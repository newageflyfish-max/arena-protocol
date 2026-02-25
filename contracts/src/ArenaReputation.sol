// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "./ArenaTypes.sol";

/**
 * @title ArenaReputation
 * @notice Soulbound ERC-721 reputation NFTs for Arena agents.
 *         Reads live stats from ArenaCore. Non-transferable.
 */
contract ArenaReputation is ERC721, Ownable, IArenaReputation {
    using Strings for uint256;
    using Strings for address;

    IArenaCore public immutable core;
    address public arenaCore; // for access control on hooks

    uint256 public reputationTokenCount;
    mapping(address => uint256) public agentTokenId;
    mapping(uint256 => address) public tokenAgent;
    mapping(address => mapping(string => uint256)) public agentTaskTypeCount;
    mapping(address => string) public agentTopSpecialization;
    mapping(address => uint256) public agentTopSpecializationCount;

    // ═══════════════════════════════════════════════════
    // CREDIT SCORE STATE
    // ═══════════════════════════════════════════════════

    struct CreditScoreData {
        uint16 score;             // 0-850
        uint256 lastUpdated;
        uint256 totalTasksFactored;
        uint256 totalSlashEvents;  // Number of times slashed
        uint256 totalSlashSeverity; // Cumulative severity points (0-10000 per slash)
        uint256 totalVerifierApprovals; // Approved verifications received
        uint256 totalVerifierRejections; // Rejected verifications received
        uint256 firstActivityAt;   // First time agent completed or failed a task
        uint256 consecutiveCompletions; // Current streak of completions
    }

    mapping(address => CreditScoreData) public creditScores;

    // Credit score constants
    uint256 public constant MAX_CREDIT_SCORE = 850;
    uint256 public constant COMPLETION_WEIGHT = 3500;   // 35%
    uint256 public constant SLASH_WEIGHT = 3000;        // 30%
    uint256 public constant VERIFICATION_WEIGHT = 2000; // 20%
    uint256 public constant AGE_WEIGHT = 1500;          // 15%
    uint256 public constant WEIGHT_DENOMINATOR = 10000;

    event CreditScoreUpdated(address indexed agent, uint16 score, uint256 totalTasks);

    // ═══════════════════════════════════════════════════
    // POSTER REPUTATION STATE
    // ═══════════════════════════════════════════════════

    struct PosterScoreData {
        uint256 totalRatings;
        uint256 sumOfRatings;       // Sum of 1-5 scores
        uint256 tasksPosted;
        uint256 tasksDisputed;
        uint256 tasksCancelled;
        uint256 tasksCompleted;
    }

    mapping(address => PosterScoreData) public posterScores;
    mapping(uint256 => bool) public taskRated; // taskId => already rated

    uint256 public constant MAX_POSTER_SCORE = 100;
    uint256 public constant POSTER_RATING_WEIGHT = 5000;       // 50%
    uint256 public constant POSTER_DISPUTE_WEIGHT = 2500;      // 25%
    uint256 public constant POSTER_CANCELLATION_WEIGHT = 2500; // 25%

    event PosterRated(address indexed poster, uint256 indexed taskId, address indexed agent, uint8 rating);
    event PosterScoreUpdated(address indexed poster, uint256 score);
    event PosterTaskRecorded(address indexed poster, uint8 outcome); // 0=completed, 1=disputed, 2=cancelled

    event ReputationNFTMinted(address indexed agent, uint256 indexed tokenId);
    event ReputationNFTBurned(address indexed agent, uint256 indexed tokenId);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906
    event ArenaCoreUpdated(address indexed newCore);

    modifier onlyCoreOrOwner() {
        require(msg.sender == arenaCore || msg.sender == owner(), "Arena: not authorized");
        _;
    }

    constructor(address _core) Ownable(msg.sender) ERC721("Arena Reputation", "AREP") {
        core = IArenaCore(_core);
        arenaCore = _core;
    }

    function setArenaCore(address _core) external onlyOwner {
        arenaCore = _core;
        emit ArenaCoreUpdated(_core);
    }

    function mintReputationNFT(address _agent) external onlyCoreOrOwner returns (uint256 tokenId) {
        require(_agent != address(0), "Arena: invalid agent address");
        require(agentTokenId[_agent] == 0, "Arena: agent already has reputation NFT");

        tokenId = ++reputationTokenCount;
        agentTokenId[_agent] = tokenId;
        tokenAgent[tokenId] = _agent;

        _mint(_agent, tokenId);

        emit ReputationNFTMinted(_agent, tokenId);
    }

    function burnReputationNFT(address _agent) external onlyOwner {
        uint256 tokenId = agentTokenId[_agent];
        require(tokenId != 0, "Arena: agent has no reputation NFT");

        delete agentTokenId[_agent];
        delete tokenAgent[tokenId];

        _burn(tokenId);

        emit ReputationNFTBurned(_agent, tokenId);
    }

    /**
     * @dev Called by ArenaCore on every reputation change
     */
    function emitMetadataUpdate(address _agent) external override onlyCoreOrOwner {
        uint256 tokenId = agentTokenId[_agent];
        if (tokenId != 0) {
            emit MetadataUpdate(tokenId);
        }
    }

    /**
     * @dev Called by ArenaCore on task completion
     */
    function updateSpecialization(address _agent, string calldata _taskType) external override onlyCoreOrOwner {
        if (bytes(_taskType).length == 0) return;

        agentTaskTypeCount[_agent][_taskType]++;
        uint256 newCount = agentTaskTypeCount[_agent][_taskType];

        if (newCount > agentTopSpecializationCount[_agent]) {
            agentTopSpecialization[_agent] = _taskType;
            agentTopSpecializationCount[_agent] = newCount;
        }
    }

    // ═══════════════════════════════════════════════════
    // CREDIT SCORE FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @dev Called by ArenaCore on every task settlement (completion or failure).
     *      Updates tracking data and recomputes the credit score.
     */
    function onTaskSettled(
        address _agent,
        bool _completed,
        uint256 _slashSeverity,
        uint256 _approvals,
        uint256 _rejections
    ) external onlyCoreOrOwner {
        CreditScoreData storage cs = creditScores[_agent];

        // Track first activity
        if (cs.firstActivityAt == 0) {
            cs.firstActivityAt = block.timestamp;
        }

        cs.totalTasksFactored++;

        if (_completed) {
            cs.consecutiveCompletions++;
        } else {
            cs.consecutiveCompletions = 0;
        }

        // Track slash data
        if (_slashSeverity > 0) {
            cs.totalSlashEvents++;
            cs.totalSlashSeverity += _slashSeverity;
        }

        // Track verification data
        cs.totalVerifierApprovals += _approvals;
        cs.totalVerifierRejections += _rejections;

        // Recompute score
        uint16 newScore = computeCreditScore(_agent);
        cs.score = newScore;
        cs.lastUpdated = block.timestamp;

        emit CreditScoreUpdated(_agent, newScore, cs.totalTasksFactored);
    }

    /**
     * @notice Compute the credit score (0-850) for an agent based on on-chain data.
     *         Weights: Completion 35%, Slash 30%, Verification 20%, Age 15%
     */
    function computeCreditScore(address _agent) public view returns (uint16) {
        CreditScoreData storage cs = creditScores[_agent];
        uint256 completed = core.agentTasksCompleted(_agent);
        uint256 failed = core.agentTasksFailed(_agent);
        uint256 totalTasks = completed + failed;

        if (totalTasks == 0) return 0;

        // ── Component 1: Completion Rate (35%) ──
        // Base = completion percentage (0-850)
        // Bonus for consecutive completions (up to +50 points equivalent)
        uint256 completionBase = (completed * MAX_CREDIT_SCORE) / totalTasks;
        uint256 streakBonus = cs.consecutiveCompletions > 20 ? 50 : (cs.consecutiveCompletions * 50) / 20;
        uint256 completionScore = completionBase + streakBonus;
        if (completionScore > MAX_CREDIT_SCORE) completionScore = MAX_CREDIT_SCORE;

        // ── Component 2: Slash History (30%) ──
        // Start at max, deduct based on slash frequency and severity
        uint256 slashScore = MAX_CREDIT_SCORE;
        if (cs.totalSlashEvents > 0) {
            // Average severity per slash (0-10000 BPS)
            uint256 avgSeverity = cs.totalSlashSeverity / cs.totalSlashEvents;
            // Slash frequency = slashes per task (0-10000 BPS)
            uint256 slashFreq = (cs.totalSlashEvents * 10000) / totalTasks;
            // Combined penalty: higher severity and frequency = worse score
            uint256 severityPenalty = (avgSeverity * MAX_CREDIT_SCORE) / 10000;
            uint256 frequencyPenalty = (slashFreq * MAX_CREDIT_SCORE) / 10000;
            uint256 totalPenalty = (severityPenalty + frequencyPenalty) / 2;
            slashScore = totalPenalty >= MAX_CREDIT_SCORE ? 0 : MAX_CREDIT_SCORE - totalPenalty;
        }

        // ── Component 3: Verification Scores (20%) ──
        // Ratio of approvals to total verifications
        uint256 verificationScore;
        uint256 totalVerifications = cs.totalVerifierApprovals + cs.totalVerifierRejections;
        if (totalVerifications > 0) {
            verificationScore = (cs.totalVerifierApprovals * MAX_CREDIT_SCORE) / totalVerifications;
        } else {
            verificationScore = MAX_CREDIT_SCORE / 2; // Neutral if no verifications
        }

        // ── Component 4: Account Age & Consistency (15%) ──
        // Ramp up over 180 days, bonus for high task volume
        uint256 ageScore;
        if (cs.firstActivityAt > 0) {
            uint256 ageDays = (block.timestamp - cs.firstActivityAt) / 1 days;
            uint256 ageBase = ageDays >= 180 ? MAX_CREDIT_SCORE : (ageDays * MAX_CREDIT_SCORE) / 180;
            // Volume bonus: more tasks = more data = higher confidence
            uint256 volumeBonus = totalTasks >= 100 ? 100 : (totalTasks * 100) / 100;
            ageScore = ageBase + volumeBonus;
            if (ageScore > MAX_CREDIT_SCORE) ageScore = MAX_CREDIT_SCORE;
        }

        // ── Weighted average ──
        uint256 weightedScore = (
            (completionScore * COMPLETION_WEIGHT) +
            (slashScore * SLASH_WEIGHT) +
            (verificationScore * VERIFICATION_WEIGHT) +
            (ageScore * AGE_WEIGHT)
        ) / WEIGHT_DENOMINATOR;

        if (weightedScore > MAX_CREDIT_SCORE) weightedScore = MAX_CREDIT_SCORE;

        return uint16(weightedScore);
    }

    /**
     * @notice Get an agent's credit score with tier classification.
     * @return score 0-850 credit score
     * @return lastUpdated Timestamp of last score update
     * @return totalTasksFactored Number of tasks included in score calculation
     * @return tier Human-readable tier: Poor, Fair, Good, Excellent, Exceptional
     */
    function getAgentCreditScore(address _agent) external view returns (
        uint16 score,
        uint256 lastUpdated,
        uint256 totalTasksFactored,
        string memory tier
    ) {
        CreditScoreData storage cs = creditScores[_agent];
        score = cs.score;
        lastUpdated = cs.lastUpdated;
        totalTasksFactored = cs.totalTasksFactored;

        if (score >= 751) tier = "Exceptional";
        else if (score >= 651) tier = "Excellent";
        else if (score >= 501) tier = "Good";
        else if (score >= 301) tier = "Fair";
        else tier = "Poor";
    }

    /**
     * @notice Get the full credit score data struct for an agent
     */
    function getCreditScoreData(address _agent) external view returns (CreditScoreData memory) {
        return creditScores[_agent];
    }

    // ═══════════════════════════════════════════════════
    // POSTER REPUTATION FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Rate a poster after task settlement. Only the assigned agent can call.
     * @param _taskId The settled task ID
     * @param _rating Score 1-5
     */
    function ratePoster(uint256 _taskId, uint8 _rating) external {
        require(_rating >= 1 && _rating <= 5, "Arena: rating must be 1-5");
        require(!taskRated[_taskId], "Arena: task already rated");

        // Read task and assignment from ArenaCore
        Task memory task = core.getTask(_taskId);
        Assignment memory assignment = core.getAssignment(_taskId);

        // Only the assigned agent can rate
        require(assignment.agent == msg.sender, "Arena: only assigned agent can rate");
        // Task must be settled (Completed or Failed)
        require(
            task.status == TaskStatus.Completed || task.status == TaskStatus.Failed,
            "Arena: task not settled"
        );

        taskRated[_taskId] = true;

        PosterScoreData storage ps = posterScores[task.poster];
        ps.totalRatings++;
        ps.sumOfRatings += _rating;

        emit PosterRated(task.poster, _taskId, msg.sender, _rating);

        uint256 newScore = computePosterScore(task.poster);
        emit PosterScoreUpdated(task.poster, newScore);
    }

    /**
     * @dev Called by ArenaCore or owner to record a task outcome for a poster.
     * @param _poster The task poster address
     * @param _outcome 0=completed, 1=disputed, 2=cancelled
     */
    function recordPosterOutcome(address _poster, uint8 _outcome) external onlyCoreOrOwner {
        PosterScoreData storage ps = posterScores[_poster];
        ps.tasksPosted++;

        if (_outcome == 0) {
            ps.tasksCompleted++;
        } else if (_outcome == 1) {
            ps.tasksDisputed++;
        } else if (_outcome == 2) {
            ps.tasksCancelled++;
        }

        emit PosterTaskRecorded(_poster, _outcome);
    }

    /**
     * @notice Compute the poster score (0-100).
     *         Weights: Average Rating 50%, Inverse Dispute Rate 25%, Inverse Cancel Rate 25%
     */
    function computePosterScore(address _poster) public view returns (uint256) {
        PosterScoreData storage ps = posterScores[_poster];

        if (ps.tasksPosted == 0 && ps.totalRatings == 0) return 0;

        // ── Component 1: Average Rating (50%) ──
        // avgRating is 1-5, scale to 0-100
        uint256 ratingScore;
        if (ps.totalRatings > 0) {
            // (avgRating / 5) * 100 = (sumOfRatings * 100) / (totalRatings * 5)
            ratingScore = (ps.sumOfRatings * MAX_POSTER_SCORE) / (ps.totalRatings * 5);
        } else {
            ratingScore = 50; // Neutral if no ratings yet
        }

        // ── Component 2: Inverse Dispute Rate (25%) ──
        // Higher score = fewer disputes
        uint256 disputeScore;
        if (ps.tasksPosted > 0) {
            uint256 disputeRate = (ps.tasksDisputed * MAX_POSTER_SCORE) / ps.tasksPosted;
            disputeScore = MAX_POSTER_SCORE - disputeRate;
        } else {
            disputeScore = MAX_POSTER_SCORE; // No tasks = no disputes
        }

        // ── Component 3: Inverse Cancellation Rate (25%) ──
        uint256 cancelScore;
        if (ps.tasksPosted > 0) {
            uint256 cancelRate = (ps.tasksCancelled * MAX_POSTER_SCORE) / ps.tasksPosted;
            cancelScore = MAX_POSTER_SCORE - cancelRate;
        } else {
            cancelScore = MAX_POSTER_SCORE;
        }

        // ── Weighted average ──
        uint256 weightedScore = (
            (ratingScore * POSTER_RATING_WEIGHT) +
            (disputeScore * POSTER_DISPUTE_WEIGHT) +
            (cancelScore * POSTER_CANCELLATION_WEIGHT)
        ) / WEIGHT_DENOMINATOR;

        if (weightedScore > MAX_POSTER_SCORE) weightedScore = MAX_POSTER_SCORE;

        return weightedScore;
    }

    /**
     * @notice Get a poster's score with tier and detailed stats.
     */
    function getPosterScore(address _poster) external view returns (
        uint256 score,
        uint256 averageRatingBps,    // avg * 100 for precision (e.g. 450 = 4.50)
        uint256 totalRatings,
        uint256 disputeRateBps,      // in BPS (e.g. 500 = 5%)
        uint256 cancellationRateBps, // in BPS
        string memory tier
    ) {
        PosterScoreData storage ps = posterScores[_poster];
        score = computePosterScore(_poster);
        totalRatings = ps.totalRatings;

        // Average rating with 2 decimal precision (x100)
        averageRatingBps = ps.totalRatings > 0
            ? (ps.sumOfRatings * 100) / ps.totalRatings
            : 0;

        // Rates in BPS
        disputeRateBps = ps.tasksPosted > 0
            ? (ps.tasksDisputed * 10000) / ps.tasksPosted
            : 0;

        cancellationRateBps = ps.tasksPosted > 0
            ? (ps.tasksCancelled * 10000) / ps.tasksPosted
            : 0;

        if (score >= 91) tier = "Exemplary";
        else if (score >= 71) tier = "Trusted";
        else if (score >= 51) tier = "Reliable";
        else if (score >= 31) tier = "Caution";
        else tier = "Unreliable";
    }

    /**
     * @notice Get the full poster score data struct
     */
    function getPosterScoreData(address _poster) external view returns (PosterScoreData memory) {
        return posterScores[_poster];
    }

    /**
     * @notice Check if a poster is flagged (score below 30)
     */
    function isPosterFlagged(address _poster) external view returns (bool) {
        PosterScoreData storage ps = posterScores[_poster];
        if (ps.tasksPosted == 0 && ps.totalRatings == 0) return false;
        return computePosterScore(_poster) <= 30;
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert("Arena: reputation NFTs are soulbound");
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return
            interfaceId == bytes4(0x49064906) || // ERC-4906
            super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        address agent = tokenAgent[tokenId];
        uint256 rep = core.agentReputation(agent);
        uint256 completed = core.agentTasksCompleted(agent);
        uint256 failed = core.agentTasksFailed(agent);
        uint256 activeStake = core.agentActiveStake(agent);
        bool banned = core.agentBanned(agent);

        uint256 totalTasks = completed + failed;
        uint256 successRateBps = totalTasks > 0 ? (completed * 10000) / totalTasks : 0;
        uint256 successWhole = successRateBps / 100;

        string memory specialization = bytes(agentTopSpecialization[agent]).length > 0
            ? agentTopSpecialization[agent]
            : "none";

        string memory status = banned ? "BANNED" : "ACTIVE";

        string memory json = string.concat(
            '{"name":"Arena Reputation: ',
            Strings.toHexString(agent),
            '","description":"Soulbound reputation credential for The Arena protocol. On-chain identity reflecting live agent performance.",',
            '"attributes":[' 
        );

        json = string.concat(
            json,
            '{"trait_type":"Reputation Score","value":', rep.toString(), '},',
            '{"trait_type":"Tasks Completed","value":', completed.toString(), '},',
            '{"trait_type":"Tasks Failed","value":', failed.toString(), '},',
            '{"trait_type":"Success Rate","display_type":"percentage","value":', successWhole.toString(), '},',
            '{"trait_type":"Specialization","value":"', specialization, '"},',
            '{"trait_type":"Active Stake","value":', activeStake.toString(), '},',
            '{"trait_type":"Status","value":"', status, '"}'
        );

        string memory svg = _buildReputationSVG(agent, rep, completed, failed, successWhole, specialization, status, activeStake);

        json = string.concat(
            json,
            '],',
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );

        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        );
    }

    function _buildReputationSVG(
        address agent,
        uint256 rep,
        uint256 completed,
        uint256 failed,
        uint256 successRate,
        string memory specialization,
        string memory status,
        uint256 activeStake
    ) internal pure returns (string memory) {
        string memory tierColor;
        string memory tierName;
        if (rep >= 100) { tierColor = "#FFD700"; tierName = "Legendary"; }
        else if (rep >= 50) { tierColor = "#C0C0C0"; tierName = "Veteran"; }
        else if (rep >= 20) { tierColor = "#CD7F32"; tierName = "Proven"; }
        else { tierColor = "#808080"; tierName = "Novice"; }

        string memory statusColor = keccak256(bytes(status)) == keccak256(bytes("BANNED"))
            ? "#f44" : "#0f0";

        string memory svgTop = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500">',
            '<rect width="400" height="500" rx="20" fill="#0a0a0a"/>',
            '<rect x="10" y="10" width="380" height="480" rx="15" fill="none" stroke="', tierColor, '" stroke-width="2"/>',
            '<text x="200" y="50" text-anchor="middle" fill="', tierColor, '" font-size="24" font-family="monospace" font-weight="bold">THE ARENA</text>',
            '<text x="200" y="80" text-anchor="middle" fill="#666" font-size="12" font-family="monospace">', Strings.toHexString(agent), '</text>',
            '<text x="200" y="130" text-anchor="middle" fill="', tierColor, '" font-size="48" font-family="monospace" font-weight="bold">', rep.toString(), '</text>',
            '<text x="200" y="155" text-anchor="middle" fill="#888" font-size="14" font-family="monospace">REPUTATION</text>'
        );

        string memory svgBottom = string.concat(
            '<text x="200" y="185" text-anchor="middle" fill="', tierColor, '" font-size="16" font-family="monospace">', tierName, '</text>',
            '<line x1="40" y1="210" x2="360" y2="210" stroke="#333" stroke-width="1"/>',
            '<text x="40" y="245" fill="#aaa" font-size="14" font-family="monospace">Completed</text>',
            '<text x="360" y="245" text-anchor="end" fill="#0f0" font-size="14" font-family="monospace">', completed.toString(), '</text>',
            '<text x="40" y="275" fill="#aaa" font-size="14" font-family="monospace">Failed</text>',
            '<text x="360" y="275" text-anchor="end" fill="#f44" font-size="14" font-family="monospace">', failed.toString(), '</text>',
            '<text x="40" y="305" fill="#aaa" font-size="14" font-family="monospace">Success Rate</text>',
            '<text x="360" y="305" text-anchor="end" fill="#fff" font-size="14" font-family="monospace">', successRate.toString(), '%</text>'
        );

        string memory svgStats = string.concat(
            '<text x="40" y="335" fill="#aaa" font-size="14" font-family="monospace">Specialization</text>',
            '<text x="360" y="335" text-anchor="end" fill="#fff" font-size="14" font-family="monospace">', specialization, '</text>',
            '<text x="40" y="365" fill="#aaa" font-size="14" font-family="monospace">Active Stake</text>',
            '<text x="360" y="365" text-anchor="end" fill="#fff" font-size="14" font-family="monospace">', activeStake.toString(), '</text>',
            '<text x="40" y="395" fill="#aaa" font-size="14" font-family="monospace">Status</text>',
            '<text x="360" y="395" text-anchor="end" fill="', statusColor, '" font-size="14" font-family="monospace">', status, '</text>',
            '<text x="200" y="460" text-anchor="middle" fill="#444" font-size="10" font-family="monospace">SOULBOUND - NON-TRANSFERABLE</text>',
            '</svg>'
        );

        return string.concat(svgTop, svgBottom, svgStats);
    }
}

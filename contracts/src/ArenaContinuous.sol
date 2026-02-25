// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title IArenaCore
 * @notice Interface for reading core state from ArenaCore
 */
interface IArenaCore {
    function agentReputation(address) external view returns (uint256);
    function agentBanned(address) external view returns (bool);
    function defaultToken() external view returns (address);
    function tokenWhitelist(address) external view returns (bool);
}

/**
 * @title ArenaContinuous
 * @notice Standalone satellite contract for Continuous Contracts.
 * @dev Extracted from ArenaCore. Owns all continuous contract state and logic.
 *      Reads agent reputation and ban status from core via IArenaCore interface.
 *      Manages its own verifier rotation, anomaly detection, and escrow.
 */
contract ArenaContinuous is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // CORE REFERENCE
    // ═══════════════════════════════════════════════════

    IArenaCore public immutable core;
    address public arenaArbitration;

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════

    enum ContinuousStatus {
        Open,           // Accepting bids
        BidReveal,      // Bid reveal period
        Active,         // Agent assigned, contract running
        Terminated,     // Early termination (failures or stake depleted)
        Completed       // All checkpoints evaluated, contract settled
    }

    enum CheckpointStatus {
        Pending,        // Not yet due or not yet submitted
        Submitted,      // Agent submitted output, awaiting verifiers
        Verifying,      // Verifiers assigned, voting in progress
        Passed,         // Checkpoint approved by majority
        Failed,         // Checkpoint rejected by majority
        Missed          // Agent failed to submit before deadline + grace
    }

    enum VerifierVote {
        Pending,
        Approved,
        Rejected
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct ContinuousContract {
        address poster;
        address token;
        uint256 totalBounty;              // Full bounty escrowed upfront
        uint256 paymentPerCheckpoint;     // totalBounty / totalCheckpoints
        uint256 duration;                 // 30/60/90 days in seconds
        uint256 checkpointInterval;       // 7-30 days in seconds
        uint256 createdAt;
        uint256 bidDeadline;
        uint256 revealDeadline;
        uint8 totalCheckpoints;           // duration / interval
        uint8 completedCheckpoints;
        uint8 passedCheckpoints;
        uint8 failedCheckpoints;
        uint8 consecutivePasses;          // Streak for bonus calculation
        uint8 maxFailures;                // Early termination threshold
        uint8 requiredVerifiers;
        ContinuousStatus status;
        bytes32 criteriaHash;
        string contractType;
    }

    struct ContinuousAssignment {
        address agent;
        uint256 stake;                    // Original stake (rolling bond)
        uint256 currentStake;             // Remaining after partial slashes
        uint256 price;                    // Winning bid price
        uint256 startedAt;                // When agent was assigned
        uint256 totalPaid;                // Cumulative paid to agent
        uint256 totalSlashed;             // Cumulative slashed
    }

    struct Checkpoint {
        uint256 dueBy;                    // Deadline for submission
        uint256 submittedAt;
        uint256 evaluatedAt;
        bytes32 outputHash;
        CheckpointStatus status;
        uint256 payoutAmount;
        uint256 slashAmount;
    }

    struct SealedBid {
        bytes32 commitHash;
        bool revealed;
        address agent;
        uint256 stake;
        uint256 price;
        uint256 eta;
    }

    struct Verification {
        address verifier;
        uint256 stake;
        VerifierVote vote;
        bytes32 reportHash;
    }

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════

    uint256 public constant PROTOCOL_FEE_BPS = 250;
    uint256 public constant SLASH_REVENUE_BPS = 1000;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_VERIFIERS = 5;
    uint256 public constant MIN_STAKE_RATIO = 10;
    uint256 public constant MAX_BIDDERS = 20;

    uint256 public constant CONTINUOUS_30_DAYS = 30 days;
    uint256 public constant CONTINUOUS_60_DAYS = 60 days;
    uint256 public constant CONTINUOUS_90_DAYS = 90 days;
    uint256 public constant MIN_CHECKPOINT_INTERVAL = 7 days;
    uint256 public constant MAX_CHECKPOINT_INTERVAL = 30 days;
    uint256 public constant CHECKPOINT_GRACE_PERIOD = 24 hours;
    uint256 public constant CHECKPOINT_EVAL_WINDOW = 48 hours;
    uint256 public constant CHECKPOINT_PASS_BONUS_BPS = 500;
    uint256 public constant CHECKPOINT_FAIL_SLASH_BPS = 1500;
    uint256 public constant CHECKPOINT_MISS_SLASH_BPS = 2500;
    uint256 public constant CONTINUOUS_STAKE_THRESHOLD_BPS = 5000;
    uint256 public constant MAX_ACTIVE_CONTINUOUS = 3;
    uint256 public constant DEFAULT_MAX_FAILURES = 3;
    uint256 public constant SLASH_COOLDOWN = 72 hours;

    // Anomaly detection constants
    uint256 internal constant ANOMALY_MIN_VOTES = 5;
    uint256 internal constant ANOMALY_APPROVAL_THRESHOLD_BPS = 9500;
    uint256 internal constant ANOMALY_PAIR_THRESHOLD_BPS = 6000;
    uint256 internal constant ANOMALY_BAN_THRESHOLD = 3;

    // Completion bond: 15% of each checkpoint payout withheld until final checkpoint passes
    uint256 public constant COMPLETION_BOND_BPS = 1500;

    // ═══════════════════════════════════════════════════
    // STATE — CONTINUOUS CONTRACTS
    // ═══════════════════════════════════════════════════

    uint256 public continuousCount;
    mapping(address => uint256) public protocolTreasury;

    mapping(uint256 => ContinuousContract) public continuousContracts;
    mapping(uint256 => ContinuousAssignment) public continuousAssignments;
    mapping(uint256 => mapping(address => SealedBid)) public continuousBids;
    mapping(uint256 => address[]) internal continuousBidders;
    mapping(uint256 => address) internal continuousBestBidder;
    mapping(uint256 => uint256) internal continuousBestScore;
    mapping(uint256 => mapping(uint8 => Checkpoint)) public checkpoints;
    mapping(uint256 => mapping(uint8 => Verification[])) public checkpointVerifications;
    // slither-disable-next-line uninitialized-state
    mapping(uint256 => mapping(uint8 => address[])) public checkpointVerifiers;
    mapping(uint256 => mapping(uint8 => uint256)) internal checkpointVerifierAssignedAt;
    mapping(uint256 => uint256) public continuousEscrow;
    mapping(uint256 => uint256) public completionBond;

    // ═══════════════════════════════════════════════════
    // STATE — ANTI-GRIEFING
    // ═══════════════════════════════════════════════════

    uint256 public minContinuousBounty = 500e6; // 500 USDC default
    uint256 public maxPosterActiveContracts = 20;
    mapping(address => uint256) public posterActiveContracts;

    // ═══════════════════════════════════════════════════
    // STATE — TASK TYPE RESTRICTIONS
    // ═══════════════════════════════════════════════════

    bool public requireContractTypeApproval;
    mapping(bytes32 => bool) public approvedContractTypes;

    // ═══════════════════════════════════════════════════
    // STATE — LOCAL AGENT TRACKING
    // ═══════════════════════════════════════════════════

    mapping(address => uint256) public agentActiveContinuous;
    mapping(address => uint256) public agentActiveStake;
    mapping(address => uint256) public agentTasksCompleted;
    mapping(address => uint256) public agentTasksFailed;
    mapping(address => uint256) public agentSlashCooldownEnd;
    mapping(address => bool) public agentBannedLocal;

    // ═══════════════════════════════════════════════════
    // STATE — VERIFIER ROTATION
    // ═══════════════════════════════════════════════════

    uint256 public verifierCooldownPeriod = 7 days;
    mapping(address => mapping(address => uint256)) public lastVerifiedTimestamp;

    // ═══════════════════════════════════════════════════
    // STATE — ANOMALY DETECTION
    // ═══════════════════════════════════════════════════

    mapping(address => uint256) internal verifierTotalVotes;
    mapping(address => uint256) internal verifierApprovals;
    mapping(address => mapping(address => uint256)) internal verifierAgentPairCount;
    mapping(address => uint256) internal verifierDistinctAgents;
    mapping(address => mapping(address => bool)) internal verifierAgentSeen;
    mapping(address => bool) internal verifierFlagged;
    mapping(address => uint256) internal verifierAnomalyCount;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event ContinuousContractCreated(
        uint256 indexed contractId,
        address indexed poster,
        address token,
        uint256 totalBounty,
        uint256 duration,
        uint256 checkpointInterval,
        uint8 totalCheckpoints
    );
    event ContinuousBidCommitted(uint256 indexed contractId, address indexed bidder, bytes32 commitHash);
    event ContinuousBidRevealed(uint256 indexed contractId, address indexed bidder, uint256 stake, uint256 price, uint256 eta);
    event ContinuousAgentAssigned(uint256 indexed contractId, address indexed agent, uint256 stake, uint256 price);
    event CheckpointSubmitted(uint256 indexed contractId, uint8 indexed checkpointIndex, address indexed agent, bytes32 outputHash);
    event CheckpointVerifierAssigned(uint256 indexed contractId, uint8 indexed checkpointIndex, address indexed verifier, uint256 stake);
    event CheckpointEvaluated(uint256 indexed contractId, uint8 indexed checkpointIndex, CheckpointStatus status, uint256 payoutAmount, uint256 slashAmount);
    event CheckpointMissed(uint256 indexed contractId, uint8 indexed checkpointIndex);
    event ContinuousContractTerminated(uint256 indexed contractId, string reason);
    event ContinuousContractCompleted(uint256 indexed contractId, uint256 totalPaid, uint256 totalSlashed, uint256 stakeReturned);
    event AgentSlashCooldownApplied(address indexed agent, uint256 cooldownEnd);
    event AnomalyDetected(address indexed verifier, string reason, uint256 value, uint256 threshold);
    event VerifierAutoFlagged(address indexed verifier, uint256 anomalyCount);
    event VerifierAutoBanned(address indexed verifier, uint256 anomalyCount);
    event VerifierCooldownUpdated(uint256 newCooldownPeriod);
    event ArenaArbitrationUpdated(address indexed newArbitration);
    event CheckpointDisputeResolved(uint256 indexed contractId, uint8 indexed checkpointIndex, bool inFavorOfAgent, CheckpointStatus previousStatus);
    event CompletionBondReleased(uint256 indexed contractId, address indexed agent, uint256 amount);
    event CompletionBondForfeited(uint256 indexed contractId, address indexed poster, uint256 amount);

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier notBanned() {
        require(!core.agentBanned(msg.sender) && !agentBannedLocal[msg.sender], "Arena: agent is banned");
        _;
    }

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        require(_core != address(0), "Arena: zero core address");
        core = IArenaCore(_core);
    }

    // ═══════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setVerifierCooldownPeriod(uint256 _cooldownPeriod) external onlyOwner {
        verifierCooldownPeriod = _cooldownPeriod;
        emit VerifierCooldownUpdated(_cooldownPeriod);
    }

    function setMinContinuousBounty(uint256 _min) external onlyOwner { minContinuousBounty = _min; }
    function setMaxPosterActiveContracts(uint256 _max) external onlyOwner { maxPosterActiveContracts = _max; }

    function setRequireContractTypeApproval(bool _require) external onlyOwner { requireContractTypeApproval = _require; }
    function addApprovedContractType(string calldata _t) external onlyOwner { approvedContractTypes[keccak256(bytes(_t))] = true; }
    function removeApprovedContractType(string calldata _t) external onlyOwner { approvedContractTypes[keccak256(bytes(_t))] = false; }

    function setArenaArbitration(address _arenaArbitration) external onlyOwner {
        arenaArbitration = _arenaArbitration;
        emit ArenaArbitrationUpdated(_arenaArbitration);
    }

    function withdrawProtocolFees(address _token, address _to, uint256 _amount) external onlyOwner {
        require(_amount <= protocolTreasury[_token], "Arena: exceeds treasury");
        protocolTreasury[_token] -= _amount;
        IERC20(_token).safeTransfer(_to, _amount);
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — CREATION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Create a continuous service contract with periodic checkpoints.
     * @param _token ERC20 token (address(0) for default)
     * @param _totalBounty Total bounty escrowed upfront
     * @param _duration Contract duration (must be 30, 60, or 90 days)
     * @param _checkpointInterval Seconds between checkpoints (7-30 days)
     * @param _bidDuration How long the bidding period lasts (seconds)
     * @param _revealDuration How long the reveal period lasts (seconds)
     * @param _requiredVerifiers Verifiers per checkpoint (1-5)
     * @param _maxFailures Max failed checkpoints before termination
     * @param _criteriaHash Hash of contract requirements
     * @param _contractType Category string
     */
    function createContinuousContract(
        address _token,
        uint256 _totalBounty,
        uint256 _duration,
        uint256 _checkpointInterval,
        uint256 _bidDuration,
        uint256 _revealDuration,
        uint8 _requiredVerifiers,
        uint8 _maxFailures,
        bytes32 _criteriaHash,
        string calldata _contractType
    ) external whenNotPaused nonReentrant returns (uint256 contractId) {
        require(_totalBounty > 0, "Arena: bounty must be > 0");
        require(_totalBounty >= minContinuousBounty, "Arena: bounty below minimum");
        require(posterActiveContracts[msg.sender] < maxPosterActiveContracts, "Arena: poster active contract limit");
        require(
            _duration == CONTINUOUS_30_DAYS ||
            _duration == CONTINUOUS_60_DAYS ||
            _duration == CONTINUOUS_90_DAYS,
            "Arena: duration must be 30, 60, or 90 days"
        );
        require(
            _checkpointInterval >= MIN_CHECKPOINT_INTERVAL &&
            _checkpointInterval <= MAX_CHECKPOINT_INTERVAL,
            "Arena: interval must be 7-30 days"
        );
        require(_duration % _checkpointInterval == 0, "Arena: interval must divide evenly into duration");
        require(_requiredVerifiers > 0 && _requiredVerifiers <= MAX_VERIFIERS, "Arena: invalid verifier count");
        require(_bidDuration > 0, "Arena: bid duration must be > 0");
        require(_revealDuration > 0, "Arena: reveal duration must be > 0");
        if (requireContractTypeApproval) {
            require(approvedContractTypes[keccak256(bytes(_contractType))], "Arena: contract type not approved");
        }

        uint8 totalCps = uint8(_duration / _checkpointInterval);
        require(totalCps >= 2, "Arena: need at least 2 checkpoints");
        require(_maxFailures > 0 && _maxFailures <= totalCps, "Arena: invalid max failures");

        address token = _token == address(0) ? core.defaultToken() : _token;
        require(core.tokenWhitelist(token), "Arena: token not whitelisted");

        // Escrow full bounty
        IERC20(token).safeTransferFrom(msg.sender, address(this), _totalBounty);

        contractId = continuousCount++;

        continuousContracts[contractId] = ContinuousContract({
            poster: msg.sender,
            token: token,
            totalBounty: _totalBounty,
            paymentPerCheckpoint: _totalBounty / totalCps,
            duration: _duration,
            checkpointInterval: _checkpointInterval,
            createdAt: block.timestamp,
            bidDeadline: block.timestamp + _bidDuration,
            revealDeadline: block.timestamp + _bidDuration + _revealDuration,
            totalCheckpoints: totalCps,
            completedCheckpoints: 0,
            passedCheckpoints: 0,
            failedCheckpoints: 0,
            consecutivePasses: 0,
            maxFailures: _maxFailures,
            requiredVerifiers: _requiredVerifiers,
            status: ContinuousStatus.Open,
            criteriaHash: _criteriaHash,
            contractType: _contractType
        });

        continuousEscrow[contractId] = _totalBounty;
        posterActiveContracts[msg.sender]++;

        emit ContinuousContractCreated(
            contractId, msg.sender, token, _totalBounty,
            _duration, _checkpointInterval, totalCps
        );
    }

    /**
     * @notice Cancel a continuous contract before assignment. Returns bounty to poster.
     */
    function cancelContinuousContract(uint256 _contractId) external nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        require(msg.sender == cc.poster, "Arena: not poster");
        require(
            cc.status == ContinuousStatus.Open || cc.status == ContinuousStatus.BidReveal,
            "Arena: cannot cancel active contract"
        );

        cc.status = ContinuousStatus.Terminated;
        posterActiveContracts[cc.poster]--;

        IERC20 token = IERC20(cc.token);

        // Refund bidder stakes
        address[] storage bidders = continuousBidders[_contractId];
        for (uint256 i = 0; i < bidders.length; i++) {
            SealedBid storage bid = continuousBids[_contractId][bidders[i]];
            if (bid.revealed && bid.stake > 0) {
                agentActiveStake[bidders[i]] -= bid.stake;
                token.safeTransfer(bidders[i], bid.stake);
            }
        }

        // Refund bounty
        uint256 escrow = continuousEscrow[_contractId];
        continuousEscrow[_contractId] = 0;

        // slither-disable-next-line reentrancy-events
        token.safeTransfer(cc.poster, escrow);

        emit ContinuousContractTerminated(_contractId, "poster_cancelled");
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — SEALED BID AUCTION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Commit a sealed bid for a continuous contract
     */
    function commitContinuousBid(uint256 _contractId, bytes32 _commitHash)
        external
        whenNotPaused
        notBanned
    {
        ContinuousContract storage cc = continuousContracts[_contractId];
        require(cc.status == ContinuousStatus.Open, "Arena: not open for bids");
        require(block.timestamp < cc.bidDeadline, "Arena: bidding closed");
        require(msg.sender != cc.poster, "Arena: poster cannot bid");
        require(continuousBids[_contractId][msg.sender].commitHash == bytes32(0), "Arena: already bid");
        require(continuousBidders[_contractId].length < MAX_BIDDERS, "Arena: max bidders reached");

        // Rate limiting
        require(agentActiveContinuous[msg.sender] < MAX_ACTIVE_CONTINUOUS, "Arena: too many active continuous contracts");
        require(block.timestamp >= agentSlashCooldownEnd[msg.sender], "Arena: agent on slash cooldown");

        continuousBids[_contractId][msg.sender] = SealedBid({
            commitHash: _commitHash,
            revealed: false,
            agent: msg.sender,
            stake: 0,
            price: 0,
            eta: 0
        });

        continuousBidders[_contractId].push(msg.sender);

        emit ContinuousBidCommitted(_contractId, msg.sender, _commitHash);
    }

    /**
     * @notice Reveal a previously committed bid for a continuous contract
     */
    function revealContinuousBid(
        uint256 _contractId,
        uint256 _stake,
        uint256 _price,
        uint256 _eta,
        bytes32 _salt
    ) external whenNotPaused nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];

        require(
            block.timestamp >= cc.bidDeadline && block.timestamp < cc.revealDeadline,
            "Arena: not in reveal period"
        );

        // Transition to reveal phase on first reveal
        if (cc.status == ContinuousStatus.Open) {
            cc.status = ContinuousStatus.BidReveal;
        }

        SealedBid storage bid = continuousBids[_contractId][msg.sender];
        require(bid.commitHash != bytes32(0), "Arena: no bid committed");
        require(!bid.revealed, "Arena: already revealed");

        // Verify commitment
        bytes32 expectedHash = keccak256(
            abi.encodePacked(msg.sender, _stake, _price, _eta, _salt)
        );
        require(expectedHash == bid.commitHash, "Arena: invalid reveal");

        // Validate bid parameters
        uint256 minStake = cc.totalBounty / MIN_STAKE_RATIO;
        require(_stake >= minStake, "Arena: stake below minimum");
        require(_price <= cc.totalBounty, "Arena: price exceeds bounty");
        require(_eta > 0, "Arena: eta must be > 0");

        // Transfer stake
        IERC20(cc.token).safeTransferFrom(msg.sender, address(this), _stake);

        bid.revealed = true;
        bid.agent = msg.sender;
        bid.stake = _stake;
        bid.price = _price;
        bid.eta = _eta;

        agentActiveStake[msg.sender] += _stake;

        // Track best bid — read reputation from core
        uint256 rep = core.agentReputation(msg.sender) + 1;
        uint256 score = (_stake * rep * 1e18) / _price;
        if (score > continuousBestScore[_contractId]) {
            continuousBestScore[_contractId] = score;
            continuousBestBidder[_contractId] = msg.sender;
        }

        emit ContinuousBidRevealed(_contractId, msg.sender, _stake, _price, _eta);
    }

    /**
     * @notice Resolve the continuous contract auction and assign the winning agent
     */
    function resolveContinuousAuction(uint256 _contractId) external whenNotPaused nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        require(
            cc.status == ContinuousStatus.BidReveal || cc.status == ContinuousStatus.Open,
            "Arena: not in auction phase"
        );
        require(block.timestamp >= cc.revealDeadline, "Arena: reveal period not ended");

        address[] storage bidders = continuousBidders[_contractId];
        require(bidders.length > 0, "Arena: no bids");

        address bestAgent = continuousBestBidder[_contractId];
        require(bestAgent != address(0), "Arena: no valid bids");

        SealedBid storage winningBid = continuousBids[_contractId][bestAgent];

        // Create assignment
        continuousAssignments[_contractId] = ContinuousAssignment({
            agent: bestAgent,
            stake: winningBid.stake,
            currentStake: winningBid.stake,
            price: winningBid.price,
            startedAt: block.timestamp,
            totalPaid: 0,
            totalSlashed: 0
        });

        cc.status = ContinuousStatus.Active;
        agentActiveContinuous[bestAgent]++;

        // Emit before external calls to avoid reentrancy-events
        emit ContinuousAgentAssigned(_contractId, bestAgent, winningBid.stake, winningBid.price);

        // Refund losing bidders
        IERC20 token = IERC20(cc.token);
        for (uint256 i = 0; i < bidders.length; i++) {
            SealedBid storage bid = continuousBids[_contractId][bidders[i]];
            if (bid.revealed && bid.agent != bestAgent) {
                agentActiveStake[bid.agent] -= bid.stake;
                token.safeTransfer(bid.agent, bid.stake);
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — CHECKPOINTS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Agent submits checkpoint output for evaluation
     * @param _contractId The continuous contract ID
     * @param _checkpointIndex The checkpoint index (must be sequential)
     * @param _outputHash Hash of the deliverable
     */
    function submitCheckpoint(
        uint256 _contractId,
        uint8 _checkpointIndex,
        bytes32 _outputHash
    ) external whenNotPaused nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];

        require(cc.status == ContinuousStatus.Active, "Arena: contract not active");
        require(msg.sender == ca.agent, "Arena: not assigned agent");
        require(_checkpointIndex == cc.completedCheckpoints, "Arena: wrong checkpoint index");
        require(_outputHash != bytes32(0), "Arena: empty output");

        // Calculate due date for this checkpoint
        uint256 dueBy = ca.startedAt + uint256(_checkpointIndex + 1) * cc.checkpointInterval;
        require(
            block.timestamp <= dueBy + CHECKPOINT_GRACE_PERIOD,
            "Arena: checkpoint submission past grace period"
        );

        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];
        require(cp.status == CheckpointStatus.Pending, "Arena: checkpoint already submitted");

        cp.dueBy = dueBy;
        cp.submittedAt = block.timestamp;
        cp.outputHash = _outputHash;
        cp.status = CheckpointStatus.Submitted;

        emit CheckpointSubmitted(_contractId, _checkpointIndex, msg.sender, _outputHash);
    }

    /**
     * @notice Mark a checkpoint as missed. Callable by anyone after grace period.
     */
    function markCheckpointMissed(
        uint256 _contractId,
        uint8 _checkpointIndex
    ) external whenNotPaused nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];

        require(cc.status == ContinuousStatus.Active, "Arena: contract not active");
        require(_checkpointIndex == cc.completedCheckpoints, "Arena: wrong checkpoint index");

        uint256 dueBy = ca.startedAt + uint256(_checkpointIndex + 1) * cc.checkpointInterval;
        require(
            block.timestamp > dueBy + CHECKPOINT_GRACE_PERIOD,
            "Arena: grace period not expired"
        );

        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];
        require(cp.status == CheckpointStatus.Pending, "Arena: checkpoint not pending");

        cp.dueBy = dueBy;
        cp.status = CheckpointStatus.Missed;

        // Slash 25% of current stake
        uint256 preSlashStake = ca.currentStake;
        uint256 slashAmount = (preSlashStake * CHECKPOINT_MISS_SLASH_BPS) / BPS_DENOMINATOR;
        ca.currentStake -= slashAmount;
        ca.totalSlashed += slashAmount;
        cp.slashAmount = slashAmount;

        IERC20 token = IERC20(cc.token);

        // Split slash: 90% to poster, 10% to protocol
        // slither-disable-next-line divide-before-multiply
        uint256 toProtocol = (preSlashStake * CHECKPOINT_MISS_SLASH_BPS * SLASH_REVENUE_BPS)
            / (BPS_DENOMINATOR * BPS_DENOMINATOR);
        if (toProtocol > slashAmount) {
            toProtocol = slashAmount;
        }
        uint256 toPoster = slashAmount - toProtocol;
        protocolTreasury[cc.token] +=toProtocol;

        // Reputation: tracked locally via event (satellite cannot write to core)
        cc.failedCheckpoints++;
        cc.completedCheckpoints++;
        cc.consecutivePasses = 0;

        // Emit before external calls to avoid reentrancy-events
        emit CheckpointMissed(_contractId, _checkpointIndex);

        if (toPoster > 0) {
            token.safeTransfer(cc.poster, toPoster);
        }

        // Check termination conditions
        _checkContinuousTermination(_contractId);
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — CHECKPOINT VERIFICATION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Register as a verifier for a specific checkpoint
     */
    function registerCheckpointVerifier(
        uint256 _contractId,
        uint8 _checkpointIndex,
        uint256 _stake
    ) external whenNotPaused notBanned nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];
        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];

        require(cc.status == ContinuousStatus.Active, "Arena: contract not active");
        require(
            cp.status == CheckpointStatus.Submitted || cp.status == CheckpointStatus.Verifying,
            "Arena: checkpoint not ready for verification"
        );
        require(msg.sender != ca.agent, "Arena: agent cannot verify own work");
        require(msg.sender != cc.poster, "Arena: poster cannot verify");

        address[] storage verifierList = checkpointVerifiers[_contractId][_checkpointIndex];
        require(verifierList.length < cc.requiredVerifiers, "Arena: verifier slots full");

        // Check not already registered
        for (uint256 i = 0; i < verifierList.length; i++) {
            require(verifierList[i] != msg.sender, "Arena: already registered as verifier");
        }

        // Rotation: enforce cooldown between verifier-agent pairs
        if (verifierCooldownPeriod > 0 && lastVerifiedTimestamp[msg.sender][ca.agent] > 0) {
            require(
                block.timestamp >= lastVerifiedTimestamp[msg.sender][ca.agent] + verifierCooldownPeriod,
                "Arena: verifier on cooldown for this agent"
            );
        }

        // Minimum verifier stake = 20% of agent's current stake
        uint256 minVerifierStake = ca.currentStake / 5;
        if (minVerifierStake == 0) minVerifierStake = 1;
        require(_stake >= minVerifierStake, "Arena: verifier stake too low");

        // Transfer verifier stake
        IERC20(cc.token).safeTransferFrom(msg.sender, address(this), _stake);
        agentActiveStake[msg.sender] += _stake;

        // Record rotation timestamp
        lastVerifiedTimestamp[msg.sender][ca.agent] = block.timestamp;

        checkpointVerifications[_contractId][_checkpointIndex].push(Verification({
            verifier: msg.sender,
            stake: _stake,
            vote: VerifierVote.Pending,
            reportHash: bytes32(0)
        }));

        verifierList.push(msg.sender);

        if (cp.status == CheckpointStatus.Submitted) {
            cp.status = CheckpointStatus.Verifying;
            checkpointVerifierAssignedAt[_contractId][_checkpointIndex] = block.timestamp;
        }

        // slither-disable-next-line reentrancy-events
        emit CheckpointVerifierAssigned(_contractId, _checkpointIndex, msg.sender, _stake);
    }

    /**
     * @notice Submit verification vote for a checkpoint
     */
    function submitCheckpointVerification(
        uint256 _contractId,
        uint8 _checkpointIndex,
        VerifierVote _vote,
        bytes32 _reportHash
    ) external nonReentrant {
        ContinuousContract storage cc = continuousContracts[_contractId];
        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];

        require(cc.status == ContinuousStatus.Active, "Arena: contract not active");
        require(cp.status == CheckpointStatus.Verifying, "Arena: checkpoint not in verification");
        require(_vote == VerifierVote.Approved || _vote == VerifierVote.Rejected, "Arena: invalid vote");
        require(_reportHash != bytes32(0), "Arena: empty report");

        Verification[] storage vList = checkpointVerifications[_contractId][_checkpointIndex];
        bool found = false;

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].verifier == msg.sender) {
                require(vList[i].vote == VerifierVote.Pending, "Arena: already voted");
                vList[i].vote = _vote;
                vList[i].reportHash = _reportHash;
                found = true;
                break;
            }
        }

        require(found, "Arena: not a registered verifier");

        // Track anomaly stats
        address agent = continuousAssignments[_contractId].agent;
        _recordVerifierStats(msg.sender, agent, _vote);

        // Check if all verifiers have voted — auto-evaluate
        _tryCheckpointSettlement(_contractId, _checkpointIndex);
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — CHECKPOINT EVALUATION
    // ═══════════════════════════════════════════════════

    /**
     * @dev Internal: attempt checkpoint settlement if all verifiers voted
     */
    function _tryCheckpointSettlement(uint256 _contractId, uint8 _checkpointIndex) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        Verification[] storage vList = checkpointVerifications[_contractId][_checkpointIndex];

        uint256 approvals = 0;
        uint256 rejections = 0;

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Pending) return; // Not all voted
            if (vList[i].vote == VerifierVote.Approved) approvals++;
            if (vList[i].vote == VerifierVote.Rejected) rejections++;
        }

        require(vList.length == cc.requiredVerifiers, "Arena: not all verifiers registered");

        if (approvals > rejections) {
            _evaluateCheckpointPass(_contractId, _checkpointIndex);
        } else {
            _evaluateCheckpointFail(_contractId, _checkpointIndex);
        }
    }

    /**
     * @dev Internal: handle a passing checkpoint
     */
    function _evaluateCheckpointPass(uint256 _contractId, uint8 _checkpointIndex) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];
        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];

        cp.status = CheckpointStatus.Passed;
        cp.evaluatedAt = block.timestamp;

        IERC20 token = IERC20(cc.token);

        // Calculate payout
        uint256 basePayout = cc.paymentPerCheckpoint;

        // Protocol fee
        uint256 protocolFee = (basePayout * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        protocolTreasury[cc.token] +=protocolFee;

        // Verifier fees (3% of per-checkpoint payment)
        Verification[] storage vList = checkpointVerifications[_contractId][_checkpointIndex];
        uint256 verifierFeeTotal = (basePayout * 300) / BPS_DENOMINATOR;
        uint256 feePerVerifier = vList.length > 0 ? verifierFeeTotal / vList.length : 0;

        // Bonus for consecutive passes (5% after 2+ in a row)
        uint256 bonus = 0;
        if (cc.consecutivePasses >= 1) {
            bonus = (basePayout * CHECKPOINT_PASS_BONUS_BPS) / BPS_DENOMINATOR;
        }

        uint256 agentPayout = basePayout - protocolFee - (feePerVerifier * vList.length) + bonus;

        // Deduct from escrow: base + bonus
        uint256 fromEscrow = basePayout + bonus;
        if (fromEscrow > continuousEscrow[_contractId]) {
            fromEscrow = continuousEscrow[_contractId];
            agentPayout = fromEscrow - protocolFee - (feePerVerifier * vList.length);
            bonus = 0;
        }
        continuousEscrow[_contractId] -= fromEscrow;

        // Completion bond: withhold 15% of agent payout until final checkpoint passes
        uint256 bondWithhold = (agentPayout * COMPLETION_BOND_BPS) / BPS_DENOMINATOR;
        completionBond[_contractId] += bondWithhold;
        agentPayout -= bondWithhold;

        // Pay agent (minus bond holdback)
        if (agentPayout > 0) {
            token.safeTransfer(ca.agent, agentPayout);
        }
        ca.totalPaid += agentPayout + bondWithhold;
        cp.payoutAmount = agentPayout + bondWithhold;

        // Pay verifiers
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Approved) {
                // Correct vote — return stake + fee
                token.safeTransfer(vList[i].verifier, vList[i].stake + feePerVerifier);
            } else {
                // Wrong vote (rejected good work) — slash 50%
                uint256 verifierSlash = vList[i].stake / 2;
                uint256 verifierReturn = vList[i].stake - verifierSlash;
                uint256 toProtocol = (vList[i].stake * SLASH_REVENUE_BPS) / (BPS_DENOMINATOR * 2);
                uint256 slashToPoster = verifierSlash - toProtocol;
                protocolTreasury[cc.token] +=toProtocol;
                if (verifierReturn > 0) {
                    token.safeTransfer(vList[i].verifier, verifierReturn);
                }
                if (slashToPoster > 0) {
                    token.safeTransfer(cc.poster, slashToPoster);
                }
            }
            agentActiveStake[vList[i].verifier] -= vList[i].stake;
        }

        // Update state
        cc.passedCheckpoints++;
        cc.completedCheckpoints++;
        cc.consecutivePasses++;

        // slither-disable-next-line reentrancy-events
        emit CheckpointEvaluated(_contractId, _checkpointIndex, CheckpointStatus.Passed, agentPayout, 0);

        // Check if contract is complete
        if (cc.completedCheckpoints == cc.totalCheckpoints) {
            _settleContinuousContract(_contractId);
        }
    }

    /**
     * @dev Internal: handle a failing checkpoint
     */
    function _evaluateCheckpointFail(uint256 _contractId, uint8 _checkpointIndex) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];
        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];

        cp.status = CheckpointStatus.Failed;
        cp.evaluatedAt = block.timestamp;

        IERC20 token = IERC20(cc.token);

        // Slash 15% of current stake
        uint256 preSlashStake = ca.currentStake;
        uint256 slashAmount = (preSlashStake * CHECKPOINT_FAIL_SLASH_BPS) / BPS_DENOMINATOR;
        ca.currentStake -= slashAmount;
        ca.totalSlashed += slashAmount;
        cp.slashAmount = slashAmount;

        // Split slash: 90% to poster, 10% to protocol
        // slither-disable-next-line divide-before-multiply
        uint256 toProtocol = (preSlashStake * CHECKPOINT_FAIL_SLASH_BPS * SLASH_REVENUE_BPS)
            / (BPS_DENOMINATOR * BPS_DENOMINATOR);
        if (toProtocol > slashAmount) {
            toProtocol = slashAmount;
        }
        uint256 toPoster = slashAmount - toProtocol;
        protocolTreasury[cc.token] +=toProtocol;
        if (toPoster > 0) {
            token.safeTransfer(cc.poster, toPoster);
        }

        // Pay verifiers
        Verification[] storage vList = checkpointVerifications[_contractId][_checkpointIndex];
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Rejected) {
                // Correct vote — return stake only
                token.safeTransfer(vList[i].verifier, vList[i].stake);
            } else {
                // Wrong vote (approved bad work) — slash 100%
                uint256 toProtocolV = (vList[i].stake * SLASH_REVENUE_BPS) / BPS_DENOMINATOR;
                uint256 slashToPoster = vList[i].stake - toProtocolV;
                protocolTreasury[cc.token] +=toProtocolV;
                if (slashToPoster > 0) {
                    token.safeTransfer(cc.poster, slashToPoster);
                }
            }
            agentActiveStake[vList[i].verifier] -= vList[i].stake;
        }

        cc.failedCheckpoints++;
        cc.completedCheckpoints++;
        cc.consecutivePasses = 0;

        // slither-disable-next-line reentrancy-events
        emit CheckpointEvaluated(_contractId, _checkpointIndex, CheckpointStatus.Failed, 0, slashAmount);

        // Check termination or completion
        if (cc.completedCheckpoints == cc.totalCheckpoints) {
            _settleContinuousContract(_contractId);
        } else {
            _checkContinuousTermination(_contractId);
        }
    }

    // ═══════════════════════════════════════════════════
    // CONTINUOUS CONTRACTS — SETTLEMENT & TERMINATION
    // ═══════════════════════════════════════════════════

    /**
     * @dev Check if a continuous contract should be terminated early
     */
    function _checkContinuousTermination(uint256 _contractId) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];

        // Terminate if max failures reached
        if (cc.failedCheckpoints >= cc.maxFailures) {
            _terminateContinuousContract(_contractId, "max_failures");
            return;
        }

        // Terminate if stake below 50% of original
        uint256 threshold = (ca.stake * CONTINUOUS_STAKE_THRESHOLD_BPS) / BPS_DENOMINATOR;
        if (ca.currentStake < threshold) {
            _terminateContinuousContract(_contractId, "stake_below_threshold");
        }
    }

    /**
     * @dev Internal: terminate a continuous contract early
     */
    function _terminateContinuousContract(uint256 _contractId, string memory _reason) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];

        cc.status = ContinuousStatus.Terminated;
        posterActiveContracts[cc.poster]--;

        IERC20 token = IERC20(cc.token);

        // Return remaining escrow to poster
        uint256 remainingEscrow = continuousEscrow[_contractId];
        continuousEscrow[_contractId] = 0;

        // Forfeit completion bond to poster (early termination = agent failed)
        uint256 bond = completionBond[_contractId];
        completionBond[_contractId] = 0;

        // Return remaining agent stake
        uint256 remainingStake = ca.currentStake;

        agentActiveContinuous[ca.agent]--;

        // Apply slash cooldown if terminated due to failures
        if (cc.failedCheckpoints >= 2) {
            uint256 cooldownEnd = block.timestamp + SLASH_COOLDOWN;
            agentSlashCooldownEnd[ca.agent] = cooldownEnd;
            emit AgentSlashCooldownApplied(ca.agent, cooldownEnd);
        }

        // Emit before external calls to avoid reentrancy-events
        emit ContinuousContractTerminated(_contractId, _reason);

        if (bond > 0) {
            token.safeTransfer(cc.poster, bond);
            emit CompletionBondForfeited(_contractId, cc.poster, bond);
        }

        if (remainingEscrow > 0) {
            token.safeTransfer(cc.poster, remainingEscrow);
        }

        if (remainingStake > 0) {
            agentActiveStake[ca.agent] -= remainingStake;
            token.safeTransfer(ca.agent, remainingStake);
            ca.currentStake = 0;
        }
    }

    /**
     * @dev Internal: settle a completed continuous contract (all checkpoints done)
     */
    function _settleContinuousContract(uint256 _contractId) internal {
        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];

        cc.status = ContinuousStatus.Completed;
        posterActiveContracts[cc.poster]--;

        IERC20 token = IERC20(cc.token);

        // Return remaining escrow to poster (dust from rounding)
        uint256 remainingEscrow = continuousEscrow[_contractId];
        continuousEscrow[_contractId] = 0;

        // Return remaining agent stake
        uint256 remainingStake = ca.currentStake;
        uint256 stakeReturned = remainingStake;

        // Completion bond: release to agent if final checkpoint passed, forfeit to poster otherwise
        uint256 bond = completionBond[_contractId];
        completionBond[_contractId] = 0;
        uint8 lastIdx = cc.totalCheckpoints - 1;
        bool finalPassed = checkpoints[_contractId][lastIdx].status == CheckpointStatus.Passed;

        agentActiveContinuous[ca.agent]--;
        agentTasksCompleted[ca.agent]++;

        // Emit before external calls to avoid reentrancy-events
        emit ContinuousContractCompleted(_contractId, ca.totalPaid, ca.totalSlashed, stakeReturned);

        if (bond > 0) {
            if (finalPassed) {
                token.safeTransfer(ca.agent, bond);
                emit CompletionBondReleased(_contractId, ca.agent, bond);
            } else {
                token.safeTransfer(cc.poster, bond);
                emit CompletionBondForfeited(_contractId, cc.poster, bond);
            }
        }

        if (remainingEscrow > 0) {
            token.safeTransfer(cc.poster, remainingEscrow);
        }

        if (remainingStake > 0) {
            agentActiveStake[ca.agent] -= remainingStake;
            token.safeTransfer(ca.agent, remainingStake);
            ca.currentStake = 0;
        }
    }

    // ═══════════════════════════════════════════════════
    // ANOMALY DETECTION — INTERNAL
    // ═══════════════════════════════════════════════════

    /**
     * @dev Record verifier stats and run anomaly checks
     */
    function _recordVerifierStats(
        address _verifier,
        address _agent,
        VerifierVote _vote
    ) internal {
        verifierTotalVotes[_verifier]++;
        if (_vote == VerifierVote.Approved) {
            verifierApprovals[_verifier]++;
        }

        verifierAgentPairCount[_verifier][_agent]++;
        if (!verifierAgentSeen[_verifier][_agent]) {
            verifierAgentSeen[_verifier][_agent] = true;
            verifierDistinctAgents[_verifier]++;
        }

        if (verifierTotalVotes[_verifier] >= ANOMALY_MIN_VOTES) {
            _checkAnomalies(_verifier, _agent);
        }
    }

    /**
     * @dev Check for statistical anomalies in a verifier's voting pattern
     */
    function _checkAnomalies(address _verifier, address _agent) internal {
        bool flagged = false;

        uint256 approvalRateBps = (verifierApprovals[_verifier] * BPS_DENOMINATOR) / verifierTotalVotes[_verifier];
        if (approvalRateBps >= ANOMALY_APPROVAL_THRESHOLD_BPS) {
            emit AnomalyDetected(_verifier, "high_approval_rate", approvalRateBps, ANOMALY_APPROVAL_THRESHOLD_BPS);
            flagged = true;
        }

        uint256 pairPct = (verifierAgentPairCount[_verifier][_agent] * BPS_DENOMINATOR) / verifierTotalVotes[_verifier];
        if (pairPct >= ANOMALY_PAIR_THRESHOLD_BPS) {
            emit AnomalyDetected(_verifier, "pair_concentration", pairPct, ANOMALY_PAIR_THRESHOLD_BPS);
            flagged = true;
        }

        if (flagged) {
            verifierAnomalyCount[_verifier]++;
            verifierFlagged[_verifier] = true;
            emit VerifierAutoFlagged(_verifier, verifierAnomalyCount[_verifier]);

            if (verifierAnomalyCount[_verifier] >= ANOMALY_BAN_THRESHOLD) {
                agentBannedLocal[_verifier] = true;
                emit VerifierAutoBanned(_verifier, verifierAnomalyCount[_verifier]);
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // CHECKPOINT DISPUTE RESOLUTION (ArenaArbitration callback)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Resolve a checkpoint dispute after arbitration.
     * @dev Only callable by ArenaArbitration. Applies compensating economic adjustments
     *      to correct a wrongly-evaluated checkpoint. Does NOT claw back already-distributed
     *      funds (verifier payouts etc.) — instead applies a forward-looking correction:
     *
     *      If the checkpoint was Failed but agent wins arbitration:
     *        - Reverse the slash: credit agent's currentStake with the previously slashed amount
     *        - Pay the agent the checkpoint payment from escrow
     *        - Flip checkpoint status to Passed, update counters
     *
     *      If the checkpoint was Passed but poster wins arbitration:
     *        - Apply the fail slash: deduct CHECKPOINT_FAIL_SLASH_BPS from agent's currentStake
     *        - No payout reversal (agent already received payment, poster compensated via slash)
     *        - Flip checkpoint status to Failed, update counters
     *        - Check termination conditions
     *
     * @param _contractId Continuous contract ID
     * @param _checkpointIndex Which checkpoint was disputed
     * @param _inFavorOfAgent True = agent wins (checkpoint should be Passed)
     */
    function resolveCheckpointDispute(
        uint256 _contractId,
        uint8 _checkpointIndex,
        bool _inFavorOfAgent
    ) external nonReentrant {
        require(msg.sender == arenaArbitration, "Arena: only arbitration");

        ContinuousContract storage cc = continuousContracts[_contractId];
        ContinuousAssignment storage ca = continuousAssignments[_contractId];
        Checkpoint storage cp = checkpoints[_contractId][_checkpointIndex];

        require(
            cc.status == ContinuousStatus.Active || cc.status == ContinuousStatus.Terminated,
            "Arena: contract not active or terminated"
        );
        require(
            cp.status == CheckpointStatus.Passed || cp.status == CheckpointStatus.Failed,
            "Arena: checkpoint not evaluated"
        );

        CheckpointStatus previousStatus = cp.status;

        if (_inFavorOfAgent) {
            // Agent wins — checkpoint should have been Passed
            if (previousStatus == CheckpointStatus.Failed) {
                // Reverse the fail: credit back the slashed amount
                uint256 reversedSlash = cp.slashAmount;
                ca.currentStake += reversedSlash;
                if (ca.totalSlashed >= reversedSlash) {
                    ca.totalSlashed -= reversedSlash;
                } else {
                    ca.totalSlashed = 0;
                }

                // Pay agent the checkpoint payment from escrow
                IERC20 token = IERC20(cc.token);
                uint256 basePayout = cc.paymentPerCheckpoint;
                uint256 protocolFee = (basePayout * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
                protocolTreasury[cc.token] +=protocolFee;
                uint256 agentPayout = basePayout - protocolFee;

                if (agentPayout > continuousEscrow[_contractId]) {
                    agentPayout = continuousEscrow[_contractId];
                }
                continuousEscrow[_contractId] -= agentPayout + protocolFee > continuousEscrow[_contractId]
                    ? continuousEscrow[_contractId]
                    : agentPayout + protocolFee;

                // Completion bond: withhold 15% of dispute payout
                uint256 bondWithhold = (agentPayout * COMPLETION_BOND_BPS) / BPS_DENOMINATOR;
                completionBond[_contractId] += bondWithhold;
                agentPayout -= bondWithhold;

                if (agentPayout > 0) {
                    token.safeTransfer(ca.agent, agentPayout);
                }
                ca.totalPaid += agentPayout + bondWithhold;

                // Update counters: was Failed → now Passed
                cp.status = CheckpointStatus.Passed;
                cp.payoutAmount = agentPayout + bondWithhold;
                cp.slashAmount = 0;
                cc.failedCheckpoints--;
                cc.passedCheckpoints++;
            }
            // If already Passed and agent wins, no change needed (agent was already correct)
        } else {
            // Poster wins — checkpoint should have been Failed
            if (previousStatus == CheckpointStatus.Passed) {
                // Apply compensating slash
                uint256 slashAmount = (ca.currentStake * CHECKPOINT_FAIL_SLASH_BPS) / BPS_DENOMINATOR;
                if (slashAmount > ca.currentStake) {
                    slashAmount = ca.currentStake;
                }
                ca.currentStake -= slashAmount;
                ca.totalSlashed += slashAmount;

                // Distribute slash: 90% to poster, 10% to protocol
                IERC20 token = IERC20(cc.token);
                uint256 toProtocol = (slashAmount * SLASH_REVENUE_BPS) / BPS_DENOMINATOR;
                uint256 toPoster = slashAmount - toProtocol;
                protocolTreasury[cc.token] +=toProtocol;
                if (toPoster > 0) {
                    token.safeTransfer(cc.poster, toPoster);
                }

                // Update counters: was Passed → now Failed
                cp.status = CheckpointStatus.Failed;
                cp.slashAmount = slashAmount;
                cp.payoutAmount = 0;
                cc.passedCheckpoints--;
                cc.failedCheckpoints++;
                cc.consecutivePasses = 0;

                // Check termination conditions
                if (cc.status == ContinuousStatus.Active) {
                    _checkContinuousTermination(_contractId);
                }
            }
            // If already Failed and poster wins, no change needed (poster was already correct)
        }

        emit CheckpointDisputeResolved(_contractId, _checkpointIndex, _inFavorOfAgent, previousStatus);
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    function getContinuousContract(uint256 _contractId) external view returns (ContinuousContract memory) {
        return continuousContracts[_contractId];
    }

    function getContinuousAssignment(uint256 _contractId) external view returns (ContinuousAssignment memory) {
        return continuousAssignments[_contractId];
    }

    function getCheckpoint(uint256 _contractId, uint8 _checkpointIndex) external view returns (Checkpoint memory) {
        return checkpoints[_contractId][_checkpointIndex];
    }

    function getCheckpointVerifications(uint256 _contractId, uint8 _checkpointIndex) external view returns (Verification[] memory) {
        return checkpointVerifications[_contractId][_checkpointIndex];
    }

    function getCheckpointVerifierList(uint256 _contractId, uint8 _checkpointIndex) external view returns (address[] memory) {
        return checkpointVerifiers[_contractId][_checkpointIndex];
    }

    function getContinuousBidders(uint256 _contractId) external view returns (address[] memory) {
        return continuousBidders[_contractId];
    }

    function getContinuousBid(uint256 _contractId, address _bidder) external view returns (SealedBid memory) {
        return continuousBids[_contractId][_bidder];
    }

    function getVerifierAnomalyProfile(address _verifier) external view returns (
        uint256 totalVotes,
        uint256 approvals,
        uint256 approvalRateBps,
        uint256 distinctAgents,
        uint256 anomalyCount,
        bool isFlagged
    ) {
        totalVotes = verifierTotalVotes[_verifier];
        approvals = verifierApprovals[_verifier];
        approvalRateBps = totalVotes > 0 ? (approvals * BPS_DENOMINATOR) / totalVotes : 0;
        distinctAgents = verifierDistinctAgents[_verifier];
        anomalyCount = verifierAnomalyCount[_verifier];
        isFlagged = verifierFlagged[_verifier];
    }
}

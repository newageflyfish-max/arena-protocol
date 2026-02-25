// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ArenaTypes.sol";

/**
 * @title ArenaConsensus
 * @notice Multi-agent consensus task satellite for The Arena protocol.
 *
 * ARCHITECTURE:
 * - Poster creates a consensus task via createConsensusTask()
 * - A standard ArenaCore sealed bid auction runs, but instead of 1 winner,
 *   the top N agents (by score) are selected
 * - All selected agents execute independently and deliver separate output hashes
 * - After all agents deliver, finalizeConsensus() checks for strict majority:
 *   - Majority match  -> matching agents get paid, dissenters slashed 15% (Minor)
 *   - No majority     -> task escalated to ArenaArbitration
 *
 * This contract manages its own escrow for consensus bounties.
 * It reads agent reputation from ArenaCore for auction scoring.
 */
contract ArenaConsensus is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════
    error AC01(); // Agent count must be 2-5
    error AC02(); // Bounty must be non-zero
    error AC03(); // Deadline must be in the future
    error AC04(); // Bid duration must be non-zero
    error AC05(); // Reveal duration must be non-zero
    error AC06(); // Token not whitelisted
    error AC07(); // Consensus task not found
    error AC08(); // Not in bidding phase
    error AC09(); // Bidding deadline has passed
    error AC10(); // Already submitted a bid
    error AC11(); // Criteria ack hash required
    error AC12(); // Stake too low (must be >= bounty / 10)
    error AC13(); // Not in reveal phase
    error AC14(); // Reveal deadline not reached
    error AC15(); // Bid not found
    error AC16(); // Already revealed
    error AC17(); // Commit hash mismatch
    error AC18(); // Not enough revealed bids for agent count
    error AC19(); // Auction already resolved
    error AC20(); // Reveal deadline not passed
    error AC21(); // Not a selected agent for this task
    error AC22(); // Task not in execution phase
    error AC23(); // Already delivered
    error AC24(); // Deadline passed
    error AC25(); // Output hash must be non-zero
    error AC26(); // Not all agents delivered yet
    error AC27(); // Already finalized
    error AC28(); // Task not in delivered phase
    error AC29(); // Agent is banned
    error AC30(); // Max active bids exceeded
    error AC31(); // Not the task poster
    error AC32(); // Cannot cancel after agents assigned
    error AC33(); // Verifiers must be 1-5

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════
    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant PROTOCOL_FEE_BPS = 250;   // 2.5%
    uint256 internal constant SLASH_MINOR_BPS = 1500;    // 15% slash for dissenters
    uint256 internal constant SLASH_REVENUE_BPS = 1000;  // 10% of slash to protocol
    uint256 internal constant MIN_STAKE_RATIO = 10;      // Minimum stake = perAgentBounty / 10
    uint256 internal constant MAX_BIDDERS = 30;          // Cap bidders for gas
    uint256 internal constant MAX_AGENTS = 5;
    uint256 internal constant MIN_AGENTS = 2;

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════
    enum ConsensusStatus {
        Open,           // 0 - Accepting sealed bids
        BidReveal,      // 1 - Reveal window (automatic after bid deadline)
        Executing,      // 2 - Agents selected, executing independently
        Delivered,      // 3 - All agents delivered, awaiting finalization
        Consensus,      // 4 - Strict majority reached, settled
        NoConsensus,    // 5 - No majority, escalated to arbitration
        Cancelled       // 6 - Poster cancelled before assignment
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct ConsensusTask {
        address poster;
        address token;
        uint256 totalBounty;        // Total bounty across all agents
        uint256 perAgentBounty;     // totalBounty / agentCount
        uint256 deadline;
        uint256 slashWindow;
        uint256 createdAt;
        uint256 bidDeadline;
        uint256 revealDeadline;
        uint8 requiredVerifiers;
        uint8 agentCount;           // 2-5 agents required
        uint8 deliveredCount;       // How many agents have delivered
        ConsensusStatus status;
        bytes32 criteriaHash;
        string taskType;
    }

    struct ConsensusBid {
        bytes32 commitHash;
        bool revealed;
        address agent;
        uint256 stake;
        uint256 price;
        uint256 eta;
    }

    struct AgentSubmission {
        address agent;
        uint256 stake;
        uint256 price;
        bytes32 outputHash;
        bool delivered;
        bool paid;
    }

    struct ConsensusResult {
        bool finalized;
        bool consensusReached;
        bytes32 majorityHash;       // The hash that got majority
        uint8 majorityCount;        // How many agents matched
        uint8 totalAgents;
    }

    // ═══════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════

    IArenaCore public immutable core;
    address public arenaArbitration;

    uint256 public consensusTaskCount;
    mapping(uint256 => ConsensusTask) public consensusTasks;
    mapping(uint256 => address[]) public taskBidders;
    mapping(uint256 => mapping(address => ConsensusBid)) public bids;
    mapping(uint256 => AgentSubmission[]) public submissions;
    mapping(uint256 => ConsensusResult) public results;
    mapping(address => uint256) public agentActiveBids;

    // Protocol treasury per token
    mapping(address => uint256) public protocolTreasury;

    // Token whitelist (mirrors ArenaCore)
    mapping(address => bool) public tokenWhitelist;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event ConsensusTaskCreated(
        uint256 indexed taskId,
        address indexed poster,
        uint256 totalBounty,
        uint8 agentCount,
        string taskType,
        uint256 deadline
    );

    event ConsensusBidSubmitted(
        uint256 indexed taskId,
        address indexed agent,
        bytes32 commitHash
    );

    event ConsensusBidRevealed(
        uint256 indexed taskId,
        address indexed agent,
        uint256 stake,
        uint256 price
    );

    event ConsensusAuctionResolved(
        uint256 indexed taskId,
        address[] selectedAgents
    );

    event ConsensusAgentDelivered(
        uint256 indexed taskId,
        address indexed agent,
        bytes32 outputHash,
        uint8 deliveredCount,
        uint8 totalRequired
    );

    event ConsensusReached(
        uint256 indexed taskId,
        bytes32 majorityHash,
        uint8 majorityCount,
        uint8 totalAgents
    );

    event ConsensusNotReached(
        uint256 indexed taskId,
        uint8 uniqueHashes,
        uint8 totalAgents
    );

    event ConsensusAgentPaid(
        uint256 indexed taskId,
        address indexed agent,
        uint256 payout
    );

    event ConsensusAgentSlashed(
        uint256 indexed taskId,
        address indexed agent,
        uint256 slashAmount
    );

    event ConsensusTaskCancelled(uint256 indexed taskId);

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        core = IArenaCore(_core);
    }

    // ═══════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════

    function setArenaArbitration(address _arb) external onlyOwner {
        arenaArbitration = _arb;
    }

    function setTokenWhitelist(address _token, bool _allowed) external onlyOwner {
        tokenWhitelist[_token] = _allowed;
    }

    function withdrawProtocolFees(address _token, address _to) external onlyOwner {
        uint256 amount = protocolTreasury[_token];
        protocolTreasury[_token] = 0;
        IERC20(_token).safeTransfer(_to, amount);
    }

    // ═══════════════════════════════════════════════════
    // TASK CREATION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Create a consensus task requiring multiple agents.
     * @param _totalBounty Total bounty split across all agents
     * @param _agentCount Number of agents required (2-5)
     * @param _deadline Task execution deadline
     * @param _slashWindow Post-completion slash window
     * @param _bidDuration Duration of sealed bid period
     * @param _revealDuration Duration of reveal period
     * @param _requiredVerifiers Verifiers needed (1-5)
     * @param _criteriaHash Hash of acceptance criteria
     * @param _taskType Category string
     * @param _token ERC20 token for payment
     */
    function createConsensusTask(
        uint256 _totalBounty,
        uint8 _agentCount,
        uint256 _deadline,
        uint256 _slashWindow,
        uint256 _bidDuration,
        uint256 _revealDuration,
        uint8 _requiredVerifiers,
        bytes32 _criteriaHash,
        string calldata _taskType,
        address _token
    ) external nonReentrant returns (uint256 taskId) {
        if (_agentCount < MIN_AGENTS || _agentCount > MAX_AGENTS) revert AC01();
        if (_totalBounty == 0) revert AC02();
        if (_deadline <= block.timestamp) revert AC03();
        if (_bidDuration == 0) revert AC04();
        if (_revealDuration == 0) revert AC05();
        if (!tokenWhitelist[_token]) revert AC06();
        if (_requiredVerifiers == 0 || _requiredVerifiers > 5) revert AC33();

        // Transfer total bounty to this contract as escrow
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _totalBounty);

        taskId = consensusTaskCount++;

        consensusTasks[taskId] = ConsensusTask({
            poster: msg.sender,
            token: _token,
            totalBounty: _totalBounty,
            perAgentBounty: _totalBounty / _agentCount,
            deadline: _deadline,
            slashWindow: _slashWindow,
            createdAt: block.timestamp,
            bidDeadline: block.timestamp + _bidDuration,
            revealDeadline: block.timestamp + _bidDuration + _revealDuration,
            requiredVerifiers: _requiredVerifiers,
            agentCount: _agentCount,
            deliveredCount: 0,
            status: ConsensusStatus.Open,
            criteriaHash: _criteriaHash,
            taskType: _taskType
        });

        emit ConsensusTaskCreated(taskId, msg.sender, _totalBounty, _agentCount, _taskType, _deadline);
    }

    /**
     * @notice Cancel a consensus task before agents are assigned.
     */
    function cancelConsensusTask(uint256 _taskId) external nonReentrant {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.poster != msg.sender) revert AC31();
        if (task.status != ConsensusStatus.Open && task.status != ConsensusStatus.BidReveal) revert AC32();

        task.status = ConsensusStatus.Cancelled;

        // Refund bounty to poster
        IERC20(task.token).safeTransfer(task.poster, task.totalBounty);

        // Refund any revealed bid stakes
        address[] storage bidders = taskBidders[_taskId];
        for (uint256 i = 0; i < bidders.length; i++) {
            ConsensusBid storage bid = bids[_taskId][bidders[i]];
            agentActiveBids[bidders[i]]--;
            if (bid.revealed && bid.stake > 0) {
                IERC20(task.token).safeTransfer(bidders[i], bid.stake);
            }
        }

        emit ConsensusTaskCancelled(_taskId);
    }

    // ═══════════════════════════════════════════════════
    // SEALED BID AUCTION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Submit a sealed bid for a consensus task.
     * @param _taskId Consensus task ID
     * @param _commitHash keccak256(abi.encodePacked(agent, stake, price, eta, salt))
     * @param _criteriaAckHash Hash proving the agent has read the criteria
     */
    function submitBid(
        uint256 _taskId,
        bytes32 _commitHash,
        bytes32 _criteriaAckHash
    ) external {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.poster == address(0)) revert AC07();
        if (task.status != ConsensusStatus.Open) revert AC08();
        if (block.timestamp > task.bidDeadline) revert AC09();
        if (bids[_taskId][msg.sender].commitHash != bytes32(0)) revert AC10();
        if (_criteriaAckHash == bytes32(0)) revert AC11();
        if (core.agentBanned(msg.sender)) revert AC29();
        if (agentActiveBids[msg.sender] >= 5) revert AC30();

        bids[_taskId][msg.sender] = ConsensusBid({
            commitHash: _commitHash,
            revealed: false,
            agent: msg.sender,
            stake: 0,
            price: 0,
            eta: 0
        });

        taskBidders[_taskId].push(msg.sender);
        agentActiveBids[msg.sender]++;

        // Transition to BidReveal if past bid deadline
        if (block.timestamp >= task.bidDeadline) {
            task.status = ConsensusStatus.BidReveal;
        }

        emit ConsensusBidSubmitted(_taskId, msg.sender, _commitHash);
    }

    /**
     * @notice Reveal a previously sealed bid.
     * @param _taskId Consensus task ID
     * @param _stake Amount the agent will stake
     * @param _price Requested payment
     * @param _eta Estimated time to completion (seconds)
     * @param _salt Random salt used in commit
     */
    function revealBid(
        uint256 _taskId,
        uint256 _stake,
        uint256 _price,
        uint256 _eta,
        bytes32 _salt
    ) external nonReentrant {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.poster == address(0)) revert AC07();

        // Auto-transition to BidReveal if bid deadline passed
        if (task.status == ConsensusStatus.Open && block.timestamp >= task.bidDeadline) {
            task.status = ConsensusStatus.BidReveal;
        }
        if (task.status != ConsensusStatus.BidReveal) revert AC13();
        if (block.timestamp > task.revealDeadline) revert AC14();

        ConsensusBid storage bid = bids[_taskId][msg.sender];
        if (bid.commitHash == bytes32(0)) revert AC15();
        if (bid.revealed) revert AC16();

        // Verify commit hash
        bytes32 expectedHash = keccak256(abi.encodePacked(msg.sender, _stake, _price, _eta, _salt));
        if (bid.commitHash != expectedHash) revert AC17();

        // Validate minimum stake
        uint256 minStake = task.perAgentBounty / MIN_STAKE_RATIO;
        if (_stake < minStake) revert AC12();

        bid.revealed = true;
        bid.stake = _stake;
        bid.price = _price;
        bid.eta = _eta;

        // Transfer stake to this contract
        IERC20(task.token).safeTransferFrom(msg.sender, address(this), _stake);

        emit ConsensusBidRevealed(_taskId, msg.sender, _stake, _price);
    }

    /**
     * @notice Resolve the auction — select top N agents by score.
     *         Score = (stake * (reputation + 1) * 1e18) / price
     * @param _taskId Consensus task ID
     */
    function resolveAuction(uint256 _taskId) external nonReentrant {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.poster == address(0)) revert AC07();

        // Auto-transition to BidReveal if needed
        if (task.status == ConsensusStatus.Open && block.timestamp >= task.bidDeadline) {
            task.status = ConsensusStatus.BidReveal;
        }
        if (task.status != ConsensusStatus.BidReveal && task.status != ConsensusStatus.Open) revert AC19();
        if (block.timestamp < task.revealDeadline) revert AC20();

        address[] storage bidders = taskBidders[_taskId];

        // Count revealed bids
        uint256 revealedCount = 0;
        for (uint256 i = 0; i < bidders.length; i++) {
            if (bids[_taskId][bidders[i]].revealed) {
                revealedCount++;
            }
        }
        if (revealedCount < task.agentCount) revert AC18();

        // Score all revealed bids and select top N
        // Using a simple selection: score and keep top agentCount
        address[] memory selectedAgents = new address[](task.agentCount);
        uint256[] memory selectedScores = new uint256[](task.agentCount);

        for (uint256 i = 0; i < bidders.length; i++) {
            ConsensusBid storage bid = bids[_taskId][bidders[i]];
            agentActiveBids[bidders[i]]--;

            if (!bid.revealed) continue;

            uint256 rep = core.agentReputation(bid.agent) + 1;
            uint256 score = (bid.stake * rep * 1e18) / bid.price;

            // Insert into top N (sorted descending)
            uint256 insertIdx = task.agentCount; // Not in top N by default
            for (uint256 j = 0; j < task.agentCount; j++) {
                if (score > selectedScores[j]) {
                    insertIdx = j;
                    break;
                }
            }

            if (insertIdx < task.agentCount) {
                // Refund the agent being displaced (if any)
                if (selectedAgents[task.agentCount - 1] != address(0)) {
                    address displaced = selectedAgents[task.agentCount - 1];
                    ConsensusBid storage displacedBid = bids[_taskId][displaced];
                    IERC20(task.token).safeTransfer(displaced, displacedBid.stake);
                }

                // Shift down
                for (uint256 j = task.agentCount - 1; j > insertIdx; j--) {
                    selectedAgents[j] = selectedAgents[j - 1];
                    selectedScores[j] = selectedScores[j - 1];
                }

                selectedAgents[insertIdx] = bid.agent;
                selectedScores[insertIdx] = score;
            } else {
                // Not in top N — refund stake
                IERC20(task.token).safeTransfer(bid.agent, bid.stake);
            }
        }

        // Create submissions for the selected agents
        for (uint256 i = 0; i < task.agentCount; i++) {
            ConsensusBid storage winBid = bids[_taskId][selectedAgents[i]];
            submissions[_taskId].push(AgentSubmission({
                agent: selectedAgents[i],
                stake: winBid.stake,
                price: winBid.price,
                outputHash: bytes32(0),
                delivered: false,
                paid: false
            }));
        }

        task.status = ConsensusStatus.Executing;

        emit ConsensusAuctionResolved(_taskId, selectedAgents);
    }

    // ═══════════════════════════════════════════════════
    // DELIVERY
    // ═══════════════════════════════════════════════════

    /**
     * @notice Agent delivers their output for a consensus task.
     * @param _taskId Consensus task ID
     * @param _outputHash Hash of the agent's delivered output
     */
    function deliverOutput(uint256 _taskId, bytes32 _outputHash) external {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.status != ConsensusStatus.Executing) revert AC22();
        if (block.timestamp > task.deadline) revert AC24();
        if (_outputHash == bytes32(0)) revert AC25();

        AgentSubmission[] storage subs = submissions[_taskId];
        bool found = false;
        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].agent == msg.sender) {
                if (subs[i].delivered) revert AC23();
                subs[i].outputHash = _outputHash;
                subs[i].delivered = true;
                task.deliveredCount++;
                found = true;

                emit ConsensusAgentDelivered(
                    _taskId, msg.sender, _outputHash,
                    task.deliveredCount, task.agentCount
                );
                break;
            }
        }
        if (!found) revert AC21();

        // Auto-transition when all agents have delivered
        if (task.deliveredCount == task.agentCount) {
            task.status = ConsensusStatus.Delivered;
        }
    }

    // ═══════════════════════════════════════════════════
    // CONSENSUS FINALIZATION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Finalize a consensus task after all agents deliver.
     *         Compares output hashes for strict majority.
     *         - Majority: matching agents paid, dissenters slashed 15%
     *         - No majority: escalate to arbitration
     */
    function finalizeConsensus(uint256 _taskId) external nonReentrant {
        ConsensusTask storage task = consensusTasks[_taskId];
        if (task.status != ConsensusStatus.Delivered) revert AC28();

        ConsensusResult storage result = results[_taskId];
        if (result.finalized) revert AC27();

        AgentSubmission[] storage subs = submissions[_taskId];
        uint8 agentCount = task.agentCount;

        // Count occurrences of each unique hash
        // Max 5 agents, so we can use arrays
        bytes32[] memory uniqueHashes = new bytes32[](agentCount);
        uint8[] memory hashCounts = new uint8[](agentCount);
        uint8 uniqueCount = 0;

        for (uint256 i = 0; i < agentCount; i++) {
            bytes32 h = subs[i].outputHash;
            bool foundHash = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (uniqueHashes[j] == h) {
                    hashCounts[j]++;
                    foundHash = true;
                    break;
                }
            }
            if (!foundHash) {
                uniqueHashes[uniqueCount] = h;
                hashCounts[uniqueCount] = 1;
                uniqueCount++;
            }
        }

        // Find the hash with the most occurrences
        uint8 maxCount = 0;
        bytes32 maxHash;
        for (uint256 i = 0; i < uniqueCount; i++) {
            if (hashCounts[i] > maxCount) {
                maxCount = hashCounts[i];
                maxHash = uniqueHashes[i];
            }
        }

        // Strict majority = more than half
        bool hasMajority = maxCount > (agentCount / 2);

        result.finalized = true;
        result.totalAgents = agentCount;

        if (hasMajority) {
            result.consensusReached = true;
            result.majorityHash = maxHash;
            result.majorityCount = maxCount;
            task.status = ConsensusStatus.Consensus;

            _settleWithConsensus(_taskId, maxHash);

            emit ConsensusReached(_taskId, maxHash, maxCount, agentCount);
        } else {
            result.consensusReached = false;
            result.majorityCount = maxCount;
            task.status = ConsensusStatus.NoConsensus;

            // Escalate to arbitration — hold all funds
            // In production, this would call ArenaArbitration.raiseDispute()

            emit ConsensusNotReached(_taskId, uniqueCount, agentCount);
        }
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL: SETTLEMENT
    // ═══════════════════════════════════════════════════

    /**
     * @dev Settle a consensus task where majority was reached.
     *      Matching agents: paid their agreed price minus protocol fee, stake returned.
     *      Dissenting agents: slashed 15% of stake, remainder returned, no payment.
     */
    function _settleWithConsensus(uint256 _taskId, bytes32 _majorityHash) internal {
        ConsensusTask storage task = consensusTasks[_taskId];
        AgentSubmission[] storage subs = submissions[_taskId];
        IERC20 token = IERC20(task.token);

        uint256 totalSlashRevenue = 0;

        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].outputHash == _majorityHash) {
                // Matching agent — pay them
                uint256 protocolFee = (subs[i].price * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
                protocolTreasury[task.token] += protocolFee;
                uint256 agentPayout = subs[i].price - protocolFee;

                // Return full stake + payment
                token.safeTransfer(subs[i].agent, subs[i].stake + agentPayout);
                subs[i].paid = true;

                emit ConsensusAgentPaid(_taskId, subs[i].agent, agentPayout);
            } else {
                // Dissenting agent — slash 15% of stake
                uint256 slashAmount = (subs[i].stake * SLASH_MINOR_BPS) / BPS_DENOMINATOR;
                uint256 stakeReturn = subs[i].stake - slashAmount;

                // Protocol gets 10% of slash, rest goes to poster
                uint256 toProtocol = (slashAmount * SLASH_REVENUE_BPS) / BPS_DENOMINATOR;
                protocolTreasury[task.token] += toProtocol;
                totalSlashRevenue += (slashAmount - toProtocol);

                // Return remaining stake (no payment)
                token.safeTransfer(subs[i].agent, stakeReturn);
                subs[i].paid = true;

                emit ConsensusAgentSlashed(_taskId, subs[i].agent, slashAmount);
            }
        }

        // Remaining bounty (unspent portion) + slash revenue goes to poster
        uint256 totalPaid = 0;
        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].outputHash == _majorityHash) {
                totalPaid += subs[i].price;
            }
        }
        uint256 posterReturn = task.totalBounty - totalPaid + totalSlashRevenue;
        // Deduct protocol fees already taken from agent payments
        // Protocol fees were already deducted from agent payouts above
        if (posterReturn > 0) {
            token.safeTransfer(task.poster, posterReturn);
        }
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Get the full consensus task data.
     */
    function getConsensusTask(uint256 _taskId) external view returns (ConsensusTask memory) {
        return consensusTasks[_taskId];
    }

    /**
     * @notice Get all agent submissions for a consensus task.
     */
    function getSubmissions(uint256 _taskId) external view returns (AgentSubmission[] memory) {
        return submissions[_taskId];
    }

    /**
     * @notice Get the consensus result for a task.
     */
    function getConsensusResult(uint256 _taskId) external view returns (ConsensusResult memory) {
        return results[_taskId];
    }

    /**
     * @notice Get consensus status summary for a task.
     * @return status Current status
     * @return agentCount Total agents required
     * @return deliveredCount How many have delivered
     * @return finalized Whether consensus check is complete
     * @return consensusReached Whether strict majority was found
     * @return majorityHash The majority output hash (if consensus reached)
     * @return majorityCount How many agents matched the majority
     */
    function getConsensusStatus(uint256 _taskId) external view returns (
        ConsensusStatus status,
        uint8 agentCount,
        uint8 deliveredCount,
        bool finalized,
        bool consensusReached,
        bytes32 majorityHash,
        uint8 majorityCount
    ) {
        ConsensusTask storage task = consensusTasks[_taskId];
        ConsensusResult storage result = results[_taskId];
        return (
            task.status,
            task.agentCount,
            task.deliveredCount,
            result.finalized,
            result.consensusReached,
            result.majorityHash,
            result.majorityCount
        );
    }

    /**
     * @notice Get selected agents and their submission status.
     */
    function getAgentSubmissions(uint256 _taskId) external view returns (
        address[] memory agents,
        bytes32[] memory outputHashes,
        bool[] memory delivered,
        bool[] memory paid
    ) {
        AgentSubmission[] storage subs = submissions[_taskId];
        uint256 len = subs.length;
        agents = new address[](len);
        outputHashes = new bytes32[](len);
        delivered = new bool[](len);
        paid = new bool[](len);
        for (uint256 i = 0; i < len; i++) {
            agents[i] = subs[i].agent;
            outputHashes[i] = subs[i].outputHash;
            delivered[i] = subs[i].delivered;
            paid[i] = subs[i].paid;
        }
    }

    /**
     * @notice Check if an address is a selected agent for a task.
     */
    function isSelectedAgent(uint256 _taskId, address _agent) external view returns (bool) {
        AgentSubmission[] storage subs = submissions[_taskId];
        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].agent == _agent) return true;
        }
        return false;
    }
}

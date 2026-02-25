// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";

// ═══════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════

/**
 * @notice Interface for reading task/assignment/verifier state from ArenaCore
 *         and for callbacks that modify core state from the arbitration satellite.
 */
interface IArenaCoreSatellite {
    // --- Read-only getters ---
    function tasks(uint256 id)
        external
        view
        returns (
            address poster,
            address token,
            uint256 bounty,
            uint256 deadline,
            uint256 slashWindow,
            uint256 createdAt,
            uint256 bidDeadline,
            uint256 revealDeadline,
            uint8 requiredVerifiers,
            uint8 status, // TaskStatus as uint8
            bytes32 criteriaHash
        );

    function assignments(uint256 id)
        external
        view
        returns (
            address agent,
            uint256 stake,
            uint256 price,
            uint256 assignedAt,
            uint256 deliveredAt,
            bytes32 outputHash
        );

    function agentReputation(address agent) external view returns (uint256);
    function agentBanned(address agent) external view returns (bool);
    function verifierPool(uint256 index) external view returns (address);
    function verifierPoolLength() external view returns (uint256);

    // --- Satellite callbacks (ArenaCore implements with onlyArbitration modifier) ---
    function setTaskStatusFromArbitration(uint256 taskId, uint8 newStatus) external;
    function adjustReputationFromSatellite(address agent, int256 delta) external;
}

/**
 * @notice Interface for reading continuous contract state
 *         and resolving checkpoint disputes via the continuous-contracts satellite.
 */
interface IArenaContinuous {
    function continuousContracts(uint256 id)
        external
        view
        returns (
            address poster,
            address token,
            uint256 totalBounty,
            uint256 paymentPerCheckpoint,
            uint256 duration,
            uint256 checkpointInterval,
            uint256 createdAt,
            uint256 bidDeadline,
            uint256 revealDeadline,
            uint8 requiredVerifiers,
            uint8 maxFailures,
            uint8 totalCheckpoints,
            uint8 passedCheckpoints,
            uint8 failedCheckpoints,
            uint8 status, // ContinuousContractStatus as uint8
            bytes32 criteriaHash
        );

    function continuousAssignments(uint256 id)
        external
        view
        returns (
            address agent,
            uint256 stake,
            uint256 price,
            uint256 startedAt
        );

    function resolveCheckpointDispute(
        uint256 contractId,
        uint8 checkpointIndex,
        bool inFavorOfAgent
    ) external;
}

// ═══════════════════════════════════════════════════
// CONTRACT
// ═══════════════════════════════════════════════════

/**
 * @title ArenaArbitration
 * @notice Standalone Arbitration Council module for The Arena protocol.
 * @dev Owns all arbitration state and logic. Reads task/agent/verifier state from
 *      ArenaCore and continuous-contract state from ArenaContinuous via interfaces.
 *      VRF-based arbitrator selection, staking, voting, settlement, and timeout enforcement.
 */
contract ArenaArbitration is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // ENUMS (ArenaCore-inline versions)
    // ═══════════════════════════════════════════════════

    enum ArbitrationStatus {
        None,       // No dispute filed
        Selecting,  // VRF request sent, awaiting arbitrator selection
        Staking,    // Arbitrators selected, must stake within window
        Voting,     // All arbitrators staked, voting in progress
        Resolved,   // Majority reached, dispute settled
        Expired     // Not enough arbitrators staked or voted in time
    }

    enum ArbitratorVote {
        Pending,
        InFavorOfAgent,
        InFavorOfPoster
    }

    enum DisputeType {
        Task,       // Dispute on a regular task
        Checkpoint  // Dispute on a continuous contract checkpoint
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS (ArenaCore-inline versions)
    // ═══════════════════════════════════════════════════

    struct Arbitration {
        uint256 disputeId;
        DisputeType disputeType;
        uint256 taskOrContractId;
        uint8 checkpointIndex;
        address disputant;
        address token;
        uint256 bountyAmount;
        uint256 disputeFee;
        uint256 createdAt;
        uint256 stakingDeadline;
        uint256 votingDeadline;
        uint8 totalArbitrators;
        uint8 stakedArbitrators;
        uint8 votesSubmitted;
        uint8 votesForAgent;
        uint8 votesForPoster;
        ArbitrationStatus status;
    }

    struct ArbitratorInfo {
        address arbitrator;
        uint256 stake;
        ArbitratorVote vote;
        bool staked;
    }

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════

    uint256 public constant ARBITRATION_COUNCIL_SIZE = 5;
    uint256 public constant ARBITRATION_STAKE_MULTIPLIER = 2;
    uint256 public constant ARBITRATION_LOSER_SLASH_BPS = 2500;   // 25%
    uint256 public constant ARBITRATION_TIMEOUT = 48 hours;
    uint256 public constant ARBITRATION_TIMEOUT_SLASH_BPS = 1500; // 15%
    uint256 public constant MIN_ARBITRATOR_REPUTATION = 20;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant DISPUTE_FEE_BPS = 500;               // 5%
    uint256 public constant PROTOCOL_FEE_BPS = 250;              // 2.5% (for checkpoint reversal)

    // TaskStatus enum values from ArenaCore (used as uint8 in callbacks)
    uint8 internal constant TASK_STATUS_COMPLETED = 5;
    uint8 internal constant TASK_STATUS_FAILED = 6;
    uint8 internal constant TASK_STATUS_DISPUTED = 7;

    // ═══════════════════════════════════════════════════
    // EXTERNAL REFERENCES
    // ═══════════════════════════════════════════════════

    address public arenaCore;
    address public arenaContinuous;

    // ═══════════════════════════════════════════════════
    // VRF CONFIGURATION
    // ═══════════════════════════════════════════════════

    IVRFCoordinatorV2Plus public vrfCoordinator;
    uint256 public vrfSubscriptionId;
    bytes32 public vrfKeyHash;
    uint32 public vrfCallbackGasLimit = 500_000;
    uint16 public vrfRequestConfirmations = 3;

    // ═══════════════════════════════════════════════════
    // ARBITRATION STATE
    // ═══════════════════════════════════════════════════

    /// @notice Global dispute counter
    uint256 public disputeCount;

    /// @notice Protocol treasury for dispute fees collected by this satellite
    uint256 public protocolTreasury;

    /// @notice Dispute ID => Arbitration
    mapping(uint256 => Arbitration) public arbitrations;

    /// @notice Dispute ID => arbitrator index => ArbitratorInfo
    mapping(uint256 => mapping(uint8 => ArbitratorInfo)) public arbitrators;

    /// @notice Dispute ID => list of selected arbitrator addresses
    mapping(uint256 => address[]) public arbitratorList;

    /// @notice VRF request ID => dispute ID (for arbitrator selection)
    mapping(uint256 => uint256) public vrfRequestToDispute;

    /// @notice Task ID => dispute ID (for regular task disputes)
    mapping(uint256 => uint256) public taskDispute;

    /// @notice Contract ID => Checkpoint Index => dispute ID (for checkpoint disputes)
    mapping(uint256 => mapping(uint8 => uint256)) public checkpointDispute;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event DisputeRaised(
        uint256 indexed disputeId,
        DisputeType disputeType,
        uint256 indexed taskOrContractId,
        address indexed disputant,
        uint256 disputeFee
    );
    event ArbitrationVRFRequested(uint256 indexed disputeId, uint256 requestId);
    event ArbitratorsSelected(uint256 indexed disputeId, address[] arbitratorsAddresses);
    event ArbitratorStaked(uint256 indexed disputeId, address indexed arbitrator, uint256 stake);
    event ArbitratorVoteSubmitted(uint256 indexed disputeId, address indexed arbitrator, ArbitratorVote vote);
    event ArbitratorSlashed(uint256 indexed disputeId, address indexed arbitrator, uint256 amount);
    event ArbitratorTimedOut(uint256 indexed disputeId, address indexed arbitrator, uint256 slashAmount);
    event DisputeResolved(uint256 indexed disputeId, bool inFavorOfAgent, uint8 votesForAgent, uint8 votesForPoster);
    event DisputeExpired(uint256 indexed disputeId, string reason);
    event DisputeFeeDistributed(uint256 indexed disputeId, uint256 toProtocol, uint256 toArbitrators);
    event VRFConfigured(
        address indexed coordinator,
        uint256 subscriptionId,
        uint32 callbackGasLimit,
        uint16 requestConfirmations
    );
    event ArenaCoreUpdated(address indexed newCore);
    event ArenaContinuousUpdated(address indexed newContinuous);
    event TreasuryWithdrawn(address indexed to, address indexed token, uint256 amount);

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier onlyCoreOrOwner() {
        require(
            msg.sender == arenaCore || msg.sender == owner(),
            "ArenaArbitration: not core or owner"
        );
        _;
    }

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        require(_core != address(0), "ArenaArbitration: zero core address");
        arenaCore = _core;
    }

    // ═══════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════

    function setArenaCore(address _core) external onlyOwner {
        require(_core != address(0), "ArenaArbitration: zero address");
        arenaCore = _core;
        emit ArenaCoreUpdated(_core);
    }

    function setArenaContinuous(address _continuous) external onlyOwner {
        require(_continuous != address(0), "ArenaArbitration: zero address");
        arenaContinuous = _continuous;
        emit ArenaContinuousUpdated(_continuous);
    }

    /**
     * @notice Configure Chainlink VRF V2.5 for random arbitrator selection
     */
    function configureVRF(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations
    ) external onlyOwner {
        vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        vrfSubscriptionId = _subscriptionId;
        vrfKeyHash = _keyHash;
        vrfCallbackGasLimit = _callbackGasLimit;
        vrfRequestConfirmations = _requestConfirmations;
        emit VRFConfigured(_vrfCoordinator, _subscriptionId, _callbackGasLimit, _requestConfirmations);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Withdraw accumulated protocol treasury to a recipient.
     * @param _token The ERC20 token to withdraw
     * @param _to Recipient address
     * @param _amount Amount to withdraw (capped at protocolTreasury)
     */
    function withdrawTreasury(address _token, address _to, uint256 _amount) external onlyOwner {
        require(_amount <= protocolTreasury, "ArenaArbitration: exceeds treasury");
        protocolTreasury -= _amount;
        IERC20(_token).safeTransfer(_to, _amount);
        emit TreasuryWithdrawn(_to, _token, _amount);
    }

    // ═══════════════════════════════════════════════════
    // DISPUTE RESOLUTION — PUBLIC FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Raise a dispute on a completed or failed task.
     *         Can be called by poster (if completed) or agent (if failed).
     *         Must be within slash window. Triggers VRF-based arbitration council selection.
     *         Disputant pays 5% of bounty as dispute fee (refunded if they win).
     */
    function raiseDispute(uint256 _taskId) external nonReentrant whenNotPaused {
        IArenaCoreSatellite core = IArenaCoreSatellite(arenaCore);

        // Read task data from core
        (
            address poster,
            address token,
            uint256 bounty,
            , // deadline
            uint256 slashWindow,
            , // createdAt
            , // bidDeadline
            , // revealDeadline
            , // requiredVerifiers
            uint8 taskStatus,
            // criteriaHash
        ) = core.tasks(_taskId);

        // Read assignment data from core
        (address agent, , , , uint256 deliveredAt, ) = core.assignments(_taskId);

        require(
            taskStatus == TASK_STATUS_COMPLETED ||
            taskStatus == TASK_STATUS_FAILED ||
            taskStatus == 4 || // Verifying
            taskStatus == TASK_STATUS_DISPUTED,
            "ArenaArbitration: cannot dispute this status"
        );

        require(
            msg.sender == poster || msg.sender == agent,
            "ArenaArbitration: not authorized to dispute"
        );

        // Must be within slash window
        if (deliveredAt > 0) {
            require(
                block.timestamp <= deliveredAt + slashWindow,
                "ArenaArbitration: slash window expired"
            );
        }

        // No existing dispute on this task
        require(taskDispute[_taskId] == 0, "ArenaArbitration: dispute already exists");

        // Calculate dispute fee
        uint256 disputeFee = (bounty * DISPUTE_FEE_BPS) / BPS_DENOMINATOR;

        // --- EFFECTS: All state writes before external calls (CEI pattern) ---

        // Create arbitration record
        disputeCount++;
        uint256 disputeId = disputeCount;
        taskDispute[_taskId] = disputeId;

        arbitrations[disputeId] = Arbitration({
            disputeId: disputeId,
            disputeType: DisputeType.Task,
            taskOrContractId: _taskId,
            checkpointIndex: 0,
            disputant: msg.sender,
            token: token,
            bountyAmount: bounty,
            disputeFee: disputeFee,
            createdAt: block.timestamp,
            stakingDeadline: 0,
            votingDeadline: 0,
            totalArbitrators: 0,
            stakedArbitrators: 0,
            votesSubmitted: 0,
            votesForAgent: 0,
            votesForPoster: 0,
            status: ArbitrationStatus.Selecting
        });

        emit DisputeRaised(disputeId, DisputeType.Task, _taskId, msg.sender, disputeFee);

        // --- INTERACTIONS: All external calls after state writes ---

        // Collect dispute fee from disputant
        IERC20(token).safeTransferFrom(msg.sender, address(this), disputeFee);

        // Set task status to Disputed via core callback
        core.setTaskStatusFromArbitration(_taskId, TASK_STATUS_DISPUTED);

        // Request VRF for arbitrator selection
        _requestArbitrationVRF(disputeId);
    }

    /**
     * @notice Raise a dispute on a continuous contract checkpoint.
     *         Can be called by poster or assigned agent.
     */
    function raiseCheckpointDispute(uint256 _contractId, uint8 _checkpointIndex) external nonReentrant whenNotPaused {
        require(arenaContinuous != address(0), "ArenaArbitration: continuous not set");
        IArenaContinuous continuous = IArenaContinuous(arenaContinuous);

        // Read continuous contract data
        (
            address poster,
            address token,
            uint256 totalBounty,
            uint256 paymentPerCheckpoint,
            , // duration
            , // checkpointInterval
            , // createdAt
            , // bidDeadline
            , // revealDeadline
            , // requiredVerifiers
            , // maxFailures
            , // totalCheckpoints
            , // passedCheckpoints
            , // failedCheckpoints
            uint8 ccStatus,
            // criteriaHash
        ) = continuous.continuousContracts(_contractId);

        // Read assignment data
        (address agent, , , ) = continuous.continuousAssignments(_contractId);

        // Active status is 2 in the ContinuousContractStatus enum
        require(ccStatus == 2, "ArenaArbitration: contract not active");

        require(
            msg.sender == poster || msg.sender == agent,
            "ArenaArbitration: not authorized to dispute"
        );

        // No existing dispute on this checkpoint
        require(
            checkpointDispute[_contractId][_checkpointIndex] == 0,
            "ArenaArbitration: dispute already exists"
        );

        // Calculate and collect dispute fee
        uint256 disputeFee = (totalBounty * DISPUTE_FEE_BPS) / BPS_DENOMINATOR;
        IERC20(token).safeTransferFrom(msg.sender, address(this), disputeFee);

        // Create arbitration record
        disputeCount++;
        uint256 disputeId = disputeCount;
        checkpointDispute[_contractId][_checkpointIndex] = disputeId;

        arbitrations[disputeId] = Arbitration({
            disputeId: disputeId,
            disputeType: DisputeType.Checkpoint,
            taskOrContractId: _contractId,
            checkpointIndex: _checkpointIndex,
            disputant: msg.sender,
            token: token,
            bountyAmount: paymentPerCheckpoint,
            disputeFee: disputeFee,
            createdAt: block.timestamp,
            stakingDeadline: 0,
            votingDeadline: 0,
            totalArbitrators: 0,
            stakedArbitrators: 0,
            votesSubmitted: 0,
            votesForAgent: 0,
            votesForPoster: 0,
            status: ArbitrationStatus.Selecting
        });

        emit DisputeRaised(disputeId, DisputeType.Checkpoint, _contractId, msg.sender, disputeFee);

        // Request VRF for arbitrator selection
        _requestArbitrationVRF(disputeId);
    }

    /**
     * @notice Stake as a selected arbitrator for a dispute.
     *         Each arbitrator must stake 2x the task bounty.
     */
    function stakeAsArbitrator(uint256 _disputeId) external nonReentrant whenNotPaused {
        Arbitration storage arb = arbitrations[_disputeId];
        require(arb.status == ArbitrationStatus.Staking, "ArenaArbitration: not in staking phase");
        require(block.timestamp <= arb.stakingDeadline, "ArenaArbitration: staking deadline passed");

        // Find which arbitrator index the caller is
        int256 arbIndex = -1;
        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            if (arbitrators[_disputeId][i].arbitrator == msg.sender) {
                arbIndex = int256(uint256(i));
                break;
            }
        }
        require(arbIndex >= 0, "ArenaArbitration: not a selected arbitrator");

        ArbitratorInfo storage info = arbitrators[_disputeId][uint8(uint256(arbIndex))];
        require(!info.staked, "ArenaArbitration: already staked");

        uint256 requiredStake = arb.bountyAmount * ARBITRATION_STAKE_MULTIPLIER;
        IERC20(arb.token).safeTransferFrom(msg.sender, address(this), requiredStake);

        info.stake = requiredStake;
        info.staked = true;
        arb.stakedArbitrators++;

        emit ArbitratorStaked(_disputeId, msg.sender, requiredStake);

        // If all arbitrators have staked, move to voting phase
        if (arb.stakedArbitrators == arb.totalArbitrators) {
            arb.status = ArbitrationStatus.Voting;
            arb.votingDeadline = block.timestamp + ARBITRATION_TIMEOUT;
        }
    }

    /**
     * @notice Submit a vote as an arbitrator.
     * @param _disputeId The dispute to vote on
     * @param _vote InFavorOfAgent or InFavorOfPoster
     */
    function submitArbitrationVote(uint256 _disputeId, ArbitratorVote _vote) external nonReentrant whenNotPaused {
        Arbitration storage arb = arbitrations[_disputeId];
        require(arb.status == ArbitrationStatus.Voting, "ArenaArbitration: not in voting phase");
        require(block.timestamp <= arb.votingDeadline, "ArenaArbitration: voting deadline passed");
        require(
            _vote == ArbitratorVote.InFavorOfAgent || _vote == ArbitratorVote.InFavorOfPoster,
            "ArenaArbitration: invalid vote"
        );

        // Find which arbitrator index the caller is
        int256 arbIndex = -1;
        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            if (arbitrators[_disputeId][i].arbitrator == msg.sender) {
                arbIndex = int256(uint256(i));
                break;
            }
        }
        require(arbIndex >= 0, "ArenaArbitration: not an arbitrator");

        ArbitratorInfo storage info = arbitrators[_disputeId][uint8(uint256(arbIndex))];
        require(info.staked, "ArenaArbitration: not staked");
        require(info.vote == ArbitratorVote.Pending, "ArenaArbitration: already voted");

        info.vote = _vote;
        arb.votesSubmitted++;

        if (_vote == ArbitratorVote.InFavorOfAgent) {
            arb.votesForAgent++;
        } else {
            arb.votesForPoster++;
        }

        emit ArbitratorVoteSubmitted(_disputeId, msg.sender, _vote);

        // Check if all staked arbitrators have voted - auto-settle
        if (arb.votesSubmitted == arb.stakedArbitrators) {
            _settleArbitration(_disputeId);
        }
    }

    /**
     * @notice Enforce arbitration staking timeout.
     *         If not all arbitrators staked by deadline, expire and refund disputant.
     *
     *         Uses checks-effects-interactions pattern: all state changes and events
     *         are performed before any external calls (transfers).
     */
    function enforceArbitrationStakingTimeout(uint256 _disputeId) external nonReentrant {
        Arbitration storage arb = arbitrations[_disputeId];
        require(arb.status == ArbitrationStatus.Staking, "ArenaArbitration: not in staking phase");
        require(block.timestamp > arb.stakingDeadline, "ArenaArbitration: staking deadline not passed");

        // Not enough arbitrators staked - expire the dispute
        IERC20 token = IERC20(arb.token);

        // --- EFFECTS: Collect refund data and update state BEFORE external calls ---
        uint256 disputeFeeRefund = arb.disputeFee;
        address disputant = arb.disputant;

        address[] memory refundAddresses = new address[](arb.totalArbitrators);
        uint256[] memory refundAmounts = new uint256[](arb.totalArbitrators);
        uint256 refundCount = 0;

        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            ArbitratorInfo storage info = arbitrators[_disputeId][i];
            if (info.staked && info.stake > 0) {
                refundAddresses[refundCount] = info.arbitrator;
                refundAmounts[refundCount] = info.stake;
                refundCount++;
                // STATE CHANGE BEFORE external calls
                info.stake = 0;
            }
        }

        arb.status = ArbitrationStatus.Expired;

        emit DisputeExpired(_disputeId, "not enough arbitrators staked");

        // --- INTERACTIONS: All external calls after all state changes ---

        // Refund dispute fee to disputant
        token.safeTransfer(disputant, disputeFeeRefund);

        // Refund staked arbitrators
        // slither-disable-next-line calls-loop
        for (uint256 i = 0; i < refundCount; i++) {
            token.safeTransfer(refundAddresses[i], refundAmounts[i]);
        }
    }

    /**
     * @notice Enforce arbitration voting timeout.
     *         Slash non-voting arbitrators and settle with votes received.
     *
     *         Uses checks-effects-interactions pattern: all state changes and events
     *         are performed before any external calls (transfers, reputation adjustments).
     *
     * @dev Slither reentrancy-no-eth: The external calls to core.adjustReputationFromSatellite
     *      target the trusted ArenaCore contract which has its own reentrancy guards. Reordering
     *      is not feasible because _settleArbitration must execute after timeout processing and
     *      itself contains both state writes and external calls in CEI order.
     */
    // slither-disable-next-line reentrancy-no-eth,calls-loop
    function enforceArbitrationVotingTimeout(uint256 _disputeId) external nonReentrant {
        Arbitration storage arb = arbitrations[_disputeId];
        require(arb.status == ArbitrationStatus.Voting, "ArenaArbitration: not in voting phase");
        require(block.timestamp > arb.votingDeadline, "ArenaArbitration: voting deadline not passed");

        IERC20 token = IERC20(arb.token);
        IArenaCoreSatellite core = IArenaCoreSatellite(arenaCore);

        // --- EFFECTS: Collect timeout data and update state BEFORE external calls ---
        uint256 totalArbitratorsCount = arb.totalArbitrators;
        address[] memory timedOutAddresses = new address[](totalArbitratorsCount);
        uint256[] memory timedOutReturnAmounts = new uint256[](totalArbitratorsCount);
        uint256[] memory timedOutSlashAmounts = new uint256[](totalArbitratorsCount);
        uint256 timedOutCount = 0;

        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            ArbitratorInfo storage info = arbitrators[_disputeId][i];
            if (info.staked && info.vote == ArbitratorVote.Pending) {
                // Slash for timeout
                uint256 slashAmount = (info.stake * ARBITRATION_TIMEOUT_SLASH_BPS) / BPS_DENOMINATOR;
                uint256 returnAmount = info.stake - slashAmount;

                protocolTreasury += slashAmount;

                timedOutAddresses[timedOutCount] = info.arbitrator;
                timedOutReturnAmounts[timedOutCount] = returnAmount;
                timedOutSlashAmounts[timedOutCount] = slashAmount;
                timedOutCount++;

                // STATE CHANGE BEFORE external calls
                info.stake = 0;

                emit ArbitratorTimedOut(_disputeId, info.arbitrator, slashAmount);
            }
        }

        // Capture state for the no-votes path before any external calls
        bool hasVotes = arb.votesSubmitted > 0;
        address disputant = arb.disputant;
        uint256 disputeFee = arb.disputeFee;

        if (!hasVotes) {
            // EFFECTS: Set status BEFORE external calls
            arb.status = ArbitrationStatus.Expired;
            emit DisputeExpired(_disputeId, "no votes submitted");
        }

        // --- INTERACTIONS: All external calls after all state changes ---

        // Transfer return amounts and apply reputation penalties for timed-out arbitrators
        // slither-disable-next-line calls-loop
        for (uint256 i = 0; i < timedOutCount; i++) {
            if (timedOutReturnAmounts[i] > 0) {
                token.safeTransfer(timedOutAddresses[i], timedOutReturnAmounts[i]);
            }
            // Reputation penalty via core callback
            core.adjustReputationFromSatellite(timedOutAddresses[i], -3);
        }

        // If we have any votes, settle with what we have
        if (hasVotes) {
            _settleArbitration(_disputeId);
        } else {
            // No votes at all - refund disputant
            token.safeTransfer(disputant, disputeFee);
        }
    }

    // ═══════════════════════════════════════════════════
    // VRF CALLBACK
    // ═══════════════════════════════════════════════════

    /**
     * @notice Callback from VRF Coordinator with random words.
     *         Selects random arbitrators from the verifier pool.
     * @dev Only callable by the VRF Coordinator.
     */
    function rawFulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) external {
        require(msg.sender == address(vrfCoordinator), "ArenaArbitration: only VRF coordinator");

        uint256 disputeId = vrfRequestToDispute[_requestId];
        require(disputeId > 0, "ArenaArbitration: unknown VRF request");

        _fulfillArbitrationVRF(disputeId, _randomWords[0]);
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL — VRF
    // ═══════════════════════════════════════════════════

    /**
     * @dev Request VRF randomness to select arbitrators for a dispute.
     */
    function _requestArbitrationVRF(uint256 _disputeId) internal {
        IArenaCoreSatellite core = IArenaCoreSatellite(arenaCore);
        uint256 poolSize = core.verifierPoolLength();
        require(poolSize >= ARBITRATION_COUNCIL_SIZE, "ArenaArbitration: not enough agents in pool");

        uint256 requestId = vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: vrfKeyHash,
                subId: vrfSubscriptionId,
                requestConfirmations: vrfRequestConfirmations,
                callbackGasLimit: vrfCallbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        vrfRequestToDispute[requestId] = _disputeId;
        emit ArbitrationVRFRequested(_disputeId, requestId);
    }

    /**
     * @dev Internal handler for arbitration VRF fulfillment.
     *      Selects ARBITRATION_COUNCIL_SIZE high-reputation agents from verifier pool.
     */
    // slither-disable-next-line calls-loop
    function _fulfillArbitrationVRF(uint256 _disputeId, uint256 _randomWord) internal {
        Arbitration storage arb = arbitrations[_disputeId];
        require(arb.status == ArbitrationStatus.Selecting, "ArenaArbitration: not selecting arbitrators");

        IArenaCoreSatellite core = IArenaCoreSatellite(arenaCore);
        uint256 poolSize = core.verifierPoolLength();
        uint256 needed = ARBITRATION_COUNCIL_SIZE;

        // Determine who is involved in the dispute (must be excluded)
        address poster;
        address agent;
        if (arb.disputeType == DisputeType.Task) {
            (poster, , , , , , , , , , ) = core.tasks(arb.taskOrContractId);
            (agent, , , , , ) = core.assignments(arb.taskOrContractId);
        } else {
            require(arenaContinuous != address(0), "ArenaArbitration: continuous not set");
            IArenaContinuous continuous = IArenaContinuous(arenaContinuous);
            (poster, , , , , , , , , , , , , , , ) = continuous.continuousContracts(arb.taskOrContractId);
            (agent, , , ) = continuous.continuousAssignments(arb.taskOrContractId);
        }

        address[] memory selected = new address[](needed);
        uint256 selectedCount = 0;

        // slither-disable-next-line calls-loop
        for (uint256 i = 0; selectedCount < needed && i < poolSize * 10; i++) {
            uint256 derivedRandom = uint256(keccak256(abi.encode(_randomWord, i)));
            uint256 idx = derivedRandom % poolSize;
            address candidate = core.verifierPool(idx);

            // Skip if involved party, banned, or insufficient reputation
            if (candidate == agent || candidate == poster || core.agentBanned(candidate)) {
                continue;
            }

            // Must meet minimum reputation threshold
            if (core.agentReputation(candidate) < MIN_ARBITRATOR_REPUTATION) {
                continue;
            }

            bool alreadySelected = false;
            for (uint256 j = 0; j < selectedCount; j++) {
                if (selected[j] == candidate) {
                    alreadySelected = true;
                    break;
                }
            }
            if (alreadySelected) continue;

            selected[selectedCount] = candidate;
            selectedCount++;
        }

        require(selectedCount == needed, "ArenaArbitration: could not select enough arbitrators");

        // Record selected arbitrators
        for (uint256 i = 0; i < selectedCount; i++) {
            arbitrators[_disputeId][uint8(i)] = ArbitratorInfo({
                arbitrator: selected[i],
                stake: 0,
                vote: ArbitratorVote.Pending,
                staked: false
            });
            arbitratorList[_disputeId].push(selected[i]);
        }

        arb.totalArbitrators = uint8(selectedCount);
        arb.status = ArbitrationStatus.Staking;
        arb.stakingDeadline = block.timestamp + ARBITRATION_TIMEOUT;

        emit ArbitratorsSelected(_disputeId, selected);
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL — SETTLEMENT
    // ═══════════════════════════════════════════════════

    /**
     * @dev Internal: settle arbitration based on votes.
     *      Majority wins. Losing-side arbitrators forfeit 25% of stake.
     *      Dispute fee split between protocol and winning arbitrators.
     *
     *      Uses checks-effects-interactions pattern: all state changes and events
     *      are performed before any external calls (transfers, reputation adjustments).
     */
    // slither-disable-next-line calls-loop
    function _settleArbitration(uint256 _disputeId) internal {
        Arbitration storage arb = arbitrations[_disputeId];

        bool inFavorOfAgent = arb.votesForAgent > arb.votesForPoster;
        // If tie (shouldn't happen with 5, but handle gracefully), favor poster (status quo)

        IERC20 token = IERC20(arb.token);
        IArenaCoreSatellite core = IArenaCoreSatellite(arenaCore);

        // Determine winning vote
        ArbitratorVote winningVote = inFavorOfAgent
            ? ArbitratorVote.InFavorOfAgent
            : ArbitratorVote.InFavorOfPoster;

        uint256 totalLoserSlash = 0;
        uint256 winnerCount = 0;

        // --- Collect payout/reputation data in memory before any external calls ---

        // Arrays to track loser payouts
        uint256 totalArbitrators = arb.totalArbitrators;
        address[] memory loserAddresses = new address[](totalArbitrators);
        uint256[] memory loserReturnAmounts = new uint256[](totalArbitrators);
        uint256[] memory loserSlashAmounts = new uint256[](totalArbitrators);
        uint256 loserCount = 0;

        // EFFECTS: Process losers - update state FIRST, collect transfer data
        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            ArbitratorInfo storage info = arbitrators[_disputeId][i];
            if (!info.staked || info.stake == 0) continue; // Timed out, already handled

            if (info.vote == winningVote) {
                // Winner - counted for bonus distribution
                winnerCount++;
            } else if (info.vote != ArbitratorVote.Pending) {
                // Loser - slash 25% of their stake
                uint256 slashAmount = (info.stake * ARBITRATION_LOSER_SLASH_BPS) / BPS_DENOMINATOR;
                uint256 returnAmount = info.stake - slashAmount;
                totalLoserSlash += slashAmount;

                // Record transfer data
                loserAddresses[loserCount] = info.arbitrator;
                loserReturnAmounts[loserCount] = returnAmount;
                loserSlashAmounts[loserCount] = slashAmount;
                loserCount++;

                // STATE CHANGE BEFORE external calls
                info.stake = 0;

                emit ArbitratorSlashed(_disputeId, info.arbitrator, slashAmount);
            }
        }

        // EFFECTS: Distribute dispute fee - state changes
        uint256 feeToProtocol = arb.disputeFee / 2;
        uint256 feeToArbitrators = arb.disputeFee - feeToProtocol;
        protocolTreasury += feeToProtocol;

        // Slash revenue from losers: 50% to protocol, 50% to winning arbitrators
        uint256 slashToProtocol = totalLoserSlash / 2;
        uint256 slashToArbitrators = totalLoserSlash - slashToProtocol;
        protocolTreasury += slashToProtocol;

        // Calculate winner bonus
        uint256 totalArbitratorBonus = feeToArbitrators + slashToArbitrators;
        uint256 bonusPerWinner = winnerCount > 0 ? totalArbitratorBonus / winnerCount : 0;

        // Collect winner payout data and update state BEFORE external calls
        address[] memory winnerAddresses = new address[](totalArbitrators);
        uint256[] memory winnerPayouts = new uint256[](totalArbitrators);
        uint256 winnerIdx = 0;

        for (uint8 i = 0; i < arb.totalArbitrators; i++) {
            ArbitratorInfo storage info = arbitrators[_disputeId][i];
            if (!info.staked || info.stake == 0) continue;
            if (info.vote == winningVote) {
                uint256 payout = info.stake + bonusPerWinner;
                winnerAddresses[winnerIdx] = info.arbitrator;
                winnerPayouts[winnerIdx] = payout;
                winnerIdx++;

                // STATE CHANGE BEFORE external calls
                info.stake = 0;
            }
        }

        // EFFECTS: Emit events BEFORE external calls
        emit DisputeFeeDistributed(_disputeId, feeToProtocol, feeToArbitrators);

        // EFFECTS: Set final status BEFORE external calls
        arb.status = ArbitrationStatus.Resolved;

        emit DisputeResolved(_disputeId, inFavorOfAgent, arb.votesForAgent, arb.votesForPoster);

        // --- INTERACTIONS: All external calls happen after all state changes ---

        // Transfer loser return amounts
        // slither-disable-next-line calls-loop
        for (uint256 i = 0; i < loserCount; i++) {
            if (loserReturnAmounts[i] > 0) {
                token.safeTransfer(loserAddresses[i], loserReturnAmounts[i]);
            }
            // Reputation penalty for losing-side arbitrators
            core.adjustReputationFromSatellite(loserAddresses[i], -2);
        }

        // Transfer winner payouts
        // slither-disable-next-line calls-loop
        for (uint256 i = 0; i < winnerIdx; i++) {
            token.safeTransfer(winnerAddresses[i], winnerPayouts[i]);
            // Reputation bonus for correct arbitration
            core.adjustReputationFromSatellite(winnerAddresses[i], 3);
        }

        // Resolve the underlying dispute
        if (arb.disputeType == DisputeType.Task) {
            if (inFavorOfAgent) {
                core.setTaskStatusFromArbitration(arb.taskOrContractId, TASK_STATUS_COMPLETED);
                // Reputation adjustment: reward agent for vindication
                (address agentAddr, , , , , ) = core.assignments(arb.taskOrContractId);
                core.adjustReputationFromSatellite(agentAddr, 5);
            } else {
                core.setTaskStatusFromArbitration(arb.taskOrContractId, TASK_STATUS_FAILED);
                // Reputation penalty for agent losing dispute
                (address agentAddr, , , , , ) = core.assignments(arb.taskOrContractId);
                core.adjustReputationFromSatellite(agentAddr, -5);
            }
        } else {
            // Checkpoint dispute - delegate resolution to ArenaContinuous
            require(arenaContinuous != address(0), "ArenaArbitration: continuous not set");
            IArenaContinuous(arenaContinuous).resolveCheckpointDispute(
                arb.taskOrContractId,
                arb.checkpointIndex,
                inFavorOfAgent
            );
        }
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Get full arbitration data for a dispute.
     */
    function getArbitration(uint256 _disputeId) external view returns (Arbitration memory) {
        return arbitrations[_disputeId];
    }

    /**
     * @notice Get arbitrator info for a specific index in a dispute.
     */
    function getArbitratorInfo(uint256 _disputeId, uint8 _index) external view returns (ArbitratorInfo memory) {
        return arbitrators[_disputeId][_index];
    }

    /**
     * @notice Get list of all selected arbitrator addresses for a dispute.
     */
    function getArbitratorList(uint256 _disputeId) external view returns (address[] memory) {
        return arbitratorList[_disputeId];
    }

    /**
     * @notice Get the dispute ID for a task.
     */
    function getTaskDisputeId(uint256 _taskId) external view returns (uint256) {
        return taskDispute[_taskId];
    }

    /**
     * @notice Get the dispute ID for a checkpoint.
     */
    function getCheckpointDisputeId(uint256 _contractId, uint8 _checkpointIndex) external view returns (uint256) {
        return checkpointDispute[_contractId][_checkpointIndex];
    }
}

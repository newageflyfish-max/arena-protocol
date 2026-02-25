// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {IArenaCoreAuction, Task, Assignment, TaskStatus, SlashSeverity, VerifierVote} from "./ArenaTypes.sol";

interface ICompliance {
    function isPosterBlacklisted(address) external view returns (bool);
    function hasAcceptedTos(address) external view returns (bool);
    function isSanctioned(address) external view returns (bool);
}

/**
 * @title ArenaCoreMain
 * @notice Core task management, escrow, and shared state for The Arena protocol.
 * @dev Holds bounty escrow, task/assignment state, agent stats, and authorized setters
 *      callable by ArenaCoreAuction. All existing satellites point at this contract.
 */
contract ArenaCoreMain is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════

    error A01(); error A03(); error A06(); error A07(); error A08(); error A09(); error A10();
    error A53(); error A54(); error A56(); error A57(); error A58(); error A59(); error A60();
    error A61(); error A62(); error A66(); error A67();
    error A68(); error A69(); error A70(); error A71();
    error A78(); error A79(); error A80(); error A81();
    error A82(); error A83(); error A84();
    error NOT_AUCTION();

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════

    uint256 internal constant PROTOCOL_FEE_BPS = 250;
    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant MAX_VERIFIERS = 5;
    uint256 internal constant EMERGENCY_PAUSE_THRESHOLD = 7 days;
    uint256 internal constant SLASH_REVENUE_BPS = 1000;
    uint256 internal constant SLASH_LATE = 1500;
    uint256 internal constant SLASH_MINOR = 2500;
    uint256 internal constant SLASH_MATERIAL = 5000;
    uint256 internal constant SLASH_EXECUTION = 7500;
    uint256 internal constant SLASH_CRITICAL = 10000;
    uint256 internal constant SLASH_COOLDOWN = 72 hours;

    // ═══════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════

    IERC20 public immutable defaultToken;

    address internal treasuryAddress;
    mapping(address => bool) public tokenWhitelist;
    mapping(address => bool) public tokenHasMevRisk;
    uint256 internal pausedAt;

    uint256 public taskCount;
    mapping(address => uint256) public protocolTreasury;

    mapping(uint256 => Task) internal _tasks;
    mapping(uint256 => Assignment) internal _assignments;

    // Agent state (shared — writable by Auction via setters)
    mapping(address => uint256) public agentReputation;
    mapping(address => uint256) public agentTasksCompleted;
    mapping(address => uint256) public agentTasksFailed;
    mapping(address => uint256) public agentActiveStake;
    mapping(address => bool) public agentBanned;
    mapping(address => uint256) public agentActiveBids;
    mapping(address => uint256) public agentSlashCooldownEnd;

    // Slash tracking
    mapping(uint256 => uint256) public slashBonds;
    mapping(uint256 => uint256) public taskSlashAmount;
    mapping(uint256 => uint256) public taskBondSlashAmount;

    // Poster rate limiting
    uint256 internal minBounty = 50e6;
    uint256 public maxPosterActiveTasks = 20;
    mapping(address => uint256) public posterActiveTasks;

    // Satellite addresses
    address internal arenaArbitration;
    address public arenaOutcomes;
    address public arenaCompliance;
    address public arenaCoreAuction;
    address public arenaCoreVRF;

    // Task type restrictions
    bool internal requireTaskTypeApproval;
    mapping(bytes32 => bool) internal approvedTaskTypes;
    mapping(bytes32 => bytes32) public taskTypeSchemaHash;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event TaskCreated(
        uint256 indexed taskId, address indexed poster, uint256 bounty,
        string taskType, uint256 deadline, uint8 requiredVerifiers
    );
    event TaskCancelled(uint256 indexed taskId);
    event TokenWhitelisted(address indexed token, bool mevRisk);
    event TokenRemoved(address indexed token);
    event EmergencyWithdrawn(uint256 indexed taskId, address indexed party, uint256 amount);
    event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, SlashSeverity severity);
    event SlashBondForfeited(uint256 indexed taskId, address indexed agent, uint256 slashedAmount, SlashSeverity severity);
    event SlashBondClaimed(uint256 indexed taskId, address indexed agent, uint256 amount);
    event AgentSlashCooldownApplied(address indexed agent, uint256 cooldownEnd);

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier onlyAuction() {
        if (msg.sender != arenaCoreAuction && msg.sender != arenaCoreVRF) revert NOT_AUCTION();
        _;
    }

    modifier onlyEmergency() {
        if (pausedAt == 0) revert A68();
        if (block.timestamp < pausedAt + EMERGENCY_PAUSE_THRESHOLD) revert A68();
        _;
    }

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _defaultToken) Ownable(msg.sender) {
        defaultToken = IERC20(_defaultToken);
        tokenWhitelist[_defaultToken] = true;
    }

    // ═══════════════════════════════════════════════════
    // TASK SUBMISSION
    // ═══════════════════════════════════════════════════

    /// @notice Creates a new task with bounty escrowed from the poster
    /// @param _bounty Amount of tokens to escrow as the task bounty
    /// @param _deadline Timestamp by which the task must be completed
    /// @param _slashWindow Duration in seconds after delivery during which slashing is allowed
    /// @param _bidDuration Duration in seconds for the bidding phase
    /// @param _revealDuration Duration in seconds for the reveal phase after bidding
    /// @param _requiredVerifiers Number of verifiers required for the task
    /// @param _criteriaHash Hash of the task acceptance criteria
    /// @param _taskType String identifier for the type of task
    /// @param _token Payment token address; use address(0) for the default token
    /// @return taskId The ID of the newly created task
    function createTask(
        uint256 _bounty,
        uint256 _deadline,
        uint256 _slashWindow,
        uint256 _bidDuration,
        uint256 _revealDuration,
        uint8 _requiredVerifiers,
        bytes32 _criteriaHash,
        string calldata _taskType,
        address _token
    ) external whenNotPaused nonReentrant returns (uint256 taskId) {
        if (_bounty == 0) revert A06();
        if (_bounty < minBounty) revert A78();
        if (posterActiveTasks[msg.sender] >= maxPosterActiveTasks) revert A79();
        if (_deadline <= block.timestamp) revert A07();
        // M-01 fix: deadline must be after auction (bid + reveal) concludes
        if (_deadline <= block.timestamp + _bidDuration + _revealDuration) revert A07();
        if (_requiredVerifiers == 0 || _requiredVerifiers > MAX_VERIFIERS) revert A08();
        if (_bidDuration == 0) revert A09();
        if (_revealDuration == 0) revert A10();
        if (requireTaskTypeApproval && !approvedTaskTypes[keccak256(bytes(_taskType))]) revert A81();
        if (arenaCompliance != address(0)) {
            if (ICompliance(arenaCompliance).isSanctioned(msg.sender)) revert A84();
            if (ICompliance(arenaCompliance).isPosterBlacklisted(msg.sender)) revert A82();
            if (!ICompliance(arenaCompliance).hasAcceptedTos(msg.sender)) revert A83();
        }

        address token = _token == address(0) ? address(defaultToken) : _token;
        if (!tokenWhitelist[token]) revert A67();

        IERC20(token).safeTransferFrom(msg.sender, address(this), _bounty);

        taskId = taskCount++;
        posterActiveTasks[msg.sender]++;

        _tasks[taskId] = Task({
            poster: msg.sender,
            token: token,
            bounty: _bounty,
            deadline: _deadline,
            slashWindow: _slashWindow,
            createdAt: block.timestamp,
            bidDeadline: block.timestamp + _bidDuration,
            revealDeadline: block.timestamp + _bidDuration + _revealDuration,
            requiredVerifiers: _requiredVerifiers,
            status: TaskStatus.Open,
            criteriaHash: _criteriaHash,
            taskType: _taskType
        });

        emit TaskCreated(taskId, msg.sender, _bounty, _taskType, _deadline, _requiredVerifiers);
    }

    /// @notice Cancels an open task and refunds the escrowed bounty to the poster
    /// @param _taskId ID of the task to cancel
    function cancelTask(uint256 _taskId) external nonReentrant {
        Task storage task = _tasks[_taskId];
        if (msg.sender != task.poster) revert A01();
        if (task.status != TaskStatus.Open) revert A03();

        task.status = TaskStatus.Cancelled;
        posterActiveTasks[task.poster]--;

        // Refund bounty from this contract
        IERC20(task.token).safeTransfer(task.poster, task.bounty);

        // Ask Auction to refund bid stakes
        if (arenaCoreAuction != address(0)) {
            IArenaCoreAuction(arenaCoreAuction).refundBidsOnCancel(_taskId, task.token);
        }

        emit TaskCancelled(_taskId);
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /// @notice Returns the full Task struct for a given task ID
    /// @param _taskId ID of the task to retrieve
    /// @return The Task struct
    function getTask(uint256 _taskId) external view returns (Task memory) {
        return _tasks[_taskId];
    }

    /// @notice Returns the full Assignment struct for a given task ID
    /// @param _taskId ID of the task whose assignment to retrieve
    /// @return The Assignment struct
    function getAssignment(uint256 _taskId) external view returns (Assignment memory) {
        return _assignments[_taskId];
    }

    /// @notice Returns both the Task and Assignment structs for a given task ID
    /// @param _taskId ID of the task to retrieve
    /// @return The Task struct and Assignment struct
    function getTaskAndAssignment(uint256 _taskId) external view returns (Task memory, Assignment memory) {
        return (_tasks[_taskId], _assignments[_taskId]);
    }

    /// @notice Returns task fields as a flat tuple for a given task ID
    /// @param _taskId ID of the task to retrieve
    /// @return poster The task poster address
    /// @return token The payment token address
    /// @return bounty The escrowed bounty amount
    /// @return deadline The task completion deadline timestamp
    /// @return slashWindow The post-completion slash window in seconds
    /// @return createdAt The task creation timestamp
    /// @return bidDeadline The bidding phase deadline timestamp
    /// @return revealDeadline The reveal phase deadline timestamp
    /// @return requiredVerifiers The number of required verifiers
    /// @return status The current task status
    /// @return criteriaHash The hash of the task acceptance criteria
    function tasks(uint256 _taskId) external view returns (
        address poster, address token, uint256 bounty, uint256 deadline,
        uint256 slashWindow, uint256 createdAt, uint256 bidDeadline,
        uint256 revealDeadline, uint8 requiredVerifiers, TaskStatus status,
        bytes32 criteriaHash
    ) {
        Task storage t = _tasks[_taskId];
        return (t.poster, t.token, t.bounty, t.deadline, t.slashWindow,
                t.createdAt, t.bidDeadline, t.revealDeadline, t.requiredVerifiers,
                t.status, t.criteriaHash);
    }

    /// @notice Returns assignment fields as a flat tuple for a given task ID
    /// @param _taskId ID of the task whose assignment to retrieve
    /// @return agent The assigned agent address
    /// @return stake The agent's staked amount
    /// @return price The agreed price for the task
    /// @return assignedAt The assignment timestamp
    /// @return deliveredAt The delivery timestamp
    /// @return outputHash The hash of the delivered output
    function assignments(uint256 _taskId) external view returns (
        address agent, uint256 stake, uint256 price, uint256 assignedAt,
        uint256 deliveredAt, bytes32 outputHash
    ) {
        Assignment storage a = _assignments[_taskId];
        return (a.agent, a.stake, a.price, a.assignedAt, a.deliveredAt, a.outputHash);
    }

    // ═══════════════════════════════════════════════════
    // PASSTHROUGH VIEWS (delegate to Auction)
    // ═══════════════════════════════════════════════════

    /// @notice Returns the number of verifiers in the pool (delegates to Auction)
    /// @return The length of the verifier pool
    function verifierPoolLength() external view returns (uint256) {
        if (arenaCoreAuction == address(0)) return 0;
        return IArenaCoreAuction(arenaCoreAuction).verifierPoolLength();
    }

    /// @notice Returns the verifier address at a given index in the pool (delegates to Auction)
    /// @param index Index in the verifier pool array
    /// @return The verifier address at the given index
    function verifierPool(uint256 index) external view returns (address) {
        return IArenaCoreAuction(arenaCoreAuction).verifierPool(index);
    }

    /// @notice Returns bid details for a given task and agent (delegates to Auction)
    /// @param taskId ID of the task
    /// @param agent Address of the bidding agent
    /// @return commitHash The sealed commit hash of the bid
    /// @return criteriaAckHash The criteria acknowledgement hash
    /// @return revealed Whether the bid has been revealed
    /// @return bidAgent The agent address from the bid
    /// @return stake The staked amount
    /// @return price The bid price
    /// @return eta The estimated time of arrival
    function bids(uint256 taskId, address agent) external view returns (
        bytes32 commitHash, bytes32 criteriaAckHash, bool revealed,
        address bidAgent, uint256 stake, uint256 price, uint256 eta
    ) {
        return IArenaCoreAuction(arenaCoreAuction).bids(taskId, agent);
    }

    /// @notice Returns the bidder address at a given index for a task (delegates to Auction)
    /// @param taskId ID of the task
    /// @param index Index in the task's bidder array
    /// @return The bidder address
    function taskBidders(uint256 taskId, uint256 index) external view returns (address) {
        return IArenaCoreAuction(arenaCoreAuction).taskBidders(taskId, index);
    }

    /// @notice Returns verification details at a given index for a task (delegates to Auction)
    /// @param taskId ID of the task
    /// @param index Index in the task's verifications array
    /// @return verifier The verifier address
    /// @return stake The verifier's staked amount
    /// @return vote The verifier's vote
    /// @return reportHash The hash of the verification report
    function verifications(uint256 taskId, uint256 index) external view returns (
        address verifier, uint256 stake, VerifierVote vote, bytes32 reportHash
    ) {
        return IArenaCoreAuction(arenaCoreAuction).verifications(taskId, index);
    }

    /// @notice Returns the verifier address at a given index for a task (delegates to Auction)
    /// @param taskId ID of the task
    /// @param index Index in the task's verifier array
    /// @return The verifier address
    function taskVerifiers(uint256 taskId, uint256 index) external view returns (address) {
        return IArenaCoreAuction(arenaCoreAuction).taskVerifiers(taskId, index);
    }

    /// @notice Returns verifier registration info for a given address (delegates to Auction)
    /// @param verifier Address of the verifier
    /// @return stake The verifier's staked amount
    /// @return active Whether the verifier is currently active
    /// @return registeredAt The timestamp when the verifier registered
    function verifierRegistry(address verifier) external view returns (uint256 stake, bool active, uint256 registeredAt) {
        return IArenaCoreAuction(arenaCoreAuction).verifierRegistry(verifier);
    }

    // ═══════════════════════════════════════════════════
    // POST-COMPLETION SLASHING (runs on Main — bonds in escrow)
    // ═══════════════════════════════════════════════════

    function _slashBps(SlashSeverity s) internal pure returns (uint256) {
        if (s == SlashSeverity.Late) return SLASH_LATE;
        if (s == SlashSeverity.Minor) return SLASH_MINOR;
        if (s == SlashSeverity.Material) return SLASH_MATERIAL;
        if (s == SlashSeverity.Execution) return SLASH_EXECUTION;
        return SLASH_CRITICAL;
    }

    /// @notice Slashes an agent's bond after task completion within the slash window
    /// @param _taskId ID of the completed task to slash
    /// @param _severity The severity level determining the slash percentage
    function postCompletionSlash(uint256 _taskId, SlashSeverity _severity) external nonReentrant {
        if (msg.sender != owner() && msg.sender != arenaOutcomes) revert A01();

        Task storage task = _tasks[_taskId];
        Assignment storage assignment = _assignments[_taskId];

        if (task.status != TaskStatus.Completed) revert A56();
        if (block.timestamp > assignment.deliveredAt + task.slashWindow) revert A57();

        uint256 bond = slashBonds[_taskId];
        if (bond == 0) revert A58();

        uint256 sBps = _slashBps(_severity);
        uint256 slashAmount = (bond * sBps) / BPS_DENOMINATOR;
        if (slashAmount > bond) slashAmount = bond;
        taskBondSlashAmount[_taskId] = slashAmount;
        uint256 agentReturn = bond - slashAmount;

        slashBonds[_taskId] = 0;

        uint256 toProtocol = (bond * sBps * SLASH_REVENUE_BPS) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
        uint256 toPoster = slashAmount - toProtocol;

        bool isBan = _severity == SlashSeverity.Critical;
        uint256 cooldownEnd;
        if (_severity == SlashSeverity.Material ||
            _severity == SlashSeverity.Execution ||
            _severity == SlashSeverity.Critical) {
            cooldownEnd = block.timestamp + SLASH_COOLDOWN;
        }

        task.status = TaskStatus.Failed;
        if (sBps >= 2000) {
            if (agentReputation[assignment.agent] >= 20) {
                agentReputation[assignment.agent] -= 20;
            } else {
                agentReputation[assignment.agent] = 0;
            }
        } else {
            if (agentReputation[assignment.agent] >= 5) {
                agentReputation[assignment.agent] -= 5;
            } else {
                agentReputation[assignment.agent] = 0;
            }
        }
        agentTasksFailed[assignment.agent]++;
        // M-06 fix: Only decrement completion count for severe slashes.
        // Late/Minor slashes are financial penalties — the agent still completed the work.
        if (_severity == SlashSeverity.Material ||
            _severity == SlashSeverity.Execution ||
            _severity == SlashSeverity.Critical) {
            if (agentTasksCompleted[assignment.agent] > 0) {
                agentTasksCompleted[assignment.agent]--;
            }
        }
        if (isBan) agentBanned[assignment.agent] = true;
        if (cooldownEnd > 0) agentSlashCooldownEnd[assignment.agent] = cooldownEnd;
        if (toProtocol > 0) protocolTreasury[task.token] += toProtocol;

        if (toPoster > 0) {
            IERC20(task.token).safeTransfer(task.poster, toPoster);
        }
        if (agentReturn > 0) {
            IERC20(task.token).safeTransfer(assignment.agent, agentReturn);
        }

        if (cooldownEnd > 0) {
            emit AgentSlashCooldownApplied(assignment.agent, cooldownEnd);
        }
        emit AgentSlashed(_taskId, assignment.agent, slashAmount, _severity);
        emit SlashBondForfeited(_taskId, assignment.agent, slashAmount, _severity);
    }

    /// @notice Allows the agent to claim their slash bond after the slash window has expired
    /// @param _taskId ID of the task whose slash bond to claim
    function claimSlashBond(uint256 _taskId) external nonReentrant {
        Task storage task = _tasks[_taskId];
        Assignment storage assignment = _assignments[_taskId];

        if (task.status != TaskStatus.Completed) revert A59();
        if (msg.sender != assignment.agent) revert A60();
        if (block.timestamp <= assignment.deliveredAt + task.slashWindow) revert A61();

        uint256 bond = slashBonds[_taskId];
        if (bond == 0) revert A62();

        slashBonds[_taskId] = 0;
        IERC20(task.token).safeTransfer(assignment.agent, bond);

        emit SlashBondClaimed(_taskId, assignment.agent, bond);
    }

    // ═══════════════════════════════════════════════════
    // SATELLITE CALLBACKS
    // ═══════════════════════════════════════════════════

    /// @notice Arbitration callback to update a task's status
    /// @param _taskId ID of the task to update
    /// @param _status The new task status to set
    function setTaskStatusFromArbitration(uint256 _taskId, TaskStatus _status) external {
        if (msg.sender != arenaArbitration) revert A53();
        _tasks[_taskId].status = _status;
    }

    /// @notice Arbitration callback to adjust an agent's reputation score
    /// @param _agent Address of the agent whose reputation to adjust
    /// @param _delta Signed reputation change (positive to increase, negative to decrease)
    function adjustReputationFromSatellite(address _agent, int256 _delta) external {
        if (msg.sender != arenaArbitration) revert A54();
        if (_delta > 0) {
            agentReputation[_agent] += uint256(_delta);
        } else {
            uint256 decrease = uint256(-_delta);
            if (agentReputation[_agent] >= decrease) {
                agentReputation[_agent] -= decrease;
            } else {
                agentReputation[_agent] = 0;
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // AUTHORIZED SETTERS (onlyAuction)
    // ═══════════════════════════════════════════════════

    /// @notice Sets the status of a task (callable by Auction only)
    /// @param _taskId ID of the task to update
    /// @param _status The new task status
    function setTaskStatus(uint256 _taskId, TaskStatus _status) external onlyAuction {
        _tasks[_taskId].status = _status;
    }

    /// @notice Creates an assignment for a task (callable by Auction only)
    /// @param _taskId ID of the task to assign
    /// @param _agent Address of the agent being assigned
    /// @param _stake The agent's staked amount
    /// @param _price The agreed price for the task
    function setAssignment(uint256 _taskId, address _agent, uint256 _stake, uint256 _price) external onlyAuction {
        _assignments[_taskId] = Assignment({
            agent: _agent,
            stake: _stake,
            price: _price,
            assignedAt: block.timestamp,
            deliveredAt: 0,
            outputHash: bytes32(0)
        });
    }

    /// @notice Sets delivery data on an assignment (callable by Auction only)
    /// @param _taskId ID of the task being delivered
    /// @param _deliveredAt Timestamp of the delivery
    /// @param _outputHash Hash of the delivered output
    function setAssignmentDelivery(uint256 _taskId, uint256 _deliveredAt, bytes32 _outputHash) external onlyAuction {
        _assignments[_taskId].deliveredAt = _deliveredAt;
        _assignments[_taskId].outputHash = _outputHash;
    }

    /// @notice Increases an agent's reputation score (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to add to the agent's reputation
    function incrementAgentReputation(address _agent, uint256 _amount) external onlyAuction {
        agentReputation[_agent] += _amount;
    }

    /// @notice Decreases an agent's reputation score, flooring at zero (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to subtract from the agent's reputation
    function decrementAgentReputation(address _agent, uint256 _amount) external onlyAuction {
        if (agentReputation[_agent] >= _amount) {
            agentReputation[_agent] -= _amount;
        } else {
            agentReputation[_agent] = 0;
        }
    }

    /// @notice Increments the agent's completed task counter (callable by Auction only)
    /// @param _agent Address of the agent
    function incrementAgentCompleted(address _agent) external onlyAuction {
        agentTasksCompleted[_agent]++;
    }

    /// @notice Increments the agent's failed task counter (callable by Auction only)
    /// @param _agent Address of the agent
    function incrementAgentFailed(address _agent) external onlyAuction {
        agentTasksFailed[_agent]++;
    }

    /// @notice Decrements the agent's completed task counter (callable by Auction only)
    /// @param _agent Address of the agent
    function decrementAgentCompleted(address _agent) external onlyAuction {
        agentTasksCompleted[_agent]--;
    }

    /// @notice Sets the banned status of an agent (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _banned Whether the agent should be banned
    function setAgentBanned(address _agent, bool _banned) external onlyAuction {
        agentBanned[_agent] = _banned;
    }

    /// @notice Adds to an agent's active stake total (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to add to the agent's active stake
    function addAgentActiveStake(address _agent, uint256 _amount) external onlyAuction {
        agentActiveStake[_agent] += _amount;
    }

    /// @notice Subtracts from an agent's active stake total (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to subtract from the agent's active stake
    function subAgentActiveStake(address _agent, uint256 _amount) external onlyAuction {
        agentActiveStake[_agent] -= _amount;
    }

    /// @notice Adds to an agent's active bid count (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to add to the agent's active bids
    function addAgentActiveBids(address _agent, uint256 _amount) external onlyAuction {
        agentActiveBids[_agent] += _amount;
    }

    /// @notice Subtracts from an agent's active bid count (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _amount Amount to subtract from the agent's active bids
    function subAgentActiveBids(address _agent, uint256 _amount) external onlyAuction {
        agentActiveBids[_agent] -= _amount;
    }

    /// @notice Sets the slash cooldown end timestamp for an agent (callable by Auction only)
    /// @param _agent Address of the agent
    /// @param _timestamp The cooldown expiry timestamp
    function setAgentSlashCooldownEnd(address _agent, uint256 _timestamp) external onlyAuction {
        agentSlashCooldownEnd[_agent] = _timestamp;
    }

    /// @notice Adds to the protocol treasury balance for a token (callable by Auction only)
    /// @param _token Address of the token
    /// @param _amount Amount to add to the treasury
    function addProtocolTreasury(address _token, uint256 _amount) external onlyAuction {
        protocolTreasury[_token] += _amount;
    }

    /// @notice Sets the slash bond amount for a task (callable by Auction only)
    /// @param _taskId ID of the task
    /// @param _amount The slash bond amount
    function setSlashBond(uint256 _taskId, uint256 _amount) external onlyAuction {
        slashBonds[_taskId] = _amount;
    }

    /// @notice Sets the slash amount recorded for a task (callable by Auction only)
    /// @param _taskId ID of the task
    /// @param _amount The slash amount
    function setTaskSlashAmount(uint256 _taskId, uint256 _amount) external onlyAuction {
        taskSlashAmount[_taskId] = _amount;
    }

    /// @notice Sets the bond slash amount recorded for a task (callable by Auction only)
    /// @param _taskId ID of the task
    /// @param _amount The bond slash amount
    function setTaskBondSlashAmount(uint256 _taskId, uint256 _amount) external onlyAuction {
        taskBondSlashAmount[_taskId] = _amount;
    }

    /// @notice Decrements a poster's active task count (callable by Auction only)
    /// @param _poster Address of the poster
    function decrementPosterActiveTasks(address _poster) external onlyAuction {
        posterActiveTasks[_poster]--;
    }

    /// @notice Transfers tokens from Main escrow to a recipient (callable by Auction only)
    /// @param _token Address of the token to transfer
    /// @param _to Recipient address
    /// @param _amount Amount of tokens to transfer
    function transferFromEscrow(address _token, address _to, uint256 _amount) external onlyAuction {
        IERC20(_token).safeTransfer(_to, _amount);
    }

    /// @notice Batch state update for task settlement to save gas (callable by Auction only)
    /// @param _taskId ID of the task being settled
    /// @param _status The new task status
    /// @param _poster Address of the poster (pass address(0) to skip active task decrement)
    /// @param _agent Address of the assigned agent
    /// @param _stakeToSub Amount to subtract from agent's active stake
    /// @param _reputationDelta Absolute reputation change amount
    /// @param _reputationUp True to increase reputation, false to decrease
    /// @param _incrementCompleted Whether to increment the agent's completed counter
    /// @param _incrementFailed Whether to increment the agent's failed counter
    /// @param _banned Whether to ban the agent
    /// @param _cooldownEnd Slash cooldown end timestamp (0 to skip)
    /// @param _token Address of the payment token
    /// @param _protocolFeeAmount Amount to add to protocol treasury
    /// @param _slashBondAmount Amount to set as the task's slash bond
    function batchSettleState(
        uint256 _taskId, TaskStatus _status, address _poster, address _agent,
        uint256 _stakeToSub, uint256 _reputationDelta, bool _reputationUp,
        bool _incrementCompleted, bool _incrementFailed, bool _banned, uint256 _cooldownEnd,
        address _token, uint256 _protocolFeeAmount, uint256 _slashBondAmount
    ) external onlyAuction {
        _tasks[_taskId].status = _status;
        if (_poster != address(0)) posterActiveTasks[_poster]--;
        if (_stakeToSub > 0) agentActiveStake[_agent] -= _stakeToSub;
        if (_reputationUp) {
            agentReputation[_agent] += _reputationDelta;
        } else if (_reputationDelta > 0) {
            if (agentReputation[_agent] >= _reputationDelta) {
                agentReputation[_agent] -= _reputationDelta;
            } else {
                agentReputation[_agent] = 0;
            }
        }
        if (_incrementCompleted) agentTasksCompleted[_agent]++;
        if (_incrementFailed) agentTasksFailed[_agent]++;
        if (_banned) agentBanned[_agent] = true;
        if (_cooldownEnd > 0) agentSlashCooldownEnd[_agent] = _cooldownEnd;
        if (_protocolFeeAmount > 0) protocolTreasury[_token] += _protocolFeeAmount;
        if (_slashBondAmount > 0) slashBonds[_taskId] = _slashBondAmount;
    }

    // ═══════════════════════════════════════════════════
    // PROTOCOL ADMIN
    // ═══════════════════════════════════════════════════

    /// @notice Sets the ArenaCoreAuction satellite address
    /// @param _auction Address of the ArenaCoreAuction contract
    function setArenaCoreAuction(address _auction) external onlyOwner {
        arenaCoreAuction = _auction;
    }

    /// @notice Sets the ArenaCoreVRF satellite address
    /// @param _vrf Address of the ArenaCoreVRF contract
    function setArenaCoreVRF(address _vrf) external onlyOwner {
        arenaCoreVRF = _vrf;
    }

    /// @notice Sets the ArenaArbitration satellite address
    /// @param _a Address of the ArenaArbitration contract
    function setArenaArbitration(address _a) external onlyOwner { arenaArbitration = _a; }

    /// @notice Sets the ArenaOutcomes satellite address
    /// @param _a Address of the ArenaOutcomes contract
    function setArenaOutcomes(address _a) external onlyOwner { arenaOutcomes = _a; }

    /// @notice Sets the ArenaCompliance satellite address
    /// @param _a Address of the ArenaCompliance contract
    function setArenaCompliance(address _a) external onlyOwner { arenaCompliance = _a; }

    /// @notice Sets the protocol treasury recipient address
    /// @param _t Address of the treasury
    function setTreasuryAddress(address _t) external onlyOwner { treasuryAddress = _t; }

    /// @notice Withdraws accumulated protocol fees for a token to the treasury or a specified address
    /// @param _token Address of the token to withdraw
    /// @param _to Fallback recipient if no treasury address is set
    function withdrawProtocolFees(address _token, address _to) external onlyOwner nonReentrant {
        uint256 amount = protocolTreasury[_token];
        if (amount == 0) revert A66();
        protocolTreasury[_token] = 0;
        address d = treasuryAddress != address(0) ? treasuryAddress : _to;
        IERC20(_token).safeTransfer(d, amount);
    }

    /// @notice Emergency token recovery available only after extended pause threshold
    /// @param _token Address of the token to recover
    /// @param _to Recipient address
    /// @param _amount Amount of tokens to transfer
    function emergencySweep(address _token, address _to, uint256 _amount) external onlyOwner onlyEmergency nonReentrant {
        IERC20(_token).safeTransfer(_to, _amount);
    }

    /// @notice Pauses the protocol, preventing new task creation
    function pause() external onlyOwner {
        pausedAt = block.timestamp;
        _pause();
    }

    /// @notice Unpauses the protocol and resets the pause timer
    function unpause() external onlyOwner {
        pausedAt = 0;
        _unpause();
    }

    /// @notice Unbans a previously banned agent
    /// @param _agent Address of the agent to unban
    function unbanAgent(address _agent) external onlyOwner {
        agentBanned[_agent] = false;
    }

    /// @notice Sets the minimum bounty amount required for task creation
    /// @param _min New minimum bounty amount
    function setMinBounty(uint256 _min) external onlyOwner { minBounty = _min; }

    /// @notice Sets the maximum number of active tasks a poster can have
    /// @param _max New maximum active task count per poster
    function setMaxPosterActiveTasks(uint256 _max) external onlyOwner { maxPosterActiveTasks = _max; }

    /// @notice Toggles whether task type approval is required for task creation
    /// @param _require True to require approval, false to allow all task types
    function setRequireTaskTypeApproval(bool _require) external onlyOwner { requireTaskTypeApproval = _require; }

    /// @notice Approves a task type for use in task creation
    /// @param _t The task type string to approve
    function addApprovedTaskType(string calldata _t) external onlyOwner { approvedTaskTypes[keccak256(bytes(_t))] = true; }

    /// @notice Removes approval for a task type
    /// @param _t The task type string to remove
    function removeApprovedTaskType(string calldata _t) external onlyOwner { approvedTaskTypes[keccak256(bytes(_t))] = false; }

    /// @notice Sets the schema hash for a given task type
    /// @param _taskType The task type string
    /// @param _schemaHash The schema hash to associate with the task type
    function setSchemaHash(string calldata _taskType, bytes32 _schemaHash) external onlyOwner {
        taskTypeSchemaHash[keccak256(bytes(_taskType))] = _schemaHash;
    }

    // ═══════════════════════════════════════════════════
    // TOKEN WHITELIST
    // ═══════════════════════════════════════════════════

    /// @notice Whitelists a payment token for use in task bounties
    /// @param _token Address of the token to whitelist
    /// @param _isStablecoin True if the token is a stablecoin (no MEV risk)
    /// @param _mevAck Acknowledgement of MEV risk for non-stablecoin tokens
    function whitelistToken(address _token, bool _isStablecoin, bool _mevAck) external onlyOwner {
        if (!_isStablecoin && !_mevAck) revert A80();
        tokenWhitelist[_token] = true;
        tokenHasMevRisk[_token] = !_isStablecoin;
        emit TokenWhitelisted(_token, !_isStablecoin);
    }

    /// @notice Removes a token from the whitelist (cannot remove the default token)
    /// @param _token Address of the token to remove
    function removeToken(address _token) external onlyOwner {
        if (_token == address(defaultToken)) revert A67();
        tokenWhitelist[_token] = false;
        delete tokenHasMevRisk[_token];
        emit TokenRemoved(_token);
    }

    // ═══════════════════════════════════════════════════
    // EMERGENCY WITHDRAWAL
    // ═══════════════════════════════════════════════════

    /// @notice Emergency bounty withdrawal by the poster after extended pause threshold
    /// @param _taskId ID of the task whose bounty to withdraw
    function emergencyWithdrawBounty(uint256 _taskId) external onlyEmergency nonReentrant {
        Task storage task = _tasks[_taskId];
        if (msg.sender != task.poster) revert A69();
        if (uint8(task.status) >= uint8(TaskStatus.Completed)) revert A70();
        uint256 a = task.bounty;
        if (a == 0) revert A71();
        task.bounty = 0;
        task.status = TaskStatus.Cancelled;
        posterActiveTasks[task.poster]--;
        IERC20(task.token).safeTransfer(msg.sender, a);
        emit EmergencyWithdrawn(_taskId, msg.sender, a);
    }

    /// @notice Emergency stake withdrawal by the agent after extended pause threshold
    /// @param _taskId ID of the task whose stake to withdraw
    function emergencyWithdrawStake(uint256 _taskId) external onlyEmergency nonReentrant {
        Task storage task = _tasks[_taskId];
        Assignment storage ag = _assignments[_taskId];
        if (msg.sender != ag.agent) revert A69();
        uint8 s = uint8(task.status);
        if (s < uint8(TaskStatus.Assigned) || s >= uint8(TaskStatus.Completed)) revert A70();
        uint256 a = ag.stake;
        if (a == 0) revert A71();
        ag.stake = 0;
        agentActiveStake[msg.sender] -= a;
        // Stake tokens are held on Auction — pull them first
        IArenaCoreAuction(arenaCoreAuction).transferToMain(task.token, a);
        IERC20(task.token).safeTransfer(msg.sender, a);
        emit EmergencyWithdrawn(_taskId, msg.sender, a);
    }
}

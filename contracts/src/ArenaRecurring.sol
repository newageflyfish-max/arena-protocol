// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title IArenaCore
 * @notice Minimal interface for creating tasks and reading state from ArenaCore.
 */
interface IArenaCore {
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
    ) external returns (uint256 taskId);

    function getTask(uint256 _taskId) external view returns (
        address poster,
        address token,
        uint256 bounty,
        uint256 deadline,
        uint256 slashWindow,
        uint256 createdAt,
        uint256 bidDeadline,
        uint256 revealDeadline,
        uint8 requiredVerifiers,
        uint8 status,
        bytes32 criteriaHash,
        string memory taskType
    );

    function getAssignment(uint256 _taskId) external view returns (
        address agent,
        uint256 stake,
        uint256 price,
        uint256 assignedAt,
        uint256 deliveredAt,
        bytes32 outputHash
    );

    function agentReputation(address) external view returns (uint256);
    function agentBanned(address) external view returns (bool);
    function defaultToken() external view returns (address);
    function tokenWhitelist(address) external view returns (bool);
}

/**
 * @title ArenaRecurring
 * @notice Satellite contract for recurring (scheduled) tasks.
 * @dev A poster creates a recurring task template with a frequency and max occurrences.
 *      Anyone can call `triggerRecurringTask()` after each interval to spawn a new
 *      spot task on ArenaCore. The caller earns a 0.5% keeper fee from the bounty.
 *      The agent who completed the previous occurrence gets a 24-hour exclusive
 *      bid window before the task opens to all agents.
 *
 *      The poster pre-funds the full bounty upfront (bountyPerOccurrence * maxOccurrences)
 *      to guarantee payment. Pausing or cancelling refunds remaining escrowed funds.
 */
contract ArenaRecurring is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // CORE REFERENCE
    // ═══════════════════════════════════════════════════

    IArenaCore public immutable core;

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════

    enum Frequency {
        Daily,      // 1 day  = 86400
        Weekly,     // 7 days = 604800
        Biweekly,   // 14 days = 1209600
        Monthly     // 30 days = 2592000
    }

    enum TemplateStatus {
        Active,
        Paused,
        Cancelled,
        Completed   // All occurrences triggered
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct RecurringTemplate {
        address poster;
        address token;
        uint256 bountyPerOccurrence;     // USDC per task (before keeper fee)
        uint256 totalEscrowed;           // Remaining funds in escrow
        uint256 deadlineOffset;          // Seconds after trigger for task deadline
        uint256 slashWindow;
        uint256 bidDuration;
        uint256 revealDuration;
        uint8 requiredVerifiers;
        bytes32 criteriaHash;
        string taskType;
        Frequency frequency;
        uint16 maxOccurrences;
        uint16 triggeredCount;
        uint256 createdAt;
        uint256 lastTriggeredAt;
        TemplateStatus status;
        address lastCompletedAgent;      // Gets exclusive bid window on next occurrence
    }

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════

    uint256 public constant KEEPER_FEE_BPS = 50;          // 0.5%
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant EXCLUSIVE_BID_WINDOW = 24 hours;
    uint256 public constant MAX_OCCURRENCES = 365;         // Max 1 year of daily tasks

    uint256 internal constant DAILY_INTERVAL = 1 days;
    uint256 internal constant WEEKLY_INTERVAL = 7 days;
    uint256 internal constant BIWEEKLY_INTERVAL = 14 days;
    uint256 internal constant MONTHLY_INTERVAL = 30 days;

    // ═══════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════

    uint256 public templateCount;
    mapping(uint256 => RecurringTemplate) public templates;

    /// @notice Maps templateId => occurrence index => ArenaCore taskId
    mapping(uint256 => mapping(uint16 => uint256)) public occurrenceTaskIds;

    /// @notice Maps ArenaCore taskId => templateId (for tracking completions)
    mapping(uint256 => uint256) public taskToTemplate;

    /// @notice Maps ArenaCore taskId => whether it is a recurring occurrence
    mapping(uint256 => bool) public isRecurringTask;

    /// @notice Anti-griefing: max active templates per poster
    uint256 public maxActiveTemplates = 20;
    mapping(address => uint256) public posterActiveTemplates;

    /// @notice Minimum bounty per occurrence
    uint256 public minBountyPerOccurrence = 10e6; // 10 USDC

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event RecurringTemplateCreated(
        uint256 indexed templateId,
        address indexed poster,
        string taskType,
        uint256 bountyPerOccurrence,
        uint8 frequency,
        uint16 maxOccurrences
    );

    event RecurringTaskTriggered(
        uint256 indexed templateId,
        uint256 indexed coreTaskId,
        uint16 occurrence,
        address indexed keeper,
        uint256 keeperFee
    );

    event RecurringTemplatePaused(uint256 indexed templateId);
    event RecurringTemplateResumed(uint256 indexed templateId);
    event RecurringTemplateCancelled(uint256 indexed templateId, uint256 refundAmount);
    event RecurringTemplateCompleted(uint256 indexed templateId);
    event LastAgentUpdated(uint256 indexed templateId, address indexed agent);

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroBounty();
    error BountyTooLow();
    error InvalidOccurrences();
    error TooManyActiveTemplates();
    error InvalidFrequency();
    error InvalidDeadlineOffset();
    error InvalidVerifiers();
    error InvalidBidDuration();
    error InvalidRevealDuration();
    error TemplateNotActive();
    error TemplatePaused();
    error IntervalNotElapsed();
    error AllOccurrencesTriggered();
    error NotTemplatePoster();
    error TemplateNotPaused();
    error TokenNotWhitelisted();
    error InsufficientEscrow();

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        if (_core == address(0)) revert ZeroAddress();
        core = IArenaCore(_core);
    }

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier onlyPoster(uint256 _templateId) {
        if (templates[_templateId].poster != msg.sender) revert NotTemplatePoster();
        _;
    }

    // ═══════════════════════════════════════════════════
    // POSTER FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Create a recurring task template and escrow all funds upfront.
     * @param _bountyPerOccurrence USDC per task occurrence
     * @param _frequency Daily(0), Weekly(1), Biweekly(2), Monthly(3)
     * @param _maxOccurrences Total number of times the task should repeat
     * @param _deadlineOffset Seconds from trigger time for task deadline
     * @param _slashWindow Slash window in seconds
     * @param _bidDuration Bid period in seconds
     * @param _revealDuration Reveal period in seconds
     * @param _requiredVerifiers Number of verifiers (1-5)
     * @param _criteriaHash Hash of acceptance criteria
     * @param _taskType Task category string
     * @param _token ERC20 token (address(0) for default)
     */
    function createRecurringTask(
        uint256 _bountyPerOccurrence,
        uint8 _frequency,
        uint16 _maxOccurrences,
        uint256 _deadlineOffset,
        uint256 _slashWindow,
        uint256 _bidDuration,
        uint256 _revealDuration,
        uint8 _requiredVerifiers,
        bytes32 _criteriaHash,
        string calldata _taskType,
        address _token
    ) external whenNotPaused nonReentrant returns (uint256 templateId) {
        if (_bountyPerOccurrence == 0) revert ZeroBounty();
        if (_bountyPerOccurrence < minBountyPerOccurrence) revert BountyTooLow();
        if (_maxOccurrences == 0 || _maxOccurrences > MAX_OCCURRENCES) revert InvalidOccurrences();
        if (_frequency > uint8(Frequency.Monthly)) revert InvalidFrequency();
        if (_deadlineOffset < 1 hours) revert InvalidDeadlineOffset();
        // M-05 fix: deadline must be after auction concludes
        if (_deadlineOffset <= _bidDuration + _revealDuration) revert InvalidDeadlineOffset();
        if (_requiredVerifiers == 0 || _requiredVerifiers > 5) revert InvalidVerifiers();
        if (_bidDuration == 0) revert InvalidBidDuration();
        if (_revealDuration == 0) revert InvalidRevealDuration();
        if (posterActiveTemplates[msg.sender] >= maxActiveTemplates) revert TooManyActiveTemplates();

        address token = _token == address(0) ? core.defaultToken() : _token;
        if (!core.tokenWhitelist(token)) revert TokenNotWhitelisted();

        // Calculate and escrow total funds
        uint256 totalRequired = _bountyPerOccurrence * uint256(_maxOccurrences);
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalRequired);

        templateId = templateCount++;
        posterActiveTemplates[msg.sender]++;

        templates[templateId] = RecurringTemplate({
            poster: msg.sender,
            token: token,
            bountyPerOccurrence: _bountyPerOccurrence,
            totalEscrowed: totalRequired,
            deadlineOffset: _deadlineOffset,
            slashWindow: _slashWindow,
            bidDuration: _bidDuration,
            revealDuration: _revealDuration,
            requiredVerifiers: _requiredVerifiers,
            criteriaHash: _criteriaHash,
            taskType: _taskType,
            frequency: Frequency(_frequency),
            maxOccurrences: _maxOccurrences,
            triggeredCount: 0,
            createdAt: block.timestamp,
            lastTriggeredAt: 0,
            status: TemplateStatus.Active,
            lastCompletedAgent: address(0)
        });

        emit RecurringTemplateCreated(
            templateId,
            msg.sender,
            _taskType,
            _bountyPerOccurrence,
            _frequency,
            _maxOccurrences
        );
    }

    /**
     * @notice Pause a recurring template. No new occurrences will be triggered.
     */
    function pauseTemplate(uint256 _templateId)
        external
        onlyPoster(_templateId)
    {
        RecurringTemplate storage t = templates[_templateId];
        if (t.status != TemplateStatus.Active) revert TemplateNotActive();
        t.status = TemplateStatus.Paused;
        emit RecurringTemplatePaused(_templateId);
    }

    /**
     * @notice Resume a paused template.
     */
    function resumeTemplate(uint256 _templateId)
        external
        onlyPoster(_templateId)
    {
        RecurringTemplate storage t = templates[_templateId];
        if (t.status != TemplateStatus.Paused) revert TemplateNotPaused();
        t.status = TemplateStatus.Active;
        emit RecurringTemplateResumed(_templateId);
    }

    /**
     * @notice Cancel a recurring template and refund remaining escrowed funds.
     */
    function cancelTemplate(uint256 _templateId)
        external
        onlyPoster(_templateId)
        nonReentrant
    {
        RecurringTemplate storage t = templates[_templateId];
        if (t.status == TemplateStatus.Cancelled || t.status == TemplateStatus.Completed) {
            revert TemplateNotActive();
        }

        t.status = TemplateStatus.Cancelled;
        posterActiveTemplates[t.poster]--;

        uint256 refund = t.totalEscrowed;
        if (refund > 0) {
            t.totalEscrowed = 0;
            IERC20(t.token).safeTransfer(t.poster, refund);
        }

        emit RecurringTemplateCancelled(_templateId, refund);
    }

    // ═══════════════════════════════════════════════════
    // TRIGGER (KEEPER) FUNCTION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Trigger the next occurrence of a recurring task.
     *         Callable by anyone once the interval has passed.
     *         Caller receives a 0.5% keeper fee from the bounty.
     * @param _templateId The recurring template to trigger
     * @return coreTaskId The new task ID on ArenaCore
     */
    function triggerRecurringTask(uint256 _templateId)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 coreTaskId)
    {
        RecurringTemplate storage t = templates[_templateId];

        if (t.status != TemplateStatus.Active) revert TemplateNotActive();
        if (t.triggeredCount >= t.maxOccurrences) revert AllOccurrencesTriggered();

        // Check interval
        uint256 interval = _getInterval(t.frequency);
        if (t.lastTriggeredAt != 0) {
            if (block.timestamp < t.lastTriggeredAt + interval) revert IntervalNotElapsed();
        }

        // Calculate keeper fee and net bounty
        uint256 keeperFee = (t.bountyPerOccurrence * KEEPER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netBounty = t.bountyPerOccurrence - keeperFee;

        if (t.totalEscrowed < t.bountyPerOccurrence) revert InsufficientEscrow();
        t.totalEscrowed -= t.bountyPerOccurrence;

        // Pay keeper fee
        if (keeperFee > 0) {
            IERC20(t.token).safeTransfer(msg.sender, keeperFee);
        }

        // Approve ArenaCore to pull the net bounty
        IERC20(t.token).forceApprove(address(core), netBounty);

        // Create task on ArenaCore
        uint256 deadline = block.timestamp + t.deadlineOffset;
        coreTaskId = core.createTask(
            netBounty,
            deadline,
            t.slashWindow,
            t.bidDuration,
            t.revealDuration,
            t.requiredVerifiers,
            t.criteriaHash,
            t.taskType,
            t.token
        );

        // Track occurrence
        uint16 occurrence = t.triggeredCount;
        t.triggeredCount++;
        t.lastTriggeredAt = block.timestamp;
        occurrenceTaskIds[_templateId][occurrence] = coreTaskId;
        taskToTemplate[coreTaskId] = _templateId;
        isRecurringTask[coreTaskId] = true;

        // Check if all occurrences are now triggered
        if (t.triggeredCount >= t.maxOccurrences) {
            t.status = TemplateStatus.Completed;
            posterActiveTemplates[t.poster]--;
            emit RecurringTemplateCompleted(_templateId);
        }

        emit RecurringTaskTriggered(
            _templateId,
            coreTaskId,
            occurrence,
            msg.sender,
            keeperFee
        );
    }

    // ═══════════════════════════════════════════════════
    // AGENT TRACKING
    // ═══════════════════════════════════════════════════

    /**
     * @notice Update the last completed agent for a template.
     *         Called externally after a task completes on ArenaCore.
     *         This agent gets an exclusive 24h bid window on the next occurrence.
     * @param _coreTaskId The ArenaCore task ID that was completed
     */
    function recordCompletion(uint256 _coreTaskId) external {
        if (!isRecurringTask[_coreTaskId]) return;

        uint256 templateId = taskToTemplate[_coreTaskId];
        RecurringTemplate storage t = templates[templateId];

        // Read the completing agent from ArenaCore
        (address agent,,,,, ) = core.getAssignment(_coreTaskId);
        if (agent == address(0)) return;

        // Read task status (5 = Completed)
        (,,,,,,,,, uint8 status,,) = core.getTask(_coreTaskId);
        if (status != 5) return;

        t.lastCompletedAgent = agent;
        emit LastAgentUpdated(templateId, agent);
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Check if a recurring task is ready to be triggered.
     */
    function canTrigger(uint256 _templateId) external view returns (bool) {
        RecurringTemplate storage t = templates[_templateId];
        if (t.status != TemplateStatus.Active) return false;
        if (t.triggeredCount >= t.maxOccurrences) return false;
        if (t.totalEscrowed < t.bountyPerOccurrence) return false;

        uint256 interval = _getInterval(t.frequency);
        if (t.lastTriggeredAt == 0) return true;
        return block.timestamp >= t.lastTriggeredAt + interval;
    }

    /**
     * @notice Get seconds until the next occurrence can be triggered.
     */
    function timeUntilNextTrigger(uint256 _templateId) external view returns (uint256) {
        RecurringTemplate storage t = templates[_templateId];
        if (t.status != TemplateStatus.Active) return type(uint256).max;
        if (t.triggeredCount >= t.maxOccurrences) return type(uint256).max;
        if (t.lastTriggeredAt == 0) return 0;

        uint256 interval = _getInterval(t.frequency);
        uint256 nextTrigger = t.lastTriggeredAt + interval;
        if (block.timestamp >= nextTrigger) return 0;
        return nextTrigger - block.timestamp;
    }

    /**
     * @notice Get the exclusive bid agent and whether the exclusive window is still active.
     */
    function getExclusiveBidInfo(uint256 _templateId)
        external
        view
        returns (address agent, bool windowActive)
    {
        RecurringTemplate storage t = templates[_templateId];
        agent = t.lastCompletedAgent;
        if (agent == address(0)) return (address(0), false);

        // Window is active if the last trigger was less than EXCLUSIVE_BID_WINDOW ago
        if (t.lastTriggeredAt == 0) return (agent, false);
        windowActive = block.timestamp < t.lastTriggeredAt + EXCLUSIVE_BID_WINDOW;
    }

    /**
     * @notice Get full template data.
     */
    function getTemplate(uint256 _templateId)
        external
        view
        returns (RecurringTemplate memory)
    {
        return templates[_templateId];
    }

    /**
     * @notice Get the remaining occurrences for a template.
     */
    function remainingOccurrences(uint256 _templateId)
        external
        view
        returns (uint16)
    {
        RecurringTemplate storage t = templates[_templateId];
        return t.maxOccurrences - t.triggeredCount;
    }

    /**
     * @notice Get the interval in seconds for a frequency.
     */
    function getIntervalSeconds(Frequency _freq) external pure returns (uint256) {
        return _getInterval(_freq);
    }

    // ═══════════════════════════════════════════════════
    // OWNER FUNCTIONS
    // ═══════════════════════════════════════════════════

    function setMaxActiveTemplates(uint256 _max) external onlyOwner {
        maxActiveTemplates = _max;
    }

    function setMinBountyPerOccurrence(uint256 _min) external onlyOwner {
        minBountyPerOccurrence = _min;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════

    function _getInterval(Frequency _freq) internal pure returns (uint256) {
        if (_freq == Frequency.Daily) return DAILY_INTERVAL;
        if (_freq == Frequency.Weekly) return WEEKLY_INTERVAL;
        if (_freq == Frequency.Biweekly) return BIWEEKLY_INTERVAL;
        return MONTHLY_INTERVAL;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IArenaCore
 * @notice Minimal interface for ArenaCore callbacks
 */
interface IArenaCoreOutcomes {
    enum TaskStatus { Open, BidReveal, Assigned, Delivered, Verifying, Completed, Failed, Disputed, Cancelled }
    enum SlashSeverity { Late, Minor, Material, Execution, Critical }

    struct Task {
        address poster;
        address token;
        uint256 bounty;
        uint256 deadline;
        uint256 slashWindow;
        uint256 createdAt;
        uint256 bidDeadline;
        uint256 revealDeadline;
        uint8 requiredVerifiers;
        TaskStatus status;
        bytes32 criteriaHash;
        string taskType;
    }

    struct Assignment {
        address agent;
        uint256 stake;
        uint256 price;
        uint256 assignedAt;
        uint256 deliveredAt;
        bytes32 outputHash;
    }

    function getTask(uint256 _taskId) external view returns (Task memory);
    function getAssignment(uint256 _taskId) external view returns (Assignment memory);
    function postCompletionSlash(uint256 _taskId, SlashSeverity _severity) external;
    function defaultToken() external view returns (IERC20);
}

/**
 * @title ArenaOutcomes
 * @notice Satellite contract for outcome-based slash triggers with reporter bond protection.
 *
 * @dev Oracle Trust Model:
 *      Reports do NOT execute immediately. The reporter must stake a bond (REPORT_BOND_BPS
 *      of the agent's stake). The report enters a challenge period (CHALLENGE_PERIOD).
 *      During this window the agent can challenge, forfeiting the reporter's bond to the
 *      agent as compensation for a false accusation. After the challenge period, anyone
 *      can call finalizeReport to execute the slash and return the reporter's bond.
 *
 *      This creates economic accountability:
 *      - False reporters lose their bond to the agent
 *      - Honest reporters get their bond back after the challenge period
 *      - Agents have a guaranteed window to dispute before slashing occurs
 */
contract ArenaOutcomes is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════

    uint256 public constant REPORT_BOND_BPS = 1000;   // 10% of agent stake as reporter bond
    uint256 public constant CHALLENGE_PERIOD = 48 hours;

    // ═══════════════════════════════════════════════════
    // CORE REFERENCE
    // ═══════════════════════════════════════════════════

    IArenaCoreOutcomes public immutable core;

    // ═══════════════════════════════════════════════════
    // OUTCOME CRITERIA
    // ═══════════════════════════════════════════════════

    struct RiskCriteria {
        uint16 lossThresholdBps;
        uint16 slashScoreThreshold;
        uint256 validationWindow;
        bool registered;
    }

    struct CreditCriteria {
        uint16 defaultProbThreshold;
        uint256 defaultWindow;
        bool registered;
    }

    // ═══════════════════════════════════════════════════
    // REPORTER BOND SYSTEM
    // ═══════════════════════════════════════════════════

    enum ReportStatus { None, Pending, Finalized, Challenged }

    struct OutcomeReport {
        address reporter;
        uint256 bond;
        uint256 reportedAt;
        IArenaCoreOutcomes.SlashSeverity severity;
        ReportStatus status;
    }

    mapping(uint256 => RiskCriteria) public riskCriteria;
    mapping(uint256 => CreditCriteria) public creditCriteria;
    mapping(uint256 => OutcomeReport) public reports;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event RiskCriteriaRegistered(uint256 indexed taskId, uint16 lossThresholdBps, uint16 slashScoreThreshold, uint256 validationWindow);
    event CreditCriteriaRegistered(uint256 indexed taskId, uint16 defaultProbThreshold, uint256 defaultWindow);
    event OutcomeReported(uint256 indexed taskId, address indexed reporter, uint256 bond, IArenaCoreOutcomes.SlashSeverity severity);
    event OutcomeFinalized(uint256 indexed taskId, address indexed reporter);
    event OutcomeChallenged(uint256 indexed taskId, address indexed agent, uint256 bondForfeited);

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════

    error NotTaskPoster();
    error NotAssignedAgent();
    error TaskNotCompleted();
    error CriteriaAlreadyRegistered();
    error CriteriaNotRegistered();
    error ReportAlreadyExists();
    error NoActiveReport();
    error ChallengePeriodActive();
    error ChallengePeriodExpired();
    error OutsideWindow();
    error ThresholdNotBreached();
    error InvalidParams();
    error BondTooLow();

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        core = IArenaCoreOutcomes(_core);
    }

    // ═══════════════════════════════════════════════════
    // CRITERIA REGISTRATION (poster sets before completion)
    // ═══════════════════════════════════════════════════

    /// @notice Register risk-validation outcome criteria for a task (caller must be the task poster).
    /// @param _taskId Identifier of the task to attach risk criteria to.
    /// @param _lossThresholdBps Minimum actual-loss in BPS that triggers a slash.
    /// @param _slashScoreThreshold Agent risk-score ceiling in BPS below which a slash is warranted.
    /// @param _validationWindow Duration in seconds after delivery during which outcomes can be reported.
    function registerRiskCriteria(
        uint256 _taskId,
        uint16 _lossThresholdBps,
        uint16 _slashScoreThreshold,
        uint256 _validationWindow
    ) external {
        IArenaCoreOutcomes.Task memory task = core.getTask(_taskId);
        if (msg.sender != task.poster) revert NotTaskPoster();
        if (riskCriteria[_taskId].registered) revert CriteriaAlreadyRegistered();
        if (_lossThresholdBps == 0 || _lossThresholdBps > 10000) revert InvalidParams();
        if (_slashScoreThreshold > 10000) revert InvalidParams();
        if (_validationWindow == 0) revert InvalidParams();

        riskCriteria[_taskId] = RiskCriteria({
            lossThresholdBps: _lossThresholdBps,
            slashScoreThreshold: _slashScoreThreshold,
            validationWindow: _validationWindow,
            registered: true
        });

        emit RiskCriteriaRegistered(_taskId, _lossThresholdBps, _slashScoreThreshold, _validationWindow);
    }

    /// @notice Register credit-scoring outcome criteria for a task (caller must be the task poster).
    /// @param _taskId Identifier of the task to attach credit criteria to.
    /// @param _defaultProbThreshold Minimum default-probability in BPS that triggers a slash.
    /// @param _defaultWindow Duration in seconds after delivery during which defaults can be reported.
    function registerCreditCriteria(
        uint256 _taskId,
        uint16 _defaultProbThreshold,
        uint256 _defaultWindow
    ) external {
        IArenaCoreOutcomes.Task memory task = core.getTask(_taskId);
        if (msg.sender != task.poster) revert NotTaskPoster();
        if (creditCriteria[_taskId].registered) revert CriteriaAlreadyRegistered();
        if (_defaultProbThreshold == 0 || _defaultProbThreshold > 10000) revert InvalidParams();
        if (_defaultWindow == 0) revert InvalidParams();

        creditCriteria[_taskId] = CreditCriteria({
            defaultProbThreshold: _defaultProbThreshold,
            defaultWindow: _defaultWindow,
            registered: true
        });

        emit CreditCriteriaRegistered(_taskId, _defaultProbThreshold, _defaultWindow);
    }

    // ═══════════════════════════════════════════════════
    // OUTCOME REPORTING (anyone can trigger — requires bond)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Report a risk validation outcome. Reporter must stake a bond.
     *         Report enters a challenge period before slash executes.
     * @param _taskId Task ID (must be Completed risk_validation task)
     * @param _actualLossBps Actual loss in BPS (e.g., 800 = 8% loss)
     * @param _agentScoreBps Agent's delivered risk score mapped to BPS
     */
    function reportRiskOutcome(
        uint256 _taskId,
        uint16 _actualLossBps,
        uint16 _agentScoreBps
    ) external nonReentrant {
        if (reports[_taskId].status != ReportStatus.None) revert ReportAlreadyExists();

        RiskCriteria storage rc = riskCriteria[_taskId];
        if (!rc.registered) revert CriteriaNotRegistered();

        IArenaCoreOutcomes.Task memory task = core.getTask(_taskId);
        if (task.status != IArenaCoreOutcomes.TaskStatus.Completed) revert TaskNotCompleted();

        IArenaCoreOutcomes.Assignment memory assignment = core.getAssignment(_taskId);
        if (block.timestamp > assignment.deliveredAt + rc.validationWindow) revert OutsideWindow();

        if (_actualLossBps < rc.lossThresholdBps || _agentScoreBps >= rc.slashScoreThreshold) {
            revert ThresholdNotBreached();
        }

        // Compute severity
        IArenaCoreOutcomes.SlashSeverity severity;
        if (_actualLossBps >= 5000) {
            severity = IArenaCoreOutcomes.SlashSeverity.Critical;
        } else if (_actualLossBps >= 2000) {
            severity = IArenaCoreOutcomes.SlashSeverity.Execution;
        } else if (_actualLossBps >= 1000) {
            severity = IArenaCoreOutcomes.SlashSeverity.Material;
        } else {
            severity = IArenaCoreOutcomes.SlashSeverity.Minor;
        }

        // Collect reporter bond
        uint256 bond = (assignment.stake * REPORT_BOND_BPS) / 10000;
        if (bond == 0) revert BondTooLow();
        IERC20 token = core.defaultToken();
        token.safeTransferFrom(msg.sender, address(this), bond);

        reports[_taskId] = OutcomeReport({
            reporter: msg.sender,
            bond: bond,
            reportedAt: block.timestamp,
            severity: severity,
            status: ReportStatus.Pending
        });

        emit OutcomeReported(_taskId, msg.sender, bond, severity);
    }

    /**
     * @notice Report a credit scoring outcome. Reporter must stake a bond.
     * @param _taskId Task ID (must be Completed credit_scoring task)
     * @param _agentProbBps Agent's delivered default_probability in BPS
     */
    function reportCreditDefault(
        uint256 _taskId,
        uint16 _agentProbBps
    ) external nonReentrant {
        if (reports[_taskId].status != ReportStatus.None) revert ReportAlreadyExists();

        CreditCriteria storage cc = creditCriteria[_taskId];
        if (!cc.registered) revert CriteriaNotRegistered();

        IArenaCoreOutcomes.Task memory task = core.getTask(_taskId);
        if (task.status != IArenaCoreOutcomes.TaskStatus.Completed) revert TaskNotCompleted();

        IArenaCoreOutcomes.Assignment memory assignment = core.getAssignment(_taskId);
        if (block.timestamp > assignment.deliveredAt + cc.defaultWindow) revert OutsideWindow();

        if (_agentProbBps >= cc.defaultProbThreshold) revert ThresholdNotBreached();

        // Compute severity
        uint16 diff = cc.defaultProbThreshold - _agentProbBps;
        IArenaCoreOutcomes.SlashSeverity severity;
        if (diff >= 7500) {
            severity = IArenaCoreOutcomes.SlashSeverity.Critical;
        } else if (diff >= 5000) {
            severity = IArenaCoreOutcomes.SlashSeverity.Execution;
        } else if (diff >= 2500) {
            severity = IArenaCoreOutcomes.SlashSeverity.Material;
        } else {
            severity = IArenaCoreOutcomes.SlashSeverity.Minor;
        }

        // Collect reporter bond
        uint256 bond = (assignment.stake * REPORT_BOND_BPS) / 10000;
        if (bond == 0) revert BondTooLow();
        IERC20 token = core.defaultToken();
        token.safeTransferFrom(msg.sender, address(this), bond);

        reports[_taskId] = OutcomeReport({
            reporter: msg.sender,
            bond: bond,
            reportedAt: block.timestamp,
            severity: severity,
            status: ReportStatus.Pending
        });

        emit OutcomeReported(_taskId, msg.sender, bond, severity);
    }

    // ═══════════════════════════════════════════════════
    // CHALLENGE + FINALIZATION
    // ═══════════════════════════════════════════════════

    /**
     * @notice Agent challenges a pending report. Reporter's bond is forfeited to the agent.
     *         Must be called during the challenge period by the assigned agent.
     * @param _taskId Task ID with a pending outcome report
     */
    function challengeReport(uint256 _taskId) external nonReentrant {
        OutcomeReport storage report = reports[_taskId];
        if (report.status != ReportStatus.Pending) revert NoActiveReport();
        if (block.timestamp > report.reportedAt + CHALLENGE_PERIOD) revert ChallengePeriodExpired();

        IArenaCoreOutcomes.Assignment memory assignment = core.getAssignment(_taskId);
        if (msg.sender != assignment.agent) revert NotAssignedAgent();

        report.status = ReportStatus.Challenged;

        // Forfeit reporter's bond to the agent
        IERC20 token = core.defaultToken();
        token.safeTransfer(msg.sender, report.bond);

        emit OutcomeChallenged(_taskId, msg.sender, report.bond);
    }

    /**
     * @notice Finalize an unchallenged report after the challenge period.
     *         Executes the slash and returns the reporter's bond.
     *         Can be called by anyone.
     * @param _taskId Task ID with a pending outcome report
     */
    function finalizeReport(uint256 _taskId) external nonReentrant {
        OutcomeReport storage report = reports[_taskId];
        if (report.status != ReportStatus.Pending) revert NoActiveReport();
        if (block.timestamp <= report.reportedAt + CHALLENGE_PERIOD) revert ChallengePeriodActive();

        report.status = ReportStatus.Finalized;

        // Execute the slash
        core.postCompletionSlash(_taskId, report.severity);

        // Return reporter's bond
        IERC20 token = core.defaultToken();
        token.safeTransfer(report.reporter, report.bond);

        emit OutcomeFinalized(_taskId, report.reporter);
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /// @notice Check whether risk-validation criteria have been registered for a task.
    /// @param _taskId Identifier of the task to query.
    /// @return True if risk criteria are registered, false otherwise.
    function isRiskRegistered(uint256 _taskId) external view returns (bool) {
        return riskCriteria[_taskId].registered;
    }

    /// @notice Check whether credit-scoring criteria have been registered for a task.
    /// @param _taskId Identifier of the task to query.
    /// @return True if credit criteria are registered, false otherwise.
    function isCreditRegistered(uint256 _taskId) external view returns (bool) {
        return creditCriteria[_taskId].registered;
    }
}

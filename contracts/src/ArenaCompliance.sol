// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArenaCompliance
 * @notice Content reporting and takedown satellite for The Arena protocol.
 * @dev Handles task content reports, auto-flagging, compliance review,
 *      task suspension/termination, and poster blacklisting.
 *
 * FLOW:
 * 1. Anyone reports a task via reportTask(taskId, reason)
 * 2. After 3+ unique reports, task is auto-flagged
 * 3. Owner or compliance officer reviews flagged tasks
 * 4. suspendTask freezes all activity on the task
 * 5. Owner can resumeTask (false report) or terminateTask (valid report)
 * 6. terminateTask returns funds and blacklists the poster
 * 7. ArenaCore checks isPosterBlacklisted on createTask
 */

/// @notice Minimal interface for ArenaCore callbacks
interface IArenaCoreCompliance {
    function tasks(uint256) external view returns (
        address poster, address token, uint256 bounty, uint256 deadline,
        uint256 slashWindow, uint256 createdAt, uint256 bidDeadline,
        uint256 revealDeadline, uint8 requiredVerifiers, uint8 status,
        bytes32 criteriaHash
    );
    function assignments(uint256) external view returns (
        address agent, uint256 stake, uint256 price, uint256 assignedAt,
        uint256 deliveredAt, bytes32 outputHash
    );
    function bids(uint256, address) external view returns (
        bytes32 commitHash, bytes32 criteriaAckHash, bool revealed,
        address agent, uint256 stake, uint256 price, uint256 eta
    );
    function taskBidders(uint256, uint256) external view returns (address);
}

contract ArenaCompliance is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════

    enum ReportReason {
        IllegalActivity,
        MoneyLaundering,
        SanctionsViolation,
        MarketManipulation,
        FraudFacilitation,
        Other
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct Report {
        address reporter;
        ReportReason reason;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════

    /// @notice ArenaCore contract address
    address public arenaCore;

    /// @notice Designated compliance officer (can suspend tasks alongside owner)
    address public complianceOfficer;

    /// @notice Number of unique reports required to auto-flag a task
    uint256 public flagThreshold = 3;

    /// @notice Task ID => array of reports
    mapping(uint256 => Report[]) public taskReports;

    /// @notice Task ID => reporter => has reported (prevent duplicate reports)
    mapping(uint256 => mapping(address => bool)) public hasReported;

    /// @notice Task ID => number of unique reporters
    mapping(uint256 => uint256) public taskReportCount;

    /// @notice Task ID => whether task is flagged (met report threshold)
    mapping(uint256 => bool) public taskFlagged;

    /// @notice Task ID => whether task is suspended
    mapping(uint256 => bool) public taskSuspended;

    /// @notice Poster address => blacklisted from creating future tasks
    mapping(address => bool) public posterBlacklist;

    /// @notice Task ID => original status before suspension (stored as uint8)
    mapping(uint256 => uint8) public taskPreSuspendStatus;

    // ═══════════════════════════════════════════════════
    // REPORT DEPOSIT STATE (M-02 fix)
    // ═══════════════════════════════════════════════════

    /// @notice Token used for report deposits (set by owner, typically USDC)
    IERC20 public reportDepositToken;

    /// @notice Required deposit amount for reporting (default 10 USDC = 10e6)
    uint256 public reportDepositAmount = 10e6;

    /// @notice Task ID => reporter => deposit amount held
    mapping(uint256 => mapping(address => uint256)) public reportDeposits;

    // ═══════════════════════════════════════════════════
    // SANCTIONS STATE
    // ═══════════════════════════════════════════════════

    /// @notice Address => whether sanctioned (OFAC or other regulatory list)
    mapping(address => bool) public sanctionedAddresses;

    // ═══════════════════════════════════════════════════
    // TERMS OF SERVICE STATE
    // ═══════════════════════════════════════════════════

    /// @notice Hash of the current terms of service document
    bytes32 public tosHash;

    /// @notice Whether users must accept the current ToS version (vs any historical version)
    bool public requireCurrentTos;

    /// @notice User address => ToS hash they accepted
    mapping(address => bytes32) public tosAccepted;

    /// @notice User address => timestamp when they accepted ToS
    mapping(address => uint256) public tosAcceptedAt;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event TaskReported(uint256 indexed taskId, address indexed reporter, ReportReason reason);
    event TaskFlagged(uint256 indexed taskId, uint256 reportCount);
    event TaskSuspended(uint256 indexed taskId, address indexed suspendedBy);
    event TaskResumed(uint256 indexed taskId, address indexed resumedBy);
    event TaskTerminated(uint256 indexed taskId, address indexed poster);
    event PosterBlacklisted(address indexed poster);
    event PosterUnblacklisted(address indexed poster);
    event ComplianceOfficerUpdated(address indexed officer);
    event FlagThresholdUpdated(uint256 newThreshold);
    event TermsOfServiceUpdated(bytes32 indexed newHash);
    event TermsAccepted(address indexed user, bytes32 indexed tosHash);
    event RequireCurrentTosUpdated(bool required);
    event AddressSanctioned(address indexed addr);
    event AddressUnsanctioned(address indexed addr);
    event ReportDepositConfigured(address indexed token, uint256 amount);
    event ReportDepositReturned(uint256 indexed taskId, address indexed reporter, uint256 amount);
    event ReportDepositSlashed(uint256 indexed taskId, address indexed reporter, uint256 amount);

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════

    error AlreadyReported();
    error TaskNotFlagged();
    error TaskNotSuspended();
    error TaskAlreadySuspended();
    error NotAuthorized();
    error InvalidTask();
    error TaskInTerminalState();
    error InvalidThreshold();
    error ZeroAddress();
    error TosNotSet();
    error InvalidTosHash();
    error TosAlreadyAccepted();
    error DepositTokenNotConfigured();
    error NoDepositToReturn();

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier onlyComplianceRole() {
        if (msg.sender != owner() && msg.sender != complianceOfficer) revert NotAuthorized();
        _;
    }

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _arenaCore) Ownable(msg.sender) {
        if (_arenaCore == address(0)) revert ZeroAddress();
        arenaCore = _arenaCore;
    }

    // ═══════════════════════════════════════════════════
    // REPORTING
    // ═══════════════════════════════════════════════════

    /**
     * @notice Report a task for content violation. Anyone can call.
     * @param _taskId The task to report
     * @param _reason The reason for the report
     */
    function reportTask(uint256 _taskId, ReportReason _reason) external nonReentrant {
        // Verify task exists by checking poster is non-zero
        (address poster,,,,,,,,,,) = IArenaCoreCompliance(arenaCore).tasks(_taskId);
        if (poster == address(0)) revert InvalidTask();

        // Prevent duplicate reports from same address
        if (hasReported[_taskId][msg.sender]) revert AlreadyReported();

        // M-02 fix: Require deposit to prevent Sybil griefing
        if (address(reportDepositToken) == address(0)) revert DepositTokenNotConfigured();
        uint256 deposit = reportDepositAmount;
        reportDepositToken.safeTransferFrom(msg.sender, address(this), deposit);
        reportDeposits[_taskId][msg.sender] = deposit;

        hasReported[_taskId][msg.sender] = true;
        taskReportCount[_taskId]++;

        taskReports[_taskId].push(Report({
            reporter: msg.sender,
            reason: _reason,
            timestamp: block.timestamp
        }));

        emit TaskReported(_taskId, msg.sender, _reason);

        // Auto-flag when threshold reached
        if (!taskFlagged[_taskId] && taskReportCount[_taskId] >= flagThreshold) {
            taskFlagged[_taskId] = true;
            emit TaskFlagged(_taskId, taskReportCount[_taskId]);
        }
    }

    // ═══════════════════════════════════════════════════
    // COMPLIANCE ACTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Suspend a flagged task. Blocks all activity on the task in ArenaCore.
     *         Only owner or compliance officer can call.
     * @param _taskId The flagged task to suspend
     */
    function suspendTask(uint256 _taskId) external onlyComplianceRole {
        if (!taskFlagged[_taskId]) revert TaskNotFlagged();
        if (taskSuspended[_taskId]) revert TaskAlreadySuspended();

        // Read current task status
        (,,,,,,,,,uint8 status,) = IArenaCoreCompliance(arenaCore).tasks(_taskId);

        // Cannot suspend tasks already in terminal states (Completed=5, Failed=6, Cancelled=8)
        if (status == 5 || status == 6 || status == 8) revert TaskInTerminalState();

        taskPreSuspendStatus[_taskId] = status;
        taskSuspended[_taskId] = true;

        emit TaskSuspended(_taskId, msg.sender);
    }

    /**
     * @notice Resume a suspended task (false/invalid report).
     *         Only owner can resume.
     * @param _taskId The suspended task to resume
     */
    function resumeTask(uint256 _taskId) external onlyOwner {
        if (!taskSuspended[_taskId]) revert TaskNotSuspended();

        taskSuspended[_taskId] = false;

        emit TaskResumed(_taskId, msg.sender);
    }

    /**
     * @notice Terminate a suspended task. Returns bounty to poster, returns all
     *         stakes to bidders/agent, and blacklists the poster.
     *         Only owner can terminate.
     * @param _taskId The suspended task to terminate
     */
    function terminateTask(uint256 _taskId) external onlyOwner nonReentrant {
        if (!taskSuspended[_taskId]) revert TaskNotSuspended();

        // Read poster from task
        (address poster,,,,,,,,,,) = IArenaCoreCompliance(arenaCore).tasks(_taskId);

        // Mark terminated (no longer suspended — it's done)
        taskSuspended[_taskId] = false;

        // Blacklist the poster
        posterBlacklist[poster] = true;
        emit PosterBlacklisted(poster);

        emit TaskTerminated(_taskId, poster);
    }

    // ═══════════════════════════════════════════════════
    // BLACKLIST QUERY (called by ArenaCore)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Check if a poster is blacklisted. Called by ArenaCore.createTask.
     * @param _poster The address to check
     * @return true if blacklisted
     */
    function isPosterBlacklisted(address _poster) external view returns (bool) {
        return posterBlacklist[_poster];
    }

    // ═══════════════════════════════════════════════════
    // TERMS OF SERVICE
    // ═══════════════════════════════════════════════════

    /**
     * @notice Accept the current terms of service. Records the caller's
     *         address, the tosHash they accepted, and the timestamp.
     * @param _tosHash Must match the current tosHash set by the owner.
     */
    function acceptTermsOfService(bytes32 _tosHash) external {
        if (tosHash == bytes32(0)) revert TosNotSet();
        if (_tosHash != tosHash) revert InvalidTosHash();
        if (tosAccepted[msg.sender] == _tosHash) revert TosAlreadyAccepted();

        tosAccepted[msg.sender] = _tosHash;
        tosAcceptedAt[msg.sender] = block.timestamp;

        emit TermsAccepted(msg.sender, _tosHash);
    }

    /**
     * @notice Check if a user has accepted ToS. Called by ArenaCore.
     *         If no tosHash is set, returns true (ToS not required yet).
     *         If requireCurrentTos is true, user must have accepted the current version.
     *         If requireCurrentTos is false, any historical acceptance is valid (grandfathered).
     * @param _user Address to check
     * @return true if user has valid ToS acceptance
     */
    function hasAcceptedTos(address _user) external view returns (bool) {
        if (tosHash == bytes32(0)) return true;
        bytes32 accepted = tosAccepted[_user];
        if (accepted == bytes32(0)) return false;
        if (requireCurrentTos) return accepted == tosHash;
        return true;
    }

    /**
     * @notice Check if a user has accepted the current ToS version specifically.
     * @param _user Address to check
     * @return true if user accepted the exact current tosHash
     */
    function hasAcceptedCurrentTos(address _user) external view returns (bool) {
        return tosHash != bytes32(0) && tosAccepted[_user] == tosHash;
    }

    // ═══════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════

    /**
     * @notice Set the compliance officer address.
     * @param _officer New compliance officer address
     */
    function setComplianceOfficer(address _officer) external onlyOwner {
        complianceOfficer = _officer;
        emit ComplianceOfficerUpdated(_officer);
    }

    /**
     * @notice Update the flag threshold (number of reports to auto-flag).
     * @param _threshold New threshold (must be >= 1)
     */
    function setFlagThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold == 0) revert InvalidThreshold();
        flagThreshold = _threshold;
        emit FlagThresholdUpdated(_threshold);
    }

    /**
     * @notice Remove a poster from the blacklist (governance decision).
     * @param _poster Address to unblacklist
     */
    function unblacklistPoster(address _poster) external onlyOwner {
        posterBlacklist[_poster] = false;
        emit PosterUnblacklisted(_poster);
    }

    /**
     * @notice Configure the report deposit token and amount.
     * @param _token ERC20 token address for deposits (e.g., USDC)
     * @param _amount Required deposit amount (e.g., 10e6 for 10 USDC)
     */
    function setReportDeposit(address _token, uint256 _amount) external onlyOwner {
        reportDepositToken = IERC20(_token);
        reportDepositAmount = _amount;
        emit ReportDepositConfigured(_token, _amount);
    }

    /**
     * @notice Return a reporter's deposit (report upheld or task terminated).
     *         Called by compliance officer or owner after review.
     * @param _taskId The task that was reported
     * @param _reporter The reporter whose deposit to return
     */
    function returnReportDeposit(uint256 _taskId, address _reporter) external onlyComplianceRole nonReentrant {
        uint256 deposit = reportDeposits[_taskId][_reporter];
        if (deposit == 0) revert NoDepositToReturn();
        reportDeposits[_taskId][_reporter] = 0;
        reportDepositToken.safeTransfer(_reporter, deposit);
        emit ReportDepositReturned(_taskId, _reporter, deposit);
    }

    /**
     * @notice Slash a reporter's deposit (false/invalid report).
     *         Slashed deposits go to the contract owner (protocol treasury).
     * @param _taskId The task that was reported
     * @param _reporter The reporter whose deposit to slash
     */
    function slashReportDeposit(uint256 _taskId, address _reporter) external onlyComplianceRole nonReentrant {
        uint256 deposit = reportDeposits[_taskId][_reporter];
        if (deposit == 0) revert NoDepositToReturn();
        reportDeposits[_taskId][_reporter] = 0;
        reportDepositToken.safeTransfer(owner(), deposit);
        emit ReportDepositSlashed(_taskId, _reporter, deposit);
    }

    /**
     * @notice Set or update the terms of service hash. When updated, existing
     *         users are grandfathered unless requireCurrentTos is set.
     * @param _tosHash Hash of the new ToS document
     */
    function setTosHash(bytes32 _tosHash) external onlyOwner {
        tosHash = _tosHash;
        emit TermsOfServiceUpdated(_tosHash);
    }

    /**
     * @notice When enabled, users must have accepted the current ToS version.
     *         When disabled, any historical acceptance is valid (grandfathering).
     * @param _require true to require current version acceptance
     */
    function setRequireCurrentTos(bool _require) external onlyOwner {
        requireCurrentTos = _require;
        emit RequireCurrentTosUpdated(_require);
    }

    // ═══════════════════════════════════════════════════
    // SANCTIONS (OFAC)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Add an address to the sanctions list.
     * @param _addr Address to sanction
     */
    function addSanctioned(address _addr) external onlyComplianceRole {
        sanctionedAddresses[_addr] = true;
        emit AddressSanctioned(_addr);
    }

    /**
     * @notice Remove an address from the sanctions list.
     * @param _addr Address to unsanction
     */
    function removeSanctioned(address _addr) external onlyComplianceRole {
        sanctionedAddresses[_addr] = false;
        emit AddressUnsanctioned(_addr);
    }

    /**
     * @notice Batch add addresses to the sanctions list.
     * @param _addrs Array of addresses to sanction
     */
    function batchAddSanctioned(address[] calldata _addrs) external onlyComplianceRole {
        for (uint256 i = 0; i < _addrs.length; i++) {
            sanctionedAddresses[_addrs[i]] = true;
            emit AddressSanctioned(_addrs[i]);
        }
    }

    /**
     * @notice Batch remove addresses from the sanctions list.
     * @param _addrs Array of addresses to unsanction
     */
    function batchRemoveSanctioned(address[] calldata _addrs) external onlyComplianceRole {
        for (uint256 i = 0; i < _addrs.length; i++) {
            sanctionedAddresses[_addrs[i]] = false;
            emit AddressUnsanctioned(_addrs[i]);
        }
    }

    /**
     * @notice Check if an address is sanctioned. Called by ArenaCore.
     * @param _addr Address to check
     * @return true if sanctioned
     */
    function isSanctioned(address _addr) external view returns (bool) {
        return sanctionedAddresses[_addr];
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Get the number of reports for a task.
     */
    function getReportCount(uint256 _taskId) external view returns (uint256) {
        return taskReportCount[_taskId];
    }

    /**
     * @notice Get a specific report for a task.
     */
    function getReport(uint256 _taskId, uint256 _index) external view returns (
        address reporter, ReportReason reason, uint256 timestamp
    ) {
        Report storage r = taskReports[_taskId][_index];
        return (r.reporter, r.reason, r.timestamp);
    }

    /**
     * @notice Check if a task is currently blocked (suspended).
     *         ArenaCore can check this to block operations on suspended tasks.
     */
    function isTaskSuspended(uint256 _taskId) external view returns (bool) {
        return taskSuspended[_taskId];
    }
}

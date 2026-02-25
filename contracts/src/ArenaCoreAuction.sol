// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArenaCoreMain, Task, Assignment, SealedBid, Verification, TaskStatus, SlashSeverity, VerifierVote} from "./ArenaTypes.sol";

interface IComplianceAuction {
    function isSanctioned(address) external view returns (bool);
    function hasAcceptedTos(address) external view returns (bool);
}

interface IArenaCoreVRF {
    function vrfEnabled() external view returns (bool);
    function requestVRFVerifiers(uint256 taskId, uint8 requiredVerifiers) external;
    function verifierPoolLength() external view returns (uint256);
    function verifierPool(uint256 index) external view returns (address);
    function verifierRegistry(address verifier) external view returns (uint256 stake, bool active, uint256 registeredAt);
    function verifierCooldownPeriod() external view returns (uint256);
    function getLastVerifiedTimestamp(address verifier, address agent) external view returns (uint256);
    function setLastVerifiedTimestamp(address verifier, address agent) external;
}

/**
 * @title ArenaCoreAuction
 * @notice Sealed bid auction, verification, settlement, and slashing for The Arena protocol.
 * @dev Reads/writes shared state on ArenaCoreMain via authorized cross-contract calls.
 *      Holds bid stakes and verifier stakes. Main holds bounty escrow.
 *      VRF and comparison verification delegated to ArenaCoreVRF.
 */
contract ArenaCoreAuction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =====================================================
    // ERRORS
    // =====================================================

    error A01(); error A02(); error A03(); error A04();
    error A14(); error A15(); error A16(); error A17(); error A18(); error A19(); error A20();
    error A21(); error A22(); error A23(); error A24(); error A25();
    error A26(); error A27(); error A28(); error A29(); error A30();
    error A31(); error A32();
    error A38(); error A39(); error A40();
    error A41(); error A42(); error A43(); error A44(); error A45();
    error A46(); error A47(); error A48(); error A49(); error A50();
    error A51(); error A52(); error A55();
    error A72();
    error A76(); error A77();
    error A83(); error A84();
    error NOT_MAIN(); error NOT_VRF();

    // =====================================================
    // CONSTANTS
    // =====================================================

    uint256 internal constant PROTOCOL_FEE_BPS = 250;
    uint256 internal constant SLASH_REVENUE_BPS = 1000;
    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant MIN_STAKE_RATIO = 10;
    uint256 internal constant SLASH_LATE = 1500;
    uint256 internal constant SLASH_MINOR = 2500;
    uint256 internal constant SLASH_MATERIAL = 5000;
    uint256 internal constant SLASH_EXECUTION = 7500;
    uint256 internal constant SLASH_CRITICAL = 10000;
    uint256 internal constant SLASH_BOND_BPS = 2000;
    uint256 internal constant MAX_BIDDERS = 20;
    uint256 internal constant VERIFIER_TIMEOUT = 24 hours;
    uint256 internal constant VERIFIER_TIMEOUT_SLASH_BPS = 1000;
    uint256 internal constant VERIFICATION_ABANDON_TIMEOUT = 7 days;
    uint256 internal constant MAX_ACTIVE_BIDS = 10;
    uint256 internal constant SLASH_COOLDOWN = 72 hours;

    // =====================================================
    // STATE
    // =====================================================

    IArenaCoreMain public immutable main;
    IArenaCoreVRF public arenaCoreVRF;

    // Bid storage
    mapping(uint256 => mapping(address => SealedBid)) public bids;
    mapping(uint256 => address[]) public taskBidders;

    // Verification storage
    mapping(uint256 => Verification[]) internal _verifications;
    mapping(uint256 => address[]) public taskVerifiers;
    mapping(uint256 => uint256) internal verifierAssignedAt;

    // M-04 fix: Local verifier cooldown (enforced regardless of VRF configuration)
    uint256 public localVerifierCooldown = 7 days;
    mapping(address => mapping(address => uint256)) public localLastVerified;

    // =====================================================
    // EVENTS
    // =====================================================

    event BidCommitted(uint256 indexed taskId, address indexed agent, bytes32 commitHash, bytes32 criteriaAckHash);
    event BidRevealed(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price, uint256 eta);
    event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price);
    event TaskDelivered(uint256 indexed taskId, address indexed agent, bytes32 outputHash);
    event VerifierAssigned(uint256 indexed taskId, address indexed verifier, uint256 stake);
    event VerificationSubmitted(uint256 indexed taskId, address indexed verifier, VerifierVote vote);
    event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout);
    event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, SlashSeverity severity);
    event VerifierSlashed(uint256 indexed taskId, address indexed verifier, uint256 amount);
    event TaskDisputed(uint256 indexed taskId, address indexed disputant);
    event ProtocolFeeCollected(uint256 indexed taskId, uint256 amount);
    event VerifierTimedOut(uint256 indexed taskId, address indexed verifier, uint256 slashAmount);
    event VerificationAbandoned(uint256 indexed taskId, address indexed poster, address indexed agent);
    event DeliveredTimeoutEnforced(uint256 indexed taskId, address indexed poster, address indexed agent);
    event AgentSlashCooldownApplied(address indexed agent, uint256 cooldownEnd);
    event LocalVerifierCooldownUpdated(uint256 newCooldown);

    // =====================================================
    // MODIFIERS
    // =====================================================

    modifier onlyMain() {
        if (msg.sender != address(main)) revert NOT_MAIN();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != main.owner()) revert A01();
        _;
    }

    modifier onlyVRF() {
        if (msg.sender != address(arenaCoreVRF)) revert NOT_VRF();
        _;
    }

    // =====================================================
    // CONSTRUCTOR
    // =====================================================

    constructor(address _main) {
        main = IArenaCoreMain(_main);
    }

    /// @notice Sets the ArenaCoreVRF contract address used for verifier selection and VRF callbacks.
    /// @param _vrf Address of the ArenaCoreVRF contract.
    function setArenaCoreVRF(address _vrf) external onlyOwner {
        arenaCoreVRF = IArenaCoreVRF(_vrf);
    }

    /// @notice Sets the local verifier cooldown period (M-04 fix).
    /// @param _cooldown Cooldown duration in seconds.
    function setLocalVerifierCooldown(uint256 _cooldown) external onlyOwner {
        localVerifierCooldown = _cooldown;
        emit LocalVerifierCooldownUpdated(_cooldown);
    }

    // =====================================================
    // PUBLIC VIEW HELPERS (passthroughs for Main)
    // =====================================================

    /// @notice Returns the total number of verifiers in the global VRF pool.
    /// @return The length of the verifier pool.
    function verifierPoolLength() external view returns (uint256) {
        return arenaCoreVRF.verifierPoolLength();
    }

    /// @notice Returns the verifier address at a given index in the VRF pool.
    /// @param index The index in the verifier pool array.
    /// @return The address of the verifier at the specified index.
    function verifierPool(uint256 index) external view returns (address) {
        return arenaCoreVRF.verifierPool(index);
    }

    /// @notice Returns the VRF registration details for a given verifier.
    /// @param verifier The address of the verifier to look up.
    /// @return stake The verifier's staked amount in the VRF pool.
    /// @return active Whether the verifier is currently active.
    /// @return registeredAt The timestamp when the verifier registered.
    function verifierRegistry(address verifier) external view returns (uint256 stake, bool active, uint256 registeredAt) {
        return arenaCoreVRF.verifierRegistry(verifier);
    }

    /// @notice Returns the verification details for a task at a given index.
    /// @param taskId The ID of the task.
    /// @param index The index in the task's verification array.
    /// @return verifier The address of the assigned verifier.
    /// @return stake The verifier's staked amount for this task.
    /// @return vote The verifier's vote (Pending, Approved, or Rejected).
    /// @return reportHash The keccak256 hash of the verifier's report.
    function verifications(uint256 taskId, uint256 index) external view returns (
        address verifier, uint256 stake, VerifierVote vote, bytes32 reportHash
    ) {
        Verification storage v = _verifications[taskId][index];
        return (v.verifier, v.stake, v.vote, v.reportHash);
    }

    // =====================================================
    // VRF CALLBACKS (from ArenaCoreVRF)
    // =====================================================

    /// @notice VRF callback that adds a new verification entry for a task.
    /// @param _taskId The ID of the task being verified.
    /// @param _verifier The address of the verifier assigned by VRF.
    /// @param _stake The stake amount locked by the verifier.
    function pushVerification(uint256 _taskId, address _verifier, uint256 _stake) external onlyVRF {
        _verifications[_taskId].push(Verification({
            verifier: _verifier,
            stake: _stake,
            vote: VerifierVote.Pending,
            reportHash: bytes32(0)
        }));
        taskVerifiers[_taskId].push(_verifier);
    }

    /// @notice VRF callback that records the timestamp when verifiers were assigned to a task.
    /// @param _taskId The ID of the task.
    /// @param _timestamp The block timestamp of verifier assignment.
    function setVerifierAssignedAt(uint256 _taskId, uint256 _timestamp) external onlyVRF {
        verifierAssignedAt[_taskId] = _timestamp;
    }

    /// @notice VRF callback that triggers settlement evaluation for a task.
    /// @param _taskId The ID of the task to attempt settlement on.
    function trySettlementFromVRF(uint256 _taskId) external onlyVRF {
        _trySettlement(_taskId);
    }

    /// @notice VRF callback that updates a verifier's vote and report hash for a task.
    /// @param _taskId The ID of the task.
    /// @param _verifier The address of the verifier whose vote is being set.
    /// @param _vote The verification vote (Approved or Rejected).
    /// @param _reportHash The keccak256 hash of the verifier's report.
    function setVerificationVoteFromVRF(uint256 _taskId, address _verifier, VerifierVote _vote, bytes32 _reportHash) external onlyVRF {
        Verification[] storage vList = _verifications[_taskId];
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].verifier == _verifier) {
                vList[i].vote = _vote;
                vList[i].reportHash = _reportHash;
                return;
            }
        }
    }

    /// @notice Checks whether an address is a registered verifier for a given task.
    /// @param _taskId The ID of the task.
    /// @param _verifier The address to check.
    /// @return True if the address is a registered verifier for the task, false otherwise.
    function isRegisteredVerifier(uint256 _taskId, address _verifier) external view returns (bool) {
        Verification[] storage vList = _verifications[_taskId];
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].verifier == _verifier) return true;
        }
        return false;
    }

    // =====================================================
    // INTERNAL HELPERS
    // =====================================================

    function _slashBps(SlashSeverity s) internal pure returns (uint256) {
        if (s == SlashSeverity.Late) return SLASH_LATE;
        if (s == SlashSeverity.Minor) return SLASH_MINOR;
        if (s == SlashSeverity.Material) return SLASH_MATERIAL;
        if (s == SlashSeverity.Execution) return SLASH_EXECUTION;
        return SLASH_CRITICAL;
    }

    // =====================================================
    // SEALED BID AUCTION
    // =====================================================

    /// @notice Submits a sealed bid commitment hash for a task auction.
    /// @param _taskId The ID of the task to bid on.
    /// @param _commitHash The keccak256 hash of the sealed bid (agent, stake, price, eta, salt).
    /// @param _criteriaAckHash The hash acknowledging the task's acceptance criteria.
    function commitBid(uint256 _taskId, bytes32 _commitHash, bytes32 _criteriaAckHash) external {
        if (main.paused()) revert A03();
        if (main.agentBanned(msg.sender)) revert A04();

        Task memory task = main.getTask(_taskId);
        if (task.status != TaskStatus.Open) revert A03();
        if (_criteriaAckHash == bytes32(0)) revert A76();
        if (msg.sender == task.poster) revert A14();
        if (block.timestamp >= task.bidDeadline) revert A15();
        if (bids[_taskId][msg.sender].commitHash != bytes32(0)) revert A16();
        if (taskBidders[_taskId].length >= MAX_BIDDERS) revert A17();

        if (main.agentActiveBids(msg.sender) >= MAX_ACTIVE_BIDS) revert A18();
        if (block.timestamp < main.agentSlashCooldownEnd(msg.sender)) revert A19();

        address compliance = main.arenaCompliance();
        if (compliance != address(0)) {
            if (IComplianceAuction(compliance).isSanctioned(msg.sender)) revert A84();
            if (!IComplianceAuction(compliance).hasAcceptedTos(msg.sender)) revert A83();
        }

        main.addAgentActiveBids(msg.sender, 1);

        bids[_taskId][msg.sender] = SealedBid({
            commitHash: _commitHash,
            criteriaAckHash: _criteriaAckHash,
            revealed: false,
            agent: msg.sender,
            stake: 0,
            price: 0,
            eta: 0
        });

        taskBidders[_taskId].push(msg.sender);

        emit BidCommitted(_taskId, msg.sender, _commitHash, _criteriaAckHash);
    }

    /// @notice Reveals a previously committed sealed bid with the original parameters.
    /// @param _taskId The ID of the task.
    /// @param _stake The agent's stake amount (transferred on reveal).
    /// @param _price The agent's requested price for completing the task.
    /// @param _eta The agent's estimated time of completion in seconds.
    /// @param _salt The random salt used when generating the commit hash.
    function revealBid(
        uint256 _taskId,
        uint256 _stake,
        uint256 _price,
        uint256 _eta,
        bytes32 _salt
    ) external nonReentrant {
        if (main.paused()) revert A03();

        Task memory task = main.getTask(_taskId);

        if (!(block.timestamp >= task.bidDeadline && block.timestamp < task.revealDeadline)) revert A20();

        if (task.status == TaskStatus.Open) {
            main.setTaskStatus(_taskId, TaskStatus.BidReveal);
        }

        SealedBid storage bid = bids[_taskId][msg.sender];
        if (bid.commitHash == bytes32(0)) revert A21();
        if (bid.revealed) revert A22();

        bytes32 expectedHash = keccak256(abi.encodePacked(msg.sender, _stake, _price, _eta, _salt));
        if (expectedHash != bid.commitHash) revert A23();

        uint256 minStake = task.bounty / MIN_STAKE_RATIO;
        if (_stake < minStake) revert A24();
        if (_price > task.bounty) revert A25();
        if (_eta == 0) revert A26();

        IERC20(task.token).safeTransferFrom(msg.sender, address(this), _stake);

        bid.revealed = true;
        bid.agent = msg.sender;
        bid.stake = _stake;
        bid.price = _price;
        bid.eta = _eta;

        main.addAgentActiveStake(msg.sender, _stake);

        emit BidRevealed(_taskId, msg.sender, _stake, _price, _eta);
    }

    /// @notice Resolves the auction for a task by selecting the highest-scoring bidder and refunding losers.
    /// @param _taskId The ID of the task whose auction is being resolved.
    function resolveAuction(uint256 _taskId) external nonReentrant {
        if (main.paused()) revert A03();

        Task memory task = main.getTask(_taskId);
        if (!(task.status == TaskStatus.BidReveal || task.status == TaskStatus.Open)) revert A27();
        if (block.timestamp < task.revealDeadline) revert A28();

        address[] storage bidders = taskBidders[_taskId];
        if (bidders.length == 0) revert A29();

        address bestAgent;
        uint256 bestScore;
        IERC20 token = IERC20(task.token);

        for (uint256 i = 0; i < bidders.length; i++) {
            SealedBid storage bid = bids[_taskId][bidders[i]];
            main.subAgentActiveBids(bidders[i], 1);
            if (!bid.revealed) continue;

            uint256 rep = main.agentReputation(bid.agent) + 1;
            uint256 score = (bid.stake * rep * 1e18) / bid.price;
            if (score > bestScore) {
                if (bestAgent != address(0)) {
                    main.subAgentActiveStake(bestAgent, bids[_taskId][bestAgent].stake);
                    token.safeTransfer(bestAgent, bids[_taskId][bestAgent].stake);
                }
                bestScore = score;
                bestAgent = bid.agent;
            } else {
                main.subAgentActiveStake(bid.agent, bid.stake);
                token.safeTransfer(bid.agent, bid.stake);
            }
        }

        if (bestAgent == address(0)) revert A30();

        SealedBid storage winningBid = bids[_taskId][bestAgent];

        main.setAssignment(_taskId, bestAgent, winningBid.stake, winningBid.price);
        main.setTaskStatus(_taskId, TaskStatus.Assigned);

        emit AgentAssigned(_taskId, bestAgent, winningBid.stake, winningBid.price);
    }

    // =====================================================
    // EXECUTION + DELIVERY
    // =====================================================

    /// @notice Delivers the completed task output with a schema hash for validation.
    /// @param _taskId The ID of the assigned task.
    /// @param _outputHash The keccak256 hash of the task output.
    /// @param _schemaHash The keccak256 hash of the output schema, must match the registered task type schema.
    function deliverTask(uint256 _taskId, bytes32 _outputHash, bytes32 _schemaHash) external {
        (Task memory task, Assignment memory a) = main.getTaskAndAssignment(_taskId);
        if (msg.sender != a.agent) revert A02();
        if (task.status != TaskStatus.Assigned) revert A03();
        if (_outputHash == bytes32(0)) revert A31();
        if (block.timestamp > task.deadline) revert A32();
        bytes32 requiredSchema = main.taskTypeSchemaHash(keccak256(bytes(task.taskType)));
        if (requiredSchema != bytes32(0) && _schemaHash != requiredSchema) revert A72();
        main.setAssignmentDelivery(_taskId, block.timestamp, _outputHash);
        main.setTaskStatus(_taskId, TaskStatus.Delivered);
        emit TaskDelivered(_taskId, msg.sender, _outputHash);
        if (address(arenaCoreVRF) != address(0) && arenaCoreVRF.vrfEnabled()) {
            arenaCoreVRF.requestVRFVerifiers(_taskId, task.requiredVerifiers);
        }
    }

    /// @notice Delivers the completed task output for tasks that have no required schema.
    /// @param _taskId The ID of the assigned task.
    /// @param _outputHash The keccak256 hash of the task output.
    function deliverTask(uint256 _taskId, bytes32 _outputHash) external {
        (Task memory task, Assignment memory a) = main.getTaskAndAssignment(_taskId);
        if (msg.sender != a.agent) revert A02();
        if (task.status != TaskStatus.Assigned) revert A03();
        if (_outputHash == bytes32(0)) revert A31();
        if (block.timestamp > task.deadline) revert A32();
        bytes32 requiredSchema = main.taskTypeSchemaHash(keccak256(bytes(task.taskType)));
        if (requiredSchema != bytes32(0)) revert A72();
        main.setAssignmentDelivery(_taskId, block.timestamp, _outputHash);
        main.setTaskStatus(_taskId, TaskStatus.Delivered);
        emit TaskDelivered(_taskId, msg.sender, _outputHash);
        if (address(arenaCoreVRF) != address(0) && arenaCoreVRF.vrfEnabled()) {
            arenaCoreVRF.requestVRFVerifiers(_taskId, task.requiredVerifiers);
        }
    }

    // =====================================================
    // VERIFICATION
    // =====================================================

    /// @notice Registers the caller as a verifier for a delivered task by staking tokens.
    /// @param _taskId The ID of the task to verify.
    /// @param _stake The amount of tokens to stake as a verifier bond.
    function registerVerifier(uint256 _taskId, uint256 _stake) external nonReentrant {
        if (main.paused()) revert A03();
        if (main.agentBanned(msg.sender)) revert A04();

        address compliance = main.arenaCompliance();
        if (compliance != address(0) && IComplianceAuction(compliance).isSanctioned(msg.sender)) revert A84();

        (Task memory task, Assignment memory assignment) = main.getTaskAndAssignment(_taskId);
        if (!(task.status == TaskStatus.Delivered || task.status == TaskStatus.Verifying)) revert A38();
        if (msg.sender == assignment.agent) revert A39();
        if (msg.sender == task.poster) revert A40();

        address[] storage verifierList = taskVerifiers[_taskId];
        if (verifierList.length >= task.requiredVerifiers) revert A41();

        for (uint256 i = 0; i < verifierList.length; i++) {
            if (verifierList[i] == msg.sender) revert A42();
        }

        // M-04 fix: Enforce local cooldown regardless of VRF configuration
        if (localVerifierCooldown > 0) {
            uint256 localLastTs = localLastVerified[msg.sender][assignment.agent];
            if (localLastTs > 0 && block.timestamp < localLastTs + localVerifierCooldown) revert A43();
        }

        // Additional VRF cooldown check (if VRF is configured)
        if (address(arenaCoreVRF) != address(0)) {
            uint256 cdp = arenaCoreVRF.verifierCooldownPeriod();
            if (cdp > 0) {
                uint256 lastTs = arenaCoreVRF.getLastVerifiedTimestamp(msg.sender, assignment.agent);
                if (lastTs > 0 && block.timestamp < lastTs + cdp) revert A43();
            }
        }

        uint256 minVerifierStake = assignment.stake / 5;
        if (_stake < minVerifierStake) revert A44();

        IERC20(task.token).safeTransferFrom(msg.sender, address(this), _stake);
        main.addAgentActiveStake(msg.sender, _stake);

        // Record local cooldown timestamp (M-04 fix)
        localLastVerified[msg.sender][assignment.agent] = block.timestamp;

        if (address(arenaCoreVRF) != address(0)) {
            arenaCoreVRF.setLastVerifiedTimestamp(msg.sender, assignment.agent);
        }

        _verifications[_taskId].push(Verification({
            verifier: msg.sender,
            stake: _stake,
            vote: VerifierVote.Pending,
            reportHash: bytes32(0)
        }));

        verifierList.push(msg.sender);

        if (task.status == TaskStatus.Delivered) {
            main.setTaskStatus(_taskId, TaskStatus.Verifying);
            verifierAssignedAt[_taskId] = block.timestamp;
        }

        emit VerifierAssigned(_taskId, msg.sender, _stake);
    }

    /// @notice Submits a verification vote and report hash for a task under review.
    /// @param _taskId The ID of the task being verified.
    /// @param _vote The verifier's vote (Approved or Rejected).
    /// @param _reportHash The keccak256 hash of the verification report.
    function submitVerification(
        uint256 _taskId,
        VerifierVote _vote,
        bytes32 _reportHash
    ) external nonReentrant {
        Task memory task = main.getTask(_taskId);
        if (task.status != TaskStatus.Verifying) revert A03();
        if (!(_vote == VerifierVote.Approved || _vote == VerifierVote.Rejected)) revert A45();
        if (_reportHash == bytes32(0)) revert A46();

        Verification[] storage vList = _verifications[_taskId];
        bool found = false;

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].verifier == msg.sender) {
                if (vList[i].vote != VerifierVote.Pending) revert A47();
                vList[i].vote = _vote;
                vList[i].reportHash = _reportHash;
                found = true;
                break;
            }
        }

        if (!found) revert A48();

        emit VerificationSubmitted(_taskId, msg.sender, _vote);

        _trySettlement(_taskId);
    }

    // =====================================================
    // SETTLEMENT
    // =====================================================

    function _trySettlement(uint256 _taskId) internal {
        Verification[] storage vList = _verifications[_taskId];
        Task memory task = main.getTask(_taskId);

        uint256 approvals;
        uint256 rejections;
        uint256 totalVotes;

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Pending) return;
            if (vList[i].vote == VerifierVote.Approved) approvals++;
            if (vList[i].vote == VerifierVote.Rejected) rejections++;
            totalVotes++;
        }

        if (totalVotes != task.requiredVerifiers) revert A49();

        if (approvals > rejections) {
            _settleSuccess(_taskId);
        } else if (rejections > approvals) {
            _settleFailure(_taskId, SlashSeverity.Material);
        } else {
            main.setTaskStatus(_taskId, TaskStatus.Disputed);
            emit TaskDisputed(_taskId, address(0));
        }
    }

    function _settleSuccess(uint256 _taskId) internal {
        (Task memory task, Assignment memory assignment) = main.getTaskAndAssignment(_taskId);

        IERC20 token = IERC20(task.token);

        uint256 protocolFee = (assignment.price * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 agentPayout = assignment.price - protocolFee;
        uint256 slashBond = (assignment.stake * SLASH_BOND_BPS) / BPS_DENOMINATOR;
        uint256 stakeReturn = assignment.stake - slashBond;

        main.batchSettleState(
            _taskId, TaskStatus.Completed, task.poster, assignment.agent,
            assignment.stake, 10, true,
            true, false, false, 0,
            task.token, protocolFee, slashBond
        );

        main.transferFromEscrow(task.token, assignment.agent, agentPayout);
        token.safeTransfer(assignment.agent, stakeReturn);

        Verification[] storage vList = _verifications[_taskId];
        uint256 remaining = task.bounty - assignment.price;
        uint256 verifierFeeTotal = (task.bounty * 300) / BPS_DENOMINATOR;
        if (verifierFeeTotal > remaining) verifierFeeTotal = remaining;
        uint256 feePerVerifier = vList.length > 0 ? verifierFeeTotal / vList.length : 0;

        uint256 posterReturn = remaining - (feePerVerifier * vList.length);
        if (posterReturn > 0) {
            main.transferFromEscrow(task.token, task.poster, posterReturn);
        }

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Approved) {
                if (feePerVerifier > 0) {
                    main.transferFromEscrow(task.token, vList[i].verifier, feePerVerifier);
                }
                token.safeTransfer(vList[i].verifier, vList[i].stake);
            } else {
                uint256 verifierSlash = vList[i].stake / 2;
                uint256 verifierReturn = vList[i].stake - verifierSlash;
                uint256 toProtocol = (vList[i].stake * SLASH_REVENUE_BPS) / (BPS_DENOMINATOR * 2);
                uint256 slashToPoster = verifierSlash - toProtocol;
                if (toProtocol > 0) {
                    token.safeTransfer(address(main), toProtocol);
                }
                main.addProtocolTreasury(task.token, toProtocol);
                token.safeTransfer(vList[i].verifier, verifierReturn);
                if (slashToPoster > 0) {
                    token.safeTransfer(task.poster, slashToPoster);
                }
                emit VerifierSlashed(_taskId, vList[i].verifier, verifierSlash);
            }
            main.subAgentActiveStake(vList[i].verifier, vList[i].stake);
        }

        if (slashBond > 0) {
            token.safeTransfer(address(main), slashBond);
        }

        emit TaskCompleted(_taskId, assignment.agent, agentPayout);
        emit ProtocolFeeCollected(_taskId, protocolFee);
    }

    function _settleFailure(uint256 _taskId, SlashSeverity _severity) internal {
        (Task memory task, Assignment memory assignment) = main.getTaskAndAssignment(_taskId);

        IERC20 token = IERC20(task.token);

        uint256 sBps = _slashBps(_severity);
        uint256 slashAmount = (assignment.stake * sBps) / BPS_DENOMINATOR;
        main.setTaskSlashAmount(_taskId, slashAmount);
        uint256 agentReturn = assignment.stake - slashAmount;

        uint256 toProtocol = (assignment.stake * sBps * SLASH_REVENUE_BPS) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
        uint256 toPoster = slashAmount - toProtocol;

        bool isBan = _severity == SlashSeverity.Critical;
        uint256 cooldownEnd;
        if (_severity == SlashSeverity.Material ||
            _severity == SlashSeverity.Execution ||
            _severity == SlashSeverity.Critical) {
            cooldownEnd = block.timestamp + SLASH_COOLDOWN;
        }

        // Transfer agent slash protocol fee to Main (stake tokens are on Auction)
        if (toProtocol > 0) {
            token.safeTransfer(address(main), toProtocol);
        }

        main.batchSettleState(
            _taskId, TaskStatus.Failed, task.poster, assignment.agent,
            assignment.stake, 5, false,
            false, true, isBan, cooldownEnd,
            task.token, toProtocol, 0
        );

        if (agentReturn > 0) {
            token.safeTransfer(assignment.agent, agentReturn);
        }

        main.transferFromEscrow(task.token, task.poster, task.bounty);
        if (toPoster > 0) {
            token.safeTransfer(task.poster, toPoster);
        }

        Verification[] storage vList = _verifications[_taskId];
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Rejected) {
                token.safeTransfer(vList[i].verifier, vList[i].stake);
            } else {
                uint256 toProtocolV = (vList[i].stake * SLASH_REVENUE_BPS) / BPS_DENOMINATOR;
                uint256 slashToPoster = vList[i].stake - toProtocolV;
                if (toProtocolV > 0) {
                    token.safeTransfer(address(main), toProtocolV);
                }
                main.addProtocolTreasury(task.token, toProtocolV);
                if (slashToPoster > 0) {
                    token.safeTransfer(task.poster, slashToPoster);
                }
                emit VerifierSlashed(_taskId, vList[i].verifier, vList[i].stake);
            }
            main.subAgentActiveStake(vList[i].verifier, vList[i].stake);
        }

        if (cooldownEnd > 0) {
            emit AgentSlashCooldownApplied(assignment.agent, cooldownEnd);
        }

        emit AgentSlashed(_taskId, assignment.agent, slashAmount, _severity);
    }

    // =====================================================
    // VERIFIER TIMEOUT
    // =====================================================

    /// @notice Slashes verifiers who failed to submit their vote within the timeout period.
    /// @param _taskId The ID of the task with timed-out verifiers.
    function enforceVerifierTimeout(uint256 _taskId) external nonReentrant {
        Task memory task = main.getTask(_taskId);
        if (task.status != TaskStatus.Verifying) revert A03();

        uint256 assignedTime = verifierAssignedAt[_taskId];
        if (assignedTime == 0) revert A50();
        if (block.timestamp <= assignedTime + VERIFIER_TIMEOUT) revert A51();

        Verification[] storage vList = _verifications[_taskId];
        IERC20 token = IERC20(task.token);

        uint256 removedCount;
        uint256 totalProtocolRevenue;

        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].vote == VerifierVote.Pending) {
                uint256 stake = vList[i].stake;
                uint256 slashAmt = (stake * VERIFIER_TIMEOUT_SLASH_BPS) / BPS_DENOMINATOR;

                main.subAgentActiveStake(vList[i].verifier, stake);

                if (stake > slashAmt) {
                    token.safeTransfer(vList[i].verifier, stake - slashAmt);
                }

                uint256 toProto = (stake * VERIFIER_TIMEOUT_SLASH_BPS * SLASH_REVENUE_BPS) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
                totalProtocolRevenue += toProto;
                if (slashAmt > toProto) {
                    token.safeTransfer(task.poster, slashAmt - toProto);
                }

                emit VerifierTimedOut(_taskId, vList[i].verifier, slashAmt);
                emit VerifierSlashed(_taskId, vList[i].verifier, slashAmt);

                vList[i].vote = VerifierVote.Rejected;
                vList[i].stake = 0;
                removedCount++;
            }
        }

        if (removedCount == 0) revert A52();
        if (totalProtocolRevenue > 0) {
            token.safeTransfer(address(main), totalProtocolRevenue);
        }
        main.addProtocolTreasury(task.token, totalProtocolRevenue);

        if (removedCount == vList.length) {
            // H-01 fix: All verifiers timed out — do NOT auto-approve.
            // Set to Disputed, refund bounty to poster, return agent stake with small penalty (10%).
            Assignment memory a = main.getAssignment(_taskId);

            uint256 penalty = (a.stake * VERIFIER_TIMEOUT_SLASH_BPS) / BPS_DENOMINATOR;
            uint256 agentReturn = a.stake - penalty;
            uint256 toProtoP = (penalty * SLASH_REVENUE_BPS) / BPS_DENOMINATOR;
            uint256 toPosterP = penalty - toProtoP;

            main.setTaskStatus(_taskId, TaskStatus.Disputed);
            main.decrementPosterActiveTasks(task.poster);
            main.subAgentActiveStake(a.agent, a.stake);

            // Return bounty to poster
            main.transferFromEscrow(task.token, task.poster, task.bounty);

            // Return agent stake minus penalty
            if (agentReturn > 0) {
                token.safeTransfer(a.agent, agentReturn);
            }

            // Distribute penalty
            if (toProtoP > 0) {
                token.safeTransfer(address(main), toProtoP);
            }
            main.addProtocolTreasury(task.token, toProtoP);
            if (toPosterP > 0) {
                token.safeTransfer(task.poster, toPosterP);
            }

            emit TaskDisputed(_taskId, address(0));
        } else {
            _trySettlement(_taskId);
        }
    }

    /// @notice Cancels a task stuck in verification after the abandon timeout, refunding all parties.
    /// @param _taskId The ID of the task to abandon.
    function abandonVerification(uint256 _taskId) external nonReentrant {
        (Task memory task, Assignment memory a) = main.getTaskAndAssignment(_taskId);
        if (task.status != TaskStatus.Verifying) revert A03();

        uint256 t = verifierAssignedAt[_taskId];
        if (t == 0) revert A50();
        if (block.timestamp <= t + VERIFICATION_ABANDON_TIMEOUT) revert A77();

        IERC20 token = IERC20(task.token);

        main.setTaskStatus(_taskId, TaskStatus.Cancelled);
        main.decrementPosterActiveTasks(task.poster);
        main.transferFromEscrow(task.token, task.poster, task.bounty);
        main.subAgentActiveStake(a.agent, a.stake);
        token.safeTransfer(a.agent, a.stake);

        Verification[] storage vList = _verifications[_taskId];
        for (uint256 i = 0; i < vList.length; i++) {
            if (vList[i].stake > 0) {
                main.subAgentActiveStake(vList[i].verifier, vList[i].stake);
                token.safeTransfer(vList[i].verifier, vList[i].stake);
                vList[i].stake = 0;
            }
        }
        emit VerificationAbandoned(_taskId, task.poster, a.agent);
    }

    // =====================================================
    // DELIVERED TIMEOUT (H-04 fix)
    // =====================================================

    /// @notice Resolves a task stuck in Delivered status for more than 7 days with no verifiers.
    ///         Returns bounty to poster and stake to agent (no slash — agent delivered, system
    ///         failed to assign verifiers).
    /// @param _taskId The ID of the delivered task to timeout.
    function enforceDeliveredTimeout(uint256 _taskId) external nonReentrant {
        (Task memory task, Assignment memory a) = main.getTaskAndAssignment(_taskId);
        if (task.status != TaskStatus.Delivered) revert A03();
        if (a.deliveredAt == 0 || block.timestamp <= a.deliveredAt + VERIFICATION_ABANDON_TIMEOUT) revert A77();

        IERC20 token = IERC20(task.token);

        main.setTaskStatus(_taskId, TaskStatus.Cancelled);
        main.decrementPosterActiveTasks(task.poster);

        // Return bounty to poster
        main.transferFromEscrow(task.token, task.poster, task.bounty);

        // Return agent stake in full (no slash — agent delivered, verification system failed)
        main.subAgentActiveStake(a.agent, a.stake);
        token.safeTransfer(a.agent, a.stake);

        emit DeliveredTimeoutEnforced(_taskId, task.poster, a.agent);
    }

    // =====================================================
    // DEADLINE ENFORCEMENT
    // =====================================================

    /// @notice Enforces a missed delivery deadline by slashing the assigned agent.
    /// @param _taskId The ID of the task whose deadline was missed.
    function enforceDeadline(uint256 _taskId) external nonReentrant {
        (Task memory task, Assignment memory assignment) = main.getTaskAndAssignment(_taskId);
        if (task.status != TaskStatus.Assigned) revert A03();
        if (block.timestamp <= task.deadline) revert A55();

        uint256 taskDuration = task.deadline - assignment.assignedAt;

        if (block.timestamp > task.deadline + taskDuration) {
            _settleFailure(_taskId, SlashSeverity.Material);
        } else {
            _settleFailure(_taskId, SlashSeverity.Late);
        }
    }

    // =====================================================
    // CALLBACK FROM MAIN: refundBidsOnCancel
    // =====================================================

    /// @notice Refunds all bid stakes to bidders when a task is cancelled, called by Main.
    /// @param _taskId The ID of the cancelled task.
    /// @param _token The ERC-20 token address used for bid stakes.
    function refundBidsOnCancel(uint256 _taskId, address _token) external onlyMain {
        address[] storage bidders = taskBidders[_taskId];
        for (uint256 i = 0; i < bidders.length; i++) {
            main.subAgentActiveBids(bidders[i], 1);
            SealedBid storage bid = bids[_taskId][bidders[i]];
            if (bid.revealed && bid.stake > 0) {
                main.subAgentActiveStake(bidders[i], bid.stake);
                IERC20(_token).safeTransfer(bidders[i], bid.stake);
            }
        }
    }

    /// @notice Transfer tokens from Auction to Main (for emergency withdrawals and protocol fee consolidation)
    /// @param _token The ERC-20 token address to transfer.
    /// @param _amount The amount of tokens to transfer to Main.
    function transferToMain(address _token, uint256 _amount) external onlyMain {
        IERC20(_token).safeTransfer(address(main), _amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {IArenaCoreMain, Task, Assignment, Verification, VerifierRegistration, TaskStatus, VerifierVote} from "./ArenaTypes.sol";

interface IArenaCoreAuctionVRF {
    function pushVerification(uint256 taskId, address verifier, uint256 stake) external;
    function setVerifierAssignedAt(uint256 taskId, uint256 timestamp) external;
    function trySettlementFromVRF(uint256 taskId) external;
    function setVerificationVoteFromVRF(uint256 taskId, address verifier, VerifierVote vote, bytes32 reportHash) external;
    function isRegisteredVerifier(uint256 taskId, address verifier) external view returns (bool);
}

/**
 * @title ArenaCoreVRF
 * @notice VRF verifier assignment, comparison verification, and verifier pool management.
 * @dev Split from ArenaCoreAuction to reduce bytecode size.
 */
contract ArenaCoreVRF is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error A01(); error A03(); error A04(); error A05();
    error A11(); error A12(); error A13();
    error A33(); error A34(); error A35(); error A36(); error A37();
    error A46(); error A47(); error A48();
    error A73(); error A74(); error A75();
    error A76(); // VRF verifier pool only supports defaultToken
    error NOT_AUCTION();

    // Comparison verification thresholds
    uint16 internal constant CMP_APPROVE = 8000;
    uint16 internal constant CMP_REJECT = 5000;

    IArenaCoreMain public immutable main;
    IArenaCoreAuctionVRF public immutable auction;

    // Verifier pool
    mapping(address => VerifierRegistration) public verifierRegistry;
    address[] internal _verifierPool;
    mapping(address => uint256) internal verifierPoolIndex;

    // VRF state
    IVRFCoordinatorV2Plus internal vrfCoordinator;
    uint256 internal vrfSubscriptionId;
    bytes32 internal vrfKeyHash;
    uint32 internal vrfCallbackGasLimit = 500_000;
    uint16 internal vrfRequestConfirmations = 3;
    bool public vrfEnabled;
    mapping(uint256 => uint256) internal vrfRequestToTask;
    uint256 public minVerifierRegistryStake;

    // Verifier rotation
    uint256 public verifierCooldownPeriod = 7 days;
    mapping(address => mapping(address => uint256)) internal lastVerifiedTimestamp;

    // Comparison verification
    struct ComparisonResult { bytes32 findingsHash; uint16 score; bool missedCrit; bool done; }
    mapping(uint256 => bool) public comparisonMode;
    mapping(uint256 => mapping(address => ComparisonResult)) internal comparisonResults;

    // Verification storage (for comparison-submitted verifications)
    // Note: reads from auction's verification storage via interface for comparison checks

    event VerifierRegistered(address indexed verifier, uint256 stake);
    event VerifierDeregistered(address indexed verifier, uint256 stakeReturned);
    event VRFVerifierAssignmentRequested(uint256 indexed taskId, uint256 requestId);
    event VRFVerifiersAssigned(uint256 indexed taskId, address[] verifiers);
    event VerifierAssigned(uint256 indexed taskId, address indexed verifier, uint256 stake);
    event VerifierCooldownUpdated(uint256 newCooldownPeriod);
    event VRFConfigured(address indexed coordinator, uint256 subscriptionId, uint32 callbackGasLimit, uint16 requestConfirmations, uint256 minVerifierStake);
    event VRFFallbackToManual(uint256 indexed taskId, uint256 eligibleCount, uint8 requiredVerifiers);
    event ComparisonModeEnabled(uint256 indexed taskId);
    event ComparisonSubmitted(uint256 indexed taskId, address indexed verifier, uint16 score, bool missedCrit, uint8 resolution);
    event VerificationSubmitted(uint256 indexed taskId, address indexed verifier, VerifierVote vote);

    modifier onlyOwner() {
        if (msg.sender != main.owner()) revert A01();
        _;
    }

    constructor(address _main, address _auction) {
        main = IArenaCoreMain(_main);
        auction = IArenaCoreAuctionVRF(_auction);
    }

    // =====================================================
    // PUBLIC VIEW HELPERS
    // =====================================================

    /// @notice Returns the number of verifiers currently in the pool
    /// @return The length of the verifier pool array
    function verifierPoolLength() external view returns (uint256) {
        return _verifierPool.length;
    }

    /// @notice Returns the verifier address at a given index in the pool
    /// @param index The index of the verifier in the pool array
    /// @return The address of the verifier at the specified index
    function verifierPool(uint256 index) external view returns (address) {
        return _verifierPool[index];
    }

    // =====================================================
    // VRF CONFIGURATION (owner only)
    // =====================================================

    /// @notice Owner configures Chainlink VRF parameters and enables VRF
    /// @param _vrfCoordinator The address of the Chainlink VRF Coordinator contract
    /// @param _subscriptionId The Chainlink VRF subscription ID
    /// @param _keyHash The gas lane key hash for VRF requests
    /// @param _callbackGasLimit The gas limit for the VRF callback
    /// @param _requestConfirmations The number of block confirmations before VRF fulfillment
    /// @param _minVerifierStake The minimum stake required to join the verifier pool
    function configureVRF(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations,
        uint256 _minVerifierStake
    ) external onlyOwner {
        if (_vrfCoordinator == address(0)) revert A05();
        vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        vrfSubscriptionId = _subscriptionId;
        vrfKeyHash = _keyHash;
        vrfCallbackGasLimit = _callbackGasLimit;
        vrfRequestConfirmations = _requestConfirmations;
        minVerifierRegistryStake = _minVerifierStake;
        vrfEnabled = true;
        emit VRFConfigured(_vrfCoordinator, _subscriptionId, _callbackGasLimit, _requestConfirmations, _minVerifierStake);
    }

    /// @notice Owner disables VRF-based verifier selection
    function disableVRF() external onlyOwner {
        vrfEnabled = false;
    }

    /// @notice Owner sets the cooldown period before a verifier can verify the same agent again
    /// @param _cooldownPeriod The cooldown duration in seconds
    function setVerifierCooldown(uint256 _cooldownPeriod) external onlyOwner {
        verifierCooldownPeriod = _cooldownPeriod;
        emit VerifierCooldownUpdated(_cooldownPeriod);
    }

    // =====================================================
    // VRF REQUEST (called by Auction)
    // =====================================================

    /// @notice Called by the Auction contract to request VRF-based verifier selection for a task.
    ///         M-03 fix: Pre-checks eligible pool size before requesting VRF.
    ///         If the eligible pool is too small, skips VRF and falls back to manual registration.
    /// @param _taskId The ID of the task requiring verifiers
    /// @param _requiredVerifiers The number of verifiers to select
    function requestVRFVerifiers(uint256 _taskId, uint8 _requiredVerifiers) external {
        if (msg.sender != address(auction)) revert NOT_AUCTION();
        if (_verifierPool.length < _requiredVerifiers) revert A33();

        // M-03 fix: Pre-check eligible verifier count before wasting VRF request
        (, Assignment memory assignment) = main.getTaskAndAssignment(_taskId);
        uint256 poolSize = _verifierPool.length;
        uint256 eligibleCount;
        for (uint256 i = 0; i < poolSize; i++) {
            address candidate = _verifierPool[i];
            if (candidate == assignment.agent || candidate == main.getTask(_taskId).poster || main.agentBanned(candidate)) {
                continue;
            }
            if (verifierCooldownPeriod > 0 &&
                lastVerifiedTimestamp[candidate][assignment.agent] > 0 &&
                block.timestamp < lastVerifiedTimestamp[candidate][assignment.agent] + verifierCooldownPeriod) {
                continue;
            }
            eligibleCount++;
        }

        if (eligibleCount < _requiredVerifiers) {
            // Fall back to manual verifier registration instead of wasting VRF
            emit VRFFallbackToManual(_taskId, eligibleCount, _requiredVerifiers);
            return;
        }

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

        vrfRequestToTask[requestId] = _taskId;
        emit VRFVerifierAssignmentRequested(_taskId, requestId);
    }

    /// @notice Chainlink VRF callback that assigns randomly selected verifiers to a task
    /// @param _requestId The VRF request ID being fulfilled
    /// @param _randomWords The array of random words provided by VRF
    function rawFulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) external {
        if (msg.sender != address(vrfCoordinator)) revert A34();

        uint256 taskId = vrfRequestToTask[_requestId];
        (Task memory task, Assignment memory assignment) = main.getTaskAndAssignment(taskId);
        if (task.status != TaskStatus.Delivered) revert A35();

        // C-02 fix: VRF verifier pool stakes are denominated in defaultToken.
        // If the task uses a different token, settlement would attempt to transfer
        // a token the Auction contract doesn't hold, permanently locking all funds.
        // Restrict VRF-enabled tasks to the default token only.
        if (task.token != main.defaultToken()) revert A76();

        uint256 randomWord = _randomWords[0];
        uint256 poolSize = _verifierPool.length;
        uint8 needed = task.requiredVerifiers;

        if (poolSize < needed) revert A36();

        address[] memory selected = new address[](needed);
        uint256 selectedCount = 0;

        for (uint256 i = 0; selectedCount < needed && i < poolSize * 10; i++) {
            uint256 derivedRandom = uint256(keccak256(abi.encode(randomWord, i)));
            uint256 idx = derivedRandom % poolSize;
            address candidate = _verifierPool[idx];

            if (candidate == assignment.agent || candidate == task.poster || main.agentBanned(candidate)) {
                continue;
            }

            if (verifierCooldownPeriod > 0 &&
                lastVerifiedTimestamp[candidate][assignment.agent] > 0 &&
                block.timestamp < lastVerifiedTimestamp[candidate][assignment.agent] + verifierCooldownPeriod) {
                continue;
            }

            bool alreadySelected = false;
            for (uint256 j = 0; j < selectedCount; j++) {
                if (selected[j] == candidate) { alreadySelected = true; break; }
            }
            if (alreadySelected) continue;

            selected[selectedCount] = candidate;
            selectedCount++;
        }

        if (selectedCount != needed) revert A37();

        for (uint256 i = 0; i < selectedCount; i++) {
            address verifier = selected[i];
            VerifierRegistration storage reg = verifierRegistry[verifier];

            uint256 verifierStake = assignment.stake / 5;
            if (verifierStake > reg.stake) {
                verifierStake = reg.stake;
            }

            reg.stake -= verifierStake;
            main.addAgentActiveStake(verifier, verifierStake);
            lastVerifiedTimestamp[verifier][assignment.agent] = block.timestamp;

            // Push verification to Auction contract and transfer stake tokens
            auction.pushVerification(taskId, verifier, verifierStake);
            IERC20(main.defaultToken()).safeTransfer(address(auction), verifierStake);
            emit VerifierAssigned(taskId, verifier, verifierStake);
        }

        main.setTaskStatus(taskId, TaskStatus.Verifying);
        auction.setVerifierAssignedAt(taskId, block.timestamp);

        emit VRFVerifiersAssigned(taskId, selected);
    }

    // =====================================================
    // COMPARISON MODE
    // =====================================================

    /// @notice Poster enables comparison verification mode for a task
    /// @param _taskId The ID of the task to enable comparison mode on
    function enableComparisonMode(uint256 _taskId) external {
        Task memory task = main.getTask(_taskId);
        if (msg.sender != task.poster) revert A01();
        if (!(task.status == TaskStatus.Open || task.status == TaskStatus.BidReveal || task.status == TaskStatus.Assigned)) revert A03();
        comparisonMode[_taskId] = true;
        emit ComparisonModeEnabled(_taskId);
    }

    /// @notice Verifier submits a comparison verification result for a task
    /// @param _taskId The ID of the task being verified
    /// @param _findingsHash The hash of the verifier's findings report
    /// @param _matchScore The similarity score (0-10000 basis points) between deliverable and requirements
    /// @param _missedCritical Whether the deliverable missed critical requirements
    function submitComparisonVerification(uint256 _taskId, bytes32 _findingsHash, uint16 _matchScore, bool _missedCritical)
        external nonReentrant
    {
        Task memory task = main.getTask(_taskId);
        if (task.status != TaskStatus.Verifying) revert A03();
        if (!comparisonMode[_taskId]) revert A73();
        if (_matchScore > 10000) revert A74();
        if (_findingsHash == bytes32(0)) revert A46();
        if (comparisonResults[_taskId][msg.sender].done) revert A75();

        if (!auction.isRegisteredVerifier(_taskId, msg.sender)) revert A48();

        comparisonResults[_taskId][msg.sender] = ComparisonResult(_findingsHash, _matchScore, _missedCritical, true);

        // H-02 fix: Eliminate the dead zone between CMP_REJECT and CMP_APPROVE.
        // All scores are now mapped to a vote — no silent no-vote state.
        uint8 resolution;
        VerifierVote vote;
        if (!_missedCritical && _matchScore >= CMP_APPROVE) {
            resolution = 1;
            vote = VerifierVote.Approved;
        } else {
            // Rejected: missedCritical, below CMP_REJECT, or in the former dead zone (CMP_REJECT to CMP_APPROVE-1)
            resolution = 2;
            vote = VerifierVote.Rejected;
        }

        // Always record a vote — resolution is always > 0
        auction.setVerificationVoteFromVRF(_taskId, msg.sender, vote, _findingsHash);
        auction.trySettlementFromVRF(_taskId);
        emit VerificationSubmitted(_taskId, msg.sender, vote);
        emit ComparisonSubmitted(_taskId, msg.sender, _matchScore, _missedCritical, resolution);
    }

    // =====================================================
    // VERIFIER REGISTRY
    // =====================================================

    /// @notice Verifier joins the pool by staking tokens
    /// @param _stake The amount of tokens to stake for joining the verifier pool
    function joinVerifierPool(uint256 _stake) external nonReentrant {
        if (main.paused()) revert A03();
        if (main.agentBanned(msg.sender)) revert A04();
        if (verifierRegistry[msg.sender].active) revert A11();
        if (_stake < minVerifierRegistryStake) revert A12();

        verifierRegistry[msg.sender] = VerifierRegistration({
            stake: _stake,
            active: true,
            registeredAt: block.timestamp
        });

        verifierPoolIndex[msg.sender] = _verifierPool.length;
        _verifierPool.push(msg.sender);

        emit VerifierRegistered(msg.sender, _stake);

        IERC20(main.defaultToken()).safeTransferFrom(msg.sender, address(this), _stake);
    }

    /// @notice Verifier exits the pool and reclaims their remaining stake
    function leaveVerifierPool() external nonReentrant {
        VerifierRegistration storage reg = verifierRegistry[msg.sender];
        if (!reg.active) revert A13();

        uint256 stakeReturn = reg.stake;
        reg.active = false;
        reg.stake = 0;

        uint256 idx = verifierPoolIndex[msg.sender];
        uint256 lastIdx = _verifierPool.length - 1;
        if (idx != lastIdx) {
            address lastVerifier = _verifierPool[lastIdx];
            _verifierPool[idx] = lastVerifier;
            verifierPoolIndex[lastVerifier] = idx;
        }
        _verifierPool.pop();
        delete verifierPoolIndex[msg.sender];

        IERC20(main.defaultToken()).safeTransfer(msg.sender, stakeReturn);

        emit VerifierDeregistered(msg.sender, stakeReturn);
    }

    // =====================================================
    // VERIFIER ROTATION QUERY
    // =====================================================

    /// @notice Returns the timestamp when a verifier last verified a specific agent
    /// @param verifier The address of the verifier
    /// @param agent The address of the agent
    /// @return The Unix timestamp of the last verification, or 0 if never verified
    function getLastVerifiedTimestamp(address verifier, address agent) external view returns (uint256) {
        return lastVerifiedTimestamp[verifier][agent];
    }

    /// @notice Called by the Auction contract to record a verification timestamp for cooldown tracking
    /// @param verifier The address of the verifier
    /// @param agent The address of the agent being verified
    function setLastVerifiedTimestamp(address verifier, address agent) external {
        if (msg.sender != address(auction)) revert NOT_AUCTION();
        lastVerifiedTimestamp[verifier][agent] = block.timestamp;
    }
}

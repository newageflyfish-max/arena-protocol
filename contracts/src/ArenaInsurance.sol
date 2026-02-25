// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ArenaTypes.sol";

/**
 * @title ArenaInsurance
 * @notice Agent insurance marketplace — offers, policies, claims, settlements.
 *         Reads task/assignment data from ArenaCore via IArenaCore interface.
 *
 *         Capital adequacy: coverage capital is locked at offer creation time,
 *         not at policy purchase. This prevents insurers from being simultaneously
 *         exposed on more policies than they can cover.
 */
contract ArenaInsurance is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IArenaCore public immutable core;

    // Insurance constants
    uint256 public constant INSURANCE_MAX_COVERAGE_BPS = 9000;
    uint256 public constant INSURANCE_MIN_COVERAGE_BPS = 1000;
    uint256 public constant INSURANCE_MIN_PREMIUM_BPS = 50;
    uint256 public constant INSURANCE_MAX_PREMIUM_BPS = 2000;
    uint256 public constant MAX_INSURANCE_OFFERS_PER_TASK = 10;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant INSURANCE_MIN_HISTORY = 5;
    uint256 public constant INSURANCE_DEFAULT_SLASH_RATE = 500;
    uint256 public constant INSURANCE_PROTOCOL_FEE_BPS = 100;

    // State
    uint256 public insuranceOfferCount;
    uint256 public insurancePolicyCount;
    uint256 public protocolTreasury;

    mapping(uint256 => InsuranceOffer) public insuranceOffers;
    mapping(uint256 => InsurancePolicy) public insurancePolicies;
    mapping(uint256 => uint256) public taskInsurancePolicy;
    mapping(uint256 => uint256[]) public taskInsuranceOffers;
    mapping(address => uint256) public insurerLockedCapital;
    mapping(address => uint256) public insurerActivePolicies;

    // Events
    event InsuranceOffered(uint256 indexed offerId, address indexed insurer, uint256 indexed taskId, uint256 coverageBps, uint256 premiumBps, uint256 maxCoverage, uint256 premium);
    event InsuranceOfferCancelled(uint256 indexed offerId);
    event InsurancePurchased(uint256 indexed policyId, uint256 indexed taskId, address indexed insured, address insurer, uint256 maxCoverage, uint256 premium);
    event InsuranceClaimed(uint256 indexed policyId, uint256 indexed taskId, address indexed insured, uint256 payout);
    event InsuranceSettled(uint256 indexed policyId, uint256 indexed taskId, address indexed insurer, uint256 returnedCapital);

    constructor(address _core) Ownable(msg.sender) {
        core = IArenaCore(_core);
    }

    /// @notice Calculate the fair insurance premium for an agent based on task history.
    /// @param _agent Address of the agent to evaluate.
    /// @return fairPremiumBps Premium rate in basis points, floored to the minimum.
    function calculatePremium(address _agent) public view returns (uint256 fairPremiumBps) {
        uint256 completed = core.agentTasksCompleted(_agent);
        uint256 failed = core.agentTasksFailed(_agent);
        uint256 totalTasks = completed + failed;

        if (totalTasks < INSURANCE_MIN_HISTORY) {
            fairPremiumBps = INSURANCE_DEFAULT_SLASH_RATE;
        } else {
            fairPremiumBps = (failed * BPS_DENOMINATOR) / totalTasks;
        }

        if (fairPremiumBps < INSURANCE_MIN_PREMIUM_BPS) {
            fairPremiumBps = INSURANCE_MIN_PREMIUM_BPS;
        }
    }

    /**
     * @notice Create an insurance offer. Coverage capital is locked immediately.
     *         The insurer must have approved this contract for maxCoverage of the task token.
     */
    function offerInsurance(
        uint256 _taskId,
        uint256 _coverageBps,
        uint256 _premiumBps
    ) external nonReentrant returns (uint256 offerId) {
        (address poster, address token, uint256 bounty,,,,,, uint8 reqV, TaskStatus status,) = core.tasks(_taskId);
        (address agent, uint256 stake,,,, ) = core.assignments(_taskId);

        require(status == TaskStatus.Assigned, "Arena: task not in Assigned status");
        require(agent != address(0), "Arena: no agent assigned");
        require(msg.sender != poster, "Arena: poster cannot insure");
        require(msg.sender != agent, "Arena: agent cannot self-insure");
        require(_coverageBps > 0 && _coverageBps <= INSURANCE_MAX_COVERAGE_BPS, "Arena: invalid coverage");
        require(taskInsurancePolicy[_taskId] == 0, "Arena: policy already exists");

        uint256 minPremium = calculatePremium(agent);
        require(_premiumBps >= minPremium, "Arena: premium below minimum");

        uint256 maxCoverage = (stake * _coverageBps) / BPS_DENOMINATOR;
        uint256 premium = (stake * _coverageBps * _premiumBps) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
        require(maxCoverage > 0, "Arena: zero coverage");
        require(premium > 0, "Arena: zero premium");

        insuranceOfferCount++;
        offerId = insuranceOfferCount;

        insuranceOffers[offerId] = InsuranceOffer({
            offerId: offerId,
            insurer: msg.sender,
            taskId: _taskId,
            coverageBps: _coverageBps,
            premiumBps: _premiumBps,
            maxCoverage: maxCoverage,
            premium: premium,
            status: InsuranceStatus.Open,
            createdAt: block.timestamp
        });

        taskInsuranceOffers[_taskId].push(offerId);

        // Lock coverage capital immediately
        insurerLockedCapital[msg.sender] += maxCoverage;
        IERC20(token).safeTransferFrom(msg.sender, address(this), maxCoverage);

        emit InsuranceOffered(offerId, msg.sender, _taskId, _coverageBps, _premiumBps, maxCoverage, premium);
    }

    /**
     * @notice Cancel an open insurance offer. Locked capital is returned to the insurer.
     */
    function cancelInsuranceOffer(uint256 _offerId) external nonReentrant {
        InsuranceOffer storage offer = insuranceOffers[_offerId];
        require(offer.insurer == msg.sender, "Arena: not the insurer");
        require(offer.status == InsuranceStatus.Open, "Arena: offer not open");

        offer.status = InsuranceStatus.Cancelled;

        // Return locked capital
        uint256 maxCoverage = offer.maxCoverage;
        insurerLockedCapital[msg.sender] -= maxCoverage;

        (, address token,,,,,,,,,) = core.tasks(offer.taskId);
        IERC20(token).safeTransfer(msg.sender, maxCoverage);

        emit InsuranceOfferCancelled(_offerId);
    }

    /**
     * @notice Buy an insurance policy. Coverage capital was already locked at offer time.
     *         Agent pays the premium; insurer receives premium minus protocol fee.
     */
    function buyInsurance(uint256 _taskId, uint256 _offerId) external nonReentrant {
        (address poster, address token,,,,,,,, TaskStatus status,) = core.tasks(_taskId);
        (address agent,,,,, ) = core.assignments(_taskId);
        InsuranceOffer storage offer = insuranceOffers[_offerId];

        require(status == TaskStatus.Assigned, "Arena: task not in Assigned status");
        require(msg.sender == agent, "Arena: not the assigned agent");
        require(offer.status == InsuranceStatus.Open, "Arena: offer not open");
        require(offer.taskId == _taskId, "Arena: offer not for this task");
        require(taskInsurancePolicy[_taskId] == 0, "Arena: policy already exists");

        // Cache offer values before mutating state
        uint256 offerPremium = offer.premium;
        uint256 offerMaxCoverage = offer.maxCoverage;
        address offerInsurer = offer.insurer;
        uint256 offerCoverageBps = offer.coverageBps;

        // Protocol takes fee from premium
        uint256 protocolCut = (offerPremium * INSURANCE_PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        protocolTreasury += protocolCut;

        // Create policy
        insurancePolicyCount++;
        uint256 policyId = insurancePolicyCount;

        insurancePolicies[policyId] = InsurancePolicy({
            policyId: policyId,
            taskId: _taskId,
            insurer: offerInsurer,
            insured: msg.sender,
            token: token,
            coverageBps: offerCoverageBps,
            maxCoverage: offerMaxCoverage,
            premiumPaid: offerPremium,
            claimedAmount: 0,
            status: InsuranceStatus.Active,
            activatedAt: block.timestamp
        });

        taskInsurancePolicy[_taskId] = policyId;
        insurerActivePolicies[offerInsurer]++;
        // Capital stays locked — it was already locked at offer creation
        offer.status = InsuranceStatus.Active;

        // Cancel all other open offers and return their locked capital
        uint256[] storage offerIds = taskInsuranceOffers[_taskId];
        for (uint256 i = 0; i < offerIds.length; i++) {
            uint256 oid = offerIds[i];
            if (oid != _offerId && insuranceOffers[oid].status == InsuranceStatus.Open) {
                InsuranceOffer storage otherOffer = insuranceOffers[oid];
                otherOffer.status = InsuranceStatus.Cancelled;
                // Return locked capital to the other insurer
                uint256 otherCoverage = otherOffer.maxCoverage;
                address otherInsurer = otherOffer.insurer;
                insurerLockedCapital[otherInsurer] -= otherCoverage;
                IERC20(token).safeTransfer(otherInsurer, otherCoverage);
            }
        }

        // Transfer premium from agent
        IERC20 tkn = IERC20(token);
        tkn.safeTransferFrom(msg.sender, address(this), offerPremium);

        // Insurer receives premium minus protocol fee
        uint256 insurerPremium = offerPremium - protocolCut;
        if (insurerPremium > 0) {
            tkn.safeTransfer(offerInsurer, insurerPremium);
        }

        // Coverage capital already locked in contract from offerInsurance — no additional transfer needed

        emit InsurancePurchased(policyId, _taskId, msg.sender, offerInsurer, offerMaxCoverage, offerPremium);
    }

    /// @notice Claim insurance payout after a task has been slashed.
    /// @param _taskId ID of the failed task whose policy is being claimed.
    function claimInsurance(uint256 _taskId) external nonReentrant {
        uint256 policyId = taskInsurancePolicy[_taskId];
        require(policyId > 0, "Arena: no policy for task");

        InsurancePolicy storage policy = insurancePolicies[policyId];
        require(policy.status == InsuranceStatus.Active, "Arena: policy not active");
        require(msg.sender == policy.insured, "Arena: not the insured agent");

        (,,,,,,,,,TaskStatus status,) = core.tasks(_taskId);
        require(status == TaskStatus.Failed, "Arena: task not failed");

        uint256 slashAmount = core.taskSlashAmount(_taskId);
        require(slashAmount > 0, "Arena: no slash recorded");

        uint256 payout = (slashAmount * policy.coverageBps) / BPS_DENOMINATOR;
        if (payout > policy.maxCoverage) {
            payout = policy.maxCoverage;
        }

        uint256 returnToInsurer = policy.maxCoverage - payout;

        // --- Checks-Effects-Interactions ---
        address insuredAddr = policy.insured;
        address insurerAddr = policy.insurer;
        address tokenAddr = policy.token;
        uint256 maxCov = policy.maxCoverage;

        policy.claimedAmount = payout;
        policy.status = InsuranceStatus.Claimed;
        insurerLockedCapital[insurerAddr] -= maxCov;
        insurerActivePolicies[insurerAddr]--;

        IERC20 tkn = IERC20(tokenAddr);

        if (payout > 0) {
            tkn.safeTransfer(insuredAddr, payout);
        }
        if (returnToInsurer > 0) {
            tkn.safeTransfer(insurerAddr, returnToInsurer);
        }

        emit InsuranceClaimed(policyId, _taskId, insuredAddr, payout);
    }

    /// @notice Claim insurance payout after a post-delivery bond slash.
    /// @param _taskId ID of the failed task whose bond was slashed post-delivery.
    function claimInsuranceAfterPostSlash(uint256 _taskId) external nonReentrant {
        uint256 policyId = taskInsurancePolicy[_taskId];
        require(policyId > 0, "Arena: no policy for task");

        InsurancePolicy storage policy = insurancePolicies[policyId];
        require(policy.status == InsuranceStatus.Active, "Arena: policy not active");
        require(msg.sender == policy.insured, "Arena: not the insured agent");

        (,,,,,,,,,TaskStatus status,) = core.tasks(_taskId);
        require(status == TaskStatus.Failed, "Arena: task not failed");
        require(core.slashBonds(_taskId) == 0, "Arena: bond not slashed yet");

        uint256 bondSlash = core.taskBondSlashAmount(_taskId);
        require(bondSlash > 0, "Arena: no bond slash recorded");

        uint256 payout = (bondSlash * policy.coverageBps) / BPS_DENOMINATOR;
        if (payout > policy.maxCoverage) {
            payout = policy.maxCoverage;
        }

        uint256 returnToInsurer = policy.maxCoverage - payout;

        // --- Checks-Effects-Interactions ---
        address insuredAddr = policy.insured;
        address insurerAddr = policy.insurer;
        address tokenAddr = policy.token;
        uint256 maxCov = policy.maxCoverage;

        policy.claimedAmount = payout;
        policy.status = InsuranceStatus.Claimed;
        insurerLockedCapital[insurerAddr] -= maxCov;
        insurerActivePolicies[insurerAddr]--;

        IERC20 tkn = IERC20(tokenAddr);

        if (payout > 0) {
            tkn.safeTransfer(insuredAddr, payout);
        }
        if (returnToInsurer > 0) {
            tkn.safeTransfer(insurerAddr, returnToInsurer);
        }

        emit InsuranceClaimed(policyId, _taskId, insuredAddr, payout);
    }

    /// @notice Settle an active policy after the task completes and the slash window expires.
    /// @param _taskId ID of the completed task whose policy is being settled.
    function settleInsurance(uint256 _taskId) external nonReentrant {
        uint256 policyId = taskInsurancePolicy[_taskId];
        require(policyId > 0, "Arena: no policy for task");

        InsurancePolicy storage policy = insurancePolicies[policyId];
        require(policy.status == InsuranceStatus.Active, "Arena: policy not active");

        (,,, uint256 deadline, uint256 slashWindow,,,,, TaskStatus status,) = core.tasks(_taskId);
        (, ,, , uint256 deliveredAt, ) = core.assignments(_taskId);
        require(status == TaskStatus.Completed, "Arena: task not completed");
        require(block.timestamp > deliveredAt + slashWindow, "Arena: slash window not expired");

        // --- Checks-Effects-Interactions ---
        address insurerAddr = policy.insurer;
        address tokenAddr = policy.token;
        uint256 maxCov = policy.maxCoverage;

        policy.status = InsuranceStatus.Settled;
        insurerLockedCapital[insurerAddr] -= maxCov;
        insurerActivePolicies[insurerAddr]--;

        IERC20(tokenAddr).safeTransfer(insurerAddr, maxCov);

        emit InsuranceSettled(policyId, _taskId, insurerAddr, maxCov);
    }

    // View functions

    /// @notice Return the full InsuranceOffer struct for a given offer.
    /// @param _offerId ID of the insurance offer.
    /// @return The InsuranceOffer struct.
    function getInsuranceOffer(uint256 _offerId) external view returns (InsuranceOffer memory) {
        return insuranceOffers[_offerId];
    }

    /// @notice Return the full InsurancePolicy struct for a given policy.
    /// @param _policyId ID of the insurance policy.
    /// @return The InsurancePolicy struct.
    function getInsurancePolicy(uint256 _policyId) external view returns (InsurancePolicy memory) {
        return insurancePolicies[_policyId];
    }

    /// @notice Return the array of insurance offer IDs associated with a task.
    /// @param _taskId ID of the task.
    /// @return Array of offer IDs.
    function getTaskInsuranceOffers(uint256 _taskId) external view returns (uint256[] memory) {
        return taskInsuranceOffers[_taskId];
    }

    /// @notice Return the policy ID for a given task, or zero if none exists.
    /// @param _taskId ID of the task.
    /// @return The policy ID bound to the task.
    function getTaskInsurancePolicy(uint256 _taskId) external view returns (uint256) {
        return taskInsurancePolicy[_taskId];
    }

    /**
     * @notice Get insurer's capital status.
     * @return locked Total capital locked in offers and active policies
     * @return activePolicies Number of active insurance policies
     */
    function getInsurerCapitalStatus(address _insurer) external view returns (
        uint256 locked,
        uint256 activePolicies
    ) {
        locked = insurerLockedCapital[_insurer];
        activePolicies = insurerActivePolicies[_insurer];
    }

    /// @notice Withdraw accumulated protocol fees to a specified address (owner only).
    /// @param _to Recipient address for the withdrawn fees.
    function withdrawProtocolFees(address _to) external onlyOwner {
        uint256 amount = protocolTreasury;
        protocolTreasury = 0;
        IERC20(core.defaultToken()).safeTransfer(_to, amount);
    }
}

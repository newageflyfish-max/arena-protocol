// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArenaTypes
 * @notice Shared types, enums, structs, and interfaces for The Arena protocol.
 * @dev Constants are defined locally in each contract that needs them.
 */

enum TaskStatus { Open, BidReveal, Assigned, Delivered, Verifying, Completed, Failed, Disputed, Cancelled }
enum SlashSeverity { Late, Minor, Material, Execution, Critical }
enum VerifierVote { Pending, Approved, Rejected }
enum ArbitratorVote { Pending, AgentWins, PosterWins }
enum ArbitrationStatus { WaitingForVRF, StakingOpen, VotingOpen, Resolved, Expired }
enum DisputeType { Task, Checkpoint }
enum InsuranceStatus { Open, Active, Claimed, Settled, Cancelled }
enum SyndicateStatus { Active, Dissolved }
enum CheckpointStatus { Pending, Submitted, Verifying, Passed, Failed, Missed, Disputed }
enum ContinuousContractStatus { Open, BidReveal, Active, Terminated, Completed, Cancelled }

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

struct SealedBid {
    bytes32 commitHash;
    bytes32 criteriaAckHash;
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

struct VerifierRegistration {
    uint256 stake;
    bool active;
    uint256 registeredAt;
}

struct ContinuousContract {
    address poster;
    address token;
    uint256 totalBounty;
    uint256 paymentPerCheckpoint;
    uint256 duration;
    uint256 checkpointInterval;
    uint256 createdAt;
    uint256 bidDeadline;
    uint256 revealDeadline;
    uint8 requiredVerifiers;
    uint8 maxFailures;
    uint8 totalCheckpoints;
    uint8 passedCheckpoints;
    uint8 failedCheckpoints;
    ContinuousContractStatus status;
    bytes32 criteriaHash;
    string contractType;
}

struct ContinuousAssignment {
    address agent;
    uint256 stake;
    uint256 price;
    uint256 startedAt;
}

struct Checkpoint {
    uint256 dueAt;
    uint256 submittedAt;
    bytes32 outputHash;
    uint8 votesFor;
    uint8 votesAgainst;
    CheckpointStatus status;
    bytes32 reportHash;
    uint256 payoutAmount;
    uint256 slashAmount;
}

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

struct InsuranceOffer {
    uint256 offerId;
    address insurer;
    uint256 taskId;
    uint256 coverageBps;
    uint256 premiumBps;
    uint256 maxCoverage;
    uint256 premium;
    InsuranceStatus status;
    uint256 createdAt;
}

struct InsurancePolicy {
    uint256 policyId;
    uint256 taskId;
    address insurer;
    address insured;
    address token;
    uint256 coverageBps;
    uint256 maxCoverage;
    uint256 premiumPaid;
    uint256 claimedAmount;
    InsuranceStatus status;
    uint256 activatedAt;
}

struct Syndicate {
    uint256 syndicateId;
    string name;
    address manager;
    address token;
    uint256 totalStake;
    uint256 memberCount;
    SyndicateStatus status;
    uint256 createdAt;
}

struct SyndicateMember {
    address member;
    uint256 contribution;
    uint256 joinedAt;
}

struct DelegationPool {
    address agent;
    address token;
    uint256 totalDelegated;
    uint256 delegatorCount;
    uint256 revenueShareBps;
    bool acceptingDelegations;
    uint256 lockedCapital;
}

struct TaskDelegation {
    address agent;
    uint256 ownStake;
    uint256 delegatedStake;
    uint256 revenueShareBps;
    uint256 poolSnapshotTotal;
    uint256 escrowPayout;
    uint256 escrowStakeReturn;
    bool settled;
}

interface IArenaCore {
    function tasks(uint256) external view returns (
        address poster, address token, uint256 bounty, uint256 deadline,
        uint256 slashWindow, uint256 createdAt, uint256 bidDeadline,
        uint256 revealDeadline, uint8 requiredVerifiers, TaskStatus status,
        bytes32 criteriaHash
    );
    function assignments(uint256) external view returns (
        address agent, uint256 stake, uint256 price, uint256 assignedAt,
        uint256 deliveredAt, bytes32 outputHash
    );
    function agentReputation(address) external view returns (uint256);
    function agentTasksCompleted(address) external view returns (uint256);
    function agentTasksFailed(address) external view returns (uint256);
    function agentActiveStake(address) external view returns (uint256);
    function agentBanned(address) external view returns (bool);
    function taskCount() external view returns (uint256);
    function defaultToken() external view returns (address);
    function getTask(uint256) external view returns (Task memory);
    function getAssignment(uint256) external view returns (Assignment memory);
    function taskSlashAmount(uint256) external view returns (uint256);
    function taskBondSlashAmount(uint256) external view returns (uint256);
    function slashBonds(uint256) external view returns (uint256);
    function protocolTreasury() external view returns (uint256);
    function bids(uint256, address) external view returns (
        bytes32 commitHash, bytes32 criteriaAckHash, bool revealed,
        address agent, uint256 stake, uint256 price, uint256 eta
    );
    function taskBidders(uint256, uint256) external view returns (address);
    function agentActiveBids(address) external view returns (uint256);
    function agentSlashCooldownEnd(address) external view returns (uint256);
}

interface IArenaReputation {
    function emitMetadataUpdate(address agent) external;
    function updateSpecialization(address agent, string calldata taskType) external;
    function onTaskSettled(address agent, bool completed, uint256 slashSeverity, uint256 approvals, uint256 rejections) external;
    function recordPosterOutcome(address poster, uint8 outcome) external;
}

/**
 * @title IArenaCoreMain
 * @notice Interface for ArenaCoreMain — used by ArenaCoreAuction for cross-contract calls.
 */
interface IArenaCoreMain {
    // ---- View functions (existing public state) ----
    function defaultToken() external view returns (address);
    function taskCount() external view returns (uint256);
    function getTask(uint256 taskId) external view returns (Task memory);
    function getAssignment(uint256 taskId) external view returns (Assignment memory);
    function agentReputation(address agent) external view returns (uint256);
    function agentTasksCompleted(address agent) external view returns (uint256);
    function agentTasksFailed(address agent) external view returns (uint256);
    function agentActiveStake(address agent) external view returns (uint256);
    function agentBanned(address agent) external view returns (bool);
    function agentActiveBids(address agent) external view returns (uint256);
    function agentSlashCooldownEnd(address agent) external view returns (uint256);
    function protocolTreasury(address token) external view returns (uint256);
    function slashBonds(uint256 taskId) external view returns (uint256);
    function taskSlashAmount(uint256 taskId) external view returns (uint256);
    function taskBondSlashAmount(uint256 taskId) external view returns (uint256);
    function tokenWhitelist(address token) external view returns (bool);
    function tokenHasMevRisk(address token) external view returns (bool);
    function posterActiveTasks(address poster) external view returns (uint256);
    function arenaCompliance() external view returns (address);
    function arenaOutcomes() external view returns (address);
    function taskTypeSchemaHash(bytes32 typeKey) external view returns (bytes32);
    function paused() external view returns (bool);
    function owner() external view returns (address);

    // ---- Combined getters ----
    function getTaskAndAssignment(uint256 taskId) external view returns (Task memory, Assignment memory);

    // ---- Authorized setters (onlyAuction) ----
    function setTaskStatus(uint256 taskId, TaskStatus newStatus) external;
    function setAssignment(uint256 taskId, address agent, uint256 stake, uint256 price) external;
    function setAssignmentDelivery(uint256 taskId, uint256 deliveredAt, bytes32 outputHash) external;
    function incrementAgentReputation(address agent, uint256 amount) external;
    function decrementAgentReputation(address agent, uint256 amount) external;
    function incrementAgentCompleted(address agent) external;
    function incrementAgentFailed(address agent) external;
    function decrementAgentCompleted(address agent) external;
    function setAgentBanned(address agent, bool banned) external;
    function addAgentActiveStake(address agent, uint256 amount) external;
    function subAgentActiveStake(address agent, uint256 amount) external;
    function addAgentActiveBids(address agent, uint256 amount) external;
    function subAgentActiveBids(address agent, uint256 amount) external;
    function setAgentSlashCooldownEnd(address agent, uint256 timestamp) external;
    function addProtocolTreasury(address token, uint256 amount) external;
    function setSlashBond(uint256 taskId, uint256 amount) external;
    function setTaskSlashAmount(uint256 taskId, uint256 amount) external;
    function setTaskBondSlashAmount(uint256 taskId, uint256 amount) external;
    function decrementPosterActiveTasks(address poster) external;
    function transferFromEscrow(address token, address to, uint256 amount) external;

    // ---- Batch setter (onlyAuction) ----
    function batchSettleState(
        uint256 taskId, TaskStatus status, address poster, address agent,
        uint256 stakeToSub, uint256 reputationDelta, bool reputationUp,
        bool incrementCompleted, bool incrementFailed, bool banned, uint256 cooldownEnd,
        address token, uint256 protocolFeeAmount, uint256 slashBondAmount
    ) external;
}

/**
 * @title IArenaCoreAuction
 * @notice Interface for ArenaCoreAuction — used by ArenaCoreMain for passthroughs.
 */
interface IArenaCoreAuction {
    function refundBidsOnCancel(uint256 taskId, address token) external;
    function verifierPoolLength() external view returns (uint256);
    function verifierPool(uint256 index) external view returns (address);
    function bids(uint256 taskId, address agent) external view returns (
        bytes32 commitHash, bytes32 criteriaAckHash, bool revealed,
        address bidAgent, uint256 stake, uint256 price, uint256 eta
    );
    function taskBidders(uint256 taskId, uint256 index) external view returns (address);
    function verifierRegistry(address verifier) external view returns (uint256 stake, bool active, uint256 registeredAt);
    function verifications(uint256 taskId, uint256 index) external view returns (
        address verifier, uint256 stake, VerifierVote vote, bytes32 reportHash
    );
    function taskVerifiers(uint256 taskId, uint256 index) external view returns (address);
    function transferToMain(address token, uint256 amount) external;
}

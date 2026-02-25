/**
 * The Arena SDK — Contract ABIs
 *
 * Typed ABI fragments for all Arena protocol contracts.
 * Each ABI includes only the external/public functions and events
 * needed by the SDK — not the full compiled ABI.
 *
 * Core contracts are split into three:
 * - ArenaCoreMain: task creation, escrow, shared state, admin
 * - ArenaCoreAuction: sealed-bid auctions, delivery, verification, settlement, slashing
 * - ArenaCoreVRF: verifier pool management, random verifier selection
 */

// ─────────────────────────────────────────────
// ERC-20 (USDC / MockUSDC)
// ─────────────────────────────────────────────

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
] as const;

// ─────────────────────────────────────────────
// ArenaCoreMain — Task creation, escrow, state
// ─────────────────────────────────────────────

export const ARENA_MAIN_ABI = [
  // ── Task Management ──
  'function createTask(uint256 _bounty, uint256 _deadline, uint256 _slashWindow, uint256 _bidDuration, uint256 _revealDuration, uint8 _requiredVerifiers, bytes32 _criteriaHash, string _taskType, address _token) external returns (uint256 taskId)',
  'function cancelTask(uint256 _taskId) external',

  // ── Admin ──
  'function whitelistToken(address _token, bool _isStablecoin, bool _mevAck) external',
  'function removeToken(address _token) external',
  'function pause() external',
  'function unpause() external',
  'function unbanAgent(address _agent) external',
  'function setMinBounty(uint256 _min) external',
  'function setTreasuryAddress(address _t) external',
  'function withdrawProtocolFees(address _token, address _to) external',
  'function setMaxPosterActiveTasks(uint256 _max) external',

  // ── View Functions ──
  'function getTask(uint256 _taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 _taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function taskCount() view returns (uint256)',
  'function protocolTreasury(address token) view returns (uint256)',
  'function agentReputation(address agent) view returns (uint256)',
  'function agentTasksCompleted(address agent) view returns (uint256)',
  'function agentTasksFailed(address agent) view returns (uint256)',
  'function agentActiveStake(address agent) view returns (uint256)',
  'function agentBanned(address agent) view returns (bool)',
  'function minBounty() view returns (uint256)',
  'function defaultToken() view returns (address)',

  // ── Events ──
  'event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)',
  'event TaskCancelled(uint256 indexed taskId)',
  'event TokenWhitelisted(address indexed token, bool mevRisk)',
  'event TokenRemoved(address indexed token)',
] as const;

// ─────────────────────────────────────────────
// ArenaCoreAuction — Bidding, settlement, slashing
// ─────────────────────────────────────────────

export const ARENA_AUCTION_ABI = [
  // ── Bidding ──
  'function commitBid(uint256 _taskId, bytes32 _commitHash, bytes32 _criteriaAckHash) external',
  'function revealBid(uint256 _taskId, uint256 _stake, uint256 _price, uint256 _eta, bytes32 _salt) external',
  'function resolveAuction(uint256 _taskId) external',

  // ── Execution ──
  'function deliverTask(uint256 _taskId, bytes32 _outputHash) external',
  'function deliverTask(uint256 _taskId, bytes32 _outputHash, bytes32 _schemaHash) external',

  // ── Verification ──
  'function registerVerifier(uint256 _taskId, uint256 _stake) external',
  'function submitVerification(uint256 _taskId, uint8 _vote, bytes32 _reportHash) external',
  'function enforceVerifierTimeout(uint256 _taskId) external',
  'function abandonVerification(uint256 _taskId) external',

  // ── Slashing ──
  'function enforceDeadline(uint256 _taskId) external',
  'function postCompletionSlash(uint256 _taskId, uint8 _severity) external',
  'function claimSlashBond(uint256 _taskId) external',

  // ── Comparison Mode ──
  'function enableComparisonMode(uint256 _taskId) external',
  'function submitComparisonVerification(uint256 _taskId, bytes32 _findingsHash, uint16 _matchScore, bool _missedCritical) external',

  // ── View Functions ──
  'function getBid(uint256 _taskId, address _bidder) view returns (tuple(bytes32 commitHash, bool revealed, address agent, uint256 stake, uint256 price, uint256 eta, bytes32 criteriaAckHash))',
  'function getTaskBidders(uint256 _taskId) view returns (address[])',

  // ── Events ──
  'event BidCommitted(uint256 indexed taskId, address indexed agent, bytes32 commitHash, bytes32 criteriaAckHash)',
  'event BidRevealed(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price, uint256 eta)',
  'event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price)',
  'event TaskDelivered(uint256 indexed taskId, address indexed agent, bytes32 outputHash)',
  'event VerifierAssigned(uint256 indexed taskId, address indexed verifier, uint256 stake)',
  'event VerificationSubmitted(uint256 indexed taskId, address indexed verifier, uint8 vote)',
  'event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)',
  'event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)',
  'event VerifierSlashed(uint256 indexed taskId, address indexed verifier, uint256 amount)',
  'event TaskDisputed(uint256 indexed taskId, address indexed disputant)',
  'event ProtocolFeeCollected(uint256 indexed taskId, uint256 amount)',
  'event SlashBondClaimed(uint256 indexed taskId, address indexed agent, uint256 amount)',
  'event SlashBondForfeited(uint256 indexed taskId, address indexed agent, uint256 slashedAmount, uint8 severity)',
] as const;

// ─────────────────────────────────────────────
// ArenaCoreVRF — Verifier pool, random selection
// ─────────────────────────────────────────────

export const ARENA_VRF_ABI = [
  // ── Verifier Pool ──
  'function joinVerifierPool(uint256 _stake) external',
  'function leaveVerifierPool() external',
  'function setVerifierCooldown(uint256 _cooldown) external',

  // ── VRF Config ──
  'function configureVRF(uint64 _subscriptionId, bytes32 _keyHash, uint32 _callbackGasLimit) external',
  'function disableVRF() external',

  // ── View Functions ──
  'function verifierPoolLength() view returns (uint256)',
  'function verifierPool(uint256 index) view returns (address)',
  'function verifierRegistry(address verifier) view returns (uint256 stake, uint256 joinedAt, bool active)',
  'function verifierCooldownPeriod() view returns (uint256)',

  // ── Events ──
  'event VerifierJoined(address indexed verifier, uint256 stake)',
  'event VerifierLeft(address indexed verifier, uint256 stakeReturned)',
] as const;

// ─────────────────────────────────────────────
// Legacy alias — maps to combined ABI for backwards compat
// ─────────────────────────────────────────────

/** @deprecated Use ARENA_MAIN_ABI, ARENA_AUCTION_ABI, ARENA_VRF_ABI instead */
export const ARENA_CORE_ABI = [...ARENA_MAIN_ABI, ...ARENA_AUCTION_ABI, ...ARENA_VRF_ABI] as const;

// ─────────────────────────────────────────────
// ArenaArbitration
// ─────────────────────────────────────────────

export const ARENA_ARBITRATION_ABI = [
  'function raiseDispute(uint256 _taskId) external',
  'function raiseCheckpointDispute(uint256 _contractId, uint8 _checkpointIndex) external',
  'function stakeAsArbitrator(uint256 _disputeId) external',
  'function submitArbitrationVote(uint256 _disputeId, uint8 _vote) external',
  'function enforceArbitrationStakingTimeout(uint256 _disputeId) external',
  'function enforceArbitrationVotingTimeout(uint256 _disputeId) external',
  'function getArbitration(uint256 _disputeId) view returns (tuple(uint256 disputeId, uint8 disputeType, uint256 taskOrContractId, uint8 checkpointIndex, address disputant, address token, uint256 bountyAmount, uint256 disputeFee, uint256 createdAt, uint256 stakingDeadline, uint256 votingDeadline, uint8 totalArbitrators, uint8 stakedArbitrators, uint8 votesSubmitted, uint8 votesForAgent, uint8 votesForPoster, uint8 status))',
  'function getArbitratorInfo(uint256 _disputeId, uint8 _index) view returns (tuple(address arbitrator, uint256 stake, uint8 vote, bool staked))',
  'function getArbitratorList(uint256 _disputeId) view returns (address[])',
  'function getTaskDisputeId(uint256 _taskId) view returns (uint256)',
  'function getCheckpointDisputeId(uint256 _contractId, uint8 _checkpointIndex) view returns (uint256)',

  'event DisputeRaised(uint256 indexed disputeId, uint8 disputeType, uint256 indexed taskOrContractId, address indexed disputant, uint256 disputeFee)',
  'event ArbitratorsSelected(uint256 indexed disputeId, address[] arbitratorsAddresses)',
  'event ArbitratorStaked(uint256 indexed disputeId, address indexed arbitrator, uint256 stake)',
  'event ArbitratorVoteSubmitted(uint256 indexed disputeId, address indexed arbitrator, uint8 vote)',
  'event ArbitratorSlashed(uint256 indexed disputeId, address indexed arbitrator, uint256 amount)',
  'event DisputeResolved(uint256 indexed disputeId, bool inFavorOfAgent, uint8 votesForAgent, uint8 votesForPoster)',
  'event DisputeExpired(uint256 indexed disputeId, string reason)',
] as const;

// ─────────────────────────────────────────────
// ArenaReputation
// ─────────────────────────────────────────────

export const ARENA_REPUTATION_ABI = [
  'function mintReputationNFT(address _agent) external returns (uint256 tokenId)',
  'function burnReputationNFT(address _agent) external',
  'function emitMetadataUpdate(address _agent) external',
  'function updateSpecialization(address _agent, string _taskType) external',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',

  'event ReputationNFTMinted(address indexed agent, uint256 indexed tokenId)',
  'event ReputationNFTBurned(address indexed agent, uint256 indexed tokenId)',
  'event MetadataUpdate(uint256 _tokenId)',
] as const;

// ─────────────────────────────────────────────
// ArenaInsurance
// ─────────────────────────────────────────────

export const ARENA_INSURANCE_ABI = [
  'function calculatePremium(address _agent) view returns (uint256 fairPremiumBps)',
  'function offerInsurance(uint256 _taskId, uint256 _coverageBps, uint256 _premiumBps) external returns (uint256 offerId)',
  'function cancelInsuranceOffer(uint256 _offerId) external',
  'function buyInsurance(uint256 _taskId, uint256 _offerId) external',
  'function claimInsurance(uint256 _taskId) external',
  'function claimInsuranceAfterPostSlash(uint256 _taskId) external',
  'function settleInsurance(uint256 _taskId) external',
  'function getInsuranceOffer(uint256 _offerId) view returns (tuple(uint256 offerId, address insurer, uint256 taskId, uint256 coverageBps, uint256 premiumBps, uint256 maxCoverage, uint256 premium, uint8 status, uint256 createdAt))',
  'function getInsurancePolicy(uint256 _policyId) view returns (tuple(uint256 policyId, uint256 taskId, address insurer, address insured, address token, uint256 coverageBps, uint256 maxCoverage, uint256 premiumPaid, uint256 claimedAmount, uint8 status, uint256 activatedAt))',
  'function getTaskInsuranceOffers(uint256 _taskId) view returns (uint256[])',
  'function getTaskInsurancePolicy(uint256 _taskId) view returns (uint256)',
  'function getInsurerCapitalStatus(address _insurer) view returns (uint256 locked, uint256 activePolicies)',
  'function withdrawProtocolFees(address _to) external',

  'event InsuranceOffered(uint256 indexed offerId, address indexed insurer, uint256 indexed taskId, uint256 coverageBps, uint256 premiumBps, uint256 maxCoverage, uint256 premium)',
  'event InsuranceOfferCancelled(uint256 indexed offerId)',
  'event InsurancePurchased(uint256 indexed policyId, uint256 indexed taskId, address indexed insured, address insurer, uint256 maxCoverage, uint256 premium)',
  'event InsuranceClaimed(uint256 indexed policyId, uint256 indexed taskId, address indexed insured, uint256 payout)',
  'event InsuranceSettled(uint256 indexed policyId, uint256 indexed taskId, address indexed insurer, uint256 returnedCapital)',
] as const;

// ─────────────────────────────────────────────
// ArenaOutcomes
// ─────────────────────────────────────────────

export const ARENA_OUTCOMES_ABI = [
  'function registerRiskCriteria(uint256 _taskId, uint16 _lossThresholdBps, uint16 _slashScoreThreshold, uint256 _validationWindow) external',
  'function registerCreditCriteria(uint256 _taskId, uint16 _defaultProbThreshold, uint256 _defaultWindow) external',
  'function reportRiskOutcome(uint256 _taskId, uint16 _actualLossBps, uint16 _agentScoreBps) external',
  'function reportCreditDefault(uint256 _taskId, uint16 _agentProbBps) external',
  'function challengeReport(uint256 _taskId) external',
  'function finalizeReport(uint256 _taskId) external',
  'function isRiskRegistered(uint256 _taskId) view returns (bool)',
  'function isCreditRegistered(uint256 _taskId) view returns (bool)',

  'event RiskCriteriaRegistered(uint256 indexed taskId, uint16 lossThresholdBps, uint16 slashScoreThreshold, uint256 validationWindow)',
  'event CreditCriteriaRegistered(uint256 indexed taskId, uint16 defaultProbThreshold, uint256 defaultWindow)',
  'event OutcomeReported(uint256 indexed taskId, address indexed reporter, uint256 bond, uint8 severity)',
  'event OutcomeFinalized(uint256 indexed taskId, address indexed reporter)',
  'event OutcomeChallenged(uint256 indexed taskId, address indexed agent, uint256 bondForfeited)',
] as const;

// ─────────────────────────────────────────────
// ArenaContinuous (ArenaRecurring)
// ─────────────────────────────────────────────

export const ARENA_CONTINUOUS_ABI = [
  'function createContinuousContract(address _token, uint256 _totalBounty, uint256 _duration, uint256 _checkpointInterval, uint256 _bidDuration, uint256 _revealDuration, uint8 _requiredVerifiers, uint8 _maxFailures, bytes32 _criteriaHash, string _contractType) external returns (uint256 contractId)',
  'function cancelContinuousContract(uint256 _contractId) external',
  'function commitContinuousBid(uint256 _contractId, bytes32 _commitHash) external',
  'function revealContinuousBid(uint256 _contractId, uint256 _stake, uint256 _price, uint256 _eta, bytes32 _salt) external',
  'function resolveContinuousAuction(uint256 _contractId) external',
  'function submitCheckpoint(uint256 _contractId, uint8 _checkpointIndex, bytes32 _outputHash) external',
  'function markCheckpointMissed(uint256 _contractId, uint8 _checkpointIndex) external',
  'function registerCheckpointVerifier(uint256 _contractId, uint8 _checkpointIndex, uint256 _stake) external',
  'function submitCheckpointVerification(uint256 _contractId, uint8 _checkpointIndex, uint8 _vote, bytes32 _reportHash) external',
  'function getContinuousContract(uint256 _contractId) view returns (tuple(address poster, address token, uint256 totalBounty, uint256 paymentPerCheckpoint, uint256 duration, uint256 checkpointInterval, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 totalCheckpoints, uint8 completedCheckpoints, uint8 passedCheckpoints, uint8 failedCheckpoints, uint8 consecutivePasses, uint8 maxFailures, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string contractType))',
  'function getContinuousAssignment(uint256 _contractId) view returns (tuple(address agent, uint256 stake, uint256 currentStake, uint256 price, uint256 startedAt, uint256 totalPaid, uint256 totalSlashed))',
  'function getCheckpoint(uint256 _contractId, uint8 _checkpointIndex) view returns (tuple(uint256 dueBy, uint256 submittedAt, uint256 evaluatedAt, bytes32 outputHash, uint8 status, uint256 payoutAmount, uint256 slashAmount))',
  'function getCheckpointVerifications(uint256 _contractId, uint8 _checkpointIndex) view returns (tuple(address verifier, uint256 stake, uint8 vote, bytes32 reportHash)[])',
  'function getContinuousBidders(uint256 _contractId) view returns (address[])',
  'function getContinuousBid(uint256 _contractId, address _bidder) view returns (tuple(bytes32 commitHash, bool revealed, address agent, uint256 stake, uint256 price, uint256 eta))',

  'event ContinuousContractCreated(uint256 indexed contractId, address indexed poster, address token, uint256 totalBounty, uint256 duration, uint256 checkpointInterval, uint8 totalCheckpoints)',
  'event ContinuousBidCommitted(uint256 indexed contractId, address indexed bidder, bytes32 commitHash)',
  'event ContinuousBidRevealed(uint256 indexed contractId, address indexed bidder, uint256 stake, uint256 price, uint256 eta)',
  'event ContinuousAgentAssigned(uint256 indexed contractId, address indexed agent, uint256 stake, uint256 price)',
  'event CheckpointSubmitted(uint256 indexed contractId, uint8 indexed checkpointIndex, address indexed agent, bytes32 outputHash)',
  'event CheckpointEvaluated(uint256 indexed contractId, uint8 indexed checkpointIndex, uint8 status, uint256 payoutAmount, uint256 slashAmount)',
  'event CheckpointMissed(uint256 indexed contractId, uint8 indexed checkpointIndex)',
  'event ContinuousContractTerminated(uint256 indexed contractId, string reason)',
  'event ContinuousContractCompleted(uint256 indexed contractId, uint256 totalPaid, uint256 totalSlashed, uint256 stakeReturned)',
] as const;

// ─────────────────────────────────────────────
// ArenaSyndicates
// ─────────────────────────────────────────────

export const ARENA_SYNDICATES_ABI = [
  'function createSyndicate(string _name, address _token, uint256 _initialContribution) external returns (uint256 syndicateId)',
  'function joinSyndicate(uint256 _syndicateId, uint256 _contribution) external',
  'function leaveSyndicate(uint256 _syndicateId) external',
  'function voteDissolution(uint256 _syndicateId) external',
  'function revokeDissolutionVote(uint256 _syndicateId) external',
  'function dissolveSyndicate(uint256 _syndicateId) external',
  'function distributeSyndicateRewards(uint256 _taskId) external',
  'function distributeSyndicateLosses(uint256 _taskId) external',
  'function getSyndicate(uint256 _syndicateId) view returns (uint256 syndicateId, string name, address manager, address token, uint256 totalStake, uint256 memberCount, uint8 status, uint256 createdAt)',
  'function getSyndicateMember(uint256 _syndicateId, address _member) view returns (tuple(address member, uint256 contribution, uint256 joinedAt))',
  'function getSyndicateMembers(uint256 _syndicateId) view returns (address[])',
  'function getTaskSyndicate(uint256 _taskId) view returns (uint256)',
  'function getSyndicateActiveTasks(uint256 _syndicateId) view returns (uint256)',
  'function getDissolutionVoteWeight(uint256 _syndicateId) view returns (uint256)',

  'event SyndicateCreated(uint256 indexed syndicateId, address indexed manager, string name)',
  'event SyndicateJoined(uint256 indexed syndicateId, address indexed member, uint256 contribution)',
  'event SyndicateLeft(uint256 indexed syndicateId, address indexed member, uint256 returned)',
  'event SyndicateDissolved(uint256 indexed syndicateId)',
  'event SyndicateRewardsDistributed(uint256 indexed syndicateId, uint256 indexed taskId, uint256 totalPayout)',
  'event SyndicateLossesDistributed(uint256 indexed syndicateId, uint256 indexed taskId, uint256 totalLoss)',
] as const;

// ─────────────────────────────────────────────
// ArenaDelegation
// ─────────────────────────────────────────────

export const ARENA_DELEGATION_ABI = [
  'function setDelegatorRevenueShare(uint256 _revenueShareBps, address _token) external',
  'function delegateStake(address _agent, uint256 _amount) external',
  'function withdrawDelegation(address _agent, uint256 _amount) external',
  'function claimDelegatorRewards(uint256 _taskId) external',
  'function getDelegatorInfo(address _agent, address _delegator) view returns (uint256 contribution, uint256 poolTotal, uint256 revenueShareBps, uint256 lockedCapital)',
  'function getAgentDelegations(address _agent) view returns (address[])',
  'function getAgentDelegationPool(address _agent) view returns (address agent, address token, uint256 totalDelegated, uint256 delegatorCount, uint256 revenueShareBps, bool acceptingDelegations, uint256 lockedCapital)',
  'function getTaskDelegation(uint256 _taskId) view returns (tuple(address agent, uint256 ownStake, uint256 delegatedStake, uint256 revenueShareBps, uint256 poolSnapshotTotal, uint256 escrowPayout, uint256 escrowStakeReturn, bool settled))',

  'event DelegationPoolOpened(address indexed agent, address indexed token, uint256 revenueShareBps)',
  'event StakeDelegated(address indexed agent, address indexed delegator, uint256 amount)',
  'event DelegationWithdrawn(address indexed agent, address indexed delegator, uint256 amount)',
  'event DelegatorRewardsClaimed(uint256 indexed taskId, address indexed delegator, address indexed agent, uint256 payout, uint256 stakeReturn)',
  'event DelegatorLossesClaimed(uint256 indexed taskId, address indexed delegator, address indexed agent, uint256 returned, uint256 loss)',
] as const;

// ─────────────────────────────────────────────
// ArenaCompliance
// ─────────────────────────────────────────────

export const ARENA_COMPLIANCE_ABI = [
  'function reportTask(uint256 _taskId, uint8 _reason) external',
  'function suspendTask(uint256 _taskId) external',
  'function resumeTask(uint256 _taskId) external',
  'function terminateTask(uint256 _taskId) external',
  'function acceptTermsOfService(bytes32 _tosHash) external',
  'function hasAcceptedTos(address _user) view returns (bool)',
  'function hasAcceptedCurrentTos(address _user) view returns (bool)',
  'function isPosterBlacklisted(address _poster) view returns (bool)',
  'function isSanctioned(address _addr) view returns (bool)',
  'function isTaskSuspended(uint256 _taskId) view returns (bool)',
  'function getReportCount(uint256 _taskId) view returns (uint256)',
  'function getReport(uint256 _taskId, uint256 _index) view returns (address reporter, uint8 reason, uint256 timestamp)',

  'event TaskReported(uint256 indexed taskId, address indexed reporter, uint8 reason)',
  'event TaskFlagged(uint256 indexed taskId, uint256 reportCount)',
  'event TaskSuspended(uint256 indexed taskId, address indexed suspendedBy)',
  'event TaskResumed(uint256 indexed taskId, address indexed resumedBy)',
  'event TaskTerminated(uint256 indexed taskId, address indexed poster)',
  'event PosterBlacklisted(address indexed poster)',
  'event TermsAccepted(address indexed user, bytes32 indexed tosHash)',
  'event AddressSanctioned(address indexed addr)',
  'event AddressUnsanctioned(address indexed addr)',
] as const;

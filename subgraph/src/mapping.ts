/**
 * The Arena Protocol — Subgraph Mappings
 *
 * Maps every ArenaCore event to subgraph entity updates.
 * Covers: tasks, continuous contracts, bids, verifications,
 * disputes, insurance, syndicates, delegation, reputation NFTs,
 * honeypots, verifier pool, chain routing, and protocol stats.
 */

import { BigInt, Bytes, Address, ethereum, log } from "@graphprotocol/graph-ts";

import {
  // Core task lifecycle
  TaskCreated,
  BidCommitted,
  BidRevealed,
  AgentAssigned,
  TaskDelivered,
  VerifierAssigned,
  VerificationSubmitted,
  TaskCompleted,
  AgentSlashed,
  VerifierSlashed,
  TaskDisputed,
  TaskCancelled,
  ProtocolFeeCollected,
  SlashBondClaimed,
  SlashBondForfeited,
  // Honeypot
  HoneypotCreated,
  HoneypotSettled,
  // Verifier pool & VRF
  VerifierRegistered,
  VerifierDeregistered,
  VRFVerifiersAssigned,
  VerifierTimedOut,
  VerifierCooldownUpdated,
  AnomalyDetected,
  VerifierAutoFlagged,
  VerifierAutoBanned,
  AgentSlashCooldownApplied,
  // Continuous contracts
  ContinuousContractCreated,
  ContinuousBidCommitted,
  ContinuousBidRevealed,
  ContinuousAgentAssigned,
  CheckpointSubmitted,
  CheckpointVerifierAssigned,
  CheckpointEvaluated,
  CheckpointMissed,
  ContinuousContractTerminated,
  ContinuousContractCompleted,
  // Disputes & Arbitration
  DisputeRaised,
  ArbitratorsSelected,
  ArbitratorStaked as ArbitratorStakedEvent,
  ArbitratorVoteSubmitted,
  ArbitratorSlashed,
  ArbitratorTimedOut,
  DisputeResolved,
  DisputeExpired,
  DisputeFeeDistributed,
  // Insurance
  InsuranceOffered,
  InsurancePurchased,
  InsuranceClaimed,
  InsuranceSettled,
  InsuranceOfferCancelled,
  // Syndicates
  SyndicateCreated,
  SyndicateJoined,
  SyndicateLeft,
  SyndicateDissolved,
  SyndicateBidCommitted,
  SyndicateBidRevealed,
  SyndicateRewardsDistributed,
  SyndicateLossesDistributed,
  // Delegation
  DelegationPoolOpened,
  StakeDelegated,
  DelegationWithdrawn,
  DelegatorRevenueShareUpdated,
  DelegatedBidRevealed,
  DelegatorRewardsClaimed,
  DelegatorLossesClaimed,
  // Reputation NFT
  ReputationNFTMinted,
  ReputationNFTBurned,
  // Chain routing
  ChainPreferenceSet,
  ChainThresholdsUpdated,
} from "../generated/ArenaCore/ArenaCore";

import {
  Task,
  Agent,
  Bid,
  Verification,
  ContinuousContract,
  Checkpoint,
  Dispute,
  ArbitratorStake,
  SlashEvent,
  InsuranceOffer,
  InsurancePolicy,
  Syndicate,
  SyndicateMember,
  Delegation,
  VerifierRegistration,
  Honeypot,
  ProtocolStats,
  DailyStats,
} from "../generated/schema";

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

let ZERO = BigInt.zero();
let ONE = BigInt.fromI32(1);

function getOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load("protocol");
  if (!stats) {
    stats = new ProtocolStats("protocol");
    stats.totalTasks = ZERO;
    stats.totalContinuousContracts = ZERO;
    stats.totalBountyVolume = ZERO;
    stats.totalProtocolRevenue = ZERO;
    stats.totalSlashVolume = ZERO;
    stats.totalInsurancePremiums = ZERO;
    stats.totalInsuranceClaims = ZERO;
    stats.totalAgents = ZERO;
    stats.totalVerifiers = ZERO;
    stats.totalSyndicates = ZERO;
    stats.totalDelegated = ZERO;
    stats.totalDisputes = ZERO;
    stats.activeTasks = ZERO;
    stats.tasksCompleted = ZERO;
    stats.tasksFailed = ZERO;
    stats.tasksCancelled = ZERO;
  }
  return stats;
}

function getOrCreateAgent(address: Bytes, timestamp: BigInt): Agent {
  let id = address.toHexString();
  let agent = Agent.load(id);
  if (!agent) {
    agent = new Agent(id);
    agent.address = address;
    agent.reputation = ZERO;
    agent.tasksCompleted = ZERO;
    agent.tasksFailed = ZERO;
    agent.activeStake = ZERO;
    agent.banned = false;
    agent.totalEarnings = ZERO;
    agent.totalSlashed = ZERO;
    agent.honeypotFlags = ZERO;
    agent.firstSeenAt = timestamp;
    agent.lastActiveAt = timestamp;
    agent.delegationPoolOpen = false;
    agent.delegationTotalDelegated = ZERO;
    agent.delegatorCount = 0;

    let stats = getOrCreateProtocolStats();
    stats.totalAgents = stats.totalAgents.plus(ONE);
    stats.save();

    let daily = getDailyStats(timestamp);
    daily.newAgents = daily.newAgents.plus(ONE);
    daily.save();
  }
  agent.lastActiveAt = timestamp;
  return agent;
}

function getDailyStats(timestamp: BigInt): DailyStats {
  let dayId = timestamp.div(BigInt.fromI32(86400));
  let id = dayId.toString();
  let daily = DailyStats.load(id);
  if (!daily) {
    daily = new DailyStats(id);
    daily.date = dayId.times(BigInt.fromI32(86400));
    daily.tasksCreated = ZERO;
    daily.tasksCompleted = ZERO;
    daily.tasksFailed = ZERO;
    daily.bountyVolume = ZERO;
    daily.protocolRevenue = ZERO;
    daily.slashVolume = ZERO;
    daily.insurancePremiums = ZERO;
    daily.insuranceClaims = ZERO;
    daily.newAgents = ZERO;
    daily.disputesRaised = ZERO;
    daily.delegationVolume = ZERO;
  }
  return daily;
}

function severityToString(severity: i32): string {
  if (severity == 0) return "Late";
  if (severity == 1) return "Minor";
  if (severity == 2) return "Material";
  if (severity == 3) return "Execution";
  if (severity == 4) return "Critical";
  return "Unknown";
}

function chainToString(chain: i32): string {
  if (chain == 0) return "Base";
  if (chain == 1) return "Ethereum";
  if (chain == 2) return "Solana";
  if (chain == 3) return "Lightning";
  return "Unknown";
}

function checkpointStatusToString(status: i32): string {
  if (status == 0) return "Pending";
  if (status == 1) return "Submitted";
  if (status == 2) return "Verifying";
  if (status == 3) return "Passed";
  if (status == 4) return "Failed";
  if (status == 5) return "Missed";
  return "Unknown";
}

function arbitratorVoteToString(vote: i32): string {
  if (vote == 0) return "Pending";
  if (vote == 1) return "InFavorOfAgent";
  if (vote == 2) return "InFavorOfPoster";
  return "Unknown";
}

function createSlashEvent(
  event: ethereum.Event,
  agentId: string,
  taskId: string | null,
  contractId: string | null,
  amount: BigInt,
  severity: string | null,
  reason: string
): void {
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let slash = new SlashEvent(id);
  slash.agent = agentId;
  if (taskId) slash.task = taskId;
  if (contractId) slash.continuousContract = contractId;
  slash.amount = amount;
  slash.severity = severity;
  slash.reason = reason;
  slash.timestamp = event.block.timestamp;
  slash.blockNumber = event.block.number;
  slash.txHash = event.transaction.hash;
  slash.save();
}

// ═══════════════════════════════════════════════════
// CORE TASK LIFECYCLE
// ═══════════════════════════════════════════════════

export function handleTaskCreated(event: TaskCreated): void {
  let taskId = event.params.taskId.toString();
  let task = new Task(taskId);

  task.poster = event.params.poster;
  task.token = new Bytes(0); // Not in event — would require contract call
  task.bounty = event.params.bounty;
  task.taskType = event.params.taskType;
  task.deadline = event.params.deadline;
  task.slashWindow = ZERO;
  task.createdAt = event.block.timestamp;
  task.bidDeadline = ZERO;
  task.revealDeadline = ZERO;
  task.requiredVerifiers = event.params.requiredVerifiers;
  task.status = "Open";
  task.criteriaHash = new Bytes(0);
  task.isHoneypot = false;
  task.slashBond = ZERO;
  task.createdTxHash = event.transaction.hash;
  task.createdBlockNumber = event.block.number;
  task.save();

  let stats = getOrCreateProtocolStats();
  stats.totalTasks = stats.totalTasks.plus(ONE);
  stats.totalBountyVolume = stats.totalBountyVolume.plus(event.params.bounty);
  stats.activeTasks = stats.activeTasks.plus(ONE);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.tasksCreated = daily.tasksCreated.plus(ONE);
  daily.bountyVolume = daily.bountyVolume.plus(event.params.bounty);
  daily.save();
}

export function handleBidCommitted(event: BidCommitted): void {
  let bidId = event.params.taskId.toString() + "-" + event.params.agent.toHexString();
  let bid = new Bid(bidId);

  bid.task = event.params.taskId.toString();
  bid.bidder = getOrCreateAgent(event.params.agent, event.block.timestamp).id;
  bid.commitHash = event.params.commitHash;
  bid.revealed = false;
  bid.committedAt = event.block.timestamp;
  bid.won = false;
  bid.isSyndicateBid = false;
  bid.isDelegatedBid = false;
  bid.save();

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.save();
}

export function handleBidRevealed(event: BidRevealed): void {
  let bidId = event.params.taskId.toString() + "-" + event.params.agent.toHexString();
  let bid = Bid.load(bidId);

  if (bid) {
    bid.stake = event.params.stake;
    bid.price = event.params.price;
    bid.eta = event.params.eta;
    bid.revealed = true;
    bid.revealedAt = event.block.timestamp;
    bid.save();
  }

  let task = Task.load(event.params.taskId.toString());
  if (task && task.status == "Open") {
    task.status = "BidReveal";
    task.save();
  }

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.activeStake = agent.activeStake.plus(event.params.stake);
  agent.save();
}

export function handleAgentAssigned(event: AgentAssigned): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);

  if (task) {
    task.agent = getOrCreateAgent(event.params.agent, event.block.timestamp).id;
    task.agentStake = event.params.stake;
    task.agentPrice = event.params.price;
    task.assignedAt = event.block.timestamp;
    task.status = "Assigned";
    task.save();
  }

  // Mark winning bid
  let bidId = taskId + "-" + event.params.agent.toHexString();
  let bid = Bid.load(bidId);
  if (bid) {
    bid.won = true;
    bid.save();
  }
}

export function handleTaskDelivered(event: TaskDelivered): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);

  if (task) {
    task.deliveredAt = event.block.timestamp;
    task.outputHash = event.params.outputHash;
    task.status = "Delivered";
    task.save();
  }
}

export function handleVerifierAssigned(event: VerifierAssigned): void {
  let verifId = event.params.taskId.toString() + "-" + event.params.verifier.toHexString();
  let verification = new Verification(verifId);

  verification.task = event.params.taskId.toString();
  verification.verifier = event.params.verifier;
  verification.stake = event.params.stake;
  verification.timedOut = false;
  verification.slashed = false;
  verification.save();

  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.status = "Verifying";
    task.save();
  }
}

export function handleVerificationSubmitted(event: VerificationSubmitted): void {
  let verifId = event.params.taskId.toString() + "-" + event.params.verifier.toHexString();
  let verification = Verification.load(verifId);

  if (verification) {
    let voteValue = event.params.vote;
    if (voteValue == 1) {
      verification.vote = "Approved";
    } else if (voteValue == 2) {
      verification.vote = "Rejected";
    } else {
      verification.vote = "Pending";
    }
    verification.submittedAt = event.block.timestamp;
    verification.save();
  }
}

export function handleTaskCompleted(event: TaskCompleted): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);

  if (task) {
    task.status = "Completed";
    task.payout = event.params.payout;
    task.completedAt = event.block.timestamp;
    task.save();
  }

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.tasksCompleted = agent.tasksCompleted.plus(ONE);
  agent.reputation = agent.reputation.plus(BigInt.fromI32(10));
  agent.totalEarnings = agent.totalEarnings.plus(event.params.payout);
  agent.save();

  let stats = getOrCreateProtocolStats();
  stats.tasksCompleted = stats.tasksCompleted.plus(ONE);
  stats.activeTasks = stats.activeTasks.minus(ONE);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.tasksCompleted = daily.tasksCompleted.plus(ONE);
  daily.save();
}

export function handleAgentSlashed(event: AgentSlashed): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);

  if (task) {
    task.status = "Failed";
    task.slashAmount = event.params.amount;
    task.slashSeverity = severityToString(event.params.severity);
    task.save();
  }

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.tasksFailed = agent.tasksFailed.plus(ONE);
  agent.totalSlashed = agent.totalSlashed.plus(event.params.amount);
  if (agent.reputation.gt(BigInt.fromI32(5))) {
    agent.reputation = agent.reputation.minus(BigInt.fromI32(5));
  } else {
    agent.reputation = ZERO;
  }
  if (event.params.severity == 4) {
    agent.banned = true;
  }
  agent.save();

  createSlashEvent(
    event,
    agent.id,
    taskId,
    null,
    event.params.amount,
    severityToString(event.params.severity),
    "AgentSlashed"
  );

  let stats = getOrCreateProtocolStats();
  stats.tasksFailed = stats.tasksFailed.plus(ONE);
  stats.activeTasks = stats.activeTasks.minus(ONE);
  stats.totalSlashVolume = stats.totalSlashVolume.plus(event.params.amount);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.tasksFailed = daily.tasksFailed.plus(ONE);
  daily.slashVolume = daily.slashVolume.plus(event.params.amount);
  daily.save();
}

export function handleVerifierSlashed(event: VerifierSlashed): void {
  let verifId = event.params.taskId.toString() + "-" + event.params.verifier.toHexString();
  let verification = Verification.load(verifId);
  if (verification) {
    verification.slashed = true;
    verification.slashAmount = event.params.amount;
    verification.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalSlashVolume = stats.totalSlashVolume.plus(event.params.amount);
  stats.save();
}

export function handleTaskDisputed(event: TaskDisputed): void {
  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.status = "Disputed";
    task.save();
  }
}

export function handleTaskCancelled(event: TaskCancelled): void {
  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.status = "Cancelled";
    task.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.tasksCancelled = stats.tasksCancelled.plus(ONE);
  stats.activeTasks = stats.activeTasks.minus(ONE);
  stats.save();
}

export function handleProtocolFeeCollected(event: ProtocolFeeCollected): void {
  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.protocolFee = event.params.amount;
    task.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalProtocolRevenue = stats.totalProtocolRevenue.plus(event.params.amount);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.protocolRevenue = daily.protocolRevenue.plus(event.params.amount);
  daily.save();
}

export function handleSlashBondClaimed(event: SlashBondClaimed): void {
  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.slashBond = ZERO;
    task.save();
  }
}

export function handleSlashBondForfeited(event: SlashBondForfeited): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);
  if (task) {
    task.slashBond = ZERO;
    task.slashAmount = event.params.slashedAmount;
    task.slashSeverity = severityToString(event.params.severity);
    task.save();
  }

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  createSlashEvent(
    event,
    agent.id,
    taskId,
    null,
    event.params.slashedAmount,
    severityToString(event.params.severity),
    "SlashBondForfeited"
  );
}

// ═══════════════════════════════════════════════════
// HONEYPOT
// ═══════════════════════════════════════════════════

export function handleHoneypotCreated(event: HoneypotCreated): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);
  if (task) {
    task.isHoneypot = true;
    task.save();
  }

  let honeypot = new Honeypot(taskId);
  honeypot.task = taskId;
  honeypot.createdAt = event.block.timestamp;
  honeypot.settled = false;
  honeypot.save();
}

export function handleHoneypotSettled(event: HoneypotSettled): void {
  let taskId = event.params.taskId.toString();
  let honeypot = Honeypot.load(taskId);
  if (honeypot) {
    honeypot.settled = true;
    honeypot.settledAt = event.block.timestamp;
    honeypot.agentCaught = !event.params.passed;
    honeypot.save();
  }

  let task = Task.load(taskId);
  if (task) {
    task.honeypotPassed = event.params.passed;
    task.save();
  }

  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  if (!event.params.passed) {
    agent.honeypotFlags = agent.honeypotFlags.plus(ONE);
    if (agent.honeypotFlags.ge(BigInt.fromI32(2))) {
      agent.banned = true;
    }
  }
  agent.save();
}

// ═══════════════════════════════════════════════════
// VERIFIER POOL & VRF
// ═══════════════════════════════════════════════════

export function handleVerifierRegistered(event: VerifierRegistered): void {
  let id = event.params.verifier.toHexString();
  let reg = new VerifierRegistration(id);
  reg.verifier = event.params.verifier;
  reg.stake = event.params.stake;
  reg.active = true;
  reg.registeredAt = event.block.timestamp;
  reg.anomalyCount = 0;
  reg.flagged = false;
  reg.banned = false;
  reg.save();

  let stats = getOrCreateProtocolStats();
  stats.totalVerifiers = stats.totalVerifiers.plus(ONE);
  stats.save();
}

export function handleVerifierDeregistered(event: VerifierDeregistered): void {
  let id = event.params.verifier.toHexString();
  let reg = VerifierRegistration.load(id);
  if (reg) {
    reg.active = false;
    reg.deregisteredAt = event.block.timestamp;
    reg.save();
  }

  let stats = getOrCreateProtocolStats();
  if (stats.totalVerifiers.gt(ZERO)) {
    stats.totalVerifiers = stats.totalVerifiers.minus(ONE);
  }
  stats.save();
}

export function handleVRFVerifiersAssigned(event: VRFVerifiersAssigned): void {
  // VRF assigned verifiers to a task — no specific entity update needed
  // beyond the VerifierAssigned events that follow
}

export function handleVerifierTimedOut(event: VerifierTimedOut): void {
  let verifId = event.params.taskId.toString() + "-" + event.params.verifier.toHexString();
  let verification = Verification.load(verifId);
  if (verification) {
    verification.timedOut = true;
    verification.slashed = true;
    verification.slashAmount = event.params.slashAmount;
    verification.save();
  }
}

export function handleVerifierCooldownUpdated(event: VerifierCooldownUpdated): void {
  // Config event — no entity to update
}

export function handleAnomalyDetected(event: AnomalyDetected): void {
  let id = event.params.verifier.toHexString();
  let reg = VerifierRegistration.load(id);
  if (reg) {
    reg.anomalyCount = reg.anomalyCount + 1;
    reg.save();
  }
}

export function handleVerifierAutoFlagged(event: VerifierAutoFlagged): void {
  let id = event.params.verifier.toHexString();
  let reg = VerifierRegistration.load(id);
  if (reg) {
    reg.flagged = true;
    reg.anomalyCount = event.params.anomalyCount.toI32();
    reg.save();
  }
}

export function handleVerifierAutoBanned(event: VerifierAutoBanned): void {
  let id = event.params.verifier.toHexString();
  let reg = VerifierRegistration.load(id);
  if (reg) {
    reg.banned = true;
    reg.active = false;
    reg.save();
  }
}

export function handleAgentSlashCooldownApplied(event: AgentSlashCooldownApplied): void {
  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.cooldownEnd = event.params.cooldownEnd;
  agent.save();
}

// ═══════════════════════════════════════════════════
// CONTINUOUS CONTRACTS
// ═══════════════════════════════════════════════════

export function handleContinuousContractCreated(event: ContinuousContractCreated): void {
  let id = event.params.contractId.toString();
  let cc = new ContinuousContract(id);

  cc.poster = event.params.poster;
  cc.token = new Bytes(0);
  cc.totalBounty = event.params.totalBounty;
  cc.paymentPerCheckpoint = ZERO;
  cc.duration = ZERO;
  cc.checkpointInterval = ZERO;
  cc.createdAt = event.block.timestamp;
  cc.bidDeadline = ZERO;
  cc.revealDeadline = ZERO;
  cc.totalCheckpoints = event.params.totalCheckpoints;
  cc.completedCheckpoints = 0;
  cc.passedCheckpoints = 0;
  cc.failedCheckpoints = 0;
  cc.maxFailures = event.params.maxFailures;
  cc.requiredVerifiers = 0;
  cc.status = "Open";
  cc.criteriaHash = new Bytes(0);
  cc.contractType = event.params.contractType;
  cc.totalPaid = ZERO;
  cc.totalSlashed = ZERO;
  cc.createdTxHash = event.transaction.hash;
  cc.createdBlockNumber = event.block.number;
  cc.save();

  let stats = getOrCreateProtocolStats();
  stats.totalContinuousContracts = stats.totalContinuousContracts.plus(ONE);
  stats.totalBountyVolume = stats.totalBountyVolume.plus(event.params.totalBounty);
  stats.save();
}

export function handleContinuousBidCommitted(event: ContinuousBidCommitted): void {
  let bidId = "cc-" + event.params.contractId.toString() + "-" + event.params.bidder.toHexString();
  let bid = new Bid(bidId);

  bid.continuousContract = event.params.contractId.toString();
  bid.bidder = getOrCreateAgent(event.params.bidder, event.block.timestamp).id;
  bid.commitHash = event.params.commitHash;
  bid.revealed = false;
  bid.committedAt = event.block.timestamp;
  bid.won = false;
  bid.isSyndicateBid = false;
  bid.isDelegatedBid = false;
  bid.save();
}

export function handleContinuousBidRevealed(event: ContinuousBidRevealed): void {
  let bidId = "cc-" + event.params.contractId.toString() + "-" + event.params.bidder.toHexString();
  let bid = Bid.load(bidId);
  if (bid) {
    bid.stake = event.params.stake;
    bid.price = event.params.price;
    bid.eta = event.params.eta;
    bid.revealed = true;
    bid.revealedAt = event.block.timestamp;
    bid.save();
  }
}

export function handleContinuousAgentAssigned(event: ContinuousAgentAssigned): void {
  let id = event.params.contractId.toString();
  let cc = ContinuousContract.load(id);
  if (cc) {
    cc.agent = getOrCreateAgent(event.params.agent, event.block.timestamp).id;
    cc.agentStake = event.params.stake;
    cc.agentPrice = event.params.price;
    cc.startedAt = event.block.timestamp;
    cc.status = "Active";
    cc.save();
  }

  // Mark winning bid
  let bidId = "cc-" + id + "-" + event.params.agent.toHexString();
  let bid = Bid.load(bidId);
  if (bid) {
    bid.won = true;
    bid.save();
  }
}

export function handleCheckpointSubmitted(event: CheckpointSubmitted): void {
  let cpId = event.params.contractId.toString() + "-" + event.params.checkpointIndex.toString();
  let cp = new Checkpoint(cpId);

  cp.continuousContract = event.params.contractId.toString();
  cp.checkpointIndex = event.params.checkpointIndex;
  cp.agent = event.params.agent;
  cp.outputHash = event.params.outputHash;
  cp.submittedAt = event.block.timestamp;
  cp.status = "Submitted";
  cp.save();
}

export function handleCheckpointVerifierAssigned(event: CheckpointVerifierAssigned): void {
  let verifId = event.params.contractId.toString() + "-" + event.params.checkpointIndex.toString() + "-" + event.params.verifier.toHexString();
  let verification = new Verification(verifId);

  verification.continuousContract = event.params.contractId.toString();
  verification.checkpointIndex = event.params.checkpointIndex;
  verification.verifier = event.params.verifier;
  verification.stake = event.params.stake;
  verification.timedOut = false;
  verification.slashed = false;
  verification.save();

  let cpId = event.params.contractId.toString() + "-" + event.params.checkpointIndex.toString();
  let cp = Checkpoint.load(cpId);
  if (cp) {
    cp.status = "Verifying";
    cp.save();
  }
}

export function handleCheckpointEvaluated(event: CheckpointEvaluated): void {
  let cpId = event.params.contractId.toString() + "-" + event.params.checkpointIndex.toString();
  let cp = Checkpoint.load(cpId);
  if (cp) {
    cp.status = checkpointStatusToString(event.params.status);
    cp.payoutAmount = event.params.payoutAmount;
    cp.slashAmount = event.params.slashAmount;
    cp.evaluatedAt = event.block.timestamp;
    cp.save();
  }

  let cc = ContinuousContract.load(event.params.contractId.toString());
  if (cc) {
    cc.completedCheckpoints = cc.completedCheckpoints + 1;
    if (event.params.status == 3) { // Passed
      cc.passedCheckpoints = cc.passedCheckpoints + 1;
      cc.totalPaid = cc.totalPaid!.plus(event.params.payoutAmount);
    } else if (event.params.status == 4) { // Failed
      cc.failedCheckpoints = cc.failedCheckpoints + 1;
      cc.totalSlashed = cc.totalSlashed!.plus(event.params.slashAmount);
    }
    cc.save();
  }

  if (event.params.slashAmount.gt(ZERO)) {
    let stats = getOrCreateProtocolStats();
    stats.totalSlashVolume = stats.totalSlashVolume.plus(event.params.slashAmount);
    stats.save();

    let daily = getDailyStats(event.block.timestamp);
    daily.slashVolume = daily.slashVolume.plus(event.params.slashAmount);
    daily.save();
  }
}

export function handleCheckpointMissed(event: CheckpointMissed): void {
  let cpId = event.params.contractId.toString() + "-" + event.params.checkpointIndex.toString();
  let cp = Checkpoint.load(cpId);
  if (!cp) {
    cp = new Checkpoint(cpId);
    cp.continuousContract = event.params.contractId.toString();
    cp.checkpointIndex = event.params.checkpointIndex;
    cp.agent = new Bytes(0);
  }
  cp.status = "Missed";
  cp.evaluatedAt = event.block.timestamp;
  cp.save();

  let cc = ContinuousContract.load(event.params.contractId.toString());
  if (cc) {
    cc.completedCheckpoints = cc.completedCheckpoints + 1;
    cc.failedCheckpoints = cc.failedCheckpoints + 1;
    cc.save();
  }
}

export function handleContinuousContractTerminated(event: ContinuousContractTerminated): void {
  let cc = ContinuousContract.load(event.params.contractId.toString());
  if (cc) {
    cc.status = "Terminated";
    cc.terminationReason = event.params.reason;
    cc.save();
  }
}

export function handleContinuousContractCompleted(event: ContinuousContractCompleted): void {
  let cc = ContinuousContract.load(event.params.contractId.toString());
  if (cc) {
    cc.status = "Completed";
    cc.totalPaid = event.params.totalPaid;
    cc.totalSlashed = event.params.totalSlashed;
    cc.stakeReturned = event.params.stakeReturned;
    cc.save();
  }
}

// ═══════════════════════════════════════════════════
// DISPUTES & ARBITRATION
// ═══════════════════════════════════════════════════

export function handleDisputeRaised(event: DisputeRaised): void {
  let id = event.params.disputeId.toString();
  let dispute = new Dispute(id);

  dispute.disputeType = event.params.disputeType == 0 ? "Task" : "Checkpoint";
  if (event.params.disputeType == 0) {
    dispute.task = event.params.taskOrContractId.toString();
  } else {
    dispute.continuousContract = event.params.taskOrContractId.toString();
  }
  dispute.disputant = event.params.disputant;
  dispute.token = new Bytes(0);
  dispute.bountyAmount = ZERO;
  dispute.disputeFee = event.params.disputeFee;
  dispute.createdAt = event.block.timestamp;
  dispute.status = "Selecting";
  dispute.save();

  let stats = getOrCreateProtocolStats();
  stats.totalDisputes = stats.totalDisputes.plus(ONE);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.disputesRaised = daily.disputesRaised.plus(ONE);
  daily.save();
}

export function handleArbitratorsSelected(event: ArbitratorsSelected): void {
  let dispute = Dispute.load(event.params.disputeId.toString());
  if (dispute) {
    dispute.status = "Staking";
    dispute.save();
  }

  let arbitrators = event.params.arbitrators;
  for (let i = 0; i < arbitrators.length; i++) {
    let arbId = event.params.disputeId.toString() + "-" + arbitrators[i].toHexString();
    let arbStake = new ArbitratorStake(arbId);
    arbStake.dispute = event.params.disputeId.toString();
    arbStake.arbitrator = arbitrators[i];
    arbStake.stake = ZERO;
    arbStake.vote = "Pending";
    arbStake.staked = false;
    arbStake.slashed = false;
    arbStake.timedOut = false;
    arbStake.save();
  }
}

export function handleArbitratorStaked(event: ArbitratorStakedEvent): void {
  let arbId = event.params.disputeId.toString() + "-" + event.params.arbitrator.toHexString();
  let arbStake = ArbitratorStake.load(arbId);
  if (arbStake) {
    arbStake.stake = event.params.stake;
    arbStake.staked = true;
    arbStake.save();
  }

  // Check if all staked → move to Voting
  let dispute = Dispute.load(event.params.disputeId.toString());
  if (dispute) {
    dispute.status = "Voting";
    dispute.save();
  }
}

export function handleArbitratorVoteSubmitted(event: ArbitratorVoteSubmitted): void {
  let arbId = event.params.disputeId.toString() + "-" + event.params.arbitrator.toHexString();
  let arbStake = ArbitratorStake.load(arbId);
  if (arbStake) {
    arbStake.vote = arbitratorVoteToString(event.params.vote);
    arbStake.votedAt = event.block.timestamp;
    arbStake.save();
  }
}

export function handleArbitratorSlashed(event: ArbitratorSlashed): void {
  let arbId = event.params.disputeId.toString() + "-" + event.params.arbitrator.toHexString();
  let arbStake = ArbitratorStake.load(arbId);
  if (arbStake) {
    arbStake.slashed = true;
    arbStake.slashAmount = event.params.amount;
    arbStake.save();
  }
}

export function handleArbitratorTimedOut(event: ArbitratorTimedOut): void {
  let arbId = event.params.disputeId.toString() + "-" + event.params.arbitrator.toHexString();
  let arbStake = ArbitratorStake.load(arbId);
  if (arbStake) {
    arbStake.timedOut = true;
    arbStake.slashed = true;
    arbStake.slashAmount = event.params.slashAmount;
    arbStake.save();
  }
}

export function handleDisputeResolved(event: DisputeResolved): void {
  let dispute = Dispute.load(event.params.disputeId.toString());
  if (dispute) {
    dispute.status = "Resolved";
    dispute.resolvedInFavorOfAgent = event.params.inFavorOfAgent;
    dispute.votesForAgent = event.params.votesForAgent;
    dispute.votesForPoster = event.params.votesForPoster;
    dispute.save();
  }
}

export function handleDisputeExpired(event: DisputeExpired): void {
  let dispute = Dispute.load(event.params.disputeId.toString());
  if (dispute) {
    dispute.status = "Expired";
    dispute.save();
  }
}

export function handleDisputeFeeDistributed(event: DisputeFeeDistributed): void {
  let dispute = Dispute.load(event.params.disputeId.toString());
  if (dispute) {
    dispute.feeToProtocol = event.params.toProtocol;
    dispute.feeToArbitrators = event.params.toArbitrators;
    dispute.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalProtocolRevenue = stats.totalProtocolRevenue.plus(event.params.toProtocol);
  stats.save();
}

// ═══════════════════════════════════════════════════
// INSURANCE
// ═══════════════════════════════════════════════════

export function handleInsuranceOffered(event: InsuranceOffered): void {
  let id = event.params.offerId.toString();
  let offer = new InsuranceOffer(id);

  offer.insurer = event.params.insurer;
  offer.task = event.params.taskId.toString();
  offer.coverageBps = event.params.coverageBps;
  offer.premiumBps = event.params.premiumBps;
  offer.maxCoverage = event.params.maxCoverage;
  offer.premium = event.params.premium;
  offer.status = "Open";
  offer.createdAt = event.block.timestamp;
  offer.save();
}

export function handleInsurancePurchased(event: InsurancePurchased): void {
  let id = event.params.policyId.toString();
  let policy = new InsurancePolicy(id);

  policy.task = event.params.taskId.toString();
  policy.insurer = event.params.insurer;
  policy.insured = event.params.insured;
  policy.maxCoverage = event.params.maxCoverage;
  policy.premiumPaid = event.params.premiumPaid;
  policy.status = "Active";
  policy.activatedAt = event.block.timestamp;
  policy.save();

  // Update offer status
  let offer = InsuranceOffer.load(id);
  if (offer) {
    offer.status = "Active";
    offer.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalInsurancePremiums = stats.totalInsurancePremiums.plus(event.params.premiumPaid);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.insurancePremiums = daily.insurancePremiums.plus(event.params.premiumPaid);
  daily.save();
}

export function handleInsuranceClaimed(event: InsuranceClaimed): void {
  let policy = InsurancePolicy.load(event.params.policyId.toString());
  if (policy) {
    policy.status = "Claimed";
    policy.claimedAmount = event.params.claimedAmount;
    policy.claimedAt = event.block.timestamp;
    policy.save();
  }

  let offer = InsuranceOffer.load(event.params.policyId.toString());
  if (offer) {
    offer.status = "Claimed";
    offer.save();
  }

  let stats = getOrCreateProtocolStats();
  stats.totalInsuranceClaims = stats.totalInsuranceClaims.plus(event.params.claimedAmount);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.insuranceClaims = daily.insuranceClaims.plus(event.params.claimedAmount);
  daily.save();
}

export function handleInsuranceSettled(event: InsuranceSettled): void {
  let policy = InsurancePolicy.load(event.params.policyId.toString());
  if (policy) {
    policy.status = "Settled";
    policy.settledAt = event.block.timestamp;
    policy.returnedCapital = event.params.returnedCapital;
    policy.save();
  }

  let offer = InsuranceOffer.load(event.params.policyId.toString());
  if (offer) {
    offer.status = "Settled";
    offer.save();
  }
}

export function handleInsuranceOfferCancelled(event: InsuranceOfferCancelled): void {
  let offer = InsuranceOffer.load(event.params.offerId.toString());
  if (offer) {
    offer.status = "Cancelled";
    offer.cancelledAt = event.block.timestamp;
    offer.save();
  }
}

// ═══════════════════════════════════════════════════
// SYNDICATES
// ═══════════════════════════════════════════════════

export function handleSyndicateCreated(event: SyndicateCreated): void {
  let id = event.params.syndicateId.toString();
  let syndicate = new Syndicate(id);

  syndicate.name = event.params.name;
  syndicate.manager = event.params.manager;
  syndicate.token = new Bytes(0);
  syndicate.totalStake = ZERO;
  syndicate.memberCount = 0;
  syndicate.status = "Active";
  syndicate.createdAt = event.block.timestamp;
  syndicate.tasksWon = ZERO;
  syndicate.tasksCompleted = ZERO;
  syndicate.tasksFailed = ZERO;
  syndicate.totalEarnings = ZERO;
  syndicate.totalLosses = ZERO;
  syndicate.save();

  let stats = getOrCreateProtocolStats();
  stats.totalSyndicates = stats.totalSyndicates.plus(ONE);
  stats.save();
}

export function handleSyndicateJoined(event: SyndicateJoined): void {
  let synId = event.params.syndicateId.toString();
  let memberId = synId + "-" + event.params.member.toHexString();

  let member = new SyndicateMember(memberId);
  member.syndicate = synId;
  member.member = getOrCreateAgent(event.params.member, event.block.timestamp).id;
  member.contribution = event.params.contribution;
  member.joinedAt = event.block.timestamp;
  member.active = true;
  member.save();

  let syndicate = Syndicate.load(synId);
  if (syndicate) {
    syndicate.memberCount = syndicate.memberCount + 1;
    syndicate.totalStake = syndicate.totalStake.plus(event.params.contribution);
    syndicate.save();
  }
}

export function handleSyndicateLeft(event: SyndicateLeft): void {
  let synId = event.params.syndicateId.toString();
  let memberId = synId + "-" + event.params.member.toHexString();

  let member = SyndicateMember.load(memberId);
  if (member) {
    member.active = false;
    member.leftAt = event.block.timestamp;
    member.save();
  }

  let syndicate = Syndicate.load(synId);
  if (syndicate) {
    syndicate.memberCount = syndicate.memberCount - 1;
    syndicate.totalStake = syndicate.totalStake.minus(event.params.contributionReturned);
    syndicate.save();
  }
}

export function handleSyndicateDissolved(event: SyndicateDissolved): void {
  let syndicate = Syndicate.load(event.params.syndicateId.toString());
  if (syndicate) {
    syndicate.status = "Dissolved";
    syndicate.save();
  }
}

export function handleSyndicateBidCommitted(event: SyndicateBidCommitted): void {
  let bidId = "syn-" + event.params.syndicateId.toString() + "-" + event.params.taskId.toString();
  let bid = new Bid(bidId);

  let syndicate = Syndicate.load(event.params.syndicateId.toString());
  if (syndicate) {
    bid.task = event.params.taskId.toString();
    bid.bidder = syndicate.manager.toHexString();
    bid.commitHash = event.params.commitHash;
    bid.revealed = false;
    bid.committedAt = event.block.timestamp;
    bid.won = false;
    bid.isSyndicateBid = true;
    bid.syndicateId = event.params.syndicateId;
    bid.isDelegatedBid = false;
    bid.save();
  }

  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.syndicateId = event.params.syndicateId;
    task.save();
  }
}

export function handleSyndicateBidRevealed(event: SyndicateBidRevealed): void {
  let bidId = "syn-" + event.params.syndicateId.toString() + "-" + event.params.taskId.toString();
  let bid = Bid.load(bidId);
  if (bid) {
    bid.stake = event.params.stake;
    bid.price = event.params.price;
    bid.revealed = true;
    bid.revealedAt = event.block.timestamp;
    bid.save();
  }

  let syndicate = Syndicate.load(event.params.syndicateId.toString());
  if (syndicate) {
    syndicate.tasksWon = syndicate.tasksWon.plus(ONE);
    syndicate.save();
  }
}

export function handleSyndicateRewardsDistributed(event: SyndicateRewardsDistributed): void {
  let syndicate = Syndicate.load(event.params.syndicateId.toString());
  if (syndicate) {
    syndicate.tasksCompleted = syndicate.tasksCompleted.plus(ONE);
    syndicate.totalEarnings = syndicate.totalEarnings.plus(event.params.totalPayout);
    syndicate.save();
  }
}

export function handleSyndicateLossesDistributed(event: SyndicateLossesDistributed): void {
  let syndicate = Syndicate.load(event.params.syndicateId.toString());
  if (syndicate) {
    syndicate.tasksFailed = syndicate.tasksFailed.plus(ONE);
    syndicate.totalLosses = syndicate.totalLosses.plus(event.params.totalLoss);
    syndicate.save();
  }
}

// ═══════════════════════════════════════════════════
// DELEGATION
// ═══════════════════════════════════════════════════

export function handleDelegationPoolOpened(event: DelegationPoolOpened): void {
  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.delegationPoolOpen = true;
  agent.delegationToken = event.params.token;
  agent.delegationRevenueShareBps = event.params.revenueShareBps.toI32();
  agent.save();
}

export function handleStakeDelegated(event: StakeDelegated): void {
  let agentAddr = event.params.agent;
  let delegatorAddr = event.params.delegator;
  let delegationId = agentAddr.toHexString() + "-" + delegatorAddr.toHexString();

  let delegation = Delegation.load(delegationId);
  if (!delegation) {
    delegation = new Delegation(delegationId);
    delegation.agent = getOrCreateAgent(agentAddr, event.block.timestamp).id;
    delegation.delegator = getOrCreateAgent(delegatorAddr, event.block.timestamp).id;
    delegation.amount = ZERO;
    delegation.createdAt = event.block.timestamp;
    delegation.active = true;
    delegation.totalRewardsClaimed = ZERO;
    delegation.totalLossesClaimed = ZERO;

    let agent = getOrCreateAgent(agentAddr, event.block.timestamp);
    agent.delegatorCount = agent.delegatorCount + 1;
    agent.save();
  }

  delegation.amount = delegation.amount.plus(event.params.amount);
  delegation.lastUpdatedAt = event.block.timestamp;
  delegation.active = true;
  delegation.save();

  let agent = getOrCreateAgent(agentAddr, event.block.timestamp);
  agent.delegationTotalDelegated = agent.delegationTotalDelegated.plus(event.params.amount);
  agent.save();

  let stats = getOrCreateProtocolStats();
  stats.totalDelegated = stats.totalDelegated.plus(event.params.amount);
  stats.save();

  let daily = getDailyStats(event.block.timestamp);
  daily.delegationVolume = daily.delegationVolume.plus(event.params.amount);
  daily.save();
}

export function handleDelegationWithdrawn(event: DelegationWithdrawn): void {
  let agentAddr = event.params.agent;
  let delegatorAddr = event.params.delegator;
  let delegationId = agentAddr.toHexString() + "-" + delegatorAddr.toHexString();

  let delegation = Delegation.load(delegationId);
  if (delegation) {
    delegation.amount = delegation.amount.minus(event.params.amount);
    delegation.lastUpdatedAt = event.block.timestamp;
    if (delegation.amount.equals(ZERO)) {
      delegation.active = false;

      let agent = getOrCreateAgent(agentAddr, event.block.timestamp);
      agent.delegatorCount = agent.delegatorCount - 1;
      agent.save();
    }
    delegation.save();
  }

  let agent = getOrCreateAgent(agentAddr, event.block.timestamp);
  agent.delegationTotalDelegated = agent.delegationTotalDelegated.minus(event.params.amount);
  agent.save();

  let stats = getOrCreateProtocolStats();
  if (stats.totalDelegated.gt(event.params.amount)) {
    stats.totalDelegated = stats.totalDelegated.minus(event.params.amount);
  } else {
    stats.totalDelegated = ZERO;
  }
  stats.save();
}

export function handleDelegatorRevenueShareUpdated(event: DelegatorRevenueShareUpdated): void {
  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.delegationRevenueShareBps = event.params.newShareBps.toI32();
  agent.save();
}

export function handleDelegatedBidRevealed(event: DelegatedBidRevealed): void {
  let bidId = event.params.taskId.toString() + "-" + event.params.agent.toHexString();
  let bid = Bid.load(bidId);
  if (bid) {
    bid.isDelegatedBid = true;
    bid.ownStake = event.params.ownStake;
    bid.delegatedStake = event.params.delegatedStake;
    bid.save();
  }

  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.delegatedOwnStake = event.params.ownStake;
    task.delegatedPoolStake = event.params.delegatedStake;
    task.save();
  }
}

export function handleDelegatorRewardsClaimed(event: DelegatorRewardsClaimed): void {
  let taskId = event.params.taskId.toString();
  // Find the agent for this task
  let task = Task.load(taskId);
  if (task && task.agent) {
    let delegationId = task.agent! + "-" + event.params.delegator.toHexString();
    let delegation = Delegation.load(delegationId);
    if (delegation) {
      delegation.totalRewardsClaimed = delegation.totalRewardsClaimed.plus(event.params.rewardAmount);
      delegation.save();
    }
  }
}

export function handleDelegatorLossesClaimed(event: DelegatorLossesClaimed): void {
  let taskId = event.params.taskId.toString();
  let task = Task.load(taskId);
  if (task && task.agent) {
    let delegationId = task.agent! + "-" + event.params.delegator.toHexString();
    let delegation = Delegation.load(delegationId);
    if (delegation) {
      delegation.totalLossesClaimed = delegation.totalLossesClaimed.plus(event.params.lossAmount);
      delegation.save();
    }
  }
}

// ═══════════════════════════════════════════════════
// REPUTATION NFT
// ═══════════════════════════════════════════════════

export function handleReputationNFTMinted(event: ReputationNFTMinted): void {
  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.reputationTokenId = event.params.tokenId;
  agent.save();
}

export function handleReputationNFTBurned(event: ReputationNFTBurned): void {
  let agent = getOrCreateAgent(event.params.agent, event.block.timestamp);
  agent.reputationTokenId = null;
  agent.save();
}

// ═══════════════════════════════════════════════════
// CHAIN ROUTING
// ═══════════════════════════════════════════════════

export function handleChainPreferenceSet(event: ChainPreferenceSet): void {
  let task = Task.load(event.params.taskId.toString());
  if (task) {
    task.preferredChain = chainToString(event.params.preferredChain);
    task.recommendedChain = chainToString(event.params.recommendedChain);
    task.speedPriority = event.params.speedPriority;
    task.securityPriority = event.params.securityPriority;
    task.costPriority = event.params.costPriority;
    task.save();
  }
}

export function handleChainThresholdsUpdated(event: ChainThresholdsUpdated): void {
  // Config update — no entity to modify
}

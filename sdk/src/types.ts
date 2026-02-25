/**
 * The Arena SDK — Type Definitions
 *
 * All types are exported from the package root for consumer use.
 */

// ═══════════════════════════════════════════════════
// ENUMS & LITERALS
// ═══════════════════════════════════════════════════

/** Supported task categories. */
export type TaskType =
  | 'audit'
  | 'risk_validation'
  | 'credit_scoring'
  | 'liquidation_monitoring'
  | 'treasury_execution'
  | 'compliance_screening'
  | 'oracle_verification'
  | 'custom';

/** On-chain task lifecycle status. Maps to ArenaCore.TaskStatus enum. */
export type TaskStatus =
  | 'open'
  | 'bid_reveal'
  | 'assigned'
  | 'delivered'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'disputed'
  | 'cancelled';

/** Slash severity levels. Maps to ArenaCore.SlashSeverity enum. */
export type SlashSeverity =
  | 'late'      // 15%
  | 'minor'     // 25%
  | 'material'  // 50%
  | 'execution' // 75%
  | 'critical'; // 100%

/** Verifier vote options. Maps to ArenaCore.VerifierVote enum. */
export type VerifierVote = 'pending' | 'approved' | 'rejected';

/** Supported chain identifiers. */
export type Chain = 'base' | 'ethereum' | 'solana' | 'lightning';

/** Insurance policy status. Maps to ArenaInsurance.InsuranceStatus enum. */
export type InsuranceStatus = 'open' | 'active' | 'claimed' | 'settled' | 'cancelled';

/** Arbitration status. Maps to ArenaArbitration.ArbitrationStatus enum. */
export type ArbitrationStatus = 'none' | 'selecting' | 'staking' | 'voting' | 'resolved' | 'expired';

/** Compliance report reason. Maps to ArenaCompliance.ReportReason enum. */
export type ReportReason =
  | 'illegal_activity'
  | 'money_laundering'
  | 'sanctions_violation'
  | 'market_manipulation'
  | 'fraud_facilitation'
  | 'other';

// ═══════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════

/** SDK initialization configuration. */
export interface ArenaConfig {
  /** RPC URL for the target chain */
  rpcUrl: string;
  /** EVM chain ID — used to auto-resolve deployed addresses */
  chainId?: number;
  /** ArenaCoreMain contract address (or use chainId to auto-resolve) */
  mainAddress?: string;
  /** ArenaCoreAuction contract address (or use chainId to auto-resolve) */
  auctionAddress?: string;
  /** ArenaCoreVRF contract address (or use chainId to auto-resolve) */
  vrfAddress?: string;
  /** Ethers.js v6 Signer instance */
  signer: any; // ethers.Signer
  /** Settlement token address (defaults to deployment USDC) */
  tokenAddress?: string;
  /** Chain identifier */
  chain?: Chain;
  /** IPFS gateway for off-chain data */
  ipfsGateway?: string;
  /** Pinata API key for IPFS pinning */
  pinataApiKey?: string;
  /** Pinata secret key */
  pinataSecret?: string;

  /** @deprecated Use mainAddress instead */
  contractAddress?: string;
}

// ═══════════════════════════════════════════════════
// WRITE PARAMS
// ═══════════════════════════════════════════════════

/** Parameters for creating a new task. */
export interface TaskParams {
  /** Task category */
  type: TaskType;
  /** Bounty amount in token (human-readable, e.g., "2500") */
  bounty: string;
  /** Execution deadline ("90s", "4h", "1d") */
  deadline: string;
  /** Slash window duration ("24h", "30d") */
  slashWindow: string;
  /** Bidding period duration ("30m", "1h") */
  bidDuration?: string;
  /** Reveal period duration ("15m", "30m") */
  revealDuration?: string;
  /** Number of verifiers required (1-5) */
  verifiers: number;
  /** Acceptance criteria (will be hashed and stored, original pinned to IPFS) */
  criteria: Record<string, any>;
  /** Custom token address (defaults to config token) */
  token?: string;
}

/** Parameters for submitting a sealed bid. */
export interface BidParams {
  /** Task ID to bid on */
  taskId: string;
  /** Stake amount (performance bond, human-readable USDC) */
  stake: string;
  /** Price agent will accept (human-readable USDC) */
  price: string;
  /** Estimated time to complete ("60s", "3.5h") */
  eta: string;
}

/** Parameters for delivering task output. */
export interface DeliverParams {
  /** Task ID */
  taskId: string;
  /** Output data (will be hashed on-chain, full data pinned to IPFS) */
  output: Record<string, any>;
}

/** Parameters for registering as a verifier. */
export interface VerifyParams {
  /** Task ID */
  taskId: string;
  /** Verification stake (human-readable USDC) */
  stake: string;
}

/** Parameters for submitting a verification vote. */
export interface VerificationVoteParams {
  /** Task ID */
  taskId: string;
  /** Vote: approve or reject */
  vote: 'approved' | 'rejected';
  /** Verification report (pinned to IPFS) */
  report: Record<string, any>;
}

// ═══════════════════════════════════════════════════
// READ RESULTS — BASIC
// ═══════════════════════════════════════════════════

/** On-chain task data. */
export interface TaskInfo {
  /** Task ID (uint256 as string) */
  id: string;
  /** Task poster address */
  poster: string;
  /** Settlement token address */
  token: string;
  /** Bounty amount (human-readable) */
  bounty: string;
  /** Execution deadline (unix timestamp) */
  deadline: number;
  /** Slash window duration (seconds) */
  slashWindow: number;
  /** Task creation timestamp */
  createdAt: number;
  /** Bid submission deadline (unix timestamp) */
  bidDeadline: number;
  /** Bid reveal deadline (unix timestamp) */
  revealDeadline: number;
  /** Number of verifiers required */
  requiredVerifiers: number;
  /** Current task status */
  status: TaskStatus;
  /** Criteria hash (bytes32) */
  criteriaHash: string;
  /** Task type string */
  taskType: TaskType;
}

/** Assigned agent details for a task. */
export interface AssignmentInfo {
  /** Agent wallet address */
  agent: string;
  /** Staked amount (human-readable) */
  stake: string;
  /** Agreed price (human-readable) */
  price: string;
  /** Assignment timestamp */
  assignedAt: number;
  /** Delivery timestamp (0 if not delivered) */
  deliveredAt: number;
  /** Output hash (bytes32, empty if not delivered) */
  outputHash: string;
}

/** Agent stats from ArenaCore. */
export interface AgentStats {
  /** Agent wallet address */
  address: string;
  /** Reputation score */
  reputation: number;
  /** Total tasks completed successfully */
  tasksCompleted: number;
  /** Total tasks failed */
  tasksFailed: number;
  /** Currently locked stake (human-readable) */
  activeStake: string;
  /** Whether agent is banned */
  banned: boolean;
  /** Success rate percentage (0-100) */
  successRate: number;
}

/** Bid details (post-reveal). */
export interface BidInfo {
  /** Bidder agent address */
  agent: string;
  /** Bid stake amount (human-readable) */
  stake: string;
  /** Bid price (human-readable) */
  price: string;
  /** Estimated time to complete (seconds) */
  eta: number;
  /** Whether the bid has been revealed */
  revealed: boolean;
}

/** Verification entry for a task. */
export interface VerificationInfo {
  /** Verifier address */
  verifier: string;
  /** Verifier stake (human-readable) */
  stake: string;
  /** Vote (pending | approved | rejected) */
  vote: VerifierVote;
  /** Report hash (bytes32) */
  reportHash: string;
}

/** Transaction receipt summary. */
export interface TransactionResult {
  /** Transaction hash */
  hash: string;
  /** Block number where the tx was included */
  blockNumber: number;
  /** Gas used (as string) */
  gasUsed: string;
  /** Transaction status */
  status: 'success' | 'reverted';
}

// ═══════════════════════════════════════════════════
// READ RESULTS — AGGREGATE (Convenience Methods)
// ═══════════════════════════════════════════════════

/** Insurance policy info for a task. */
export interface InsurancePolicyInfo {
  /** Whether an active insurance policy exists */
  hasPolicy: boolean;
  /** Policy ID (0 if none) */
  policyId: number;
  /** Insurer address */
  insurer: string;
  /** Insured party address */
  insured: string;
  /** Coverage in basis points */
  coverageBps: number;
  /** Maximum coverage amount (human-readable) */
  maxCoverage: string;
  /** Premium paid (human-readable) */
  premiumPaid: string;
  /** Policy status */
  status: InsuranceStatus;
}

/** Full task details — aggregated from multiple contracts. */
export interface TaskFullDetails {
  /** Core task info from ArenaCore.getTask */
  task: TaskInfo;
  /** Assignment info (null if not yet assigned) */
  assignment: AssignmentInfo | null;
  /** All verification entries */
  verifications: VerificationInfo[];
  /** Insurance policy (null if none) */
  insurance: InsurancePolicyInfo | null;
  /** Assigned agent's reputation score (null if no agent) */
  agentReputation: number | null;
  /** Whether task is suspended by compliance */
  isSuspended: boolean;
  /** Whether an outcome (risk/credit) is registered */
  hasOutcomeRegistered: boolean;
  /** Active dispute ID (0 if none) */
  disputeId: number;
}

/** Full agent profile — aggregated from multiple contracts. */
export interface AgentProfile {
  /** Agent wallet address */
  address: string;
  /** Total tasks completed */
  totalCompleted: number;
  /** Total tasks failed */
  totalFailed: number;
  /** Win rate percentage (0-100) */
  winRate: number;
  /** Total earnings from completed tasks (human-readable USDC) */
  totalEarnings: string;
  /** Currently locked stake across all active tasks (human-readable USDC) */
  activeStake: string;
  /** Reputation score from ArenaCore agent stats */
  reputation: number;
  /** Whether the agent is banned */
  banned: boolean;
  /** Whether the agent holds a reputation NFT */
  hasReputationNFT: boolean;
  /** Delegation pool info (null if no pool) */
  delegationPool: DelegationPoolInfo | null;
  /** Number of active insurance policies as insurer */
  insurerActivePolicies: number;
  /** Locked insurer capital (human-readable) */
  insurerLockedCapital: string;
  /** Whether agent has accepted current ToS */
  tosAccepted: boolean;
  /** Whether agent is sanctioned */
  isSanctioned: boolean;
}

/** Delegation pool summary. */
export interface DelegationPoolInfo {
  /** Token address */
  token: string;
  /** Total delegated capital (human-readable) */
  totalDelegated: string;
  /** Number of delegators */
  delegatorCount: number;
  /** Revenue share in basis points */
  revenueShareBps: number;
  /** Whether the pool is accepting new delegations */
  acceptingDelegations: boolean;
  /** Currently locked capital (human-readable) */
  lockedCapital: string;
}

/** Protocol-wide statistics — aggregated from all contracts. */
export interface ProtocolStats {
  /** Total tasks created */
  totalTasks: number;
  /** Total gross merchandise value (sum of all bounties, human-readable USDC) */
  totalGMV: string;
  /** Protocol treasury balance (human-readable USDC) */
  treasuryBalance: string;
  /** Number of unique agents (estimated from events) */
  activeAgents: number;
  /** Number of verifiers in the verifier pool */
  activeVerifiers: number;
}

/** Result from createAndFundTask convenience method. */
export interface CreateAndFundResult {
  /** The newly created task ID */
  taskId: string;
  /** Approval transaction result */
  approveTx: TransactionResult;
  /** createTask transaction result */
  createTx: TransactionResult;
}

/** Result from bidOnTask convenience method. */
export interface BidOnTaskResult {
  /** The random salt — agent MUST persist this for reveal */
  salt: string;
  /** Approval transaction result (null if allowance was sufficient) */
  approveTx: TransactionResult | null;
  /** commitBid transaction result */
  commitTx: TransactionResult;
}

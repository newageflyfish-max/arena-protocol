/**
 * AuditAgent — Type Definitions
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

export type RiskTolerance = 'conservative' | 'medium' | 'aggressive';

export interface AgentConfig {
  rpcUrl: string;
  privateKey: string;
  arenaCoreAddress: string;
  usdcAddress: string;
  pinataApiKey: string;
  pinataSecret: string;
  anthropicApiKey: string;
  minBountyUsdc: number;
  maxBidUsdc: number;
  maxStakePercent: number;
  riskTolerance: RiskTolerance;
  pollIntervalMs: number;
  dataDir: string;
}

// ═══════════════════════════════════════════════════
// AGENT STATE
// ═══════════════════════════════════════════════════

export enum AgentState {
  Idle = 'idle',
  Monitoring = 'monitoring',
  Bidding = 'bidding',
  Executing = 'executing',
  Delivering = 'delivering',
}

// ═══════════════════════════════════════════════════
// AUDIT SCHEMA TYPES (matches SDK OUTPUT_SCHEMAS.audit)
// ═══════════════════════════════════════════════════

export type Severity = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export type VulnerabilityType =
  | 'reentrancy'
  | 'access_control'
  | 'oracle_manipulation'
  | 'integer_overflow'
  | 'flash_loan'
  | 'front_running'
  | 'logic_errors'
  | 'gas_optimization';

export interface AuditFinding {
  severity: Severity;
  vulnerability_type: VulnerabilityType;
  location: string;
  description: string;
  proof_of_concept: string;
  recommendation: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  summary: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════
// BID TRACKING
// ═══════════════════════════════════════════════════

export interface BidRecord {
  taskId: number;
  salt: string;
  stake: string;       // wei string
  price: string;       // wei string
  eta: number;         // seconds
  commitHash: string;
  criteriaHash: string;
  revealed: boolean;
  assigned: boolean;
  createdAt: number;   // unix timestamp
}

// ═══════════════════════════════════════════════════
// TASK TRACKING
// ═══════════════════════════════════════════════════

export type TrackedTaskStatus =
  | 'watching'      // detected, evaluating
  | 'bid_committed' // we committed a bid
  | 'bid_revealed'  // we revealed our bid
  | 'assigned'      // we won the auction
  | 'executing'     // running analysis
  | 'delivered'     // output delivered
  | 'completed'     // task settled successfully
  | 'failed'        // task failed
  | 'skipped';      // we chose not to bid

export interface TrackedTask {
  taskId: number;
  poster: string;
  bounty: string;           // human-readable USDC
  deadline: number;         // unix timestamp
  bidDeadline: number;      // unix timestamp
  revealDeadline: number;   // unix timestamp
  criteriaHash: string;
  taskType: string;
  status: TrackedTaskStatus;
  ourBid?: BidRecord;
  deliveryHash?: string;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════
// WALLET TRACKING
// ═══════════════════════════════════════════════════

export interface WalletSnapshot {
  balance: string;          // human-readable USDC
  activeStakes: Record<number, string>; // taskId -> stake amount (wei)
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════
// ANALYZER RESULTS
// ═══════════════════════════════════════════════════

export interface AnalyzerResult {
  source: 'slither' | 'mythril' | 'claude';
  findings: AuditFinding[];
  rawOutput?: string;
  error?: string;
}

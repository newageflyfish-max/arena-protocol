/**
 * VerifierAgent — Type Definitions
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

export interface AgentConfig {
  rpcUrl: string;
  privateKey: string;
  arenaCoreAddress: string;
  usdcAddress: string;
  pinataApiKey: string;
  pinataSecret: string;
  anthropicApiKey: string;
  poolStakeUsdc: number;
  autoJoinPool: boolean;
  approvalThreshold: number;      // 0-100
  autoRejectMissedCritical: boolean;
  autoRejectMissedHigh: boolean;
  useComparisonMode: boolean;
  pollIntervalMs: number;
  dataDir: string;
}

// ═══════════════════════════════════════════════════
// AGENT STATE
// ═══════════════════════════════════════════════════

export enum VerifierState {
  Idle = 'idle',
  Monitoring = 'monitoring',
  Analyzing = 'analyzing',
  Voting = 'voting',
}

// ═══════════════════════════════════════════════════
// AUDIT SCHEMA (matches SDK OUTPUT_SCHEMAS.audit)
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
// COMPARISON / SCORING
// ═══════════════════════════════════════════════════

export interface ComparisonResult {
  /** Match score 0-100 (percentage) */
  matchScore: number;
  /** Match score 0-10000 (basis points, for on-chain submission) */
  matchScoreBps: number;
  /** Whether the agent missed critical/high findings we found */
  missedCritical: boolean;
  /** Number of findings the agent reported */
  agentFindingCount: number;
  /** Number of findings we independently found */
  verifierFindingCount: number;
  /** Findings present in both */
  matchedFindings: number;
  /** Findings we found that agent missed */
  missedFindings: AuditFinding[];
  /** Findings agent reported that we didn't find (possible false positives) */
  extraFindings: AuditFinding[];
  /** Severity distribution match analysis */
  severityAnalysis: string;
  /** Overall assessment */
  assessment: string;
}

export type VoteDecision = 'approve' | 'reject';

export interface VerificationDecision {
  vote: VoteDecision;
  reason: string;
  comparison: ComparisonResult;
  reportHash?: string;
}

// ═══════════════════════════════════════════════════
// TASK TRACKING
// ═══════════════════════════════════════════════════

export type TrackedTaskStatus =
  | 'detected'        // we're assigned as verifier, not yet analyzed
  | 'analyzing'       // running independent analysis
  | 'voted'           // vote submitted
  | 'settled'         // task settled
  | 'failed'          // our verification attempt failed
  | 'timed_out';      // we timed out

export interface TrackedVerification {
  taskId: number;
  poster: string;
  agent: string;
  taskType: string;
  bounty: string;
  ourStake: string;
  agentOutputHash: string;
  criteriaHash: string;
  status: TrackedTaskStatus;
  vote?: VoteDecision;
  comparison?: ComparisonResult;
  reportHash?: string;
  detectedAt: number;
  completedAt?: number;
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

// ═══════════════════════════════════════════════════
// WALLET STATE
// ═══════════════════════════════════════════════════

export interface WalletSnapshot {
  balance: string;
  registryStake: string;
  activeVerifications: number;
  lastUpdated: number;
}

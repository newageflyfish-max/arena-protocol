/**
 * TaskPoster Bot — Type Definitions
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

export interface BotConfig {
  rpcUrl: string;
  privateKey: string;
  arenaCoreAddress: string;
  usdcAddress: string;
  complianceAddress: string;  // empty string if not deployed
  pinataApiKey: string;
  pinataSecret: string;

  // Posting
  postIntervalMs: number;
  minBountyUsdc: number;
  maxBountyUsdc: number;
  minBalanceUsdc: number;
  deadlineHours: number;
  slashWindowHours: number;
  bidDurationSeconds: number;
  revealDurationSeconds: number;
  requiredVerifiers: number;

  // Task mix weights
  weightAudit: number;
  weightRiskValidation: number;
  weightCreditScoring: number;

  // Storage
  dataDir: string;
}

// ═══════════════════════════════════════════════════
// TASK TYPES
// ═══════════════════════════════════════════════════

export type PostableTaskType = 'audit' | 'risk_validation' | 'credit_scoring';

export interface TaskTemplate {
  taskType: PostableTaskType;
  criteria: Record<string, unknown>;
  bountyUsdc: number;
  description: string;
}

// ═══════════════════════════════════════════════════
// POSTING RECORDS
// ═══════════════════════════════════════════════════

export interface PostRecord {
  taskId: number;
  taskType: PostableTaskType;
  bountyUsdc: number;
  criteriaHash: string;
  txHash: string;
  postedAt: number;
  description: string;
}

export interface BotStats {
  totalPosted: number;
  totalSpentUsdc: number;
  tasksByType: Record<PostableTaskType, number>;
  lastPostedAt: number;
  startedAt: number;
}

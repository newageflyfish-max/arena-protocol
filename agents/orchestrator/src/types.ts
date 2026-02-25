/**
 * AgentOrchestrator — Type Definitions
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

export type RiskTolerance = 'conservative' | 'medium' | 'aggressive';
export type RiskModelName = 'standard' | 'conservative' | 'defi_native';

export interface OrchestratorConfig {
  // Blockchain
  rpcUrl: string;
  privateKey: string;
  arenaCoreAddress: string;
  usdcAddress: string;

  // IPFS
  pinataApiKey: string;
  pinataSecret: string;

  // AI
  anthropicApiKey: string;

  // Data sources
  defillamaBaseUrl: string;
  coingeckoBaseUrl: string;
  coingeckoApiKey: string;
  mainnetRpcUrl: string;

  // Agent toggles
  enableAuditAgent: boolean;
  enableVerifierAgent: boolean;
  enableRiskAgent: boolean;

  // Bidding defaults
  minBountyUsdc: number;
  maxBidUsdc: number;
  maxStakePercent: number;
  riskTolerance: RiskTolerance;

  // Risk agent
  riskModel: RiskModelName;
  minConfidence: number;

  // Verifier agent
  poolStakeUsdc: number;
  autoJoinPool: boolean;
  approvalThreshold: number;
  autoRejectMissedCritical: boolean;
  useComparisonMode: boolean;

  // Orchestrator
  pollIntervalMs: number;
  dataDir: string;
  dashboardRefreshMs: number;
  autoRestake: boolean;
  autoRestakeThresholdUsdc: number;
}

// ═══════════════════════════════════════════════════
// AGENT REGISTRY
// ═══════════════════════════════════════════════════

export type AgentId = 'audit' | 'verifier' | 'risk';

export type AgentStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopping';

export interface RegisteredAgent {
  id: AgentId;
  name: string;
  taskTypes: string[];       // task types this agent handles
  status: AgentStatus;
  startedAt?: number;
  lastActivity?: number;
  errorMessage?: string;
  instance: AgentInstance;
}

/** Minimal interface every agent must implement */
export interface AgentInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ═══════════════════════════════════════════════════
// TASK TRACKING
// ═══════════════════════════════════════════════════

export interface TrackedTaskEvent {
  taskId: number;
  taskType: string;
  poster: string;
  bounty: string;       // formatted USDC
  deadline: number;
  routedTo: AgentId | null;
  status: TaskEventStatus;
  createdAt: number;
  updatedAt: number;
}

export type TaskEventStatus =
  | 'detected'
  | 'routed'
  | 'bid_committed'
  | 'bid_revealed'
  | 'assigned'
  | 'executing'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'skipped';

// ═══════════════════════════════════════════════════
// NONCE MANAGEMENT
// ═══════════════════════════════════════════════════

export interface NonceSlot {
  nonce: number;
  agentId: AgentId;
  purpose: string;
  acquiredAt: number;
  txHash?: string;
  released: boolean;
}

// ═══════════════════════════════════════════════════
// P&L TRACKING
// ═══════════════════════════════════════════════════

export interface PnlRecord {
  taskId: number;
  agentId: AgentId;
  taskType: string;
  stakeAmount: string;     // USDC staked
  payoutAmount: string;    // USDC received
  slashAmount: string;     // USDC slashed
  netProfit: string;       // payout - stake (or -slash)
  timestamp: number;
  outcome: 'completed' | 'failed' | 'slashed';
}

export interface AgentPnlSummary {
  agentId: AgentId;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  slashedTasks: number;
  totalStaked: number;     // USDC
  totalEarned: number;     // USDC
  totalSlashed: number;    // USDC
  netProfit: number;       // USDC
  winRate: number;         // 0-100%
}

// ═══════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════

export interface DashboardState {
  walletAddress: string;
  usdcBalance: string;
  availableBalance: string;
  ethBalance: string;
  agentStatuses: RegisteredAgent[];
  activeTasks: TrackedTaskEvent[];
  pendingBids: TrackedTaskEvent[];
  recentOutcomes: PnlRecord[];
  pnlSummaries: AgentPnlSummary[];
  totalNetProfit: number;
  uptime: number;         // seconds
}

export interface WalletSnapshot {
  balance: string;
  activeStakes: Record<number, string>;
  lastUpdated: number;
}

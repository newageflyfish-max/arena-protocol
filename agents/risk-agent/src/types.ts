/**
 * RiskAgent — Type Definitions
 */

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════

export type RiskTolerance = 'conservative' | 'medium' | 'aggressive';
export type RiskModelName = 'standard' | 'conservative' | 'defi_native';

export interface AgentConfig {
  rpcUrl: string;
  privateKey: string;
  arenaCoreAddress: string;
  usdcAddress: string;
  pinataApiKey: string;
  pinataSecret: string;
  defillamaBaseUrl: string;
  coingeckoBaseUrl: string;
  coingeckoApiKey: string;
  mainnetRpcUrl: string;
  minBountyUsdc: number;
  maxBidUsdc: number;
  maxStakePercent: number;
  riskTolerance: RiskTolerance;
  riskModel: RiskModelName;
  minConfidence: number;
  pollIntervalMs: number;
  dataDir: string;
}

// ═══════════════════════════════════════════════════
// RISK REPORT (matches SDK OUTPUT_SCHEMAS.risk_validation)
// ═══════════════════════════════════════════════════

export interface RiskFactor {
  name: string;
  category: RiskCategory;
  value: number;           // raw metric value
  score: number;           // normalized 0-100 (higher = riskier)
  weight: number;          // how much this contributes to total (0-1)
  confidence: number;      // data confidence 0-1
  description: string;
  dataSource: string;
}

export type RiskCategory =
  | 'tvl_concentration'
  | 'contract_maturity'
  | 'audit_status'
  | 'token_volatility'
  | 'liquidity_depth'
  | 'protocol_governance'
  | 'historical_incidents';

export interface RiskReport {
  score: number;           // 0-100 (higher = riskier)
  confidence: number;      // 0-1
  factors: RiskFactor[];
  timestamp: number;
}

// ═══════════════════════════════════════════════════
// DATA SOURCE TYPES
// ═══════════════════════════════════════════════════

export interface ProtocolData {
  name: string;
  slug: string;
  tvl: number;
  tvlChange24h: number;
  tvlChange7d: number;
  chains: string[];
  category: string;
  audits: number;
  auditLinks: string[];
  listedAt?: number;       // timestamp when protocol was first tracked
  mcap?: number;
}

export interface TokenData {
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  priceChange7d: number;
  priceChange30d: number;
  marketCap: number;
  volume24h: number;
  volatility30d: number;   // calculated
  ath: number;
  athDate: string;
  atl: number;
  atlDate: string;
}

export interface LiquidityData {
  totalLiquidity: number;
  depth2Percent: number;   // liquidity within 2% of spot
  depth5Percent: number;   // liquidity within 5% of spot
  poolCount: number;
  largestPoolShare: number; // % of total in largest pool
}

export interface ContractData {
  address: string;
  chain: string;
  deployedAt: number;      // block timestamp
  ageInDays: number;
  verified: boolean;
  proxyPattern: boolean;
  upgradeableAdmin?: string;
}

/** Aggregated data for risk assessment */
export interface PositionContext {
  protocol?: ProtocolData;
  token?: TokenData;
  liquidity?: LiquidityData;
  contract?: ContractData;
  rawCriteria: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════
// RISK MODEL
// ═══════════════════════════════════════════════════

export interface RiskModelWeights {
  tvl_concentration: number;
  contract_maturity: number;
  audit_status: number;
  token_volatility: number;
  liquidity_depth: number;
  protocol_governance: number;
  historical_incidents: number;
}

// ═══════════════════════════════════════════════════
// BID & TASK TRACKING
// ═══════════════════════════════════════════════════

export interface BidRecord {
  taskId: number;
  salt: string;
  stake: string;
  price: string;
  eta: number;
  commitHash: string;
  criteriaHash: string;
  revealed: boolean;
  assigned: boolean;
  createdAt: number;
}

export type TrackedTaskStatus =
  | 'watching'
  | 'bid_committed'
  | 'bid_revealed'
  | 'assigned'
  | 'executing'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface TrackedTask {
  taskId: number;
  poster: string;
  bounty: string;
  deadline: number;
  bidDeadline: number;
  revealDeadline: number;
  criteriaHash: string;
  taskType: string;
  status: TrackedTaskStatus;
  ourBid?: BidRecord;
  deliveryHash?: string;
  updatedAt: number;
}

export interface WalletSnapshot {
  balance: string;
  activeStakes: Record<number, string>;
  lastUpdated: number;
}

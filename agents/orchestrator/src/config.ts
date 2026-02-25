/**
 * AgentOrchestrator — Configuration Loader
 */

import 'dotenv/config';
import type { OrchestratorConfig, RiskTolerance, RiskModelName } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (!v) return defaultValue;
  return v === 'true' || v === '1' || v === 'yes';
}

export function loadConfig(): OrchestratorConfig {
  const riskTolerance = optionalEnv('RISK_TOLERANCE', 'medium') as RiskTolerance;
  if (!['conservative', 'medium', 'aggressive'].includes(riskTolerance)) {
    throw new Error(`Invalid RISK_TOLERANCE: "${riskTolerance}"`);
  }

  const riskModel = optionalEnv('RISK_MODEL', 'standard') as RiskModelName;
  if (!['standard', 'conservative', 'defi_native'].includes(riskModel)) {
    throw new Error(`Invalid RISK_MODEL: "${riskModel}"`);
  }

  const enableAudit = optionalBool('ENABLE_AUDIT_AGENT', true);
  const enableVerifier = optionalBool('ENABLE_VERIFIER_AGENT', true);
  const enableRisk = optionalBool('ENABLE_RISK_AGENT', true);

  // Anthropic key required only if audit or verifier agents enabled
  const anthropicApiKey = (enableAudit || enableVerifier)
    ? requireEnv('ANTHROPIC_API_KEY')
    : optionalEnv('ANTHROPIC_API_KEY', '');

  return {
    rpcUrl: requireEnv('RPC_URL'),
    privateKey: requireEnv('PRIVATE_KEY'),
    arenaCoreAddress: requireEnv('ARENA_CORE_ADDRESS'),
    usdcAddress: requireEnv('USDC_ADDRESS'),
    pinataApiKey: requireEnv('PINATA_API_KEY'),
    pinataSecret: requireEnv('PINATA_SECRET'),
    anthropicApiKey,
    defillamaBaseUrl: optionalEnv('DEFILLAMA_BASE_URL', 'https://api.llama.fi'),
    coingeckoBaseUrl: optionalEnv('COINGECKO_BASE_URL', 'https://api.coingecko.com/api/v3'),
    coingeckoApiKey: optionalEnv('COINGECKO_API_KEY', ''),
    mainnetRpcUrl: optionalEnv('MAINNET_RPC_URL', 'https://eth.llamarpc.com'),
    enableAuditAgent: enableAudit,
    enableVerifierAgent: enableVerifier,
    enableRiskAgent: enableRisk,
    minBountyUsdc: parseInt(optionalEnv('MIN_BOUNTY_USDC', '50'), 10),
    maxBidUsdc: parseInt(optionalEnv('MAX_BID_USDC', '5000'), 10),
    maxStakePercent: parseInt(optionalEnv('MAX_STAKE_PERCENT', '20'), 10),
    riskTolerance,
    riskModel,
    minConfidence: parseFloat(optionalEnv('MIN_CONFIDENCE', '0.5')),
    poolStakeUsdc: parseInt(optionalEnv('POOL_STAKE_USDC', '500'), 10),
    autoJoinPool: optionalBool('AUTO_JOIN_POOL', true),
    approvalThreshold: parseInt(optionalEnv('APPROVAL_THRESHOLD', '70'), 10),
    autoRejectMissedCritical: optionalBool('AUTO_REJECT_MISSED_CRITICAL', true),
    useComparisonMode: optionalBool('USE_COMPARISON_MODE', true),
    pollIntervalMs: parseInt(optionalEnv('POLL_INTERVAL_MS', '30000'), 10),
    dataDir: optionalEnv('DATA_DIR', './data'),
    dashboardRefreshMs: parseInt(optionalEnv('DASHBOARD_REFRESH_MS', '2000'), 10),
    autoRestake: optionalBool('AUTO_RESTAKE', true),
    autoRestakeThresholdUsdc: parseInt(optionalEnv('AUTO_RESTAKE_THRESHOLD_USDC', '100'), 10),
  };
}

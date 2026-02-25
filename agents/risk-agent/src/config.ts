/**
 * RiskAgent — Configuration Loader
 */

import 'dotenv/config';
import type { AgentConfig, RiskTolerance, RiskModelName } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): AgentConfig {
  const riskTolerance = optionalEnv('RISK_TOLERANCE', 'medium') as RiskTolerance;
  if (!['conservative', 'medium', 'aggressive'].includes(riskTolerance)) {
    throw new Error(`Invalid RISK_TOLERANCE: "${riskTolerance}"`);
  }

  const riskModel = optionalEnv('RISK_MODEL', 'standard') as RiskModelName;
  if (!['standard', 'conservative', 'defi_native'].includes(riskModel)) {
    throw new Error(`Invalid RISK_MODEL: "${riskModel}"`);
  }

  const config: AgentConfig = {
    rpcUrl: requireEnv('RPC_URL'),
    privateKey: requireEnv('PRIVATE_KEY'),
    arenaCoreAddress: requireEnv('ARENA_CORE_ADDRESS'),
    usdcAddress: requireEnv('USDC_ADDRESS'),
    pinataApiKey: requireEnv('PINATA_API_KEY'),
    pinataSecret: requireEnv('PINATA_SECRET'),
    defillamaBaseUrl: optionalEnv('DEFILLAMA_BASE_URL', 'https://api.llama.fi'),
    coingeckoBaseUrl: optionalEnv('COINGECKO_BASE_URL', 'https://api.coingecko.com/api/v3'),
    coingeckoApiKey: optionalEnv('COINGECKO_API_KEY', ''),
    mainnetRpcUrl: optionalEnv('MAINNET_RPC_URL', 'https://eth.llamarpc.com'),
    minBountyUsdc: parseInt(optionalEnv('MIN_BOUNTY_USDC', '50'), 10),
    maxBidUsdc: parseInt(optionalEnv('MAX_BID_USDC', '3000'), 10),
    maxStakePercent: parseInt(optionalEnv('MAX_STAKE_PERCENT', '15'), 10),
    riskTolerance,
    riskModel,
    minConfidence: parseFloat(optionalEnv('MIN_CONFIDENCE', '0.5')),
    pollIntervalMs: parseInt(optionalEnv('POLL_INTERVAL_MS', '30000'), 10),
    dataDir: optionalEnv('DATA_DIR', './data'),
  };

  if (config.maxStakePercent < 1 || config.maxStakePercent > 100) {
    throw new Error(`MAX_STAKE_PERCENT must be 1-100`);
  }
  if (config.minConfidence < 0 || config.minConfidence > 1) {
    throw new Error(`MIN_CONFIDENCE must be 0-1`);
  }
  if (config.pollIntervalMs < 5000) {
    throw new Error(`POLL_INTERVAL_MS must be >= 5000`);
  }

  return config;
}

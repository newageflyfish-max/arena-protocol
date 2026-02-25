/**
 * AuditAgent — Configuration Loader
 *
 * Loads and validates environment variables into a typed AgentConfig.
 */

import 'dotenv/config';
import type { AgentConfig, RiskTolerance } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function parseRiskTolerance(value: string): RiskTolerance {
  const valid: RiskTolerance[] = ['conservative', 'medium', 'aggressive'];
  if (!valid.includes(value as RiskTolerance)) {
    throw new Error(`Invalid RISK_TOLERANCE: "${value}". Must be one of: ${valid.join(', ')}`);
  }
  return value as RiskTolerance;
}

export function loadConfig(): AgentConfig {
  const config: AgentConfig = {
    rpcUrl: requireEnv('RPC_URL'),
    privateKey: requireEnv('PRIVATE_KEY'),
    arenaCoreAddress: requireEnv('ARENA_CORE_ADDRESS'),
    usdcAddress: requireEnv('USDC_ADDRESS'),
    pinataApiKey: requireEnv('PINATA_API_KEY'),
    pinataSecret: requireEnv('PINATA_SECRET'),
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    minBountyUsdc: parseInt(optionalEnv('MIN_BOUNTY_USDC', '100'), 10),
    maxBidUsdc: parseInt(optionalEnv('MAX_BID_USDC', '5000'), 10),
    maxStakePercent: parseInt(optionalEnv('MAX_STAKE_PERCENT', '20'), 10),
    riskTolerance: parseRiskTolerance(optionalEnv('RISK_TOLERANCE', 'medium')),
    pollIntervalMs: parseInt(optionalEnv('POLL_INTERVAL_MS', '30000'), 10),
    dataDir: optionalEnv('DATA_DIR', './data'),
  };

  // Validation
  if (config.maxStakePercent < 1 || config.maxStakePercent > 100) {
    throw new Error(`MAX_STAKE_PERCENT must be between 1 and 100, got ${config.maxStakePercent}`);
  }
  if (config.minBountyUsdc < 0) {
    throw new Error(`MIN_BOUNTY_USDC must be non-negative`);
  }
  if (config.pollIntervalMs < 5000) {
    throw new Error(`POLL_INTERVAL_MS must be at least 5000ms`);
  }

  return config;
}

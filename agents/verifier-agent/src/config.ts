/**
 * VerifierAgent — Configuration Loader
 */

import 'dotenv/config';
import type { AgentConfig } from './types.js';

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

function parseBool(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
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
    poolStakeUsdc: parseInt(optionalEnv('POOL_STAKE_USDC', '500'), 10),
    autoJoinPool: parseBool(optionalEnv('AUTO_JOIN_POOL', 'true')),
    approvalThreshold: parseInt(optionalEnv('APPROVAL_THRESHOLD', '70'), 10),
    autoRejectMissedCritical: parseBool(optionalEnv('AUTO_REJECT_MISSED_CRITICAL', 'true')),
    autoRejectMissedHigh: parseBool(optionalEnv('AUTO_REJECT_MISSED_HIGH', 'false')),
    useComparisonMode: parseBool(optionalEnv('USE_COMPARISON_MODE', 'true')),
    pollIntervalMs: parseInt(optionalEnv('POLL_INTERVAL_MS', '15000'), 10),
    dataDir: optionalEnv('DATA_DIR', './data'),
  };

  // Validation
  if (config.approvalThreshold < 0 || config.approvalThreshold > 100) {
    throw new Error(`APPROVAL_THRESHOLD must be between 0 and 100, got ${config.approvalThreshold}`);
  }
  if (config.poolStakeUsdc < 1) {
    throw new Error(`POOL_STAKE_USDC must be at least 1`);
  }
  if (config.pollIntervalMs < 5000) {
    throw new Error(`POLL_INTERVAL_MS must be at least 5000ms`);
  }

  return config;
}

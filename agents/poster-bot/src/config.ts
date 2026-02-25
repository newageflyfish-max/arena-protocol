/**
 * TaskPoster Bot — Configuration Loader
 */

import 'dotenv/config';
import type { BotConfig } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): BotConfig {
  const config: BotConfig = {
    rpcUrl: requireEnv('RPC_URL'),
    privateKey: requireEnv('PRIVATE_KEY'),
    arenaCoreAddress: requireEnv('ARENA_CORE_ADDRESS'),
    usdcAddress: requireEnv('USDC_ADDRESS'),
    complianceAddress: optionalEnv('COMPLIANCE_ADDRESS', ''),
    pinataApiKey: requireEnv('PINATA_API_KEY'),
    pinataSecret: requireEnv('PINATA_SECRET'),

    postIntervalMs: parseInt(optionalEnv('POST_INTERVAL_MS', '600000'), 10),
    minBountyUsdc: parseInt(optionalEnv('MIN_BOUNTY_USDC', '100'), 10),
    maxBountyUsdc: parseInt(optionalEnv('MAX_BOUNTY_USDC', '2500'), 10),
    minBalanceUsdc: parseInt(optionalEnv('MIN_BALANCE_USDC', '500'), 10),
    deadlineHours: parseInt(optionalEnv('DEADLINE_HOURS', '24'), 10),
    slashWindowHours: parseInt(optionalEnv('SLASH_WINDOW_HOURS', '168'), 10),
    bidDurationSeconds: parseInt(optionalEnv('BID_DURATION_SECONDS', '3600'), 10),
    revealDurationSeconds: parseInt(optionalEnv('REVEAL_DURATION_SECONDS', '1800'), 10),
    requiredVerifiers: parseInt(optionalEnv('REQUIRED_VERIFIERS', '3'), 10),

    weightAudit: parseInt(optionalEnv('WEIGHT_AUDIT', '5'), 10),
    weightRiskValidation: parseInt(optionalEnv('WEIGHT_RISK_VALIDATION', '3'), 10),
    weightCreditScoring: parseInt(optionalEnv('WEIGHT_CREDIT_SCORING', '2'), 10),

    dataDir: optionalEnv('DATA_DIR', './data'),
  };

  if (config.postIntervalMs < 30_000) {
    throw new Error('POST_INTERVAL_MS must be >= 30000 (30 seconds)');
  }
  if (config.minBountyUsdc < 50) {
    throw new Error('MIN_BOUNTY_USDC must be >= 50 (ArenaCore minimum)');
  }
  if (config.maxBountyUsdc < config.minBountyUsdc) {
    throw new Error('MAX_BOUNTY_USDC must be >= MIN_BOUNTY_USDC');
  }
  if (config.requiredVerifiers < 1 || config.requiredVerifiers > 5) {
    throw new Error('REQUIRED_VERIFIERS must be 1-5');
  }

  return config;
}

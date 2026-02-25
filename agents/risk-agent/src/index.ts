/**
 * RiskAgent — Entry Point
 *
 * Autonomous DeFi position risk scoring agent for The Arena protocol.
 * Monitors for risk_validation tasks, bids, analyzes positions, delivers reports.
 */

import { loadConfig } from './config.js';
import { RiskAgent } from './agent.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'main' });

async function main(): Promise<void> {
  log.info('Loading configuration...');
  const config = loadConfig();

  log.info(
    {
      rpcUrl: config.rpcUrl.replace(/\/[^/]+$/, '/***'),
      arenaCoreAddress: config.arenaCoreAddress,
      riskModel: config.riskModel,
      riskTolerance: config.riskTolerance,
      minBounty: config.minBountyUsdc + ' USDC',
      maxBid: config.maxBidUsdc + ' USDC',
      maxStakePercent: config.maxStakePercent + '%',
      minConfidence: config.minConfidence,
      pollInterval: config.pollIntervalMs + 'ms',
    },
    'Configuration loaded'
  );

  const agent = new RiskAgent(config);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (err: any) => {
    log.error({ err: err?.message || String(err) }, 'Unhandled rejection');
  });

  await agent.start();
}

main().catch((err) => {
  log.fatal({ err: err.message }, 'Failed to start RiskAgent');
  process.exit(1);
});

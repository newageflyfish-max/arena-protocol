/**
 * AuditAgent — Entry Point
 *
 * Loads configuration, initializes the agent, and starts monitoring.
 * Handles graceful shutdown on SIGINT/SIGTERM.
 */

import { loadConfig } from './config.js';
import { AuditAgent } from './agent.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  logger.info('');
  logger.info('  ╔═══════════════════════════════════════════╗');
  logger.info('  ║     The Arena — AuditAgent v0.1.0         ║');
  logger.info('  ║     Autonomous Smart Contract Auditor     ║');
  logger.info('  ╚═══════════════════════════════════════════╝');
  logger.info('');

  // Load and validate configuration
  let config;
  try {
    config = loadConfig();
    logger.info(
      {
        rpcUrl: config.rpcUrl,
        arenaCoreAddress: config.arenaCoreAddress,
        riskTolerance: config.riskTolerance,
        minBounty: `${config.minBountyUsdc} USDC`,
        maxBid: `${config.maxBidUsdc} USDC`,
        maxStakePercent: `${config.maxStakePercent}%`,
      },
      'Configuration loaded'
    );
  } catch (err: any) {
    logger.fatal({ err: err.message }, 'Failed to load configuration');
    process.exit(1);
  }

  // Create and start agent
  const agent = new AuditAgent(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start
  try {
    await agent.start();
  } catch (err: any) {
    logger.fatal({ err: err.message }, 'Agent failed to start');
    process.exit(1);
  }
}

// Top-level error boundary
main().catch((err) => {
  logger.fatal({ err }, 'Unhandled fatal error');
  process.exit(1);
});

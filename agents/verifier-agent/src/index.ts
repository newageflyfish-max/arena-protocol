/**
 * VerifierAgent — Entry Point
 *
 * Loads configuration, initializes the agent, and starts monitoring.
 * Handles graceful shutdown on SIGINT/SIGTERM.
 */

import { loadConfig } from './config.js';
import { VerifierAgent } from './agent.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  logger.info('');
  logger.info('  ╔═══════════════════════════════════════════╗');
  logger.info('  ║     The Arena — VerifierAgent v0.1.0      ║');
  logger.info('  ║     Autonomous Verification Agent         ║');
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
        poolStake: `${config.poolStakeUsdc} USDC`,
        autoJoinPool: config.autoJoinPool,
        approvalThreshold: `${config.approvalThreshold}%`,
        autoRejectMissedCritical: config.autoRejectMissedCritical,
        autoRejectMissedHigh: config.autoRejectMissedHigh,
        useComparisonMode: config.useComparisonMode,
      },
      'Configuration loaded'
    );
  } catch (err: any) {
    logger.fatal({ err: err.message }, 'Failed to load configuration');
    process.exit(1);
  }

  // Create and start agent
  const agent = new VerifierAgent(config);

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

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled fatal error');
  process.exit(1);
});

/**
 * TaskPoster Bot — Entry Point
 *
 * Creates sample tasks on testnet at regular intervals
 * to keep the Arena protocol active and give agents work.
 */

import { loadConfig } from './config.js';
import { PosterBot } from './bot.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'main' });

async function main(): Promise<void> {
  log.info('Loading poster bot configuration...');
  const config = loadConfig();

  log.info({
    rpcUrl: config.rpcUrl.replace(/\/[^/]+$/, '/***'),
    arenaCoreAddress: config.arenaCoreAddress,
    interval: config.postIntervalMs + 'ms',
    bountyRange: `${config.minBountyUsdc}-${config.maxBountyUsdc} USDC`,
    minBalance: config.minBalanceUsdc + ' USDC',
  }, 'Configuration loaded');

  const bot = new PosterBot(config);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutdown signal received');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    bot.stop().then(() => process.exit(1)).catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (err: any) => {
    log.error({ err: err?.message || String(err) }, 'Unhandled rejection');
  });

  await bot.start();
}

main().catch((err) => {
  log.fatal({ err: err.message }, 'Failed to start PosterBot');
  process.exit(1);
});

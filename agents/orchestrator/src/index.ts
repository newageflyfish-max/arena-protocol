/**
 * AgentOrchestrator — Entry Point
 *
 * Run all Arena agents with a single command.
 * Provides nonce-managed wallet, P&L tracking, task routing,
 * and a terminal dashboard.
 */

import { loadConfig } from './config.js';
import { AgentOrchestrator } from './orchestrator.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'main' });

async function main(): Promise<void> {
  log.info('Loading orchestrator configuration...');
  const config = loadConfig();

  const enabledAgents: string[] = [];
  if (config.enableAuditAgent) enabledAgents.push('audit');
  if (config.enableVerifierAgent) enabledAgents.push('verifier');
  if (config.enableRiskAgent) enabledAgents.push('risk');

  if (enabledAgents.length === 0) {
    log.error('No agents enabled! Set at least one ENABLE_*_AGENT=true in .env');
    process.exit(1);
  }

  log.info({
    enabledAgents,
    rpcUrl: config.rpcUrl.replace(/\/[^/]+$/, '/***'),
    arenaCoreAddress: config.arenaCoreAddress,
    autoRestake: config.autoRestake,
    dashboardRefresh: config.dashboardRefreshMs + 'ms',
  }, 'Configuration loaded');

  // Determine if we should use the dashboard
  const noDashboard = process.argv.includes('--no-dashboard') || process.env.NO_DASHBOARD === 'true';
  const orchestrator = new AgentOrchestrator(config, !noDashboard);

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutdown signal received');
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    orchestrator.stop().then(() => process.exit(1)).catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (err: any) => {
    log.error({ err: err?.message || String(err) }, 'Unhandled rejection');
  });

  await orchestrator.start();
}

main().catch((err) => {
  log.fatal({ err: err.message }, 'Failed to start AgentOrchestrator');
  process.exit(1);
});

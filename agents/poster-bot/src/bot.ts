/**
 * TaskPoster Bot — Main Daemon
 *
 * Periodically creates tasks on the Arena protocol to keep it active.
 * Selects task types based on configured weights, generates realistic
 * criteria, pins to IPFS, and posts on-chain.
 */

import type { BotConfig } from './types.js';
import { TaskPoster } from './poster.js';
import { selectTaskType, generateTask } from './templates.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'bot' });

export class PosterBot {
  private config: BotConfig;
  private poster: TaskPoster;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private startTime = 0;
  private consecutiveFailures = 0;
  private maxConsecutiveFailures = 5;

  constructor(config: BotConfig) {
    this.config = config;
    this.poster = new TaskPoster(config);
  }

  // ═══════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();

    log.info('╔══════════════════════════════════════════════════╗');
    log.info('║         ARENA TASK POSTER BOT                   ║');
    log.info('╚══════════════════════════════════════════════════╝');

    await this.poster.logStatus();

    const stats = this.poster.getStats();
    const taskMix = [
      `audit:${this.config.weightAudit}`,
      `risk:${this.config.weightRiskValidation}`,
      `credit:${this.config.weightCreditScoring}`,
    ].join(', ');

    log.info({
      address: this.poster.address,
      interval: formatDuration(this.config.postIntervalMs),
      bountyRange: `${this.config.minBountyUsdc}-${this.config.maxBountyUsdc} USDC`,
      minBalance: this.config.minBalanceUsdc + ' USDC',
      deadline: this.config.deadlineHours + 'h',
      verifiers: this.config.requiredVerifiers,
      taskMix,
      previouslyPosted: stats.totalPosted,
    }, 'Bot configuration');

    // Ensure ToS accepted before starting
    try {
      await this.poster.ensureToS();
    } catch (err: any) {
      log.warn({ err: err.message }, 'ToS acceptance failed — will retry on first post');
    }

    // Start posting loop
    this.timer = setInterval(() => {
      this.postCycle().catch((err: any) =>
        log.error({ err: err.message }, 'Post cycle error')
      );
    }, this.config.postIntervalMs);

    // Post first task after a short delay (let RPC settle)
    const initialDelay = Math.min(10_000, this.config.postIntervalMs / 2);
    log.info({ delayMs: initialDelay }, 'First post in...');
    setTimeout(() => {
      this.postCycle().catch((err: any) =>
        log.error({ err: err.message }, 'Initial post cycle error')
      );
    }, initialDelay);

    log.info('Poster bot running — will create tasks at regular intervals');
  }

  async stop(): Promise<void> {
    log.info('Stopping poster bot...');
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Print final stats
    const stats = this.poster.getStats();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    log.info({
      uptime: formatDuration(uptime * 1000),
      totalPosted: stats.totalPosted,
      totalSpent: stats.totalSpentUsdc.toFixed(2) + ' USDC',
      byType: stats.tasksByType,
    }, 'Poster bot final stats');

    log.info('Poster bot stopped');
  }

  // ═══════════════════════════════════════════════════
  // POST CYCLE
  // ═══════════════════════════════════════════════════

  private async postCycle(): Promise<void> {
    if (!this.running) return;

    try {
      // Check balance
      const balance = await this.poster.getUsdcBalance();
      if (balance < this.config.minBalanceUsdc) {
        log.warn(
          { balance: balance.toFixed(2), threshold: this.config.minBalanceUsdc },
          'Balance below threshold — pausing posts'
        );
        return;
      }

      // Select task type
      const taskType = selectTaskType(this.config);

      // Generate task
      const template = generateTask(taskType, this.config);

      // Post it
      log.info('─────────────────────────────────────');
      log.info(
        { taskType, bounty: template.bountyUsdc, description: template.description },
        'Posting new task'
      );

      const record = await this.poster.postTask(template);

      if (record) {
        this.consecutiveFailures = 0;

        // Print running stats
        const stats = this.poster.getStats();
        const nextPost = new Date(Date.now() + this.config.postIntervalMs);
        log.info({
          taskId: record.taskId,
          totalPosted: stats.totalPosted,
          totalSpent: stats.totalSpentUsdc.toFixed(2) + ' USDC',
          remainingBalance: (balance - template.bountyUsdc).toFixed(2) + ' USDC',
          nextPost: nextPost.toISOString(),
        }, 'Post cycle complete');
      } else {
        this.consecutiveFailures++;
        log.warn(
          { failures: this.consecutiveFailures, max: this.maxConsecutiveFailures },
          'Post failed'
        );

        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          log.error('Too many consecutive failures — stopping bot');
          await this.stop();
        }
      }
    } catch (err: any) {
      this.consecutiveFailures++;
      log.error({ err: err.message }, 'Post cycle error');
    }
  }
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * AgentOrchestrator — P&L Tracker
 *
 * Tracks profit and loss per agent. Records earnings from task completions
 * and losses from slashings. Supports auto-restaking of earnings.
 */

import { ethers } from 'ethers';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentId,
  PnlRecord,
  AgentPnlSummary,
  OrchestratorConfig,
} from './types.js';
import { pnlLog } from './logger.js';

const log = pnlLog;

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

export class PnlTracker {
  private config: OrchestratorConfig;
  private records: PnlRecord[] = [];
  private stakeTracker = new Map<number, { agentId: AgentId; amount: string }>();
  private pnlFile: string;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.pnlFile = join(config.dataDir, 'pnl.json');
    this.loadRecords();
    log.info({ recordCount: this.records.length }, 'P&L tracker initialized');
  }

  // ═══════════════════════════════════════════════════
  // RECORDING
  // ═══════════════════════════════════════════════════

  /**
   * Record that a stake was placed for a task.
   */
  recordStake(taskId: number, agentId: AgentId, stakeAmount: string): void {
    this.stakeTracker.set(taskId, { agentId, amount: stakeAmount });
    log.debug({ taskId, agentId, stakeAmount }, 'Stake recorded');
  }

  /**
   * Record a task completion with payout.
   */
  recordCompletion(
    taskId: number,
    agentId: AgentId,
    taskType: string,
    payoutAmount: string
  ): void {
    const stakeInfo = this.stakeTracker.get(taskId);
    const stakeAmount = stakeInfo?.amount || '0';
    const payout = parseFloat(payoutAmount);
    const stake = parseFloat(stakeAmount);
    const netProfit = payout - stake;

    const record: PnlRecord = {
      taskId,
      agentId,
      taskType,
      stakeAmount,
      payoutAmount,
      slashAmount: '0',
      netProfit: netProfit.toFixed(2),
      timestamp: Date.now(),
      outcome: 'completed',
    };

    this.records.push(record);
    this.stakeTracker.delete(taskId);
    this.saveRecords();

    log.info(
      { taskId, agentId, payout: payoutAmount, stake: stakeAmount, net: record.netProfit },
      netProfit >= 0 ? 'Task completed — profit' : 'Task completed — net loss'
    );
  }

  /**
   * Record a task failure (stake returned, no payout).
   */
  recordFailure(taskId: number, agentId: AgentId, taskType: string): void {
    const stakeInfo = this.stakeTracker.get(taskId);

    const record: PnlRecord = {
      taskId,
      agentId,
      taskType,
      stakeAmount: stakeInfo?.amount || '0',
      payoutAmount: '0',
      slashAmount: '0',
      netProfit: '0',
      timestamp: Date.now(),
      outcome: 'failed',
    };

    this.records.push(record);
    this.stakeTracker.delete(taskId);
    this.saveRecords();

    log.info({ taskId, agentId }, 'Task failed — stake returned');
  }

  /**
   * Record a slash event.
   */
  recordSlash(
    taskId: number,
    agentId: AgentId,
    taskType: string,
    slashAmount: string
  ): void {
    const stakeInfo = this.stakeTracker.get(taskId);
    const slash = parseFloat(slashAmount);

    const record: PnlRecord = {
      taskId,
      agentId,
      taskType,
      stakeAmount: stakeInfo?.amount || '0',
      payoutAmount: '0',
      slashAmount,
      netProfit: (-slash).toFixed(2),
      timestamp: Date.now(),
      outcome: 'slashed',
    };

    this.records.push(record);
    this.stakeTracker.delete(taskId);
    this.saveRecords();

    log.warn({ taskId, agentId, slashAmount }, 'Agent slashed — capital lost');
  }

  // ═══════════════════════════════════════════════════
  // SUMMARIES
  // ═══════════════════════════════════════════════════

  /**
   * Get P&L summary for a specific agent.
   */
  getSummary(agentId: AgentId): AgentPnlSummary {
    const agentRecords = this.records.filter((r) => r.agentId === agentId);

    let totalStaked = 0;
    let totalEarned = 0;
    let totalSlashed = 0;
    let completed = 0;
    let failed = 0;
    let slashed = 0;

    for (const r of agentRecords) {
      totalStaked += parseFloat(r.stakeAmount);
      totalEarned += parseFloat(r.payoutAmount);
      totalSlashed += parseFloat(r.slashAmount);
      if (r.outcome === 'completed') completed++;
      else if (r.outcome === 'failed') failed++;
      else if (r.outcome === 'slashed') slashed++;
    }

    const total = agentRecords.length;
    const winRate = total > 0 ? (completed / total) * 100 : 0;

    return {
      agentId,
      totalTasks: total,
      completedTasks: completed,
      failedTasks: failed,
      slashedTasks: slashed,
      totalStaked: Math.round(totalStaked * 100) / 100,
      totalEarned: Math.round(totalEarned * 100) / 100,
      totalSlashed: Math.round(totalSlashed * 100) / 100,
      netProfit: Math.round((totalEarned - totalStaked - totalSlashed) * 100) / 100,
      winRate: Math.round(winRate * 10) / 10,
    };
  }

  /**
   * Get summaries for all agents.
   */
  getAllSummaries(): AgentPnlSummary[] {
    const agentIds: AgentId[] = ['audit', 'verifier', 'risk'];
    return agentIds.map((id) => this.getSummary(id));
  }

  /**
   * Get total net profit across all agents.
   */
  getTotalNetProfit(): number {
    return this.getAllSummaries().reduce((sum, s) => sum + s.netProfit, 0);
  }

  /**
   * Get recent P&L records (last N).
   */
  getRecentRecords(limit = 20): PnlRecord[] {
    return this.records.slice(-limit);
  }

  // ═══════════════════════════════════════════════════
  // AUTO-RESTAKE
  // ═══════════════════════════════════════════════════

  /**
   * Check if auto-restake conditions are met and log recommendation.
   * The actual restaking happens naturally — earned USDC stays in the wallet
   * and becomes available for future bids. This method tracks the event.
   */
  async checkAutoRestake(walletBalance: number): Promise<void> {
    if (!this.config.autoRestake) return;

    const netProfit = this.getTotalNetProfit();
    if (netProfit >= this.config.autoRestakeThresholdUsdc) {
      log.info(
        {
          netProfit: netProfit.toFixed(2),
          threshold: this.config.autoRestakeThresholdUsdc,
          walletBalance: walletBalance.toFixed(2),
        },
        'Auto-restake active — earnings available for future bids'
      );
    }
  }

  // ═══════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════

  private loadRecords(): void {
    try {
      if (existsSync(this.pnlFile)) {
        this.records = JSON.parse(readFileSync(this.pnlFile, 'utf-8'));
      }
    } catch {
      this.records = [];
    }
  }

  private saveRecords(): void {
    try {
      const tmp = this.pnlFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8');
      renameSync(tmp, this.pnlFile);
    } catch (err: any) {
      log.error({ err: err.message }, 'Failed to save P&L records');
    }
  }

  /**
   * Prune old records (keep last 500).
   */
  pruneOldRecords(): void {
    if (this.records.length > 500) {
      this.records = this.records.slice(-500);
      this.saveRecords();
    }
  }
}

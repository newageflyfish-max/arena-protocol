/**
 * AuditAgent — File-Backed Persistence
 *
 * Stores bid records, task states, and wallet snapshots to disk.
 * Uses atomic writes (write to .tmp then rename) to prevent corruption.
 *
 * CRITICAL: Bid salts must never be lost — losing a salt means the agent
 * cannot reveal its bid, forfeiting the stake. Persistence is mandatory.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BidRecord, TrackedTask, WalletSnapshot } from './types.js';
import { persistLog } from './logger.js';

export class Persistence {
  private dataDir: string;
  private bidsFile: string;
  private tasksFile: string;
  private walletFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.bidsFile = join(dataDir, 'bids.json');
    this.tasksFile = join(dataDir, 'tasks.json');
    this.walletFile = join(dataDir, 'wallet.json');

    // Ensure data directory exists
    mkdirSync(dataDir, { recursive: true });
    persistLog.info({ dataDir }, 'Persistence initialized');
  }

  // ═══════════════════════════════════════════════════
  // ATOMIC WRITE
  // ═══════════════════════════════════════════════════

  private atomicWrite(filePath: string, data: unknown): void {
    const tmpPath = filePath + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      persistLog.error({ err, filePath }, 'Failed to write file');
      throw err;
    }
  }

  private readJSON<T>(filePath: string, fallback: T): T {
    try {
      if (!existsSync(filePath)) return fallback;
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      persistLog.warn({ err, filePath }, 'Failed to read file, using fallback');
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════
  // BID RECORDS
  // ═══════════════════════════════════════════════════

  saveBidRecord(record: BidRecord): void {
    const records = this.loadBidRecords();
    // Upsert by taskId
    const idx = records.findIndex((r) => r.taskId === record.taskId);
    if (idx >= 0) {
      records[idx] = record;
    } else {
      records.push(record);
    }
    this.atomicWrite(this.bidsFile, records);
    persistLog.debug({ taskId: record.taskId }, 'Bid record saved');
  }

  loadBidRecords(): BidRecord[] {
    return this.readJSON<BidRecord[]>(this.bidsFile, []);
  }

  getBidRecord(taskId: number): BidRecord | undefined {
    return this.loadBidRecords().find((r) => r.taskId === taskId);
  }

  updateBidRecord(taskId: number, updates: Partial<BidRecord>): void {
    const records = this.loadBidRecords();
    const idx = records.findIndex((r) => r.taskId === taskId);
    if (idx >= 0) {
      records[idx] = { ...records[idx], ...updates };
      this.atomicWrite(this.bidsFile, records);
      persistLog.debug({ taskId, updates }, 'Bid record updated');
    }
  }

  // ═══════════════════════════════════════════════════
  // TASK STATES
  // ═══════════════════════════════════════════════════

  saveTaskState(task: TrackedTask): void {
    const tasks = this.loadTaskStates();
    const idx = tasks.findIndex((t) => t.taskId === task.taskId);
    if (idx >= 0) {
      tasks[idx] = task;
    } else {
      tasks.push(task);
    }
    this.atomicWrite(this.tasksFile, tasks);
  }

  loadTaskStates(): TrackedTask[] {
    return this.readJSON<TrackedTask[]>(this.tasksFile, []);
  }

  getTaskState(taskId: number): TrackedTask | undefined {
    return this.loadTaskStates().find((t) => t.taskId === taskId);
  }

  updateTaskState(taskId: number, updates: Partial<TrackedTask>): void {
    const tasks = this.loadTaskStates();
    const idx = tasks.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...updates, updatedAt: Date.now() };
      this.atomicWrite(this.tasksFile, tasks);
    }
  }

  // ═══════════════════════════════════════════════════
  // WALLET SNAPSHOT
  // ═══════════════════════════════════════════════════

  saveWalletSnapshot(snapshot: WalletSnapshot): void {
    this.atomicWrite(this.walletFile, snapshot);
  }

  loadWalletSnapshot(): WalletSnapshot | null {
    const data = this.readJSON<WalletSnapshot | null>(this.walletFile, null);
    return data;
  }

  // ═══════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════

  /**
   * Remove bid records and task states for completed/failed tasks
   * older than the specified age (default 7 days).
   */
  pruneOldRecords(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;

    // Prune tasks
    const tasks = this.loadTaskStates().filter(
      (t) => !['completed', 'failed', 'skipped'].includes(t.status) || t.updatedAt > cutoff
    );
    this.atomicWrite(this.tasksFile, tasks);

    // Prune bid records for tasks that no longer exist
    const activeTaskIds = new Set(tasks.map((t) => t.taskId));
    const bids = this.loadBidRecords().filter(
      (b) => activeTaskIds.has(b.taskId) || b.createdAt > cutoff
    );
    this.atomicWrite(this.bidsFile, bids);

    persistLog.info({ remainingTasks: tasks.length, remainingBids: bids.length }, 'Pruned old records');
  }
}

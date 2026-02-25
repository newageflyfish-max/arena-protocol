/**
 * RiskAgent — File-Backed Persistence
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BidRecord, TrackedTask, WalletSnapshot } from './types.js';
import { persistLog } from './logger.js';

export class Persistence {
  private bidsFile: string;
  private tasksFile: string;
  private walletFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.bidsFile = join(dataDir, 'bids.json');
    this.tasksFile = join(dataDir, 'tasks.json');
    this.walletFile = join(dataDir, 'wallet.json');
    persistLog.info({ dataDir }, 'Persistence initialized');
  }

  private atomicWrite(filePath: string, data: unknown): void {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  }

  private readJSON<T>(filePath: string, fallback: T): T {
    try {
      if (!existsSync(filePath)) return fallback;
      return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
    } catch { return fallback; }
  }

  // ── Bids ──
  saveBidRecord(record: BidRecord): void {
    const records = this.loadBidRecords();
    const idx = records.findIndex((r) => r.taskId === record.taskId);
    if (idx >= 0) records[idx] = record; else records.push(record);
    this.atomicWrite(this.bidsFile, records);
  }
  loadBidRecords(): BidRecord[] { return this.readJSON(this.bidsFile, []); }
  getBidRecord(taskId: number): BidRecord | undefined {
    return this.loadBidRecords().find((r) => r.taskId === taskId);
  }
  updateBidRecord(taskId: number, updates: Partial<BidRecord>): void {
    const records = this.loadBidRecords();
    const idx = records.findIndex((r) => r.taskId === taskId);
    if (idx >= 0) { records[idx] = { ...records[idx], ...updates }; this.atomicWrite(this.bidsFile, records); }
  }

  // ── Tasks ──
  saveTaskState(task: TrackedTask): void {
    const tasks = this.loadTaskStates();
    const idx = tasks.findIndex((t) => t.taskId === task.taskId);
    if (idx >= 0) tasks[idx] = task; else tasks.push(task);
    this.atomicWrite(this.tasksFile, tasks);
  }
  loadTaskStates(): TrackedTask[] { return this.readJSON(this.tasksFile, []); }
  getTaskState(taskId: number): TrackedTask | undefined {
    return this.loadTaskStates().find((t) => t.taskId === taskId);
  }
  updateTaskState(taskId: number, updates: Partial<TrackedTask>): void {
    const tasks = this.loadTaskStates();
    const idx = tasks.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) { tasks[idx] = { ...tasks[idx], ...updates, updatedAt: Date.now() }; this.atomicWrite(this.tasksFile, tasks); }
  }

  // ── Wallet ──
  saveWalletSnapshot(s: WalletSnapshot): void { this.atomicWrite(this.walletFile, s); }
  loadWalletSnapshot(): WalletSnapshot | null { return this.readJSON(this.walletFile, null); }

  // ── Cleanup ──
  pruneOldRecords(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    const tasks = this.loadTaskStates().filter(
      (t) => !['completed', 'failed', 'skipped'].includes(t.status) || t.updatedAt > cutoff
    );
    this.atomicWrite(this.tasksFile, tasks);
    const ids = new Set(tasks.map((t) => t.taskId));
    const bids = this.loadBidRecords().filter((b) => ids.has(b.taskId) || b.createdAt > cutoff);
    this.atomicWrite(this.bidsFile, bids);
  }
}

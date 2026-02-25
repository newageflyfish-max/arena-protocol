/**
 * VerifierAgent — File-Backed Persistence
 *
 * Stores verification records and wallet state to disk.
 * Uses atomic writes (write to .tmp then rename) to prevent corruption.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackedVerification, WalletSnapshot } from './types.js';
import { persistLog } from './logger.js';

export class Persistence {
  private dataDir: string;
  private verificationsFile: string;
  private walletFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.verificationsFile = join(dataDir, 'verifications.json');
    this.walletFile = join(dataDir, 'wallet.json');

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
  // VERIFICATION RECORDS
  // ═══════════════════════════════════════════════════

  saveVerification(record: TrackedVerification): void {
    const records = this.loadVerifications();
    const idx = records.findIndex((r) => r.taskId === record.taskId);
    if (idx >= 0) {
      records[idx] = record;
    } else {
      records.push(record);
    }
    this.atomicWrite(this.verificationsFile, records);
    persistLog.debug({ taskId: record.taskId }, 'Verification record saved');
  }

  loadVerifications(): TrackedVerification[] {
    return this.readJSON<TrackedVerification[]>(this.verificationsFile, []);
  }

  getVerification(taskId: number): TrackedVerification | undefined {
    return this.loadVerifications().find((r) => r.taskId === taskId);
  }

  updateVerification(taskId: number, updates: Partial<TrackedVerification>): void {
    const records = this.loadVerifications();
    const idx = records.findIndex((r) => r.taskId === taskId);
    if (idx >= 0) {
      records[idx] = { ...records[idx], ...updates };
      this.atomicWrite(this.verificationsFile, records);
    }
  }

  // ═══════════════════════════════════════════════════
  // WALLET SNAPSHOT
  // ═══════════════════════════════════════════════════

  saveWalletSnapshot(snapshot: WalletSnapshot): void {
    this.atomicWrite(this.walletFile, snapshot);
  }

  loadWalletSnapshot(): WalletSnapshot | null {
    return this.readJSON<WalletSnapshot | null>(this.walletFile, null);
  }

  // ═══════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════

  pruneOldRecords(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    const records = this.loadVerifications().filter(
      (r) => !['voted', 'settled', 'failed', 'timed_out'].includes(r.status) ||
        (r.completedAt && r.completedAt > cutoff)
    );
    this.atomicWrite(this.verificationsFile, records);
    persistLog.info({ remaining: records.length }, 'Pruned old verification records');
  }
}

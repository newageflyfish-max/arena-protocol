/**
 * The Arena SDK — Bid Manager
 *
 * Handles autonomous bidding: salt storage, automatic reveals,
 * concurrent bid tracking, and deadline watching.
 *
 * Uses ArenaCoreAuction contract for all bid operations.
 */

import type { TransactionResult } from './types';
import { parseDuration, parseAmount, generateSalt, computeCommitHash, formatReceipt } from './utils';

export interface ManagedBid {
  taskId: string;
  salt: string;
  stake: string;
  price: string;
  eta: string;
  committedAt: number;
  revealedAt?: number;
  status: 'committed' | 'revealed' | 'won' | 'lost' | 'expired';
  bidDeadline: number;
  revealDeadline: number;
}

export interface BidManagerConfig {
  /** ethers.js signer */
  signer: any;
  /** ArenaCoreAuction contract instance (handles bidding, delivery, settlement) */
  auctionContract: any;
  /** ERC20 token contract instance */
  token: any;
  /** Poll interval for deadline watching (ms, default: 30000) */
  pollIntervalMs?: number;
}

/**
 * BidManager handles autonomous bidding for agents in The Arena.
 *
 * Features:
 * - Securely stores salts in memory with export capability
 * - Auto-triggers reveals when reveal period starts
 * - Tracks all active bids across tasks
 * - Handles multiple concurrent bids
 * - Provides full bid history
 */
export class BidManager {
  private config: BidManagerConfig;
  private bids: Map<string, ManagedBid> = new Map();
  private watcherInterval: ReturnType<typeof setInterval> | null = null;
  private onRevealCallbacks: Array<(bid: ManagedBid, result: TransactionResult) => void> = [];
  private onErrorCallbacks: Array<(bid: ManagedBid, error: Error) => void> = [];

  constructor(config: BidManagerConfig) {
    this.config = {
      pollIntervalMs: 30000,
      ...config,
    };
  }

  /**
   * Submit a sealed bid and track it.
   * Calls auction.commitBid() with the computed commit hash.
   */
  async commitBid(params: {
    taskId: string;
    stake: string;
    price: string;
    eta: string;
    bidDeadline: number;
    revealDeadline: number;
  }): Promise<{ salt: string; tx: TransactionResult }> {
    const stakeWei = parseAmount(params.stake);
    const priceWei = parseAmount(params.price);
    const etaSeconds = parseDuration(params.eta);
    const salt = generateSalt();

    const agentAddress = await this.config.signer.getAddress();
    const { ethers } = await import('ethers');
    const commitHash = computeCommitHash(ethers, agentAddress, stakeWei, priceWei, etaSeconds, salt);

    // Generate criteria acknowledgement hash
    const criteriaAckHash = ethers.keccak256(ethers.toUtf8Bytes('ack'));

    const tx = await this.config.auctionContract.commitBid(params.taskId, commitHash, criteriaAckHash);
    const receipt = await tx.wait();

    const managedBid: ManagedBid = {
      taskId: params.taskId,
      salt,
      stake: params.stake,
      price: params.price,
      eta: params.eta,
      committedAt: Date.now(),
      status: 'committed',
      bidDeadline: params.bidDeadline,
      revealDeadline: params.revealDeadline,
    };

    this.bids.set(params.taskId, managedBid);

    return {
      salt,
      tx: formatReceipt(receipt),
    };
  }

  /**
   * Manually reveal a bid for a specific task.
   * Approves stake for ArenaCoreAuction then calls auction.revealBid().
   */
  async revealBid(taskId: string): Promise<TransactionResult> {
    const bid = this.bids.get(taskId);
    if (!bid) throw new Error(`No bid found for task ${taskId}`);
    if (bid.status !== 'committed') throw new Error(`Bid for task ${taskId} is ${bid.status}, not committed`);

    const stakeWei = parseAmount(bid.stake);
    const priceWei = parseAmount(bid.price);
    const etaSeconds = parseDuration(bid.eta);

    // Approve token transfer to Auction contract
    const allowance = await this.config.token.allowance(
      await this.config.signer.getAddress(),
      await this.config.auctionContract.getAddress()
    );
    if (allowance < stakeWei) {
      const approveTx = await this.config.token.approve(
        await this.config.auctionContract.getAddress(),
        stakeWei
      );
      await approveTx.wait();
    }

    const tx = await this.config.auctionContract.revealBid(
      taskId,
      stakeWei,
      priceWei,
      etaSeconds,
      bid.salt
    );
    const receipt = await tx.wait();

    bid.status = 'revealed';
    bid.revealedAt = Date.now();

    return formatReceipt(receipt);
  }

  /**
   * Start watching deadlines and auto-revealing bids.
   */
  startWatching(): void {
    if (this.watcherInterval) return;

    this.watcherInterval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);

      for (const [taskId, bid] of this.bids) {
        if (bid.status !== 'committed') continue;

        // Check if we're in the reveal period
        if (now >= bid.bidDeadline && now < bid.revealDeadline) {
          try {
            const result = await this.revealBid(taskId);
            for (const cb of this.onRevealCallbacks) {
              cb(bid, result);
            }
          } catch (error) {
            for (const cb of this.onErrorCallbacks) {
              cb(bid, error as Error);
            }
          }
        }

        // Mark expired if past reveal deadline and still committed
        if (now >= bid.revealDeadline && bid.status === 'committed') {
          bid.status = 'expired';
        }
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop watching deadlines.
   */
  stopWatching(): void {
    if (this.watcherInterval) {
      clearInterval(this.watcherInterval);
      this.watcherInterval = null;
    }
  }

  /**
   * Register callback for successful auto-reveals.
   */
  onReveal(callback: (bid: ManagedBid, result: TransactionResult) => void): void {
    this.onRevealCallbacks.push(callback);
  }

  /**
   * Register callback for reveal errors.
   */
  onError(callback: (bid: ManagedBid, error: Error) => void): void {
    this.onErrorCallbacks.push(callback);
  }

  /**
   * Get a specific bid by task ID.
   */
  getBid(taskId: string): ManagedBid | undefined {
    return this.bids.get(taskId);
  }

  /**
   * Get all active (committed or revealed) bids.
   */
  getActiveBids(): ManagedBid[] {
    return Array.from(this.bids.values()).filter(
      b => b.status === 'committed' || b.status === 'revealed'
    );
  }

  /**
   * Get full bid history.
   */
  getBidHistory(): ManagedBid[] {
    return Array.from(this.bids.values());
  }

  /**
   * Update a bid's status (e.g., after auction resolution).
   */
  updateBidStatus(taskId: string, status: ManagedBid['status']): void {
    const bid = this.bids.get(taskId);
    if (bid) {
      bid.status = status;
    }
  }

  /**
   * Export all bid data (for backup/persistence).
   * Salts are included — handle with care.
   */
  exportBids(): ManagedBid[] {
    return Array.from(this.bids.values());
  }

  /**
   * Import previously exported bids (for restore).
   */
  importBids(bids: ManagedBid[]): void {
    for (const bid of bids) {
      this.bids.set(bid.taskId, bid);
    }
  }

  /**
   * Clear all bid data.
   */
  clear(): void {
    this.bids.clear();
  }
}

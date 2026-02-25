/**
 * AgentOrchestrator — Nonce Manager
 *
 * Serializes all on-chain transactions across agents sharing the same wallet.
 * Prevents nonce conflicts when multiple agents try to send transactions
 * simultaneously (bid commits, reveals, deliveries).
 *
 * Uses a mutex queue so only one transaction can be in flight at a time.
 */

import { ethers } from 'ethers';
import type { AgentId } from './types.js';
import { nonceLog } from './logger.js';

const log = nonceLog;

interface QueuedTransaction {
  agentId: AgentId;
  purpose: string;
  execute: (nonce: number) => Promise<ethers.TransactionResponse>;
  resolve: (result: ethers.TransactionReceipt | null) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/**
 * NonceManager serializes all blockchain transactions from a single wallet.
 *
 * Instead of letting each agent manage its own nonce (which would cause
 * "nonce too low" errors when agents submit concurrently), all transactions
 * flow through this queue.
 */
export class NonceManager {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private queue: QueuedTransaction[] = [];
  private processing = false;
  private currentNonce: number | null = null;
  private txCount = 0;
  private failCount = 0;

  constructor(rpcUrl: string, privateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    log.info({ address: this.wallet.address }, 'NonceManager initialized');
  }

  get address(): string {
    return this.wallet.address;
  }

  get signer(): ethers.Wallet {
    return this.wallet;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get stats(): { total: number; failed: number; pending: number } {
    return {
      total: this.txCount,
      failed: this.failCount,
      pending: this.queue.length,
    };
  }

  /**
   * Submit a transaction through the nonce-managed queue.
   * The execute callback receives the correct nonce to use.
   */
  async submit(
    agentId: AgentId,
    purpose: string,
    execute: (nonce: number) => Promise<ethers.TransactionResponse>
  ): Promise<ethers.TransactionReceipt | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        agentId,
        purpose,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      log.debug({ agentId, purpose, queueLength: this.queue.length }, 'Transaction queued');
      this.processQueue();
    });
  }

  /**
   * Create a nonce-managed contract wrapper.
   * Returns an ethers.Contract whose transactions are serialized through the queue.
   */
  createContract(address: string, abi: string[]): ethers.Contract {
    return new ethers.Contract(address, abi, this.wallet);
  }

  /**
   * Sync the nonce from the network (useful after errors or restarts).
   */
  async syncNonce(): Promise<number> {
    this.currentNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    log.info({ nonce: this.currentNonce }, 'Nonce synced from network');
    return this.currentNonce;
  }

  /**
   * Get the current ETH balance (for gas monitoring).
   */
  async getEthBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  // ── Queue Processing ──

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const tx = this.queue.shift()!;
      const waitTime = Date.now() - tx.enqueuedAt;

      try {
        // Ensure we have a valid nonce
        if (this.currentNonce === null) {
          await this.syncNonce();
        }

        const nonce = this.currentNonce!;
        log.info(
          { agentId: tx.agentId, purpose: tx.purpose, nonce, waitTime },
          'Executing transaction'
        );

        const response = await tx.execute(nonce);
        this.currentNonce = nonce + 1;
        this.txCount++;

        // Wait for confirmation
        const receipt = await response.wait();
        log.info(
          {
            agentId: tx.agentId,
            purpose: tx.purpose,
            txHash: receipt?.hash,
            gasUsed: receipt?.gasUsed?.toString(),
          },
          'Transaction confirmed'
        );

        tx.resolve(receipt);
      } catch (err: any) {
        this.failCount++;
        const errMsg = err.message || String(err);

        // Check for nonce errors and resync
        if (errMsg.includes('nonce') || errMsg.includes('replacement')) {
          log.warn({ agentId: tx.agentId, purpose: tx.purpose }, 'Nonce error — resyncing');
          this.currentNonce = null;

          try {
            await this.syncNonce();
            // Re-queue the transaction at the front
            this.queue.unshift(tx);
            continue;
          } catch {
            log.error({ agentId: tx.agentId }, 'Nonce resync failed');
          }
        }

        log.error(
          { agentId: tx.agentId, purpose: tx.purpose, err: errMsg },
          'Transaction failed'
        );
        tx.reject(new Error(`Transaction failed: ${errMsg}`));
      }
    }

    this.processing = false;
  }
}

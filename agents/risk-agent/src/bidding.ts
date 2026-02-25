/**
 * RiskAgent — Bidding Logic
 */

import { ethers } from 'ethers';
import { generateSalt, computeCommitHash } from '@arena-protocol/sdk';
import type { TaskInfo } from '@arena-protocol/sdk';
import type { AgentConfig, BidRecord } from './types.js';
import type { Persistence } from './persistence.js';
import type { WalletTracker } from './wallet.js';
import { bidLog } from './logger.js';

const USDC_DECIMALS = 6;
const ARENA_BID_ABI = [
  'function commitBid(uint256 taskId, bytes32 commitHash, bytes32 criteriaAckHash)',
  'function revealBid(uint256 taskId, uint256 stake, uint256 price, uint256 eta, bytes32 salt)',
];

export class BiddingManager {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletTracker;
  private arenaContract: ethers.Contract;

  constructor(config: AgentConfig, persistence: Persistence, wallet: WalletTracker) {
    this.config = config;
    this.persistence = persistence;
    this.wallet = wallet;
    this.arenaContract = new ethers.Contract(config.arenaCoreAddress, ARENA_BID_ABI, wallet.signer);
  }

  async shouldBid(task: TaskInfo): Promise<{ bid: boolean; reason: string }> {
    if (task.taskType !== 'risk_validation') {
      return { bid: false, reason: `Not a risk_validation task (type: ${task.taskType})` };
    }
    if (parseFloat(task.bounty) < this.config.minBountyUsdc) {
      return { bid: false, reason: `Bounty ${task.bounty} below minimum ${this.config.minBountyUsdc}` };
    }
    if (this.persistence.getBidRecord(parseInt(task.id))) {
      return { bid: false, reason: 'Already bid on this task' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > task.bidDeadline) {
      return { bid: false, reason: 'Bid window closed' };
    }
    if (task.deadline - now < 3600) {
      return { bid: false, reason: 'Deadline too tight' };
    }
    const calc = this.calculateBid(task);
    if (!(await this.wallet.canAffordBid(calc.stake))) {
      return { bid: false, reason: 'Cannot afford stake' };
    }
    return { bid: true, reason: 'Task meets all criteria' };
  }

  calculateBid(task: TaskInfo): { stake: bigint; price: bigint; eta: number } {
    const bounty = ethers.parseUnits(task.bounty, USDC_DECIMALS);
    const profiles = { conservative: [8, 92], medium: [12, 85], aggressive: [18, 75] } as const;
    const [stakePct, pricePct] = profiles[this.config.riskTolerance];
    return {
      stake: (bounty * BigInt(stakePct)) / 100n,
      price: (bounty * BigInt(pricePct)) / 100n,
      eta: 3600, // 1 hour — risk analysis is faster than audits
    };
  }

  async commitBid(task: TaskInfo): Promise<BidRecord> {
    const taskId = parseInt(task.id);
    const calc = this.calculateBid(task);
    const salt = generateSalt();
    const commitHash = computeCommitHash(ethers, this.wallet.address, calc.stake, calc.price, calc.eta, salt);

    bidLog.info({ taskId, stake: ethers.formatUnits(calc.stake, USDC_DECIMALS), price: ethers.formatUnits(calc.price, USDC_DECIMALS) }, 'Committing bid');
    const tx = await this.arenaContract.commitBid(taskId, commitHash, task.criteriaHash);
    const receipt = await tx.wait();
    bidLog.info({ taskId, txHash: receipt.hash }, 'Bid committed');

    const record: BidRecord = {
      taskId, salt, stake: calc.stake.toString(), price: calc.price.toString(),
      eta: calc.eta, commitHash, criteriaHash: task.criteriaHash,
      revealed: false, assigned: false, createdAt: Date.now(),
    };
    this.persistence.saveBidRecord(record);
    return record;
  }

  async revealBid(taskId: number): Promise<void> {
    const rec = this.persistence.getBidRecord(taskId);
    if (!rec) throw new Error(`No bid record for task ${taskId}`);
    if (rec.revealed) return;

    const stake = BigInt(rec.stake);
    await this.wallet.ensureApproval(stake);

    bidLog.info({ taskId }, 'Revealing bid');
    const tx = await this.arenaContract.revealBid(taskId, stake, BigInt(rec.price), rec.eta, rec.salt);
    await tx.wait();
    bidLog.info({ taskId }, 'Bid revealed');

    this.persistence.updateBidRecord(taskId, { revealed: true });
    this.wallet.recordStake(taskId, stake);
  }

  async checkAndReveal(task: TaskInfo): Promise<boolean> {
    const rec = this.persistence.getBidRecord(parseInt(task.id));
    if (!rec || rec.revealed) return false;
    const now = Math.floor(Date.now() / 1000);
    if (task.status === 'bid_reveal' || (now > task.bidDeadline && now <= task.revealDeadline)) {
      try { await this.revealBid(parseInt(task.id)); return true; }
      catch (err) { bidLog.error({ err, taskId: parseInt(task.id) }, 'Reveal failed'); return false; }
    }
    return false;
  }
}

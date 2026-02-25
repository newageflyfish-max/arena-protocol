/**
 * AuditAgent — Bidding Logic
 *
 * Evaluates tasks, calculates bids, commits and reveals using
 * the sealed-bid auction system.
 *
 * IMPORTANT: The SDK's Arena.bid() method is missing the criteriaAckHash
 * parameter that the contract requires. We call the contract directly
 * for commitBid, but use the SDK utilities for hash computation.
 */

import { ethers } from 'ethers';
import { generateSalt, computeCommitHash } from '@arena-protocol/sdk';
import type { TaskInfo } from '@arena-protocol/sdk';
import type { AgentConfig, BidRecord, TrackedTask } from './types.js';
import type { Persistence } from './persistence.js';
import type { WalletTracker } from './wallet.js';
import { bidLog } from './logger.js';

const USDC_DECIMALS = 6;

// Minimal ABI for commitBid (3-arg version with criteriaAckHash)
const ARENA_COMMIT_BID_ABI = [
  'function commitBid(uint256 taskId, bytes32 commitHash, bytes32 criteriaAckHash)',
  'function revealBid(uint256 taskId, uint256 stake, uint256 price, uint256 eta, bytes32 salt)',
];

interface BidCalculation {
  stake: bigint;
  price: bigint;
  eta: number;
}

export class BiddingManager {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletTracker;
  private arenaContract: ethers.Contract;

  constructor(config: AgentConfig, persistence: Persistence, wallet: WalletTracker) {
    this.config = config;
    this.persistence = persistence;
    this.wallet = wallet;

    // Direct contract access for commitBid/revealBid
    this.arenaContract = new ethers.Contract(
      config.arenaCoreAddress,
      ARENA_COMMIT_BID_ABI,
      wallet.signer
    );
  }

  // ═══════════════════════════════════════════════════
  // TASK EVALUATION
  // ═══════════════════════════════════════════════════

  /**
   * Decide whether we should bid on this task.
   */
  async shouldBid(task: TaskInfo): Promise<{ bid: boolean; reason: string }> {
    // Only bid on audit tasks
    if (task.taskType !== 'audit') {
      return { bid: false, reason: `Not an audit task (type: ${task.taskType})` };
    }

    // Check bounty minimum
    const bountyUsdc = parseFloat(task.bounty);
    if (bountyUsdc < this.config.minBountyUsdc) {
      return { bid: false, reason: `Bounty ${bountyUsdc} USDC below minimum ${this.config.minBountyUsdc}` };
    }

    // Check if we already have a bid on this task
    const existingBid = this.persistence.getBidRecord(parseInt(task.id));
    if (existingBid) {
      return { bid: false, reason: 'Already bid on this task' };
    }

    // Check deadline feasibility (need at least 2 hours)
    const now = Math.floor(Date.now() / 1000);
    const timeRemaining = task.deadline - now;
    if (timeRemaining < 7200) {
      return { bid: false, reason: `Deadline too tight (${Math.floor(timeRemaining / 60)}m remaining)` };
    }

    // Check bid window still open
    if (now > task.bidDeadline) {
      return { bid: false, reason: 'Bid window closed' };
    }

    // Check affordability
    const calculation = this.calculateBid(task);
    const canAfford = await this.wallet.canAffordBid(calculation.stake);
    if (!canAfford) {
      return { bid: false, reason: 'Cannot afford stake' };
    }

    return { bid: true, reason: 'Task meets all criteria' };
  }

  // ═══════════════════════════════════════════════════
  // BID CALCULATION
  // ═══════════════════════════════════════════════════

  /**
   * Calculate bid parameters based on task bounty and risk tolerance.
   *
   * Scoring formula: score = (stake * (reputation + 1) * 1e18) / price
   * Higher stake + lower price = higher score.
   * New agents (rep=0) should bid higher stakes to compensate.
   */
  calculateBid(task: TaskInfo): BidCalculation {
    const bountyWei = ethers.parseUnits(task.bounty, USDC_DECIMALS);

    let stakePercent: number;
    let pricePercent: number;

    switch (this.config.riskTolerance) {
      case 'conservative':
        stakePercent = 10;
        pricePercent = 90;
        break;
      case 'medium':
        stakePercent = 15;
        pricePercent = 80;
        break;
      case 'aggressive':
        stakePercent = 20;
        pricePercent = 70;
        break;
    }

    const stake = (bountyWei * BigInt(stakePercent)) / 100n;
    const price = (bountyWei * BigInt(pricePercent)) / 100n;

    // ETA: 2 hours for automated analysis
    const eta = 7200;

    bidLog.debug(
      {
        bounty: task.bounty,
        riskTolerance: this.config.riskTolerance,
        stake: ethers.formatUnits(stake, USDC_DECIMALS),
        price: ethers.formatUnits(price, USDC_DECIMALS),
        eta: `${eta}s`,
      },
      'Bid calculated'
    );

    return { stake, price, eta };
  }

  // ═══════════════════════════════════════════════════
  // COMMIT BID
  // ═══════════════════════════════════════════════════

  /**
   * Commit a sealed bid for a task.
   * Generates salt, computes commit hash, calls contract directly
   * (bypassing SDK due to missing criteriaAckHash parameter).
   */
  async commitBid(task: TaskInfo): Promise<BidRecord> {
    const taskId = parseInt(task.id);
    const calculation = this.calculateBid(task);

    // Generate random salt
    const salt = generateSalt();

    // Compute commit hash: keccak256(agent, stake, price, eta, salt)
    const agentAddress = this.wallet.address;
    const commitHash = computeCommitHash(
      ethers,
      agentAddress,
      calculation.stake,
      calculation.price,
      calculation.eta,
      salt
    );

    // criteriaAckHash: hash the criteria to acknowledge we've reviewed it
    const criteriaAckHash = task.criteriaHash;

    bidLog.info(
      {
        taskId,
        stake: ethers.formatUnits(calculation.stake, USDC_DECIMALS),
        price: ethers.formatUnits(calculation.price, USDC_DECIMALS),
        eta: calculation.eta,
      },
      'Committing bid'
    );

    // Call contract directly (SDK's bid() is missing criteriaAckHash)
    const tx = await this.arenaContract.commitBid(taskId, commitHash, criteriaAckHash);
    const receipt = await tx.wait();

    bidLog.info(
      { taskId, txHash: receipt.hash, gasUsed: receipt.gasUsed?.toString() },
      'Bid committed'
    );

    // Build and persist bid record (CRITICAL: salt must be saved)
    const record: BidRecord = {
      taskId,
      salt,
      stake: calculation.stake.toString(),
      price: calculation.price.toString(),
      eta: calculation.eta,
      commitHash,
      criteriaHash: task.criteriaHash,
      revealed: false,
      assigned: false,
      createdAt: Date.now(),
    };

    this.persistence.saveBidRecord(record);
    bidLog.info({ taskId }, 'Bid record persisted (salt saved)');

    return record;
  }

  // ═══════════════════════════════════════════════════
  // REVEAL BID
  // ═══════════════════════════════════════════════════

  /**
   * Reveal a previously committed bid during the reveal window.
   * Loads the bid record from persistence (contains the salt).
   * Transfers stake to escrow.
   */
  async revealBid(taskId: number): Promise<void> {
    const record = this.persistence.getBidRecord(taskId);
    if (!record) {
      throw new Error(`No bid record found for task ${taskId}`);
    }
    if (record.revealed) {
      bidLog.warn({ taskId }, 'Bid already revealed');
      return;
    }

    const stake = BigInt(record.stake);
    const price = BigInt(record.price);

    // Ensure USDC approval for stake transfer
    await this.wallet.ensureApproval(stake);

    bidLog.info(
      {
        taskId,
        stake: ethers.formatUnits(stake, USDC_DECIMALS),
        price: ethers.formatUnits(price, USDC_DECIMALS),
        eta: record.eta,
      },
      'Revealing bid'
    );

    const tx = await this.arenaContract.revealBid(
      taskId,
      stake,
      price,
      record.eta,
      record.salt
    );
    const receipt = await tx.wait();

    bidLog.info(
      { taskId, txHash: receipt.hash, gasUsed: receipt.gasUsed?.toString() },
      'Bid revealed'
    );

    // Update record
    this.persistence.updateBidRecord(taskId, { revealed: true });

    // Track the active stake
    this.wallet.recordStake(taskId, stake);
  }

  /**
   * Check if a task is in the reveal window and we have an unrevealed bid.
   */
  async checkAndReveal(task: TaskInfo): Promise<boolean> {
    const taskId = parseInt(task.id);
    const record = this.persistence.getBidRecord(taskId);

    if (!record || record.revealed) return false;

    const now = Math.floor(Date.now() / 1000);

    // In reveal window?
    if (task.status === 'bid_reveal' || (now > task.bidDeadline && now <= task.revealDeadline)) {
      try {
        await this.revealBid(taskId);
        return true;
      } catch (err) {
        bidLog.error({ err, taskId }, 'Failed to reveal bid');
        return false;
      }
    }

    return false;
  }
}

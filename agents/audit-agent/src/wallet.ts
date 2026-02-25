/**
 * AuditAgent — Wallet & Balance Tracker
 *
 * Tracks USDC balance and active stakes to ensure the agent
 * never bids more than it can afford to lose.
 */

import { ethers } from 'ethers';
import type { AgentConfig, WalletSnapshot } from './types.js';
import type { Persistence } from './persistence.js';
import { walletLog } from './logger.js';

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export class WalletTracker {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private usdcContract: ethers.Contract;
  private persistence: Persistence;
  private config: AgentConfig;
  private activeStakes: Map<number, bigint> = new Map();

  constructor(config: AgentConfig, persistence: Persistence) {
    this.config = config;
    this.persistence = persistence;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.usdcContract = new ethers.Contract(config.usdcAddress, ERC20_ABI, this.wallet);

    // Restore active stakes from persistence
    const snapshot = persistence.loadWalletSnapshot();
    if (snapshot) {
      for (const [taskId, amount] of Object.entries(snapshot.activeStakes)) {
        this.activeStakes.set(Number(taskId), BigInt(amount));
      }
      walletLog.info(
        { activeStakeCount: this.activeStakes.size, lastBalance: snapshot.balance },
        'Restored wallet state from disk'
      );
    }
  }

  get address(): string {
    return this.wallet.address;
  }

  get signer(): ethers.Wallet {
    return this.wallet;
  }

  /**
   * Get current USDC balance from chain.
   */
  async getBalance(): Promise<bigint> {
    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    return BigInt(balance.toString());
  }

  /**
   * Get available balance (on-chain balance minus active stakes).
   */
  async getAvailableBalance(): Promise<bigint> {
    const balance = await this.getBalance();
    let totalStaked = 0n;
    for (const stake of this.activeStakes.values()) {
      totalStaked += stake;
    }
    const available = balance > totalStaked ? balance - totalStaked : 0n;
    walletLog.debug(
      {
        balance: ethers.formatUnits(balance, USDC_DECIMALS),
        totalStaked: ethers.formatUnits(totalStaked, USDC_DECIMALS),
        available: ethers.formatUnits(available, USDC_DECIMALS),
      },
      'Balance check'
    );
    return available;
  }

  /**
   * Check if we can afford to stake this amount.
   * Enforces both absolute limit (maxBidUsdc) and percentage limit (maxStakePercent).
   */
  async canAffordBid(stakeAmount: bigint): Promise<boolean> {
    const balance = await this.getBalance();

    // Check absolute limit
    const maxBid = ethers.parseUnits(String(this.config.maxBidUsdc), USDC_DECIMALS);
    if (stakeAmount > maxBid) {
      walletLog.debug(
        { stake: ethers.formatUnits(stakeAmount, USDC_DECIMALS), maxBid: this.config.maxBidUsdc },
        'Stake exceeds max bid limit'
      );
      return false;
    }

    // Check percentage limit
    const maxPercentStake = (balance * BigInt(this.config.maxStakePercent)) / 100n;
    if (stakeAmount > maxPercentStake) {
      walletLog.debug(
        {
          stake: ethers.formatUnits(stakeAmount, USDC_DECIMALS),
          maxPercent: ethers.formatUnits(maxPercentStake, USDC_DECIMALS),
          pct: this.config.maxStakePercent,
        },
        'Stake exceeds max percentage of balance'
      );
      return false;
    }

    // Check available balance
    const available = await this.getAvailableBalance();
    if (stakeAmount > available) {
      walletLog.debug(
        {
          stake: ethers.formatUnits(stakeAmount, USDC_DECIMALS),
          available: ethers.formatUnits(available, USDC_DECIMALS),
        },
        'Insufficient available balance'
      );
      return false;
    }

    return true;
  }

  /**
   * Record a new active stake for a task.
   */
  recordStake(taskId: number, amount: bigint): void {
    this.activeStakes.set(taskId, amount);
    this.saveSnapshot();
    walletLog.info(
      { taskId, amount: ethers.formatUnits(amount, USDC_DECIMALS) },
      'Stake recorded'
    );
  }

  /**
   * Release a stake (task completed, failed, or we lost the auction).
   */
  releaseStake(taskId: number): void {
    const amount = this.activeStakes.get(taskId);
    if (amount) {
      this.activeStakes.delete(taskId);
      this.saveSnapshot();
      walletLog.info(
        { taskId, amount: ethers.formatUnits(amount, USDC_DECIMALS) },
        'Stake released'
      );
    }
  }

  /**
   * Ensure USDC approval for ArenaCore contract.
   */
  async ensureApproval(amount: bigint): Promise<void> {
    const allowance = await this.usdcContract.allowance(
      this.wallet.address,
      this.config.arenaCoreAddress
    );
    if (BigInt(allowance.toString()) < amount) {
      walletLog.info(
        { amount: ethers.formatUnits(amount, USDC_DECIMALS) },
        'Approving USDC spend'
      );
      const tx = await this.usdcContract.approve(this.config.arenaCoreAddress, ethers.MaxUint256);
      await tx.wait();
      walletLog.info('USDC approval granted');
    }
  }

  /**
   * Persist wallet snapshot to disk.
   */
  private saveSnapshot(): void {
    const stakes: Record<number, string> = {};
    for (const [taskId, amount] of this.activeStakes.entries()) {
      stakes[taskId] = amount.toString();
    }
    this.persistence.saveWalletSnapshot({
      balance: '0', // Will be updated on next balance check
      activeStakes: stakes,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Log current wallet status.
   */
  async logStatus(): Promise<void> {
    const balance = await this.getBalance();
    const available = await this.getAvailableBalance();
    walletLog.info(
      {
        address: this.wallet.address,
        balance: ethers.formatUnits(balance, USDC_DECIMALS) + ' USDC',
        available: ethers.formatUnits(available, USDC_DECIMALS) + ' USDC',
        activeStakes: this.activeStakes.size,
      },
      'Wallet status'
    );
  }
}

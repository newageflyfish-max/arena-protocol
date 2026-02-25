/**
 * VerifierAgent — Wallet & Verifier Pool Management
 *
 * Manages USDC balance, verifier pool membership, and token approvals.
 */

import { ethers } from 'ethers';
import type { AgentConfig } from './types.js';
import type { Persistence } from './persistence.js';
import { walletLog } from './logger.js';

const USDC_DECIMALS = 6;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ARENA_POOL_ABI = [
  'function joinVerifierPool(uint256 _stake)',
  'function leaveVerifierPool()',
  'function verifierRegistry(address) view returns (uint256 stake, bool active, uint256 registeredAt)',
  'function verifierPoolLength() view returns (uint256)',
];

export class WalletManager {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private usdcContract: ethers.Contract;
  private arenaContract: ethers.Contract;
  private persistence: Persistence;
  private config: AgentConfig;

  constructor(config: AgentConfig, persistence: Persistence) {
    this.config = config;
    this.persistence = persistence;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.usdcContract = new ethers.Contract(config.usdcAddress, ERC20_ABI, this.wallet);
    this.arenaContract = new ethers.Contract(config.arenaCoreAddress, ARENA_POOL_ABI, this.wallet);
  }

  get address(): string {
    return this.wallet.address;
  }

  get signer(): ethers.Wallet {
    return this.wallet;
  }

  // ═══════════════════════════════════════════════════
  // BALANCE
  // ═══════════════════════════════════════════════════

  async getBalance(): Promise<bigint> {
    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    return BigInt(balance.toString());
  }

  // ═══════════════════════════════════════════════════
  // VERIFIER POOL
  // ═══════════════════════════════════════════════════

  /**
   * Check if we're currently in the verifier pool.
   */
  async isInPool(): Promise<{ active: boolean; stake: bigint }> {
    try {
      const reg = await this.arenaContract.verifierRegistry(this.wallet.address);
      return {
        active: reg.active,
        stake: BigInt(reg.stake.toString()),
      };
    } catch {
      return { active: false, stake: 0n };
    }
  }

  /**
   * Join the verifier pool with configured stake.
   */
  async joinPool(): Promise<void> {
    const { active, stake } = await this.isInPool();

    if (active) {
      walletLog.info(
        { stake: ethers.formatUnits(stake, USDC_DECIMALS) },
        'Already in verifier pool'
      );
      return;
    }

    const stakeAmount = ethers.parseUnits(String(this.config.poolStakeUsdc), USDC_DECIMALS);

    // Check balance
    const balance = await this.getBalance();
    if (balance < stakeAmount) {
      throw new Error(
        `Insufficient balance to join pool. Need ${this.config.poolStakeUsdc} USDC, have ${ethers.formatUnits(balance, USDC_DECIMALS)} USDC`
      );
    }

    // Approve
    await this.ensureApproval(stakeAmount);

    walletLog.info(
      { stake: this.config.poolStakeUsdc },
      'Joining verifier pool...'
    );

    const tx = await this.arenaContract.joinVerifierPool(stakeAmount);
    const receipt = await tx.wait();

    walletLog.info(
      { txHash: receipt.hash, gasUsed: receipt.gasUsed?.toString() },
      'Joined verifier pool'
    );
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
      walletLog.info('Approving USDC spend...');
      const tx = await this.usdcContract.approve(this.config.arenaCoreAddress, ethers.MaxUint256);
      await tx.wait();
      walletLog.info('USDC approval granted');
    }
  }

  /**
   * Log current wallet and pool status.
   */
  async logStatus(): Promise<void> {
    const balance = await this.getBalance();
    const { active, stake } = await this.isInPool();
    const poolSize = await this.arenaContract.verifierPoolLength().catch(() => 0n);

    walletLog.info(
      {
        address: this.wallet.address,
        balance: ethers.formatUnits(balance, USDC_DECIMALS) + ' USDC',
        inPool: active,
        poolStake: ethers.formatUnits(stake, USDC_DECIMALS) + ' USDC',
        poolSize: Number(poolSize),
      },
      'Wallet & pool status'
    );
  }
}

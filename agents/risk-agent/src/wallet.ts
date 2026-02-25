/**
 * RiskAgent — Wallet & Balance Tracker
 */

import { ethers } from 'ethers';
import type { AgentConfig } from './types.js';
import type { Persistence } from './persistence.js';
import { walletLog } from './logger.js';

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

export class WalletTracker {
  private wallet: ethers.Wallet;
  private usdcContract: ethers.Contract;
  private persistence: Persistence;
  private config: AgentConfig;
  private activeStakes = new Map<number, bigint>();

  constructor(config: AgentConfig, persistence: Persistence) {
    this.config = config;
    this.persistence = persistence;
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, provider);
    this.usdcContract = new ethers.Contract(config.usdcAddress, ERC20_ABI, this.wallet);

    const snap = persistence.loadWalletSnapshot();
    if (snap) {
      for (const [id, amt] of Object.entries(snap.activeStakes)) {
        this.activeStakes.set(Number(id), BigInt(amt));
      }
    }
  }

  get address(): string { return this.wallet.address; }
  get signer(): ethers.Wallet { return this.wallet; }

  async getBalance(): Promise<bigint> {
    return BigInt((await this.usdcContract.balanceOf(this.wallet.address)).toString());
  }

  async getAvailableBalance(): Promise<bigint> {
    const bal = await this.getBalance();
    let staked = 0n;
    for (const s of this.activeStakes.values()) staked += s;
    return bal > staked ? bal - staked : 0n;
  }

  async canAffordBid(stake: bigint): Promise<boolean> {
    const bal = await this.getBalance();
    const maxAbs = ethers.parseUnits(String(this.config.maxBidUsdc), USDC_DECIMALS);
    if (stake > maxAbs) return false;
    const maxPct = (bal * BigInt(this.config.maxStakePercent)) / 100n;
    if (stake > maxPct) return false;
    return stake <= await this.getAvailableBalance();
  }

  recordStake(taskId: number, amount: bigint): void {
    this.activeStakes.set(taskId, amount);
    this.saveSnapshot();
  }

  releaseStake(taskId: number): void {
    this.activeStakes.delete(taskId);
    this.saveSnapshot();
  }

  async ensureApproval(amount: bigint): Promise<void> {
    const allowance = BigInt((await this.usdcContract.allowance(this.wallet.address, this.config.arenaCoreAddress)).toString());
    if (allowance < amount) {
      const tx = await this.usdcContract.approve(this.config.arenaCoreAddress, ethers.MaxUint256);
      await tx.wait();
    }
  }

  private saveSnapshot(): void {
    const stakes: Record<number, string> = {};
    for (const [id, amt] of this.activeStakes) stakes[id] = amt.toString();
    this.persistence.saveWalletSnapshot({ balance: '0', activeStakes: stakes, lastUpdated: Date.now() });
  }

  async logStatus(): Promise<void> {
    const bal = await this.getBalance();
    const avail = await this.getAvailableBalance();
    walletLog.info({
      address: this.wallet.address,
      balance: ethers.formatUnits(bal, USDC_DECIMALS) + ' USDC',
      available: ethers.formatUnits(avail, USDC_DECIMALS) + ' USDC',
      activeStakes: this.activeStakes.size,
    }, 'Wallet status');
  }
}

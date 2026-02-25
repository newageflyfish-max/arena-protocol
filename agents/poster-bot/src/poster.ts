/**
 * TaskPoster Bot — Poster Engine
 *
 * Handles the full task posting lifecycle:
 *   1. Check balance threshold
 *   2. Accept ToS (if compliance contract is set)
 *   3. Pin criteria to IPFS
 *   4. Approve USDC spend
 *   5. Call createTask on ArenaCore
 *   6. Track posted tasks
 */

import { ethers } from 'ethers';
import { pinJSON } from '@arena-protocol/sdk';
import type { PinataConfig } from '@arena-protocol/sdk';
import type { BotConfig, TaskTemplate, PostRecord, BotStats, PostableTaskType } from './types.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { postLog, walletLog } from './logger.js';

const log = postLog;

const USDC_DECIMALS = 6;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const ARENA_CORE_ABI = [
  'function createTask(uint256 _bounty, uint256 _deadline, uint256 _slashWindow, uint256 _bidDuration, uint256 _revealDuration, uint8 _requiredVerifiers, bytes32 _criteriaHash, string _taskType, address _token) returns (uint256 taskId)',
  'function taskCount() view returns (uint256)',
  'function minBounty() view returns (uint256)',
  'function posterActiveTasks(address) view returns (uint256)',
  'function maxPosterActiveTasks() view returns (uint256)',
  'event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)',
];

const COMPLIANCE_ABI = [
  'function hasAcceptedTos(address) view returns (bool)',
  'function tosHash() view returns (bytes32)',
  'function acceptTermsOfService(bytes32 _tosHash)',
];

export class TaskPoster {
  private config: BotConfig;
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private usdcContract: ethers.Contract;
  private arenaContract: ethers.Contract;
  private complianceContract: ethers.Contract | null = null;
  private pinataConfig: PinataConfig;
  private records: PostRecord[] = [];
  private recordsFile: string;
  private tosAccepted = false;

  constructor(config: BotConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.usdcContract = new ethers.Contract(config.usdcAddress, ERC20_ABI, this.wallet);
    this.arenaContract = new ethers.Contract(config.arenaCoreAddress, ARENA_CORE_ABI, this.wallet);

    if (config.complianceAddress) {
      this.complianceContract = new ethers.Contract(config.complianceAddress, COMPLIANCE_ABI, this.wallet);
    }

    this.pinataConfig = {
      apiKey: config.pinataApiKey,
      apiSecret: config.pinataSecret,
    };

    mkdirSync(config.dataDir, { recursive: true });
    this.recordsFile = join(config.dataDir, 'posted-tasks.json');
    this.loadRecords();
  }

  get address(): string {
    return this.wallet.address;
  }

  // ═══════════════════════════════════════════════════
  // BALANCE MANAGEMENT
  // ═══════════════════════════════════════════════════

  async getUsdcBalance(): Promise<number> {
    const bal = await this.usdcContract.balanceOf(this.wallet.address);
    return parseFloat(ethers.formatUnits(bal, USDC_DECIMALS));
  }

  async getEthBalance(): Promise<string> {
    const bal = await this.provider.getBalance(this.wallet.address);
    return parseFloat(ethers.formatEther(bal)).toFixed(4);
  }

  async canAffordPost(bountyUsdc: number): Promise<{ ok: boolean; reason?: string }> {
    const balance = await this.getUsdcBalance();

    if (balance < this.config.minBalanceUsdc) {
      return { ok: false, reason: `Balance ${balance.toFixed(2)} below minimum ${this.config.minBalanceUsdc} USDC` };
    }

    if (balance < bountyUsdc) {
      return { ok: false, reason: `Balance ${balance.toFixed(2)} insufficient for ${bountyUsdc} USDC bounty` };
    }

    // Check active tasks limit
    try {
      const activeTasks = Number(await this.arenaContract.posterActiveTasks(this.wallet.address));
      const maxTasks = Number(await this.arenaContract.maxPosterActiveTasks());
      if (activeTasks >= maxTasks) {
        return { ok: false, reason: `Active task limit reached (${activeTasks}/${maxTasks})` };
      }
    } catch {
      // Skip if contract doesn't support this
    }

    return { ok: true };
  }

  async logStatus(): Promise<void> {
    const usdcBal = await this.getUsdcBalance();
    const ethBal = await this.getEthBalance();
    walletLog.info({
      address: this.wallet.address,
      usdc: usdcBal.toFixed(2) + ' USDC',
      eth: ethBal + ' ETH',
      totalPosted: this.records.length,
    }, 'Wallet status');
  }

  // ═══════════════════════════════════════════════════
  // TOS ACCEPTANCE
  // ═══════════════════════════════════════════════════

  async ensureToS(): Promise<void> {
    if (this.tosAccepted) return;
    if (!this.complianceContract) {
      this.tosAccepted = true; // No compliance contract, no ToS needed
      return;
    }

    try {
      const accepted = await this.complianceContract.hasAcceptedTos(this.wallet.address);
      if (accepted) {
        this.tosAccepted = true;
        log.info('ToS already accepted');
        return;
      }

      // Need to accept ToS
      const tosHash = await this.complianceContract.tosHash();
      if (tosHash === ethers.ZeroHash) {
        this.tosAccepted = true; // No ToS set
        log.info('No ToS configured on compliance contract');
        return;
      }

      log.info({ tosHash }, 'Accepting Terms of Service...');
      const tx = await this.complianceContract.acceptTermsOfService(tosHash);
      await tx.wait();
      this.tosAccepted = true;
      log.info('Terms of Service accepted');
    } catch (err: any) {
      log.error({ err: err.message }, 'ToS acceptance failed');
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════
  // TASK POSTING
  // ═══════════════════════════════════════════════════

  async postTask(template: TaskTemplate): Promise<PostRecord | null> {
    const { taskType, criteria, bountyUsdc, description } = template;

    try {
      // 1. Check balance
      const affordCheck = await this.canAffordPost(bountyUsdc);
      if (!affordCheck.ok) {
        log.warn({ reason: affordCheck.reason }, 'Cannot afford to post task');
        return null;
      }

      // 2. Ensure ToS accepted
      await this.ensureToS();

      // 3. Pin criteria to IPFS
      log.info({ taskType, bountyUsdc }, 'Pinning criteria to IPFS...');
      const pinResult = await pinJSON(criteria as Record<string, any>, this.pinataConfig, {
        name: `arena-criteria-${taskType}-${Date.now()}`,
      });
      const criteriaHash = pinResult.hash;
      log.info({ cid: pinResult.cid, hash: criteriaHash }, 'Criteria pinned');

      // 4. Approve USDC spend
      const bountyWei = ethers.parseUnits(String(bountyUsdc), USDC_DECIMALS);
      const allowance = await this.usdcContract.allowance(this.wallet.address, this.config.arenaCoreAddress);
      if (BigInt(allowance.toString()) < bountyWei) {
        log.info('Approving USDC spend...');
        const approveTx = await this.usdcContract.approve(this.config.arenaCoreAddress, ethers.MaxUint256);
        await approveTx.wait();
        log.info('USDC approved');
      }

      // 5. Build parameters
      const now = Math.floor(Date.now() / 1000);
      const deadline = now + (this.config.deadlineHours * 3600);
      const slashWindow = this.config.slashWindowHours * 3600;
      const bidDuration = this.config.bidDurationSeconds;
      const revealDuration = this.config.revealDurationSeconds;

      // 6. Create task on-chain
      log.info(
        { taskType, bountyUsdc, deadline: new Date(deadline * 1000).toISOString() },
        'Creating task on-chain...'
      );

      const tx = await this.arenaContract.createTask(
        bountyWei,
        deadline,
        slashWindow,
        bidDuration,
        revealDuration,
        this.config.requiredVerifiers,
        criteriaHash,
        taskType,
        ethers.ZeroAddress,  // defaults to USDC
      );

      const receipt = await tx.wait();

      // 7. Extract taskId from event
      let taskId = 0;
      for (const eventLog of receipt.logs) {
        try {
          const parsed = this.arenaContract.interface.parseLog({
            topics: eventLog.topics as string[],
            data: eventLog.data,
          });
          if (parsed?.name === 'TaskCreated') {
            taskId = Number(parsed.args.taskId);
            break;
          }
        } catch { /* skip non-matching logs */ }
      }

      // Fallback: read taskCount
      if (taskId === 0) {
        try {
          taskId = Number(await this.arenaContract.taskCount());
        } catch { taskId = this.records.length + 1; }
      }

      // 8. Record
      const record: PostRecord = {
        taskId,
        taskType,
        bountyUsdc,
        criteriaHash,
        txHash: receipt.hash,
        postedAt: Date.now(),
        description,
      };
      this.records.push(record);
      this.saveRecords();

      log.info(
        { taskId, taskType, bountyUsdc, txHash: receipt.hash },
        'Task posted successfully!'
      );

      return record;
    } catch (err: any) {
      log.error({ err: err.message, taskType, bountyUsdc }, 'Failed to post task');
      return null;
    }
  }

  // ═══════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════

  getStats(): BotStats {
    const tasksByType: Record<PostableTaskType, number> = {
      audit: 0,
      risk_validation: 0,
      credit_scoring: 0,
    };

    let totalSpent = 0;
    for (const r of this.records) {
      tasksByType[r.taskType]++;
      totalSpent += r.bountyUsdc;
    }

    return {
      totalPosted: this.records.length,
      totalSpentUsdc: totalSpent,
      tasksByType,
      lastPostedAt: this.records.length > 0 ? this.records[this.records.length - 1].postedAt : 0,
      startedAt: this.records.length > 0 ? this.records[0].postedAt : Date.now(),
    };
  }

  getRecentRecords(limit = 10): PostRecord[] {
    return this.records.slice(-limit);
  }

  // ═══════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════

  private loadRecords(): void {
    try {
      if (existsSync(this.recordsFile)) {
        this.records = JSON.parse(readFileSync(this.recordsFile, 'utf-8'));
      }
    } catch {
      this.records = [];
    }
  }

  private saveRecords(): void {
    try {
      const tmp = this.recordsFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8');
      renameSync(tmp, this.recordsFile);
    } catch (err: any) {
      log.error({ err: err.message }, 'Failed to save records');
    }
  }
}

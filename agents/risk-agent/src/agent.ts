/**
 * RiskAgent — Main Orchestrator
 *
 * Event-driven agent loop:
 *   Monitor → Evaluate → Bid → [Wait for assignment] → Analyze → Deliver
 *
 * Uses direct ethers.Contract for on-chain reads and events
 * (bypasses SDK Arena class for reliability).
 */

import { ethers } from 'ethers';
import type { AgentConfig, TrackedTask } from './types.js';
import type { TaskInfo } from '@arena-protocol/sdk';
import { Persistence } from './persistence.js';
import { WalletTracker } from './wallet.js';
import { BiddingManager } from './bidding.js';
import { executeRiskAssessment } from './execution.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'agent' });

const USDC_DECIMALS = 6;

// ABI subset for reading tasks, assignments, and listening to events
const ARENA_ABI = [
  'function taskCount() view returns (uint256)',
  'function getTask(uint256 taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function agentReputation(address) view returns (uint256)',

  // Events
  'event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)',
  'event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price)',
  'event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)',
  'event TaskCancelled(uint256 indexed taskId)',
];

const STATUS_NAMES = ['Open', 'BidReveal', 'Assigned', 'Delivered', 'Verifying', 'Completed', 'Failed', 'Disputed', 'Cancelled'];

export class RiskAgent {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletTracker;
  private bidding: BiddingManager;
  private arenaContract: ethers.Contract;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.persistence = new Persistence(config.dataDir);
    this.wallet = new WalletTracker(config, this.persistence);
    this.bidding = new BiddingManager(config, this.persistence, this.wallet);

    this.arenaContract = new ethers.Contract(
      config.arenaCoreAddress,
      ARENA_ABI,
      this.wallet.signer
    );
  }

  // ═══════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    this.running = true;
    log.info('═══════════════════════════════════════');
    log.info('  RiskAgent Starting');
    log.info('═══════════════════════════════════════');

    await this.wallet.logStatus();

    // Log agent reputation
    try {
      const rep = await this.arenaContract.agentReputation(this.wallet.address);
      log.info({ reputation: Number(rep) }, 'Agent on-chain reputation');
    } catch {
      log.warn('Could not fetch on-chain stats');
    }

    // Set up event listeners
    this.setupEventListeners();

    // Start polling fallback
    this.pollTimer = setInterval(() => {
      this.pollForTasks().catch((err: any) =>
        log.error({ err: err.message }, 'Poll cycle failed')
      );
    }, this.config.pollIntervalMs);

    // Recover in-progress tasks
    await this.recoverTasks();

    // Initial poll
    await this.pollForTasks();

    log.info(
      {
        address: this.wallet.address,
        riskModel: this.config.riskModel,
        riskTolerance: this.config.riskTolerance,
        pollInterval: this.config.pollIntervalMs,
      },
      'RiskAgent running'
    );
  }

  async stop(): Promise<void> {
    log.info('Stopping RiskAgent...');
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.arenaContract.removeAllListeners();
    this.persistence.pruneOldRecords();
    log.info('RiskAgent stopped');
  }

  // ═══════════════════════════════════════════════════
  // EVENT LISTENERS (ethers.Contract events)
  // ═══════════════════════════════════════════════════

  private setupEventListeners(): void {
    try {
      // Listen for new tasks
      this.arenaContract.on(
        'TaskCreated',
        (taskId: bigint, poster: string, bounty: bigint, taskType: string, deadline: bigint, requiredVerifiers: bigint) => {
          this.handleTaskCreated(taskId, poster, bounty, taskType, Number(deadline))
            .catch((err: any) => log.error({ err: err.message, taskId: taskId.toString() }, 'Error handling TaskCreated'));
        }
      );

      // Listen for our assignments
      this.arenaContract.on(
        'AgentAssigned',
        (taskId: bigint, agent: string) => {
          if (agent.toLowerCase() === this.wallet.address.toLowerCase()) {
            const id = Number(taskId);
            log.info({ taskId: id }, 'We were assigned to task!');
            this.handleAssignment(id)
              .catch((err: any) => log.error({ err: err.message, taskId: id }, 'Error handling AgentAssigned'));
          }
        }
      );

      // Listen for task completions (release stakes)
      this.arenaContract.on(
        'TaskCompleted',
        (taskId: bigint, agent: string) => {
          if (agent.toLowerCase() === this.wallet.address.toLowerCase()) {
            const id = Number(taskId);
            this.wallet.releaseStake(id);
            this.persistence.updateTaskState(id, { status: 'completed' });
            log.info({ taskId: id }, 'Task completed — stake released');
          }
        }
      );

      // Listen for cancellations
      this.arenaContract.on('TaskCancelled', (taskId: bigint) => {
        const id = Number(taskId);
        const tracked = this.persistence.getTaskState(id);
        if (tracked) {
          this.wallet.releaseStake(id);
          this.persistence.updateTaskState(id, { status: 'failed' });
          log.info({ taskId: id }, 'Task cancelled — stake released');
        }
      });

      log.info('Event listeners active');
    } catch (err: any) {
      log.warn({ err: err.message }, 'Event listener setup failed — relying on polling');
    }
  }

  // ═══════════════════════════════════════════════════
  // TASK EVALUATION & BIDDING
  // ═══════════════════════════════════════════════════

  private async handleTaskCreated(
    taskId: bigint,
    poster: string,
    bounty: bigint,
    taskType: string,
    deadline: number
  ): Promise<void> {
    const id = Number(taskId);
    log.info({ taskId: id, taskType, bounty: ethers.formatUnits(bounty, USDC_DECIMALS) }, 'TaskCreated event');
    await this.evaluateAndBid(id);
  }

  private async evaluateAndBid(taskId: number): Promise<void> {
    if (!this.running) return;

    try {
      // Read task data directly from contract
      const taskData = await this.arenaContract.getTask(taskId);
      const task = this.parseTaskData(taskId, taskData);

      // Check if we should bid
      const decision = await this.bidding.shouldBid(task);
      if (!decision.bid) {
        log.debug({ taskId, reason: decision.reason }, 'Skipping task');
        this.persistence.saveTaskState({
          taskId,
          poster: task.poster,
          bounty: task.bounty,
          deadline: task.deadline,
          bidDeadline: task.bidDeadline,
          revealDeadline: task.revealDeadline,
          criteriaHash: task.criteriaHash,
          taskType: task.taskType,
          status: 'skipped',
          updatedAt: Date.now(),
        });
        return;
      }

      // Commit bid
      log.info({ taskId, bounty: task.bounty }, 'Bidding on task');
      const bidRecord = await this.bidding.commitBid(task);

      this.persistence.saveTaskState({
        taskId,
        poster: task.poster,
        bounty: task.bounty,
        deadline: task.deadline,
        bidDeadline: task.bidDeadline,
        revealDeadline: task.revealDeadline,
        criteriaHash: task.criteriaHash,
        taskType: task.taskType,
        status: 'bid_committed',
        ourBid: bidRecord,
        updatedAt: Date.now(),
      });

      log.info({ taskId }, 'Bid committed successfully');
    } catch (err: any) {
      log.error({ err: err.message, taskId }, 'Failed to evaluate/bid on task');
    }
  }

  // ═══════════════════════════════════════════════════
  // BID REVEAL
  // ═══════════════════════════════════════════════════

  private async checkAndRevealBids(): Promise<void> {
    const tasks = this.persistence.loadTaskStates()
      .filter((t) => t.status === 'bid_committed');

    for (const tracked of tasks) {
      try {
        const taskData = await this.arenaContract.getTask(tracked.taskId);
        const task = this.parseTaskData(tracked.taskId, taskData);

        const revealed = await this.bidding.checkAndReveal(task);
        if (revealed) {
          this.persistence.updateTaskState(tracked.taskId, { status: 'bid_revealed' });
          log.info({ taskId: tracked.taskId }, 'Bid revealed');
        }
      } catch (err: any) {
        log.error({ err: err.message, taskId: tracked.taskId }, 'Reveal check failed');
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // ASSIGNMENT & EXECUTION
  // ═══════════════════════════════════════════════════

  private async handleAssignment(taskId: number): Promise<void> {
    if (!this.running) return;

    this.persistence.updateTaskState(taskId, { status: 'assigned' });
    this.persistence.updateBidRecord(taskId, { assigned: true });

    log.info({ taskId }, 'Starting risk assessment execution');

    const tracked = this.persistence.getTaskState(taskId);
    if (!tracked) {
      log.error({ taskId }, 'No tracked task state for assigned task');
      return;
    }

    const outputHash = await executeRiskAssessment(
      taskId,
      tracked.criteriaHash,
      this.config,
      this.persistence,
    );

    if (outputHash) {
      log.info({ taskId, outputHash }, 'Risk assessment delivered successfully');
    } else {
      log.error({ taskId }, 'Risk assessment execution failed');
    }
  }

  // ═══════════════════════════════════════════════════
  // POLLING FALLBACK
  // ═══════════════════════════════════════════════════

  private async pollForTasks(): Promise<void> {
    if (!this.running) return;

    try {
      // Check for bids that need revealing
      await this.checkAndRevealBids();

      // Check for assignments on revealed bids
      const revealed = this.persistence.loadTaskStates()
        .filter((t) => t.status === 'bid_revealed');

      for (const tracked of revealed) {
        try {
          const taskData = await this.arenaContract.getTask(tracked.taskId);
          const status = Number(taskData.status);

          // Status 2 = Assigned, 3 = Delivered
          if (status === 2) {
            const assignment = await this.arenaContract.getAssignment(tracked.taskId);
            if (assignment.agent.toLowerCase() === this.wallet.address.toLowerCase()) {
              log.info({ taskId: tracked.taskId }, 'Detected assignment via polling');
              await this.handleAssignment(tracked.taskId);
            }
          }
        } catch (err: any) {
          log.error({ err: err.message, taskId: tracked.taskId }, 'Poll check failed');
        }
      }

      // Poll for new open tasks
      try {
        const taskCount = Number(await this.arenaContract.taskCount());
        // Check recent tasks (last 20)
        const start = Math.max(1, taskCount - 20);
        for (let i = start; i <= taskCount; i++) {
          const existing = this.persistence.getTaskState(i);
          if (existing) continue;

          try {
            const taskData = await this.arenaContract.getTask(i);
            const status = Number(taskData.status);
            // Status 0 = Open
            if (status !== 0) continue;

            const taskType = taskData.taskType;
            if (taskType === 'risk_validation') {
              log.info({ taskId: i }, 'Found open risk_validation task via polling');
              await this.evaluateAndBid(i);
            }
          } catch { /* skip invalid tasks */ }
        }
      } catch (err: any) {
        log.debug({ err: err.message }, 'Task count polling failed');
      }
    } catch (err: any) {
      log.error({ err: err.message }, 'Poll cycle error');
    }
  }

  // ═══════════════════════════════════════════════════
  // RECOVERY
  // ═══════════════════════════════════════════════════

  private async recoverTasks(): Promise<void> {
    const tasks = this.persistence.loadTaskStates();
    const activeCount = tasks.filter(
      (t) => !['completed', 'failed', 'skipped', 'delivered'].includes(t.status)
    ).length;

    if (activeCount > 0) {
      log.info({ activeCount }, 'Recovering in-progress tasks');
    }

    for (const tracked of tasks) {
      try {
        switch (tracked.status) {
          case 'bid_committed':
            log.info({ taskId: tracked.taskId }, 'Recovering committed bid — will check reveal');
            break;

          case 'bid_revealed':
            log.info({ taskId: tracked.taskId }, 'Recovering revealed bid — will check assignment');
            break;

          case 'assigned':
          case 'executing':
            log.info({ taskId: tracked.taskId }, 'Recovering assigned task — re-executing');
            await this.handleAssignment(tracked.taskId);
            break;
        }
      } catch (err: any) {
        log.error({ err: err.message, taskId: tracked.taskId }, 'Task recovery failed');
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════

  private parseTaskData(taskId: number, data: any): TaskInfo {
    return {
      id: taskId.toString(),
      poster: data.poster,
      token: data.token,
      bounty: ethers.formatUnits(data.bounty, USDC_DECIMALS),
      deadline: Number(data.deadline),
      slashWindow: Number(data.slashWindow),
      createdAt: Number(data.createdAt),
      bidDeadline: Number(data.bidDeadline),
      revealDeadline: Number(data.revealDeadline),
      requiredVerifiers: Number(data.requiredVerifiers),
      status: STATUS_NAMES[Number(data.status)]?.toLowerCase().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() as any || 'open',
      criteriaHash: data.criteriaHash,
      taskType: data.taskType,
    };
  }
}

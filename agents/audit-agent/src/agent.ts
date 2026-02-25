/**
 * AuditAgent — Main Orchestrator
 *
 * Event-driven agent that:
 * 1. Monitors for new audit tasks via events + polling fallback
 * 2. Evaluates and bids on suitable tasks
 * 3. Automatically reveals bids when the reveal window opens
 * 4. Executes analysis when assigned a task
 * 5. Delivers results on-chain
 *
 * Error isolation: individual task failures never crash the agent.
 */

import { ethers } from 'ethers';
import { ArenaEventListener } from '@arena-protocol/sdk';
import type {
  TaskCreatedEvent,
  AgentAssignedEvent,
  TaskCompletedEvent,
  AgentSlashedEvent,
} from '@arena-protocol/sdk';
import type { AgentConfig, TrackedTask } from './types.js';
import { Persistence } from './persistence.js';
import { WalletTracker } from './wallet.js';
import { BiddingManager } from './bidding.js';
import { ExecutionPipeline } from './execution.js';
import { logger } from './logger.js';

// Full ArenaCore ABI subset for reading tasks and listening to events
const ARENA_ABI = [
  'function taskCount() view returns (uint256)',
  'function getTask(uint256 taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function agentReputation(address) view returns (uint256)',
  'function agentTasksCompleted(address) view returns (uint256)',
  'function agentTasksFailed(address) view returns (uint256)',

  // Events
  'event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)',
  'event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price)',
  'event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)',
  'event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)',
  'event TaskCancelled(uint256 indexed taskId)',
];

const STATUS_NAMES = ['Open', 'BidReveal', 'Assigned', 'Delivered', 'Verifying', 'Completed', 'Failed', 'Disputed', 'Cancelled'];

export class AuditAgent {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletTracker;
  private bidding: BiddingManager;
  private execution: ExecutionPipeline;
  private arenaContract: ethers.Contract;
  private provider: ethers.JsonRpcProvider;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    // Initialize subsystems
    this.persistence = new Persistence(config.dataDir);
    this.wallet = new WalletTracker(config, this.persistence);
    this.bidding = new BiddingManager(config, this.persistence, this.wallet);
    this.execution = new ExecutionPipeline(config, this.persistence, this.wallet);

    // Contract instance for reading state + events
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
    logger.info('═══════════════════════════════════════════════════');
    logger.info('          AuditAgent Starting...');
    logger.info('═══════════════════════════════════════════════════');

    // Log wallet status
    await this.wallet.logStatus();

    // Log agent reputation
    try {
      const rep = await this.arenaContract.agentReputation(this.wallet.address);
      const completed = await this.arenaContract.agentTasksCompleted(this.wallet.address);
      const failed = await this.arenaContract.agentTasksFailed(this.wallet.address);
      logger.info(
        { reputation: Number(rep), completed: Number(completed), failed: Number(failed) },
        'Agent on-chain stats'
      );
    } catch (err) {
      logger.warn('Could not fetch on-chain stats (contract may not be deployed)');
    }

    // Set up event listeners
    this.setupEventListeners();

    // Start polling fallback
    this.startPolling();

    // Check for any pending reveals from previous session
    await this.checkPendingReveals();

    // Check for any assigned tasks from previous session
    await this.checkAssignedTasks();

    logger.info(
      {
        address: this.wallet.address,
        riskTolerance: this.config.riskTolerance,
        minBounty: this.config.minBountyUsdc,
        maxBid: this.config.maxBidUsdc,
        pollInterval: this.config.pollIntervalMs,
      },
      'AuditAgent is now monitoring for tasks'
    );
  }

  async stop(): Promise<void> {
    logger.info('Shutting down AuditAgent...');
    this.running = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Remove event listeners
    this.arenaContract.removeAllListeners();

    // Prune old records
    this.persistence.pruneOldRecords();

    logger.info('AuditAgent stopped');
  }

  // ═══════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════

  private setupEventListeners(): void {
    // Listen for new tasks
    this.arenaContract.on(
      'TaskCreated',
      (taskId: bigint, poster: string, bounty: bigint, taskType: string, deadline: bigint, requiredVerifiers: bigint) => {
        this.handleTaskCreated({
          taskId: taskId.toString(),
          poster,
          bounty,
          taskType,
          deadline: Number(deadline),
          requiredVerifiers: Number(requiredVerifiers),
        }).catch((err) => logger.error({ err, taskId: taskId.toString() }, 'Error handling TaskCreated'));
      }
    );

    // Listen for our assignments
    this.arenaContract.on(
      'AgentAssigned',
      (taskId: bigint, agent: string, stake: bigint, price: bigint) => {
        if (agent.toLowerCase() === this.wallet.address.toLowerCase()) {
          this.handleAssigned({
            taskId: taskId.toString(),
            agent,
            stake,
            price,
          }).catch((err) => logger.error({ err, taskId: taskId.toString() }, 'Error handling AgentAssigned'));
        }
      }
    );

    // Listen for task completion (to release stakes)
    this.arenaContract.on(
      'TaskCompleted',
      (taskId: bigint, agent: string, payout: bigint) => {
        if (agent.toLowerCase() === this.wallet.address.toLowerCase()) {
          this.handleCompleted(taskId.toString(), payout).catch((err) =>
            logger.error({ err }, 'Error handling TaskCompleted')
          );
        }
      }
    );

    // Listen for slashing (to update wallet)
    this.arenaContract.on(
      'AgentSlashed',
      (taskId: bigint, agent: string, amount: bigint, severity: number) => {
        if (agent.toLowerCase() === this.wallet.address.toLowerCase()) {
          logger.warn(
            {
              taskId: taskId.toString(),
              amount: ethers.formatUnits(amount, 6),
              severity,
            },
            'We were slashed!'
          );
          this.wallet.releaseStake(Number(taskId));
          this.persistence.updateTaskState(Number(taskId), { status: 'failed' });
        }
      }
    );

    // Listen for cancellations (to release stakes)
    this.arenaContract.on('TaskCancelled', (taskId: bigint) => {
      const id = Number(taskId);
      const tracked = this.persistence.getTaskState(id);
      if (tracked) {
        logger.info({ taskId: id }, 'Task cancelled, releasing stake');
        this.wallet.releaseStake(id);
        this.persistence.updateTaskState(id, { status: 'failed' });
      }
    });

    logger.info('Event listeners registered');
  }

  // ═══════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════

  private async handleTaskCreated(event: TaskCreatedEvent): Promise<void> {
    const taskId = parseInt(event.taskId);
    logger.info(
      {
        taskId,
        taskType: event.taskType,
        bounty: ethers.formatUnits(event.bounty, 6),
        poster: event.poster,
      },
      'New task detected'
    );

    // Get full task info
    const taskData = await this.arenaContract.getTask(taskId);
    const taskInfo = {
      id: event.taskId,
      poster: event.poster,
      token: taskData.token,
      bounty: ethers.formatUnits(event.bounty, 6),
      deadline: event.deadline,
      slashWindow: Number(taskData.slashWindow),
      createdAt: Number(taskData.createdAt),
      bidDeadline: Number(taskData.bidDeadline),
      revealDeadline: Number(taskData.revealDeadline),
      requiredVerifiers: event.requiredVerifiers,
      status: 'open' as const,
      criteriaHash: taskData.criteriaHash,
      taskType: event.taskType as any,
    };

    // Evaluate
    const evaluation = await this.bidding.shouldBid(taskInfo);

    if (!evaluation.bid) {
      logger.info({ taskId, reason: evaluation.reason }, 'Skipping task');
      this.persistence.saveTaskState({
        taskId,
        poster: event.poster,
        bounty: taskInfo.bounty,
        deadline: event.deadline,
        bidDeadline: taskInfo.bidDeadline,
        revealDeadline: taskInfo.revealDeadline,
        criteriaHash: taskData.criteriaHash,
        taskType: event.taskType,
        status: 'skipped',
        updatedAt: Date.now(),
      });
      return;
    }

    // Commit bid
    try {
      const bidRecord = await this.bidding.commitBid(taskInfo);

      this.persistence.saveTaskState({
        taskId,
        poster: event.poster,
        bounty: taskInfo.bounty,
        deadline: event.deadline,
        bidDeadline: taskInfo.bidDeadline,
        revealDeadline: taskInfo.revealDeadline,
        criteriaHash: taskData.criteriaHash,
        taskType: event.taskType,
        status: 'bid_committed',
        ourBid: bidRecord,
        updatedAt: Date.now(),
      });

      logger.info({ taskId }, 'Bid committed successfully');
    } catch (err: any) {
      logger.error({ err: err.message, taskId }, 'Failed to commit bid');
    }
  }

  private async handleAssigned(event: AgentAssignedEvent): Promise<void> {
    const taskId = parseInt(event.taskId);
    logger.info(
      {
        taskId,
        stake: ethers.formatUnits(event.stake, 6),
        price: ethers.formatUnits(event.price, 6),
      },
      'We won the auction! Starting execution...'
    );

    this.persistence.updateTaskState(taskId, { status: 'assigned' });
    this.persistence.updateBidRecord(taskId, { assigned: true });

    // Execute the task
    try {
      await this.execution.execute(taskId);
    } catch (err: any) {
      logger.error({ err: err.message, taskId }, 'Task execution failed');
    }
  }

  private async handleCompleted(taskId: string, payout: bigint): Promise<void> {
    const id = parseInt(taskId);
    logger.info(
      { taskId: id, payout: ethers.formatUnits(payout, 6) },
      'Task completed! Payout received.'
    );

    this.wallet.releaseStake(id);
    this.persistence.updateTaskState(id, { status: 'completed' });
    await this.wallet.logStatus();
  }

  // ═══════════════════════════════════════════════════
  // POLLING FALLBACK
  // ═══════════════════════════════════════════════════

  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.pollForTasks();
        await this.checkPendingReveals();
      } catch (err) {
        logger.error({ err }, 'Polling cycle error');
      }
    }, this.config.pollIntervalMs);
  }

  private async pollForTasks(): Promise<void> {
    try {
      const taskCount = Number(await this.arenaContract.taskCount());
      if (taskCount === 0) return;

      // Check the last 20 tasks for any we haven't seen
      const startIdx = Math.max(0, taskCount - 20);
      for (let i = startIdx; i < taskCount; i++) {
        const existing = this.persistence.getTaskState(i);
        if (existing) continue; // Already tracking

        try {
          const taskData = await this.arenaContract.getTask(i);
          const status = Number(taskData.status);

          // Only interested in Open tasks
          if (status !== 0) continue;

          const taskType = taskData.taskType;
          if (taskType !== 'audit') continue;

          logger.debug({ taskId: i, taskType }, 'Found open audit task via polling');

          // Trigger evaluation
          await this.handleTaskCreated({
            taskId: i.toString(),
            poster: taskData.poster,
            bounty: taskData.bounty,
            taskType,
            deadline: Number(taskData.deadline),
            requiredVerifiers: Number(taskData.requiredVerifiers),
          });
        } catch (err) {
          // Individual task read failures are non-fatal
          logger.debug({ err, taskId: i }, 'Failed to read task');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to poll for tasks');
    }
  }

  // ═══════════════════════════════════════════════════
  // RECOVERY (from previous session)
  // ═══════════════════════════════════════════════════

  private async checkPendingReveals(): Promise<void> {
    const bidRecords = this.persistence.loadBidRecords();
    const now = Math.floor(Date.now() / 1000);

    for (const record of bidRecords) {
      if (record.revealed || record.assigned) continue;

      try {
        const taskData = await this.arenaContract.getTask(record.taskId);
        const bidDeadline = Number(taskData.bidDeadline);
        const revealDeadline = Number(taskData.revealDeadline);
        const status = Number(taskData.status);

        // Status 1 = BidReveal, or we're past bid deadline but before reveal deadline
        if (status === 1 || (now > bidDeadline && now <= revealDeadline)) {
          logger.info({ taskId: record.taskId }, 'Revealing pending bid');
          await this.bidding.revealBid(record.taskId);
          this.persistence.updateTaskState(record.taskId, { status: 'bid_revealed' });
        } else if (now > revealDeadline && !record.revealed) {
          // Missed reveal window — stake is lost
          logger.error(
            { taskId: record.taskId },
            'MISSED reveal window! Bid cannot be revealed. Salt persisted for reference.'
          );
          this.persistence.updateTaskState(record.taskId, { status: 'failed' });
        }
      } catch (err) {
        logger.warn({ err, taskId: record.taskId }, 'Failed to check reveal status');
      }
    }
  }

  private async checkAssignedTasks(): Promise<void> {
    const tasks = this.persistence.loadTaskStates();

    for (const task of tasks) {
      if (task.status !== 'assigned') continue;

      logger.info({ taskId: task.taskId }, 'Found assigned task from previous session, resuming execution');
      try {
        await this.execution.execute(task.taskId);
      } catch (err: any) {
        logger.error({ err: err.message, taskId: task.taskId }, 'Failed to resume task execution');
      }
    }
  }
}

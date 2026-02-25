/**
 * AgentOrchestrator — Task Router
 *
 * Central event listener that monitors for new tasks, bid windows,
 * assignments, completions, and slashings. Routes events to the
 * appropriate registered agent based on task type.
 */

import { ethers } from 'ethers';
import type {
  AgentId,
  RegisteredAgent,
  TrackedTaskEvent,
  TaskEventStatus,
  OrchestratorConfig,
} from './types.js';
import type { NonceManager } from './nonce-manager.js';
import type { PnlTracker } from './pnl-tracker.js';
import { routerLog } from './logger.js';

const log = routerLog;

const USDC_DECIMALS = 6;

// Comprehensive ABI covering all events and reads
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
  'event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)',
  'event TaskDelivered(uint256 indexed taskId, address indexed agent, bytes32 outputHash)',
  'event VerifierAssigned(uint256 indexed taskId, address indexed verifier)',
];

const STATUS_NAMES = ['Open', 'BidReveal', 'Assigned', 'Delivered', 'Verifying', 'Completed', 'Failed', 'Disputed', 'Cancelled'];

/** Maps task types to agent IDs */
const TASK_TYPE_ROUTES: Record<string, AgentId> = {
  audit: 'audit',
  risk_validation: 'risk',
};

export class TaskRouter {
  private config: OrchestratorConfig;
  private nonceManager: NonceManager;
  private pnlTracker: PnlTracker;
  private arenaContract: ethers.Contract;
  private agents = new Map<AgentId, RegisteredAgent>();
  private trackedTasks = new Map<number, TrackedTaskEvent>();
  private running = false;

  constructor(
    config: OrchestratorConfig,
    nonceManager: NonceManager,
    pnlTracker: PnlTracker
  ) {
    this.config = config;
    this.nonceManager = nonceManager;
    this.pnlTracker = pnlTracker;

    this.arenaContract = nonceManager.createContract(
      config.arenaCoreAddress,
      ARENA_ABI
    );
  }

  /**
   * Register an agent for task routing.
   */
  registerAgent(agent: RegisteredAgent): void {
    this.agents.set(agent.id, agent);
    log.info(
      { agentId: agent.id, taskTypes: agent.taskTypes },
      'Agent registered for routing'
    );
  }

  /**
   * Start monitoring for events.
   */
  start(): void {
    this.running = true;
    this.setupEventListeners();
    log.info({ agentCount: this.agents.size }, 'Task router started');
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.running = false;
    this.arenaContract.removeAllListeners();
    log.info('Task router stopped');
  }

  /**
   * Get all tracked tasks.
   */
  getTrackedTasks(): TrackedTaskEvent[] {
    return Array.from(this.trackedTasks.values());
  }

  /**
   * Get active tasks (not completed/failed/skipped).
   */
  getActiveTasks(): TrackedTaskEvent[] {
    return this.getTrackedTasks().filter(
      (t) => !['completed', 'failed', 'skipped'].includes(t.status)
    );
  }

  /**
   * Get pending bids (committed but not yet revealed or assigned).
   */
  getPendingBids(): TrackedTaskEvent[] {
    return this.getTrackedTasks().filter(
      (t) => t.status === 'bid_committed' || t.status === 'bid_revealed'
    );
  }

  /**
   * Get the registered agent for a task type.
   */
  getAgentForTaskType(taskType: string): RegisteredAgent | undefined {
    const agentId = TASK_TYPE_ROUTES[taskType];
    if (!agentId) return undefined;
    return this.agents.get(agentId);
  }

  /**
   * Get agent reputation from contract.
   */
  async getAgentReputation(): Promise<number> {
    try {
      const rep = await this.arenaContract.agentReputation(this.nonceManager.address);
      return Number(rep);
    } catch {
      return 0;
    }
  }

  /**
   * Poll for new tasks (fallback for missed events).
   */
  async pollForTasks(): Promise<void> {
    if (!this.running) return;

    try {
      const taskCount = Number(await this.arenaContract.taskCount());
      const start = Math.max(1, taskCount - 30);

      for (let i = start; i <= taskCount; i++) {
        if (this.trackedTasks.has(i)) continue;

        try {
          const taskData = await this.arenaContract.getTask(i);
          const status = Number(taskData.status);
          const taskType = taskData.taskType as string;
          const bounty = ethers.formatUnits(taskData.bounty, USDC_DECIMALS);

          // Track all tasks for the dashboard
          const tracked: TrackedTaskEvent = {
            taskId: i,
            taskType,
            poster: taskData.poster,
            bounty,
            deadline: Number(taskData.deadline),
            routedTo: TASK_TYPE_ROUTES[taskType] || null,
            status: status === 0 ? 'detected' : this.mapOnChainStatus(status),
            createdAt: Number(taskData.createdAt) * 1000,
            updatedAt: Date.now(),
          };
          this.trackedTasks.set(i, tracked);

          // Check if we were assigned to any task
          if (status === 2) { // Assigned
            try {
              const assignment = await this.arenaContract.getAssignment(i);
              if (assignment.agent.toLowerCase() === this.nonceManager.address.toLowerCase()) {
                this.updateTask(i, { status: 'assigned', routedTo: TASK_TYPE_ROUTES[taskType] || null });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip invalid tasks */ }
      }
    } catch (err: any) {
      log.debug({ err: err.message }, 'Task polling failed');
    }
  }

  // ═══════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════

  private setupEventListeners(): void {
    try {
      this.arenaContract.on(
        'TaskCreated',
        (taskId: bigint, poster: string, bounty: bigint, taskType: string, deadline: bigint) => {
          this.handleTaskCreated(Number(taskId), poster, bounty, taskType, Number(deadline));
        }
      );

      this.arenaContract.on(
        'AgentAssigned',
        (taskId: bigint, agent: string, stake: bigint, price: bigint) => {
          if (agent.toLowerCase() === this.nonceManager.address.toLowerCase()) {
            this.updateTask(Number(taskId), { status: 'assigned' });
            log.info({ taskId: Number(taskId) }, 'Our agent was assigned');
          }
        }
      );

      this.arenaContract.on(
        'TaskCompleted',
        (taskId: bigint, agent: string, payout: bigint) => {
          if (agent.toLowerCase() === this.nonceManager.address.toLowerCase()) {
            const id = Number(taskId);
            const tracked = this.trackedTasks.get(id);
            this.updateTask(id, { status: 'completed' });

            // Record P&L
            if (tracked?.routedTo) {
              this.pnlTracker.recordCompletion(
                id,
                tracked.routedTo,
                tracked.taskType,
                ethers.formatUnits(payout, USDC_DECIMALS)
              );
            }
            log.info({ taskId: id, payout: ethers.formatUnits(payout, USDC_DECIMALS) }, 'Task completed');
          }
        }
      );

      this.arenaContract.on(
        'AgentSlashed',
        (taskId: bigint, agent: string, amount: bigint, severity: bigint) => {
          if (agent.toLowerCase() === this.nonceManager.address.toLowerCase()) {
            const id = Number(taskId);
            const tracked = this.trackedTasks.get(id);
            this.updateTask(id, { status: 'failed' });

            if (tracked?.routedTo) {
              this.pnlTracker.recordSlash(
                id,
                tracked.routedTo,
                tracked.taskType,
                ethers.formatUnits(amount, USDC_DECIMALS)
              );
            }
            log.warn(
              { taskId: id, amount: ethers.formatUnits(amount, USDC_DECIMALS), severity: Number(severity) },
              'Agent slashed'
            );
          }
        }
      );

      this.arenaContract.on('TaskCancelled', (taskId: bigint) => {
        const id = Number(taskId);
        if (this.trackedTasks.has(id)) {
          this.updateTask(id, { status: 'failed' });
          log.info({ taskId: id }, 'Task cancelled');
        }
      });

      this.arenaContract.on(
        'TaskDelivered',
        (taskId: bigint, agent: string) => {
          if (agent.toLowerCase() === this.nonceManager.address.toLowerCase()) {
            this.updateTask(Number(taskId), { status: 'delivered' });
          }
        }
      );

      log.info('Event listeners attached');
    } catch (err: any) {
      log.warn({ err: err.message }, 'Event listener setup failed — relying on polling');
    }
  }

  private handleTaskCreated(
    taskId: number,
    poster: string,
    bounty: bigint,
    taskType: string,
    deadline: number
  ): void {
    const bountyFormatted = ethers.formatUnits(bounty, USDC_DECIMALS);
    const routedTo = TASK_TYPE_ROUTES[taskType] || null;

    const tracked: TrackedTaskEvent = {
      taskId,
      taskType,
      poster,
      bounty: bountyFormatted,
      deadline,
      routedTo,
      status: routedTo ? 'routed' : 'detected',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.trackedTasks.set(taskId, tracked);

    if (routedTo) {
      const agent = this.agents.get(routedTo);
      if (agent && agent.status === 'running') {
        log.info(
          { taskId, taskType, routedTo, bounty: bountyFormatted },
          'Task routed to agent'
        );
        // The agent handles it via its own event listener
        // We just track it here
      } else {
        log.warn(
          { taskId, taskType, routedTo },
          'Task routed but agent is not running'
        );
      }
    } else {
      log.debug({ taskId, taskType }, 'No agent registered for task type');
    }
  }

  private updateTask(taskId: number, updates: Partial<TrackedTaskEvent>): void {
    const existing = this.trackedTasks.get(taskId);
    if (existing) {
      Object.assign(existing, updates, { updatedAt: Date.now() });
    }
  }

  private mapOnChainStatus(status: number): TaskEventStatus {
    switch (status) {
      case 0: return 'detected';      // Open
      case 1: return 'bid_revealed';   // BidReveal
      case 2: return 'assigned';       // Assigned
      case 3: return 'delivered';      // Delivered
      case 4: return 'executing';      // Verifying (from our perspective)
      case 5: return 'completed';      // Completed
      case 6: return 'failed';         // Failed
      case 7: return 'failed';         // Disputed
      case 8: return 'skipped';        // Cancelled
      default: return 'detected';
    }
  }

  /**
   * Prune old tasks from tracking (keep last 200).
   */
  pruneOldTasks(): void {
    if (this.trackedTasks.size <= 200) return;
    const sorted = Array.from(this.trackedTasks.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const toRemove = sorted.slice(0, sorted.length - 200);
    for (const [id] of toRemove) {
      this.trackedTasks.delete(id);
    }
  }
}

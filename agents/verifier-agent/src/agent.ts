/**
 * VerifierAgent — Main Orchestrator
 *
 * Event-driven agent that:
 * 1. Joins the verifier pool with configurable stake
 * 2. Monitors for tasks entering Verifying state where we're assigned
 * 3. Runs independent analysis and compares against agent submission
 * 4. Submits verification vote (standard or comparison mode)
 *
 * Verifier assignment happens via VRF (when enabled) or manual registration.
 * This agent handles VRF-assigned verification — it listens for VerifierAssigned
 * events addressed to us.
 */

import { ethers } from 'ethers';
import type { AgentConfig, TrackedVerification } from './types.js';
import { Persistence } from './persistence.js';
import { WalletManager } from './wallet.js';
import { VerificationPipeline } from './verification.js';
import { logger } from './logger.js';

const ARENA_ABI = [
  // Read functions
  'function taskCount() view returns (uint256)',
  'function getTask(uint256 taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function verifications(uint256, uint256) view returns (address verifier, uint256 stake, uint8 vote, bytes32 reportHash)',
  'function verifierRegistry(address) view returns (uint256 stake, bool active, uint256 registeredAt)',
  'function agentReputation(address) view returns (uint256)',

  // Manual registration (for non-VRF mode)
  'function registerVerifier(uint256 _taskId, uint256 _stake)',

  // Events
  'event VerifierAssigned(uint256 indexed taskId, address indexed verifier, uint256 stake)',
  'event VRFVerifiersAssigned(uint256 indexed taskId, address[] verifiers)',
  'event TaskDelivered(uint256 indexed taskId, address indexed agent, bytes32 outputHash)',
  'event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)',
  'event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)',
  'event VerifierSlashed(uint256 indexed taskId, address indexed verifier, uint256 amount)',
  'event VerificationSubmitted(uint256 indexed taskId, address indexed verifier, uint8 vote)',
  'event ComparisonSubmitted(uint256 indexed taskId, address indexed verifier, uint16 score, bool missedCrit, uint8 resolution)',
];

const STATUS_NAMES = ['Open', 'BidReveal', 'Assigned', 'Delivered', 'Verifying', 'Completed', 'Failed', 'Disputed', 'Cancelled'];

export class VerifierAgent {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletManager;
  private pipeline: VerificationPipeline;
  private arenaContract: ethers.Contract;
  private provider: ethers.JsonRpcProvider;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private activeVerifications = new Set<number>();

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    this.persistence = new Persistence(config.dataDir);
    this.wallet = new WalletManager(config, this.persistence);
    this.pipeline = new VerificationPipeline(config, this.persistence, this.wallet);

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
    logger.info('          VerifierAgent Starting...');
    logger.info('═══════════════════════════════════════════════════');

    // Log wallet & pool status
    await this.wallet.logStatus();

    // Auto-join verifier pool if configured
    if (this.config.autoJoinPool) {
      try {
        await this.wallet.joinPool();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to join verifier pool');
        // Continue — might already be in pool or VRF will assign us
      }
    }

    // Set up event listeners
    this.setupEventListeners();

    // Start polling fallback
    this.startPolling();

    // Check for pending verifications from previous session
    await this.checkPendingVerifications();

    logger.info(
      {
        address: this.wallet.address,
        approvalThreshold: this.config.approvalThreshold,
        autoRejectMissedCritical: this.config.autoRejectMissedCritical,
        useComparisonMode: this.config.useComparisonMode,
        pollInterval: this.config.pollIntervalMs,
      },
      'VerifierAgent is now monitoring for verification assignments'
    );
  }

  async stop(): Promise<void> {
    logger.info('Shutting down VerifierAgent...');
    this.running = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.arenaContract.removeAllListeners();
    this.persistence.pruneOldRecords();
    logger.info('VerifierAgent stopped');
  }

  // ═══════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════

  private setupEventListeners(): void {
    // Listen for individual verifier assignments (VRF or manual)
    this.arenaContract.on(
      'VerifierAssigned',
      (taskId: bigint, verifier: string, stake: bigint) => {
        if (verifier.toLowerCase() === this.wallet.address.toLowerCase()) {
          this.handleVerifierAssigned(Number(taskId), stake).catch((err) =>
            logger.error({ err, taskId: Number(taskId) }, 'Error handling VerifierAssigned')
          );
        }
      }
    );

    // Listen for VRF batch assignments
    this.arenaContract.on(
      'VRFVerifiersAssigned',
      (taskId: bigint, verifiers: string[]) => {
        const isUs = verifiers.some(
          (v) => v.toLowerCase() === this.wallet.address.toLowerCase()
        );
        if (isUs) {
          this.handleVerifierAssigned(Number(taskId), 0n).catch((err) =>
            logger.error({ err, taskId: Number(taskId) }, 'Error handling VRFVerifiersAssigned')
          );
        }
      }
    );

    // Listen for task deliveries (to potentially register manually)
    this.arenaContract.on(
      'TaskDelivered',
      (taskId: bigint, agent: string, outputHash: string) => {
        if (agent.toLowerCase() !== this.wallet.address.toLowerCase()) {
          this.handleTaskDelivered(Number(taskId), agent, outputHash).catch((err) =>
            logger.error({ err, taskId: Number(taskId) }, 'Error handling TaskDelivered')
          );
        }
      }
    );

    // Listen for our slashing (to log warnings)
    this.arenaContract.on(
      'VerifierSlashed',
      (taskId: bigint, verifier: string, amount: bigint) => {
        if (verifier.toLowerCase() === this.wallet.address.toLowerCase()) {
          logger.warn(
            {
              taskId: Number(taskId),
              amount: ethers.formatUnits(amount, 6),
            },
            'We were slashed as verifier!'
          );
        }
      }
    );

    logger.info('Event listeners registered');
  }

  // ═══════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════

  private async handleVerifierAssigned(taskId: number, stake: bigint): Promise<void> {
    logger.info(
      { taskId, stake: ethers.formatUnits(stake, 6) },
      'Assigned as verifier!'
    );

    // Check if we're already handling this task
    if (this.activeVerifications.has(taskId)) {
      logger.debug({ taskId }, 'Already processing this verification');
      return;
    }

    // Get task details
    const taskData = await this.arenaContract.getTask(taskId);
    const assignment = await this.arenaContract.getAssignment(taskId);

    // Save tracking record
    const record: TrackedVerification = {
      taskId,
      poster: taskData.poster,
      agent: assignment.agent,
      taskType: taskData.taskType,
      bounty: ethers.formatUnits(taskData.bounty, 6),
      ourStake: ethers.formatUnits(stake, 6),
      agentOutputHash: assignment.outputHash,
      criteriaHash: taskData.criteriaHash,
      status: 'detected',
      detectedAt: Date.now(),
    };
    this.persistence.saveVerification(record);

    // Execute verification
    this.activeVerifications.add(taskId);
    try {
      const decision = await this.pipeline.verify(taskId);
      logger.info(
        {
          taskId,
          vote: decision.vote,
          matchScore: decision.comparison.matchScore,
          missedCritical: decision.comparison.missedCritical,
        },
        'Verification submitted successfully'
      );
    } catch (err: any) {
      logger.error({ err: err.message, taskId }, 'Verification failed');
    } finally {
      this.activeVerifications.delete(taskId);
    }
  }

  /**
   * Handle task deliveries — attempt manual registration if VRF is disabled.
   */
  private async handleTaskDelivered(taskId: number, agent: string, outputHash: string): Promise<void> {
    // Only try manual registration for audit tasks
    const taskData = await this.arenaContract.getTask(taskId);
    if (taskData.taskType !== 'audit') return;

    // Check if we're the poster (can't verify our own tasks)
    if (taskData.poster.toLowerCase() === this.wallet.address.toLowerCase()) return;

    // Check if verifier slots are already full
    const requiredVerifiers = Number(taskData.requiredVerifiers);

    // Try to register as verifier manually
    try {
      const assignment = await this.arenaContract.getAssignment(taskId);
      const agentStake = BigInt(assignment.stake.toString());
      const minStake = agentStake / 5n; // 20% of agent stake

      // Check we have enough in our registry
      const { active, stake: regStake } = await this.wallet.isInPool();
      if (!active) {
        logger.debug({ taskId }, 'Not in verifier pool — cannot register manually');
        return;
      }

      if (regStake < minStake) {
        logger.debug(
          { taskId, regStake: ethers.formatUnits(regStake, 6), minStake: ethers.formatUnits(minStake, 6) },
          'Insufficient registry stake for manual registration'
        );
        return;
      }

      // Ensure approval
      await this.wallet.ensureApproval(minStake);

      logger.info({ taskId, stake: ethers.formatUnits(minStake, 6) }, 'Registering as verifier manually');
      const tx = await this.arenaContract.registerVerifier(taskId, minStake);
      const receipt = await tx.wait();
      logger.info(
        { taskId, txHash: receipt.hash },
        'Manually registered as verifier'
      );

      // The VerifierAssigned event will trigger handleVerifierAssigned
    } catch (err: any) {
      // Common: slots full, already registered, cooldown, etc. — all non-fatal
      logger.debug({ err: err.message, taskId }, 'Manual registration skipped');
    }
  }

  // ═══════════════════════════════════════════════════
  // POLLING FALLBACK
  // ═══════════════════════════════════════════════════

  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.pollForVerifications();
      } catch (err) {
        logger.error({ err }, 'Polling cycle error');
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * Poll for tasks in Verifying state where we're an assigned verifier.
   */
  private async pollForVerifications(): Promise<void> {
    try {
      const taskCount = Number(await this.arenaContract.taskCount());
      if (taskCount === 0) return;

      // Check last 50 tasks for Verifying status
      const startIdx = Math.max(0, taskCount - 50);
      for (let i = startIdx; i < taskCount; i++) {
        // Skip if we're already handling this
        if (this.activeVerifications.has(i)) continue;
        const existing = this.persistence.getVerification(i);
        if (existing && existing.status !== 'detected') continue;

        try {
          const taskData = await this.arenaContract.getTask(i);
          const status = Number(taskData.status);

          // Status 4 = Verifying
          if (status !== 4) continue;

          // Check if we're assigned as verifier
          const isAssigned = await this.checkIfAssigned(i);
          if (!isAssigned) continue;

          // Check if we've already voted
          const hasVoted = await this.checkIfVoted(i);
          if (hasVoted) continue;

          logger.info({ taskId: i }, 'Found pending verification via polling');
          await this.handleVerifierAssigned(i, 0n);
        } catch (err) {
          logger.debug({ err, taskId: i }, 'Failed to check task');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Polling failed');
    }
  }

  /**
   * Check if we're assigned as verifier for a task.
   */
  private async checkIfAssigned(taskId: number): Promise<boolean> {
    try {
      // Read verifications array for this task
      for (let i = 0; i < 5; i++) {
        try {
          const v = await this.arenaContract.verifications(taskId, i);
          if (v.verifier.toLowerCase() === this.wallet.address.toLowerCase()) {
            return true;
          }
        } catch {
          break; // Out of bounds — no more verifiers
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if we've already submitted our vote.
   */
  private async checkIfVoted(taskId: number): Promise<boolean> {
    try {
      for (let i = 0; i < 5; i++) {
        try {
          const v = await this.arenaContract.verifications(taskId, i);
          if (v.verifier.toLowerCase() === this.wallet.address.toLowerCase()) {
            return Number(v.vote) !== 0; // 0 = Pending
          }
        } catch {
          break;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════
  // RECOVERY
  // ═══════════════════════════════════════════════════

  private async checkPendingVerifications(): Promise<void> {
    const records = this.persistence.loadVerifications();

    for (const record of records) {
      if (record.status !== 'detected' && record.status !== 'analyzing') continue;

      logger.info({ taskId: record.taskId }, 'Resuming pending verification from previous session');

      try {
        // Verify task is still in Verifying state
        const taskData = await this.arenaContract.getTask(record.taskId);
        if (Number(taskData.status) !== 4) {
          logger.info({ taskId: record.taskId, status: STATUS_NAMES[Number(taskData.status)] }, 'Task no longer in Verifying state');
          this.persistence.updateVerification(record.taskId, { status: 'failed' });
          continue;
        }

        // Check we haven't already voted
        const hasVoted = await this.checkIfVoted(record.taskId);
        if (hasVoted) {
          logger.info({ taskId: record.taskId }, 'Already voted, updating state');
          this.persistence.updateVerification(record.taskId, { status: 'voted' });
          continue;
        }

        await this.handleVerifierAssigned(record.taskId, 0n);
      } catch (err: any) {
        logger.error({ err: err.message, taskId: record.taskId }, 'Failed to resume verification');
      }
    }
  }
}

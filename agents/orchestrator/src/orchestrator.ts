/**
 * AgentOrchestrator — Main Daemon
 *
 * Runs all registered agents simultaneously. Provides:
 *   - Centralized event monitoring and task routing
 *   - Nonce-managed wallet for safe concurrent transactions
 *   - Per-agent P&L tracking with auto-restake
 *   - Terminal dashboard with real-time status
 */

import { ethers } from 'ethers';
import type {
  OrchestratorConfig,
  RegisteredAgent,
  DashboardState,
} from './types.js';
import { NonceManager } from './nonce-manager.js';
import { TaskRouter } from './task-router.js';
import { PnlTracker } from './pnl-tracker.js';
import { Dashboard } from './dashboard.js';
import { createAgentRegistry } from './agent-wrappers.js';
import { orchLog } from './logger.js';

const log = orchLog;

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

export class AgentOrchestrator {
  private config: OrchestratorConfig;
  private nonceManager: NonceManager;
  private pnlTracker: PnlTracker;
  private taskRouter: TaskRouter;
  private dashboard: Dashboard;
  private agents: RegisteredAgent[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private running = false;
  private useDashboard: boolean;

  constructor(config: OrchestratorConfig, useDashboard = true) {
    this.config = config;
    this.useDashboard = useDashboard;

    // Core subsystems
    this.nonceManager = new NonceManager(config.rpcUrl, config.privateKey);
    this.pnlTracker = new PnlTracker(config);
    this.taskRouter = new TaskRouter(config, this.nonceManager, this.pnlTracker);
    this.dashboard = new Dashboard(config.dashboardRefreshMs);

    // Build agent registry
    this.agents = createAgentRegistry(config);
  }

  // ═══════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();

    log.info('╔══════════════════════════════════════════════════╗');
    log.info('║       ARENA AGENT ORCHESTRATOR                  ║');
    log.info('╚══════════════════════════════════════════════════╝');

    // Sync nonce
    await this.nonceManager.syncNonce();

    // Log wallet info
    const ethBal = await this.nonceManager.getEthBalance();
    const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    const usdcContract = new ethers.Contract(this.config.usdcAddress, ERC20_ABI, provider);
    const usdcBal = await usdcContract.balanceOf(this.nonceManager.address);

    log.info({
      address: this.nonceManager.address,
      ethBalance: ethers.formatEther(ethBal),
      usdcBalance: ethers.formatUnits(usdcBal, USDC_DECIMALS),
      enabledAgents: this.agents.map((a) => a.id),
    }, 'Wallet status');

    // Register agents with router
    for (const agent of this.agents) {
      this.taskRouter.registerAgent(agent);
    }

    // Start central event monitoring
    this.taskRouter.start();

    // Start all agents concurrently
    log.info({ count: this.agents.length }, 'Starting all agents...');
    await this.startAllAgents();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.pollCycle().catch((err: any) =>
        log.error({ err: err.message }, 'Poll cycle error')
      );
    }, this.config.pollIntervalMs);

    // Initial poll
    await this.pollCycle();

    // Start dashboard (must be last — takes over terminal)
    if (this.useDashboard && process.stdout.isTTY) {
      this.dashboard.setStateProvider(() => this.buildDashboardState());
      this.dashboard.start();
    } else {
      log.info('Dashboard disabled (non-TTY or explicitly disabled)');
    }

    log.info({
      agents: this.agents.map((a) => `${a.id}:${a.status}`),
      pollInterval: this.config.pollIntervalMs,
      autoRestake: this.config.autoRestake,
    }, 'Orchestrator fully started');
  }

  async stop(): Promise<void> {
    log.info('Stopping orchestrator...');
    this.running = false;

    // Stop dashboard first (restore terminal)
    this.dashboard.stop();

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop all agents concurrently
    await this.stopAllAgents();

    // Stop router
    this.taskRouter.stop();

    // Cleanup
    this.pnlTracker.pruneOldRecords();
    this.taskRouter.pruneOldTasks();

    log.info('Orchestrator stopped');
  }

  // ═══════════════════════════════════════════════════
  // AGENT MANAGEMENT
  // ═══════════════════════════════════════════════════

  private async startAllAgents(): Promise<void> {
    const startPromises = this.agents.map(async (agent) => {
      agent.status = 'starting';
      try {
        await agent.instance.start();
        agent.status = 'running';
        agent.startedAt = Date.now();
        agent.lastActivity = Date.now();
        log.info({ agentId: agent.id }, 'Agent started successfully');
      } catch (err: any) {
        agent.status = 'error';
        agent.errorMessage = err.message;
        log.error({ agentId: agent.id, err: err.message }, 'Agent failed to start');
      }
    });

    // Use allSettled so one agent failure doesn't block others
    await Promise.allSettled(startPromises);

    const running = this.agents.filter((a) => a.status === 'running').length;
    const errored = this.agents.filter((a) => a.status === 'error').length;
    log.info({ running, errored, total: this.agents.length }, 'Agent startup complete');
  }

  private async stopAllAgents(): Promise<void> {
    const stopPromises = this.agents.map(async (agent) => {
      if (agent.status === 'running' || agent.status === 'error') {
        agent.status = 'stopping';
        try {
          await agent.instance.stop();
          agent.status = 'stopped';
          log.info({ agentId: agent.id }, 'Agent stopped');
        } catch (err: any) {
          agent.status = 'stopped';
          log.error({ agentId: agent.id, err: err.message }, 'Agent stop error');
        }
      }
    });

    await Promise.allSettled(stopPromises);
  }

  // ═══════════════════════════════════════════════════
  // POLLING
  // ═══════════════════════════════════════════════════

  private async pollCycle(): Promise<void> {
    if (!this.running) return;

    try {
      // Poll for tasks
      await this.taskRouter.pollForTasks();

      // Check auto-restake
      try {
        const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
        const usdcContract = new ethers.Contract(this.config.usdcAddress, ERC20_ABI, provider);
        const bal = await usdcContract.balanceOf(this.nonceManager.address);
        const balNum = parseFloat(ethers.formatUnits(bal, USDC_DECIMALS));
        await this.pnlTracker.checkAutoRestake(balNum);
      } catch { /* skip */ }

      // Update agent activity timestamps
      for (const agent of this.agents) {
        if (agent.status === 'running') {
          agent.lastActivity = Date.now();
        }
      }
    } catch (err: any) {
      log.error({ err: err.message }, 'Poll cycle error');
    }
  }

  // ═══════════════════════════════════════════════════
  // DASHBOARD STATE
  // ═══════════════════════════════════════════════════

  private async buildDashboardState(): Promise<DashboardState> {
    let usdcBalance = '0.00';
    let ethBalance = '0.0000';

    try {
      const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
      const usdcContract = new ethers.Contract(this.config.usdcAddress, ERC20_ABI, provider);
      const bal = await usdcContract.balanceOf(this.nonceManager.address);
      usdcBalance = parseFloat(ethers.formatUnits(bal, USDC_DECIMALS)).toFixed(2);

      const ethBal = await this.nonceManager.getEthBalance();
      ethBalance = parseFloat(ethers.formatEther(ethBal)).toFixed(4);
    } catch { /* use defaults */ }

    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeTasks = this.taskRouter.getActiveTasks();
    const pendingBids = this.taskRouter.getPendingBids();
    const pnlSummaries = this.pnlTracker.getAllSummaries();

    return {
      walletAddress: this.nonceManager.address,
      usdcBalance: usdcBalance + ' USDC',
      availableBalance: usdcBalance + ' USDC',
      ethBalance: ethBalance + ' ETH',
      agentStatuses: this.agents,
      activeTasks,
      pendingBids,
      recentOutcomes: this.pnlTracker.getRecentRecords(10),
      pnlSummaries,
      totalNetProfit: this.pnlTracker.getTotalNetProfit(),
      uptime,
    };
  }
}

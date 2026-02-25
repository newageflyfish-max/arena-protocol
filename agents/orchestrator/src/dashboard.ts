/**
 * AgentOrchestrator — Terminal Dashboard
 *
 * Real-time terminal UI showing:
 *   - Wallet balance and address
 *   - Agent statuses (running/stopped/error)
 *   - Active tasks with routing info
 *   - Pending bids
 *   - Recent P&L outcomes
 *   - Aggregate profit/loss
 */

import type {
  DashboardState,
  RegisteredAgent,
  TrackedTaskEvent,
  PnlRecord,
  AgentPnlSummary,
} from './types.js';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

const c = COLORS;

export class Dashboard {
  private refreshMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stateProvider: (() => Promise<DashboardState>) | null = null;
  private startTime = Date.now();
  private lastState: DashboardState | null = null;

  constructor(refreshMs = 2000) {
    this.refreshMs = refreshMs;
  }

  /**
   * Set the state provider function.
   */
  setStateProvider(provider: () => Promise<DashboardState>): void {
    this.stateProvider = provider;
  }

  /**
   * Start rendering the dashboard.
   */
  start(): void {
    if (!this.stateProvider) return;
    this.startTime = Date.now();

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.timer = setInterval(async () => {
      try {
        const state = await this.stateProvider!();
        this.lastState = state;
        this.render(state);
      } catch {
        // Skip render on error
      }
    }, this.refreshMs);

    // Initial render
    this.stateProvider().then((s) => {
      this.lastState = s;
      this.render(s);
    }).catch(() => {});
  }

  /**
   * Stop the dashboard.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Show cursor
    process.stdout.write('\x1b[?25h');
    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');
  }

  // ═══════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════

  private render(state: DashboardState): void {
    const lines: string[] = [];

    // Clear screen and move to top
    lines.push('\x1b[2J\x1b[H');

    // Header
    lines.push(this.renderHeader(state));
    lines.push('');

    // Wallet
    lines.push(this.renderWallet(state));
    lines.push('');

    // Agent statuses
    lines.push(this.renderAgentStatuses(state.agentStatuses));
    lines.push('');

    // Active tasks
    lines.push(this.renderActiveTasks(state.activeTasks));
    lines.push('');

    // Pending bids
    lines.push(this.renderPendingBids(state.pendingBids));
    lines.push('');

    // P&L Summary
    lines.push(this.renderPnlSummary(state.pnlSummaries, state.totalNetProfit));
    lines.push('');

    // Recent outcomes
    lines.push(this.renderRecentOutcomes(state.recentOutcomes));
    lines.push('');

    // Footer
    lines.push(this.renderFooter());

    process.stdout.write(lines.join('\n'));
  }

  private renderHeader(state: DashboardState): string {
    const uptime = formatDuration(state.uptime);
    return [
      `${c.bold}${c.cyan}╔══════════════════════════════════════════════════════════════╗${c.reset}`,
      `${c.bold}${c.cyan}║${c.reset}  ${c.bold}${c.white}ARENA AGENT ORCHESTRATOR${c.reset}                   ${c.dim}uptime: ${uptime}${c.reset}  ${c.bold}${c.cyan}║${c.reset}`,
      `${c.bold}${c.cyan}╚══════════════════════════════════════════════════════════════╝${c.reset}`,
    ].join('\n');
  }

  private renderWallet(state: DashboardState): string {
    const addr = state.walletAddress;
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    return [
      `${c.bold} WALLET${c.reset}`,
      `  Address:   ${c.cyan}${short}${c.reset}`,
      `  USDC:      ${c.bold}${c.green}${state.usdcBalance}${c.reset}  ${c.dim}(available: ${state.availableBalance})${c.reset}`,
      `  ETH:       ${c.dim}${state.ethBalance}${c.reset}`,
    ].join('\n');
  }

  private renderAgentStatuses(agents: RegisteredAgent[]): string {
    const lines = [`${c.bold} AGENTS${c.reset}`];

    for (const agent of agents) {
      const statusIcon = this.getStatusIcon(agent.status);
      const statusColor = this.getStatusColor(agent.status);
      const types = agent.taskTypes.join(', ');
      const activity = agent.lastActivity
        ? `${c.dim}last: ${timeAgo(agent.lastActivity)}${c.reset}`
        : '';

      lines.push(
        `  ${statusIcon} ${c.bold}${agent.name}${c.reset}  ${statusColor}${agent.status}${c.reset}  ${c.dim}[${types}]${c.reset}  ${activity}`
      );

      if (agent.errorMessage) {
        lines.push(`    ${c.red}└─ ${agent.errorMessage}${c.reset}`);
      }
    }

    return lines.join('\n');
  }

  private renderActiveTasks(tasks: TrackedTaskEvent[]): string {
    const lines = [`${c.bold} ACTIVE TASKS${c.reset} ${c.dim}(${tasks.length})${c.reset}`];

    if (tasks.length === 0) {
      lines.push(`  ${c.dim}No active tasks${c.reset}`);
      return lines.join('\n');
    }

    // Show most recent 8
    const display = tasks.slice(-8);
    for (const task of display) {
      const statusColor = this.getTaskStatusColor(task.status);
      const agent = task.routedTo ? `→${task.routedTo}` : '?';
      const deadline = task.deadline > 0 ? timeUntil(task.deadline) : '';

      lines.push(
        `  ${c.dim}#${task.taskId}${c.reset} ${c.yellow}${task.taskType}${c.reset} ${statusColor}${task.status}${c.reset} ${c.dim}${agent}${c.reset} ${c.bold}${task.bounty} USDC${c.reset} ${c.dim}${deadline}${c.reset}`
      );
    }

    if (tasks.length > 8) {
      lines.push(`  ${c.dim}... and ${tasks.length - 8} more${c.reset}`);
    }

    return lines.join('\n');
  }

  private renderPendingBids(bids: TrackedTaskEvent[]): string {
    const lines = [`${c.bold} PENDING BIDS${c.reset} ${c.dim}(${bids.length})${c.reset}`];

    if (bids.length === 0) {
      lines.push(`  ${c.dim}No pending bids${c.reset}`);
      return lines.join('\n');
    }

    for (const bid of bids.slice(-5)) {
      const statusColor = bid.status === 'bid_committed' ? c.yellow : c.blue;
      lines.push(
        `  ${c.dim}#${bid.taskId}${c.reset} ${c.yellow}${bid.taskType}${c.reset} ${statusColor}${bid.status}${c.reset} ${c.bold}${bid.bounty} USDC${c.reset}`
      );
    }

    return lines.join('\n');
  }

  private renderPnlSummary(summaries: AgentPnlSummary[], totalNet: number): string {
    const lines = [`${c.bold} P&L SUMMARY${c.reset}`];

    for (const s of summaries) {
      if (s.totalTasks === 0) continue;

      const profitColor = s.netProfit >= 0 ? c.green : c.red;
      const profitSign = s.netProfit >= 0 ? '+' : '';

      lines.push(
        `  ${c.bold}${s.agentId}${c.reset}: ${s.completedTasks}W/${s.failedTasks}L/${s.slashedTasks}S  ` +
        `${c.dim}earned:${c.reset} ${c.green}${s.totalEarned}${c.reset}  ` +
        `${c.dim}staked:${c.reset} ${s.totalStaked}  ` +
        `${c.dim}net:${c.reset} ${profitColor}${profitSign}${s.netProfit} USDC${c.reset}  ` +
        `${c.dim}(${s.winRate}% win)${c.reset}`
      );
    }

    const totalColor = totalNet >= 0 ? c.green : c.red;
    const totalSign = totalNet >= 0 ? '+' : '';
    lines.push(
      `  ${c.bold}TOTAL NET:${c.reset} ${totalColor}${c.bold}${totalSign}${totalNet.toFixed(2)} USDC${c.reset}`
    );

    return lines.join('\n');
  }

  private renderRecentOutcomes(records: PnlRecord[]): string {
    const lines = [`${c.bold} RECENT OUTCOMES${c.reset} ${c.dim}(last ${records.length})${c.reset}`];

    if (records.length === 0) {
      lines.push(`  ${c.dim}No outcomes yet${c.reset}`);
      return lines.join('\n');
    }

    // Show last 5
    for (const r of records.slice(-5)) {
      const icon = r.outcome === 'completed' ? `${c.green}+${c.reset}` :
                   r.outcome === 'slashed' ? `${c.red}!${c.reset}` : `${c.yellow}-${c.reset}`;
      const profitColor = parseFloat(r.netProfit) >= 0 ? c.green : c.red;
      const sign = parseFloat(r.netProfit) >= 0 ? '+' : '';

      lines.push(
        `  ${icon} ${c.dim}#${r.taskId}${c.reset} ${r.agentId} ${r.outcome} ${profitColor}${sign}${r.netProfit} USDC${c.reset} ${c.dim}${timeAgo(r.timestamp)}${c.reset}`
      );
    }

    return lines.join('\n');
  }

  private renderFooter(): string {
    return `${c.dim}  Press Ctrl+C to stop  |  Nonce-managed wallet  |  Auto-restake: ${this.lastState ? 'ON' : 'OFF'}${c.reset}`;
  }

  // ═══════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'running': return `${c.green}●${c.reset}`;
      case 'starting': return `${c.yellow}◐${c.reset}`;
      case 'error': return `${c.red}●${c.reset}`;
      case 'stopping': return `${c.yellow}◑${c.reset}`;
      default: return `${c.dim}○${c.reset}`;
    }
  }

  private getStatusColor(status: string): string {
    switch (status) {
      case 'running': return c.green;
      case 'starting': return c.yellow;
      case 'error': return c.red;
      case 'stopping': return c.yellow;
      default: return c.dim;
    }
  }

  private getTaskStatusColor(status: string): string {
    switch (status) {
      case 'completed': return c.green;
      case 'assigned':
      case 'executing':
      case 'delivered': return c.cyan;
      case 'bid_committed':
      case 'bid_revealed': return c.yellow;
      case 'failed':
      case 'skipped': return c.red;
      default: return c.dim;
    }
  }
}

// ═══════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function timeUntil(deadline: number): string {
  const seconds = deadline - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m left`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h left`;
  return `${Math.floor(seconds / 86400)}d left`;
}

# AgentOrchestrator — Run All Arena Agents With One Command

Daemon that runs all registered Arena agents simultaneously with centralized nonce management, task routing, P&L tracking, auto-restaking, and a terminal dashboard.

## What It Does

```
┌─────────────────────────────────────────────────────┐
│               AgentOrchestrator                      │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ AuditAgent   │  │VerifierAgent │  │ RiskAgent   │ │
│  │ audit tasks  │  │ verification │  │ risk_valid  │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                │         │
│  ┌──────┴─────────────────┴────────────────┴──────┐ │
│  │              Nonce Manager                      │ │
│  │     (serializes all wallet transactions)        │ │
│  └──────────────────┬─────────────────────────────┘ │
│                     │                                │
│  ┌──────────────────┴─────────────────────────────┐ │
│  │   Task Router  │  P&L Tracker  │  Dashboard     │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Core Features

- **Task Routing**: Monitors blockchain events, routes tasks to the correct agent by task type
- **Nonce Management**: Serializes all transactions from a single wallet to prevent nonce conflicts
- **P&L Tracking**: Records profit/loss per agent — tracks stakes, payouts, and slashings
- **Auto-Restake**: Earned USDC stays in wallet and is automatically available for future bids
- **Terminal Dashboard**: Real-time TUI showing active tasks, bids, wallet balance, and outcomes
- **Graceful Lifecycle**: Start/stop all agents concurrently with proper signal handling
- **Fault Isolation**: One agent failing doesn't crash the others

## Prerequisites

- Node.js 20+
- All agent packages built (`audit-agent`, `verifier-agent`, `risk-agent`)
- An Arena-compatible RPC endpoint
- Pinata API key for IPFS
- Anthropic API key (for audit + verifier agents)
- Funded wallet (USDC for staking, ETH for gas)

## Quick Start

```bash
# 1. Build all agents first
cd agents/audit-agent && npm install && npm run build && cd ../..
cd agents/verifier-agent && npm install && npm run build && cd ../..
cd agents/risk-agent && npm install && npm run build && cd ../..

# 2. Set up orchestrator
cd agents/orchestrator
npm install
cp .env.example .env
# Edit .env with your keys

# 3. Run
npm run dev
```

## Setup

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| **Blockchain** | | | |
| `RPC_URL` | Yes | — | JSON-RPC endpoint |
| `PRIVATE_KEY` | Yes | — | Wallet private key (shared by all agents) |
| `ARENA_CORE_ADDRESS` | Yes | — | ArenaCore contract address |
| `USDC_ADDRESS` | Yes | — | USDC token address |
| **IPFS** | | | |
| `PINATA_API_KEY` | Yes | — | Pinata API key |
| `PINATA_SECRET` | Yes | — | Pinata API secret |
| **AI** | | | |
| `ANTHROPIC_API_KEY` | Conditional | — | Required if audit or verifier agents enabled |
| **Data Sources** | | | |
| `DEFILLAMA_BASE_URL` | No | `https://api.llama.fi` | DeFi Llama API |
| `COINGECKO_BASE_URL` | No | `https://api.coingecko.com/api/v3` | Coingecko API |
| `COINGECKO_API_KEY` | No | — | Coingecko API key |
| `MAINNET_RPC_URL` | No | `https://eth.llamarpc.com` | Mainnet RPC for contract data |
| **Agent Toggles** | | | |
| `ENABLE_AUDIT_AGENT` | No | `true` | Enable/disable audit agent |
| `ENABLE_VERIFIER_AGENT` | No | `true` | Enable/disable verifier agent |
| `ENABLE_RISK_AGENT` | No | `true` | Enable/disable risk agent |
| **Bidding** | | | |
| `MIN_BOUNTY_USDC` | No | `50` | Minimum bounty to bid on |
| `MAX_BID_USDC` | No | `5000` | Maximum stake per bid |
| `MAX_STAKE_PERCENT` | No | `20` | Max % of balance to stake |
| `RISK_TOLERANCE` | No | `medium` | Bid aggressiveness |
| **Risk Agent** | | | |
| `RISK_MODEL` | No | `standard` | Risk scoring model |
| `MIN_CONFIDENCE` | No | `0.5` | Minimum confidence threshold |
| **Verifier Agent** | | | |
| `POOL_STAKE_USDC` | No | `500` | Verifier pool stake |
| `AUTO_JOIN_POOL` | No | `true` | Auto-join verifier pool |
| `APPROVAL_THRESHOLD` | No | `70` | Approval threshold (0-100) |
| `AUTO_REJECT_MISSED_CRITICAL` | No | `true` | Reject on missed criticals |
| `USE_COMPARISON_MODE` | No | `true` | Use comparison verification |
| **Orchestrator** | | | |
| `POLL_INTERVAL_MS` | No | `30000` | Task polling interval |
| `DATA_DIR` | No | `./data` | Storage directory |
| `DASHBOARD_REFRESH_MS` | No | `2000` | Dashboard refresh rate |
| `AUTO_RESTAKE` | No | `true` | Enable auto-restaking |
| `AUTO_RESTAKE_THRESHOLD_USDC` | No | `100` | Restake threshold |

## Running

```bash
# Development mode (auto-reload)
npm run dev

# Production
npm run build
npm start

# Without terminal dashboard (for logging to files)
npm start -- --no-dashboard
# or
NO_DASHBOARD=true npm start

# Run only specific agents
ENABLE_AUDIT_AGENT=true ENABLE_VERIFIER_AGENT=false ENABLE_RISK_AGENT=false npm run dev
```

## Terminal Dashboard

When running in a TTY, the orchestrator displays a real-time dashboard:

```
╔══════════════════════════════════════════════════════════════╗
║  ARENA AGENT ORCHESTRATOR                   uptime: 2h 15m  ║
╚══════════════════════════════════════════════════════════════╝

 WALLET
  Address:   0x1234...5678
  USDC:      12,450.00 USDC  (available: 10,200.00)
  ETH:       0.1234 ETH

 AGENTS
  ● AuditAgent     running  [audit]       last: 30s ago
  ● VerifierAgent  running  [audit]       last: 15s ago
  ● RiskAgent      running  [risk_valid]  last: 45s ago

 ACTIVE TASKS (3)
  #42 audit         assigned  →audit     500.00 USDC  2h left
  #45 risk_valid    executing →risk      200.00 USDC  4h left
  #47 audit         bid_revealed →audit  300.00 USDC  6h left

 PENDING BIDS (1)
  #49 audit bid_committed 750.00 USDC

 P&L SUMMARY
  audit:    5W/1L/0S  earned: 2,500  staked: 800  net: +1,700 USDC  (83.3% win)
  verifier: 8W/0L/0S  earned: 400    staked: 0    net: +400 USDC    (100% win)
  risk:     3W/0L/0S  earned: 450    staked: 150  net: +300 USDC    (100% win)
  TOTAL NET: +2,400.00 USDC

 RECENT OUTCOMES (last 5)
  + #38 audit completed +450.00 USDC 1h ago
  + #35 risk completed +120.00 USDC 3h ago
  + #33 verifier completed +50.00 USDC 4h ago
```

## Architecture

```
src/
├── index.ts           # Entry point + signal handlers
├── config.ts          # Unified config loader
├── types.ts           # All TypeScript interfaces
├── logger.ts          # Pino structured logging
├── orchestrator.ts    # Main daemon — lifecycle, polling, state
├── nonce-manager.ts   # Transaction queue for nonce serialization
├── task-router.ts     # Event listener + task type routing
├── pnl-tracker.ts     # Profit/loss tracking + auto-restake
├── dashboard.ts       # Terminal UI rendering
└── agent-wrappers.ts  # Dynamic agent imports + config builders
```

### How Nonce Management Works

All three agents share the same wallet (private key). Without coordination, concurrent transactions would cause "nonce too low" errors. The NonceManager:

1. Maintains a transaction queue
2. Processes transactions sequentially
3. Tracks the current nonce locally
4. Re-syncs from the network on nonce errors
5. Retries failed transactions automatically

### How Task Routing Works

The orchestrator listens for `TaskCreated` events centrally and routes them:

| Task Type | Routed To |
|---|---|
| `audit` | AuditAgent |
| `risk_validation` | RiskAgent |
| (verification) | VerifierAgent (via `VerifierAssigned` events) |

Each agent also maintains its own event listeners as a redundancy layer.

### How P&L Tracking Works

The orchestrator intercepts `TaskCompleted` and `AgentSlashed` events:

- **Completion**: Records `payout - stake = net profit`
- **Slash**: Records `-slashAmount` as loss
- **Failure**: Records stake returned, no profit

All records are persisted to `data/pnl.json` and survive restarts.

### Auto-Restake

When enabled, earned USDC stays in the wallet and becomes automatically available for future bids. The orchestrator tracks cumulative earnings and logs when the restake threshold is reached. No manual capital management needed.

## Troubleshooting

### "No agents enabled"
Set at least one `ENABLE_*_AGENT=true` in your `.env` file.

### "Failed to import audit-agent"
Build the agent first: `cd agents/audit-agent && npm run build`. The orchestrator uses dynamic imports and falls back to stub agents if packages aren't available.

### Nonce errors in logs
The nonce manager handles these automatically by resyncing from the network. If persistent, check if another process is using the same wallet.

### Dashboard not showing
The dashboard requires a TTY terminal. Use `--no-dashboard` for non-interactive environments (CI, Docker, systemd).

### Agent shows "error" status
Check the agent-specific logs. Common causes: missing API keys, insufficient USDC balance, RPC connection issues.

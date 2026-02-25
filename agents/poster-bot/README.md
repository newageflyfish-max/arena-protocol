# Arena TaskPoster Bot

Autonomous task-posting daemon for the Arena protocol. Creates diverse sample tasks on testnet at configurable intervals to keep the protocol active and give agents work to bid on.

## What It Does

The TaskPoster bot runs as a daemon and periodically:

1. **Selects a task type** using weighted random selection (audit, risk_validation, credit_scoring)
2. **Generates realistic criteria** with real contract addresses, DeFi protocols, and wallet targets
3. **Pins criteria to IPFS** via Pinata
4. **Approves USDC** spend on ArenaCore
5. **Posts the task on-chain** via `ArenaCore.createTask()`
6. **Tracks all posted tasks** with persistent JSON storage

## Task Types

| Type | Description | Default Weight |
|------|-------------|---------------|
| `audit` | Smart contract security audits using real Base Sepolia contracts (WETH, bridges, governance) | 5 |
| `risk_validation` | DeFi protocol risk assessments (Aave, Uniswap, Lido, Maker, Curve, etc.) | 3 |
| `credit_scoring` | On-chain wallet creditworthiness scoring (whale wallets, known entities) | 2 |

### Audit Tasks
- Target real deployed Base Sepolia contracts (L2StandardBridge, WETH, GovernanceToken, etc.)
- Random focus areas from the SDK vulnerability enum (reentrancy, access_control, oracle_manipulation, etc.)
- Configurable severity thresholds and max findings

### Risk Validation Tasks
- Reference real DeFi protocols with DeFi Llama slugs and CoinGecko token IDs
- Include mainnet contract addresses for on-chain analysis
- Random risk category selection (tvl_concentration, contract_maturity, audit_status, etc.)

### Credit Scoring Tasks
- Target real Ethereum addresses (vitalik.eth, Binance wallets, bridge contracts)
- Configurable evaluation periods (30-365 days)
- Multiple scoring factors (transaction_volume, wallet_age, protocol_diversity, etc.)

## Prerequisites

- **Node.js** >= 18
- **Funded wallet** with USDC on Base Sepolia
- **ETH** for gas on Base Sepolia
- **Pinata** API key for IPFS pinning

## Setup

```bash
cd agents/poster-bot
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values
```

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Base Sepolia RPC endpoint |
| `PRIVATE_KEY` | Wallet private key (with USDC + ETH) |
| `ARENA_CORE_ADDRESS` | ArenaCore contract address |
| `USDC_ADDRESS` | USDC token address |
| `PINATA_API_KEY` | Pinata API key |
| `PINATA_SECRET` | Pinata API secret |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_ADDRESS` | *(empty)* | ArenaCompliance address (auto-accepts ToS if set) |
| `POST_INTERVAL_MS` | `600000` | Interval between posts (10 minutes) |
| `MIN_BOUNTY_USDC` | `100` | Minimum bounty per task |
| `MAX_BOUNTY_USDC` | `2500` | Maximum bounty per task |
| `MIN_BALANCE_USDC` | `500` | Stop posting below this threshold |
| `DEADLINE_HOURS` | `24` | Task deadline (hours from now) |
| `SLASH_WINDOW_HOURS` | `168` | Slash window duration (1 week) |
| `BID_DURATION_SECONDS` | `3600` | Bid commitment window (1 hour) |
| `REVEAL_DURATION_SECONDS` | `1800` | Bid reveal window (30 minutes) |
| `REQUIRED_VERIFIERS` | `3` | Required verifiers per task |
| `WEIGHT_AUDIT` | `5` | Audit task selection weight |
| `WEIGHT_RISK_VALIDATION` | `3` | Risk validation task selection weight |
| `WEIGHT_CREDIT_SCORING` | `2` | Credit scoring task selection weight |
| `DATA_DIR` | `./data` | Persistent data directory |

## Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   PosterBot (bot.ts)                 │
│  setInterval → postCycle() → check balance          │
│                             → select task type      │
│                             → generate template     │
│                             → post via TaskPoster    │
│                             → log stats             │
├─────────────────────────────────────────────────────┤
│               TaskPoster (poster.ts)                │
│  canAffordPost() → ensureToS() → pinJSON()         │
│  → approve USDC → createTask() → extract taskId    │
│  → persist record                                   │
├─────────────────────────────────────────────────────┤
│              Templates (templates.ts)               │
│  selectTaskType() → weighted random                 │
│  generateTask() → audit / risk / credit generators  │
│  Real addresses: Base Sepolia contracts, DeFi       │
│  protocols, mainnet contracts, whale wallets        │
└─────────────────────────────────────────────────────┘
```

## Safety Features

- **Balance threshold**: Stops posting when USDC balance drops below `MIN_BALANCE_USDC`
- **Active task limit**: Respects ArenaCore's `maxPosterActiveTasks` limit
- **Consecutive failure cap**: Stops after 5 consecutive failures
- **ToS auto-acceptance**: Handles ArenaCompliance ToS if compliance contract is deployed
- **Atomic persistence**: Task records saved via write-tmp-then-rename
- **Graceful shutdown**: SIGINT/SIGTERM handlers stop the posting loop cleanly

## File Structure

```
src/
├── index.ts        # Entry point, signal handlers
├── config.ts       # Environment variable loader with validation
├── types.ts        # TypeScript interfaces (BotConfig, TaskTemplate, PostRecord)
├── logger.ts       # Pino structured logging
├── bot.ts          # Main daemon — interval loop, post cycle, stats
├── poster.ts       # Posting engine — IPFS, USDC approval, createTask
└── templates.ts    # Task template generators with real-world data
```

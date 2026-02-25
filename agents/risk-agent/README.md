# RiskAgent — DeFi Position Risk Scorer

Autonomous agent for **The Arena protocol** that monitors for `risk_validation` tasks, bids on them, and delivers structured risk reports scored 0-100 based on multiple on-chain and off-chain data sources.

## How It Works

```
Monitor → Evaluate → Bid → [Wait for assignment] → Gather Data → Score → Deliver
```

1. **Monitors** for new `risk_validation` tasks via events + polling
2. **Evaluates** whether to bid based on bounty, deadline, and wallet balance
3. **Bids** using commit-reveal sealed auction (commits hash, reveals stake/price)
4. **Gathers** position data from DeFi Llama, Coingecko, and direct RPC calls
5. **Scores** the position using a configurable risk model with 7 weighted categories
6. **Delivers** the risk report: validated → pinned to IPFS → output hash submitted on-chain

## Risk Categories

| Category | What It Measures |
|---|---|
| **TVL Concentration** | Protocol TVL size and recent changes |
| **Contract Maturity** | Deploy age, proxy patterns, verification |
| **Audit Status** | Number of audits and audit links |
| **Token Volatility** | 30d annualized volatility, ATH drawdown |
| **Liquidity Depth** | Total liquidity, pool concentration |
| **Protocol Governance** | Multi-chain presence, category maturity |
| **Historical Incidents** | Listing age as a proxy for track record |

## Risk Models

Three configurable model profiles with different category weightings:

### Standard (default)
Balanced weighting across all categories. Good general-purpose model.

### Conservative
Heavily penalizes new and unaudited contracts. Best for institutional risk assessment or evaluating unfamiliar protocols.

### DeFi Native
Focuses on liquidity depth and token volatility. Best for active DeFi users who prioritize market dynamics over contract maturity.

## Prerequisites

- Node.js 20+
- An Arena-compatible RPC endpoint (Base Sepolia for testnet)
- Pinata API key for IPFS pinning
- A funded wallet (USDC for staking)

Optional for enhanced data:
- Coingecko API key (free tier works, pro removes rate limits)
- Mainnet RPC URL for contract metadata lookups

## Setup

```bash
# From monorepo root
cd agents/risk-agent

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RPC_URL` | Yes | — | JSON-RPC endpoint for Arena chain |
| `PRIVATE_KEY` | Yes | — | Agent wallet private key |
| `ARENA_CORE_ADDRESS` | Yes | — | ArenaCore contract address |
| `USDC_ADDRESS` | Yes | — | USDC token address |
| `PINATA_API_KEY` | Yes | — | Pinata API key for IPFS |
| `PINATA_SECRET` | Yes | — | Pinata API secret |
| `DEFILLAMA_BASE_URL` | No | `https://api.llama.fi` | DeFi Llama API base URL |
| `COINGECKO_BASE_URL` | No | `https://api.coingecko.com/api/v3` | Coingecko API base URL |
| `COINGECKO_API_KEY` | No | — | Coingecko API key (optional) |
| `MAINNET_RPC_URL` | No | `https://eth.llamarpc.com` | Mainnet RPC for contract data |
| `MIN_BOUNTY_USDC` | No | `50` | Minimum bounty to bid on |
| `MAX_BID_USDC` | No | `3000` | Maximum stake per bid |
| `MAX_STAKE_PERCENT` | No | `15` | Max % of balance to stake |
| `RISK_TOLERANCE` | No | `medium` | `conservative`, `medium`, `aggressive` |
| `RISK_MODEL` | No | `standard` | `standard`, `conservative`, `defi_native` |
| `MIN_CONFIDENCE` | No | `0.5` | Minimum confidence to deliver (0-1) |
| `POLL_INTERVAL_MS` | No | `30000` | Task polling interval |
| `DATA_DIR` | No | `./data` | Persistent storage directory |

## Running

```bash
# Development mode (auto-reload)
npm run dev

# Production
npm run build
npm start

# Type check only
npm run typecheck
```

## Output Schema

The agent outputs a structured risk report matching the Arena `risk_validation` schema:

```json
{
  "score": 62,
  "confidence": 0.78,
  "factors": [
    {
      "name": "TVL Concentration",
      "category": "tvl_concentration",
      "value": 4500000,
      "score": 55,
      "weight": 0.18,
      "confidence": 0.8,
      "description": "Moderate TVL ($4.50M) — some concentration risk",
      "dataSource": "defillama"
    }
  ],
  "timestamp": 1700000000
}
```

## Architecture

```
src/
├── index.ts              # Entry point + graceful shutdown
├── config.ts             # Env var loading + validation
├── types.ts              # All TypeScript interfaces
├── logger.ts             # Pino structured logging
├── agent.ts              # Main orchestrator — events, polling, lifecycle
├── bidding.ts            # Bid evaluation, commit/reveal
├── execution.ts          # Full assessment pipeline
├── wallet.ts             # USDC balance + stake tracking
├── persistence.ts        # File-backed storage (atomic writes)
├── data-sources/
│   ├── defillama.ts      # Protocol TVL, audits, chains
│   ├── coingecko.ts      # Token prices, volatility, market cap
│   └── onchain.ts        # Contract age, proxy detection, liquidity
└── models/
    └── scoring.ts        # Risk scoring engine with 3 model profiles
```

## Data Sources

### DeFi Llama (free, no API key)
- Protocol TVL and historical changes
- Chain deployment data
- Audit count and links
- Protocol category and listing date

### Coingecko (free tier, optional API key)
- Token price and market cap
- 24h/7d/30d price changes
- Historical prices for volatility calculation
- ATH/ATL data

### Direct RPC
- Contract deploy date (binary search on block numbers)
- Proxy pattern detection (EIP-1967 implementation/admin slots)
- Source verification status
- Liquidity estimation via DeFi Llama prices API

## Scoring Algorithm

Each category produces a score from 0-100 (higher = riskier) with a confidence value (0-1).

The composite score is a weighted average:

```
score = Σ(category_score × category_weight) / Σ(category_weight)
confidence = Σ(category_confidence × category_weight) / Σ(category_weight)
```

Weights are defined per model profile. All weights sum to 1.0.

## Bidding Strategy

The agent uses a risk-tolerance-based bidding strategy:

| Tolerance | Stake % of Bounty | Price % of Bounty | ETA |
|---|---|---|---|
| Conservative | 8% | 92% | 1 hour |
| Medium | 12% | 85% | 1 hour |
| Aggressive | 18% | 75% | 1 hour |

Risk assessments complete faster than audits (1 hour ETA vs 2 hours for audits).

## Troubleshooting

### "Missing required environment variable"
Ensure all required vars are set in `.env`. Copy from `.env.example`.

### "Cannot afford stake"
Your USDC balance is too low for the bid amount. Fund your agent wallet or lower `MAX_BID_USDC`.

### "Confidence below threshold"
Not enough data sources returned results. Check RPC URLs and API keys. Lower `MIN_CONFIDENCE` to accept partial data.

### Rate limited by Coingecko
The free tier has strict rate limits. Add a `COINGECKO_API_KEY` or increase `POLL_INTERVAL_MS`.

### No tasks detected
Ensure `ARENA_CORE_ADDRESS` is correct and `RPC_URL` supports event subscriptions (WebSocket preferred for events, HTTP works with polling fallback).

# AuditAgent

Autonomous smart contract auditing agent for [The Arena](../../docs/) protocol. Monitors for audit tasks, evaluates and bids on them, runs automated security analysis, and delivers structured findings reports on-chain.

## How It Works

```
Monitor for tasks → Evaluate bounty & risk → Commit sealed bid → Reveal bid
    ↓ (if assigned)
Fetch criteria from IPFS → Run Slither + Mythril → Claude AI analysis
    → Merge findings → Validate schema → Pin to IPFS → Deliver on-chain
```

The agent runs a continuous event-driven loop with a polling fallback. It handles the complete Arena task lifecycle autonomously:

1. **Monitoring** — Listens for `TaskCreated` events and polls for open audit tasks
2. **Evaluation** — Checks task type, bounty size, deadline feasibility, and wallet balance
3. **Bidding** — Commits a sealed bid with stake/price/ETA based on risk tolerance
4. **Revealing** — Automatically reveals bids when the reveal window opens
5. **Execution** — Runs Slither, Mythril, and Claude AI analysis in parallel
6. **Delivery** — Validates output against the audit schema, pins to IPFS, delivers hash on-chain

## Prerequisites

- **Node.js** >= 18
- **Slither** (optional but recommended) — `pip install slither-analyzer`
- **Mythril** (optional but recommended) — `pip install mythril`
- **Pinata account** — For IPFS pinning ([pinata.cloud](https://pinata.cloud))
- **Anthropic API key** — For Claude AI analysis
- **Funded wallet** — USDC on Base Sepolia for staking

## Setup

```bash
# Clone and navigate
cd agents/audit-agent

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your keys and preferences
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | — | Base Sepolia RPC endpoint |
| `PRIVATE_KEY` | Yes | — | Agent wallet private key |
| `ARENA_CORE_ADDRESS` | Yes | — | ArenaCore contract address |
| `USDC_ADDRESS` | Yes | — | USDC token address |
| `PINATA_API_KEY` | Yes | — | Pinata API key for IPFS |
| `PINATA_SECRET` | Yes | — | Pinata API secret |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for Claude |
| `MIN_BOUNTY_USDC` | No | `100` | Minimum bounty to consider |
| `MAX_BID_USDC` | No | `5000` | Maximum stake per task |
| `MAX_STAKE_PERCENT` | No | `20` | Max % of balance to stake |
| `RISK_TOLERANCE` | No | `medium` | `conservative`, `medium`, or `aggressive` |
| `POLL_INTERVAL_MS` | No | `30000` | Polling interval in ms |
| `DATA_DIR` | No | `./data` | Directory for persisted state |

## Running

```bash
# Development mode (auto-reload)
npm run dev

# Production
npm run build
npm start
```

## Risk Tolerance

Controls how aggressively the agent bids:

| Tolerance | Stake | Price | Strategy |
|-----------|-------|-------|----------|
| Conservative | 10% of bounty | 90% of bounty | Lower risk, lower chance of winning |
| Medium | 15% of bounty | 80% of bounty | Balanced approach |
| Aggressive | 20% of bounty | 70% of bounty | Higher risk, higher chance of winning |

The scoring formula is: `score = (stake * (reputation + 1) * 1e18) / price`

New agents (reputation = 0) should consider aggressive bids to compensate for low reputation.

## Architecture

```
src/
  index.ts          — Entry point, config loading, graceful shutdown
  config.ts         — Environment variable loading and validation
  types.ts          — TypeScript type definitions
  agent.ts          — Main orchestrator (event loop, lifecycle)
  bidding.ts        — Bid evaluation, commit/reveal logic
  execution.ts      — Full analysis pipeline
  wallet.ts         — Balance tracking, bid affordability
  persistence.ts    — File-backed state (bid salts, task tracking)
  logger.ts         — Structured logging (pino)
  analyzers/
    slither.ts      — Slither subprocess runner + result parser
    mythril.ts      — Mythril subprocess runner + result parser
    ai-analyst.ts   — Claude API analysis + finding synthesis
```

### Key Design Decisions

- **Salt persistence**: Bid salts are persisted atomically to disk. Losing a salt means forfeiting the stake. The agent writes to a `.tmp` file then renames for crash safety.
- **Direct contract calls**: The SDK's `bid()` method is missing the `criteriaAckHash` parameter. The agent calls `commitBid` directly on the contract.
- **Error isolation**: Individual task failures (bid, reveal, execution) never crash the agent. Each operation is wrapped in try/catch with structured logging.
- **Recovery**: On restart, the agent checks for unrevealed bids and unfinished executions from previous sessions.

## Output Schema

The audit report follows the Arena `audit` output schema:

```json
{
  "findings": [
    {
      "severity": "high",
      "vulnerability_type": "reentrancy",
      "location": "Vault.withdraw (line 42)",
      "description": "External call before state update",
      "proof_of_concept": "1. Call withdraw() 2. Reenter via fallback...",
      "recommendation": "Apply checks-effects-interactions pattern"
    }
  ],
  "summary": "Audit identified 3 findings: 1 high, 2 medium...",
  "timestamp": 1708000000
}
```

### Severity Levels
`informational` | `low` | `medium` | `high` | `critical`

### Vulnerability Types
`reentrancy` | `access_control` | `oracle_manipulation` | `integer_overflow` | `flash_loan` | `front_running` | `logic_errors` | `gas_optimization`

## Troubleshooting

**Agent won't start**: Check that all required environment variables are set. Run `npx tsx src/index.ts` for detailed error output.

**"Slither not installed"**: Install via `pip install slither-analyzer`. The agent gracefully degrades without it but findings quality decreases.

**"Mythril not installed"**: Install via `pip install mythril`. Same graceful degradation as Slither.

**"Cannot afford stake"**: The agent's wallet balance is too low. Fund with more USDC or reduce `MAX_STAKE_PERCENT`.

**Missed reveal window**: The agent logs this as an error. Ensure the agent runs continuously during bid periods. Check `data/bids.json` for persisted salts.

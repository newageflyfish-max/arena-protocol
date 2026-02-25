# VerifierAgent

Autonomous verification agent for [The Arena](../../docs/) protocol. Joins the verifier pool, monitors for verification assignments, independently analyzes agent deliverables, compares findings, and submits on-chain votes with detailed reports.

## How It Works

```
Join verifier pool → Monitor for assignments → Fetch agent output from IPFS
    ↓ (when assigned)
Fetch criteria → Run Slither + Mythril independently → Claude AI analysis
    → Compare our findings vs agent's report → Score & decide → Submit vote
```

The agent participates in The Arena's adversarial verification system:

1. **Pool Membership** — Deposits stake into the verifier pool to be eligible for VRF-based random assignment
2. **Assignment Detection** — Listens for `VerifierAssigned` and `VRFVerifiersAssigned` events; also polls for Verifying tasks
3. **Independent Analysis** — Downloads the same contract source and runs its own Slither, Mythril, and Claude analysis
4. **Comparison** — Diffs findings against the agent's submitted report, computing a weighted match score
5. **Decision** — Approves or rejects based on configurable thresholds and auto-reject rules
6. **Submission** — Submits vote via standard `submitVerification` or `submitComparisonVerification` (when comparison mode is enabled)

### Verification Modes

| Mode | Method | Score | Decision |
|------|--------|-------|----------|
| **Standard** | `submitVerification(taskId, vote, reportHash)` | N/A — binary vote | Agent decides approve/reject based on match score |
| **Comparison** | `submitComparisonVerification(taskId, findingsHash, scoreBps, missedCritical)` | 0-10000 BPS | On-chain thresholds: >=8000=approve, <5000=reject |

## Prerequisites

- **Node.js** >= 18
- **Slither** (recommended) — `pip install slither-analyzer`
- **Mythril** (recommended) — `pip install mythril`
- **Pinata account** — For IPFS ([pinata.cloud](https://pinata.cloud))
- **Anthropic API key** — For Claude AI analysis
- **Funded wallet** — USDC on Base Sepolia for pool stake

## Setup

```bash
cd agents/verifier-agent
npm install
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
| `POOL_STAKE_USDC` | No | `500` | Stake to deposit in verifier pool |
| `AUTO_JOIN_POOL` | No | `true` | Auto-join pool on startup |
| `APPROVAL_THRESHOLD` | No | `70` | Min match score (%) to approve |
| `AUTO_REJECT_MISSED_CRITICAL` | No | `true` | Auto-reject if agent missed critical findings |
| `AUTO_REJECT_MISSED_HIGH` | No | `false` | Also auto-reject on missed high findings |
| `USE_COMPARISON_MODE` | No | `true` | Use comparison verification when on-chain |
| `POLL_INTERVAL_MS` | No | `15000` | Polling interval in ms |
| `DATA_DIR` | No | `./data` | Persistent state directory |

## Running

```bash
# Development mode (auto-reload)
npm run dev

# Production
npm run build
npm start
```

## Scoring Algorithm

The comparison engine uses **severity-weighted matching**:

### Match Score Calculation

1. **Normalize findings** by `vulnerability_type` + location (fuzzy)
2. **Match findings** between agent and verifier reports
3. **Weight by severity**: critical=10, high=7, medium=4, low=2, informational=1
4. **Coverage score** = `(matched_weight / total_verifier_weight) * 100`
5. **False positive penalty** = up to -15% for agent findings we didn't find
6. **Final score** = `max(0, coverage - penalty)`

### Decision Logic

```
if (autoRejectMissedCritical && agent missed critical/high findings):
    → REJECT (regardless of score)

if (matchScore >= approvalThreshold):
    → APPROVE

else:
    → REJECT
```

### Comparison Mode (On-Chain)

When comparison mode is enabled for a task:
- Score is submitted as basis points (0-10000)
- `missedCritical` flag is submitted as boolean
- On-chain thresholds: >=8000 BPS = Approved, <5000 BPS = Rejected
- The agent's local `approvalThreshold` does NOT override on-chain thresholds

## Architecture

```
src/
  index.ts          — Entry point, config loading, graceful shutdown
  config.ts         — Environment variable loading and validation
  types.ts          — TypeScript type definitions
  agent.ts          — Main orchestrator (events, polling, pool management)
  comparison.ts     — Comparison engine: diff, score, decide
  verification.ts   — Full pipeline: fetch → analyze → compare → submit
  wallet.ts         — Balance tracking, pool join/leave, approvals
  persistence.ts    — File-backed verification state
  logger.ts         — Structured logging (pino)
  analyzers/
    slither.ts      — Slither subprocess runner + result parser
    mythril.ts      — Mythril subprocess runner + result parser
    ai-analyst.ts   — Claude API independent analysis
```

### Key Design Decisions

- **Independent analysis**: The verifier runs the SAME tools as the auditor agent (Slither, Mythril, Claude) independently — it does NOT trust the agent's output
- **Severity-weighted scoring**: Missing a critical finding penalizes much more heavily than missing an informational one
- **Auto-reject on missed criticals**: Configurable safety rail — if the agent missed a critical vulnerability, reject regardless of overall score
- **Comparison mode support**: Automatically detects on-chain comparison mode and submits structured scores instead of binary votes
- **VRF + manual registration**: Handles both VRF-assigned verifications and attempts manual registration for delivered tasks when VRF is disabled
- **Error isolation**: Individual verification failures never crash the agent
- **Session recovery**: On restart, resumes any pending verifications

### Verifier Economics

| Outcome | Correct Vote | Incorrect Vote |
|---------|-------------|----------------|
| Task approved (majority) | Stake returned + fee share | Slashed 50% |
| Task rejected (majority) | Stake returned | Slashed 100% |
| Verifier timeout (24h) | — | Slashed 10% |

The verifier's accuracy directly impacts profitability. The comparison engine helps make accurate decisions by running truly independent analysis.

## Troubleshooting

**"Not in verifier pool"**: Set `AUTO_JOIN_POOL=true` or run `joinVerifierPool()` manually. Ensure sufficient USDC balance.

**"Insufficient registry stake"**: Your pool stake is too low for the task's required verification stake (20% of agent's stake). Deposit more with a higher `POOL_STAKE_USDC`.

**No verifications received**: VRF assignment is random. Increase pool stake for higher selection probability, or the agent will attempt manual registration on delivered tasks.

**"Failed to retrieve agent output"**: The agent's IPFS pin may have expired. This is a non-recoverable error for that task.

**Slashing**: If you're frequently slashed, consider lowering `APPROVAL_THRESHOLD` (you may be rejecting good work) or raising it (you may be approving bad work). Check logs for match score patterns.

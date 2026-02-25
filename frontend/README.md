# Arena Protocol Frontend

Next.js 14 dashboard for The Arena Protocol on Base Sepolia. Dark-theme, data-dense terminal-style interface built with wagmi v2, viem, RainbowKit, and TailwindCSS.

## Pages

| Route | Description |
|-------|-------------|
| `/` | Protocol overview -- live stat cards (total tasks, GMV, verifiers, treasury) and recent activity feed |
| `/tasks` | Task list with status filter tabs (Open, Bidding, Assigned, Delivered, Verifying, Complete, Failed) |
| `/tasks/[id]` | Task detail with full lifecycle timeline, assignment data, and deadline countdown |
| `/agents` | Agent leaderboard sorted by reputation -- win rate, earnings, active stake, tier badges |
| `/create` | Create task form with dynamic fields per type (audit, risk validation, credit scoring, treasury execution), USDC approve + createTask flow |
| `/dashboard` | Connected wallet view -- posted tasks, active bids, earnings history, personal stats |

## Stack

- **Next.js 14** (App Router, React Server Components)
- **wagmi v2** + **viem** (contract reads/writes, typed ABIs)
- **RainbowKit** (wallet connection UI)
- **TailwindCSS** (utility-first dark theme)
- **TanStack Query** (data fetching/caching)

## Setup

```bash
cd frontend
npm install
```

### Environment Variables

Create `.env.local`:

```env
# WalletConnect project ID (get one at https://cloud.walletconnect.com)
NEXT_PUBLIC_WC_PROJECT_ID=your_project_id

# Deployed contract addresses (from contracts/deployments/base-sepolia.json)
NEXT_PUBLIC_ARENA_CORE_ADDRESS=0xYourArenaCoreAddress
NEXT_PUBLIC_MOCK_USDC_ADDRESS=0xYourMockUSDCAddress
```

If env vars are not set, the app uses placeholder addresses and will show empty states.

### Development

```bash
npm run dev
```

Opens at `http://localhost:3000`.

### Production Build

```bash
npm run build
npm start
```

### Type Check

```bash
npm run typecheck
```

## Architecture

```
src/
  app/
    layout.tsx          Root layout (dark theme, Header, Providers)
    providers.tsx       WagmiProvider + RainbowKit + QueryClient
    page.tsx            Home (server wrapper)
    StatsView.tsx       Home stats (client, reads taskCount/verifierPool/treasury)
    tasks/
      page.tsx          Task list with filter tabs
      [id]/page.tsx     Task detail with lifecycle timeline
    agents/page.tsx     Agent leaderboard (from event logs + on-chain reads)
    create/page.tsx     Create task form (approve + createTask)
    dashboard/page.tsx  Wallet dashboard (posted tasks, bids, earnings)
    globals.css         Tailwind directives + dark base styles
  components/
    Header.tsx          Fixed nav bar + wallet connect
    StatCard.tsx        Metric display card
    StatusBadge.tsx     Task status pill badge
    DataTable.tsx       Generic data table
  lib/
    contracts.ts        Addresses, ABIs (ArenaCore, ERC20), status maps
    wagmi.ts            Wagmi/RainbowKit config (baseSepolia chain)
    utils.ts            truncateAddress, formatUSDC, timeRemaining, getReputationTier
```

## Contract Integration

All contract interactions use wagmi v2 hooks with typed viem ABIs:

- **Reads**: `useReadContract` for `taskCount`, `getTask`, `getAssignment`, `agentReputation`, `verifierPoolLength`, `protocolTreasury`, `allowance`
- **Writes**: `useWriteContract` for `createTask`, `approve`
- **Events**: `publicClient.getLogs` for `TaskCreated`, `AgentAssigned`, `TaskCompleted`, `AgentSlashed`

USDC uses 6 decimal places throughout. All bigint formatting via `formatUSDC()`.

## Design System

- **Background**: navy-950 (#0F1A2E) base, navy-900 (#1B2A4A) cards
- **Text**: zinc-200 body, zinc-400 secondary, zinc-500 labels, white emphasis
- **Borders**: zinc-800 default, zinc-700 inputs
- **Accent**: arena-blue (#3B82F6), arena-green (#10B981), arena-red (#EF4444)
- **Font**: System sans-serif body, JetBrains Mono for numbers and addresses
- **No emojis, no gradients** -- clean data-dense layout

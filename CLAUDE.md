# CLAUDE.md — Arena Protocol
## CRITICAL: Read This First
Arena Protocol is a **trust and verification infrastructure layer**, NOT a consumer app. We do NOT build agents, consumer frontends, or compete on task execution. The product is **contracts + SDK** that other protocols integrate. Think of Arena like Stripe for AI agent accountability.
## Project Identity
- **Name:** Arena Protocol (may rebrand — name is not final)
- **Tagline:** The Trust Layer for the AI Agent Economy
- **Chain:** Base (Ethereum L2, Optimism stack)
- **Stage:** Testnet deployed (Base Sepolia), pre-mainnet
- **Founder:** Jack Arnot (solo founder)
- **Email:** arenaprotocolhq@gmail.com
- **GitHub:** github.com/newageflyfish-max/arena-protocol (private)
## What Arena Does
Embeddable smart contracts that give any AI agent protocol:
- **Staking-backed reputation** (FICO-style 0-850 scores)
- **Sealed-bid auctions** (commit-reveal, anti-front-running)
- **Dispute resolution** (arbitration council)
- **Insurance markets** (risk hedging)
- **x402 payment verification** (dispute resolution for agent payments)
Integration pattern: Protocol imports Arena SDK → checks agent reputation before assigning work → agents stake USDC → verifiers confirm quality → reputation updates on-chain.
## Architecture
### Core Contracts (3) — The Engine
| Contract | Role | Holds |
|----------|------|-------|
| **ArenaCoreMain** | Task creation, escrow, USDC whitelist, poster rate limits, protocol fees, emergency controls | All bounty escrow |
| **ArenaCoreAuction** | Sealed-bid auction engine: commit, reveal, scoring, resolution, delivery, verification, settlement, slashing | All agent stakes |
| **ArenaCoreVRF** | Verifier pool management, random verifier selection (Chainlink VRF on mainnet, self-registration fallback on testnet) | Nothing |
**Why 3 contracts?** Original ArenaCore.sol exceeded EIP-170 24KB limit. Split into Main + Auction + VRF. Auction calls into Main for task state reads. Main calls Auction's `transferToMain()` for emergency stake withdrawals.
### Satellite Contracts (12) — Specialized Modules
| Contract | Purpose |
|----------|---------|
| ArenaReputation | On-chain reputation scoring, non-transferable |
| ArenaConsensus | Multi-agent consensus for complex tasks |
| ArenaProfiles | On-chain identity (names, bios, types) |
| ArenaRecurring | Recurring task templates |
| ArenaArbitration | Dispute resolution council |
| ArenaInsurance | Insurance markets for agent failure hedging |
| ArenaSyndicates | Agent teams that pool resources |
| ArenaDelegation | Stake delegation (back agents you trust) |
| ArenaTimelock | Governance timelock for parameter changes |
| ArenaCompliance | ToS, OFAC sanctions screening, content restrictions |
| ArenaOutcomes | Historical task result storage |
| MockUSDC | Test USDC token (6 decimals) |
### Contract Relationships
ArenaCoreMain (center)
- ArenaCoreAuction (bidirectional — auction <-> main for stakes/escrow)
- ArenaCoreVRF (reads main, manages verifier pool)
- ArenaReputation (reads completion events, writes scores)
- ArenaConsensus -> Main
- ArenaProfiles -> Main
- ArenaRecurring -> Main
- ArenaArbitration -> Main
- ArenaInsurance -> Main
- ArenaSyndicates -> Main
- ArenaDelegation -> Main
- ArenaTimelock -> Main
- ArenaCompliance -> Main
## Deployed Contract Addresses (Base Sepolia — Chain ID 84532)
| Contract | Address |
|----------|---------|
| MockUSDC | 0xfF91Ec9aaee6fF0dB44b8197E4A1e9CfC9Dc0350 |
| ArenaCoreMain | 0x04776E515eDBDE81350974E3F8576bE3b9117F61 |
| ArenaCoreAuction | 0x0c48FE6468BD0Ee121eb04aAA10b7eF09B910f9B |
| ArenaCoreVRF | 0x7417d610a1835bEcadea6A017EFd05F2906EBcd9 |
| ArenaReputation | 0x4663A38C27462CC97b0d1bdeDd88F82Ec6246371 |
| ArenaConsensus | 0xF7b561677aa7E151d1d0Eb60160dd0201D992938 |
| ArenaProfiles | 0xc5C6e1638c364b4f353397B31F1c6C6a0d9432c2 |
| ArenaRecurring | 0xF0939A408415707bE535fe5B863b1E751BEBCc4E |
| ArenaArbitration | 0x5815E25D0987d1716A15726bed802eC2Ecc16E8f |
| ArenaOutcomes | 0x6F29A9A8B01009971b606C1B5C47541E5Ab1a25e |
| ArenaInsurance | 0x2A570A32425ADE40cbb28704183165Afdcd17ce1 |
| ArenaSyndicates | 0xeeD87bd1329f3526116Bc144F76B5504bec9A9b1 |
| ArenaDelegation | 0xf9cF0895EFf491cD8e610C0C68C5d447c70e46Cc |
| ArenaTimelock | 0x2E2c019750AD39f60e6F64DebD2E473C695CBa0e |
| ArenaCompliance | 0xb354Da530329251A21EcFF7876cA03eA34ff9d84 |
**Deployer wallet:** 0x59a088F3FfAa62Ca78AAb97321E4F302C404Fc83
**Addresses file:** contracts/deployments/base-sepolia.json
**Total deployment cost:** 0.000071 ETH
## Tech Stack
- **Solidity:** 0.8.24 with viaIR optimization (200 runs)
- **Framework:** Hardhat with ethers.js v6
- **Token:** USDC (6 decimals) — MockUSDC on testnet
- **Frontend:** Next.js 14, RainbowKit, wagmi v2, viem
- **RPC:** Alchemy (Base Sepolia)
- **Testing:** 1,104 tests via Hardhat (all passing)
- **Chain ID:** 84532 (Base Sepolia)
## Key Formulas
### Scoring Algorithm (Auction Resolution)
score = (stake * repMultiplier * historyMultiplier) / price
repMultiplier = 1 + (reputationScore / 100), capped at 3x
historyMultiplier = 1 + (completedTasks / 50), capped at 2x
Higher stake + better reputation + lower price = higher score = wins auction.
### Commit Hash (Sealed Bid)
keccak256(abi.encodePacked(msg.sender, _stake, _price, _eta, _salt))
**CRITICAL:** msg.sender MUST be the first parameter. This prevents commit-copying attacks. The frontend must include the connected wallet address in the hash computation.
## Known Bugs
### 1. ~~Frontend CommitBidPanel — Wrong Commit Hash~~ ✅ RESOLVED
**Location:** src/app/tasks/[id]/page.tsx — CommitBidPanel component
**Status:** Fixed in commit 528e0d0. The encodePacked call now correctly includes the wallet address (from useAccount) as the first parameter: `[address, stakeWei, priceWei, etaSeconds, saltBytes]` matching the contract's `keccak256(abi.encodePacked(msg.sender, _stake, _price, _eta, _salt))`.
### 2. ~~Alchemy Free Tier getLogs Limit~~ ✅ RESOLVED
**Issue:** Alchemy free tier limits eth_getLogs to 10 blocks. Pages that read historical events may fail or show incomplete data.
**Status:** Not applicable. Audit confirmed all frontend pages use `publicClient.readContract()` (direct contract reads), not event queries or getLogs. No pages use getLogs, getContractEvents, or queryFilter.
### 3. Task #37 Zero-Address Winner
**Issue:** One simulated task resolved with address(0) as winner. Likely an edge case when no valid bids were revealed before deadline.
**Priority:** Low — testnet artifact, not a contract bug per se.
## Deployment Lessons (IMPORTANT)
### What Works
- Hardhat auto-gas estimation — let the provider estimate gas, don't override
- Fresh wallet with zero nonce — eliminates ghost transaction issues
- Single RPC provider — don't switch between Alchemy and public RPCs mid-deploy
- Wait for 1 confirmation (not 2) — faster, still reliable on testnet
### What Fails
- Custom gas prices (0.1 gwei) — too low, transactions hang in mempool
- Retrying failed deploys on same wallet — creates ghost nonces that poison all subsequent attempts
- Switching RPCs mid-deploy — different mempools see different pending transactions
- deploy-clean.js with hardcoded gas — unreliable, use deploy-hardhat-auto.js instead
### If Deployment Fails
1. Do NOT retry immediately
2. Create a brand new wallet (ethers.Wallet.createRandom())
3. Fund from faucet: https://portal.cdp.coinbase.com/products/faucet
4. Use Hardhat auto-gas (NO custom maxFeePerGas or gasLimit)
5. Deploy with: npx hardhat run scripts/deploy-hardhat-auto.js --network baseSepolia
## File Structure
arena-protocol/
├── contracts/
│   ├── contracts/          # Solidity source files
│   │   ├── ArenaCoreMain.sol
│   │   ├── ArenaCoreAuction.sol
│   │   ├── ArenaCoreVRF.sol
│   │   ├── ArenaReputation.sol
│   │   ├── ArenaConsensus.sol
│   │   ├── ArenaProfiles.sol
│   │   ├── ArenaRecurring.sol
│   │   ├── ArenaArbitration.sol
│   │   ├── ArenaInsurance.sol
│   │   ├── ArenaSyndicates.sol
│   │   ├── ArenaDelegation.sol
│   │   ├── ArenaTimelock.sol
│   │   ├── ArenaCompliance.sol
│   │   ├── ArenaOutcomes.sol
│   │   ├── ArenaTypes.sol        # Shared types, interfaces, errors
│   │   └── MockUSDC.sol
│   ├── test/               # 1,104 tests
│   ├── scripts/
│   │   ├── deploy-hardhat-auto.js  # USE THIS — auto-gas estimation
│   │   ├── deploy-clean.js         # DO NOT USE — hardcoded gas, unreliable
│   │   └── simulate-activity.js    # Seeds testnet with fake agent activity
│   ├── deployments/
│   │   └── base-sepolia.json       # All deployed addresses
│   ├── hardhat.config.js
│   └── .env                        # PRIVATE_KEY + BASE_SEPOLIA_RPC
├── frontend/
│   ├── src/app/            # Next.js 14 app router
│   │   ├── page.tsx        # Dashboard
│   │   ├── tasks/          # Task list + task detail with action panels
│   │   ├── create/         # Create task form
│   │   ├── agents/         # Agent leaderboard
│   │   ├── profile/        # Agent profiles
│   │   ├── verifiers/      # Verifier pool management
│   │   ├── dashboard/      # Stats overview
│   │   ├── insurance/      # Insurance markets
│   │   ├── arbitration/    # Dispute resolution
│   │   └── settings/       # User settings
│   ├── src/lib/
│   │   └── contracts.ts    # All 15 addresses + ABIs
│   ├── .env.local          # Contract addresses + chain config
│   └── next.config.js
├── sdk/                    # TypeScript SDK (44 output files)
├── api/                    # REST API (12 endpoints)
├── agents/                 # Reference agent implementations
│   ├── audit-agent/
│   ├── risk-agent/
│   ├── verifier-agent/
│   └── orchestrator/
└── CLAUDE.md               # This file
## Economic Parameters
| Parameter | Value |
|-----------|-------|
| Protocol fee | 3% of bounty on successful completion |
| Slash fee | 10% of slashed agent stakes |
| Minimum bounty | 50 USDC |
| Minimum stake | bounty / 10 |
| Max active tasks per poster | 50 |
| Reputation range | 0-850 (FICO-style) |
| Rep multiplier cap | 3x |
| History multiplier cap | 2x |
| Insurance premium | 2% of insured value |
## Stress Test Results
- 500 tasks, $13.6M USDC volume
- Zero leakage (every USDC accounted for across all contract balances)
- All economic invariants held
- Anti-collusion mechanisms verified
  - Verifier rotation with configurable cooldown period
  - Statistical anomaly detection with auto-flagging and auto-banning
- Integration tests: full lifecycle test (create through settlement with exact USDC balance verification), scoring fuzz (72 randomized inputs with on-chain winner verification), zero-leakage invariant (20 tasks across 4 outcome types — success, rejection, expiration, cancellation — verified total supply preserved)

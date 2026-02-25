# Arena Protocol — Deployment Guide

Full deployment of all 11 Arena Protocol contracts to Base Sepolia with satellite linking, token whitelisting, and Timelock ownership transfer.

## Prerequisites

- Node.js >= 18
- Funded wallet on Base Sepolia (ETH for gas)
- Alchemy account (for reliable RPC)
- BaseScan API key (for contract verification)

## Step 1: Environment Setup

```bash
cd contracts
cp .env.example .env
```

Edit `.env` with your values:

```env
# Required
PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY

# RPC — Alchemy recommended for reliability
ALCHEMY_BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY

# Verification
BASESCAN_API_KEY=YOUR_BASESCAN_API_KEY
```

## Step 2: Compile Contracts

```bash
npx hardhat compile
```

Ensure all 11 contracts compile under EIP-170 (24,576 bytes):
- MockUSDC, ArenaCore, ArenaContinuous, ArenaArbitration
- ArenaReputation, ArenaSyndicates, ArenaInsurance, ArenaDelegation
- ArenaOutcomes, ArenaCompliance, ArenaTimelock

## Step 3: Deploy to Base Sepolia

```bash
npx hardhat run scripts/deploy.js --network baseSepolia
```

The script executes these phases automatically:

### Phase 1 — Contract Deployment (11 contracts)

| Order | Contract | Constructor Args |
|-------|----------|-----------------|
| 1 | MockUSDC | *(none)* |
| 2 | ArenaCore | `MockUSDC address` |
| 3 | ArenaContinuous | `ArenaCore address` |
| 4 | ArenaArbitration | `ArenaCore address` |
| 5 | ArenaReputation | `ArenaCore address` |
| 6 | ArenaSyndicates | `ArenaCore address` |
| 7 | ArenaInsurance | `ArenaCore address` |
| 8 | ArenaDelegation | `ArenaCore address` |
| 9 | ArenaOutcomes | `ArenaCore address` |
| 10 | ArenaCompliance | `ArenaCore address` |
| 11 | ArenaTimelock | *(none)* |

### Phase 2 — Satellite Linking

| Call | Function |
|------|----------|
| 1 | `ArenaCore.setArenaArbitration(ArenaArbitration)` |
| 2 | `ArenaCore.setArenaOutcomes(ArenaOutcomes)` |
| 3 | `ArenaCore.setArenaCompliance(ArenaCompliance)` |
| 4 | `ArenaArbitration.setArenaContinuous(ArenaContinuous)` |

### Phase 3 — Token Whitelisting

```
ArenaCore.whitelistToken(MockUSDC, isStablecoin=true, mevAck=false)
```

### Phase 4 — Ownership Transfer

All 9 operational contracts transfer ownership to ArenaTimelock:
- ArenaCore, ArenaContinuous, ArenaArbitration, ArenaReputation
- ArenaSyndicates, ArenaInsurance, ArenaDelegation, ArenaOutcomes, ArenaCompliance

ArenaTimelock itself remains owned by the deployer.

### Phase 5 — BaseScan Verification

All 11 contracts are verified automatically on BaseScan.

## Step 4: Verify Deployment

Deployed addresses are saved to:

```
contracts/deployments/base-sepolia.json
```

The JSON includes all addresses, linking records, whitelist state, and ownership mapping.

## Testing Locally

Run against the built-in Hardhat network (no wallet needed):

```bash
npx hardhat run scripts/deploy.js --network hardhat
```

Or start a local node and deploy:

```bash
# Terminal 1
npx hardhat node

# Terminal 2
npx hardhat run scripts/deploy.js --network localhost
```

## Manual Verification

If automatic verification fails, verify individually:

```bash
# MockUSDC (no constructor args)
npx hardhat verify --network baseSepolia MOCKUSDC_ADDRESS

# ArenaCore (1 arg: USDC address)
npx hardhat verify --network baseSepolia ARENACORE_ADDRESS "MOCKUSDC_ADDRESS"

# All satellites (1 arg: ArenaCore address)
npx hardhat verify --network baseSepolia CONTRACT_ADDRESS "ARENACORE_ADDRESS"

# ArenaTimelock (no constructor args)
npx hardhat verify --network baseSepolia TIMELOCK_ADDRESS
```

## Skipping Verification

To deploy without BaseScan verification:

```bash
SKIP_VERIFY=true npx hardhat run scripts/deploy.js --network baseSepolia
```

## Architecture

```
                    ┌──────────────┐
                    │  Deployer    │
                    └──────┬───────┘
                           │ owns
                    ┌──────▼───────┐
                    │ ArenaTimelock│ (48h delay)
                    └──────┬───────┘
                           │ owns all 9 below
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼──────┐
   │ ArenaCore │──▶│ Arbitration │──▶│ Continuous │
   │ (hub)     │   └─────────────┘   └────────────┘
   │           │──▶│ Outcomes    │
   │           │──▶│ Compliance  │
   └─────┬─────┘
         │ immutable core ref
    ┌────┼────┬────────┬──────────┬──────────┐
    │    │    │        │          │          │
  Rep  Synd  Ins    Deleg     Outcomes  Compliance
```

## Gas Estimate

Approximate gas costs for full deployment on Base Sepolia:

| Phase | Est. Gas |
|-------|----------|
| 11 contract deploys | ~15M gas |
| 4 satellite links | ~200K gas |
| 1 token whitelist | ~50K gas |
| 9 ownership transfers | ~250K gas |
| **Total** | **~15.5M gas** |

At 0.001 gwei base fee on Base Sepolia, this costs < 0.02 ETH.

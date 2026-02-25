# CODEX TASK LIST — THE ARENA

## CONTEXT (paste this at the start of every task)

"This is The Arena — an adversarial execution protocol where AI agents stake capital on task performance. Settlement in USDC on Base L2. Sealed bid auctions, graduated slashing, adversarial verification. Do not change existing function signatures or event signatures without flagging it."

---

## TASK 1 — Test Suite
**Files:** ArenaCore.sol, hardhat.config.js, package.json
**Tell it:** Write a comprehensive Hardhat test suite for ArenaCore.sol. Cover every function, every edge case, every revert. Test the full lifecycle: create task, commit bid, reveal bid, resolve auction, deliver, verify, settle. Test slashing at every severity. Test dispute flow. Test deadline enforcement. Test cancellation with refunds. Aim for 100% branch coverage. Use ethers.js v6. Create a MockUSDC ERC20 contract for testing.

---

## TASK 2 — Fix Post-Completion Slashing
**Files:** ArenaCore.sol
**Tell it:** The postCompletionSlash function currently only does reputation damage because the agent's stake is already returned after completion. Fix this by implementing a slash bond — hold a percentage (e.g. 20%) of the agent's stake in escrow through the entire slash window before releasing it. Only release the bond after the slash window expires with no claims. Add a claimSlashBond function agents call after the window. Update _settleSuccess to hold back the bond portion.

---

## TASK 3 — VRF Verifier Assignment
**Files:** ArenaCore.sol
**Tell it:** Replace the self-registration verifier model with Chainlink VRF randomized assignment on Base. Add a verifier registry where agents register as available verifiers with a minimum stake deposit. When a task is delivered, the contract requests randomness from Chainlink VRF, selects N verifiers randomly from the registry, and assigns them automatically. Verifiers who don't submit within a time window forfeit a portion of their registry stake. Use Chainlink VRF V2.5 for Base.

---

## TASK 4 — Honeypot System
**Files:** ArenaCore.sol
**Tell it:** Add a honeypot task system. The protocol owner can create tasks with a known-correct output hash stored privately. These tasks look identical to normal tasks from the outside. After settlement, if an agent or verifier gave incorrect results on a honeypot task, they are automatically slashed and flagged. Add a createHoneypotTask function (owner only), a settleHoneypot function that compares output to the stored correct hash, and a mapping to track honeypot flags per agent.

---

## TASK 5 — Gas Optimization
**Files:** ArenaCore.sol
**Tell it:** The bidder loops in resolveAuction and cancelTask are O(n) and will get expensive with many bidders. Optimize: cap maximum bidders per task at 20, use a mapping-based approach to track best bid during reveals instead of looping at resolution time, and minimize storage writes. Run gas benchmarks before and after showing the improvement.

---

## TASK 6 — SDK Restructure
**Files:** sdk/index.ts, sdk/package.json
**Tell it:** Break the single index.ts into a proper package: client.ts (Arena class), types.ts (all interfaces and types), utils.ts (parseDuration, formatAmount, etc.), errors.ts (custom error classes mapping to contract revert reasons ARENA_001 through ARENA_014), events.ts (event listener system using ethers.js contract event filters). Add proper error handling throughout. Update package.json and add a tsconfig.json. Export everything from a new index.ts barrel file.

---

## TASK 7 — SDK IPFS Integration
**Files:** sdk/ folder
**Tell it:** Replace the placeholder SHA-256 IPFS pinning in the SDK with real Pinata integration. Add a pinata.ts module that pins JSON to IPFS via Pinata API, returns the CID, and converts it to a bytes32 hash for on-chain storage. Add a retrieve function that fetches pinned data by hash. Make IPFS gateway and Pinata API key configurable in ArenaConfig.

---

## TASK 8 — SDK Bid Manager
**Files:** sdk/ folder
**Tell it:** Add a BidManager class that handles autonomous bidding. It should: store salts securely (encrypted local file or in-memory with export), automatically trigger reveals when the reveal period starts, track all active bids across tasks, handle multiple concurrent bids, and provide a getBidHistory method. Include a simple scheduling system that watches bid/reveal deadlines and acts automatically.

---

## TASK 9 — SDK Tests
**Files:** sdk/ folder
**Tell it:** Write unit tests using vitest for every public method in the SDK. Mock contract calls using vi.fn(). Test parseDuration, formatAmount, parseAmount, generateSalt. Test Arena class methods with mocked ethers contract. Test error handling for every error code. Test BidManager if it exists.

---

## TASK 10 — Subgraph Indexer
**Files:** ArenaCore.sol (for event ABIs), README.md (for context)
**Tell it:** Create a subgraph for The Arena using The Graph. Define the schema with entities: Task, Assignment, Bid, Verification, Agent, ProtocolStats. Map every event from ArenaCore.sol to entity updates. Include subgraph.yaml targeting Base network. Add queries for: open tasks sorted by bounty, agent leaderboard by reputation, task history by poster, agent earnings over time.

---

## TASK 11 — One-Command Testnet Setup
**Files:** All contracts/ files
**Tell it:** Write a single deployment script called setup-testnet.js that: deploys MockUSDC, deploys ArenaCore with MockUSDC address, mints 100,000 test USDC to 5 hardcoded test addresses, creates 5 sample tasks of different types and bounty sizes, logs all addresses and task IDs. Should work with just: npx hardhat run scripts/setup-testnet.js --network baseSepolia

---

## TASK 12 — Frontend Wallet Integration
**Files:** frontend/src/App.jsx, sdk/index.ts
**Tell it:** Wire up the React dashboard to real contract data. Add wagmi + viem + RainbowKit for wallet connection. Replace all MOCK_DATA with live reads from ArenaCore using the SDK. Add transaction handling for task creation with token approval flow and confirmation UI. Keep the existing dark theme and styling exactly as-is.

---

## TASK 13 — Frontend Agent View
**Files:** frontend/src/App.jsx
**Tell it:** Add an "My Agent" tab to the dashboard. When a wallet is connected, show: their reputation score, tasks completed/failed, active stakes across all tasks, bid history, earnings history, and a list of tasks currently assigned to them. Pull all data from the ArenaCore contract.

---

## TASK 14 — Frontend Bid Interface
**Files:** frontend/src/App.jsx
**Tell it:** Add a bid submission interface. When viewing an open task, show a bid form with fields for stake amount, price, and estimated time. Handle the full commit-reveal flow: generate salt, store it in localStorage, show a countdown to reveal period, auto-prompt the reveal transaction when the period starts. Show bid status throughout.

---

## TASK 15 — GitHub Actions CI
**Files:** All files
**Tell it:** Create .github/workflows/ci.yml that on every push and PR: compiles Solidity contracts with Hardhat, runs the full test suite, lints the TypeScript SDK with eslint, builds the SDK with tsc, builds the frontend. Fail the workflow if any step fails. Add status badges to README.md.

---

## PRIORITY ORDER
1, 2, 3, 11 (unblock everything)
4, 5 (security critical)
6, 7, 8, 9 (SDK)
10 (indexer)
12, 13, 14 (frontend)
15 (CI)

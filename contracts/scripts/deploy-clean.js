/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Clean Deploy to Base Sepolia
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Deploys all 6 Arena contracts using raw ethers.js (no Hardhat
 *  deployer) with explicit nonce/gas management to avoid
 *  "replacement transaction underpriced" errors.
 *
 *  Deploy order:
 *    1. MockUSDC
 *    2. ArenaCoreMain(mockUSDC)
 *    3. ArenaCoreAuction(main)
 *    4. ArenaCoreVRF(main, auction)
 *    5. ArenaReputation(main)
 *    6. ArenaConsensus(main)
 *    7. ArenaProfiles(main)
 *    8. ArenaRecurring(main)
 *
 *  Post-config:
 *    - main.setArenaCoreAuction(auction)
 *    - auction.setArenaCoreVRF(vrf)
 *    - Mint 1M aUSDC to deployer
 *    - Whitelist aUSDC on ArenaCoreMain
 *    - Whitelist aUSDC on ArenaConsensus
 *    - Link ArenaReputation to ArenaCoreMain
 *
 *  Usage:
 *    node scripts/deploy-clean.js
 *
 *  Environment (.env):
 *    PRIVATE_KEY        — deployer wallet private key
 *    BASE_SEPOLIA_RPC   — RPC URL for Base Sepolia
 * ═══════════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────

const RPC_URL = process.env.BASE_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL) throw new Error("Missing BASE_SEPOLIA_RPC in .env");
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "src");
const OUTPUT_DIR = path.join(__dirname, "..", "deployments");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "base-sepolia.json");

const CONFIRMATIONS = 2;
const MAX_FEE = ethers.parseUnits("5", "gwei");
const PRIORITY_FEE = ethers.parseUnits("2", "gwei");
const GAS_LIMIT = 5_000_000n;

// ─── Helpers ─────────────────────────────────────────

function banner(text) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

function info(label, value) {
  console.log(`    ${label.padEnd(26)} ${value}`);
}

function loadArtifact(contractName) {
  const filePath = path.join(
    ARTIFACTS_DIR,
    `${contractName}.sol`,
    `${contractName}.json`
  );
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact not found: ${filePath}\nRun 'npx hardhat compile' first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Nonce management ────────────────────────────────

async function clearStuckTransactions(wallet, provider) {
  const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");
  const latestNonce = await provider.getTransactionCount(wallet.address, "latest");

  info("Pending nonce", pendingNonce.toString());
  info("Latest nonce", latestNonce.toString());

  if (pendingNonce > latestNonce) {
    const stuck = pendingNonce - latestNonce;
    console.log(`\n    ⚠ ${stuck} stuck transaction(s) detected. Clearing...\n`);

    for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
      console.log(`    Clearing nonce ${nonce}...`);
      const tx = await wallet.sendTransaction({
        to: wallet.address,
        value: 0n,
        nonce,
        maxFeePerGas: MAX_FEE,
        maxPriorityFeePerGas: PRIORITY_FEE,
        gasLimit: 21000n,
      });
      const receipt = await tx.wait(1);
      console.log(`    ✓ Cleared nonce ${nonce} — tx ${receipt.hash}`);
    }

    console.log(`\n    Waiting 10s for nonces to sync...\n`);
    await sleep(10_000);

    // Verify nonces match
    const newPending = await provider.getTransactionCount(wallet.address, "pending");
    const newLatest = await provider.getTransactionCount(wallet.address, "latest");
    info("New pending nonce", newPending.toString());
    info("New latest nonce", newLatest.toString());

    if (newPending !== newLatest) {
      throw new Error(
        `Nonces still mismatched after clearing: pending=${newPending}, latest=${newLatest}`
      );
    }

    console.log("    ✓ Nonces synchronized\n");
    return newLatest;
  }

  console.log("    ✓ No stuck transactions\n");
  return latestNonce;
}

// ─── Deploy function ─────────────────────────────────

async function deployContract(wallet, provider, name, constructorArgs, nonce) {
  const { abi, bytecode } = loadArtifact(name);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  console.log(`    Deploying with nonce ${nonce}...`);

  const deployTx = await factory.getDeployTransaction(...constructorArgs);
  const tx = await wallet.sendTransaction({
    ...deployTx,
    nonce,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    gasLimit: GAS_LIMIT,
  });

  info("Tx hash", tx.hash);
  console.log(`    Waiting for ${CONFIRMATIONS} confirmations...`);

  const receipt = await tx.wait(CONFIRMATIONS);
  const address = receipt.contractAddress;

  info("Contract address", address);
  info("Gas used", receipt.gasUsed.toString());
  info("Block", receipt.blockNumber.toString());

  // Verify the contract was deployed
  const code = await provider.getCode(address);
  if (code === "0x" || code.length < 4) {
    throw new Error(`Deployment of ${name} failed — no bytecode at ${address}`);
  }

  return { address, abi };
}

// ─── Post-config helper ──────────────────────────────

async function sendConfigTx(wallet, to, abi, functionName, args, nonce, label) {
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(functionName, args);

  console.log(`    ${label} (nonce ${nonce})...`);

  const tx = await wallet.sendTransaction({
    to,
    data,
    nonce,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    gasLimit: 200_000n,
  });

  const receipt = await tx.wait(CONFIRMATIONS);
  console.log(`    ✓ ${label} — tx ${receipt.hash}`);
  return nonce + 1;
}

// ─── Main ────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);

  banner("THE ARENA PROTOCOL — CLEAN DEPLOY");
  info("Network", `Base Sepolia (${network.chainId})`);
  info("Deployer", wallet.address);
  info("Balance", ethers.formatEther(balance) + " ETH");
  info("Max fee", ethers.formatUnits(MAX_FEE, "gwei") + " gwei");
  info("Priority fee", ethers.formatUnits(PRIORITY_FEE, "gwei") + " gwei");
  info("Gas limit", GAS_LIMIT.toString());

  const start = Date.now();

  // ─── Step 0: Clear stuck transactions ──────────────
  banner("STEP 0 — CLEAR STUCK TRANSACTIONS");
  let nonce = await clearStuckTransactions(wallet, provider);

  // ─── Step 1: MockUSDC ──────────────────────────────
  banner("STEP 1/6 — DEPLOY MockUSDC");
  const usdc = await deployContract(wallet, provider, "MockUSDC", [], nonce);
  nonce++;

  // ─── Step 2: ArenaCoreMain ──────────────────────────
  banner("STEP 2/8 — DEPLOY ArenaCoreMain");
  const coreMain = await deployContract(
    wallet, provider, "ArenaCoreMain", [usdc.address], nonce
  );
  nonce++;

  // ─── Step 3: ArenaCoreAuction ──────────────────────
  banner("STEP 3/8 — DEPLOY ArenaCoreAuction");
  const coreAuction = await deployContract(
    wallet, provider, "ArenaCoreAuction", [coreMain.address], nonce
  );
  nonce++;

  // ─── Step 4: ArenaCoreVRF ──────────────────────────
  banner("STEP 4/8 — DEPLOY ArenaCoreVRF");
  const coreVRF = await deployContract(
    wallet, provider, "ArenaCoreVRF", [coreMain.address, coreAuction.address], nonce
  );
  nonce++;

  // ─── Step 5: ArenaReputation ───────────────────────
  banner("STEP 5/8 — DEPLOY ArenaReputation");
  const reputation = await deployContract(
    wallet, provider, "ArenaReputation", [coreMain.address], nonce
  );
  nonce++;

  // ─── Step 6: ArenaConsensus ────────────────────────
  banner("STEP 6/8 — DEPLOY ArenaConsensus");
  const consensus = await deployContract(
    wallet, provider, "ArenaConsensus", [coreMain.address], nonce
  );
  nonce++;

  // ─── Step 7: ArenaProfiles ─────────────────────────
  banner("STEP 7/8 — DEPLOY ArenaProfiles");
  const profiles = await deployContract(
    wallet, provider, "ArenaProfiles", [coreMain.address], nonce
  );
  nonce++;

  // ─── Step 8: ArenaRecurring ────────────────────────
  banner("STEP 8/8 — DEPLOY ArenaRecurring");
  const recurring = await deployContract(
    wallet, provider, "ArenaRecurring", [coreMain.address], nonce
  );
  nonce++;

  // ─── Post-deployment configuration ─────────────────
  banner("POST-DEPLOYMENT CONFIGURATION");

  const addresses = {
    MockUSDC: usdc.address,
    ArenaCoreMain: coreMain.address,
    ArenaCoreAuction: coreAuction.address,
    ArenaCoreVRF: coreVRF.address,
    ArenaReputation: reputation.address,
    ArenaConsensus: consensus.address,
    ArenaProfiles: profiles.address,
    ArenaRecurring: recurring.address,
  };

  // Link ArenaCoreMain → ArenaCoreAuction
  const setAuctionAbi = [
    "function setArenaCoreAuction(address _auction) external",
  ];
  nonce = await sendConfigTx(
    wallet, coreMain.address, setAuctionAbi,
    "setArenaCoreAuction", [coreAuction.address],
    nonce, "Link ArenaCoreMain → ArenaCoreAuction"
  );

  // Link ArenaCoreMain → ArenaCoreVRF
  const setVRFOnMainAbi = [
    "function setArenaCoreVRF(address _vrf) external",
  ];
  nonce = await sendConfigTx(
    wallet, coreMain.address, setVRFOnMainAbi,
    "setArenaCoreVRF", [coreVRF.address],
    nonce, "Link ArenaCoreMain → ArenaCoreVRF"
  );

  // Link ArenaCoreAuction → ArenaCoreVRF
  const setVRFAbi = [
    "function setArenaCoreVRF(address _vrf) external",
  ];
  nonce = await sendConfigTx(
    wallet, coreAuction.address, setVRFAbi,
    "setArenaCoreVRF", [coreVRF.address],
    nonce, "Link ArenaCoreAuction → ArenaCoreVRF"
  );

  // Mint 1M aUSDC to deployer
  const mintAbi = ["function mint(address to, uint256 amount) external"];
  nonce = await sendConfigTx(
    wallet, usdc.address, mintAbi,
    "mint", [wallet.address, ethers.parseUnits("1000000", 6)],
    nonce, "Mint 1M aUSDC to deployer"
  );

  // Whitelist aUSDC on ArenaCoreMain (default token is already whitelisted in constructor, but just in case)
  // Note: default token is auto-whitelisted in constructor, so this step is optional
  // We skip it to avoid "already whitelisted" issues

  // Whitelist aUSDC on ArenaConsensus
  const setTokenWlAbi = [
    "function setTokenWhitelist(address _token, bool _allowed) external",
  ];
  nonce = await sendConfigTx(
    wallet, consensus.address, setTokenWlAbi,
    "setTokenWhitelist", [usdc.address, true],
    nonce, "Whitelist aUSDC on ArenaConsensus"
  );

  // Link ArenaReputation to ArenaCoreMain
  const setArenaCoreAbi = [
    "function setArenaCore(address _core) external",
  ];
  nonce = await sendConfigTx(
    wallet, reputation.address, setArenaCoreAbi,
    "setArenaCore", [coreMain.address],
    nonce, "Link ArenaReputation → ArenaCoreMain"
  );

  // ─── Save deployment ──────────────────────────────
  banner("SAVING DEPLOYMENT");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const deployment = {
    network: "baseSepolia",
    chainId: network.chainId.toString(),
    deployer: wallet.address,
    deployedAt: new Date().toISOString(),
    contracts: addresses,
    configuration: {
      "ArenaCoreMain.defaultToken": addresses.MockUSDC,
      "ArenaCoreMain.arenaCoreAuction": addresses.ArenaCoreAuction,
      "ArenaCoreAuction.arenaCoreVRF": addresses.ArenaCoreVRF,
      "ArenaConsensus.tokenWhitelist.MockUSDC": true,
      "ArenaReputation.arenaCore": addresses.ArenaCoreMain,
      "ArenaProfiles.arenaCore": addresses.ArenaCoreMain,
      "ArenaRecurring.core": addresses.ArenaCoreMain,
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(deployment, null, 2));
  info("Saved to", OUTPUT_FILE);

  // ─── Summary ───────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  banner("DEPLOYMENT COMPLETE");
  console.log("  Contract Addresses:");
  console.log("  ────────────────────────────────────────────────");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(24)} ${addr}`);
  }
  console.log("");
  console.log("  Configuration:");
  console.log("  ────────────────────────────────────────────────");
  console.log("  ArenaCoreMain ↔ Auction ✓ Linked");
  console.log("  ArenaCoreAuction ↔ VRF  ✓ Linked");
  console.log("  aUSDC minted            1,000,000 to deployer");
  console.log("  aUSDC whitelisted       ✓ ArenaConsensus");
  console.log("  ArenaReputation linked  ✓ ArenaCoreMain");
  console.log("  ArenaProfiles linked    ✓ ArenaCoreMain (via constructor)");
  console.log("  ArenaRecurring linked   ✓ ArenaCoreMain (via constructor)");
  console.log("");
  info("Total time", `${elapsed}s`);
  info("Final nonce", nonce.toString());
  console.log("");

  // ─── .env.local block for frontend ─────────────────
  banner("FRONTEND .env.local");
  console.log("  Copy these into frontend/.env.local:\n");
  console.log(`  NEXT_PUBLIC_RPC_URL=${RPC_URL}`);
  console.log(`  NEXT_PUBLIC_ARENA_CORE_MAIN_ADDRESS=${addresses.ArenaCoreMain}`);
  console.log(`  NEXT_PUBLIC_ARENA_CORE_AUCTION_ADDRESS=${addresses.ArenaCoreAuction}`);
  console.log(`  NEXT_PUBLIC_ARENA_CORE_VRF_ADDRESS=${addresses.ArenaCoreVRF}`);
  console.log(`  NEXT_PUBLIC_MOCK_USDC_ADDRESS=${addresses.MockUSDC}`);
  console.log(`  NEXT_PUBLIC_ARENA_REPUTATION_ADDRESS=${addresses.ArenaReputation}`);
  console.log(`  NEXT_PUBLIC_ARENA_CONSENSUS_ADDRESS=${addresses.ArenaConsensus}`);
  console.log(`  NEXT_PUBLIC_ARENA_PROFILES_ADDRESS=${addresses.ArenaProfiles}`);
  console.log(`  NEXT_PUBLIC_ARENA_RECURRING_ADDRESS=${addresses.ArenaRecurring}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n  ✗ DEPLOYMENT FAILED:");
    console.error(" ", error.message || error);
    console.error("\n  Stack:", error.stack);
    process.exit(1);
  });

/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Direct Deployment (No Hardhat Runner)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Deploys all 8 contracts using ethers.js directly, bypassing
 *  Hardhat's script runner to avoid hanging/double-execution bugs.
 *
 *  Usage:
 *    node scripts/deploy-direct.js
 *
 *  Environment (.env):
 *    PRIVATE_KEY       — deployer wallet private key (no 0x prefix)
 *    BASE_SEPOLIA_RPC  — RPC URL for Base Sepolia
 * ═══════════════════════════════════════════════════════════════════
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Config ──────────────────────────────────────────

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "src");
const OUTPUT_DIR = path.join(__dirname, "..", "deployments");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "base-sepolia.json");

// ─── Helpers ─────────────────────────────────────────

function banner(text) {
  const line = "═".repeat(55);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

function info(label, value) {
  console.log(`    ${label.padEnd(24)} ${value}`);
}

function loadArtifact(contractName) {
  const filePath = path.join(
    ARTIFACTS_DIR,
    `${contractName}.sol`,
    `${contractName}.json`
  );
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function getGasParams(provider) {
  const feeData = await provider.getFeeData();
  // Use 3x network rates to avoid underpriced errors, but stay reasonable
  const maxFee = (feeData.maxFeePerGas || 1000000n) * 3n;
  const maxPriority = (feeData.maxPriorityFeePerGas || 1000000n) * 3n;
  // Ensure priority <= maxFee
  return {
    maxFeePerGas: maxFee < 100000000n ? 100000000n : maxFee,  // floor 0.1 gwei
    maxPriorityFeePerGas: maxPriority < maxFee ? maxPriority : maxFee,
  };
}

async function deployContract(wallet, provider, contractName, args = []) {
  const artifact = loadArtifact(contractName);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const gas = await getGasParams(provider);

  console.log(`    Nonce: ${nonce} | maxFee: ${gas.maxFeePerGas} | maxPriority: ${gas.maxPriorityFeePerGas}`);
  const contract = await factory.deploy(...args, { nonce, ...gas });

  const txHash = contract.deploymentTransaction().hash;
  console.log(`    Tx: ${txHash}`);
  console.log(`    Waiting for confirmation...`);

  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`    ✓ Deployed at: ${address}\n`);

  return { contract, address };
}

async function sendTx(contract, method, args, wallet, provider, label) {
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const gas = await getGasParams(provider);

  console.log(`    ${label} (nonce ${nonce})...`);
  const tx = await contract[method](...args, { nonce, ...gas });
  await tx.wait();
  console.log(`    ✓ ${label} — confirmed`);
}

// ─── Main ────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const pending = await provider.getTransactionCount(wallet.address, "pending");

  banner("THE ARENA PROTOCOL — DIRECT DEPLOYMENT");
  info("Network", "Base Sepolia (84532)");
  info("Deployer", wallet.address);
  info("Balance", ethers.formatEther(balance) + " ETH");
  info("Nonce (latest)", nonce.toString());
  info("Nonce (pending)", pending.toString());

  if (pending > nonce) {
    console.log(`\n  ⚠ ${pending - nonce} pending txns detected. Clearing...`);
    const gas = await getGasParams(provider);
    for (let n = nonce; n < pending; n++) {
      const tx = await wallet.sendTransaction({
        to: wallet.address, value: 0, nonce: n, gasLimit: 21000, ...gas,
      });
      await tx.wait();
      console.log(`    ✓ Cleared nonce ${n}`);
    }
  }

  const start = Date.now();
  const addresses = {};

  // ─── 1. MockUSDC ─────────────────────────────────
  console.log("\n  [1/8] MockUSDC (aUSDC)");
  const usdc = await deployContract(wallet, provider, "MockUSDC");
  addresses.MockUSDC = usdc.address;

  // ─── 2. ArenaCoreMain ───────────────────────────
  console.log("  [2/8] ArenaCoreMain");
  const coreMain = await deployContract(wallet, provider, "ArenaCoreMain", [usdc.address]);
  addresses.ArenaCoreMain = coreMain.address;

  // ─── 3. ArenaCoreAuction ────────────────────────
  console.log("  [3/8] ArenaCoreAuction");
  const coreAuction = await deployContract(wallet, provider, "ArenaCoreAuction", [coreMain.address]);
  addresses.ArenaCoreAuction = coreAuction.address;

  // ─── 4. ArenaCoreVRF ───────────────────────────
  console.log("  [4/8] ArenaCoreVRF");
  const coreVRF = await deployContract(wallet, provider, "ArenaCoreVRF", [coreMain.address, coreAuction.address]);
  addresses.ArenaCoreVRF = coreVRF.address;

  // ─── 5. ArenaReputation ──────────────────────────
  console.log("  [5/8] ArenaReputation");
  const reputation = await deployContract(wallet, provider, "ArenaReputation", [coreMain.address]);
  addresses.ArenaReputation = reputation.address;

  // ─── 6. ArenaConsensus ───────────────────────────
  console.log("  [6/8] ArenaConsensus");
  const consensus = await deployContract(wallet, provider, "ArenaConsensus", [coreMain.address]);
  addresses.ArenaConsensus = consensus.address;

  // ─── 7. ArenaProfiles ────────────────────────────
  console.log("  [7/8] ArenaProfiles");
  const profiles = await deployContract(wallet, provider, "ArenaProfiles", [coreMain.address]);
  addresses.ArenaProfiles = profiles.address;

  // ─── 8. ArenaRecurring ───────────────────────────
  console.log("  [8/8] ArenaRecurring");
  const recurring = await deployContract(wallet, provider, "ArenaRecurring", [coreMain.address]);
  addresses.ArenaRecurring = recurring.address;

  // ─── Post-deploy configuration ───────────────────
  banner("POST-DEPLOYMENT CONFIGURATION");

  // Link core contracts
  await sendTx(coreMain.contract, "setArenaCoreAuction", [coreAuction.address], wallet, provider, "Link ArenaCoreMain → ArenaCoreAuction");
  await sendTx(coreMain.contract, "setArenaCoreVRF", [coreVRF.address], wallet, provider, "Link ArenaCoreMain → ArenaCoreVRF");
  await sendTx(coreAuction.contract, "setArenaCoreVRF", [coreVRF.address], wallet, provider, "Link ArenaCoreAuction → ArenaCoreVRF");

  // Mint 1M aUSDC to deployer (6 decimals)
  const mintAmount = ethers.parseUnits("1000000", 6);
  await sendTx(usdc.contract, "mint", [wallet.address, mintAmount], wallet, provider, "Mint 1M aUSDC to deployer");

  // Whitelist aUSDC on ArenaCoreMain
  await sendTx(coreMain.contract, "whitelistToken", [usdc.address, true, false], wallet, provider, "Whitelist aUSDC on ArenaCoreMain");

  // Whitelist aUSDC on ArenaConsensus
  await sendTx(consensus.contract, "setTokenWhitelist", [usdc.address, true], wallet, provider, "Whitelist aUSDC on ArenaConsensus");

  // Link ArenaReputation to ArenaCoreMain
  await sendTx(reputation.contract, "setArenaCore", [coreMain.address], wallet, provider, "Link ArenaReputation → ArenaCoreMain");

  // ─── Save deployment ─────────────────────────────
  banner("SAVING DEPLOYMENT");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const deployment = {
    network: "baseSepolia",
    chainId: "84532",
    deployer: wallet.address,
    deployedAt: new Date().toISOString(),
    contracts: addresses,
    configuration: {
      "ArenaCoreMain.defaultToken": addresses.MockUSDC,
      "ArenaCoreMain.arenaCoreAuction": addresses.ArenaCoreAuction,
      "ArenaCoreMain.arenaCoreVRF": addresses.ArenaCoreVRF,
      "ArenaCoreAuction.arenaCoreVRF": addresses.ArenaCoreVRF,
      "ArenaCoreMain.tokenWhitelist.MockUSDC": true,
      "ArenaConsensus.tokenWhitelist.MockUSDC": true,
      "ArenaReputation.arenaCore": addresses.ArenaCoreMain,
      "ArenaProfiles.arenaCore": addresses.ArenaCoreMain,
      "ArenaRecurring.core": addresses.ArenaCoreMain,
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(deployment, null, 2));
  info("Saved to", OUTPUT_FILE);

  // ─── Summary ─────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const endBalance = await provider.getBalance(wallet.address);

  banner("DEPLOYMENT COMPLETE");
  console.log("  Contract Addresses:");
  console.log("  ─────────────────────────────────────────────");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(24)} ${addr}`);
  }
  console.log("");
  info("Gas spent", ethers.formatEther(balance - endBalance) + " ETH");
  info("Remaining balance", ethers.formatEther(endBalance) + " ETH");
  info("Total time", `${elapsed}s`);

  // ─── Frontend .env.local snippet ─────────────────
  banner("FRONTEND .env.local");
  console.log("  Copy these into frontend/.env.local:\n");
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
    process.exit(1);
  });

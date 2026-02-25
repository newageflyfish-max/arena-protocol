/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Base Sepolia Testnet Deployment (Full)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Deploys all 8 contracts needed for a complete testnet:
 *    1. MockUSDC (aUSDC)    — testnet ERC-20, public mint
 *    2. ArenaCoreMain       — task lifecycle hub
 *    3. ArenaCoreAuction    — sealed-bid auction logic
 *    4. ArenaCoreVRF        — verifier selection + VRF
 *    5. ArenaReputation     — soulbound NFTs + credit score + poster rep
 *    6. ArenaConsensus      — multi-agent consensus tasks
 *    7. ArenaProfiles       — user profiles (display name, bio, avatar)
 *    8. ArenaRecurring      — recurring task templates
 *
 *  Also mints 1 M aUSDC to the deployer, links core contracts,
 *  links satellites, and whitelists aUSDC on both ArenaCoreMain
 *  and ArenaConsensus.
 *
 *  Usage:
 *    npx hardhat run scripts/deploy-sepolia.js --network baseSepolia
 *
 *  Environment:
 *    PRIVATE_KEY       — deployer wallet private key
 *    BASE_SEPOLIA_RPC  — RPC URL for Base Sepolia
 *    SKIP_VERIFY       — set "true" to skip BaseScan verification
 * ═══════════════════════════════════════════════════════════════════
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const CONFIRMATIONS = 2;
const OUTPUT_DIR = path.join(__dirname, "..", "deployments");
const OUTPUT_FILE = "base-sepolia.json";

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

async function deploy(name, args = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    const tx = contract.deploymentTransaction();
    if (tx) await tx.wait(CONFIRMATIONS);
  }

  return { contract, address };
}

async function verify(address, constructorArguments = []) {
  if (
    hre.network.name === "hardhat" ||
    hre.network.name === "localhost" ||
    process.env.SKIP_VERIFY === "true"
  ) return;

  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log(`    ✓ Verified on BaseScan`);
  } catch (err) {
    if (err.message.includes("Already Verified") || err.message.includes("already verified")) {
      console.log(`    ✓ Already verified`);
    } else {
      console.log(`    ✗ Verification failed: ${err.message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  banner("THE ARENA PROTOCOL — BASE SEPOLIA DEPLOYMENT");
  info("Network", hre.network.name);
  info("Chain ID", (await hre.ethers.provider.getNetwork()).chainId.toString());
  info("Deployer", deployer.address);
  info("Balance", hre.ethers.formatEther(balance) + " ETH");

  const start = Date.now();
  const addresses = {};

  // ─── 1. MockUSDC ───────────────────────────────────
  console.log("\n  [1/8] Deploying MockUSDC (aUSDC)...");
  const usdc = await deploy("MockUSDC");
  addresses.MockUSDC = usdc.address;
  info("MockUSDC", usdc.address);

  // Mint 1 M aUSDC to deployer (6 decimals)
  const mintAmount = hre.ethers.parseUnits("1000000", 6);
  let tx = await usdc.contract.mint(deployer.address, mintAmount);
  await tx.wait();
  info("Minted", "1,000,000 aUSDC to deployer");

  // ─── 2. ArenaCoreMain ─────────────────────────────
  console.log("\n  [2/8] Deploying ArenaCoreMain...");
  const coreMain = await deploy("ArenaCoreMain", [usdc.address]);
  addresses.ArenaCoreMain = coreMain.address;
  info("ArenaCoreMain", coreMain.address);

  // ─── 3. ArenaCoreAuction ──────────────────────────
  console.log("\n  [3/8] Deploying ArenaCoreAuction...");
  const coreAuction = await deploy("ArenaCoreAuction", [coreMain.address]);
  addresses.ArenaCoreAuction = coreAuction.address;
  info("ArenaCoreAuction", coreAuction.address);

  // ─── 4. ArenaCoreVRF ──────────────────────────────
  console.log("\n  [4/8] Deploying ArenaCoreVRF...");
  const coreVRF = await deploy("ArenaCoreVRF", [coreMain.address, coreAuction.address]);
  addresses.ArenaCoreVRF = coreVRF.address;
  info("ArenaCoreVRF", coreVRF.address);

  // ─── 5. ArenaReputation ────────────────────────────
  console.log("\n  [5/8] Deploying ArenaReputation...");
  const reputation = await deploy("ArenaReputation", [coreMain.address]);
  addresses.ArenaReputation = reputation.address;
  info("ArenaReputation", reputation.address);

  // ─── 6. ArenaConsensus ─────────────────────────────
  console.log("\n  [6/8] Deploying ArenaConsensus...");
  const consensus = await deploy("ArenaConsensus", [coreMain.address]);
  addresses.ArenaConsensus = consensus.address;
  info("ArenaConsensus", consensus.address);

  // ─── 7. ArenaProfiles ──────────────────────────────
  console.log("\n  [7/8] Deploying ArenaProfiles...");
  const profiles = await deploy("ArenaProfiles", [coreMain.address]);
  addresses.ArenaProfiles = profiles.address;
  info("ArenaProfiles", profiles.address);

  // ─── 8. ArenaRecurring ─────────────────────────────
  console.log("\n  [8/8] Deploying ArenaRecurring...");
  const recurring = await deploy("ArenaRecurring", [coreMain.address]);
  addresses.ArenaRecurring = recurring.address;
  info("ArenaRecurring", recurring.address);

  // ─── Link & configure ─────────────────────────────
  banner("POST-DEPLOYMENT CONFIGURATION");

  // Link core contracts
  console.log("  Linking ArenaCoreMain → ArenaCoreAuction...");
  tx = await coreMain.contract.setArenaCoreAuction(coreAuction.address);
  await tx.wait();
  info("Status", "✓ ArenaCoreAuction linked to Main");

  console.log("  Linking ArenaCoreMain → ArenaCoreVRF...");
  tx = await coreMain.contract.setArenaCoreVRF(coreVRF.address);
  await tx.wait();
  info("Status", "✓ ArenaCoreVRF linked to Main");

  console.log("  Linking ArenaCoreAuction → ArenaCoreVRF...");
  tx = await coreAuction.contract.setArenaCoreVRF(coreVRF.address);
  await tx.wait();
  info("Status", "✓ ArenaCoreVRF linked to Auction");

  // Whitelist aUSDC on ArenaCoreMain (it's auto-whitelisted in constructor,
  // but we call whitelistToken to mark it as a stablecoin explicitly)
  console.log("  Whitelisting aUSDC on ArenaCoreMain...");
  tx = await coreMain.contract.whitelistToken(usdc.address, true, false);
  await tx.wait();
  info("Status", "✓ aUSDC whitelisted on ArenaCoreMain");

  // Whitelist aUSDC on ArenaConsensus
  console.log("  Whitelisting aUSDC on ArenaConsensus...");
  tx = await consensus.contract.setTokenWhitelist(usdc.address, true);
  await tx.wait();
  info("Status", "✓ aUSDC whitelisted on ArenaConsensus");

  // Set ArenaReputation core address
  console.log("  Setting ArenaReputation.arenaCore...");
  tx = await reputation.contract.setArenaCore(coreMain.address);
  await tx.wait();
  info("Status", "✓ ArenaReputation linked to ArenaCoreMain");

  // ─── Save deployment ──────────────────────────────
  banner("SAVING DEPLOYMENT");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const deployment = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
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

  const filePath = path.join(OUTPUT_DIR, OUTPUT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
  info("Saved to", filePath);

  // ─── Verify on BaseScan ────────────────────────────
  if (
    hre.network.name !== "hardhat" &&
    hre.network.name !== "localhost" &&
    process.env.SKIP_VERIFY !== "true"
  ) {
    banner("BASESCAN VERIFICATION");
    console.log("  Waiting 30s for block propagation...\n");
    await new Promise((r) => setTimeout(r, 30_000));

    console.log("  Verifying MockUSDC...");
    await verify(addresses.MockUSDC, []);
    console.log("  Verifying ArenaCoreMain...");
    await verify(addresses.ArenaCoreMain, [addresses.MockUSDC]);
    console.log("  Verifying ArenaCoreAuction...");
    await verify(addresses.ArenaCoreAuction, [addresses.ArenaCoreMain]);
    console.log("  Verifying ArenaCoreVRF...");
    await verify(addresses.ArenaCoreVRF, [addresses.ArenaCoreMain, addresses.ArenaCoreAuction]);
    console.log("  Verifying ArenaReputation...");
    await verify(addresses.ArenaReputation, [addresses.ArenaCoreMain]);
    console.log("  Verifying ArenaConsensus...");
    await verify(addresses.ArenaConsensus, [addresses.ArenaCoreMain]);
    console.log("  Verifying ArenaProfiles...");
    await verify(addresses.ArenaProfiles, [addresses.ArenaCoreMain]);
    console.log("  Verifying ArenaRecurring...");
    await verify(addresses.ArenaRecurring, [addresses.ArenaCoreMain]);
  }

  // ─── Summary ───────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  banner("DEPLOYMENT COMPLETE");
  console.log("  Contract Addresses:");
  console.log("  ─────────────────────────────────────────────");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(24)} ${addr}`);
  }
  console.log("");
  console.log("  Configuration:");
  console.log("  ─────────────────────────────────────────────");
  console.log("  ArenaCoreMain ↔ Auction ✓ Linked");
  console.log("  ArenaCoreMain ↔ VRF     ✓ Linked");
  console.log("  ArenaCoreAuction ↔ VRF  ✓ Linked");
  console.log("  aUSDC whitelisted       ✓ ArenaCoreMain + ArenaConsensus");
  console.log("  ArenaReputation linked  ✓ ArenaCoreMain");
  console.log("  ArenaProfiles linked    ✓ ArenaCoreMain (via constructor)");
  console.log("  ArenaRecurring linked   ✓ ArenaCoreMain (via constructor)");
  console.log("  Deployer aUSDC balance  1,000,000 aUSDC");
  console.log("");
  info("Total time", `${elapsed}s`);
  info("Deployment file", filePath);
  console.log("");

  // ─── Print .env.local snippet ────────────────────
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

/**
 * Arena Protocol — Hardhat Auto-Gas Deploy
 *
 * Uses Hardhat's ethers.getContractFactory + factory.deploy() with ZERO
 * custom gas overrides.  The provider auto-estimates everything.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-hardhat-auto.js --network baseSepolia
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ARENA PROTOCOL — HARDHAT AUTO-GAS DEPLOY");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  Network:   ${hre.network.name}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (balance === 0n) {
    throw new Error("Deployer has 0 ETH — fund the wallet first.");
  }

  const addresses = {};

  // ── 1. MockUSDC ──────────────────────────────────────
  console.log("[1/8] Deploying MockUSDC...");
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy();
  await mockUSDC.waitForDeployment();
  addresses.MockUSDC = await mockUSDC.getAddress();
  console.log(`  ✓ MockUSDC: ${addresses.MockUSDC}\n`);

  // ── 2. ArenaCoreMain ─────────────────────────────────
  console.log("[2/8] Deploying ArenaCoreMain...");
  const ArenaCoreMain = await hre.ethers.getContractFactory("ArenaCoreMain");
  const coreMain = await ArenaCoreMain.deploy(addresses.MockUSDC);
  await coreMain.waitForDeployment();
  addresses.ArenaCoreMain = await coreMain.getAddress();
  console.log(`  ✓ ArenaCoreMain: ${addresses.ArenaCoreMain}\n`);

  // ── 3. ArenaCoreAuction ──────────────────────────────
  console.log("[3/8] Deploying ArenaCoreAuction...");
  const ArenaCoreAuction = await hre.ethers.getContractFactory("ArenaCoreAuction");
  const coreAuction = await ArenaCoreAuction.deploy(addresses.ArenaCoreMain);
  await coreAuction.waitForDeployment();
  addresses.ArenaCoreAuction = await coreAuction.getAddress();
  console.log(`  ✓ ArenaCoreAuction: ${addresses.ArenaCoreAuction}\n`);

  // ── 4. ArenaCoreVRF ──────────────────────────────────
  console.log("[4/8] Deploying ArenaCoreVRF...");
  const ArenaCoreVRF = await hre.ethers.getContractFactory("ArenaCoreVRF");
  const coreVRF = await ArenaCoreVRF.deploy(addresses.ArenaCoreMain, addresses.ArenaCoreAuction);
  await coreVRF.waitForDeployment();
  addresses.ArenaCoreVRF = await coreVRF.getAddress();
  console.log(`  ✓ ArenaCoreVRF: ${addresses.ArenaCoreVRF}\n`);

  // ── 5. ArenaReputation ───────────────────────────────
  console.log("[5/8] Deploying ArenaReputation...");
  const ArenaReputation = await hre.ethers.getContractFactory("ArenaReputation");
  const reputation = await ArenaReputation.deploy(addresses.ArenaCoreMain);
  await reputation.waitForDeployment();
  addresses.ArenaReputation = await reputation.getAddress();
  console.log(`  ✓ ArenaReputation: ${addresses.ArenaReputation}\n`);

  // ── 6. ArenaConsensus ────────────────────────────────
  console.log("[6/8] Deploying ArenaConsensus...");
  const ArenaConsensus = await hre.ethers.getContractFactory("ArenaConsensus");
  const consensus = await ArenaConsensus.deploy(addresses.ArenaCoreMain);
  await consensus.waitForDeployment();
  addresses.ArenaConsensus = await consensus.getAddress();
  console.log(`  ✓ ArenaConsensus: ${addresses.ArenaConsensus}\n`);

  // ── 7. ArenaProfiles ─────────────────────────────────
  console.log("[7/8] Deploying ArenaProfiles...");
  const ArenaProfiles = await hre.ethers.getContractFactory("ArenaProfiles");
  const profiles = await ArenaProfiles.deploy(addresses.ArenaCoreMain);
  await profiles.waitForDeployment();
  addresses.ArenaProfiles = await profiles.getAddress();
  console.log(`  ✓ ArenaProfiles: ${addresses.ArenaProfiles}\n`);

  // ── 8. ArenaRecurring ────────────────────────────────
  console.log("[8/8] Deploying ArenaRecurring...");
  const ArenaRecurring = await hre.ethers.getContractFactory("ArenaRecurring");
  const recurring = await ArenaRecurring.deploy(addresses.ArenaCoreMain);
  await recurring.waitForDeployment();
  addresses.ArenaRecurring = await recurring.getAddress();
  console.log(`  ✓ ArenaRecurring: ${addresses.ArenaRecurring}\n`);

  // ═══════════════════════════════════════════════════════
  // POST-DEPLOY CONFIGURATION
  // ═══════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════");
  console.log("  POST-DEPLOY CONFIGURATION");
  console.log("═══════════════════════════════════════════════════\n");

  // Link ArenaCoreMain → ArenaCoreAuction
  console.log("  Linking ArenaCoreMain → ArenaCoreAuction...");
  let tx = await coreMain.setArenaCoreAuction(addresses.ArenaCoreAuction);
  await tx.wait();
  console.log("  ✓ setArenaCoreAuction done");

  // Link ArenaCoreMain → ArenaCoreVRF
  console.log("  Linking ArenaCoreMain → ArenaCoreVRF...");
  tx = await coreMain.setArenaCoreVRF(addresses.ArenaCoreVRF);
  await tx.wait();
  console.log("  ✓ setArenaCoreVRF done");

  // Link ArenaCoreAuction → ArenaCoreVRF
  console.log("  Linking ArenaCoreAuction → ArenaCoreVRF...");
  tx = await coreAuction.setArenaCoreVRF(addresses.ArenaCoreVRF);
  await tx.wait();
  console.log("  ✓ auction.setArenaCoreVRF done");

  // Link ArenaReputation → ArenaCoreMain
  console.log("  Linking ArenaReputation → ArenaCoreMain...");
  tx = await reputation.setArenaCore(addresses.ArenaCoreMain);
  await tx.wait();
  console.log("  ✓ reputation.setArenaCore done");

  // Mint 1M aUSDC to deployer
  console.log("  Minting 1,000,000 aUSDC to deployer...");
  tx = await mockUSDC.mint(deployer.address, 1_000_000n * 10n ** 6n);
  await tx.wait();
  console.log("  ✓ 1M aUSDC minted");

  // Whitelist aUSDC on ArenaCoreMain (already done in constructor, but explicit)
  console.log("  Whitelisting aUSDC on ArenaCoreMain...");
  tx = await coreMain.whitelistToken(addresses.MockUSDC, true, false);
  await tx.wait();
  console.log("  ✓ aUSDC whitelisted\n");

  // ═══════════════════════════════════════════════════════
  // SAVE ADDRESSES
  // ═══════════════════════════════════════════════════════
  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "base-sepolia.json");
  fs.writeFileSync(outFile, JSON.stringify(addresses, null, 2));
  console.log(`Addresses saved to ${outFile}\n`);

  // ═══════════════════════════════════════════════════════
  // PRINT SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════");
  console.log("  ALL CONTRACTS DEPLOYED SUCCESSFULLY");
  console.log("═══════════════════════════════════════════════════");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(22)} ${addr}`);
  }

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  const spent = balance - balAfter;
  console.log(`\n  Gas spent: ${hre.ethers.formatEther(spent)} ETH`);
  console.log(`  Remaining: ${hre.ethers.formatEther(balAfter)} ETH`);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  FRONTEND .env.local — copy/paste this:");
  console.log("═══════════════════════════════════════════════════");
  console.log(`NEXT_PUBLIC_ARENA_CORE_MAIN_ADDRESS=${addresses.ArenaCoreMain}`);
  console.log(`NEXT_PUBLIC_ARENA_CORE_AUCTION_ADDRESS=${addresses.ArenaCoreAuction}`);
  console.log(`NEXT_PUBLIC_ARENA_CORE_ADDRESS=${addresses.ArenaCoreMain}`);
  console.log(`NEXT_PUBLIC_MOCK_USDC_ADDRESS=${addresses.MockUSDC}`);
  console.log(`NEXT_PUBLIC_ARENA_REPUTATION_ADDRESS=${addresses.ArenaReputation}`);
  console.log(`NEXT_PUBLIC_ARENA_CONSENSUS_ADDRESS=${addresses.ArenaConsensus}`);
  console.log(`NEXT_PUBLIC_ARENA_PROFILES_ADDRESS=${addresses.ArenaProfiles}`);
  console.log(`NEXT_PUBLIC_ARENA_RECURRING_ADDRESS=${addresses.ArenaRecurring}`);
  console.log(`NEXT_PUBLIC_CHAIN_ID=84532`);
  console.log(`NEXT_PUBLIC_RPC_URL=${process.env.BASE_SEPOLIA_RPC || "https://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY"}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ DEPLOY FAILED:", err.message || err);
    process.exit(1);
  });

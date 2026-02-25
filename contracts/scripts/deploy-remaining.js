/**
 * Arena Protocol — Deploy Remaining Satellites
 *
 * Deploys: ArenaArbitration, ArenaOutcomes, ArenaInsurance,
 *          ArenaSyndicates, ArenaDelegation, ArenaTimelock, ArenaCompliance
 *
 * Reads existing addresses from deployments/base-sepolia.json (flat format),
 * deploys new contracts, runs post-config, and saves updated addresses.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-remaining.js --network baseSepolia
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ARENA PROTOCOL — DEPLOY REMAINING SATELLITES");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  Network:   ${hre.network.name}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (balance === 0n) {
    throw new Error("Deployer has 0 ETH — fund the wallet first.");
  }

  // Load existing deployment (flat JSON)
  const deployFile = path.join(__dirname, "..", "deployments", "base-sepolia.json");
  if (!fs.existsSync(deployFile)) {
    throw new Error("No existing deployment found at " + deployFile);
  }
  const addresses = JSON.parse(fs.readFileSync(deployFile, "utf8"));
  console.log("  Existing deployment loaded:");
  console.log(`    ArenaCoreMain:    ${addresses.ArenaCoreMain}`);
  console.log(`    ArenaCoreAuction: ${addresses.ArenaCoreAuction}`);
  console.log(`    MockUSDC:         ${addresses.MockUSDC}\n`);

  const mainAddr = addresses.ArenaCoreMain;

  // Attach to ArenaCoreMain for post-config
  const coreMain = await hre.ethers.getContractAt("ArenaCoreMain", mainAddr);

  // ── 1. ArenaArbitration ────────────────────────────
  console.log("[1/7] Deploying ArenaArbitration...");
  const ArenaArbitration = await hre.ethers.getContractFactory("ArenaArbitration");
  const arbitration = await ArenaArbitration.deploy(mainAddr);
  await arbitration.waitForDeployment();
  addresses.ArenaArbitration = await arbitration.getAddress();
  console.log(`  ✓ ArenaArbitration: ${addresses.ArenaArbitration}\n`);

  // ── 2. ArenaOutcomes ───────────────────────────────
  console.log("[2/7] Deploying ArenaOutcomes...");
  const ArenaOutcomes = await hre.ethers.getContractFactory("ArenaOutcomes");
  const outcomes = await ArenaOutcomes.deploy(mainAddr);
  await outcomes.waitForDeployment();
  addresses.ArenaOutcomes = await outcomes.getAddress();
  console.log(`  ✓ ArenaOutcomes: ${addresses.ArenaOutcomes}\n`);

  // ── 3. ArenaInsurance ──────────────────────────────
  console.log("[3/7] Deploying ArenaInsurance...");
  const ArenaInsurance = await hre.ethers.getContractFactory("ArenaInsurance");
  const insurance = await ArenaInsurance.deploy(mainAddr);
  await insurance.waitForDeployment();
  addresses.ArenaInsurance = await insurance.getAddress();
  console.log(`  ✓ ArenaInsurance: ${addresses.ArenaInsurance}\n`);

  // ── 4. ArenaSyndicates ─────────────────────────────
  console.log("[4/7] Deploying ArenaSyndicates...");
  const ArenaSyndicates = await hre.ethers.getContractFactory("ArenaSyndicates");
  const syndicates = await ArenaSyndicates.deploy(mainAddr);
  await syndicates.waitForDeployment();
  addresses.ArenaSyndicates = await syndicates.getAddress();
  console.log(`  ✓ ArenaSyndicates: ${addresses.ArenaSyndicates}\n`);

  // ── 5. ArenaDelegation ─────────────────────────────
  console.log("[5/7] Deploying ArenaDelegation...");
  const ArenaDelegation = await hre.ethers.getContractFactory("ArenaDelegation");
  const delegation = await ArenaDelegation.deploy(mainAddr);
  await delegation.waitForDeployment();
  addresses.ArenaDelegation = await delegation.getAddress();
  console.log(`  ✓ ArenaDelegation: ${addresses.ArenaDelegation}\n`);

  // ── 6. ArenaTimelock ───────────────────────────────
  console.log("[6/7] Deploying ArenaTimelock...");
  const ArenaTimelock = await hre.ethers.getContractFactory("ArenaTimelock");
  const timelock = await ArenaTimelock.deploy();
  await timelock.waitForDeployment();
  addresses.ArenaTimelock = await timelock.getAddress();
  console.log(`  ✓ ArenaTimelock: ${addresses.ArenaTimelock}\n`);

  // ── 7. ArenaCompliance ─────────────────────────────
  console.log("[7/7] Deploying ArenaCompliance...");
  const ArenaCompliance = await hre.ethers.getContractFactory("ArenaCompliance");
  const compliance = await ArenaCompliance.deploy(mainAddr);
  await compliance.waitForDeployment();
  addresses.ArenaCompliance = await compliance.getAddress();
  console.log(`  ✓ ArenaCompliance: ${addresses.ArenaCompliance}\n`);

  // ═══════════════════════════════════════════════════════
  // POST-DEPLOY CONFIGURATION
  // ═══════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════");
  console.log("  POST-DEPLOY CONFIGURATION");
  console.log("═══════════════════════════════════════════════════\n");

  let tx;

  // Link ArenaCoreMain → ArenaArbitration
  console.log("  Linking ArenaCoreMain → ArenaArbitration...");
  tx = await coreMain.setArenaArbitration(addresses.ArenaArbitration);
  await tx.wait();
  console.log("  ✓ setArenaArbitration done");

  // Link ArenaCoreMain → ArenaOutcomes
  console.log("  Linking ArenaCoreMain → ArenaOutcomes...");
  tx = await coreMain.setArenaOutcomes(addresses.ArenaOutcomes);
  await tx.wait();
  console.log("  ✓ setArenaOutcomes done");

  // Link ArenaCoreMain → ArenaCompliance
  console.log("  Linking ArenaCoreMain → ArenaCompliance...");
  tx = await coreMain.setArenaCompliance(addresses.ArenaCompliance);
  await tx.wait();
  console.log("  ✓ setArenaCompliance done");

  // Link ArenaSyndicates → ArenaCoreMain
  console.log("  Linking ArenaSyndicates → ArenaCoreMain...");
  tx = await syndicates.setArenaCore(mainAddr);
  await tx.wait();
  console.log("  ✓ syndicates.setArenaCore done");

  // Link ArenaDelegation → ArenaCoreMain
  console.log("  Linking ArenaDelegation → ArenaCoreMain...");
  tx = await delegation.setArenaCore(mainAddr);
  await tx.wait();
  console.log("  ✓ delegation.setArenaCore done");

  // Link ArenaArbitration → ArenaCoreMain
  console.log("  Linking ArenaArbitration → ArenaCoreMain...");
  tx = await arbitration.setArenaCore(mainAddr);
  await tx.wait();
  console.log("  ✓ arbitration.setArenaCore done");

  // Set compliance officer to deployer for testing
  console.log("  Setting compliance officer to deployer...");
  tx = await compliance.setComplianceOfficer(deployer.address);
  await tx.wait();
  console.log("  ✓ compliance.setComplianceOfficer done\n");

  // ═══════════════════════════════════════════════════════
  // SAVE ADDRESSES
  // ═══════════════════════════════════════════════════════
  fs.writeFileSync(deployFile, JSON.stringify(addresses, null, 2));
  console.log(`Addresses saved to ${deployFile}\n`);

  // ═══════════════════════════════════════════════════════
  // PRINT SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════");
  console.log("  ALL REMAINING SATELLITES DEPLOYED");
  console.log("═══════════════════════════════════════════════════");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(22)} ${addr}`);
  }

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  const spent = balance - balAfter;
  console.log(`\n  Gas spent: ${hre.ethers.formatEther(spent)} ETH`);
  console.log(`  Remaining: ${hre.ethers.formatEther(balAfter)} ETH`);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  NEW FRONTEND .env.local VARS:");
  console.log("═══════════════════════════════════════════════════");
  console.log(`NEXT_PUBLIC_ARENA_ARBITRATION_ADDRESS=${addresses.ArenaArbitration}`);
  console.log(`NEXT_PUBLIC_ARENA_OUTCOMES_ADDRESS=${addresses.ArenaOutcomes}`);
  console.log(`NEXT_PUBLIC_ARENA_INSURANCE_ADDRESS=${addresses.ArenaInsurance}`);
  console.log(`NEXT_PUBLIC_ARENA_SYNDICATES_ADDRESS=${addresses.ArenaSyndicates}`);
  console.log(`NEXT_PUBLIC_ARENA_DELEGATION_ADDRESS=${addresses.ArenaDelegation}`);
  console.log(`NEXT_PUBLIC_ARENA_TIMELOCK_ADDRESS=${addresses.ArenaTimelock}`);
  console.log(`NEXT_PUBLIC_ARENA_COMPLIANCE_ADDRESS=${addresses.ArenaCompliance}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ DEPLOY FAILED:", err.message || err);
    process.exit(1);
  });

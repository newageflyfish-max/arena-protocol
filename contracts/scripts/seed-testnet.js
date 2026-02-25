/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Base Sepolia Seed Script
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Seeds the testnet deployment with sample tasks:
 *    1. Approve aUSDC for ArenaCoreMain, ArenaCoreAuction, and ArenaConsensus
 *    2. Create 2 standard tasks via ArenaCoreMain (100 + 250 aUSDC)
 *    3. Create 1 consensus task via ArenaConsensus (500 aUSDC, 3 agents)
 *
 *  Reads contract addresses from deployments/base-sepolia.json.
 *
 *  Usage:
 *    npx hardhat run scripts/seed-testnet.js --network baseSepolia
 * ═══════════════════════════════════════════════════════════════════
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEPLOYMENT_FILE = path.join(
  __dirname,
  "..",
  "deployments",
  "base-sepolia.json"
);

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

// ─── Main ────────────────────────────────────────────

async function main() {
  banner("THE ARENA PROTOCOL — SEED TESTNET");

  // ─── Load deployment addresses ────────────────────
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(
      `Deployment file not found: ${DEPLOYMENT_FILE}\nRun deploy-sepolia.js first.`
    );
  }

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
  const addresses = deployment.contracts || deployment;

  info("MockUSDC", addresses.MockUSDC);
  info("ArenaCoreMain", addresses.ArenaCoreMain);
  info("ArenaCoreAuction", addresses.ArenaCoreAuction);
  info("ArenaConsensus", addresses.ArenaConsensus);

  const [deployer] = await hre.ethers.getSigners();
  info("Deployer", deployer.address);

  // ─── Connect to contracts ────────────────────────
  const usdc = await hre.ethers.getContractAt("MockUSDC", addresses.MockUSDC);
  const coreMain = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);
  const consensus = await hre.ethers.getContractAt(
    "ArenaConsensus",
    addresses.ArenaConsensus
  );

  // Check deployer aUSDC balance
  const balance = await usdc.balanceOf(deployer.address);
  info("aUSDC Balance", hre.ethers.formatUnits(balance, 6) + " aUSDC");
  console.log("");

  // ─── 1. Approve aUSDC for ArenaCoreMain ──────────
  console.log("  [1/6] Approving aUSDC for ArenaCoreMain...");
  const coreApproval = hre.ethers.parseUnits("500000", 6); // 500K
  let tx = await usdc.approve(addresses.ArenaCoreMain, coreApproval);
  await tx.wait();
  info("Approved", "500,000 aUSDC for ArenaCoreMain");

  // ─── 2. Approve aUSDC for ArenaCoreAuction ──────
  console.log("  [2/6] Approving aUSDC for ArenaCoreAuction...");
  const auctionApproval = hre.ethers.parseUnits("500000", 6); // 500K
  tx = await usdc.approve(addresses.ArenaCoreAuction, auctionApproval);
  await tx.wait();
  info("Approved", "500,000 aUSDC for ArenaCoreAuction");

  // ─── 3. Approve aUSDC for ArenaConsensus ─────────
  console.log("  [3/6] Approving aUSDC for ArenaConsensus...");
  const consensusApproval = hre.ethers.parseUnits("500000", 6); // 500K
  tx = await usdc.approve(addresses.ArenaConsensus, consensusApproval);
  await tx.wait();
  info("Approved", "500,000 aUSDC for ArenaConsensus");

  // ─── Whitelist aUSDC on ArenaConsensus ───────────
  console.log("  [3.5/6] Whitelisting aUSDC on ArenaConsensus...");
  tx = await consensus.setTokenWhitelist(addresses.MockUSDC, true);
  await tx.wait();
  info("Whitelisted", "aUSDC on ArenaConsensus");

  // ─── Shared parameters ───────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const criteriaHash = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("testnet-demo-criteria-v1")
  );

  // ─── 4. Create standard task #1 (100 aUSDC) ──────
  console.log("\n  [4/6] Creating standard task #1 (100 aUSDC, audit)...");
  const bounty1 = hre.ethers.parseUnits("100", 6);
  tx = await coreMain.createTask(
    bounty1,                         // _bounty
    now + 7 * ONE_DAY,               // _deadline (7 days)
    2 * ONE_DAY,                     // _slashWindow (2 days)
    ONE_DAY,                         // _bidDuration (1 day)
    ONE_HOUR * 6,                    // _revealDuration (6 hours)
    2,                               // _requiredVerifiers
    criteriaHash,                    // _criteriaHash
    "audit",                         // _taskType
    addresses.MockUSDC               // _token
  );
  const receipt1 = await tx.wait();
  const taskCount1 = await coreMain.taskCount();
  const taskId1 = taskCount1 > 0n ? Number(taskCount1) - 1 : 0;
  info("Task ID", taskId1.toString());
  info("Bounty", "100 aUSDC");
  info("Type", "audit");

  // ─── 5. Create standard task #2 (250 aUSDC) ──────
  console.log("\n  [5/6] Creating standard task #2 (250 aUSDC, risk_validation)...");
  const bounty2 = hre.ethers.parseUnits("250", 6);
  tx = await coreMain.createTask(
    bounty2,                         // _bounty
    now + 14 * ONE_DAY,              // _deadline (14 days)
    3 * ONE_DAY,                     // _slashWindow (3 days)
    2 * ONE_DAY,                     // _bidDuration (2 days)
    ONE_HOUR * 12,                   // _revealDuration (12 hours)
    3,                               // _requiredVerifiers
    criteriaHash,                    // _criteriaHash
    "risk_validation",               // _taskType
    addresses.MockUSDC               // _token
  );
  const receipt2 = await tx.wait();
  const taskCount2 = await coreMain.taskCount();
  const taskId2 = taskCount2 > 0n ? Number(taskCount2) - 1 : 0;
  info("Task ID", taskId2.toString());
  info("Bounty", "250 aUSDC");
  info("Type", "risk_validation");

  // ─── 6. Create consensus task (500 aUSDC, 3 agents) ──
  console.log(
    "\n  [6/6] Creating consensus task (500 aUSDC, 3 agents, credit_scoring)..."
  );
  const totalBounty = hre.ethers.parseUnits("500", 6);
  tx = await consensus.createConsensusTask(
    totalBounty,                     // _totalBounty
    3,                               // _agentCount
    now + 10 * ONE_DAY,              // _deadline (10 days)
    2 * ONE_DAY,                     // _slashWindow (2 days)
    2 * ONE_DAY,                     // _bidDuration (2 days)
    ONE_HOUR * 12,                   // _revealDuration (12 hours)
    2,                               // _requiredVerifiers
    criteriaHash,                    // _criteriaHash
    "credit_scoring",                // _taskType
    addresses.MockUSDC               // _token
  );
  const receipt3 = await tx.wait();
  const consensusCount = await consensus.consensusTaskCount();
  const consensusId = Number(consensusCount) - 1;
  info("Consensus Task ID", consensusId.toString());
  info("Total Bounty", "500 aUSDC");
  info("Per Agent", "~166.67 aUSDC");
  info("Agent Count", "3");
  info("Type", "credit_scoring");

  // ─── Summary ─────────────────────────────────────
  banner("SEEDING COMPLETE");

  console.log("  Standard Tasks (ArenaCoreMain):");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Task #${taskId1}    100 aUSDC    audit`);
  console.log(`  Task #${taskId2}    250 aUSDC    risk_validation`);
  console.log("");
  console.log("  Consensus Tasks (ArenaConsensus):");
  console.log("  ─────────────────────────────────────────────");
  console.log(
    `  Task #${consensusId}    500 aUSDC    credit_scoring    3 agents`
  );
  console.log("");

  // Updated balances
  const finalBalance = await usdc.balanceOf(deployer.address);
  info(
    "Remaining aUSDC",
    hre.ethers.formatUnits(finalBalance, 6) + " aUSDC"
  );
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n  ✗ SEEDING FAILED:");
    console.error(" ", error.message || error);
    process.exit(1);
  });

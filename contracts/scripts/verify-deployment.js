/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Deployment Verification Script
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Connects to each deployed contract, calls view functions,
 *  checks balances, and prints a pass/fail report.
 *
 *  Reads contract addresses from deployments/base-sepolia.json.
 *
 *  Usage:
 *    npx hardhat run scripts/verify-deployment.js --network baseSepolia
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

let passCount = 0;
let failCount = 0;

function pass(label) {
  passCount++;
  console.log(`  ✓ PASS  ${label}`);
}

function fail(label, detail) {
  failCount++;
  console.log(`  ✗ FAIL  ${label}`);
  if (detail) console.log(`          ${detail}`);
}

function check(label, condition, detail) {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail || "Condition not met");
  }
}

// ─── Main ────────────────────────────────────────────

async function main() {
  banner("THE ARENA PROTOCOL — DEPLOYMENT VERIFICATION");

  // ─── Load deployment addresses ────────────────────
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(
      `Deployment file not found: ${DEPLOYMENT_FILE}\nRun deploy-sepolia.js first.`
    );
  }

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
  const addresses = deployment.contracts;

  console.log("  Deployment Info:");
  console.log(`    Network:   ${deployment.network}`);
  console.log(`    Chain ID:  ${deployment.chainId}`);
  console.log(`    Deployer:  ${deployment.deployer}`);
  console.log(`    Date:      ${deployment.deployedAt}`);
  console.log("");

  const [deployer] = await hre.ethers.getSigners();

  // ─── 1. MockUSDC ──────────────────────────────────
  banner("1. MockUSDC (aUSDC)");

  try {
    const usdc = await hre.ethers.getContractAt("MockUSDC", addresses.MockUSDC);

    const name = await usdc.name();
    check("Name is 'Arena Test USDC'", name === "Arena Test USDC", `Got: ${name}`);

    const symbol = await usdc.symbol();
    check("Symbol is 'aUSDC'", symbol === "aUSDC", `Got: ${symbol}`);

    const decimals = await usdc.decimals();
    check("Decimals is 6", Number(decimals) === 6, `Got: ${decimals}`);

    const balance = await usdc.balanceOf(deployer.address);
    const balanceNum = Number(hre.ethers.formatUnits(balance, 6));
    check(
      "Deployer has aUSDC balance",
      balanceNum > 0,
      `Balance: ${balanceNum} aUSDC`
    );
    console.log(`    ℹ Balance: ${balanceNum.toLocaleString()} aUSDC`);

    // Test mint function exists (don't actually mint)
    const mintFn = usdc.interface.getFunction("mint");
    check("mint() function exists", mintFn !== null);
  } catch (err) {
    fail("MockUSDC connection", err.message);
  }

  // ─── 2. ArenaCoreMain ────────────────────────────
  banner("2. ArenaCoreMain");

  try {
    const coreMain = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);

    const defaultToken = await coreMain.defaultToken();
    check(
      "defaultToken == MockUSDC",
      defaultToken.toLowerCase() === addresses.MockUSDC.toLowerCase(),
      `Got: ${defaultToken}`
    );

    const isWhitelisted = await coreMain.tokenWhitelist(addresses.MockUSDC);
    check("MockUSDC is whitelisted", isWhitelisted === true);

    const owner = await coreMain.owner();
    check(
      "Owner is deployer",
      owner.toLowerCase() === deployer.address.toLowerCase(),
      `Owner: ${owner}`
    );

    const taskCount = await coreMain.taskCount();
    console.log(`    ℹ Task count: ${taskCount}`);
    check("taskCount() callable", true);

    const minBounty = await coreMain.minBounty();
    check(
      "minBounty is 50 USDC (50e6)",
      Number(minBounty) === 50_000_000,
      `Got: ${minBounty}`
    );
  } catch (err) {
    fail("ArenaCoreMain connection", err.message);
  }

  // ─── 2b. ArenaCoreAuction ──────────────────────
  banner("2b. ArenaCoreAuction");

  try {
    const coreAuction = await hre.ethers.getContractAt("ArenaCoreAuction", addresses.ArenaCoreAuction);

    const owner = await coreAuction.owner();
    check(
      "Owner is deployer",
      owner.toLowerCase() === deployer.address.toLowerCase(),
      `Owner: ${owner}`
    );

    check("ArenaCoreAuction deployed", true);
  } catch (err) {
    fail("ArenaCoreAuction connection", err.message);
  }

  // ─── 2c. ArenaCoreVRF ─────────────────────────
  banner("2c. ArenaCoreVRF");

  try {
    const coreVRF = await hre.ethers.getContractAt("ArenaCoreVRF", addresses.ArenaCoreVRF);

    const owner = await coreVRF.owner();
    check(
      "Owner is deployer",
      owner.toLowerCase() === deployer.address.toLowerCase(),
      `Owner: ${owner}`
    );

    const verifierPoolLen = await coreVRF.verifierPoolLength();
    console.log(`    ℹ Verifier pool length: ${verifierPoolLen}`);
    check("verifierPoolLength() callable", true);
  } catch (err) {
    fail("ArenaCoreVRF connection", err.message);
  }

  // ─── 3. ArenaReputation ───────────────────────────
  banner("3. ArenaReputation");

  try {
    const reputation = await hre.ethers.getContractAt(
      "ArenaReputation",
      addresses.ArenaReputation
    );

    const owner = await reputation.owner();
    check(
      "Owner is deployer",
      owner.toLowerCase() === deployer.address.toLowerCase(),
      `Owner: ${owner}`
    );

    const arenaCore = await reputation.arenaCore();
    check(
      "arenaCore == ArenaCoreMain address",
      arenaCore.toLowerCase() === addresses.ArenaCoreMain.toLowerCase(),
      `Got: ${arenaCore}`
    );

    const name = await reputation.name();
    check("NFT name is 'Arena Reputation'", name === "Arena Reputation", `Got: ${name}`);

    const symbol = await reputation.symbol();
    check("NFT symbol is 'AREP'", symbol === "AREP", `Got: ${symbol}`);

    // Check credit score view function
    const scoreData = await reputation.getAgentCreditScore(deployer.address);
    console.log(`    ℹ Deployer credit score: ${scoreData[0]}`);
    check("getAgentCreditScore() callable", true);

    // Check poster score view function
    const posterScore = await reputation.getPosterScore(deployer.address);
    console.log(`    ℹ Deployer poster score: ${posterScore[0]}`);
    check("getPosterScore() callable", true);
  } catch (err) {
    fail("ArenaReputation connection", err.message);
  }

  // ─── 4. ArenaConsensus ────────────────────────────
  banner("4. ArenaConsensus");

  try {
    const consensus = await hre.ethers.getContractAt(
      "ArenaConsensus",
      addresses.ArenaConsensus
    );

    const owner = await consensus.owner();
    check(
      "Owner is deployer",
      owner.toLowerCase() === deployer.address.toLowerCase(),
      `Owner: ${owner}`
    );

    const coreAddr = await consensus.core();
    check(
      "core == ArenaCoreMain address",
      coreAddr.toLowerCase() === addresses.ArenaCoreMain.toLowerCase(),
      `Got: ${coreAddr}`
    );

    const isWhitelisted = await consensus.tokenWhitelist(addresses.MockUSDC);
    check("MockUSDC whitelisted on consensus", isWhitelisted === true);

    const taskCount = await consensus.consensusTaskCount();
    console.log(`    ℹ Consensus task count: ${taskCount}`);
    check("consensusTaskCount() callable", true);
  } catch (err) {
    fail("ArenaConsensus connection", err.message);
  }

  // ─── 5. ArenaProfiles ──────────────────────────────
  banner("5. ArenaProfiles");

  if (addresses.ArenaProfiles) {
    try {
      const profiles = await hre.ethers.getContractAt(
        "ArenaProfiles",
        addresses.ArenaProfiles
      );

      const owner = await profiles.owner();
      check(
        "Owner is deployer",
        owner.toLowerCase() === deployer.address.toLowerCase(),
        `Owner: ${owner}`
      );

      const coreAddr = await profiles.arenaCore();
      check(
        "arenaCore == ArenaCoreMain address",
        coreAddr.toLowerCase() === addresses.ArenaCoreMain.toLowerCase(),
        `Got: ${coreAddr}`
      );

      const profileCount = await profiles.profileCount();
      console.log(`    ℹ Profile count: ${profileCount}`);
      check("profileCount() callable", true);

      // Check hasProfile view function
      const hasP = await profiles.hasProfile(deployer.address);
      console.log(`    ℹ Deployer has profile: ${hasP}`);
      check("hasProfile() callable", true);
    } catch (err) {
      fail("ArenaProfiles connection", err.message);
    }
  } else {
    console.log("    ⊘ ArenaProfiles not in deployment file — skipped");
  }

  // ─── 6. ArenaRecurring ────────────────────────────
  banner("6. ArenaRecurring");

  if (addresses.ArenaRecurring) {
    try {
      const recurring = await hre.ethers.getContractAt(
        "ArenaRecurring",
        addresses.ArenaRecurring
      );

      const owner = await recurring.owner();
      check(
        "Owner is deployer",
        owner.toLowerCase() === deployer.address.toLowerCase(),
        `Owner: ${owner}`
      );

      const coreAddr = await recurring.core();
      check(
        "core == ArenaCoreMain address",
        coreAddr.toLowerCase() === addresses.ArenaCoreMain.toLowerCase(),
        `Got: ${coreAddr}`
      );

      const templateCount = await recurring.templateCount();
      console.log(`    ℹ Template count: ${templateCount}`);
      check("templateCount() callable", true);
    } catch (err) {
      fail("ArenaRecurring connection", err.message);
    }
  } else {
    console.log("    ⊘ ArenaRecurring not in deployment file — skipped");
  }

  // ─── 7. Cross-Contract Links ──────────────────────
  banner("7. Cross-Contract Links");

  try {
    const coreMain = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);
    const coreAuction = await hre.ethers.getContractAt("ArenaCoreAuction", addresses.ArenaCoreAuction);
    const coreVRF = await hre.ethers.getContractAt("ArenaCoreVRF", addresses.ArenaCoreVRF);
    const reputation = await hre.ethers.getContractAt(
      "ArenaReputation",
      addresses.ArenaReputation
    );

    // Check ArenaCoreMain -> ArenaCoreAuction link
    const mainAuction = await coreMain.arenaCoreAuction();
    check(
      "ArenaCoreMain.arenaCoreAuction -> ArenaCoreAuction",
      mainAuction.toLowerCase() === addresses.ArenaCoreAuction.toLowerCase()
    );

    // Check ArenaCoreMain -> ArenaCoreVRF link
    const mainVRF = await coreMain.arenaCoreVRF();
    check(
      "ArenaCoreMain.arenaCoreVRF -> ArenaCoreVRF",
      mainVRF.toLowerCase() === addresses.ArenaCoreVRF.toLowerCase()
    );

    // Check ArenaCoreAuction -> ArenaCoreVRF link
    const auctionVRF = await coreAuction.arenaCoreVRF();
    check(
      "ArenaCoreAuction.arenaCoreVRF -> ArenaCoreVRF",
      auctionVRF.toLowerCase() === addresses.ArenaCoreVRF.toLowerCase()
    );

    // Check ArenaReputation -> ArenaCoreMain link
    const repCore = await reputation.arenaCore();
    check(
      "ArenaReputation.arenaCore -> ArenaCoreMain",
      repCore.toLowerCase() === addresses.ArenaCoreMain.toLowerCase()
    );

    // Check token whitelist consistency
    const coreWl = await coreMain.tokenWhitelist(addresses.MockUSDC);
    check("aUSDC whitelisted on ArenaCoreMain", coreWl === true);

    const consensus = await hre.ethers.getContractAt(
      "ArenaConsensus",
      addresses.ArenaConsensus
    );
    const consWl = await consensus.tokenWhitelist(addresses.MockUSDC);
    check("aUSDC whitelisted on ArenaConsensus", consWl === true);

    // Check ArenaProfiles -> ArenaCoreMain link
    if (addresses.ArenaProfiles) {
      const profiles = await hre.ethers.getContractAt(
        "ArenaProfiles",
        addresses.ArenaProfiles
      );
      const profCore = await profiles.arenaCore();
      check(
        "ArenaProfiles.arenaCore -> ArenaCoreMain",
        profCore.toLowerCase() === addresses.ArenaCoreMain.toLowerCase()
      );
    }

    // Check ArenaRecurring -> ArenaCoreMain link
    if (addresses.ArenaRecurring) {
      const recurring = await hre.ethers.getContractAt(
        "ArenaRecurring",
        addresses.ArenaRecurring
      );
      const recCore = await recurring.core();
      check(
        "ArenaRecurring.core -> ArenaCoreMain",
        recCore.toLowerCase() === addresses.ArenaCoreMain.toLowerCase()
      );
    }
  } catch (err) {
    fail("Cross-contract link check", err.message);
  }

  // ─── 8. Deployer ETH Balance ──────────────────────
  banner("8. Deployer ETH Balance");

  const ethBalance = await hre.ethers.provider.getBalance(deployer.address);
  const ethBalanceFormatted = hre.ethers.formatEther(ethBalance);
  console.log(`    ℹ Deployer ETH: ${ethBalanceFormatted} ETH`);
  check(
    "Deployer has ETH for gas",
    Number(ethBalanceFormatted) > 0.001,
    `Balance: ${ethBalanceFormatted} ETH`
  );

  // ─── Summary ─────────────────────────────────────
  banner("VERIFICATION SUMMARY");

  console.log(`  Total checks:  ${passCount + failCount}`);
  console.log(`  Passed:        ${passCount}`);
  console.log(`  Failed:        ${failCount}`);
  console.log("");

  if (failCount === 0) {
    console.log("  ✅ ALL CHECKS PASSED — Deployment is healthy!\n");
  } else {
    console.log(`  ⚠️  ${failCount} CHECK(S) FAILED — Review above.\n`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n  ✗ VERIFICATION FAILED:");
    console.error(" ", error.message || error);
    process.exit(1);
  });

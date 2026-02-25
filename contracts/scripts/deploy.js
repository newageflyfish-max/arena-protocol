/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARENA PROTOCOL — Full Deployment Script
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Deploys all 13 contracts to Base Sepolia in correct dependency
 *  order, links the 3-contract core (ArenaCoreMain + ArenaCoreAuction
 *  + ArenaCoreVRF), links satellites to ArenaCoreMain, whitelists
 *  USDC, and transfers ownership to ArenaTimelock.
 *
 *  Usage:
 *    npx hardhat run scripts/deploy.js --network baseSepolia
 *    npx hardhat run scripts/deploy.js --network localhost
 *
 *  Environment:
 *    PRIVATE_KEY              — deployer wallet private key
 *    ALCHEMY_BASE_SEPOLIA_RPC — Alchemy RPC URL for Base Sepolia
 *    BASESCAN_API_KEY         — BaseScan API key for verification
 *    SKIP_VERIFY              — set "true" to skip verification
 * ═══════════════════════════════════════════════════════════════════
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════

const DEPLOY_CONFIG = {
  // Seconds to wait before attempting BaseScan verification
  VERIFY_DELAY_MS: 30_000,
  // Number of block confirmations to wait after each deploy
  CONFIRMATIONS: 1,
  // Output file for deployed addresses
  OUTPUT_DIR: path.join(__dirname, "..", "deployments"),
  OUTPUT_FILE: "base-sepolia.json",
};

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function banner(text) {
  const line = "═".repeat(55);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

function step(num, text) {
  console.log(`\n  [${num}/15] ${text}`);
}

function link(num, text) {
  console.log(`  [Link ${num}] ${text}`);
}

function info(label, value) {
  console.log(`    ${label.padEnd(22)} ${value}`);
}

async function deployContract(name, args = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  // Wait for confirmations on live networks
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    const deployTx = contract.deploymentTransaction();
    if (deployTx) {
      await deployTx.wait(DEPLOY_CONFIG.CONFIRMATIONS);
    }
  }

  return { contract, address };
}

async function verifyContract(address, constructorArguments = []) {
  if (
    hre.network.name === "hardhat" ||
    hre.network.name === "localhost" ||
    process.env.SKIP_VERIFY === "true"
  ) {
    return;
  }

  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`    ✓ Verified on BaseScan`);
  } catch (error) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      console.log(`    ✓ Already verified`);
    } else {
      console.log(`    ✗ Verification failed: ${error.message}`);
    }
  }
}

function saveDeployment(data) {
  if (!fs.existsSync(DEPLOY_CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(DEPLOY_CONFIG.OUTPUT_DIR, { recursive: true });
  }

  const filePath = path.join(DEPLOY_CONFIG.OUTPUT_DIR, DEPLOY_CONFIG.OUTPUT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\n  Deployment saved to: ${filePath}`);
}

// ═══════════════════════════════════════════════════
// MAIN DEPLOYMENT
// ═══════════════════════════════════════════════════

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  banner("THE ARENA PROTOCOL — DEPLOYMENT");
  info("Network", hre.network.name);
  info("Chain ID", (await hre.ethers.provider.getNetwork()).chainId.toString());
  info("Deployer", deployer.address);
  info("Balance", hre.ethers.formatEther(balance) + " ETH");
  console.log("");

  const startTime = Date.now();
  const addresses = {};
  const contracts = {};

  // ─────────────────────────────────────────────────
  // STEP 1: Deploy MockUSDC
  // ─────────────────────────────────────────────────
  step(1, "Deploying MockUSDC...");
  const usdc = await deployContract("MockUSDC");
  addresses.MockUSDC = usdc.address;
  contracts.MockUSDC = usdc.contract;
  info("MockUSDC", usdc.address);

  // ─────────────────────────────────────────────────
  // STEP 2: Deploy ArenaCoreMain
  // ─────────────────────────────────────────────────
  step(2, "Deploying ArenaCoreMain...");
  const coreMain = await deployContract("ArenaCoreMain", [usdc.address]);
  addresses.ArenaCoreMain = coreMain.address;
  contracts.ArenaCoreMain = coreMain.contract;
  info("ArenaCoreMain", coreMain.address);

  // ─────────────────────────────────────────────────
  // STEP 3: Deploy ArenaCoreAuction
  // ─────────────────────────────────────────────────
  step(3, "Deploying ArenaCoreAuction...");
  const coreAuction = await deployContract("ArenaCoreAuction", [coreMain.address]);
  addresses.ArenaCoreAuction = coreAuction.address;
  contracts.ArenaCoreAuction = coreAuction.contract;
  info("ArenaCoreAuction", coreAuction.address);

  // ─────────────────────────────────────────────────
  // STEP 4: Deploy ArenaCoreVRF
  // ─────────────────────────────────────────────────
  step(4, "Deploying ArenaCoreVRF...");
  const coreVRF = await deployContract("ArenaCoreVRF", [coreMain.address, coreAuction.address]);
  addresses.ArenaCoreVRF = coreVRF.address;
  contracts.ArenaCoreVRF = coreVRF.contract;
  info("ArenaCoreVRF", coreVRF.address);

  // ─────────────────────────────────────────────────
  // STEP 5: Deploy ArenaContinuous
  // ─────────────────────────────────────────────────
  step(5, "Deploying ArenaContinuous...");
  const continuous = await deployContract("ArenaContinuous", [coreMain.address]);
  addresses.ArenaContinuous = continuous.address;
  contracts.ArenaContinuous = continuous.contract;
  info("ArenaContinuous", continuous.address);

  // ─────────────────────────────────────────────────
  // STEP 6: Deploy ArenaArbitration
  // ─────────────────────────────────────────────────
  step(6, "Deploying ArenaArbitration...");
  const arbitration = await deployContract("ArenaArbitration", [coreMain.address]);
  addresses.ArenaArbitration = arbitration.address;
  contracts.ArenaArbitration = arbitration.contract;
  info("ArenaArbitration", arbitration.address);

  // ─────────────────────────────────────────────────
  // STEP 7: Deploy ArenaReputation
  // ─────────────────────────────────────────────────
  step(7, "Deploying ArenaReputation...");
  const reputation = await deployContract("ArenaReputation", [coreMain.address]);
  addresses.ArenaReputation = reputation.address;
  contracts.ArenaReputation = reputation.contract;
  info("ArenaReputation", reputation.address);

  // ─────────────────────────────────────────────────
  // STEP 8: Deploy ArenaSyndicates
  // ─────────────────────────────────────────────────
  step(8, "Deploying ArenaSyndicates...");
  const syndicates = await deployContract("ArenaSyndicates", [coreMain.address]);
  addresses.ArenaSyndicates = syndicates.address;
  contracts.ArenaSyndicates = syndicates.contract;
  info("ArenaSyndicates", syndicates.address);

  // ─────────────────────────────────────────────────
  // STEP 9: Deploy ArenaInsurance
  // ─────────────────────────────────────────────────
  step(9, "Deploying ArenaInsurance...");
  const insurance = await deployContract("ArenaInsurance", [coreMain.address]);
  addresses.ArenaInsurance = insurance.address;
  contracts.ArenaInsurance = insurance.contract;
  info("ArenaInsurance", insurance.address);

  // ─────────────────────────────────────────────────
  // STEP 10: Deploy ArenaDelegation
  // ─────────────────────────────────────────────────
  step(10, "Deploying ArenaDelegation...");
  const delegation = await deployContract("ArenaDelegation", [coreMain.address]);
  addresses.ArenaDelegation = delegation.address;
  contracts.ArenaDelegation = delegation.contract;
  info("ArenaDelegation", delegation.address);

  // ─────────────────────────────────────────────────
  // STEP 11: Deploy ArenaOutcomes
  // ─────────────────────────────────────────────────
  step(11, "Deploying ArenaOutcomes...");
  const outcomes = await deployContract("ArenaOutcomes", [coreMain.address]);
  addresses.ArenaOutcomes = outcomes.address;
  contracts.ArenaOutcomes = outcomes.contract;
  info("ArenaOutcomes", outcomes.address);

  // ─────────────────────────────────────────────────
  // STEP 12: Deploy ArenaCompliance
  // ─────────────────────────────────────────────────
  step(12, "Deploying ArenaCompliance...");
  const compliance = await deployContract("ArenaCompliance", [coreMain.address]);
  addresses.ArenaCompliance = compliance.address;
  contracts.ArenaCompliance = compliance.contract;
  info("ArenaCompliance", compliance.address);

  // ─────────────────────────────────────────────────
  // STEP 13: Deploy ArenaProfiles
  // ─────────────────────────────────────────────────
  step(13, "Deploying ArenaProfiles...");
  const profiles = await deployContract("ArenaProfiles", [coreMain.address]);
  addresses.ArenaProfiles = profiles.address;
  contracts.ArenaProfiles = profiles.contract;
  info("ArenaProfiles", profiles.address);

  // ─────────────────────────────────────────────────
  // STEP 14: Deploy ArenaRecurring
  // ─────────────────────────────────────────────────
  step(14, "Deploying ArenaRecurring...");
  const recurring = await deployContract("ArenaRecurring", [coreMain.address]);
  addresses.ArenaRecurring = recurring.address;
  contracts.ArenaRecurring = recurring.contract;
  info("ArenaRecurring", recurring.address);

  // ─────────────────────────────────────────────────
  // STEP 15: Deploy ArenaTimelock
  // ─────────────────────────────────────────────────
  step(15, "Deploying ArenaTimelock...");
  const timelock = await deployContract("ArenaTimelock");
  addresses.ArenaTimelock = timelock.address;
  contracts.ArenaTimelock = timelock.contract;
  info("ArenaTimelock", timelock.address);

  // ═══════════════════════════════════════════════════
  // LINK CORE CONTRACTS
  // ═══════════════════════════════════════════════════
  banner("LINKING CORE CONTRACTS");

  link(1, "ArenaCoreMain.setArenaCoreAuction()");
  let tx = await contracts.ArenaCoreMain.setArenaCoreAuction(addresses.ArenaCoreAuction);
  await tx.wait();
  info("Status", "✓ ArenaCoreAuction linked to Main");

  link(2, "ArenaCoreMain.setArenaCoreVRF()");
  tx = await contracts.ArenaCoreMain.setArenaCoreVRF(addresses.ArenaCoreVRF);
  await tx.wait();
  info("Status", "✓ ArenaCoreVRF linked to Main");

  link(3, "ArenaCoreAuction.setArenaCoreVRF()");
  tx = await contracts.ArenaCoreAuction.setArenaCoreVRF(addresses.ArenaCoreVRF);
  await tx.wait();
  info("Status", "✓ ArenaCoreVRF linked to Auction");

  // ═══════════════════════════════════════════════════
  // LINK SATELLITES TO ARENACOREMAIN
  // ═══════════════════════════════════════════════════
  banner("LINKING SATELLITES");

  link(4, "ArenaCoreMain.setArenaArbitration()");
  tx = await contracts.ArenaCoreMain.setArenaArbitration(addresses.ArenaArbitration);
  await tx.wait();
  info("Status", "✓ ArenaArbitration linked");

  link(5, "ArenaCoreMain.setArenaOutcomes()");
  tx = await contracts.ArenaCoreMain.setArenaOutcomes(addresses.ArenaOutcomes);
  await tx.wait();
  info("Status", "✓ ArenaOutcomes linked");

  link(6, "ArenaCoreMain.setArenaCompliance()");
  tx = await contracts.ArenaCoreMain.setArenaCompliance(addresses.ArenaCompliance);
  await tx.wait();
  info("Status", "✓ ArenaCompliance linked");

  link(7, "ArenaArbitration.setArenaContinuous()");
  tx = await contracts.ArenaArbitration.setArenaContinuous(addresses.ArenaContinuous);
  await tx.wait();
  info("Status", "✓ ArenaContinuous linked to Arbitration");

  // ═══════════════════════════════════════════════════
  // WHITELIST USDC AS STABLECOIN
  // ═══════════════════════════════════════════════════
  banner("WHITELISTING TOKENS");

  console.log("  Whitelisting MockUSDC as stablecoin...");
  tx = await contracts.ArenaCoreMain.whitelistToken(
    addresses.MockUSDC,
    true,   // isStablecoin = true
    false   // mevAck = false (not needed for stablecoins)
  );
  await tx.wait();
  info("Status", "✓ MockUSDC whitelisted (stablecoin, no MEV risk)");

  // ═══════════════════════════════════════════════════
  // TRANSFER OWNERSHIP TO TIMELOCK
  // ═══════════════════════════════════════════════════
  banner("OWNERSHIP TRANSFER TO TIMELOCK");

  const ownableContracts = [
    { name: "ArenaCoreMain", contract: contracts.ArenaCoreMain },
    { name: "ArenaCoreAuction", contract: contracts.ArenaCoreAuction },
    { name: "ArenaCoreVRF", contract: contracts.ArenaCoreVRF },
    { name: "ArenaContinuous", contract: contracts.ArenaContinuous },
    { name: "ArenaArbitration", contract: contracts.ArenaArbitration },
    { name: "ArenaReputation", contract: contracts.ArenaReputation },
    { name: "ArenaSyndicates", contract: contracts.ArenaSyndicates },
    { name: "ArenaInsurance", contract: contracts.ArenaInsurance },
    { name: "ArenaDelegation", contract: contracts.ArenaDelegation },
    { name: "ArenaOutcomes", contract: contracts.ArenaOutcomes },
    { name: "ArenaCompliance", contract: contracts.ArenaCompliance },
    { name: "ArenaProfiles", contract: contracts.ArenaProfiles },
    { name: "ArenaRecurring", contract: contracts.ArenaRecurring },
  ];

  for (const { name, contract } of ownableContracts) {
    tx = await contract.transferOwnership(addresses.ArenaTimelock);
    await tx.wait();
    info(name, `→ Timelock (${addresses.ArenaTimelock.slice(0, 10)}...)`);
  }
  console.log("\n  ✓ All 13 contracts now owned by ArenaTimelock");

  // ═══════════════════════════════════════════════════
  // SAVE DEPLOYMENT ADDRESSES
  // ═══════════════════════════════════════════════════
  banner("SAVING DEPLOYMENT");

  const deployment = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: addresses,
    linking: {
      "ArenaCoreMain.arenaCoreAuction": addresses.ArenaCoreAuction,
      "ArenaCoreMain.arenaCoreVRF": addresses.ArenaCoreVRF,
      "ArenaCoreAuction.arenaCoreVRF": addresses.ArenaCoreVRF,
      "ArenaCoreMain.arenaArbitration": addresses.ArenaArbitration,
      "ArenaCoreMain.arenaOutcomes": addresses.ArenaOutcomes,
      "ArenaCoreMain.arenaCompliance": addresses.ArenaCompliance,
      "ArenaArbitration.arenaContinuous": addresses.ArenaContinuous,
    },
    tokenWhitelist: {
      MockUSDC: {
        address: addresses.MockUSDC,
        isStablecoin: true,
        hasMevRisk: false,
      },
    },
    ownership: {
      timelockOwner: deployer.address,
      contractsOwnedByTimelock: ownableContracts.map((c) => c.name),
    },
  };

  saveDeployment(deployment);

  // ═══════════════════════════════════════════════════
  // BASESCAN VERIFICATION
  // ═══════════════════════════════════════════════════
  if (
    hre.network.name !== "hardhat" &&
    hre.network.name !== "localhost" &&
    process.env.SKIP_VERIFY !== "true"
  ) {
    banner("BASESCAN VERIFICATION");
    console.log(`  Waiting ${DEPLOY_CONFIG.VERIFY_DELAY_MS / 1000}s for block propagation...\n`);
    await new Promise((r) => setTimeout(r, DEPLOY_CONFIG.VERIFY_DELAY_MS));

    const verifications = [
      { name: "MockUSDC", address: addresses.MockUSDC, args: [] },
      { name: "ArenaCoreMain", address: addresses.ArenaCoreMain, args: [addresses.MockUSDC] },
      { name: "ArenaCoreAuction", address: addresses.ArenaCoreAuction, args: [addresses.ArenaCoreMain] },
      { name: "ArenaCoreVRF", address: addresses.ArenaCoreVRF, args: [addresses.ArenaCoreMain, addresses.ArenaCoreAuction] },
      { name: "ArenaContinuous", address: addresses.ArenaContinuous, args: [addresses.ArenaCoreMain] },
      { name: "ArenaArbitration", address: addresses.ArenaArbitration, args: [addresses.ArenaCoreMain] },
      { name: "ArenaReputation", address: addresses.ArenaReputation, args: [addresses.ArenaCoreMain] },
      { name: "ArenaSyndicates", address: addresses.ArenaSyndicates, args: [addresses.ArenaCoreMain] },
      { name: "ArenaInsurance", address: addresses.ArenaInsurance, args: [addresses.ArenaCoreMain] },
      { name: "ArenaDelegation", address: addresses.ArenaDelegation, args: [addresses.ArenaCoreMain] },
      { name: "ArenaOutcomes", address: addresses.ArenaOutcomes, args: [addresses.ArenaCoreMain] },
      { name: "ArenaCompliance", address: addresses.ArenaCompliance, args: [addresses.ArenaCoreMain] },
      { name: "ArenaProfiles", address: addresses.ArenaProfiles, args: [addresses.ArenaCoreMain] },
      { name: "ArenaRecurring", address: addresses.ArenaRecurring, args: [addresses.ArenaCoreMain] },
      { name: "ArenaTimelock", address: addresses.ArenaTimelock, args: [] },
    ];

    for (const v of verifications) {
      console.log(`  Verifying ${v.name} at ${v.address}...`);
      await verifyContract(v.address, v.args);
    }
  }

  // ═══════════════════════════════════════════════════
  // DEPLOYMENT SUMMARY
  // ═══════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  banner("DEPLOYMENT COMPLETE");
  console.log("  Contract Addresses:");
  console.log("  ─────────────────────────────────────────────");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(22)} ${addr}`);
  }
  console.log("");
  console.log("  Core Links:");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  ArenaCoreMain → Auction    ✓`);
  console.log(`  ArenaCoreMain → VRF        ✓`);
  console.log(`  ArenaCoreAuction → VRF     ✓`);
  console.log("");
  console.log("  Satellite Links:");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  ArenaCoreMain → Arbitration    ✓`);
  console.log(`  ArenaCoreMain → Outcomes       ✓`);
  console.log(`  ArenaCoreMain → Compliance     ✓`);
  console.log(`  Arbitration → Continuous       ✓`);
  console.log("");
  console.log("  Token Whitelist:");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  MockUSDC (stablecoin)      ✓`);
  console.log("");
  console.log("  Ownership:");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  13 contracts → ArenaTimelock`);
  console.log(`  ArenaTimelock → Deployer (${deployer.address.slice(0, 10)}...)`);
  console.log("");
  info("Total time", `${elapsed}s`);
  info("Deployment file", path.join(DEPLOY_CONFIG.OUTPUT_DIR, DEPLOY_CONFIG.OUTPUT_FILE));
  console.log("");
}

// ═══════════════════════════════════════════════════
// EXECUTE
// ═══════════════════════════════════════════════════

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n  ✗ DEPLOYMENT FAILED:");
    console.error(" ", error.message || error);
    process.exit(1);
  });

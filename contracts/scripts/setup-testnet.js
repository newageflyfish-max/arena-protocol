const hre = require("hardhat");

/**
 * One-command testnet setup for The Arena protocol.
 *
 * Deploys MockUSDC, deploys ArenaCoreMain + ArenaCoreAuction + ArenaCoreVRF,
 * mints test USDC, and creates sample tasks of different types and bounty sizes.
 *
 * Usage: npx hardhat run scripts/setup-testnet.js --network baseSepolia
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════");
  console.log("  THE ARENA — TESTNET SETUP");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Network:  ${hre.network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("═══════════════════════════════════════════════\n");

  // ───────────────────────────────────────────
  // 1. Deploy MockUSDC
  // ───────────────────────────────────────────
  console.log("[1/4] Deploying MockUSDC...");
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`  MockUSDC deployed: ${usdcAddress}`);

  // ───────────────────────────────────────────
  // 2. Deploy ArenaCoreMain + ArenaCoreAuction + ArenaCoreVRF
  // ───────────────────────────────────────────
  console.log("[2/4] Deploying ArenaCoreMain...");
  const ArenaCoreMain = await hre.ethers.getContractFactory("ArenaCoreMain");
  const arena = await ArenaCoreMain.deploy(usdcAddress);
  await arena.waitForDeployment();
  const arenaAddress = await arena.getAddress();
  console.log(`  ArenaCoreMain deployed: ${arenaAddress}`);

  console.log("       Deploying ArenaCoreAuction...");
  const ArenaCoreAuction = await hre.ethers.getContractFactory("ArenaCoreAuction");
  const auctionC = await ArenaCoreAuction.deploy(arenaAddress);
  await auctionC.waitForDeployment();
  const auctionAddress = await auctionC.getAddress();
  console.log(`  ArenaCoreAuction deployed: ${auctionAddress}`);

  console.log("       Deploying ArenaCoreVRF...");
  const ArenaCoreVRF = await hre.ethers.getContractFactory("ArenaCoreVRF");
  const vrfC = await ArenaCoreVRF.deploy(arenaAddress, auctionAddress);
  await vrfC.waitForDeployment();
  const vrfAddress = await vrfC.getAddress();
  console.log(`  ArenaCoreVRF deployed: ${vrfAddress}`);

  console.log("       Linking core contracts...");
  let linkTx = await arena.setArenaCoreAuction(auctionAddress);
  await linkTx.wait();
  linkTx = await arena.setArenaCoreVRF(vrfAddress);
  await linkTx.wait();
  linkTx = await auctionC.setArenaCoreVRF(vrfAddress);
  await linkTx.wait();
  console.log(`  Core contracts linked`);

  // ───────────────────────────────────────────
  // 3. Mint test USDC to test addresses
  // ───────────────────────────────────────────
  console.log("[3/4] Minting test USDC...");

  // 5 hardcoded test addresses (common Hardhat default accounts)
  const testAddresses = [
    deployer.address,
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  ];

  const mintAmount = hre.ethers.parseUnits("100000", 6); // 100,000 USDC each

  for (const addr of testAddresses) {
    await usdc.mint(addr, mintAmount);
    console.log(`  Minted 100,000 USDC to ${addr}`);
  }

  // ───────────────────────────────────────────
  // 4. Create 5 sample tasks
  // ───────────────────────────────────────────
  console.log("[4/4] Creating sample tasks...");

  // Approve ArenaCoreMain to spend deployer's USDC for task creation
  const totalBounty = hre.ethers.parseUnits("16000", 6); // Sum of all bounties
  await usdc.connect(deployer).approve(arenaAddress, totalBounty);

  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;

  const sampleTasks = [
    {
      bounty: hre.ethers.parseUnits("5000", 6),
      deadline: now + 7 * 86400,       // 7 days
      slashWindow: 14 * 86400,          // 14 days
      bidDuration: 3600,                 // 1 hour
      revealDuration: 1800,              // 30 min
      verifiers: 3,
      criteria: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Smart contract audit for DeFi lending protocol")),
      taskType: "audit",
    },
    {
      bounty: hre.ethers.parseUnits("2000", 6),
      deadline: now + 3 * 86400,       // 3 days
      slashWindow: 7 * 86400,           // 7 days
      bidDuration: 7200,                 // 2 hours
      revealDuration: 3600,              // 1 hour
      verifiers: 2,
      criteria: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Risk assessment for new vault strategy")),
      taskType: "risk_validation",
    },
    {
      bounty: hre.ethers.parseUnits("1000", 6),
      deadline: now + 2 * 86400,       // 2 days
      slashWindow: 5 * 86400,           // 5 days
      bidDuration: 1800,                 // 30 min
      revealDuration: 900,               // 15 min
      verifiers: 1,
      criteria: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Credit scoring model evaluation")),
      taskType: "credit_scoring",
    },
    {
      bounty: hre.ethers.parseUnits("7500", 6),
      deadline: now + 14 * 86400,      // 14 days
      slashWindow: 30 * 86400,          // 30 days
      bidDuration: 14400,                // 4 hours
      revealDuration: 7200,              // 2 hours
      verifiers: 5,
      criteria: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Full protocol security audit with formal verification")),
      taskType: "audit",
    },
    {
      bounty: hre.ethers.parseUnits("500", 6),
      deadline: now + 1 * 86400,       // 1 day
      slashWindow: 3 * 86400,           // 3 days
      bidDuration: 900,                  // 15 min
      revealDuration: 600,               // 10 min
      verifiers: 1,
      criteria: hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Oracle price feed validation")),
      taskType: "oracle_verification",
    },
  ];

  const taskIds = [];

  for (let i = 0; i < sampleTasks.length; i++) {
    const t = sampleTasks[i];
    const tx = await arena.connect(deployer).createTask(
      t.bounty,
      t.deadline,
      t.slashWindow,
      t.bidDuration,
      t.revealDuration,
      t.verifiers,
      t.criteria,
      t.taskType,
      hre.ethers.ZeroAddress
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return arena.interface.parseLog(l)?.name === "TaskCreated"; } catch { return false; }
    });
    const taskId = arena.interface.parseLog(event).args.taskId;
    taskIds.push(taskId);
    console.log(`  Task ${taskId}: ${t.taskType} — ${hre.ethers.formatUnits(t.bounty, 6)} USDC — ${t.verifiers} verifiers`);
  }

  // ───────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  TESTNET SETUP COMPLETE");
  console.log("═══════════════════════════════════════════════");
  console.log(`  MockUSDC:          ${usdcAddress}`);
  console.log(`  ArenaCoreMain:     ${arenaAddress}`);
  console.log(`  ArenaCoreAuction:  ${auctionAddress}`);
  console.log(`  ArenaCoreVRF:      ${vrfAddress}`);
  console.log(`  Network:           ${hre.network.name}`);
  console.log(`  Tasks:             ${taskIds.map(id => id.toString()).join(", ")}`);
  console.log(`  Test Addrs:        ${testAddresses.length} accounts with 100K USDC each`);
  console.log("═══════════════════════════════════════════════\n");

  // Output JSON for easy consumption
  console.log("// Copy-paste for .env or SDK config:");
  console.log(`ARENA_MAIN_ADDRESS=${arenaAddress}`);
  console.log(`ARENA_AUCTION_ADDRESS=${auctionAddress}`);
  console.log(`ARENA_VRF_ADDRESS=${vrfAddress}`);
  console.log(`USDC_ADDRESS=${usdcAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

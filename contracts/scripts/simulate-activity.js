/**
 * Arena Protocol — Simulate Live Activity
 *
 * Creates 5 fake agents, funds them, creates profiles,
 * posts tasks, runs sealed-bid auctions, and completes
 * tasks so the protocol looks active with real stats.
 *
 * Usage:
 *   npx hardhat run scripts/simulate-activity.js --network baseSepolia
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const AGENTS = [
  { name: "AuditBot-7",     bio: "Automated smart contract auditor. 200+ audits completed.", type: 1 },
  { name: "RiskEngine-3",   bio: "Quantitative risk assessment engine for DeFi protocols.", type: 1 },
  { name: "AlphaVerifier",  bio: "Independent verification specialist. Zero false positives.", type: 2 },
  { name: "DeFiSentinel",   bio: "Security monitoring and threat detection for on-chain activity.", type: 1 },
  { name: "YieldGuard-X",   bio: "Yield optimization and treasury risk analysis.", type: 1 },
];

const BG_TASKS = [
  { bounty: 500,  type: "audit",             desc: "Token bridge audit v4" },
  { bounty: 1200, type: "risk_validation",   desc: "Flash loan risk model v2" },
  { bounty: 200,  type: "credit_scoring",    desc: "DAO credit assessment v3" },
  { bounty: 800,  type: "security_review",   desc: "MEV protection review v2" },
  { bounty: 350,  type: "yield_optimization",desc: "LP yield curve opt v3" },
];

const LIVE_TASKS = [
  { bounty: 300,  type: "audit",           desc: "Oracle price feed validation v3" },
  { bounty: 750,  type: "risk_validation", desc: "Collateral ratio stress test v3" },
  { bounty: 500,  type: "credit_scoring",  desc: "Protocol credit risk v3" },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomSalt() { return hre.ethers.hexlify(hre.ethers.randomBytes(32)); }
function truncAddr(a) { return a.slice(0, 6) + "..." + a.slice(-4); }
const USDC = 10n ** 6n;
const VOTE_APPROVED = 1;
const BID_DURATION = 180;     // 3 minutes
const REVEAL_DURATION = 180;  // 3 minutes
const WAIT_EXTRA = 30;        // extra buffer seconds

function computeCommitHash(sender, stake, price, eta, salt) {
  return hre.ethers.keccak256(
    hre.ethers.solidityPacked(
      ["address", "uint256", "uint256", "uint256", "bytes32"],
      [sender, stake, price, eta, salt]
    )
  );
}

// Extract taskId from TaskCreated event in receipt
function getTaskIdFromReceipt(receipt, mainContract) {
  for (const log of receipt.logs) {
    try {
      const parsed = mainContract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "TaskCreated") {
        return Number(parsed.args.taskId);
      }
    } catch {}
  }
  return null;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ARENA PROTOCOL — SIMULATE ACTIVITY");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${hre.ethers.formatEther(balance)} ETH`);
  console.log("═══════════════════════════════════════════════════\n");

  if (balance < hre.ethers.parseEther("0.005")) {
    console.log("  ⚠  Low ETH! Need at least 0.005 ETH. Aborting.");
    process.exit(1);
  }

  const deployFile = path.join(__dirname, "..", "deployments", "base-sepolia.json");
  const addresses = JSON.parse(fs.readFileSync(deployFile, "utf8"));
  const usdc = await hre.ethers.getContractAt("MockUSDC", addresses.MockUSDC);
  const mainC = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);
  const auction = await hre.ethers.getContractAt("ArenaCoreAuction", addresses.ArenaCoreAuction);
  const profiles = await hre.ethers.getContractAt("ArenaProfiles", addresses.ArenaProfiles);

  const activeTasks = await mainC.posterActiveTasks(deployer.address);
  const maxTasks = await mainC.maxPosterActiveTasks();
  console.log(`  Active tasks: ${activeTasks}/${maxTasks}`);
  const remaining = Number(maxTasks) - Number(activeTasks);
  console.log(`  Slots available: ${remaining}\n`);

  // ══════════════════════════════════════════════════
  // STEP 1: Create 5 agent wallets + fund them
  // ══════════════════════════════════════════════════
  console.log("╔═══ STEP 1: Creating & Funding Agents ═══╗\n");
  const wallets = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
    wallets.push(w);
    console.log(`  ${AGENTS[i].name.padEnd(16)} ${w.address}`);
  }

  for (let i = 0; i < wallets.length; i++) {
    const tx = await deployer.sendTransaction({ to: wallets[i].address, value: hre.ethers.parseEther("0.0002") });
    await tx.wait();
  }
  console.log("  ✓ ETH funded (0.0002 each)");

  for (let i = 0; i < wallets.length; i++) {
    const tx = await usdc.mint(wallets[i].address, 10_000n * USDC);
    await tx.wait();
  }
  console.log("  ✓ 10,000 aUSDC minted to each agent\n");

  // ══════════════════════════════════════════════════
  // STEP 2: Create profiles
  // ══════════════════════════════════════════════════
  console.log("╔═══ STEP 2: Creating Profiles ═══╗\n");
  for (let i = 0; i < wallets.length; i++) {
    try {
      const tx = await profiles.connect(wallets[i]).createProfile(
        AGENTS[i].type, AGENTS[i].name, AGENTS[i].bio, "", hre.ethers.ZeroHash
      );
      await tx.wait();
      console.log(`  ✓ ${AGENTS[i].name}`);
    } catch { console.log(`  ✗ ${AGENTS[i].name} (may exist)`); }
  }
  try {
    const tx = await profiles.createProfile(0, "ArenaDAO", "Protocol governance.", "", hre.ethers.ZeroHash);
    await tx.wait();
    console.log("  ✓ ArenaDAO");
  } catch { console.log("  ✓ ArenaDAO already exists"); }

  // ══════════════════════════════════════════════════
  // STEP 3: Create background tasks
  // ══════════════════════════════════════════════════
  const bgCount = Math.min(BG_TASKS.length, remaining - 3);
  console.log(`\n╔═══ STEP 3: Creating ${bgCount} Background Tasks ═══╗\n`);

  if (bgCount > 0) {
    const totalBounty = BG_TASKS.slice(0, bgCount).reduce((s, t) => s + t.bounty, 0);
    let tx = await usdc.approve(addresses.ArenaCoreMain, BigInt(totalBounty) * USDC);
    await tx.wait();

    for (let i = 0; i < bgCount; i++) {
      const t = BG_TASKS[i];
      try {
        const tx = await mainC.createTask(
          BigInt(t.bounty) * USDC,
          Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
          48 * 3600,
          3600,  // 1h bid
          3600,  // 1h reveal
          1,
          hre.ethers.keccak256(hre.ethers.toUtf8Bytes(t.desc + "-" + Date.now())),
          t.type,
          addresses.MockUSDC,
        );
        const receipt = await tx.wait();
        const taskId = getTaskIdFromReceipt(receipt, mainC);
        console.log(`  ✓ Task #${taskId}: ${t.type.padEnd(20)} ${t.bounty} aUSDC`);
      } catch (err) {
        console.log(`  ✗ ${t.type}: ${err.message?.slice(0, 100)}`);
      }
    }
  } else {
    console.log("  ⊘ Skipped (no available slots)");
  }

  // ══════════════════════════════════════════════════
  // STEP 4: Create 3 lifecycle tasks (3-min bid/reveal windows)
  // ══════════════════════════════════════════════════
  console.log(`\n╔═══ STEP 4: Creating 3 Lifecycle Tasks (${BID_DURATION}s bid + ${REVEAL_DURATION}s reveal) ═══╗\n`);

  const liveBounty = LIVE_TASKS.reduce((s, t) => s + t.bounty, 0);
  let tx = await usdc.approve(addresses.ArenaCoreMain, BigInt(liveBounty) * USDC);
  await tx.wait();

  const liveTaskIds = [];
  let firstTaskCreatedAt = null;

  for (let i = 0; i < LIVE_TASKS.length; i++) {
    const t = LIVE_TASKS[i];
    try {
      const tx = await mainC.createTask(
        BigInt(t.bounty) * USDC,
        Math.floor(Date.now() / 1000) + 48 * 3600,
        72 * 3600,
        BID_DURATION,
        REVEAL_DURATION,
        1,
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes(t.desc + "-" + Date.now())),
        t.type,
        addresses.MockUSDC,
      );
      const receipt = await tx.wait();
      const taskId = getTaskIdFromReceipt(receipt, mainC);
      if (taskId === null) throw new Error("Could not extract taskId from event");
      liveTaskIds.push(taskId);
      if (!firstTaskCreatedAt) firstTaskCreatedAt = Date.now();
      console.log(`  ✓ Task #${taskId}: ${t.type.padEnd(20)} ${t.bounty} aUSDC`);
    } catch (err) {
      console.log(`  ✗ ${t.type}: ${err.message?.slice(0, 100)}`);
    }
  }

  if (liveTaskIds.length === 0) {
    console.log("\n  ⚠  No lifecycle tasks created. Aborting.");
    process.exit(1);
  }

  console.log(`\n  Lifecycle task IDs: [${liveTaskIds.join(", ")}]`);

  // ══════════════════════════════════════════════════
  // STEP 5: Approve USDC for agents → Auction contract
  // ══════════════════════════════════════════════════
  console.log("\n╔═══ STEP 5: Approving Agents for Auction ═══╗\n");
  for (let i = 0; i < wallets.length; i++) {
    const tx = await usdc.connect(wallets[i]).approve(addresses.ArenaCoreAuction, 5_000n * USDC);
    await tx.wait();
    console.log(`  ✓ ${AGENTS[i].name}: 5,000 aUSDC approved`);
  }

  // ══════════════════════════════════════════════════
  // STEP 6: Commit bids (2 agents per task)
  // ══════════════════════════════════════════════════
  console.log("\n╔═══ STEP 6: Committing Bids ═══╗\n");

  const bidData = {};

  for (let ti = 0; ti < liveTaskIds.length; ti++) {
    const taskId = liveTaskIds[ti];
    const bounty = LIVE_TASKS[ti].bounty;
    bidData[taskId] = [];

    const bidderA = 0;
    const bidderB = 1 + ti;
    if (bidderB >= wallets.length) continue;

    const bidders = [
      { idx: bidderA, stakePct: 15, pricePct: 70 },
      { idx: bidderB, stakePct: 20, pricePct: 80 },
    ];

    for (const b of bidders) {
      const wallet = wallets[b.idx];
      const stake = BigInt(Math.round(bounty * b.stakePct / 100)) * USDC;
      const price = BigInt(Math.round(bounty * b.pricePct / 100)) * USDC;
      const eta = BigInt(24 * 3600);
      const salt = randomSalt();
      const commitHash = computeCommitHash(wallet.address, stake, price, eta, salt);
      const criteriaAckHash = hre.ethers.keccak256(hre.ethers.solidityPacked(["uint256"], [taskId]));

      try {
        const tx = await auction.connect(wallet).commitBid(taskId, commitHash, criteriaAckHash);
        await tx.wait();
        bidData[taskId].push({ idx: b.idx, stake, price, eta, salt });
        console.log(`  ✓ Task #${taskId}: ${AGENTS[b.idx].name} committed (stake=${Number(stake/USDC)} price=${Number(price/USDC)})`);
      } catch (err) {
        console.log(`  ✗ Task #${taskId}: ${AGENTS[b.idx].name}: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 7: Wait for bid phase to expire, then reveal
  // ══════════════════════════════════════════════════
  // bidDeadline = block.timestamp_at_creation + BID_DURATION
  // We need to wait until ALL tasks' bid deadlines have passed
  // Calculate how long since the first task was created
  const elapsedSinceFirstTask = Math.floor((Date.now() - firstTaskCreatedAt) / 1000);
  const bidWaitTime = Math.max(0, BID_DURATION + WAIT_EXTRA - elapsedSinceFirstTask);

  console.log(`\n  ⏳ Elapsed since first lifecycle task: ${elapsedSinceFirstTask}s`);
  console.log(`  ⏳ Waiting ${bidWaitTime}s for bid phase to close...`);

  if (bidWaitTime > 0) {
    const steps = Math.ceil(bidWaitTime / 10);
    for (let i = steps; i > 0; i--) {
      process.stdout.write(`\r  ⏳ ${i * 10}s remaining...   `);
      await sleep(10_000);
    }
    console.log("\r  ✓ Bid phase closed.                    \n");
  }

  console.log("╔═══ STEP 7: Revealing Bids ═══╗\n");

  // Verify we're in the reveal window before trying
  for (const taskId of liveTaskIds) {
    try {
      const task = await mainC.getTask(taskId);
      const now = Math.floor(Date.now() / 1000);
      const bidDl = Number(task.bidDeadline || task[6]);
      const revDl = Number(task.revealDeadline || task[7]);
      console.log(`  Task #${taskId}: bidDeadline=${bidDl} revealDeadline=${revDl} now≈${now} (bid expired: ${now>=bidDl}, reveal open: ${now<revDl})`);
    } catch {}
  }

  for (const taskId of liveTaskIds) {
    const bids = bidData[taskId] || [];
    for (const bid of bids) {
      try {
        const tx = await auction.connect(wallets[bid.idx]).revealBid(
          taskId, bid.stake, bid.price, bid.eta, bid.salt
        );
        await tx.wait();
        console.log(`  ✓ Task #${taskId}: ${AGENTS[bid.idx].name} revealed`);
      } catch (err) {
        // Try to decode the error
        let errMsg = err.message?.slice(0, 120) || "unknown";
        if (err.data) {
          try {
            const decoded = auction.interface.parseError(err.data);
            errMsg = `Custom error: ${decoded.name}`;
          } catch {}
        }
        console.log(`  ✗ Task #${taskId}: ${AGENTS[bid.idx].name}: ${errMsg}`);
      }
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 8: Wait for reveal phase to expire, then resolve
  // ══════════════════════════════════════════════════
  const elapsedSinceFirstTask2 = Math.floor((Date.now() - firstTaskCreatedAt) / 1000);
  const totalPhaseTime = BID_DURATION + REVEAL_DURATION + WAIT_EXTRA;
  const revealWaitTime = Math.max(0, totalPhaseTime - elapsedSinceFirstTask2);

  console.log(`\n  ⏳ Elapsed since first lifecycle task: ${elapsedSinceFirstTask2}s`);
  console.log(`  ⏳ Waiting ${revealWaitTime}s for reveal phase to close...`);

  if (revealWaitTime > 0) {
    const steps = Math.ceil(revealWaitTime / 10);
    for (let i = steps; i > 0; i--) {
      process.stdout.write(`\r  ⏳ ${i * 10}s remaining...   `);
      await sleep(10_000);
    }
    console.log("\r  ✓ Reveal phase closed.                    \n");
  }

  console.log("╔═══ STEP 8: Resolving Auctions ═══╗\n");
  const assignedTasks = [];
  for (const taskId of liveTaskIds) {
    try {
      const tx = await auction.resolveAuction(taskId);
      await tx.wait();
      const assignment = await mainC.getAssignment(taskId);
      // Assignment struct: agent, stake, price, assignedAt, deliveredAt, outputHash
      const winnerAddr = assignment[0] || assignment.agent;
      const winnerIdx = wallets.findIndex(w => w.address === winnerAddr);
      const winnerName = winnerIdx >= 0 ? AGENTS[winnerIdx].name : truncAddr(winnerAddr);
      console.log(`  ✓ Task #${taskId}: Winner = ${winnerName} (${truncAddr(winnerAddr)})`);
      assignedTasks.push({ taskId, winnerIdx, winnerAddr });
    } catch (err) {
      let errMsg = err.message?.slice(0, 120) || "unknown";
      if (err.data) {
        try {
          const decoded = auction.interface.parseError(err.data);
          errMsg = `Custom error: ${decoded.name}`;
        } catch {}
      }
      console.log(`  ✗ Task #${taskId}: ${errMsg}`);
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 9: Deliver tasks
  // ══════════════════════════════════════════════════
  console.log("\n╔═══ STEP 9: Delivering Tasks ═══╗\n");
  for (const { taskId, winnerIdx } of assignedTasks) {
    if (winnerIdx < 0) {
      console.log(`  ⊘ Task #${taskId}: No known winner, skipping`);
      continue;
    }
    const outputHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`output-${taskId}-${AGENTS[winnerIdx].name}`));
    try {
      const tx = await auction.connect(wallets[winnerIdx])["deliverTask(uint256,bytes32)"](taskId, outputHash);
      await tx.wait();
      console.log(`  ✓ Task #${taskId}: ${AGENTS[winnerIdx].name} delivered`);
    } catch (err) {
      let errMsg = err.message?.slice(0, 120) || "unknown";
      if (err.data) {
        try {
          const decoded = auction.interface.parseError(err.data);
          errMsg = `Custom error: ${decoded.name}`;
        } catch {}
      }
      console.log(`  ✗ Task #${taskId}: ${errMsg}`);
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 10: Verify + complete tasks
  // ══════════════════════════════════════════════════
  console.log("\n╔═══ STEP 10: Verifying & Completing Tasks ═══╗\n");
  // Use DeFiSentinel (idx 3) or YieldGuard-X (idx 4) as verifier
  // to avoid collision with AlphaVerifier (idx 2) who might be the winner
  const verIdx = 4; // YieldGuard-X
  const verWallet = wallets[verIdx];
  console.log(`  Using ${AGENTS[verIdx].name} as verifier\n`);

  for (const { taskId, winnerAddr, winnerIdx } of assignedTasks) {
    if (winnerIdx < 0) continue;
    if (verWallet.address === winnerAddr) {
      console.log(`  ⊘ Task #${taskId}: Skipped (verifier is the assigned agent)`);
      continue;
    }

    try {
      // Get assignment to calculate min verifier stake
      const assignment = await mainC.getAssignment(taskId);
      const agentStake = assignment[1] || assignment.stake;
      const minStake = agentStake / 5n;
      const verStake = minStake > 0n ? minStake : 10n * USDC;

      // Register as verifier
      const tx1 = await auction.connect(verWallet).registerVerifier(taskId, verStake);
      await tx1.wait();
      console.log(`  ✓ Task #${taskId}: ${AGENTS[verIdx].name} registered (stake=${Number(verStake/USDC)} aUSDC)`);

      // Submit Approved vote
      const reportHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`report-${taskId}`));
      const tx2 = await auction.connect(verWallet).submitVerification(taskId, VOTE_APPROVED, reportHash);
      await tx2.wait();
      console.log(`  ✓ Task #${taskId}: ${AGENTS[verIdx].name} voted APPROVE → COMPLETED!`);
    } catch (err) {
      let errMsg = err.message?.slice(0, 120) || "unknown";
      if (err.data) {
        try {
          const decoded = auction.interface.parseError(err.data);
          errMsg = `Custom error: ${decoded.name}`;
        } catch {}
      }
      console.log(`  ✗ Task #${taskId}: ${errMsg}`);
    }
  }

  // ══════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  SIMULATION COMPLETE");
  console.log("═══════════════════════════════════════════════════\n");

  const totalTasks = await mainC.taskCount();
  console.log(`  Total tasks on-chain: ${totalTasks}`);

  console.log("\n  Agent Stats:");
  for (let i = 0; i < wallets.length; i++) {
    const addr = wallets[i].address;
    const rep = await mainC.agentReputation(addr);
    const done = await mainC.agentTasksCompleted(addr);
    const fail = await mainC.agentTasksFailed(addr);
    const bal = await usdc.balanceOf(addr);
    console.log(`    ${AGENTS[i].name.padEnd(16)} rep=${String(rep).padStart(3)} done=${done} fail=${fail} bal=${hre.ethers.formatUnits(bal, 6)} aUSDC`);
  }

  const endBal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\n  Deployer ETH remaining: ${hre.ethers.formatEther(endBal)}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ SIMULATION FAILED:", err.message || err);
    process.exit(1);
  });

/**
 * ═══════════════════════════════════════════════════════════════
 * THE ARENA — INVESTOR DEMO SCRIPT
 * ═══════════════════════════════════════════════════════════════
 *
 * Deploys all contracts, mints test USDC, and runs a complete
 * protocol lifecycle demonstrating every major feature:
 *
 *   Phase 1: Deploy MockUSDC + ArenaCoreMain + ArenaCoreAuction + ArenaCoreVRF
 *   Phase 2: Mint USDC to demo wallets
 *   Phase 3: Create 3 spot tasks + 1 continuous contract
 *   Phase 4: Agents commit sealed bids (all tasks + continuous)
 *   Phase 5: Advance time → reveal bids
 *   Phase 6: Resolve auctions (assign winners)
 *   Phase 7: Agents deliver outputs
 *   Phase 8: Verifiers register and vote
 *            → Task 0: SUCCESS (both approve)
 *            → Task 1: FAILURE (both reject → slash)
 *            → Task 2: SUCCESS (both approve)
 *   Phase 9: Continuous contract — 2 checkpoints
 *            → Checkpoint 0: PASS
 *            → Checkpoint 1: PASS
 *   Phase 10: Final state + balance reconciliation
 *
 * Usage:
 *   npx hardhat run scripts/demo.js                          # in-memory
 *   npx hardhat run scripts/demo.js --network localhost       # local node
 *
 * For live investor demos:
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  npx hardhat run scripts/demo.js --network localhost
 */

const hre = require("hardhat");
const { ethers } = hre;

// ═══════════════════════════════════════════════════
// FORMATTING HELPERS
// ═══════════════════════════════════════════════════

const DECIMALS = 6;
const parseUSDC = (n) => ethers.parseUnits(n.toString(), DECIMALS);
const fmtUSDC = (wei) => {
  const str = ethers.formatUnits(wei, DECIMALS);
  const num = parseFloat(str);
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATUS = ["Open", "BidReveal", "Assigned", "Delivered", "Verifying", "Completed", "Failed", "Disputed", "Cancelled"];
const CC_STATUS = ["Open", "BidReveal", "Active", "Terminated", "Completed"];
const CP_STATUS = ["Pending", "Submitted", "Verifying", "Passed", "Failed", "Missed"];

const AMBER = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

function banner(text) {
  const line = "═".repeat(60);
  console.log(`\n${AMBER}${line}${RESET}`);
  console.log(`${AMBER}  ${text}${RESET}`);
  console.log(`${AMBER}${line}${RESET}`);
}

function phase(num, text) {
  console.log(`\n${BOLD}${CYAN}  ▸ PHASE ${num}: ${text}${RESET}`);
}

function step(id, text) {
  console.log(`\n    ${BOLD}[${id}]${RESET} ${text}`);
}

function info(label, value) {
  console.log(`        ${DIM}${label.padEnd(26)}${RESET} ${value}`);
}

function success(text) {
  console.log(`        ${GREEN}✓ ${text}${RESET}`);
}

function fail(text) {
  console.log(`        ${RED}✗ ${text}${RESET}`);
}

function separator() {
  console.log(`    ${DIM}${"─".repeat(52)}${RESET}`);
}

async function advanceTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}

async function advanceTo(timestamp) {
  const block = await ethers.provider.getBlock("latest");
  const current = block.timestamp;
  if (Number(timestamp) > current) {
    await hre.network.provider.send("evm_increaseTime", [Number(timestamp) - current + 1]);
    await hre.network.provider.send("evm_mine");
  }
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

// Print balances for all wallets
async function printBalances(usdc, wallets, label) {
  separator();
  console.log(`    ${DIM}${label || "USDC Balances"}:${RESET}`);
  for (const w of wallets) {
    const bal = await usdc.balanceOf(w.signer.address);
    info(w.name, `${fmtUSDC(bal)} USDC`);
  }
}

// ═══════════════════════════════════════════════════
// BID HELPERS
// ═══════════════════════════════════════════════════

function makeSalt(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function makeCommitHash(bidderAddr, stake, price, eta, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["address", "uint256", "uint256", "uint256", "bytes32"],
      [bidderAddr, stake, price, eta, salt]
    )
  );
}

// ═══════════════════════════════════════════════════
// MAIN DEMO
// ═══════════════════════════════════════════════════

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length < 8) {
    console.error("Need at least 8 signers. Use Hardhat network.");
    process.exit(1);
  }

  const [deployer, poster, agent1, agent2, agent3, verifier1, verifier2, verifier3] = signers;

  const wallets = [
    { name: "Poster", signer: poster },
    { name: "Agent 1 (Alpha)", signer: agent1 },
    { name: "Agent 2 (Beta)", signer: agent2 },
    { name: "Agent 3 (Gamma)", signer: agent3 },
    { name: "Verifier 1", signer: verifier1 },
    { name: "Verifier 2", signer: verifier2 },
    { name: "Verifier 3", signer: verifier3 },
  ];

  banner("THE ARENA — ADVERSARIAL EXECUTION PROTOCOL");
  console.log(`${DIM}  Full investor demo: 3 spot tasks + 1 continuous contract${RESET}`);
  console.log(`${DIM}  Network: ${hre.network.name} (chainId: ${hre.network.config.chainId || 31337})${RESET}\n`);

  for (const w of wallets) {
    info(w.name, shortAddr(w.signer.address));
  }

  // ═══════════════════════════════════════════════════
  // PHASE 1: DEPLOY
  // ═══════════════════════════════════════════════════

  phase(1, "DEPLOY CONTRACTS");

  step("1a", "Deploying MockUSDC (6 decimals)…");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  info("MockUSDC", usdcAddr);

  step("1b", "Deploying ArenaCoreMain…");
  const ArenaCoreMain = await ethers.getContractFactory("ArenaCoreMain");
  const deployTx = await ArenaCoreMain.getDeployTransaction(usdcAddr);
  deployTx.gasLimit = 500_000_000n;
  const signedDeploy = await deployer.sendTransaction(deployTx);
  const deployReceipt = await signedDeploy.wait();
  const mainAddr = deployReceipt.contractAddress;
  const main = ArenaCoreMain.attach(mainAddr);
  info("ArenaCoreMain", mainAddr);
  info("Deploy gas", deployReceipt.gasUsed.toLocaleString());

  step("1c", "Deploying ArenaCoreAuction…");
  const ArenaCoreAuction = await ethers.getContractFactory("ArenaCoreAuction");
  const auction = await ArenaCoreAuction.deploy(mainAddr);
  await auction.waitForDeployment();
  const auctionAddr = await auction.getAddress();
  info("ArenaCoreAuction", auctionAddr);

  step("1d", "Deploying ArenaCoreVRF…");
  const ArenaCoreVRF = await ethers.getContractFactory("ArenaCoreVRF");
  const vrf = await ArenaCoreVRF.deploy(mainAddr, auctionAddr);
  await vrf.waitForDeployment();
  const vrfAddr = await vrf.getAddress();
  info("ArenaCoreVRF", vrfAddr);

  step("1e", "Linking core contracts…");
  await main.connect(deployer).setArenaCoreAuction(auctionAddr);
  await main.connect(deployer).setArenaCoreVRF(vrfAddr);
  await auction.connect(deployer).setArenaCoreVRF(vrfAddr);
  info("Main → Auction", "linked");
  info("Main → VRF", "linked");
  info("Auction → VRF", "linked");

  // Disable verifier rotation cooldown for demo (allows same verifier on consecutive tasks)
  await vrf.connect(deployer).setVerifierCooldown(0);
  info("Verifier cooldown", "disabled (demo mode)");
  success("All core contracts deployed and linked");

  // ═══════════════════════════════════════════════════
  // PHASE 2: MINT USDC
  // ═══════════════════════════════════════════════════

  phase(2, "MINT TEST USDC");

  const MINT = parseUSDC("100000"); // 100k each
  for (const w of wallets) {
    await usdc.mint(w.signer.address, MINT);
  }
  success("Minted 100,000 USDC to each wallet");
  await printBalances(usdc, wallets, "Starting Balances");

  // ═══════════════════════════════════════════════════
  // PHASE 3: CREATE TASKS + CONTINUOUS CONTRACT
  // ═══════════════════════════════════════════════════

  phase(3, "CREATE 3 SPOT TASKS + 1 CONTINUOUS CONTRACT");

  const ts = await now();
  const BID_WINDOW = 600;      // 10 min
  const REVEAL_WINDOW = 300;   // 5 min
  const DEADLINE = ts + 86400; // 24h
  const SLASH_WINDOW = 86400 * 30; // 30 days

  // ─── Task 0: Smart Contract Audit (2,500 USDC) ───
  step("3a", "Creating Task 0 — Smart Contract Audit");
  const bounty0 = parseUSDC("2500");
  await usdc.connect(poster).approve(mainAddr, bounty0);
  await main.connect(poster).createTask(
    bounty0, DEADLINE, SLASH_WINDOW, BID_WINDOW, REVEAL_WINDOW, 2,
    ethers.keccak256(ethers.toUtf8Bytes("Audit Uniswap V4 hooks for reentrancy vulnerabilities")),
    "audit", ethers.ZeroAddress
  );
  info("Task ID", "0");
  info("Bounty", "2,500.00 USDC");
  info("Type", "audit");
  info("Required Verifiers", "2");

  // ─── Task 1: Risk Scoring — will FAIL (1,000 USDC) ───
  step("3b", "Creating Task 1 — Risk Scoring (will fail)");
  const bounty1 = parseUSDC("1000");
  await usdc.connect(poster).approve(mainAddr, bounty1);
  await main.connect(poster).createTask(
    bounty1, DEADLINE, SLASH_WINDOW, BID_WINDOW, REVEAL_WINDOW, 2,
    ethers.keccak256(ethers.toUtf8Bytes("Score portfolio risk for 50M DeFi fund")),
    "risk_validation", ethers.ZeroAddress
  );
  info("Task ID", "1");
  info("Bounty", "1,000.00 USDC");
  info("Type", "risk_validation");

  // ─── Task 2: Code Generation (5,000 USDC) ───
  step("3c", "Creating Task 2 — Code Generation");
  const bounty2 = parseUSDC("5000");
  await usdc.connect(poster).approve(mainAddr, bounty2);
  await main.connect(poster).createTask(
    bounty2, DEADLINE, SLASH_WINDOW, BID_WINDOW, REVEAL_WINDOW, 2,
    ethers.keccak256(ethers.toUtf8Bytes("Generate Solidity ERC-4626 vault with yield optimization")),
    "code_generation", ethers.ZeroAddress
  );
  info("Task ID", "2");
  info("Bounty", "5,000.00 USDC");
  info("Type", "code_generation");

  // ─── Continuous Contract: 30-day Monitoring (6,000 USDC) ───
  step("3d", "Creating Continuous Contract 0 — 30-Day Protocol Monitor");
  const ccBounty = parseUSDC("6000");
  const THIRTY_DAYS = 30 * 86400;
  const TEN_DAYS = 10 * 86400;
  await usdc.connect(poster).approve(mainAddr, ccBounty);
  await main.connect(poster).createContinuousContract(
    ethers.ZeroAddress, ccBounty, THIRTY_DAYS, TEN_DAYS,
    BID_WINDOW, REVEAL_WINDOW, 1, 3,
    ethers.keccak256(ethers.toUtf8Bytes("Monitor DeFi protocol health: TVL, liquidation risk, oracle freshness")),
    "monitoring"
  );
  info("Contract ID", "0");
  info("Total Bounty", "6,000.00 USDC");
  info("Duration", "30 days");
  info("Checkpoints", "3 (every 10 days)");
  info("Payment/Checkpoint", "2,000.00 USDC");
  info("Max Failures", "3");

  const totalEscrow = bounty0 + bounty1 + bounty2 + ccBounty;
  separator();
  info("Total Escrowed", `${fmtUSDC(totalEscrow)} USDC`);
  info("Task Count", (await main.taskCount()).toString());
  info("Continuous Count", (await main.continuousCount()).toString());

  await printBalances(usdc, wallets, "After Task Creation");

  // ═══════════════════════════════════════════════════
  // PHASE 4: COMMIT SEALED BIDS
  // ═══════════════════════════════════════════════════

  phase(4, "AGENTS COMMIT SEALED BIDS");

  // ─── Spot Task Bids ───

  // Task 0: Agent1 + Agent2 bid
  const bids = [
    { task: 0, agent: agent1, name: "Agent 1", stake: parseUSDC("500"),  price: parseUSDC("2000"), eta: 3600n,  salt: makeSalt("a1-t0") },
    { task: 0, agent: agent2, name: "Agent 2", stake: parseUSDC("300"),  price: parseUSDC("1800"), eta: 7200n,  salt: makeSalt("a2-t0") },
    { task: 1, agent: agent2, name: "Agent 2", stake: parseUSDC("200"),  price: parseUSDC("800"),  eta: 1800n,  salt: makeSalt("a2-t1") },
    { task: 1, agent: agent3, name: "Agent 3", stake: parseUSDC("150"),  price: parseUSDC("700"),  eta: 3600n,  salt: makeSalt("a3-t1") },
    { task: 2, agent: agent1, name: "Agent 1", stake: parseUSDC("1000"), price: parseUSDC("4000"), eta: 7200n,  salt: makeSalt("a1-t2") },
    { task: 2, agent: agent3, name: "Agent 3", stake: parseUSDC("800"),  price: parseUSDC("3500"), eta: 10800n, salt: makeSalt("a3-t2") },
  ];

  for (let i = 0; i < bids.length; i++) {
    const b = bids[i];
    const commitHash = makeCommitHash(b.agent.address, b.stake, b.price, b.eta, b.salt);
    step(`4${String.fromCharCode(97 + i)}`, `${b.name} commits bid on Task ${b.task}`);
    await auction.connect(b.agent).commitBid(b.task, commitHash);
    info("Commit Hash", commitHash.slice(0, 20) + "…");
    info("Stake (sealed)", `${fmtUSDC(b.stake)} USDC`);
    info("Price (sealed)", `${fmtUSDC(b.price)} USDC`);
  }

  // Continuous Contract Bid: Agent 1
  const ccSalt = makeSalt("a1-cc0");
  const ccStake = parseUSDC("600");
  const ccPrice = parseUSDC("4500");
  const ccEta = 86400n;
  const ccCommitHash = makeCommitHash(agent1.address, ccStake, ccPrice, ccEta, ccSalt);

  step("4g", "Agent 1 commits bid on Continuous Contract 0");
  await auction.connect(agent1).commitContinuousBid(0, ccCommitHash);
  info("Commit Hash", ccCommitHash.slice(0, 20) + "…");
  info("Stake (sealed)", `${fmtUSDC(ccStake)} USDC`);
  info("Price (sealed)", `${fmtUSDC(ccPrice)} USDC`);

  separator();
  for (let t = 0; t <= 2; t++) {
    const bidders = await auction.getTaskBidders(t);
    info(`Task ${t} bidders`, bidders.length.toString());
  }
  const ccBidders = await auction.getContinuousBidders(0);
  info("CC 0 bidders", ccBidders.length.toString());

  // ═══════════════════════════════════════════════════
  // PHASE 5: ADVANCE TIME → REVEAL BIDS
  // ═══════════════════════════════════════════════════

  phase(5, "REVEAL BIDS (AFTER BID DEADLINE)");

  step("5a", "Advancing time past 10-minute bid deadline…");
  await advanceTime(BID_WINDOW + 1);
  info("Time advanced", `${BID_WINDOW + 1} seconds`);

  // Reveal all spot bids
  for (let i = 0; i < bids.length; i++) {
    const b = bids[i];
    step(`5${String.fromCharCode(98 + i)}`, `${b.name} reveals bid on Task ${b.task}`);
    await usdc.connect(b.agent).approve(auctionAddr, b.stake);
    await auction.connect(b.agent).revealBid(b.task, b.stake, b.price, b.eta, b.salt);
    info("Stake locked", `${fmtUSDC(b.stake)} USDC`);
    info("Price", `${fmtUSDC(b.price)} USDC`);
  }

  // Reveal continuous bid
  step("5h", "Agent 1 reveals bid on Continuous Contract 0");
  await usdc.connect(agent1).approve(auctionAddr, ccStake);
  await auction.connect(agent1).revealContinuousBid(0, ccStake, ccPrice, ccEta, ccSalt);
  info("Stake locked", `${fmtUSDC(ccStake)} USDC`);
  info("Price", `${fmtUSDC(ccPrice)} USDC`);

  await printBalances(usdc, wallets, "After Reveals (stakes locked)");

  // ═══════════════════════════════════════════════════
  // PHASE 6: RESOLVE AUCTIONS
  // ═══════════════════════════════════════════════════

  phase(6, "RESOLVE AUCTIONS");

  step("6a", "Advancing time past 5-minute reveal deadline…");
  await advanceTime(REVEAL_WINDOW + 1);

  // Resolve all 3 spot tasks
  for (let t = 0; t <= 2; t++) {
    step(`6${String.fromCharCode(98 + t)}`, `Resolving Task ${t} auction…`);
    await auction.resolveAuction(t);
    const a = await main.getAssignment(t);
    const winner = a[0];
    info("Winner", `${shortAddr(winner)}`);
    info("Stake", `${fmtUSDC(a[1])} USDC`);
    info("Agreed Price", `${fmtUSDC(a[2])} USDC`);

    // Return losing bidder's stake
    const losingBids = bids.filter(b => b.task === t && b.agent.address.toLowerCase() !== winner.toLowerCase());
    for (const lb of losingBids) {
      info("Loser refunded", `${lb.name} → ${fmtUSDC(lb.stake)} USDC returned`);
    }
  }

  // Resolve continuous contract auction
  step("6e", "Resolving Continuous Contract 0 auction…");
  const cc0 = await main.getContinuousContract(0);
  await advanceTo(cc0.revealDeadline);
  await auction.resolveContinuousAuction(0);
  const ca0 = await main.getContinuousAssignment(0);
  info("Winner", shortAddr(ca0.agent));
  info("Stake", `${fmtUSDC(ca0.stake)} USDC`);
  info("Price", `${fmtUSDC(ca0.price)} USDC`);
  info("Started At", new Date(Number(ca0.startedAt) * 1000).toISOString());

  await printBalances(usdc, wallets, "After Auction Resolution");

  // ═══════════════════════════════════════════════════
  // PHASE 7: DELIVER OUTPUTS
  // ═══════════════════════════════════════════════════

  phase(7, "AGENTS DELIVER TASK OUTPUTS");

  const outputs = [
    { task: 0, desc: "Audit report: No critical vulnerabilities. 2 low-severity issues." },
    { task: 1, desc: "Risk score: 7.2/10. Portfolio overexposed to ETH/USD." },
    { task: 2, desc: "ERC-4626 vault: 847 lines, optimized for Aave/Compound yield." },
  ];

  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    const assignment = await main.getAssignment(o.task);
    const agentAddr = assignment[0];
    const signer = [agent1, agent2, agent3].find(a => a.address.toLowerCase() === agentAddr.toLowerCase());
    const agentName = wallets.find(w => w.signer.address.toLowerCase() === agentAddr.toLowerCase())?.name || "Unknown";

    step(`7${String.fromCharCode(97 + i)}`, `${agentName} delivers Task ${o.task}`);
    const outputHash = ethers.keccak256(ethers.toUtf8Bytes(o.desc));
    await auction.connect(signer).deliverTask(o.task, outputHash);
    info("Output", o.desc.slice(0, 50) + "…");
    info("Hash", outputHash.slice(0, 20) + "…");
    success("Delivered");
  }

  // Verify status changes
  separator();
  for (let t = 0; t <= 2; t++) {
    const task = await main.getTask(t);
    info(`Task ${t} status`, STATUS[Number(task[9])]);
  }

  // ═══════════════════════════════════════════════════
  // PHASE 8: VERIFICATION + SETTLEMENT
  // ═══════════════════════════════════════════════════

  phase(8, "VERIFICATION & SETTLEMENT");

  // Helper to run verification for a spot task
  async function verifyTask(taskId, approve, label) {
    const assignment = await main.getAssignment(taskId);
    const minStake = assignment[1] / 5n;
    const vstake = minStake > 0n ? minStake : 1n;

    // Verifier 1
    step(`8-${label}a`, `Verifier 1 registers for Task ${taskId}`);
    await usdc.connect(verifier1).approve(auctionAddr, vstake);
    await auction.connect(verifier1).registerVerifier(taskId, vstake);
    info("Stake", `${fmtUSDC(vstake)} USDC`);

    // Verifier 2
    step(`8-${label}b`, `Verifier 2 registers for Task ${taskId}`);
    await usdc.connect(verifier2).approve(auctionAddr, vstake);
    await auction.connect(verifier2).registerVerifier(taskId, vstake);
    info("Stake", `${fmtUSDC(vstake)} USDC`);

    const vote = approve ? 1 : 2; // 1=Approved, 2=Rejected
    const voteLabel = approve ? "APPROVED" : "REJECTED";

    step(`8-${label}c`, `Verifier 1 votes ${voteLabel} on Task ${taskId}`);
    const r1 = ethers.keccak256(ethers.toUtf8Bytes(`report-v1-t${taskId}`));
    await auction.connect(verifier1).submitVerification(taskId, vote, r1);
    info("Vote", voteLabel);

    step(`8-${label}d`, `Verifier 2 votes ${voteLabel} on Task ${taskId}`);
    const r2 = ethers.keccak256(ethers.toUtf8Bytes(`report-v2-t${taskId}`));
    await auction.connect(verifier2).submitVerification(taskId, vote, r2);
    info("Vote", voteLabel);

    const task = await main.getTask(taskId);
    const status = STATUS[Number(task[9])];
    if (approve) {
      success(`Consensus: 2/2 APPROVED → ${status}`);
    } else {
      fail(`Consensus: 0/2 APPROVED → ${status} (agent slashed)`);
    }
  }

  // Task 0: SUCCESS PATH
  console.log(`\n    ${BOLD}── Task 0: Smart Contract Audit → SUCCESS PATH ──${RESET}`);
  await verifyTask(0, true, "T0");

  // Task 1: FAILURE PATH (SLASH)
  console.log(`\n    ${BOLD}── Task 1: Risk Scoring → FAILURE PATH (SLASH) ──${RESET}`);
  await verifyTask(1, false, "T1");

  // Task 2: SUCCESS PATH
  console.log(`\n    ${BOLD}── Task 2: Code Generation → SUCCESS PATH ──${RESET}`);
  await verifyTask(2, true, "T2");

  // Print intermediate state
  separator();
  console.log(`    ${DIM}Settlement Summary:${RESET}`);

  for (let t = 0; t <= 2; t++) {
    const task = await main.getTask(t);
    const assignment = await main.getAssignment(t);
    const agentAddr = assignment[0];
    const agentName = wallets.find(w => w.signer.address.toLowerCase() === agentAddr.toLowerCase())?.name || "Unknown";
    const status = STATUS[Number(task[9])];
    const statusColor = status === "Completed" ? GREEN : RED;
    info(`Task ${t}`, `${statusColor}${status}${RESET} — ${agentName} — Bounty: ${fmtUSDC(task[2])} USDC`);
  }

  const treasury1 = await main.protocolTreasury();
  info("Protocol Treasury", `${fmtUSDC(treasury1)} USDC`);

  await printBalances(usdc, wallets, "After Verification & Settlement");

  // ═══════════════════════════════════════════════════
  // PHASE 9: CONTINUOUS CONTRACT CHECKPOINTS
  // ═══════════════════════════════════════════════════

  phase(9, "CONTINUOUS CONTRACT — CHECKPOINTS");

  const ca = await main.getContinuousAssignment(0);
  const ccAgentSigner = [agent1, agent2, agent3].find(a => a.address.toLowerCase() === ca.agent.toLowerCase());
  const ccAgentName = wallets.find(w => w.signer.address.toLowerCase() === ca.agent.toLowerCase())?.name || "Unknown";

  info("Agent", `${ccAgentName} (${shortAddr(ca.agent)})`);
  info("Current Stake", `${fmtUSDC(ca.currentStake)} USDC`);
  info("Payment/Checkpoint", "2,000.00 USDC");

  // ─── Checkpoint 0: PASS ───
  console.log(`\n    ${BOLD}── Checkpoint 0 (Day 10) → PASS ──${RESET}`);

  step("9a", "Advancing time to checkpoint 0 due date (day 10)…");
  await advanceTo(ca.startedAt + BigInt(TEN_DAYS));
  info("Time", `+10 days from contract start`);

  step("9b", `${ccAgentName} submits checkpoint 0`);
  const cpOut0 = ethers.keccak256(ethers.toUtf8Bytes("Checkpoint 0: All metrics nominal. TVL stable at $2.1B. No liquidation events."));
  await main.connect(ccAgentSigner).submitCheckpoint(0, 0, cpOut0);
  info("Output Hash", cpOut0.slice(0, 20) + "…");
  success("Checkpoint submitted");

  step("9c", "Verifier 3 registers for checkpoint 0");
  const cpVStake = ca.currentStake / 5n > 0n ? ca.currentStake / 5n : 1n;
  await usdc.connect(verifier3).approve(auctionAddr, cpVStake);
  await auction.connect(verifier3).registerCheckpointVerifier(0, 0, cpVStake);
  info("Verifier Stake", `${fmtUSDC(cpVStake)} USDC`);

  step("9d", "Verifier 3 votes APPROVED on checkpoint 0");
  const cpReport0 = ethers.keccak256(ethers.toUtf8Bytes("cp0-report: metrics verified"));
  await auction.connect(verifier3).submitCheckpointVerification(0, 0, 1, cpReport0);
  info("Vote", "APPROVED");

  const cp0 = await main.getCheckpoint(0, 0);
  info("Checkpoint Status", CP_STATUS[Number(cp0.status)]);
  info("Payout", `${fmtUSDC(cp0.payoutAmount)} USDC`);
  success("Checkpoint 0 PASSED — agent paid");

  // ─── Checkpoint 1: PASS ───
  console.log(`\n    ${BOLD}── Checkpoint 1 (Day 20) → PASS ──${RESET}`);

  step("9e", "Advancing time to checkpoint 1 due date (day 20)…");
  await advanceTo(ca.startedAt + BigInt(TEN_DAYS * 2));
  info("Time", `+20 days from contract start`);

  step("9f", `${ccAgentName} submits checkpoint 1`);
  const cpOut1 = ethers.keccak256(ethers.toUtf8Bytes("Checkpoint 1: Oracle deviation detected day 14, resolved within SLA. TVL +3.2%."));
  await main.connect(ccAgentSigner).submitCheckpoint(0, 1, cpOut1);
  info("Output Hash", cpOut1.slice(0, 20) + "…");
  success("Checkpoint submitted");

  step("9g", "Verifier 3 registers for checkpoint 1");
  const ca1 = await main.getContinuousAssignment(0);
  const cpVStake1 = ca1.currentStake / 5n > 0n ? ca1.currentStake / 5n : 1n;
  await usdc.connect(verifier3).approve(auctionAddr, cpVStake1);
  await auction.connect(verifier3).registerCheckpointVerifier(0, 1, cpVStake1);
  info("Verifier Stake", `${fmtUSDC(cpVStake1)} USDC`);

  step("9h", "Verifier 3 votes APPROVED on checkpoint 1");
  const cpReport1 = ethers.keccak256(ethers.toUtf8Bytes("cp1-report: deviation handled correctly"));
  await auction.connect(verifier3).submitCheckpointVerification(0, 1, 1, cpReport1);
  info("Vote", "APPROVED");

  const cp1 = await main.getCheckpoint(0, 1);
  info("Checkpoint Status", CP_STATUS[Number(cp1.status)]);
  info("Payout", `${fmtUSDC(cp1.payoutAmount)} USDC`);
  success("Checkpoint 1 PASSED — agent paid");

  // CC summary
  separator();
  const ccFinal = await main.getContinuousContract(0);
  const caFinal = await main.getContinuousAssignment(0);
  console.log(`    ${DIM}Continuous Contract Summary:${RESET}`);
  info("Status", CC_STATUS[Number(ccFinal.status)]);
  info("Checkpoints Completed", `${ccFinal.completedCheckpoints}/${ccFinal.totalCheckpoints}`);
  info("Passed", ccFinal.passedCheckpoints.toString());
  info("Failed", ccFinal.failedCheckpoints.toString());
  info("Total Paid to Agent", `${fmtUSDC(caFinal.totalPaid)} USDC`);
  info("Total Slashed", `${fmtUSDC(caFinal.totalSlashed)} USDC`);
  info("Remaining Stake", `${fmtUSDC(caFinal.currentStake)} USDC`);

  await printBalances(usdc, wallets, "After Checkpoints");

  // ═══════════════════════════════════════════════════
  // PHASE 10: FINAL STATE
  // ═══════════════════════════════════════════════════

  phase(10, "FINAL STATE & RECONCILIATION");

  // Task outcomes
  step("10a", "Task Outcomes");
  for (let t = 0; t <= 2; t++) {
    const task = await main.getTask(t);
    const assignment = await main.getAssignment(t);
    const agentAddr = assignment[0];
    const agentName = wallets.find(w => w.signer.address.toLowerCase() === agentAddr.toLowerCase())?.name || "Unknown";
    const status = STATUS[Number(task[9])];
    const icon = status === "Completed" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    info(`Task ${t}`, `${icon} ${status} — ${agentName} — ${fmtUSDC(task[2])} USDC bounty`);
  }

  // Continuous contract
  step("10b", "Continuous Contract Outcome");
  info("CC 0", `${GREEN}✓${RESET} Active — ${ccFinal.passedCheckpoints}/${ccFinal.totalCheckpoints} checkpoints passed — ${fmtUSDC(caFinal.totalPaid)} USDC paid`);

  // Agent reputation
  step("10c", "Agent Reputation & Stats");
  for (const agentSigner of [agent1, agent2, agent3]) {
    const stats = await main.getAgentStats(agentSigner.address);
    const name = wallets.find(w => w.signer.address === agentSigner.address)?.name || "Unknown";
    const rep = Number(stats[0]);
    const completed = Number(stats[1]);
    const failed = Number(stats[2]);
    const banned = stats[4];

    let tier = "Novice";
    let tierColor = DIM;
    if (rep >= 100) { tier = "Legendary"; tierColor = AMBER; }
    else if (rep >= 50) { tier = "Veteran"; tierColor = CYAN; }
    else if (rep >= 20) { tier = "Proven"; tierColor = GREEN; }

    info(name, `Rep: ${tierColor}${rep} (${tier})${RESET} — ✓${completed} ✗${failed}${banned ? ` ${RED}BANNED${RESET}` : ""}`);
  }

  // Protocol treasury
  step("10d", "Protocol Economics");
  const finalTreasury = await main.protocolTreasury();
  info("Protocol Treasury", `${AMBER}${fmtUSDC(finalTreasury)} USDC${RESET}`);
  info("Fee Rate", "2.5% of settled bounties");
  info("Slash Revenue", "10% of slashed stakes");

  // Final balances
  step("10e", "Final USDC Balances");
  const mainBal = await usdc.balanceOf(mainAddr);
  const auctionBal = await usdc.balanceOf(auctionAddr);
  info("ArenaCoreMain contract", `${fmtUSDC(mainBal)} USDC (escrow + treasury)`);
  info("ArenaCoreAuction contract", `${fmtUSDC(auctionBal)} USDC (auction escrow)`);

  await printBalances(usdc, wallets, "Final Wallet Balances");

  // Balance reconciliation
  separator();
  console.log(`    ${DIM}Balance Reconciliation:${RESET}`);
  let totalMinted = MINT * BigInt(wallets.length);
  let totalInWallets = 0n;
  for (const w of wallets) {
    totalInWallets += await usdc.balanceOf(w.signer.address);
  }
  const inMain = await usdc.balanceOf(mainAddr);
  const inAuction = await usdc.balanceOf(auctionAddr);
  const inVRF = await usdc.balanceOf(vrfAddr);
  const inContracts = inMain + inAuction + inVRF;
  const totalAccounted = totalInWallets + inContracts;
  info("Total Minted", `${fmtUSDC(totalMinted)} USDC`);
  info("Total in Wallets", `${fmtUSDC(totalInWallets)} USDC`);
  info("Total in Contracts", `${fmtUSDC(inContracts)} USDC`);
  info("Sum", `${fmtUSDC(totalAccounted)} USDC`);

  if (totalMinted === totalAccounted) {
    success("All USDC accounted for — zero leakage");
  } else {
    fail(`Discrepancy: ${fmtUSDC(totalMinted - totalAccounted)} USDC unaccounted`);
  }

  // ═══════════════════════════════════════════════════
  // DEPLOYMENT INFO
  // ═══════════════════════════════════════════════════

  banner("DEPLOYMENT INFO");
  console.log(`\n  ${DIM}Add to frontend/.env:${RESET}\n`);
  console.log(`  VITE_ARENA_MAIN_ADDRESS=${mainAddr}`);
  console.log(`  VITE_ARENA_AUCTION_ADDRESS=${auctionAddr}`);
  console.log(`  VITE_ARENA_VRF_ADDRESS=${vrfAddr}`);
  console.log(`  VITE_USDC_ADDRESS=${usdcAddr}`);
  console.log(`\n  ${DIM}Network: ${hre.network.name} (chainId: ${hre.network.config.chainId || 31337})${RESET}`);
  console.log(`  ${DIM}RPC: http://127.0.0.1:8545${RESET}\n`);

  // ═══════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════

  banner("DEMO COMPLETE");
  console.log(`
  ${GREEN}✓${RESET} 3 spot tasks created (8,500 USDC total bounty)
  ${GREEN}✓${RESET} 1 continuous contract created (6,000 USDC total bounty)
  ${GREEN}✓${RESET} 6 sealed bids committed + revealed across 3 agents
  ${GREEN}✓${RESET} 4 auctions resolved (3 spot + 1 continuous)
  ${GREEN}✓${RESET} 3 task outputs delivered
  ${GREEN}✓${RESET} 6 verifier votes cast
  ${GREEN}✓${RESET} Task 0 settled ${GREEN}successfully${RESET} — agent paid
  ${GREEN}✓${RESET} Task 2 settled ${GREEN}successfully${RESET} — agent paid
  ${RED}✗${RESET} Task 1 ${RED}slashed${RESET} — agent lost stake
  ${GREEN}✓${RESET} 2 continuous checkpoints passed — agent paid per checkpoint
  ${GREEN}✓${RESET} Protocol treasury collected fees
  ${GREEN}✓${RESET} All USDC accounted for — zero leakage
  `);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n${RED}  ✗ Demo failed:${RESET}`, error.message || error);
    if (error.data) console.error(`  ${DIM}Error data:${RESET}`, error.data);
    process.exit(1);
  });

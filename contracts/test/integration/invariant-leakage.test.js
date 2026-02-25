/**
 * Invariant Leakage Test
 *
 * Runs 20 tasks with varying bounties (100-5000 USDC), different agents
 * bidding on each, some completed successfully, some rejected, some expired.
 * After all tasks are processed, verifies zero-leakage: the sum of all
 * USDC across every contract address plus all user balances equals the
 * original total minted supply. No USDC created or destroyed.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Invariant: Zero USDC Leakage", function () {
  let main, auction, vrf, usdc;
  let owner, poster1, poster2;
  let agents;    // 5 agents
  let verifiers; // 3 verifiers
  let allSigners;

  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const BID_DURATION    = 3600;
  const REVEAL_DURATION = 1800;
  const DEADLINE_OFFSET = 86400;
  const SLASH_WINDOW    = 604800; // 7 days
  const CRITERIA_HASH   = ethers.keccak256(ethers.toUtf8Bytes("invariant criteria"));
  const TASK_TYPE       = "invariant";

  // Track total minted supply
  let totalMinted = 0n;

  function makeCommitHash(addr, stake, price, eta, salt) {
    return ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256", "bytes32"],
      [addr, stake, price, eta, salt]
    );
  }

  before(async function () {
    const signers = await ethers.getSigners();
    owner     = signers[0];
    poster1   = signers[1];
    poster2   = signers[2];
    agents    = signers.slice(3, 8);   // 5 agents
    verifiers = signers.slice(8, 11);  // 3 verifiers
    allSigners = [owner, poster1, poster2, ...agents, ...verifiers];

    // Deploy contracts
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const Main = await ethers.getContractFactory("ArenaCoreMain");
    const d1 = await Main.getDeployTransaction(await usdc.getAddress());
    d1.gasLimit = 500_000_000n;
    const r1 = await (await owner.sendTransaction(d1)).wait();
    main = Main.attach(r1.contractAddress);

    const Auction = await ethers.getContractFactory("ArenaCoreAuction");
    const d2 = await Auction.getDeployTransaction(await main.getAddress());
    d2.gasLimit = 500_000_000n;
    const r2 = await (await owner.sendTransaction(d2)).wait();
    auction = Auction.attach(r2.contractAddress);

    const VRF = await ethers.getContractFactory("ArenaCoreVRF");
    const d3 = await VRF.getDeployTransaction(await main.getAddress(), await auction.getAddress());
    d3.gasLimit = 500_000_000n;
    const r3 = await (await owner.sendTransaction(d3)).wait();
    vrf = VRF.attach(r3.contractAddress);

    // Link contracts
    await main.setArenaCoreAuction(await auction.getAddress());
    await main.setArenaCoreVRF(await vrf.getAddress());
    await auction.setArenaCoreVRF(await vrf.getAddress());

    // Disable verifier cooldown for test simplicity
    await vrf.setVerifierCooldown(0);
    await auction.setLocalVerifierCooldown(0); // M-04: also disable local cooldown

    const mainAddr    = await main.getAddress();
    const auctionAddr = await auction.getAddress();
    const vrfAddr     = await vrf.getAddress();

    // Mint USDC to all participants
    const mintAmount = USDC(500_000);
    for (const s of allSigners) {
      await usdc.mint(s.address, mintAmount);
      totalMinted += mintAmount;
      await usdc.connect(s).approve(mainAddr, ethers.MaxUint256);
      await usdc.connect(s).approve(auctionAddr, ethers.MaxUint256);
      await usdc.connect(s).approve(vrfAddr, ethers.MaxUint256);
    }
  });

  // ═══════════════════════════════════════════════════
  // Helper to get total USDC across all addresses
  // ═══════════════════════════════════════════════════
  async function getTotalUSDC() {
    const mainAddr    = await main.getAddress();
    const auctionAddr = await auction.getAddress();
    const vrfAddr     = await vrf.getAddress();

    let total = 0n;
    const balances = {};

    // Contract balances
    for (const [name, addr] of [["Main", mainAddr], ["Auction", auctionAddr], ["VRF", vrfAddr]]) {
      const bal = await usdc.balanceOf(addr);
      balances[name] = bal;
      total += bal;
    }

    // User balances
    for (let i = 0; i < allSigners.length; i++) {
      const bal = await usdc.balanceOf(allSigners[i].address);
      balances[`signer_${i}`] = bal;
      total += bal;
    }

    return { total, balances };
  }

  // ═══════════════════════════════════════════════════
  // Helper: run a single task through its full lifecycle
  // Each task is self-contained with fresh deadlines
  // ═══════════════════════════════════════════════════

  async function runTask(scenario, posterSigner) {
    const s = scenario;

    // Create task
    const deadline = (await time.latest()) + DEADLINE_OFFSET;
    const tx = await main.connect(posterSigner).createTask(
      USDC(s.bounty), deadline, SLASH_WINDOW, BID_DURATION, REVEAL_DURATION,
      1, CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
    );
    const receipt = await tx.wait();
    const log = receipt.logs.find(l => {
      try { return main.interface.parseLog(l)?.name === "TaskCreated"; } catch { return false; }
    });
    const taskId = main.interface.parseLog(log).args.taskId;

    if (s.outcome === "cancel") {
      // Cancel: submit 2 bids, reveal 1, then cancel while still Open
      const bidders = [agents[0], agents[1]];
      const minStake = USDC(s.bounty) / 10n + 1n;
      const bidStake = minStake > USDC(100) ? minStake : USDC(100);
      const bidPrice = USDC(s.bounty) / 2n;

      // Commit both bids
      for (let j = 0; j < bidders.length; j++) {
        const salt = ethers.id(`cancel-${s.id}-${j}-${taskId}`);
        const commitHash = makeCommitHash(bidders[j].address, bidStake, bidPrice, 3600, salt);
        await auction.connect(bidders[j]).commitBid(taskId, commitHash, CRITERIA_HASH);
      }

      // Cancel immediately while still Open (before reveal period)
      await main.connect(posterSigner).cancelTask(taskId);
      // Note: unrevealed bids don't hold stake on Auction (only committed hash)
      return taskId;
    }

    // Non-cancel outcomes: commit → reveal → resolve → ...
    const agent = agents[s.agent];
    const salt = ethers.id(`bid-${s.id}-${taskId}`);
    const commitHash = makeCommitHash(agent.address, USDC(s.stake), USDC(s.price), 3600, salt);
    await auction.connect(agent).commitBid(taskId, commitHash, CRITERIA_HASH);

    // Advance to reveal period
    const task = await main.getTask(taskId);
    await time.increaseTo(task.bidDeadline);

    // Reveal
    await auction.connect(agent).revealBid(taskId, USDC(s.stake), USDC(s.price), 3600, salt);

    // Advance past reveal deadline and resolve
    await time.increaseTo(task.revealDeadline);
    await auction.resolveAuction(taskId);

    if (s.outcome === "expire") {
      // Advance past deadline and enforce
      await time.increaseTo(task.deadline + 1n);
      await auction.connect(posterSigner).enforceDeadline(taskId);
      return taskId;
    }

    // Success or reject: deliver → verify → settle
    const outputHash = ethers.keccak256(ethers.toUtf8Bytes(`delivery-${s.id}`));
    await auction.connect(agent).deliverTask(taskId, outputHash);

    // Register verifier and vote
    const verifier = verifiers[s.id % verifiers.length];
    const assignment = await main.getAssignment(taskId);
    const vStake = assignment.stake / 5n > 0n ? assignment.stake / 5n : 1n;
    await auction.connect(verifier).registerVerifier(taskId, vStake);

    const vote = s.outcome === "success" ? 1 : 2; // 1=Approved, 2=Rejected
    const reportHash = ethers.keccak256(ethers.toUtf8Bytes(`report-${s.id}`));
    await auction.connect(verifier).submitVerification(taskId, vote, reportHash);

    return taskId;
  }

  // ═══════════════════════════════════════════════════
  // Task scenario definitions
  // 20 tasks with varying outcomes:
  //   - 8 completed successfully (majority approve)
  //   - 5 rejected (majority reject)
  //   - 4 expired (missed deadline)
  //   - 3 cancelled (poster cancels before resolution)
  // ═══════════════════════════════════════════════════

  const SCENARIOS = [
    // Successful completions (verifiers approve)
    { id: 0,  bounty: 1000, poster: 1, agent: 0, stake: 200,  price: 800,  outcome: "success" },
    { id: 1,  bounty: 2500, poster: 1, agent: 1, stake: 500,  price: 2000, outcome: "success" },
    { id: 2,  bounty: 500,  poster: 2, agent: 2, stake: 100,  price: 400,  outcome: "success" },
    { id: 3,  bounty: 5000, poster: 1, agent: 0, stake: 1000, price: 4000, outcome: "success" },
    { id: 4,  bounty: 100,  poster: 2, agent: 3, stake: 20,   price: 80,   outcome: "success" },
    { id: 5,  bounty: 3000, poster: 1, agent: 1, stake: 600,  price: 2500, outcome: "success" },
    { id: 6,  bounty: 750,  poster: 2, agent: 4, stake: 150,  price: 600,  outcome: "success" },
    { id: 7,  bounty: 1500, poster: 1, agent: 2, stake: 300,  price: 1200, outcome: "success" },

    // Rejected (verifiers reject → agent slashed, applies 72h cooldown)
    // Use same agents but process these LAST to avoid cooldown conflicts
    { id: 8,  bounty: 2000, poster: 1, agent: 3, stake: 400,  price: 1500, outcome: "reject" },
    { id: 9,  bounty: 800,  poster: 2, agent: 0, stake: 160,  price: 600,  outcome: "reject" },
    { id: 10, bounty: 4000, poster: 1, agent: 4, stake: 800,  price: 3500, outcome: "reject" },
    { id: 11, bounty: 300,  poster: 2, agent: 1, stake: 60,   price: 250,  outcome: "reject" },
    { id: 12, bounty: 1200, poster: 1, agent: 2, stake: 240,  price: 1000, outcome: "reject" },

    // Expired (missed deadline → enforceDeadline slash, applies cooldown for late)
    { id: 13, bounty: 1000, poster: 2, agent: 3, stake: 200,  price: 800,  outcome: "expire" },
    { id: 14, bounty: 3500, poster: 1, agent: 0, stake: 700,  price: 3000, outcome: "expire" },
    { id: 15, bounty: 600,  poster: 2, agent: 4, stake: 120,  price: 500,  outcome: "expire" },
    { id: 16, bounty: 2000, poster: 1, agent: 1, stake: 400,  price: 1600, outcome: "expire" },

    // Cancelled (poster cancels before auction resolves)
    { id: 17, bounty: 1500, poster: 1, agent: null, stake: 0, price: 0, outcome: "cancel" },
    { id: 18, bounty: 4500, poster: 2, agent: null, stake: 0, price: 0, outcome: "cancel" },
    { id: 19, bounty: 200,  poster: 1, agent: null, stake: 0, price: 0, outcome: "cancel" },
  ];

  // ═══════════════════════════════════════════════════
  // Verify supply is conserved at the very start
  // ═══════════════════════════════════════════════════

  it("initial USDC supply matches total minted", async function () {
    const { total } = await getTotalUSDC();
    expect(total).to.equal(totalMinted, "Initial supply mismatch");
  });

  // ═══════════════════════════════════════════════════
  // Run all 20 tasks through their full lifecycle
  // ═══════════════════════════════════════════════════

  it("processes 20 tasks with varying outcomes and zero leakage at every step", async function () {
    this.timeout(120000);

    const posters = { 1: poster1, 2: poster2 };
    const completedTaskIds = [];

    // Process tasks ordered by outcome to avoid cooldown conflicts:
    // 1. Success tasks (no cooldown applied)
    // 2. Cancel tasks (no agent involvement past commit)
    // 3. Expire tasks (Late slash = no cooldown if enforced within taskDuration)
    // 4. Reject tasks (Material slash = 72h cooldown, process last)
    const orderedScenarios = [
      ...SCENARIOS.filter(s => s.outcome === "success"),
      ...SCENARIOS.filter(s => s.outcome === "cancel"),
      ...SCENARIOS.filter(s => s.outcome === "expire"),
      ...SCENARIOS.filter(s => s.outcome === "reject"),
    ];

    for (const s of orderedScenarios) {
      const taskId = await runTask(s, posters[s.poster]);

      if (s.outcome === "success") {
        completedTaskIds.push({ taskId, agent: agents[s.agent] });
      }

      // Check zero-leakage after every single task
      const { total } = await getTotalUSDC();
      expect(total).to.equal(totalMinted,
        `Supply leaked after task ${s.id} (${s.outcome}, bounty=${s.bounty})`
      );
    }

    // ── Claim slash bonds for all completed tasks ──
    await time.increase(SLASH_WINDOW + 1);

    for (const { taskId, agent } of completedTaskIds) {
      const bond = await main.slashBonds(taskId);
      if (bond > 0n) {
        await main.connect(agent).claimSlashBond(taskId);
      }
    }

    // Final check after bond claims
    const { total } = await getTotalUSDC();
    expect(total).to.equal(totalMinted, "Supply leaked after slash bond claims");
  });

  // ═══════════════════════════════════════════════════
  // Final comprehensive check
  // ═══════════════════════════════════════════════════

  it("final zero-leakage: total USDC equals original minted supply", async function () {
    const { total, balances } = await getTotalUSDC();

    // Log balances for transparency
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║              ZERO-LEAKAGE INVARIANT REPORT                  ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total minted:     ${totalMinted.toString().padStart(20)} USDC (raw)  ║`);
    console.log(`║  Total accounted:  ${total.toString().padStart(20)} USDC (raw)  ║`);
    console.log(`║  Difference:       ${(total - totalMinted).toString().padStart(20)} USDC (raw)  ║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Main contract:    ${balances["Main"].toString().padStart(20)}             ║`);
    console.log(`║  Auction contract: ${balances["Auction"].toString().padStart(20)}             ║`);
    console.log(`║  VRF contract:     ${balances["VRF"].toString().padStart(20)}             ║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");

    let userTotal = 0n;
    for (let i = 0; i < allSigners.length; i++) {
      userTotal += balances[`signer_${i}`];
    }
    console.log(`║  User balances:    ${userTotal.toString().padStart(20)}             ║`);
    console.log(`║  Contract balance: ${(balances["Main"] + balances["Auction"] + balances["VRF"]).toString().padStart(20)}             ║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");

    // Task outcome summary
    const outcomes = { success: 0, reject: 0, expire: 0, cancel: 0 };
    for (const s of SCENARIOS) outcomes[s.outcome]++;
    console.log(`║  Tasks completed:  ${String(outcomes.success).padStart(2)} success, ${String(outcomes.reject).padStart(2)} reject, ${String(outcomes.expire).padStart(2)} expire, ${String(outcomes.cancel).padStart(2)} cancel  ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    expect(total).to.equal(totalMinted,
      `USDC leakage detected! Expected ${totalMinted}, got ${total}, diff = ${total - totalMinted}`
    );
  });

  // ═══════════════════════════════════════════════════
  // Verify no USDC stuck in contracts after all claims
  // ═══════════════════════════════════════════════════

  it("contract balances hold only protocol treasury (no stuck funds)", async function () {
    const mainAddr    = await main.getAddress();
    const auctionAddr = await auction.getAddress();
    const vrfAddr     = await vrf.getAddress();
    const usdcAddr    = await usdc.getAddress();

    const mainBal    = await usdc.balanceOf(mainAddr);
    const auctionBal = await usdc.balanceOf(auctionAddr);
    const vrfBal     = await usdc.balanceOf(vrfAddr);

    // Main should hold only the protocol treasury (all slash bonds claimed)
    const treasury = await main.protocolTreasury(usdcAddr);
    expect(mainBal).to.equal(treasury,
      `Main balance (${mainBal}) != protocol treasury (${treasury}). ` +
      `Difference of ${mainBal - treasury} stuck in contract.`
    );

    // Auction should hold 0 after all settlements
    expect(auctionBal).to.equal(0n,
      `Auction still holds ${auctionBal} USDC after all settlements`
    );

    // VRF should hold 0 (no verifiers in pool for this test)
    expect(vrfBal).to.equal(0n,
      `VRF still holds ${vrfBal} USDC after all settlements`
    );

    // Protocol treasury should be > 0 (fees were collected)
    expect(treasury).to.be.gt(0n, "Protocol treasury should have collected fees");
  });
});

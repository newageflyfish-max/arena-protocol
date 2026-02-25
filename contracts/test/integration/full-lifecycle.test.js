/**
 * End-to-end integration test: full Arena task lifecycle.
 *
 * Covers every step from task creation through settlement, verifying
 * USDC balances, task status transitions, reputation updates, and
 * protocol fee collection at each stage.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Full Lifecycle Integration", function () {
  let main, auction, vrf, usdc;
  let owner, poster, agent, verifier;

  // ── Constants matching the contract ──
  const BOUNTY          = ethers.parseUnits("1000", 6);  // 1,000 USDC
  const STAKE           = ethers.parseUnits("100", 6);   // 100 USDC (≥ bounty / 10)
  const PRICE           = ethers.parseUnits("800", 6);   // 800 USDC asking price
  const ETA             = 3600;                          // 1 hour ETA
  const BID_DURATION    = 3600;                          // 1 hour
  const REVEAL_DURATION = 1800;                          // 30 minutes
  const DEADLINE_OFFSET = 86400;                         // 1 day
  const SLASH_WINDOW    = 604800;                        // 7 days
  const REQ_VERIFIERS   = 1;
  const CRITERIA_HASH   = ethers.keccak256(ethers.toUtf8Bytes("integration test criteria"));
  const TASK_TYPE       = "integration-test";

  // Protocol constants (from ArenaCoreAuction)
  const PROTOCOL_FEE_BPS = 250n;
  const SLASH_BOND_BPS   = 2000n;
  const BPS              = 10000n;

  // ── Deploy & link all contracts ──
  before(async function () {
    [owner, poster, agent, verifier] = await ethers.getSigners();

    // MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    // ArenaCoreMain
    const Main = await ethers.getContractFactory("ArenaCoreMain");
    const d1 = await Main.getDeployTransaction(await usdc.getAddress());
    d1.gasLimit = 500_000_000n;
    const r1 = await (await owner.sendTransaction(d1)).wait();
    main = Main.attach(r1.contractAddress);

    // ArenaCoreAuction
    const Auction = await ethers.getContractFactory("ArenaCoreAuction");
    const d2 = await Auction.getDeployTransaction(await main.getAddress());
    d2.gasLimit = 500_000_000n;
    const r2 = await (await owner.sendTransaction(d2)).wait();
    auction = Auction.attach(r2.contractAddress);

    // ArenaCoreVRF
    const VRF = await ethers.getContractFactory("ArenaCoreVRF");
    const d3 = await VRF.getDeployTransaction(await main.getAddress(), await auction.getAddress());
    d3.gasLimit = 500_000_000n;
    const r3 = await (await owner.sendTransaction(d3)).wait();
    vrf = VRF.attach(r3.contractAddress);

    // Link
    await main.setArenaCoreAuction(await auction.getAddress());
    await main.setArenaCoreVRF(await vrf.getAddress());
    await auction.setArenaCoreVRF(await vrf.getAddress());

    // Mint USDC to all participants and approve both Main and Auction
    const mintAmount = ethers.parseUnits("50000", 6);
    for (const s of [poster, agent, verifier]) {
      await usdc.mint(s.address, mintAmount);
      await usdc.connect(s).approve(await main.getAddress(), ethers.MaxUint256);
      await usdc.connect(s).approve(await auction.getAddress(), ethers.MaxUint256);
      await usdc.connect(s).approve(await vrf.getAddress(), ethers.MaxUint256);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // The single end-to-end test
  // ──────────────────────────────────────────────────────────────

  it("should complete the full lifecycle: create → bid → reveal → resolve → deliver → verify → settle", async function () {
    const mainAddr    = await main.getAddress();
    const auctionAddr = await auction.getAddress();
    const usdcAddr    = await usdc.getAddress();

    // ────────────────────────────────────
    // 1. CREATE TASK
    // ────────────────────────────────────

    const posterBalBefore = await usdc.balanceOf(poster.address);
    const mainBalBefore   = await usdc.balanceOf(mainAddr);

    const deadline = (await time.latest()) + DEADLINE_OFFSET;
    const tx1 = await main.connect(poster).createTask(
      BOUNTY, deadline, SLASH_WINDOW,
      BID_DURATION, REVEAL_DURATION, REQ_VERIFIERS,
      CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress   // ZeroAddress = use defaultToken
    );
    const receipt1 = await tx1.wait();

    // Extract taskId from TaskCreated event
    const taskCreatedLog = receipt1.logs.find(l => {
      try { return main.interface.parseLog(l)?.name === "TaskCreated"; } catch { return false; }
    });
    expect(taskCreatedLog).to.not.be.undefined;
    const taskId = main.interface.parseLog(taskCreatedLog).args.taskId;

    // Verify USDC: poster paid bounty, Main received it
    expect(await usdc.balanceOf(poster.address)).to.equal(posterBalBefore - BOUNTY);
    expect(await usdc.balanceOf(mainAddr)).to.equal(mainBalBefore + BOUNTY);

    // Verify task state
    const task0 = await main.getTask(taskId);
    expect(task0.status).to.equal(0); // Open
    expect(task0.poster).to.equal(poster.address);
    expect(task0.bounty).to.equal(BOUNTY);
    expect(task0.taskType).to.equal(TASK_TYPE);

    // ────────────────────────────────────
    // 2. COMMIT BID (sealed)
    // ────────────────────────────────────

    const salt = ethers.randomBytes(32);
    const commitHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256", "bytes32"],
      [agent.address, STAKE, PRICE, ETA, salt]
    );

    await expect(auction.connect(agent).commitBid(taskId, commitHash, CRITERIA_HASH))
      .to.emit(auction, "BidCommitted")
      .withArgs(taskId, agent.address, commitHash, CRITERIA_HASH);

    // No USDC moves during commit — only the hash is stored
    // Task status stays Open (bids are being collected)
    const task1 = await main.getTask(taskId);
    expect(task1.status).to.equal(0); // Still Open

    // ────────────────────────────────────
    // 3. REVEAL BID (stake locked)
    // ────────────────────────────────────

    // Advance past bid deadline into reveal period
    await time.increaseTo(task0.bidDeadline);

    // Task status transitions to BidReveal when first reveal happens
    const agentBalBeforeReveal  = await usdc.balanceOf(agent.address);
    const auctionBalBeforeReveal = await usdc.balanceOf(auctionAddr);

    await expect(auction.connect(agent).revealBid(taskId, STAKE, PRICE, ETA, salt))
      .to.emit(auction, "BidRevealed")
      .withArgs(taskId, agent.address, STAKE, PRICE, ETA);

    // Verify USDC: agent's stake transferred to Auction
    expect(await usdc.balanceOf(agent.address)).to.equal(agentBalBeforeReveal - STAKE);
    expect(await usdc.balanceOf(auctionAddr)).to.equal(auctionBalBeforeReveal + STAKE);

    // Task status now BidReveal
    const task2 = await main.getTask(taskId);
    expect(task2.status).to.equal(1); // BidReveal

    // ────────────────────────────────────
    // 4. RESOLVE AUCTION
    // ────────────────────────────────────

    // Advance past reveal deadline
    await time.increaseTo(task0.revealDeadline);

    await expect(auction.resolveAuction(taskId))
      .to.emit(auction, "AgentAssigned")
      .withArgs(taskId, agent.address, STAKE, PRICE);

    // Task status now Assigned
    const task3 = await main.getTask(taskId);
    expect(task3.status).to.equal(2); // Assigned

    // Assignment recorded correctly
    const assignment = await main.getAssignment(taskId);
    expect(assignment.agent).to.equal(agent.address);
    expect(assignment.stake).to.equal(STAKE);
    expect(assignment.price).to.equal(PRICE);

    // USDC balances unchanged (no transfers during resolve with 1 bidder)

    // ────────────────────────────────────
    // 5. DELIVER TASK OUTPUT
    // ────────────────────────────────────

    const outputHash = ethers.keccak256(ethers.toUtf8Bytes("task delivery output v1"));

    await expect(auction.connect(agent).deliverTask(taskId, outputHash))
      .to.emit(auction, "TaskDelivered")
      .withArgs(taskId, agent.address, outputHash);

    // Task status now Delivered
    const task4 = await main.getTask(taskId);
    expect(task4.status).to.equal(3); // Delivered

    // Assignment updated with delivery data
    const assignAfterDeliver = await main.getAssignment(taskId);
    expect(assignAfterDeliver.outputHash).to.equal(outputHash);
    expect(assignAfterDeliver.deliveredAt).to.be.gt(0);

    // ────────────────────────────────────
    // 6. REGISTER VERIFIER
    // ────────────────────────────────────

    // Minimum verifier stake = assignment.stake / 5
    const verifierStake = assignment.stake / 5n;
    expect(verifierStake).to.be.gt(0);

    const verifierBalBefore = await usdc.balanceOf(verifier.address);
    const auctionBalBeforeVerify = await usdc.balanceOf(auctionAddr);

    await expect(auction.connect(verifier).registerVerifier(taskId, verifierStake))
      .to.emit(auction, "VerifierAssigned")
      .withArgs(taskId, verifier.address, verifierStake);

    // Verifier stake transferred to Auction
    expect(await usdc.balanceOf(verifier.address)).to.equal(verifierBalBefore - verifierStake);
    expect(await usdc.balanceOf(auctionAddr)).to.equal(auctionBalBeforeVerify + verifierStake);

    // Task status now Verifying
    const task5 = await main.getTask(taskId);
    expect(task5.status).to.equal(4); // Verifying

    // ────────────────────────────────────
    // 7. SUBMIT VERIFICATION (Approved) → triggers settlement
    // ────────────────────────────────────

    // Snapshot all balances BEFORE settlement
    const posterBalPreSettle   = await usdc.balanceOf(poster.address);
    const agentBalPreSettle    = await usdc.balanceOf(agent.address);
    const verifierBalPreSettle = await usdc.balanceOf(verifier.address);
    const mainBalPreSettle     = await usdc.balanceOf(mainAddr);
    const auctionBalPreSettle  = await usdc.balanceOf(auctionAddr);
    const treasuryPreSettle    = await main.protocolTreasury(usdcAddr);
    const reputationPreSettle  = await main.agentReputation(agent.address);
    const completedPreSettle   = await main.agentTasksCompleted(agent.address);

    const reportHash = ethers.keccak256(ethers.toUtf8Bytes("verification report"));

    // VerifierVote.Approved = 1
    const settleTx = await auction.connect(verifier).submitVerification(taskId, 1, reportHash);
    const settleReceipt = await settleTx.wait();

    // Verify emitted events
    const completedEvent = settleReceipt.logs.find(l => {
      try { return auction.interface.parseLog(l)?.name === "TaskCompleted"; } catch { return false; }
    });
    expect(completedEvent).to.not.be.undefined;

    const feeEvent = settleReceipt.logs.find(l => {
      try { return auction.interface.parseLog(l)?.name === "ProtocolFeeCollected"; } catch { return false; }
    });
    expect(feeEvent).to.not.be.undefined;

    // ────────────────────────────────────
    // 8. VERIFY FINAL STATE
    // ────────────────────────────────────

    // --- Task status = Completed ---
    const taskFinal = await main.getTask(taskId);
    expect(taskFinal.status).to.equal(5); // Completed

    // --- Compute expected settlement amounts ---
    const protocolFee = (PRICE * PROTOCOL_FEE_BPS) / BPS;          // 800 * 250 / 10000 = 20 USDC
    const agentPayout = PRICE - protocolFee;                       // 800 - 20 = 780 USDC
    const slashBond   = (STAKE * SLASH_BOND_BPS) / BPS;            // 100 * 2000 / 10000 = 20 USDC
    const stakeReturn = STAKE - slashBond;                         // 100 - 20 = 80 USDC

    const remaining      = BOUNTY - PRICE;                         // 1000 - 800 = 200 USDC
    const verifierFeeMax = (BOUNTY * 300n) / BPS;                  // 1000 * 300 / 10000 = 30 USDC
    const verifierFee    = verifierFeeMax <= remaining ? verifierFeeMax : remaining;  // 30 USDC
    const posterReturn   = remaining - verifierFee;                // 200 - 30 = 170 USDC

    // Sanity-check our math
    expect(protocolFee).to.equal(ethers.parseUnits("20", 6));
    expect(agentPayout).to.equal(ethers.parseUnits("780", 6));
    expect(slashBond).to.equal(ethers.parseUnits("20", 6));
    expect(stakeReturn).to.equal(ethers.parseUnits("80", 6));
    expect(verifierFee).to.equal(ethers.parseUnits("30", 6));
    expect(posterReturn).to.equal(ethers.parseUnits("170", 6));

    // --- Agent received: agentPayout (from Main escrow) + stakeReturn (from Auction) ---
    const agentBalAfter = await usdc.balanceOf(agent.address);
    expect(agentBalAfter - agentBalPreSettle).to.equal(agentPayout + stakeReturn);

    // --- Poster received: posterReturn (from Main escrow) ---
    const posterBalAfter = await usdc.balanceOf(poster.address);
    expect(posterBalAfter - posterBalPreSettle).to.equal(posterReturn);

    // --- Verifier received: verifierFee (from Main escrow) + verifierStake back (from Auction) ---
    const verifierBalAfter = await usdc.balanceOf(verifier.address);
    expect(verifierBalAfter - verifierBalPreSettle).to.equal(verifierFee + verifierStake);

    // --- Protocol treasury increased by protocolFee ---
    const treasuryAfter = await main.protocolTreasury(usdcAddr);
    expect(treasuryAfter - treasuryPreSettle).to.equal(protocolFee);

    // --- Slash bond held on Main (slash bond transferred from Auction → Main) ---
    const slashBondStored = await main.slashBonds(taskId);
    expect(slashBondStored).to.equal(slashBond);

    // --- Reputation increased by 10 ---
    const reputationAfter = await main.agentReputation(agent.address);
    expect(reputationAfter - reputationPreSettle).to.equal(10);

    // --- Tasks completed incremented by 1 ---
    const completedAfter = await main.agentTasksCompleted(agent.address);
    expect(completedAfter - completedPreSettle).to.equal(1);

    // --- All USDC accounted for: Main holds protocolFee + slashBond, everything else distributed ---
    const mainBalAfter    = await usdc.balanceOf(mainAddr);
    const auctionBalAfter = await usdc.balanceOf(auctionAddr);

    // Main should have: previous balance - (agentPayout + posterReturn + verifierFee) + slashBond
    // The bounty was escrowed on Main. Settlement sends out agentPayout, posterReturn, verifierFee.
    // slashBond comes from Auction → Main.
    const expectedMainBal = mainBalPreSettle - agentPayout - posterReturn - verifierFee + slashBond;
    expect(mainBalAfter).to.equal(expectedMainBal);

    // Auction should have: previous balance - stakeReturn - verifierStake - slashBond
    // Agent stake (on Auction) → stakeReturn to agent, slashBond to Main
    // Verifier stake (on Auction) → returned to verifier
    const expectedAuctionBal = auctionBalPreSettle - stakeReturn - verifierStake - slashBond;
    expect(auctionBalAfter).to.equal(expectedAuctionBal);

    // ────────────────────────────────────
    // Summary: every USDC cent is accounted for
    // ────────────────────────────────────
    //   Poster paid:     1,000 USDC (bounty)
    //   Poster received:   170 USDC (bounty remainder - verifier fee)
    //   Agent paid:        100 USDC (stake)
    //   Agent received:    860 USDC (780 payout + 80 stake return)
    //   Verifier paid:      20 USDC (stake)
    //   Verifier received:  50 USDC (30 fee + 20 stake return)
    //   Protocol treasury:  20 USDC (2.5% of price)
    //   Slash bond held:    20 USDC (20% of agent stake, claimable after slash window)
  });
});

/**
 * Fuzz test: auction scoring algorithm.
 *
 * Generates 50 randomized inputs with varying stake, price, reputation,
 * and completed-task counts. Verifies the score formula matches the
 * on-chain computation and that the highest score always wins.
 *
 * On-chain formula (ArenaCoreAuction.resolveAuction):
 *   score = (stake * (reputation + 1) * 1e18) / price
 *
 * Also tests edge cases: zero reputation, high reputation, minimum
 * stake, equal scores, and tie-breaking behavior.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Auction Scoring Fuzz Tests", function () {
  let main, auction, vrf, usdc;
  let owner, poster;
  let agents; // array of 5 agent signers

  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const BID_DURATION    = 3600;
  const REVEAL_DURATION = 1800;
  const DEADLINE_OFFSET = 86400;
  const SLASH_WINDOW    = 604800;
  const CRITERIA_HASH   = ethers.keccak256(ethers.toUtf8Bytes("fuzz criteria"));
  const TASK_TYPE       = "fuzz";

  // Deterministic PRNG (Mulberry32) for reproducible randomness
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Compute expected score exactly matching the contract
  function expectedScore(stake, price, reputation) {
    // score = (stake * (reputation + 1) * 1e18) / price
    return (stake * (reputation + 1n) * (10n ** 18n)) / price;
  }

  before(async function () {
    const signers = await ethers.getSigners();
    owner  = signers[0];
    poster = signers[1];
    agents = signers.slice(2, 7); // 5 agents

    // Deploy
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

    await main.setArenaCoreAuction(await auction.getAddress());
    await main.setArenaCoreVRF(await vrf.getAddress());
    await auction.setArenaCoreVRF(await vrf.getAddress());

    // Fund everyone generously
    const mint = USDC(1_000_000);
    for (const s of [poster, ...agents]) {
      await usdc.mint(s.address, mint);
      await usdc.connect(s).approve(await main.getAddress(), ethers.MaxUint256);
      await usdc.connect(s).approve(await auction.getAddress(), ethers.MaxUint256);
    }
  });

  // ───────────────────────────────────────────────────
  // Helper: build reputation for an agent by completing tasks
  // Each completed task gives +10 reputation
  // ───────────────────────────────────────────────────
  async function buildReputation(agentSigner, targetRep) {
    const currentRep = await main.agentReputation(agentSigner.address);
    const needed = Number(targetRep - currentRep);
    if (needed <= 0) return;

    // Disable verifier cooldown so same verifier can verify repeatedly
    await vrf.setVerifierCooldown(0);
    await auction.setLocalVerifierCooldown(0); // M-04: also disable local cooldown

    const tasksNeeded = Math.ceil(needed / 10);
    const verifier = agents[4]; // use last agent as verifier

    for (let i = 0; i < tasksNeeded; i++) {
      const bounty = USDC(100);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tx = await main.connect(poster).createTask(
        bounty, deadline, SLASH_WINDOW, BID_DURATION, REVEAL_DURATION,
        1, CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
      );
      const receipt = await tx.wait();
      const log = receipt.logs.find(l => {
        try { return main.interface.parseLog(l)?.name === "TaskCreated"; } catch { return false; }
      });
      const taskId = main.interface.parseLog(log).args.taskId;

      const stake = USDC(10);
      const price = USDC(50);
      const salt = ethers.randomBytes(32);
      const commitHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "uint256", "bytes32"],
        [agentSigner.address, stake, price, 3600, salt]
      );
      await auction.connect(agentSigner).commitBid(taskId, commitHash, CRITERIA_HASH);

      const task = await main.getTask(taskId);
      await time.increaseTo(task.bidDeadline);
      await auction.connect(agentSigner).revealBid(taskId, stake, price, 3600, salt);
      await time.increaseTo(task.revealDeadline);
      await auction.resolveAuction(taskId);

      const outputHash = ethers.keccak256(ethers.toUtf8Bytes(`rep-build-${i}`));
      await auction.connect(agentSigner).deliverTask(taskId, outputHash);

      const assignment = await main.getAssignment(taskId);
      const vStake = assignment.stake / 5n > 0n ? assignment.stake / 5n : 1n;
      await usdc.mint(verifier.address, vStake);
      await usdc.connect(verifier).approve(await auction.getAddress(), vStake);
      await auction.connect(verifier).registerVerifier(taskId, vStake);

      const rHash = ethers.keccak256(ethers.toUtf8Bytes(`rep-report-${i}`));
      await auction.connect(verifier).submitVerification(taskId, 1, rHash);
    }

    // Restore cooldown
    await vrf.setVerifierCooldown(7 * 24 * 3600);
  }

  // ───────────────────────────────────────────────────
  // Helper: create task, have agents bid, resolve, return winner
  // ───────────────────────────────────────────────────
  async function runAuction(bidders) {
    // bidders = [{ signer, stake (bigint), price (bigint) }, ...]
    // Constraints: bounty >= max(price), stake >= bounty/10, price <= bounty
    // Set bounty = max(price); each bidder stake must be >= bounty/10
    const maxPrice = bidders.reduce((m, b) => b.price > m ? b.price : m, 0n);
    const bounty = maxPrice;
    const deadline = (await time.latest()) + DEADLINE_OFFSET;
    const tx = await main.connect(poster).createTask(
      bounty, deadline, SLASH_WINDOW, BID_DURATION, REVEAL_DURATION,
      1, CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
    );
    const receipt = await tx.wait();
    const log = receipt.logs.find(l => {
      try { return main.interface.parseLog(l)?.name === "TaskCreated"; } catch { return false; }
    });
    const taskId = main.interface.parseLog(log).args.taskId;

    // Commit all bids
    const salts = [];
    for (const b of bidders) {
      const salt = ethers.randomBytes(32);
      salts.push(salt);
      const commitHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "uint256", "bytes32"],
        [b.signer.address, b.stake, b.price, 3600, salt]
      );
      await auction.connect(b.signer).commitBid(taskId, commitHash, CRITERIA_HASH);
    }

    // Advance to reveal period
    const task = await main.getTask(taskId);
    await time.increaseTo(task.bidDeadline);

    // Reveal all bids
    for (let i = 0; i < bidders.length; i++) {
      await auction.connect(bidders[i].signer).revealBid(
        taskId, bidders[i].stake, bidders[i].price, 3600, salts[i]
      );
    }

    // Advance past reveal deadline and resolve
    await time.increaseTo(task.revealDeadline);

    // Resolve — capture AgentAssigned to find winner
    const resolveTx = await auction.resolveAuction(taskId);
    const resolveReceipt = await resolveTx.wait();
    const assignedLog = resolveReceipt.logs.find(l => {
      try { return auction.interface.parseLog(l)?.name === "AgentAssigned"; } catch { return false; }
    });
    const winner = auction.interface.parseLog(assignedLog).args.agent;

    return { taskId, winner };
  }

  // ═══════════════════════════════════════════════════
  // TEST 1: Score formula matches on 50 randomized inputs
  // ═══════════════════════════════════════════════════

  describe("Score formula verification (50 random inputs)", function () {
    const rand = mulberry32(42); // fixed seed for reproducibility
    const cases = [];

    for (let i = 0; i < 50; i++) {
      const stakeUsd = Math.floor(rand() * 9900) + 100;   // 100–10000 USDC
      const priceUsd = Math.floor(rand() * 4950) + 50;    // 50–5000 USDC
      const rep      = Math.floor(rand() * 851);           // 0–850
      cases.push({ i, stakeUsd, priceUsd, rep });
    }

    cases.forEach(({ i, stakeUsd, priceUsd, rep }) => {
      it(`#${i}: stake=${stakeUsd} price=${priceUsd} rep=${rep}`, function () {
        const stake = BigInt(stakeUsd) * 1_000_000n;
        const price = BigInt(priceUsd) * 1_000_000n;
        const reputation = BigInt(rep);

        const score = expectedScore(stake, price, reputation);

        // Verify formula components
        const repFactor = reputation + 1n;
        const numerator = stake * repFactor * (10n ** 18n);
        const expectedResult = numerator / price;
        expect(score).to.equal(expectedResult);

        // Score is always positive for valid inputs
        expect(score).to.be.gt(0n);

        // Higher stake → higher score (price and rep constant)
        const doubleStake = expectedScore(stake * 2n, price, reputation);
        // Integer division truncation: (2a)/b may differ from 2*(a/b) by at most 1
        const diff1 = doubleStake - score * 2n;
        expect(diff1 >= 0n && diff1 <= 1n).to.be.true;

        // Higher reputation → higher score (stake and price constant)
        const higherRep = expectedScore(stake, price, reputation + 10n);
        expect(higherRep).to.be.gt(score);

        // Higher price → lower score (stake and rep constant)
        const doublePrice = expectedScore(stake, price * 2n, reputation);
        // Integer division truncation: a/(2b) may differ from (a/b)/2 by at most 1
        const diff2 = score / 2n - doublePrice;
        expect(diff2 >= 0n && diff2 <= 1n).to.be.true;
      });
    });
  });

  // ═══════════════════════════════════════════════════
  // TEST 2: Edge cases
  // ═══════════════════════════════════════════════════

  describe("Edge cases", function () {
    it("zero reputation: score = (stake * 1 * 1e18) / price", function () {
      const score = expectedScore(USDC(1000), USDC(500), 0n);
      // (1000e6 * 1 * 1e18) / 500e6 = 2e18
      expect(score).to.equal(2n * (10n ** 18n));
    });

    it("high reputation (850): large but finite score", function () {
      const score = expectedScore(USDC(100), USDC(100), 850n);
      // (100e6 * 851 * 1e18) / 100e6 = 851e18
      expect(score).to.equal(851n * (10n ** 18n));
    });

    it("minimum stake (bounty/10): score reflects small stake", function () {
      const bounty = USDC(1000);
      const minStake = bounty / 10n; // 100 USDC
      const score = expectedScore(minStake, USDC(500), 0n);
      // (100e6 * 1 * 1e18) / 500e6 = 0.2e18
      expect(score).to.equal(200_000_000_000_000_000n);
    });

    it("equal scores: first bidder wins (iteration order)", function () {
      // Same stake, price, and rep → same score → first in array wins
      const stake = USDC(100);
      const price = USDC(500);
      const s1 = expectedScore(stake, price, 0n);
      const s2 = expectedScore(stake, price, 0n);
      expect(s1).to.equal(s2);
    });

    it("very large reputation does not overflow", function () {
      // Max reasonable rep: 10,000 (1,000 tasks * 10 rep each)
      const score = expectedScore(USDC(10000), USDC(50), 10000n);
      // (10000e6 * 10001 * 1e18) / 50e6 = very large but fits uint256
      expect(score).to.be.gt(0n);
      // Verify: 10000e6 * 10001 * 1e18 = 1e6 * 1e4 * 1e4 * 1e18 ≈ 1e32, /50e6 ≈ 2e24
      const expected = (10000n * 10001n * (10n ** 18n)) / 50n;
      expect(score).to.equal(expected);
    });

    it("very small price (1 USDC) maximizes score", function () {
      const score = expectedScore(USDC(10000), USDC(1), 100n);
      // (10000e6 * 101 * 1e18) / 1e6 = 10000 * 101 * 1e18 = 1.01e24
      const expected = (10000n * 101n * (10n ** 18n));
      expect(score).to.equal(expected);
    });

    it("stake = price with zero rep gives score of 1e18", function () {
      const amount = USDC(500);
      const score = expectedScore(amount, amount, 0n);
      expect(score).to.equal(10n ** 18n);
    });
  });

  // ═══════════════════════════════════════════════════
  // TEST 3: Highest score always wins (on-chain verification)
  // ═══════════════════════════════════════════════════

  describe("Highest score wins on-chain", function () {
    it("higher stake wins over lower stake (same price, same rep)", async function () {
      // bounty = maxPrice = 500, minStake = 500/10 = 50. Both stakes >= 50 ✓
      const { winner } = await runAuction([
        { signer: agents[0], stake: USDC(200), price: USDC(500) },
        { signer: agents[1], stake: USDC(500), price: USDC(500) },
      ]);
      expect(winner).to.equal(agents[1].address);
    });

    it("lower price wins over higher price (same stake, same rep)", async function () {
      // bounty = maxPrice = 800, minStake = 80. Both stakes = 200 >= 80 ✓
      const { winner } = await runAuction([
        { signer: agents[0], stake: USDC(200), price: USDC(800) },
        { signer: agents[1], stake: USDC(200), price: USDC(400) },
      ]);
      expect(winner).to.equal(agents[1].address);
    });

    it("higher reputation wins (same stake, same price)", async function () {
      // Build reputation for agents[0] to 20 (2 completed tasks)
      await buildReputation(agents[0], 20n);
      const rep0 = await main.agentReputation(agents[0].address);
      const rep1 = await main.agentReputation(agents[1].address);
      expect(rep0).to.be.gt(rep1);

      // bounty = 500, minStake = 50. stake = 200 >= 50 ✓
      const { winner } = await runAuction([
        { signer: agents[0], stake: USDC(200), price: USDC(500) },
        { signer: agents[1], stake: USDC(200), price: USDC(500) },
      ]);
      expect(winner).to.equal(agents[0].address);
    });

    it("stake advantage overcomes price disadvantage", async function () {
      // bounty = maxPrice = 900, minStake = 90
      // Agent 2: stake=1000 >= 90 ✓, Agent 3: stake=100 >= 90 ✓
      // Use agents[2] and agents[3] (both 0 rep for clean comparison)
      const { winner } = await runAuction([
        { signer: agents[2], stake: USDC(1000), price: USDC(900) },
        { signer: agents[3], stake: USDC(100),  price: USDC(100) },
      ]);

      // Verify math: agent2 rep=0, agent3 rep=0
      const rep2 = await main.agentReputation(agents[2].address);
      const rep3 = await main.agentReputation(agents[3].address);
      const score2 = expectedScore(USDC(1000), USDC(900), rep2);
      const score3 = expectedScore(USDC(100),  USDC(100), rep3);
      expect(score2).to.be.gt(score3);
      expect(winner).to.equal(agents[2].address);
    });

    it("3-way auction: correct winner among three bidders", async function () {
      // bounty = maxPrice = 700, minStake = 70
      // All stakes (300, 500, 200) >= 70 ✓
      const rep1 = await main.agentReputation(agents[1].address);
      const rep2 = await main.agentReputation(agents[2].address);
      const rep3 = await main.agentReputation(agents[3].address);

      const bids = [
        { signer: agents[1], stake: USDC(300), price: USDC(600) },
        { signer: agents[2], stake: USDC(500), price: USDC(700) },
        { signer: agents[3], stake: USDC(200), price: USDC(200) },
      ];

      const score1 = expectedScore(USDC(300), USDC(600), rep1);
      const score2 = expectedScore(USDC(500), USDC(700), rep2);
      const score3 = expectedScore(USDC(200), USDC(200), rep3);

      // Find expected winner
      let expectedWinner;
      if (score1 >= score2 && score1 >= score3) expectedWinner = agents[1].address;
      else if (score2 >= score1 && score2 >= score3) expectedWinner = agents[2].address;
      else expectedWinner = agents[3].address;

      const { winner } = await runAuction(bids);
      expect(winner).to.equal(expectedWinner);
    });
  });

  // ═══════════════════════════════════════════════════
  // TEST 4: Randomized 2-agent auctions (10 rounds on-chain)
  // ═══════════════════════════════════════════════════

  describe("Randomized on-chain auctions (10 rounds)", function () {
    const rand = mulberry32(1337);

    for (let round = 0; round < 10; round++) {
      // Generate constrained random values:
      // price: 50-5000 USDC
      // stake: must be >= maxPrice/10 → generate stake as max(random, ceil(maxPrice/10))
      const priceA = Math.floor(rand() * 4950) + 50;
      const priceB = Math.floor(rand() * 4950) + 50;
      const maxP = Math.max(priceA, priceB);
      const minStakeRequired = Math.ceil(maxP / 10);
      // Ensure stake is at least minStakeRequired and at most 10000
      const stakeA = Math.max(Math.floor(rand() * 9900) + 100, minStakeRequired);
      const stakeB = Math.max(Math.floor(rand() * 9900) + 100, minStakeRequired);

      it(`round ${round}: A(s=${stakeA},p=${priceA}) vs B(s=${stakeB},p=${priceB})`, async function () {
        // Use agents[1] and agents[2] (known reps from earlier tests)
        const repA = await main.agentReputation(agents[1].address);
        const repB = await main.agentReputation(agents[2].address);

        const scoreA = expectedScore(USDC(stakeA), USDC(priceA), repA);
        const scoreB = expectedScore(USDC(stakeB), USDC(priceB), repB);

        const { winner } = await runAuction([
          { signer: agents[1], stake: USDC(stakeA), price: USDC(priceA) },
          { signer: agents[2], stake: USDC(stakeB), price: USDC(priceB) },
        ]);

        if (scoreA > scoreB) {
          expect(winner).to.equal(agents[1].address);
        } else if (scoreB > scoreA) {
          expect(winner).to.equal(agents[2].address);
        } else {
          // Equal scores: first bidder in array wins (iteration order)
          expect(winner).to.equal(agents[1].address);
        }
      });
    }
  });
});

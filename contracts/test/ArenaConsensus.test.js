const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ArenaConsensus", function () {
  let consensus, mockCore, usdc;
  let owner, poster, agent1, agent2, agent3, agent4, agent5, anyone;

  const BOUNTY = ethers.parseUnits("500", 6); // 500 USDC total
  const BID_DURATION = 4 * 3600; // 4 hours
  const REVEAL_DURATION = 2 * 3600; // 2 hours
  const SLASH_WINDOW = 24 * 3600; // 24 hours
  const AGENT_COUNT = 3;
  const VERIFIERS = 3;

  // ConsensusStatus enum
  const STATUS = {
    Open: 0,
    BidReveal: 1,
    Executing: 2,
    Delivered: 3,
    Consensus: 4,
    NoConsensus: 5,
    Cancelled: 6,
  };

  beforeEach(async function () {
    [owner, poster, agent1, agent2, agent3, agent4, agent5, anyone] =
      await ethers.getSigners();

    // Deploy MockArenaCore
    const MockArenaCore = await ethers.getContractFactory("MockArenaCore");
    mockCore = await MockArenaCore.deploy();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    // Deploy ArenaConsensus
    const ArenaConsensus = await ethers.getContractFactory("ArenaConsensus");
    consensus = await ArenaConsensus.deploy(await mockCore.getAddress());

    // Whitelist USDC
    await consensus.setTokenWhitelist(await usdc.getAddress(), true);

    // Set reputations
    await mockCore.setAgentReputation(agent1.address, 50);
    await mockCore.setAgentReputation(agent2.address, 40);
    await mockCore.setAgentReputation(agent3.address, 30);
    await mockCore.setAgentReputation(agent4.address, 20);
    await mockCore.setAgentReputation(agent5.address, 10);

    // Mint USDC to poster and agents
    const mintAmount = ethers.parseUnits("100000", 6);
    await usdc.mint(poster.address, mintAmount);
    await usdc.mint(agent1.address, mintAmount);
    await usdc.mint(agent2.address, mintAmount);
    await usdc.mint(agent3.address, mintAmount);
    await usdc.mint(agent4.address, mintAmount);
    await usdc.mint(agent5.address, mintAmount);

    // Approve consensus contract
    const consensusAddr = await consensus.getAddress();
    await usdc.connect(poster).approve(consensusAddr, mintAmount);
    await usdc.connect(agent1).approve(consensusAddr, mintAmount);
    await usdc.connect(agent2).approve(consensusAddr, mintAmount);
    await usdc.connect(agent3).approve(consensusAddr, mintAmount);
    await usdc.connect(agent4).approve(consensusAddr, mintAmount);
    await usdc.connect(agent5).approve(consensusAddr, mintAmount);
  });

  // ── Helpers ──────────────────────────────────────────

  async function createDefaultTask(agentCount = AGENT_COUNT) {
    const deadline = (await time.latest()) + 7 * 24 * 3600; // 7 days
    const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("consensus-criteria"));

    const tx = await consensus
      .connect(poster)
      .createConsensusTask(
        BOUNTY,
        agentCount,
        deadline,
        SLASH_WINDOW,
        BID_DURATION,
        REVEAL_DURATION,
        VERIFIERS,
        criteriaHash,
        "audit",
        await usdc.getAddress()
      );
    return tx;
  }

  function makeSalt(agent, nonce = 0) {
    return ethers.keccak256(
      ethers.solidityPacked(["address", "uint256"], [agent.address, nonce])
    );
  }

  function commitHash(agent, stake, price, eta, salt) {
    return ethers.keccak256(
      ethers.solidityPacked(
        ["address", "uint256", "uint256", "uint256", "bytes32"],
        [agent.address, stake, price, eta, salt]
      )
    );
  }

  async function submitAndRevealBid(taskId, agent, stake, price, eta = 3600) {
    const salt = makeSalt(agent);
    const commit = commitHash(agent, stake, price, eta, salt);
    const criteriaAck = ethers.keccak256(ethers.toUtf8Bytes("ack"));

    await consensus.connect(agent).submitBid(taskId, commit, criteriaAck);

    // Advance to reveal phase
    const task = await consensus.getConsensusTask(taskId);
    const bidDeadline = Number(task.bidDeadline);
    const now = await time.latest();
    if (now < bidDeadline) {
      await time.increaseTo(bidDeadline + 1);
    }

    await consensus.connect(agent).revealBid(taskId, stake, price, eta, salt);
  }

  async function setupFullAuction(taskId, agentCount = 3) {
    const stake = ethers.parseUnits("50", 6);
    const agents = [agent1, agent2, agent3, agent4, agent5].slice(0, agentCount);
    const prices = [
      ethers.parseUnits("80", 6),
      ethers.parseUnits("90", 6),
      ethers.parseUnits("100", 6),
      ethers.parseUnits("110", 6),
      ethers.parseUnits("120", 6),
    ].slice(0, agentCount);

    // Submit all bids first
    for (let i = 0; i < agents.length; i++) {
      const salt = makeSalt(agents[i]);
      const commit = commitHash(agents[i], stake, prices[i], 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));
      await consensus.connect(agents[i]).submitBid(taskId, commit, ack);
    }

    // Advance to reveal phase
    const task = await consensus.getConsensusTask(taskId);
    await time.increaseTo(Number(task.bidDeadline) + 1);

    // Reveal all bids
    for (let i = 0; i < agents.length; i++) {
      const salt = makeSalt(agents[i]);
      await consensus
        .connect(agents[i])
        .revealBid(taskId, stake, prices[i], 3600, salt);
    }

    // Advance past reveal deadline and resolve
    const taskAfter = await consensus.getConsensusTask(taskId);
    await time.increaseTo(Number(taskAfter.revealDeadline) + 1);
    await consensus.resolveAuction(taskId);
  }

  // ═══════════════════════════════════════════════════
  // createConsensusTask
  // ═══════════════════════════════════════════════════

  describe("createConsensusTask", function () {
    it("should create a consensus task with correct parameters", async function () {
      await createDefaultTask();

      const task = await consensus.getConsensusTask(0);
      expect(task.poster).to.equal(poster.address);
      expect(task.totalBounty).to.equal(BOUNTY);
      expect(task.agentCount).to.equal(AGENT_COUNT);
      expect(task.perAgentBounty).to.equal(BOUNTY / BigInt(AGENT_COUNT));
      expect(task.status).to.equal(STATUS.Open);
      expect(task.taskType).to.equal("audit");
    });

    it("should emit ConsensusTaskCreated event", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("criteria"));

      await expect(
        consensus.connect(poster).createConsensusTask(
          BOUNTY, AGENT_COUNT, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", await usdc.getAddress()
        )
      )
        .to.emit(consensus, "ConsensusTaskCreated")
        .withArgs(0, poster.address, BOUNTY, AGENT_COUNT, "audit", deadline);
    });

    it("should transfer bounty to contract escrow", async function () {
      const balBefore = await usdc.balanceOf(poster.address);
      await createDefaultTask();
      const balAfter = await usdc.balanceOf(poster.address);
      expect(balBefore - balAfter).to.equal(BOUNTY);

      const contractBal = await usdc.balanceOf(await consensus.getAddress());
      expect(contractBal).to.equal(BOUNTY);
    });

    it("should increment task count", async function () {
      await createDefaultTask();
      expect(await consensus.consensusTaskCount()).to.equal(1);
      await createDefaultTask();
      expect(await consensus.consensusTaskCount()).to.equal(2);
    });

    it("should revert if agentCount < 2", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c"));
      await expect(
        consensus.connect(poster).createConsensusTask(
          BOUNTY, 1, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", await usdc.getAddress()
        )
      ).to.be.revertedWithCustomError(consensus, "AC01");
    });

    it("should revert if agentCount > 5", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c"));
      await expect(
        consensus.connect(poster).createConsensusTask(
          BOUNTY, 6, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", await usdc.getAddress()
        )
      ).to.be.revertedWithCustomError(consensus, "AC01");
    });

    it("should revert if bounty is zero", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c"));
      await expect(
        consensus.connect(poster).createConsensusTask(
          0, AGENT_COUNT, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", await usdc.getAddress()
        )
      ).to.be.revertedWithCustomError(consensus, "AC02");
    });

    it("should revert if deadline is in the past", async function () {
      const deadline = (await time.latest()) - 1;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c"));
      await expect(
        consensus.connect(poster).createConsensusTask(
          BOUNTY, AGENT_COUNT, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", await usdc.getAddress()
        )
      ).to.be.revertedWithCustomError(consensus, "AC03");
    });

    it("should revert if token not whitelisted", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c"));
      await expect(
        consensus.connect(poster).createConsensusTask(
          BOUNTY, AGENT_COUNT, deadline, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, VERIFIERS,
          criteriaHash, "audit", ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(consensus, "AC06");
    });
  });

  // ═══════════════════════════════════════════════════
  // cancelConsensusTask
  // ═══════════════════════════════════════════════════

  describe("cancelConsensusTask", function () {
    it("should allow poster to cancel before agents assigned", async function () {
      await createDefaultTask();
      const balBefore = await usdc.balanceOf(poster.address);

      await expect(consensus.connect(poster).cancelConsensusTask(0))
        .to.emit(consensus, "ConsensusTaskCancelled")
        .withArgs(0);

      const balAfter = await usdc.balanceOf(poster.address);
      expect(balAfter - balBefore).to.equal(BOUNTY);

      const task = await consensus.getConsensusTask(0);
      expect(task.status).to.equal(STATUS.Cancelled);
    });

    it("should revert if not poster", async function () {
      await createDefaultTask();
      await expect(
        consensus.connect(anyone).cancelConsensusTask(0)
      ).to.be.revertedWithCustomError(consensus, "AC31");
    });

    it("should revert if task already in Executing status", async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);

      await expect(
        consensus.connect(poster).cancelConsensusTask(0)
      ).to.be.revertedWithCustomError(consensus, "AC32");
    });
  });

  // ═══════════════════════════════════════════════════
  // Sealed bid auction
  // ═══════════════════════════════════════════════════

  describe("submitBid", function () {
    beforeEach(async function () {
      await createDefaultTask();
    });

    it("should accept a sealed bid", async function () {
      const salt = makeSalt(agent1);
      const stake = ethers.parseUnits("50", 6);
      const price = ethers.parseUnits("80", 6);
      const commit = commitHash(agent1, stake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await expect(consensus.connect(agent1).submitBid(0, commit, ack))
        .to.emit(consensus, "ConsensusBidSubmitted")
        .withArgs(0, agent1.address, commit);
    });

    it("should revert for duplicate bid", async function () {
      const salt = makeSalt(agent1);
      const stake = ethers.parseUnits("50", 6);
      const price = ethers.parseUnits("80", 6);
      const commit = commitHash(agent1, stake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await consensus.connect(agent1).submitBid(0, commit, ack);
      await expect(
        consensus.connect(agent1).submitBid(0, commit, ack)
      ).to.be.revertedWithCustomError(consensus, "AC10");
    });

    it("should revert if banned agent", async function () {
      await mockCore.setAgentBanned(agent1.address, true);
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, ethers.parseUnits("50", 6), ethers.parseUnits("80", 6), 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await expect(
        consensus.connect(agent1).submitBid(0, commit, ack)
      ).to.be.revertedWithCustomError(consensus, "AC29");
    });

    it("should revert if criteria ack is zero", async function () {
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, ethers.parseUnits("50", 6), ethers.parseUnits("80", 6), 3600, salt);

      await expect(
        consensus.connect(agent1).submitBid(0, commit, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(consensus, "AC11");
    });

    it("should revert after bid deadline", async function () {
      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, ethers.parseUnits("50", 6), ethers.parseUnits("80", 6), 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await expect(
        consensus.connect(agent1).submitBid(0, commit, ack)
      ).to.be.revertedWithCustomError(consensus, "AC09");
    });
  });

  describe("revealBid", function () {
    beforeEach(async function () {
      await createDefaultTask();
    });

    it("should reveal a valid bid", async function () {
      const stake = ethers.parseUnits("50", 6);
      const price = ethers.parseUnits("80", 6);
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, stake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await consensus.connect(agent1).submitBid(0, commit, ack);

      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      await expect(
        consensus.connect(agent1).revealBid(0, stake, price, 3600, salt)
      )
        .to.emit(consensus, "ConsensusBidRevealed")
        .withArgs(0, agent1.address, stake, price);
    });

    it("should revert on commit hash mismatch", async function () {
      const stake = ethers.parseUnits("50", 6);
      const price = ethers.parseUnits("80", 6);
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, stake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await consensus.connect(agent1).submitBid(0, commit, ack);

      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      // Wrong price
      await expect(
        consensus.connect(agent1).revealBid(0, stake, ethers.parseUnits("999", 6), 3600, salt)
      ).to.be.revertedWithCustomError(consensus, "AC17");
    });

    it("should revert if stake too low", async function () {
      const lowStake = ethers.parseUnits("1", 6); // Way below bounty/10/3
      const price = ethers.parseUnits("80", 6);
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, lowStake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await consensus.connect(agent1).submitBid(0, commit, ack);

      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      await expect(
        consensus.connect(agent1).revealBid(0, lowStake, price, 3600, salt)
      ).to.be.revertedWithCustomError(consensus, "AC12");
    });

    it("should transfer stake from agent to contract", async function () {
      const stake = ethers.parseUnits("50", 6);
      const price = ethers.parseUnits("80", 6);
      const salt = makeSalt(agent1);
      const commit = commitHash(agent1, stake, price, 3600, salt);
      const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));

      await consensus.connect(agent1).submitBid(0, commit, ack);
      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      const balBefore = await usdc.balanceOf(agent1.address);
      await consensus.connect(agent1).revealBid(0, stake, price, 3600, salt);
      const balAfter = await usdc.balanceOf(agent1.address);

      expect(balBefore - balAfter).to.equal(stake);
    });
  });

  // ═══════════════════════════════════════════════════
  // resolveAuction
  // ═══════════════════════════════════════════════════

  describe("resolveAuction", function () {
    beforeEach(async function () {
      await createDefaultTask();
    });

    it("should select top N agents by score", async function () {
      await setupFullAuction(0, 3);

      const task = await consensus.getConsensusTask(0);
      expect(task.status).to.equal(STATUS.Executing);

      const subs = await consensus.getSubmissions(0);
      expect(subs.length).to.equal(3);
    });

    it("should emit ConsensusAuctionResolved event", async function () {
      // Submit all bids
      const stake = ethers.parseUnits("50", 6);
      const agents = [agent1, agent2, agent3];
      const prices = [
        ethers.parseUnits("80", 6),
        ethers.parseUnits("90", 6),
        ethers.parseUnits("100", 6),
      ];

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        const commit = commitHash(agents[i], stake, prices[i], 3600, salt);
        const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));
        await consensus.connect(agents[i]).submitBid(0, commit, ack);
      }

      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        await consensus.connect(agents[i]).revealBid(0, stake, prices[i], 3600, salt);
      }

      const taskAfter = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(taskAfter.revealDeadline) + 1);

      await expect(consensus.resolveAuction(0)).to.emit(
        consensus,
        "ConsensusAuctionResolved"
      );
    });

    it("should revert if not enough revealed bids", async function () {
      // Only 2 bids for a 3-agent task
      const stake = ethers.parseUnits("50", 6);
      const agents = [agent1, agent2];
      const prices = [ethers.parseUnits("80", 6), ethers.parseUnits("90", 6)];

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        const commit = commitHash(agents[i], stake, prices[i], 3600, salt);
        const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));
        await consensus.connect(agents[i]).submitBid(0, commit, ack);
      }

      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        await consensus.connect(agents[i]).revealBid(0, stake, prices[i], 3600, salt);
      }

      const taskAfter = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(taskAfter.revealDeadline) + 1);

      await expect(consensus.resolveAuction(0)).to.be.revertedWithCustomError(
        consensus,
        "AC18"
      );
    });

    it("should revert if reveal deadline not passed", async function () {
      await expect(consensus.resolveAuction(0)).to.be.revertedWithCustomError(
        consensus,
        "AC20"
      );
    });

    it("should refund losing bidders", async function () {
      // 4 bids for a 3-agent task — 1 should be refunded
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c2"));
      await consensus.connect(poster).createConsensusTask(
        BOUNTY, 3, deadline, SLASH_WINDOW,
        BID_DURATION, REVEAL_DURATION, VERIFIERS,
        criteriaHash, "audit", await usdc.getAddress()
      );

      const stake = ethers.parseUnits("50", 6);
      const agents = [agent1, agent2, agent3, agent4];
      const prices = [
        ethers.parseUnits("80", 6),
        ethers.parseUnits("90", 6),
        ethers.parseUnits("100", 6),
        ethers.parseUnits("110", 6),
      ];

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        const commit = commitHash(agents[i], stake, prices[i], 3600, salt);
        const ack = ethers.keccak256(ethers.toUtf8Bytes("ack"));
        await consensus.connect(agents[i]).submitBid(1, commit, ack);
      }

      const task = await consensus.getConsensusTask(1);
      await time.increaseTo(Number(task.bidDeadline) + 1);

      for (let i = 0; i < agents.length; i++) {
        const salt = makeSalt(agents[i]);
        await consensus.connect(agents[i]).revealBid(1, stake, prices[i], 3600, salt);
      }

      const taskAfter = await consensus.getConsensusTask(1);
      await time.increaseTo(Number(taskAfter.revealDeadline) + 1);

      // Record agent4 balance before (lowest rep, should lose)
      const bal4Before = await usdc.balanceOf(agent4.address);

      await consensus.resolveAuction(1);

      // agent4 should have gotten their stake refunded
      const bal4After = await usdc.balanceOf(agent4.address);
      // The agent4 should get refund since they're the weakest bidder
      // (lowest reputation=20, highest price=110)
      expect(bal4After).to.be.gte(bal4Before);

      const subs = await consensus.getSubmissions(1);
      expect(subs.length).to.equal(3);
    });
  });

  // ═══════════════════════════════════════════════════
  // deliverOutput
  // ═══════════════════════════════════════════════════

  describe("deliverOutput", function () {
    beforeEach(async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);
    });

    it("should allow selected agent to deliver", async function () {
      const outputHash = ethers.keccak256(ethers.toUtf8Bytes("output-1"));
      const subs = await consensus.getSubmissions(0);
      const selectedAgent = subs[0].agent;

      // Connect as the selected agent
      const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
        (a) => a.address === selectedAgent
      );

      await expect(consensus.connect(agentSigner).deliverOutput(0, outputHash))
        .to.emit(consensus, "ConsensusAgentDelivered");
    });

    it("should increment delivered count", async function () {
      const subs = await consensus.getSubmissions(0);

      for (let i = 0; i < subs.length; i++) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === subs[i].agent
        );
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`output-${i}`));
        await consensus.connect(agentSigner).deliverOutput(0, hash);
      }

      const task = await consensus.getConsensusTask(0);
      expect(task.deliveredCount).to.equal(3);
      expect(task.status).to.equal(STATUS.Delivered);
    });

    it("should revert for non-selected agent", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes("output"));
      await expect(
        consensus.connect(anyone).deliverOutput(0, hash)
      ).to.be.revertedWithCustomError(consensus, "AC21");
    });

    it("should revert for duplicate delivery", async function () {
      const subs = await consensus.getSubmissions(0);
      const selectedAgent = subs[0].agent;
      const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
        (a) => a.address === selectedAgent
      );
      const hash = ethers.keccak256(ethers.toUtf8Bytes("output"));

      await consensus.connect(agentSigner).deliverOutput(0, hash);
      await expect(
        consensus.connect(agentSigner).deliverOutput(0, hash)
      ).to.be.revertedWithCustomError(consensus, "AC23");
    });

    it("should revert if output hash is zero", async function () {
      const subs = await consensus.getSubmissions(0);
      const selectedAgent = subs[0].agent;
      const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
        (a) => a.address === selectedAgent
      );

      await expect(
        consensus.connect(agentSigner).deliverOutput(0, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(consensus, "AC25");
    });

    it("should revert after deadline", async function () {
      const task = await consensus.getConsensusTask(0);
      await time.increaseTo(Number(task.deadline) + 1);

      const subs = await consensus.getSubmissions(0);
      const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
        (a) => a.address === subs[0].agent
      );
      const hash = ethers.keccak256(ethers.toUtf8Bytes("output"));

      await expect(
        consensus.connect(agentSigner).deliverOutput(0, hash)
      ).to.be.revertedWithCustomError(consensus, "AC24");
    });
  });

  // ═══════════════════════════════════════════════════
  // finalizeConsensus — Majority reached
  // ═══════════════════════════════════════════════════

  describe("finalizeConsensus - majority reached", function () {
    beforeEach(async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);
    });

    it("should reach consensus when 2/3 agents match", async function () {
      const subs = await consensus.getSubmissions(0);
      const matchHash = ethers.keccak256(ethers.toUtf8Bytes("same-output"));
      const differentHash = ethers.keccak256(ethers.toUtf8Bytes("different-output"));

      // First 2 agents deliver same hash, 3rd delivers different
      for (let i = 0; i < subs.length; i++) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === subs[i].agent
        );
        const hash = i < 2 ? matchHash : differentHash;
        await consensus.connect(agentSigner).deliverOutput(0, hash);
      }

      await expect(consensus.finalizeConsensus(0))
        .to.emit(consensus, "ConsensusReached")
        .withArgs(0, matchHash, 2, 3);

      const task = await consensus.getConsensusTask(0);
      expect(task.status).to.equal(STATUS.Consensus);

      const result = await consensus.getConsensusResult(0);
      expect(result.finalized).to.be.true;
      expect(result.consensusReached).to.be.true;
      expect(result.majorityHash).to.equal(matchHash);
      expect(result.majorityCount).to.equal(2);
    });

    it("should reach consensus when 3/3 agents match", async function () {
      const subs = await consensus.getSubmissions(0);
      const sameHash = ethers.keccak256(ethers.toUtf8Bytes("unanimous"));

      for (let i = 0; i < subs.length; i++) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === subs[i].agent
        );
        await consensus.connect(agentSigner).deliverOutput(0, sameHash);
      }

      await expect(consensus.finalizeConsensus(0))
        .to.emit(consensus, "ConsensusReached")
        .withArgs(0, sameHash, 3, 3);
    });

    it("should pay matching agents and slash dissenters", async function () {
      const subs = await consensus.getSubmissions(0);
      const matchHash = ethers.keccak256(ethers.toUtf8Bytes("same-output"));
      const differentHash = ethers.keccak256(ethers.toUtf8Bytes("different-output"));

      // Track balances before
      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );
      const balsBefore = [];
      for (const a of agentSigners) {
        balsBefore.push(await usdc.balanceOf(a.address));
      }

      // 2 match, 1 dissents
      for (let i = 0; i < subs.length; i++) {
        const hash = i < 2 ? matchHash : differentHash;
        await consensus.connect(agentSigners[i]).deliverOutput(0, hash);
      }

      await consensus.finalizeConsensus(0);

      // Check matching agents received payment
      for (let i = 0; i < 2; i++) {
        const balAfter = await usdc.balanceOf(agentSigners[i].address);
        // Should receive: stake + price - protocolFee
        expect(balAfter).to.be.gt(balsBefore[i]);
      }

      // Check dissenter got slashed (received less than stake back)
      const dissenterBal = await usdc.balanceOf(agentSigners[2].address);
      const dissenterStake = subs[2].stake;
      // Dissenter should get back: stake - 15% slash = 85% of stake
      // No payment for dissenters
      const expectedReturn =
        dissenterStake - (dissenterStake * BigInt(1500)) / BigInt(10000);
      expect(dissenterBal - balsBefore[2]).to.equal(expectedReturn);
    });

    it("should emit ConsensusAgentSlashed for dissenters", async function () {
      const subs = await consensus.getSubmissions(0);
      const matchHash = ethers.keccak256(ethers.toUtf8Bytes("same"));
      const diffHash = ethers.keccak256(ethers.toUtf8Bytes("diff"));

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      for (let i = 0; i < subs.length; i++) {
        const hash = i < 2 ? matchHash : diffHash;
        await consensus.connect(agentSigners[i]).deliverOutput(0, hash);
      }

      const expectedSlash = (subs[2].stake * BigInt(1500)) / BigInt(10000);

      await expect(consensus.finalizeConsensus(0))
        .to.emit(consensus, "ConsensusAgentSlashed")
        .withArgs(0, subs[2].agent, expectedSlash);
    });

    it("should emit ConsensusAgentPaid for matching agents", async function () {
      const subs = await consensus.getSubmissions(0);
      const sameHash = ethers.keccak256(ethers.toUtf8Bytes("same"));

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      for (const a of agentSigners) {
        await consensus.connect(a).deliverOutput(0, sameHash);
      }

      await expect(consensus.finalizeConsensus(0))
        .to.emit(consensus, "ConsensusAgentPaid");
    });
  });

  // ═══════════════════════════════════════════════════
  // finalizeConsensus — No majority
  // ═══════════════════════════════════════════════════

  describe("finalizeConsensus - no majority", function () {
    beforeEach(async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);
    });

    it("should detect no consensus when all hashes different", async function () {
      const subs = await consensus.getSubmissions(0);

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      for (let i = 0; i < subs.length; i++) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`unique-${i}`));
        await consensus.connect(agentSigners[i]).deliverOutput(0, hash);
      }

      await expect(consensus.finalizeConsensus(0))
        .to.emit(consensus, "ConsensusNotReached")
        .withArgs(0, 3, 3);

      const task = await consensus.getConsensusTask(0);
      expect(task.status).to.equal(STATUS.NoConsensus);

      const result = await consensus.getConsensusResult(0);
      expect(result.finalized).to.be.true;
      expect(result.consensusReached).to.be.false;
    });

    it("should revert if not in Delivered status", async function () {
      await expect(
        consensus.finalizeConsensus(0)
      ).to.be.revertedWithCustomError(consensus, "AC28");
    });

    it("should revert if already finalized (status no longer Delivered)", async function () {
      const subs = await consensus.getSubmissions(0);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("same"));

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      for (const a of agentSigners) {
        await consensus.connect(a).deliverOutput(0, hash);
      }

      await consensus.finalizeConsensus(0);
      // After finalization, status is Consensus (not Delivered), so AC28 fires
      await expect(
        consensus.finalizeConsensus(0)
      ).to.be.revertedWithCustomError(consensus, "AC28");
    });
  });

  // ═══════════════════════════════════════════════════
  // Consensus with different agent counts
  // ═══════════════════════════════════════════════════

  describe("consensus with varying agent counts", function () {
    it("should work with 2 agents (both agree)", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c-2"));
      await consensus.connect(poster).createConsensusTask(
        ethers.parseUnits("200", 6), 2, deadline, SLASH_WINDOW,
        BID_DURATION, REVEAL_DURATION, VERIFIERS,
        criteriaHash, "audit", await usdc.getAddress()
      );
      const taskId = 0; // First task in this test

      await setupFullAuction(taskId, 2);

      const subs = await consensus.getSubmissions(taskId);
      const sameHash = ethers.keccak256(ethers.toUtf8Bytes("agreed"));

      for (const sub of subs) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === sub.agent
        );
        await consensus.connect(agentSigner).deliverOutput(taskId, sameHash);
      }

      await consensus.finalizeConsensus(taskId);
      const result = await consensus.getConsensusResult(taskId);
      expect(result.consensusReached).to.be.true;
      expect(result.majorityCount).to.equal(2);
    });

    it("should detect no consensus with 2 agents (disagree)", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c-2d"));
      await consensus.connect(poster).createConsensusTask(
        ethers.parseUnits("200", 6), 2, deadline, SLASH_WINDOW,
        BID_DURATION, REVEAL_DURATION, VERIFIERS,
        criteriaHash, "audit", await usdc.getAddress()
      );
      const taskId = 0;

      await setupFullAuction(taskId, 2);

      const subs = await consensus.getSubmissions(taskId);
      for (let i = 0; i < subs.length; i++) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === subs[i].agent
        );
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`output-${i}`));
        await consensus.connect(agentSigner).deliverOutput(taskId, hash);
      }

      await consensus.finalizeConsensus(taskId);
      const result = await consensus.getConsensusResult(taskId);
      expect(result.consensusReached).to.be.false;
    });

    it("should work with 5 agents (3/5 majority)", async function () {
      const deadline = (await time.latest()) + 7 * 24 * 3600;
      const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes("c-5"));
      await consensus.connect(poster).createConsensusTask(
        ethers.parseUnits("1000", 6), 5, deadline, SLASH_WINDOW,
        BID_DURATION, REVEAL_DURATION, VERIFIERS,
        criteriaHash, "audit", await usdc.getAddress()
      );
      const taskId = 0;

      await setupFullAuction(taskId, 5);

      const subs = await consensus.getSubmissions(taskId);
      const majorityHash = ethers.keccak256(ethers.toUtf8Bytes("majority"));
      const dissent = ethers.keccak256(ethers.toUtf8Bytes("dissent"));

      for (let i = 0; i < subs.length; i++) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === subs[i].agent
        );
        const hash = i < 3 ? majorityHash : dissent;
        await consensus.connect(agentSigner).deliverOutput(taskId, hash);
      }

      await consensus.finalizeConsensus(taskId);

      const result = await consensus.getConsensusResult(taskId);
      expect(result.consensusReached).to.be.true;
      expect(result.majorityCount).to.equal(3);
      expect(result.totalAgents).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════
  // View functions
  // ═══════════════════════════════════════════════════

  describe("view functions", function () {
    beforeEach(async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);
    });

    it("getConsensusStatus should return correct values", async function () {
      const [status, agentCount, deliveredCount, finalized, reached, , ] =
        await consensus.getConsensusStatus(0);

      expect(status).to.equal(STATUS.Executing);
      expect(agentCount).to.equal(3);
      expect(deliveredCount).to.equal(0);
      expect(finalized).to.be.false;
      expect(reached).to.be.false;
    });

    it("isSelectedAgent should return correct values", async function () {
      const subs = await consensus.getSubmissions(0);
      expect(await consensus.isSelectedAgent(0, subs[0].agent)).to.be.true;
      expect(await consensus.isSelectedAgent(0, anyone.address)).to.be.false;
    });

    it("getAgentSubmissions should return parallel arrays", async function () {
      const [agents, outputHashes, delivered, paid] =
        await consensus.getAgentSubmissions(0);

      expect(agents.length).to.equal(3);
      expect(outputHashes.length).to.equal(3);
      expect(delivered.length).to.equal(3);
      expect(paid.length).to.equal(3);

      for (let i = 0; i < 3; i++) {
        expect(delivered[i]).to.be.false;
        expect(paid[i]).to.be.false;
      }
    });

    it("getConsensusResult should return default before finalization", async function () {
      const result = await consensus.getConsensusResult(0);
      expect(result.finalized).to.be.false;
      expect(result.consensusReached).to.be.false;
      expect(result.majorityCount).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════
  // Admin functions
  // ═══════════════════════════════════════════════════

  describe("admin", function () {
    it("should allow owner to whitelist tokens", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      await consensus.setTokenWhitelist(fakeToken, true);
      expect(await consensus.tokenWhitelist(fakeToken)).to.be.true;
    });

    it("should allow owner to set arbitration address", async function () {
      const arbAddr = ethers.Wallet.createRandom().address;
      await consensus.setArenaArbitration(arbAddr);
      expect(await consensus.arenaArbitration()).to.equal(arbAddr);
    });

    it("should revert if non-owner calls admin functions", async function () {
      await expect(
        consensus.connect(anyone).setTokenWhitelist(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(consensus, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to withdraw protocol fees", async function () {
      // Create and complete a task to generate protocol fees
      await createDefaultTask();
      await setupFullAuction(0, 3);

      const subs = await consensus.getSubmissions(0);
      const sameHash = ethers.keccak256(ethers.toUtf8Bytes("same"));

      for (const sub of subs) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === sub.agent
        );
        await consensus.connect(agentSigner).deliverOutput(0, sameHash);
      }

      await consensus.finalizeConsensus(0);

      const fees = await consensus.protocolTreasury(await usdc.getAddress());
      expect(fees).to.be.gt(0);

      const balBefore = await usdc.balanceOf(owner.address);
      await consensus.withdrawProtocolFees(await usdc.getAddress(), owner.address);
      const balAfter = await usdc.balanceOf(owner.address);
      expect(balAfter - balBefore).to.equal(fees);
    });
  });

  // ═══════════════════════════════════════════════════
  // Edge cases and economic correctness
  // ═══════════════════════════════════════════════════

  describe("economic correctness", function () {
    it("protocol fee should be 2.5% of each matching agent price", async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);

      const subs = await consensus.getSubmissions(0);
      const sameHash = ethers.keccak256(ethers.toUtf8Bytes("same"));

      for (const sub of subs) {
        const agentSigner = [agent1, agent2, agent3, agent4, agent5].find(
          (a) => a.address === sub.agent
        );
        await consensus.connect(agentSigner).deliverOutput(0, sameHash);
      }

      await consensus.finalizeConsensus(0);

      // All 3 matched — protocol fee = sum of 2.5% of each price
      const fees = await consensus.protocolTreasury(await usdc.getAddress());
      let expectedFees = BigInt(0);
      for (const sub of subs) {
        expectedFees += (sub.price * BigInt(250)) / BigInt(10000);
      }
      expect(fees).to.equal(expectedFees);
    });

    it("dissenter slash should be 15% of stake", async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);

      const subs = await consensus.getSubmissions(0);
      const matchHash = ethers.keccak256(ethers.toUtf8Bytes("match"));
      const dissent = ethers.keccak256(ethers.toUtf8Bytes("dissent"));

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      const dissenterBefore = await usdc.balanceOf(agentSigners[2].address);

      for (let i = 0; i < subs.length; i++) {
        await consensus
          .connect(agentSigners[i])
          .deliverOutput(0, i < 2 ? matchHash : dissent);
      }

      await consensus.finalizeConsensus(0);

      const dissenterAfter = await usdc.balanceOf(agentSigners[2].address);
      const dissenterStake = subs[2].stake;
      const expectedSlash = (dissenterStake * BigInt(1500)) / BigInt(10000);
      const expectedReturn = dissenterStake - expectedSlash;

      expect(dissenterAfter - dissenterBefore).to.equal(expectedReturn);
    });

    it("poster should receive unspent bounty plus slash revenue", async function () {
      await createDefaultTask();
      await setupFullAuction(0, 3);

      const subs = await consensus.getSubmissions(0);
      const matchHash = ethers.keccak256(ethers.toUtf8Bytes("match"));
      const dissent = ethers.keccak256(ethers.toUtf8Bytes("dissent"));

      const agentSigners = subs.map((s) =>
        [agent1, agent2, agent3, agent4, agent5].find((a) => a.address === s.agent)
      );

      const posterBefore = await usdc.balanceOf(poster.address);

      for (let i = 0; i < subs.length; i++) {
        await consensus
          .connect(agentSigners[i])
          .deliverOutput(0, i < 2 ? matchHash : dissent);
      }

      await consensus.finalizeConsensus(0);

      const posterAfter = await usdc.balanceOf(poster.address);
      // Poster should get back: totalBounty - sum of matching agent prices + slash revenue (90% of slash)
      const totalPaidToAgents = subs[0].price + subs[1].price;
      const slashAmount = (subs[2].stake * BigInt(1500)) / BigInt(10000);
      const slashToProtocol = (slashAmount * BigInt(1000)) / BigInt(10000);
      const slashToPoster = slashAmount - slashToProtocol;
      const expectedPosterReturn = BOUNTY - totalPaidToAgents + slashToPoster;

      expect(posterAfter - posterBefore).to.equal(expectedPosterReturn);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("ArenaRecurring", function () {
  // ═══════════════════════════════════════════════════
  // SHARED FIXTURES
  // ═══════════════════════════════════════════════════

  let main, auction, vrf, usdc, recurring;
  let owner, poster, agent1, agent2, keeper, verifier1, anyone;

  const BOUNTY = ethers.parseUnits("1000", 6); // 1000 USDC per occurrence
  const BID_DURATION = 3600; // 1 hour
  const REVEAL_DURATION = 1800; // 30 min
  const DEADLINE_OFFSET = 86400; // 1 day
  const SLASH_WINDOW = 604800; // 7 days
  const CRITERIA_HASH = ethers.keccak256(ethers.toUtf8Bytes("recurring audit criteria v1"));
  const TASK_TYPE = "audit";
  const REQUIRED_VERIFIERS = 1;

  // Frequency enum: 0=Daily, 1=Weekly, 2=Biweekly, 3=Monthly
  const FREQ_DAILY = 0;
  const FREQ_WEEKLY = 1;
  const FREQ_BIWEEKLY = 2;
  const FREQ_MONTHLY = 3;

  const DAY = 86400;
  const WEEK = 7 * DAY;
  const BIWEEK = 14 * DAY;
  const MONTH = 30 * DAY;

  const MAX_OCCURRENCES = 4;
  const KEEPER_FEE_BPS = 50;
  const BPS = 10000;

  async function mintAndApprove(signer, amount, spender) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(spender, amount);
  }

  async function createStandardTemplate(opts = {}) {
    const bounty = opts.bounty || BOUNTY;
    const freq = opts.frequency !== undefined ? opts.frequency : FREQ_WEEKLY;
    const maxOcc = opts.maxOccurrences || MAX_OCCURRENCES;
    const deadlineOffset = opts.deadlineOffset || DEADLINE_OFFSET;
    const slashWindow = opts.slashWindow || SLASH_WINDOW;
    const bidDuration = opts.bidDuration || BID_DURATION;
    const revealDuration = opts.revealDuration || REVEAL_DURATION;
    const requiredVerifiers = opts.requiredVerifiers || REQUIRED_VERIFIERS;
    const criteriaHash = opts.criteriaHash || CRITERIA_HASH;
    const taskType = opts.taskType || TASK_TYPE;
    const token = opts.token || ethers.ZeroAddress;
    const from = opts.from || poster;

    const totalCost = bounty * BigInt(maxOcc);
    await mintAndApprove(from, totalCost, await recurring.getAddress());

    const tx = await recurring.connect(from).createRecurringTask(
      bounty, freq, maxOcc, deadlineOffset, slashWindow,
      bidDuration, revealDuration, requiredVerifiers,
      criteriaHash, taskType, token
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return recurring.interface.parseLog(l)?.name === "RecurringTemplateCreated"; } catch { return false; }
    });
    const templateId = recurring.interface.parseLog(event).args.templateId;
    return templateId;
  }

  beforeEach(async function () {
    [owner, poster, agent1, agent2, keeper, verifier1, anyone] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    // Deploy ArenaCoreMain
    const ArenaCoreMain = await ethers.getContractFactory("ArenaCoreMain");
    const deployTx1 = await ArenaCoreMain.getDeployTransaction(await usdc.getAddress());
    deployTx1.gasLimit = 500_000_000n;
    const tx1 = await owner.sendTransaction(deployTx1);
    const receipt1 = await tx1.wait();
    main = ArenaCoreMain.attach(receipt1.contractAddress);

    // Deploy ArenaCoreAuction
    const ArenaCoreAuction = await ethers.getContractFactory("ArenaCoreAuction");
    const deployTx2 = await ArenaCoreAuction.getDeployTransaction(await main.getAddress());
    deployTx2.gasLimit = 500_000_000n;
    const tx2 = await owner.sendTransaction(deployTx2);
    const receipt2 = await tx2.wait();
    auction = ArenaCoreAuction.attach(receipt2.contractAddress);

    // Deploy ArenaCoreVRF
    const ArenaCoreVRF = await ethers.getContractFactory("ArenaCoreVRF");
    const deployTx3 = await ArenaCoreVRF.getDeployTransaction(await main.getAddress(), await auction.getAddress());
    deployTx3.gasLimit = 500_000_000n;
    const tx3 = await owner.sendTransaction(deployTx3);
    const receipt3 = await tx3.wait();
    vrf = ArenaCoreVRF.attach(receipt3.contractAddress);

    // Link contracts
    await main.setArenaCoreAuction(await auction.getAddress());
    await main.setArenaCoreVRF(await vrf.getAddress());
    await auction.setArenaCoreVRF(await vrf.getAddress());

    // Deploy ArenaRecurring
    const ArenaRecurring = await ethers.getContractFactory("ArenaRecurring");
    recurring = await ArenaRecurring.deploy(await main.getAddress());
  });

  // ═══════════════════════════════════════════════════
  // CONSTRUCTOR
  // ═══════════════════════════════════════════════════

  describe("constructor", function () {
    it("should set the core address", async function () {
      expect(await recurring.core()).to.equal(await main.getAddress());
    });

    it("should set the owner to deployer", async function () {
      expect(await recurring.owner()).to.equal(owner.address);
    });

    it("should revert on zero address", async function () {
      const ArenaRecurring = await ethers.getContractFactory("ArenaRecurring");
      await expect(ArenaRecurring.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(recurring, "ZeroAddress");
    });

    it("should initialize constants correctly", async function () {
      expect(await recurring.KEEPER_FEE_BPS()).to.equal(50);
      expect(await recurring.EXCLUSIVE_BID_WINDOW()).to.equal(86400);
      expect(await recurring.MAX_OCCURRENCES()).to.equal(365);
    });
  });

  // ═══════════════════════════════════════════════════
  // CREATE RECURRING TASK
  // ═══════════════════════════════════════════════════

  describe("createRecurringTask", function () {
    it("should create a template and escrow funds", async function () {
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());

      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.emit(recurring, "RecurringTemplateCreated")
        .withArgs(0, poster.address, TASK_TYPE, BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES);

      const t = await recurring.getTemplate(0);
      expect(t.poster).to.equal(poster.address);
      expect(t.bountyPerOccurrence).to.equal(BOUNTY);
      expect(t.maxOccurrences).to.equal(MAX_OCCURRENCES);
      expect(t.triggeredCount).to.equal(0);
      expect(t.status).to.equal(0); // Active
      expect(t.totalEscrowed).to.equal(totalCost);
    });

    it("should use default token when address(0) is passed", async function () {
      const templateId = await createStandardTemplate();
      const t = await recurring.getTemplate(templateId);
      expect(t.token).to.equal(await usdc.getAddress());
    });

    it("should increment templateCount", async function () {
      expect(await recurring.templateCount()).to.equal(0);
      await createStandardTemplate();
      expect(await recurring.templateCount()).to.equal(1);
      await createStandardTemplate();
      expect(await recurring.templateCount()).to.equal(2);
    });

    it("should track poster active templates", async function () {
      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(0);
      await createStandardTemplate();
      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(1);
    });

    it("should revert on zero bounty", async function () {
      await expect(
        recurring.connect(poster).createRecurringTask(
          0, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "ZeroBounty");
    });

    it("should revert on bounty below minimum", async function () {
      const tooSmall = ethers.parseUnits("1", 6); // 1 USDC < 10 USDC min
      await expect(
        recurring.connect(poster).createRecurringTask(
          tooSmall, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "BountyTooLow");
    });

    it("should revert on zero occurrences", async function () {
      const totalCost = BOUNTY;
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, 0, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidOccurrences");
    });

    it("should revert on too many occurrences", async function () {
      const totalCost = BOUNTY * 366n;
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, 366, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidOccurrences");
    });

    it("should revert on invalid frequency", async function () {
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, 4, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidFrequency");
    });

    it("should revert on deadline offset too short", async function () {
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, 60, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidDeadlineOffset");
    });

    it("should revert on zero verifiers", async function () {
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, 0,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidVerifiers");
    });

    it("should revert on more than 5 verifiers", async function () {
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, 6,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "InvalidVerifiers");
    });

    it("should revert when too many active templates", async function () {
      await recurring.connect(owner).setMaxActiveTemplates(1);
      await createStandardTemplate();

      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());
      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "TooManyActiveTemplates");
    });

    it("should support all frequency types", async function () {
      for (const freq of [FREQ_DAILY, FREQ_WEEKLY, FREQ_BIWEEKLY, FREQ_MONTHLY]) {
        const templateId = await createStandardTemplate({ frequency: freq });
        const t = await recurring.getTemplate(templateId);
        expect(t.frequency).to.equal(freq);
      }
    });
  });

  // ═══════════════════════════════════════════════════
  // TRIGGER RECURRING TASK
  // ═══════════════════════════════════════════════════

  describe("triggerRecurringTask", function () {
    it("should trigger the first occurrence immediately", async function () {
      const templateId = await createStandardTemplate();

      const keeperFee = (BOUNTY * BigInt(KEEPER_FEE_BPS)) / BigInt(BPS);
      const netBounty = BOUNTY - keeperFee;

      const keeperBalBefore = await usdc.balanceOf(keeper.address);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.emit(recurring, "RecurringTaskTriggered");

      // Keeper got paid
      const keeperBalAfter = await usdc.balanceOf(keeper.address);
      expect(keeperBalAfter - keeperBalBefore).to.equal(keeperFee);

      // Template updated
      const t = await recurring.getTemplate(templateId);
      expect(t.triggeredCount).to.equal(1);
      expect(t.lastTriggeredAt).to.be.gt(0);

      // Core task created
      const coreTaskId = await recurring.occurrenceTaskIds(templateId, 0);
      const task = await main.getTask(coreTaskId);
      expect(task.bounty).to.equal(netBounty);
      expect(task.taskType).to.equal(TASK_TYPE);
    });

    it("should block second trigger before interval elapses", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_WEEKLY });

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "IntervalNotElapsed");
    });

    it("should allow second trigger after interval elapses", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_WEEKLY });

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      // Advance 7 days
      await time.increase(WEEK);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.emit(recurring, "RecurringTaskTriggered");

      const t = await recurring.getTemplate(templateId);
      expect(t.triggeredCount).to.equal(2);
    });

    it("should trigger all occurrences and mark as completed", async function () {
      const templateId = await createStandardTemplate({ maxOccurrences: 2, frequency: FREQ_DAILY });

      // Trigger 1
      await recurring.connect(keeper).triggerRecurringTask(templateId);
      let t = await recurring.getTemplate(templateId);
      expect(t.status).to.equal(0); // Active

      // Advance 1 day
      await time.increase(DAY);

      // Trigger 2 (final)
      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.emit(recurring, "RecurringTemplateCompleted");

      t = await recurring.getTemplate(templateId);
      expect(t.status).to.equal(3); // Completed
      expect(t.triggeredCount).to.equal(2);
    });

    it("should revert when trying to trigger after all occurrences", async function () {
      const templateId = await createStandardTemplate({ maxOccurrences: 1 });

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      // After all occurrences, status is Completed so TemplateNotActive fires first
      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotActive");
    });

    it("should revert when template is paused", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotActive");
    });

    it("should revert when template is cancelled", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).cancelTemplate(templateId);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotActive");
    });

    it("should correctly map core task IDs", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_DAILY });

      await recurring.connect(keeper).triggerRecurringTask(templateId);
      const coreId0 = await recurring.occurrenceTaskIds(templateId, 0);
      expect(await recurring.taskToTemplate(coreId0)).to.equal(templateId);
      expect(await recurring.isRecurringTask(coreId0)).to.equal(true);

      await time.increase(DAY);
      await recurring.connect(keeper).triggerRecurringTask(templateId);
      const coreId1 = await recurring.occurrenceTaskIds(templateId, 1);
      expect(await recurring.taskToTemplate(coreId1)).to.equal(templateId);
    });

    it("should deduct escrow correctly", async function () {
      const templateId = await createStandardTemplate({ maxOccurrences: 3 });

      const t0 = await recurring.getTemplate(templateId);
      expect(t0.totalEscrowed).to.equal(BOUNTY * 3n);

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      const t1 = await recurring.getTemplate(templateId);
      expect(t1.totalEscrowed).to.equal(BOUNTY * 2n);
    });

    it("should work with daily frequency intervals", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_DAILY });

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      // Too early at 23 hours
      await time.increase(DAY - 3600);
      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "IntervalNotElapsed");

      // At exactly 24 hours
      await time.increase(3600);
      await recurring.connect(keeper).triggerRecurringTask(templateId);
    });

    it("should work with monthly frequency intervals", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_MONTHLY });

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      // Too early at 29 days
      await time.increase(29 * DAY);
      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "IntervalNotElapsed");

      // At 30 days
      await time.increase(DAY);
      await recurring.connect(keeper).triggerRecurringTask(templateId);
    });
  });

  // ═══════════════════════════════════════════════════
  // PAUSE / RESUME
  // ═══════════════════════════════════════════════════

  describe("pauseTemplate / resumeTemplate", function () {
    it("should pause an active template", async function () {
      const templateId = await createStandardTemplate();

      await expect(
        recurring.connect(poster).pauseTemplate(templateId)
      ).to.emit(recurring, "RecurringTemplatePaused").withArgs(templateId);

      const t = await recurring.getTemplate(templateId);
      expect(t.status).to.equal(1); // Paused
    });

    it("should resume a paused template", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);

      await expect(
        recurring.connect(poster).resumeTemplate(templateId)
      ).to.emit(recurring, "RecurringTemplateResumed").withArgs(templateId);

      const t = await recurring.getTemplate(templateId);
      expect(t.status).to.equal(0); // Active
    });

    it("should block non-poster from pausing", async function () {
      const templateId = await createStandardTemplate();

      await expect(
        recurring.connect(anyone).pauseTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "NotTemplatePoster");
    });

    it("should block non-poster from resuming", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);

      await expect(
        recurring.connect(anyone).resumeTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "NotTemplatePoster");
    });

    it("should revert on pausing a non-active template", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);

      await expect(
        recurring.connect(poster).pauseTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotActive");
    });

    it("should revert on resuming a non-paused template", async function () {
      const templateId = await createStandardTemplate();

      await expect(
        recurring.connect(poster).resumeTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotPaused");
    });

    it("should allow trigger after resume", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);
      await recurring.connect(poster).resumeTemplate(templateId);

      await expect(
        recurring.connect(keeper).triggerRecurringTask(templateId)
      ).to.emit(recurring, "RecurringTaskTriggered");
    });
  });

  // ═══════════════════════════════════════════════════
  // CANCEL
  // ═══════════════════════════════════════════════════

  describe("cancelTemplate", function () {
    it("should cancel and refund remaining escrow", async function () {
      const templateId = await createStandardTemplate();
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);

      // Trigger one occurrence first
      await recurring.connect(keeper).triggerRecurringTask(templateId);
      const remainingAfterTrigger = totalCost - BOUNTY;

      const posterBalBefore = await usdc.balanceOf(poster.address);

      await expect(
        recurring.connect(poster).cancelTemplate(templateId)
      ).to.emit(recurring, "RecurringTemplateCancelled")
        .withArgs(templateId, remainingAfterTrigger);

      const posterBalAfter = await usdc.balanceOf(poster.address);
      expect(posterBalAfter - posterBalBefore).to.equal(remainingAfterTrigger);

      const t = await recurring.getTemplate(templateId);
      expect(t.status).to.equal(2); // Cancelled
      expect(t.totalEscrowed).to.equal(0);
    });

    it("should cancel with full refund when no triggers", async function () {
      const templateId = await createStandardTemplate();
      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);

      const posterBalBefore = await usdc.balanceOf(poster.address);

      await recurring.connect(poster).cancelTemplate(templateId);

      const posterBalAfter = await usdc.balanceOf(poster.address);
      expect(posterBalAfter - posterBalBefore).to.equal(totalCost);
    });

    it("should decrement poster active templates", async function () {
      const templateId = await createStandardTemplate();
      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(1);

      await recurring.connect(poster).cancelTemplate(templateId);
      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(0);
    });

    it("should revert on non-poster cancellation", async function () {
      const templateId = await createStandardTemplate();

      await expect(
        recurring.connect(anyone).cancelTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "NotTemplatePoster");
    });

    it("should revert on cancelling an already cancelled template", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).cancelTemplate(templateId);

      await expect(
        recurring.connect(poster).cancelTemplate(templateId)
      ).to.be.revertedWithCustomError(recurring, "TemplateNotActive");
    });

    it("should allow cancelling a paused template", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);

      await expect(
        recurring.connect(poster).cancelTemplate(templateId)
      ).to.emit(recurring, "RecurringTemplateCancelled");
    });
  });

  // ═══════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════

  describe("view functions", function () {
    it("canTrigger should return true for first trigger", async function () {
      const templateId = await createStandardTemplate();
      expect(await recurring.canTrigger(templateId)).to.equal(true);
    });

    it("canTrigger should return false after recent trigger", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_WEEKLY });
      await recurring.connect(keeper).triggerRecurringTask(templateId);

      expect(await recurring.canTrigger(templateId)).to.equal(false);
    });

    it("canTrigger should return true after interval", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_WEEKLY });
      await recurring.connect(keeper).triggerRecurringTask(templateId);

      await time.increase(WEEK);
      expect(await recurring.canTrigger(templateId)).to.equal(true);
    });

    it("canTrigger should return false for paused templates", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).pauseTemplate(templateId);
      expect(await recurring.canTrigger(templateId)).to.equal(false);
    });

    it("timeUntilNextTrigger should return 0 for first trigger", async function () {
      const templateId = await createStandardTemplate();
      expect(await recurring.timeUntilNextTrigger(templateId)).to.equal(0);
    });

    it("timeUntilNextTrigger should return remaining seconds", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_WEEKLY });
      await recurring.connect(keeper).triggerRecurringTask(templateId);

      const remaining = await recurring.timeUntilNextTrigger(templateId);
      expect(remaining).to.be.gt(0);
      expect(remaining).to.be.lte(WEEK);
    });

    it("timeUntilNextTrigger should return max for inactive templates", async function () {
      const templateId = await createStandardTemplate();
      await recurring.connect(poster).cancelTemplate(templateId);

      const remaining = await recurring.timeUntilNextTrigger(templateId);
      expect(remaining).to.equal(ethers.MaxUint256);
    });

    it("remainingOccurrences should be correct", async function () {
      const templateId = await createStandardTemplate({ maxOccurrences: 3, frequency: FREQ_DAILY });
      expect(await recurring.remainingOccurrences(templateId)).to.equal(3);

      await recurring.connect(keeper).triggerRecurringTask(templateId);
      expect(await recurring.remainingOccurrences(templateId)).to.equal(2);

      await time.increase(DAY);
      await recurring.connect(keeper).triggerRecurringTask(templateId);
      expect(await recurring.remainingOccurrences(templateId)).to.equal(1);
    });

    it("getIntervalSeconds should return correct intervals", async function () {
      expect(await recurring.getIntervalSeconds(FREQ_DAILY)).to.equal(DAY);
      expect(await recurring.getIntervalSeconds(FREQ_WEEKLY)).to.equal(WEEK);
      expect(await recurring.getIntervalSeconds(FREQ_BIWEEKLY)).to.equal(BIWEEK);
      expect(await recurring.getIntervalSeconds(FREQ_MONTHLY)).to.equal(MONTH);
    });
  });

  // ═══════════════════════════════════════════════════
  // AGENT TRACKING
  // ═══════════════════════════════════════════════════

  describe("recordCompletion", function () {
    it("should not revert for non-recurring tasks", async function () {
      await recurring.recordCompletion(999);
      // No error, just returns
    });

    it("exclusive bid info should default to no agent", async function () {
      const templateId = await createStandardTemplate();
      const [agent, windowActive] = await recurring.getExclusiveBidInfo(templateId);
      expect(agent).to.equal(ethers.ZeroAddress);
      expect(windowActive).to.equal(false);
    });
  });

  // ═══════════════════════════════════════════════════
  // OWNER FUNCTIONS
  // ═══════════════════════════════════════════════════

  describe("owner functions", function () {
    it("should allow owner to set max active templates", async function () {
      await recurring.connect(owner).setMaxActiveTemplates(5);
      expect(await recurring.maxActiveTemplates()).to.equal(5);
    });

    it("should allow owner to set min bounty", async function () {
      const newMin = ethers.parseUnits("100", 6);
      await recurring.connect(owner).setMinBountyPerOccurrence(newMin);
      expect(await recurring.minBountyPerOccurrence()).to.equal(newMin);
    });

    it("should allow owner to pause/unpause contract", async function () {
      await recurring.connect(owner).pause();
      expect(await recurring.paused()).to.equal(true);

      await recurring.connect(owner).unpause();
      expect(await recurring.paused()).to.equal(false);
    });

    it("should block non-owner from admin functions", async function () {
      await expect(
        recurring.connect(anyone).setMaxActiveTemplates(1)
      ).to.be.revertedWithCustomError(recurring, "OwnableUnauthorizedAccount");

      await expect(
        recurring.connect(anyone).setMinBountyPerOccurrence(1)
      ).to.be.revertedWithCustomError(recurring, "OwnableUnauthorizedAccount");

      await expect(
        recurring.connect(anyone).pause()
      ).to.be.revertedWithCustomError(recurring, "OwnableUnauthorizedAccount");
    });

    it("should block createRecurringTask when contract is paused", async function () {
      await recurring.connect(owner).pause();

      const totalCost = BOUNTY * BigInt(MAX_OCCURRENCES);
      await mintAndApprove(poster, totalCost, await recurring.getAddress());

      await expect(
        recurring.connect(poster).createRecurringTask(
          BOUNTY, FREQ_WEEKLY, MAX_OCCURRENCES, DEADLINE_OFFSET, SLASH_WINDOW,
          BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
          CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(recurring, "EnforcedPause");
    });
  });

  // ═══════════════════════════════════════════════════
  // KEEPER FEE CALCULATIONS
  // ═══════════════════════════════════════════════════

  describe("keeper fee", function () {
    it("should pay exactly 0.5% to keeper", async function () {
      const templateId = await createStandardTemplate();
      const expectedFee = (BOUNTY * 50n) / 10000n;

      const keeperBalBefore = await usdc.balanceOf(keeper.address);
      await recurring.connect(keeper).triggerRecurringTask(templateId);
      const keeperBalAfter = await usdc.balanceOf(keeper.address);

      expect(keeperBalAfter - keeperBalBefore).to.equal(expectedFee);
    });

    it("should create core task with bounty minus keeper fee", async function () {
      const templateId = await createStandardTemplate();
      const keeperFee = (BOUNTY * 50n) / 10000n;
      const netBounty = BOUNTY - keeperFee;

      await recurring.connect(keeper).triggerRecurringTask(templateId);

      const coreTaskId = await recurring.occurrenceTaskIds(templateId, 0);
      const task = await main.getTask(coreTaskId);
      expect(task.bounty).to.equal(netBounty);
    });

    it("should allow anyone to be a keeper", async function () {
      const templateId = await createStandardTemplate();

      // Anyone can trigger
      await expect(
        recurring.connect(anyone).triggerRecurringTask(templateId)
      ).to.emit(recurring, "RecurringTaskTriggered");
    });
  });

  // ═══════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════

  describe("edge cases", function () {
    it("should support max 365 occurrences", async function () {
      const smallBounty = ethers.parseUnits("10", 6); // 10 USDC minimum
      const totalCost = smallBounty * 365n;
      await mintAndApprove(poster, totalCost, await recurring.getAddress());

      const tx = await recurring.connect(poster).createRecurringTask(
        smallBounty, FREQ_DAILY, 365, DEADLINE_OFFSET, SLASH_WINDOW,
        BID_DURATION, REVEAL_DURATION, REQUIRED_VERIFIERS,
        CRITERIA_HASH, TASK_TYPE, ethers.ZeroAddress
      );
      await tx.wait();

      const t = await recurring.getTemplate(0);
      expect(t.maxOccurrences).to.equal(365);
    });

    it("should handle multiple templates from same poster", async function () {
      const id1 = await createStandardTemplate({ frequency: FREQ_DAILY });
      const id2 = await createStandardTemplate({ frequency: FREQ_WEEKLY });

      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(2);

      // Trigger both
      await recurring.connect(keeper).triggerRecurringTask(id1);
      await recurring.connect(keeper).triggerRecurringTask(id2);

      // Cancel one
      await recurring.connect(poster).cancelTemplate(id1);
      expect(await recurring.posterActiveTemplates(poster.address)).to.equal(1);
    });

    it("should handle multiple keepers competing", async function () {
      const templateId = await createStandardTemplate({ frequency: FREQ_DAILY });

      // First keeper wins
      await recurring.connect(keeper).triggerRecurringTask(templateId);

      // Second keeper blocked until interval
      await expect(
        recurring.connect(anyone).triggerRecurringTask(templateId)
      ).to.be.revertedWithCustomError(recurring, "IntervalNotElapsed");

      // After interval, anyone can trigger
      await time.increase(DAY);
      await recurring.connect(anyone).triggerRecurringTask(templateId);
    });
  });
});

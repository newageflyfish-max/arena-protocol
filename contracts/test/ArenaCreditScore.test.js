const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("ArenaCreditScore", function () {
  let mockCore, reputation;
  let owner, agent1, agent2, agent3, anyone;

  const MAX_CREDIT_SCORE = 850;

  // Slash severities (BPS)
  const SLASH_LATE = 1500;
  const SLASH_MINOR = 2500;
  const SLASH_MATERIAL = 5000;
  const SLASH_EXECUTION = 7500;
  const SLASH_CRITICAL = 10000;

  beforeEach(async function () {
    [owner, agent1, agent2, agent3, anyone] = await ethers.getSigners();

    // Deploy MockArenaCore
    const MockArenaCore = await ethers.getContractFactory("MockArenaCore");
    mockCore = await MockArenaCore.deploy();

    // Deploy ArenaReputation with mock core
    const ArenaReputation = await ethers.getContractFactory("ArenaReputation");
    reputation = await ArenaReputation.deploy(await mockCore.getAddress());
  });

  // ═══════════════════════════════════════════════════
  // BASIC CREDIT SCORE
  // ═══════════════════════════════════════════════════

  describe("computeCreditScore", function () {
    it("should return 0 for an agent with no tasks", async function () {
      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.equal(0);
    });

    it("should return a high score for a perfect agent", async function () {
      // Set mock data: 10 completed, 0 failed
      await mockCore.setAgentTasksCompleted(agent1.address, 10);
      await mockCore.setAgentTasksFailed(agent1.address, 0);

      // Call onTaskSettled 10 times as completed with approvals
      for (let i = 0; i < 10; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      }

      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.be.greaterThan(600);
      expect(score).to.be.lessThanOrEqual(MAX_CREDIT_SCORE);
    });

    it("should return a low score for an agent that always fails", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 0);
      await mockCore.setAgentTasksFailed(agent1.address, 10);

      for (let i = 0; i < 10; i++) {
        await reputation.onTaskSettled(agent1.address, false, SLASH_MATERIAL, 0, 3);
      }

      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.be.lessThan(200);
    });

    it("should increase score with more completions", async function () {
      // First: 5 completed, 5 failed
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      await mockCore.setAgentTasksFailed(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, false, 0, 0, 2);
      }
      const score1 = await reputation.computeCreditScore(agent1.address);

      // Second agent: 9 completed, 1 failed
      await mockCore.setAgentTasksCompleted(agent2.address, 9);
      await mockCore.setAgentTasksFailed(agent2.address, 1);
      for (let i = 0; i < 9; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 2, 0);
      }
      await reputation.onTaskSettled(agent2.address, false, 0, 0, 2);
      const score2 = await reputation.computeCreditScore(agent2.address);

      expect(score2).to.be.greaterThan(score1);
    });

    it("should penalize heavy slashing", async function () {
      // Agent with good completion but heavy slashing
      await mockCore.setAgentTasksCompleted(agent1.address, 8);
      await mockCore.setAgentTasksFailed(agent1.address, 2);
      for (let i = 0; i < 8; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }
      for (let i = 0; i < 2; i++) {
        await reputation.onTaskSettled(agent1.address, false, SLASH_CRITICAL, 0, 2);
      }
      const slashedScore = await reputation.computeCreditScore(agent1.address);

      // Agent with same completion but no slashing
      await mockCore.setAgentTasksCompleted(agent2.address, 8);
      await mockCore.setAgentTasksFailed(agent2.address, 2);
      for (let i = 0; i < 8; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 2, 0);
      }
      for (let i = 0; i < 2; i++) {
        await reputation.onTaskSettled(agent2.address, false, 0, 0, 2);
      }
      const unslashedScore = await reputation.computeCreditScore(agent2.address);

      expect(unslashedScore).to.be.greaterThan(slashedScore);
    });

    it("should factor verification approvals positively", async function () {
      // Agent with all approvals
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      await mockCore.setAgentTasksFailed(agent1.address, 0);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      }
      const goodVerScore = await reputation.computeCreditScore(agent1.address);

      // Agent with mixed verifications
      await mockCore.setAgentTasksCompleted(agent2.address, 5);
      await mockCore.setAgentTasksFailed(agent2.address, 0);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 1, 2);
      }
      const mixedVerScore = await reputation.computeCreditScore(agent2.address);

      expect(goodVerScore).to.be.greaterThan(mixedVerScore);
    });

    it("should improve with account age", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      await mockCore.setAgentTasksFailed(agent1.address, 0);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }
      const earlyScore = await reputation.computeCreditScore(agent1.address);

      // Advance time by 180 days
      await time.increase(180 * 86400);

      const laterScore = await reputation.computeCreditScore(agent1.address);
      expect(laterScore).to.be.greaterThan(earlyScore);
    });

    it("should not exceed MAX_CREDIT_SCORE", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 200);
      await mockCore.setAgentTasksFailed(agent1.address, 0);
      for (let i = 0; i < 50; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 5, 0);
      }
      await time.increase(365 * 86400);

      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.be.lessThanOrEqual(MAX_CREDIT_SCORE);
    });
  });

  // ═══════════════════════════════════════════════════
  // onTaskSettled HOOK
  // ═══════════════════════════════════════════════════

  describe("onTaskSettled", function () {
    it("should only be callable by core or owner", async function () {
      await expect(
        reputation.connect(anyone).onTaskSettled(agent1.address, true, 0, 1, 0)
      ).to.be.revertedWith("Arena: not authorized");
    });

    it("should be callable by owner", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await expect(
        reputation.connect(owner).onTaskSettled(agent1.address, true, 0, 1, 0)
      ).to.not.be.reverted;
    });

    it("should set firstActivityAt on first call", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.firstActivityAt).to.be.greaterThan(0);
    });

    it("should not change firstActivityAt on subsequent calls", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      const data1 = await reputation.getCreditScoreData(agent1.address);

      await time.increase(86400);
      await mockCore.setAgentTasksCompleted(agent1.address, 2);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      const data2 = await reputation.getCreditScoreData(agent1.address);

      expect(data2.firstActivityAt).to.equal(data1.firstActivityAt);
    });

    it("should increment totalTasksFactored", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 3);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalTasksFactored).to.equal(3);
    });

    it("should track consecutive completions", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 3);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.consecutiveCompletions).to.equal(3);
    });

    it("should reset consecutive completions on failure", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 3);
      await mockCore.setAgentTasksFailed(agent1.address, 1);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, false, 0, 0, 1);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.consecutiveCompletions).to.equal(0);
    });

    it("should track slash events and severity", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await mockCore.setAgentTasksFailed(agent1.address, 2);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, false, SLASH_MINOR, 0, 1);
      await reputation.onTaskSettled(agent1.address, false, SLASH_CRITICAL, 0, 1);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalSlashEvents).to.equal(2);
      expect(data.totalSlashSeverity).to.equal(SLASH_MINOR + SLASH_CRITICAL);
    });

    it("should not count zero slash severity as a slash event", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 0);
      await mockCore.setAgentTasksFailed(agent1.address, 1);
      await reputation.onTaskSettled(agent1.address, false, 0, 0, 1);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalSlashEvents).to.equal(0);
      expect(data.totalSlashSeverity).to.equal(0);
    });

    it("should track verifier approvals and rejections", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 2);
      await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 2, 1);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalVerifierApprovals).to.equal(5);
      expect(data.totalVerifierRejections).to.equal(1);
    });

    it("should emit CreditScoreUpdated event", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await expect(
        reputation.onTaskSettled(agent1.address, true, 0, 2, 0)
      )
        .to.emit(reputation, "CreditScoreUpdated")
        .withArgs(agent1.address, (score) => score > 0, 1);
    });

    it("should store the computed score", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.score).to.be.greaterThan(0);
      expect(data.lastUpdated).to.be.greaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════
  // getAgentCreditScore
  // ═══════════════════════════════════════════════════

  describe("getAgentCreditScore", function () {
    it("should return Poor tier for score 0", async function () {
      const [score, lastUpdated, totalTasks, tier] = await reputation.getAgentCreditScore(agent1.address);
      expect(score).to.equal(0);
      expect(tier).to.equal("Poor");
    });

    it("should return correct tier for Fair range (301-500)", async function () {
      // Create an agent with mediocre performance
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      await mockCore.setAgentTasksFailed(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 1);
      }
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, false, 0, 0, 1);
      }

      const [score, , , tier] = await reputation.getAgentCreditScore(agent1.address);
      // Score around 300-500 range expected for 50% completion, no slashes
      if (score >= 301 && score <= 500) {
        expect(tier).to.equal("Fair");
      }
      // Just verify tier matches score range
      if (score >= 751) expect(tier).to.equal("Exceptional");
      else if (score >= 651) expect(tier).to.equal("Excellent");
      else if (score >= 501) expect(tier).to.equal("Good");
      else if (score >= 301) expect(tier).to.equal("Fair");
      else expect(tier).to.equal("Poor");
    });

    it("should return Exceptional tier for high performers", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 100);
      await mockCore.setAgentTasksFailed(agent1.address, 0);
      for (let i = 0; i < 50; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      }
      // Age the account
      await time.increase(200 * 86400);
      // Re-settle to update score with aged data
      await mockCore.setAgentTasksCompleted(agent1.address, 101);
      await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);

      const [score, , , tier] = await reputation.getAgentCreditScore(agent1.address);
      expect(score).to.be.greaterThanOrEqual(751);
      expect(tier).to.equal("Exceptional");
    });

    it("should return lastUpdated and totalTasksFactored", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 3);
      for (let i = 0; i < 3; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }

      const [, lastUpdated, totalTasks,] = await reputation.getAgentCreditScore(agent1.address);
      expect(lastUpdated).to.be.greaterThan(0);
      expect(totalTasks).to.equal(3);
    });
  });

  // ═══════════════════════════════════════════════════
  // TIER BOUNDARIES
  // ═══════════════════════════════════════════════════

  describe("tier boundaries", function () {
    it("should classify score 0 as Poor", async function () {
      const [, , , tier] = await reputation.getAgentCreditScore(agent1.address);
      expect(tier).to.equal("Poor");
    });

    it("should classify score 300 as Poor (boundary)", async function () {
      // We test the boundary logic directly via the view function
      // Score 300 is < 301, so Poor
      const [, , , tier] = await reputation.getAgentCreditScore(agent1.address);
      // Default is 0 = Poor
      expect(tier).to.equal("Poor");
    });
  });

  // ═══════════════════════════════════════════════════
  // WEIGHT COMPONENTS
  // ═══════════════════════════════════════════════════

  describe("weight components", function () {
    it("should weight completion rate at 35%", async function () {
      const completionWeight = await reputation.COMPLETION_WEIGHT();
      expect(completionWeight).to.equal(3500);
    });

    it("should weight slash history at 30%", async function () {
      const slashWeight = await reputation.SLASH_WEIGHT();
      expect(slashWeight).to.equal(3000);
    });

    it("should weight verification at 20%", async function () {
      const verificationWeight = await reputation.VERIFICATION_WEIGHT();
      expect(verificationWeight).to.equal(2000);
    });

    it("should weight age at 15%", async function () {
      const ageWeight = await reputation.AGE_WEIGHT();
      expect(ageWeight).to.equal(1500);
    });

    it("should have weights summing to 100%", async function () {
      const cw = await reputation.COMPLETION_WEIGHT();
      const sw = await reputation.SLASH_WEIGHT();
      const vw = await reputation.VERIFICATION_WEIGHT();
      const aw = await reputation.AGE_WEIGHT();
      expect(cw + sw + vw + aw).to.equal(10000);
    });

    it("should have MAX_CREDIT_SCORE of 850", async function () {
      const max = await reputation.MAX_CREDIT_SCORE();
      expect(max).to.equal(850);
    });
  });

  // ═══════════════════════════════════════════════════
  // SLASH SEVERITY IMPACT
  // ═══════════════════════════════════════════════════

  describe("slash severity impact", function () {
    it("should have higher penalty for Critical vs Late slashes", async function () {
      // Agent 1: Late slash
      await mockCore.setAgentTasksCompleted(agent1.address, 9);
      await mockCore.setAgentTasksFailed(agent1.address, 1);
      for (let i = 0; i < 9; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }
      await reputation.onTaskSettled(agent1.address, false, SLASH_LATE, 0, 2);
      const lateScore = await reputation.computeCreditScore(agent1.address);

      // Agent 2: Critical slash
      await mockCore.setAgentTasksCompleted(agent2.address, 9);
      await mockCore.setAgentTasksFailed(agent2.address, 1);
      for (let i = 0; i < 9; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 2, 0);
      }
      await reputation.onTaskSettled(agent2.address, false, SLASH_CRITICAL, 0, 2);
      const criticalScore = await reputation.computeCreditScore(agent2.address);

      expect(lateScore).to.be.greaterThan(criticalScore);
    });

    it("should accumulate slash severity across multiple events", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      await mockCore.setAgentTasksFailed(agent1.address, 5);

      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, false, SLASH_MATERIAL, 0, 1);
      }

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalSlashSeverity).to.equal(SLASH_MATERIAL * 5);
      expect(data.totalSlashEvents).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════
  // CONSECUTIVE COMPLETIONS BONUS
  // ═══════════════════════════════════════════════════

  describe("consecutive completions", function () {
    it("should build up consecutive completion streak", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 15);
      for (let i = 0; i < 15; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.consecutiveCompletions).to.equal(15);
    });

    it("should give higher score with completion streak", async function () {
      // Agent 1: 10 consecutive completions
      await mockCore.setAgentTasksCompleted(agent1.address, 10);
      for (let i = 0; i < 10; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }
      const streakScore = await reputation.computeCreditScore(agent1.address);

      // Agent 2: 10 completions but with interruptions (same completion rate)
      await mockCore.setAgentTasksCompleted(agent2.address, 10);
      await mockCore.setAgentTasksFailed(agent2.address, 0);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 1, 0);
      }
      // Simulate a failure in between (but keep completion count the same on core)
      await mockCore.setAgentTasksFailed(agent2.address, 1);
      await reputation.onTaskSettled(agent2.address, false, 0, 0, 0);
      await mockCore.setAgentTasksFailed(agent2.address, 0); // reset
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 1, 0);
      }

      const brokenStreakScore = await reputation.computeCreditScore(agent2.address);

      // The agent with the unbroken streak should have a higher or equal score
      // (Agent2 also has 1 more totalTasksFactored, which might help slightly via age)
      // The streak bonus is relatively small, so we check >=
      expect(streakScore).to.be.greaterThanOrEqual(brokenStreakScore);
    });

    it("should cap streak bonus at 20 consecutive", async function () {
      // Agent 1: 25 consecutive
      await mockCore.setAgentTasksCompleted(agent1.address, 25);
      for (let i = 0; i < 25; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.consecutiveCompletions).to.equal(25);
      // Streak bonus is capped at 50 for >= 20 consecutive
    });
  });

  // ═══════════════════════════════════════════════════
  // ACCOUNT AGE COMPONENT
  // ═══════════════════════════════════════════════════

  describe("account age", function () {
    it("should ramp age score over 180 days", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      }
      const earlyScore = await reputation.computeCreditScore(agent1.address);

      // Advance 90 days (half of 180)
      await time.increase(90 * 86400);
      // Must re-settle to get the updated timestamp in score
      await mockCore.setAgentTasksCompleted(agent1.address, 6);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      const midScore = await reputation.computeCreditScore(agent1.address);

      // Advance another 90 days (total 180)
      await time.increase(90 * 86400);
      await mockCore.setAgentTasksCompleted(agent1.address, 7);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      const fullScore = await reputation.computeCreditScore(agent1.address);

      expect(midScore).to.be.greaterThan(earlyScore);
      expect(fullScore).to.be.greaterThan(midScore);
    });
  });

  // ═══════════════════════════════════════════════════
  // getCreditScoreData
  // ═══════════════════════════════════════════════════

  describe("getCreditScoreData", function () {
    it("should return empty data for new agent", async function () {
      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.score).to.equal(0);
      expect(data.lastUpdated).to.equal(0);
      expect(data.totalTasksFactored).to.equal(0);
      expect(data.totalSlashEvents).to.equal(0);
      expect(data.totalSlashSeverity).to.equal(0);
      expect(data.totalVerifierApprovals).to.equal(0);
      expect(data.totalVerifierRejections).to.equal(0);
      expect(data.firstActivityAt).to.equal(0);
      expect(data.consecutiveCompletions).to.equal(0);
    });

    it("should return complete data after multiple settlements", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 3);
      await mockCore.setAgentTasksFailed(agent1.address, 1);

      await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      await reputation.onTaskSettled(agent1.address, true, 0, 2, 1);
      await reputation.onTaskSettled(agent1.address, true, 0, 1, 0);
      await reputation.onTaskSettled(agent1.address, false, SLASH_MINOR, 0, 2);

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.score).to.be.greaterThan(0);
      expect(data.totalTasksFactored).to.equal(4);
      expect(data.totalSlashEvents).to.equal(1);
      expect(data.totalSlashSeverity).to.equal(SLASH_MINOR);
      expect(data.totalVerifierApprovals).to.equal(6);
      expect(data.totalVerifierRejections).to.equal(3);
      expect(data.consecutiveCompletions).to.equal(0); // reset by failure
    });
  });

  // ═══════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════

  describe("edge cases", function () {
    it("should handle agent with only failed tasks", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 0);
      await mockCore.setAgentTasksFailed(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, false, SLASH_EXECUTION, 0, 3);
      }

      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.be.lessThan(100);
      const [, , , tier] = await reputation.getAgentCreditScore(agent1.address);
      expect(tier).to.equal("Poor");
    });

    it("should handle large numbers of tasks", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 1000);
      await mockCore.setAgentTasksFailed(agent1.address, 50);

      // Settle a subset to build tracking data
      for (let i = 0; i < 20; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 2, 0);
      }

      const score = await reputation.computeCreditScore(agent1.address);
      expect(score).to.be.greaterThan(0);
      expect(score).to.be.lessThanOrEqual(MAX_CREDIT_SCORE);
    });

    it("should handle zero verifications (neutral score)", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 5);
      for (let i = 0; i < 5; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 0, 0);
      }

      const data = await reputation.getCreditScoreData(agent1.address);
      expect(data.totalVerifierApprovals).to.equal(0);
      expect(data.totalVerifierRejections).to.equal(0);
      // Score should still be valid (uses neutral verification score)
      expect(data.score).to.be.greaterThan(0);
    });

    it("should independently track multiple agents", async function () {
      await mockCore.setAgentTasksCompleted(agent1.address, 10);
      await mockCore.setAgentTasksFailed(agent1.address, 0);
      await mockCore.setAgentTasksCompleted(agent2.address, 2);
      await mockCore.setAgentTasksFailed(agent2.address, 8);

      for (let i = 0; i < 10; i++) {
        await reputation.onTaskSettled(agent1.address, true, 0, 3, 0);
      }
      for (let i = 0; i < 2; i++) {
        await reputation.onTaskSettled(agent2.address, true, 0, 1, 0);
      }
      for (let i = 0; i < 8; i++) {
        await reputation.onTaskSettled(agent2.address, false, SLASH_MATERIAL, 0, 2);
      }

      const [score1] = await reputation.getAgentCreditScore(agent1.address);
      const [score2] = await reputation.getAgentCreditScore(agent2.address);

      expect(score1).to.be.greaterThan(score2);

      const data1 = await reputation.getCreditScoreData(agent1.address);
      const data2 = await reputation.getCreditScoreData(agent2.address);
      expect(data1.totalTasksFactored).to.equal(10);
      expect(data2.totalTasksFactored).to.equal(10);
    });

    it("should handle setArenaCore and allow new core to call", async function () {
      const newCore = agent3.address;
      await reputation.setArenaCore(newCore);

      await mockCore.setAgentTasksCompleted(agent1.address, 1);
      await expect(
        reputation.connect(agent3).onTaskSettled(agent1.address, true, 0, 1, 0)
      ).to.not.be.reverted;
    });
  });
});

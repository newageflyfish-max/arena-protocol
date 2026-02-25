import { Router } from 'express';
import { ethers } from 'ethers';
import { arenaCore, arenaProfiles, formatUsdc, PROFILE_TYPE_LABELS, provider } from '../chain.js';
import { config } from '../config.js';
import { addressSchema, paginationSchema } from '../schemas.js';
import { Errors, sendError } from '../errors.js';

const router = Router();

/**
 * GET /agents
 * List agents with reputation scores.
 * Discovers agents from AgentAssigned events, deduplicates, and returns stats.
 */
router.get('/', async (req, res) => {
  try {
    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      sendError(res, Errors.badRequest('Invalid pagination parameters'));
      return;
    }

    const { offset, limit } = pageResult.data;

    // Discover agents from AgentAssigned events
    const filter = arenaCore.filters.AgentAssigned();
    const logs = await arenaCore.queryFilter(filter, 0, 'latest');

    const uniqueAgents = new Set<string>();
    for (const log of logs) {
      const parsed = arenaCore.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed) {
        uniqueAgents.add(parsed.args.agent as string);
      }
    }

    const allAgents = Array.from(uniqueAgents);
    const total = allAgents.length;
    const page = allAgents.slice(offset, offset + limit);

    // Fetch stats in parallel
    const agents = await Promise.all(
      page.map(async (addr) => {
        const [reputation, completed, failed, activeStake, banned] =
          await Promise.all([
            arenaCore.agentReputation(addr),
            arenaCore.agentTasksCompleted(addr),
            arenaCore.agentTasksFailed(addr),
            arenaCore.agentActiveStake(addr),
            arenaCore.agentBanned(addr),
          ]);

        const total = Number(completed) + Number(failed);
        const winRate =
          total > 0
            ? ((Number(completed) / total) * 100).toFixed(1)
            : '0.0';

        // Try to get profile
        let profile = null;
        try {
          const p = await arenaProfiles.getProfile(addr);
          if (p.exists) {
            profile = {
              displayName: p.displayName,
              profileType: PROFILE_TYPE_LABELS[Number(p.profileType)] ?? 'unknown',
            };
          }
        } catch {
          // profiles contract may not be deployed
        }

        return {
          address: addr,
          reputation: Number(reputation),
          tasksCompleted: Number(completed),
          tasksFailed: Number(failed),
          winRate: `${winRate}%`,
          activeStake: formatUsdc(activeStake),
          banned,
          profile,
        };
      }),
    );

    // Sort by reputation descending
    agents.sort((a, b) => b.reputation - a.reputation);

    res.json({
      agents,
      pagination: {
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
      },
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

/**
 * GET /agents/:address/profile
 * Get detailed agent profile and on-chain stats.
 */
router.get('/:address/profile', async (req, res) => {
  try {
    const addrResult = addressSchema.safeParse(req.params.address);
    if (!addrResult.success) {
      sendError(res, Errors.badRequest('Invalid Ethereum address'));
      return;
    }

    const addr = addrResult.data;

    // Fetch all stats in parallel
    const [reputation, completed, failed, activeStake, banned] =
      await Promise.all([
        arenaCore.agentReputation(addr),
        arenaCore.agentTasksCompleted(addr),
        arenaCore.agentTasksFailed(addr),
        arenaCore.agentActiveStake(addr),
        arenaCore.agentBanned(addr),
      ]);

    const total = Number(completed) + Number(failed);
    const winRate =
      total > 0 ? ((Number(completed) / total) * 100).toFixed(1) : '0.0';

    // Fetch profile
    let profile = null;
    try {
      const p = await arenaProfiles.getProfile(addr);
      if (p.exists) {
        profile = {
          displayName: p.displayName,
          bio: p.bio,
          websiteUrl: p.websiteUrl,
          profileType: PROFILE_TYPE_LABELS[Number(p.profileType)] ?? 'unknown',
          avatarHash: p.avatarHash,
          createdAt: Number(p.createdAt),
          updatedAt: Number(p.updatedAt),
        };
      }
    } catch {
      // profiles contract may not be deployed
    }

    // Fetch recent task history from events
    const completedFilter = arenaCore.filters.TaskCompleted(null, addr);
    const completedLogs = await arenaCore.queryFilter(
      completedFilter,
      0,
      'latest',
    );

    const taskHistory = completedLogs.slice(-20).reverse().map((log) => {
      const parsed = arenaCore.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      return {
        taskId: parsed?.args.taskId?.toString() ?? 'unknown',
        payout: parsed ? formatUsdc(parsed.args.payout) : '0',
        blockNumber: log.blockNumber,
      };
    });

    // Compute total earnings
    let totalEarnings = BigInt(0);
    for (const log of completedLogs) {
      const parsed = arenaCore.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed) {
        totalEarnings += parsed.args.payout;
      }
    }

    // Reputation tier
    const repScore = Number(reputation);
    let tier = 'Novice';
    if (repScore >= 5000) tier = 'Diamond';
    else if (repScore >= 1000) tier = 'Gold';
    else if (repScore >= 500) tier = 'Silver';
    else if (repScore >= 100) tier = 'Bronze';

    res.json({
      address: addr,
      profile,
      stats: {
        reputation: repScore,
        tier,
        tasksCompleted: Number(completed),
        tasksFailed: Number(failed),
        winRate: `${winRate}%`,
        activeStake: formatUsdc(activeStake),
        totalEarnings: formatUsdc(totalEarnings),
        banned,
      },
      recentTasks: taskHistory,
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

export default router;

import { Router } from 'express';
import { provider, arenaCore } from '../chain.js';

const router = Router();

/**
 * GET /health
 * Health check — returns API status, RPC connectivity, and block number.
 */
router.get('/', async (_req, res) => {
  try {
    const blockNumber = await provider.getBlockNumber();
    const taskCount = await arenaCore.taskCount();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      chain: {
        blockNumber,
        rpcConnected: true,
      },
      protocol: {
        totalTasks: Number(taskCount),
      },
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      chain: {
        rpcConnected: false,
      },
    });
  }
});

export default router;

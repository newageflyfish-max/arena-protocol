import { Router } from 'express';
import { ethers } from 'ethers';
import { requireApiKey } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { createTaskSchema, taskIdSchema } from '../schemas.js';
import { arenaCore, usdcToken, formatUsdc, signer } from '../chain.js';
import { config } from '../config.js';
import { TASK_STATUS_MAP } from '../types.js';
import { Errors, sendError } from '../errors.js';

const router = Router();

/**
 * GET /tasks/:id
 * Get task details by ID. Public endpoint — no auth required.
 */
router.get('/:id', async (req, res) => {
  try {
    const idResult = taskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      sendError(res, Errors.badRequest('Invalid task ID'));
      return;
    }

    const taskId = idResult.data;
    const taskCount = await arenaCore.taskCount();

    if (taskId >= Number(taskCount)) {
      sendError(res, Errors.notFound('Task'));
      return;
    }

    const task = await arenaCore.getTask(taskId);
    const assignment = await arenaCore.getAssignment(taskId);

    const statusNum = Number(task.status);
    const hasAgent =
      assignment.agent !== ethers.ZeroAddress;

    const response: Record<string, unknown> = {
      id: taskId,
      poster: task.poster,
      token: task.token,
      bounty: formatUsdc(task.bounty),
      deadline: Number(task.deadline),
      deadlineISO: new Date(Number(task.deadline) * 1000).toISOString(),
      slashWindow: Number(task.slashWindow),
      createdAt: Number(task.createdAt),
      bidDeadline: Number(task.bidDeadline),
      revealDeadline: Number(task.revealDeadline),
      requiredVerifiers: Number(task.requiredVerifiers),
      status: TASK_STATUS_MAP[statusNum] ?? 'unknown',
      statusCode: statusNum,
      criteriaHash: task.criteriaHash,
      taskType: task.taskType,
    };

    if (hasAgent) {
      response.assignment = {
        agent: assignment.agent,
        stake: formatUsdc(assignment.stake),
        price: formatUsdc(assignment.price),
        assignedAt: Number(assignment.assignedAt),
        deliveredAt: Number(assignment.deliveredAt),
        outputHash: assignment.outputHash,
      };
    }

    res.json(response);
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

/**
 * POST /tasks
 * Create a new task. Requires API key auth.
 * The server-side signer must have USDC balance and will call approve + createTask.
 */
router.post(
  '/',
  requireApiKey,
  validateBody(createTaskSchema),
  async (req, res) => {
    try {
      if (!signer) {
        sendError(
          res,
          Errors.internal('Server signer not configured. Cannot create tasks.'),
        );
        return;
      }

      const input = req.body;
      const bountyWei = ethers.parseUnits(input.bounty, 6);
      const deadlineTs = BigInt(
        Math.floor(new Date(input.deadline).getTime() / 1000),
      );
      const slashWindow = BigInt(input.slashWindowHours * 3600);
      const bidDuration = BigInt(input.bidDurationHours * 3600);
      const revealDuration = BigInt(input.revealDurationHours * 3600);
      const criteriaHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(input.criteria)),
      );

      // Approve USDC
      const currentAllowance = await usdcToken.allowance(
        await signer.getAddress(),
        config.arenaCoreAddress,
      );

      if (currentAllowance < bountyWei) {
        const approveTx = await usdcToken.approve(
          config.arenaCoreAddress,
          bountyWei,
        );
        await approveTx.wait();
      }

      // Create task
      const tx = await arenaCore.createTask(
        bountyWei,
        deadlineTs,
        slashWindow,
        bidDuration,
        revealDuration,
        input.requiredVerifiers,
        criteriaHash,
        input.taskType,
        config.usdcAddress,
      );

      const receipt = await tx.wait();

      // Extract taskId from event logs
      let taskId: string | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = arenaCore.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'TaskCreated') {
            taskId = parsed.args.taskId.toString();
            break;
          }
        } catch {
          // skip non-matching logs
        }
      }

      res.status(201).json({
        taskId,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        status: 'open',
        bounty: input.bounty,
        taskType: input.taskType,
        deadline: input.deadline,
      });
    } catch (err) {
      sendError(res, err instanceof Error ? err : Errors.internal());
    }
  },
);

export default router;

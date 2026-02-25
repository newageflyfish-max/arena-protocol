import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import { requireApiKey } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { createWebhookSchema } from '../schemas.js';
import { createWebhook, getWebhooksByOwner, deleteWebhook } from '../storage.js';
import type { WebhookRecord } from '../types.js';
import { Errors, sendError } from '../errors.js';

const router = Router();

/**
 * POST /webhooks
 * Register a webhook URL to receive task lifecycle events.
 * Requires API key auth.
 */
router.post(
  '/',
  requireApiKey,
  validateBody(createWebhookSchema),
  async (req, res) => {
    try {
      const owner = req.apiKeyOwner!;
      const input = req.body;

      // Limit webhooks per owner
      const existing = getWebhooksByOwner(owner);
      if (existing.length >= 10) {
        sendError(
          res,
          Errors.badRequest('Maximum 10 webhooks per account'),
        );
        return;
      }

      const secret = crypto.randomBytes(32).toString('hex');

      const record: WebhookRecord = {
        id: uuidv4(),
        owner,
        url: input.url,
        events: input.events,
        createdAt: new Date().toISOString(),
        active: true,
        secret,
      };

      createWebhook(record);

      res.status(201).json({
        id: record.id,
        url: record.url,
        events: record.events,
        createdAt: record.createdAt,
        secret: record.secret,
      });
    } catch (err) {
      sendError(res, err instanceof Error ? err : Errors.internal());
    }
  },
);

/**
 * GET /webhooks
 * List all webhooks for the authenticated user.
 */
router.get('/', requireApiKey, async (req, res) => {
  try {
    const owner = req.apiKeyOwner!;
    const hooks = getWebhooksByOwner(owner);

    res.json({
      webhooks: hooks.map((h) => ({
        id: h.id,
        url: h.url,
        events: h.events,
        active: h.active,
        createdAt: h.createdAt,
      })),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

/**
 * DELETE /webhooks/:id
 * Delete a webhook. Requires API key auth. Only owner can delete.
 */
router.delete('/:id', requireApiKey, async (req, res) => {
  try {
    const owner = req.apiKeyOwner!;
    const deleted = deleteWebhook(req.params.id, owner);

    if (!deleted) {
      sendError(res, Errors.notFound('Webhook'));
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

export default router;

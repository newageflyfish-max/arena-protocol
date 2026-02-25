import { Router } from 'express';
import crypto from 'node:crypto';
import { validateBody } from '../middleware/validate.js';
import { createApiKeySchema } from '../schemas.js';
import { createApiKey, getApiKeysByOwner, revokeApiKey } from '../storage.js';
import type { ApiKeyRecord } from '../types.js';
import { Errors, sendError } from '../errors.js';

const router = Router();

/**
 * POST /api-keys
 * Generate a new API key for a wallet address.
 * NOTE: In production, this should require wallet signature verification.
 * For now, it accepts an owner address in the body.
 */
router.post(
  '/',
  validateBody(createApiKeySchema),
  async (req, res) => {
    try {
      const input = req.body;

      // Limit keys per owner
      const existing = getApiKeysByOwner(input.owner);
      const activeKeys = existing.filter((k) => k.active);
      if (activeKeys.length >= 5) {
        sendError(res, Errors.badRequest('Maximum 5 active API keys per account'));
        return;
      }

      const key = `arena_${crypto.randomBytes(24).toString('hex')}`;

      const record: ApiKeyRecord = {
        key,
        owner: input.owner,
        label: input.label,
        createdAt: new Date().toISOString(),
        active: true,
      };

      createApiKey(record);

      res.status(201).json({
        key: record.key,
        label: record.label,
        owner: record.owner,
        createdAt: record.createdAt,
      });
    } catch (err) {
      sendError(res, err instanceof Error ? err : Errors.internal());
    }
  },
);

/**
 * GET /api-keys?owner=0x...
 * List API keys for an owner. Keys are masked.
 */
router.get('/', async (req, res) => {
  try {
    const owner = req.query.owner as string;
    if (!owner) {
      sendError(res, Errors.badRequest('owner query parameter is required'));
      return;
    }

    const keys = getApiKeysByOwner(owner);

    res.json({
      keys: keys.map((k) => ({
        key: `${k.key.slice(0, 10)}...${k.key.slice(-4)}`,
        label: k.label,
        active: k.active,
        createdAt: k.createdAt,
      })),
    });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

/**
 * DELETE /api-keys/:key
 * Revoke an API key. Requires owner query param.
 */
router.delete('/:key', async (req, res) => {
  try {
    const owner = req.query.owner as string;
    if (!owner) {
      sendError(res, Errors.badRequest('owner query parameter is required'));
      return;
    }

    const revoked = revokeApiKey(req.params.key, owner);
    if (!revoked) {
      sendError(res, Errors.notFound('API key'));
      return;
    }

    res.json({ revoked: true });
  } catch (err) {
    sendError(res, err instanceof Error ? err : Errors.internal());
  }
});

export default router;

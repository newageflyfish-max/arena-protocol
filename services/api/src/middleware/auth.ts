import type { Request, Response, NextFunction } from 'express';
import { findApiKey } from '../storage.js';
import { Errors, sendError } from '../errors.js';

declare global {
  namespace Express {
    interface Request {
      apiKeyOwner?: string;
    }
  }
}

/**
 * Authenticate requests via API key in the Authorization header.
 * Format: Authorization: Bearer arena_xxxxxxxxxxxx
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, Errors.unauthorized());
    return;
  }

  const key = authHeader.slice(7);

  if (!key.startsWith('arena_')) {
    sendError(res, Errors.unauthorized());
    return;
  }

  const record = findApiKey(key);
  if (!record) {
    sendError(res, Errors.unauthorized());
    return;
  }

  req.apiKeyOwner = record.owner;
  next();
}

/**
 * Optional API key — extracts owner if present but doesn't block.
 */
export function optionalApiKey(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer arena_')) {
    const key = authHeader.slice(7);
    const record = findApiKey(key);
    if (record) {
      req.apiKeyOwner = record.owner;
    }
  }

  next();
}

import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema, ZodError } from 'zod';
import { AppError, sendError } from '../errors.js';

/**
 * Express middleware that validates req.body against a Zod schema.
 * On failure, returns a 400 with structured validation errors.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const zodErr = result.error as ZodError;
      const messages = zodErr.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );

      sendError(
        res,
        new AppError(400, 'VALIDATION_ERROR', messages.join('; ')),
      );
      return;
    }

    req.body = result.data;
    next();
  };
}

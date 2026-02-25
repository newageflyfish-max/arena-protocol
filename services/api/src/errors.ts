import type { Response } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(res: Response, err: AppError | Error): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.error,
      message: err.message,
      statusCode: err.statusCode,
    });
  } else {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, 'UNAUTHORIZED', 'Missing or invalid API key'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'API key does not have access to this resource'),
  notFound: (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found`),
  badRequest: (message: string) => new AppError(400, 'BAD_REQUEST', message),
  conflict: (message: string) => new AppError(409, 'CONFLICT', message),
  rateLimit: () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'),
  internal: (message?: string) => new AppError(500, 'INTERNAL_ERROR', message ?? 'An unexpected error occurred'),
} as const;

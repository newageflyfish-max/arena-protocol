/**
 * AuditAgent — Structured Logger
 *
 * Uses pino for structured JSON logging with pretty-print in development.
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

// Pre-configured child loggers for subsystems
export const bidLog = logger.child({ module: 'bidding' });
export const execLog = logger.child({ module: 'execution' });
export const walletLog = logger.child({ module: 'wallet' });
export const analyzerLog = logger.child({ module: 'analyzer' });
export const persistLog = logger.child({ module: 'persistence' });

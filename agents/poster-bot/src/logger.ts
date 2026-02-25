/**
 * TaskPoster Bot — Structured Logger
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

export const postLog = logger.child({ module: 'poster' });
export const walletLog = logger.child({ module: 'wallet' });
export const templateLog = logger.child({ module: 'templates' });

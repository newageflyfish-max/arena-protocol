/**
 * AgentOrchestrator — Structured Logger
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

export const orchLog = logger.child({ module: 'orchestrator' });
export const nonceLog = logger.child({ module: 'nonce' });
export const routerLog = logger.child({ module: 'router' });
export const pnlLog = logger.child({ module: 'pnl' });
export const dashLog = logger.child({ module: 'dashboard' });
export const walletLog = logger.child({ module: 'wallet' });

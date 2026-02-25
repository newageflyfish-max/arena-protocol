import { z } from 'zod';

// ─── Task creation ───────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  taskType: z.enum([
    'audit',
    'risk_validation',
    'credit_scoring',
    'liquidation_monitoring',
    'treasury_execution',
    'compliance_screening',
    'oracle_verification',
    'custom',
  ]),
  bounty: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'Bounty must be a numeric string (e.g. "2500")'),
  deadline: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      'Deadline must be ISO 8601 format (e.g. "2026-03-01T12:00:00Z")',
    ),
  slashWindowHours: z.number().int().min(1).max(720).default(24),
  bidDurationHours: z.number().int().min(1).max(48).default(4),
  revealDurationHours: z.number().int().min(1).max(24).default(2),
  requiredVerifiers: z.number().int().min(1).max(5).default(3),
  criteria: z.record(z.unknown()),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ─── Webhook registration ────────────────────────────────────────────────────

export const createWebhookSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  events: z
    .array(
      z.enum([
        'task.created',
        'task.assigned',
        'task.delivered',
        'task.completed',
        'task.failed',
        'task.cancelled',
      ]),
    )
    .min(1, 'Must subscribe to at least one event'),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

// ─── API key generation ──────────────────────────────────────────────────────

export const createApiKeySchema = z.object({
  label: z
    .string()
    .min(1, 'Label is required')
    .max(64, 'Label must be 64 characters or less'),
  owner: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Owner must be a valid Ethereum address'),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// ─── Query params ────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

export const taskIdSchema = z.coerce
  .number()
  .int()
  .min(0, 'Task ID must be non-negative');

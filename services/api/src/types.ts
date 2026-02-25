/** Stored API key record. */
export interface ApiKeyRecord {
  /** The API key (prefixed with arena_) */
  key: string;
  /** Wallet address that owns this key */
  owner: string;
  /** Human-readable label */
  label: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Whether the key is active */
  active: boolean;
}

/** Stored webhook registration. */
export interface WebhookRecord {
  /** Unique webhook ID */
  id: string;
  /** Owner wallet address */
  owner: string;
  /** Target URL to POST events to */
  url: string;
  /** Event types to subscribe to */
  events: WebhookEventType[];
  /** ISO timestamp of creation */
  createdAt: string;
  /** Whether the webhook is active */
  active: boolean;
  /** Secret for HMAC signature verification */
  secret: string;
}

/** Supported webhook event types. */
export type WebhookEventType =
  | 'task.created'
  | 'task.assigned'
  | 'task.delivered'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled';

/** Standard API error response. */
export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

/** Task status labels matching on-chain enum. */
export const TASK_STATUS_MAP: Record<number, string> = {
  0: 'open',
  1: 'bid_reveal',
  2: 'assigned',
  3: 'delivered',
  4: 'verifying',
  5: 'completed',
  6: 'failed',
  7: 'disputed',
  8: 'cancelled',
};

import fs from 'node:fs';
import path from 'node:path';
import type { ApiKeyRecord, WebhookRecord } from './types.js';
import { config } from './config.js';

// ─── Generic JSON file store ─────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(filePath: string, data: T): void {
  ensureDir(filePath);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── API Keys ────────────────────────────────────────────────────────────────

export function loadApiKeys(): ApiKeyRecord[] {
  return readJson<ApiKeyRecord[]>(config.apiKeysFile, []);
}

export function saveApiKeys(keys: ApiKeyRecord[]): void {
  writeJson(config.apiKeysFile, keys);
}

export function findApiKey(key: string): ApiKeyRecord | undefined {
  const keys = loadApiKeys();
  return keys.find((k) => k.key === key && k.active);
}

export function createApiKey(record: ApiKeyRecord): void {
  const keys = loadApiKeys();
  keys.push(record);
  saveApiKeys(keys);
}

export function revokeApiKey(key: string, owner: string): boolean {
  const keys = loadApiKeys();
  const idx = keys.findIndex((k) => k.key === key && k.owner === owner);
  if (idx === -1) return false;
  keys[idx].active = false;
  saveApiKeys(keys);
  return true;
}

export function getApiKeysByOwner(owner: string): ApiKeyRecord[] {
  return loadApiKeys().filter((k) => k.owner === owner);
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export function loadWebhooks(): WebhookRecord[] {
  return readJson<WebhookRecord[]>(config.webhooksFile, []);
}

export function saveWebhooks(hooks: WebhookRecord[]): void {
  writeJson(config.webhooksFile, hooks);
}

export function createWebhook(record: WebhookRecord): void {
  const hooks = loadWebhooks();
  hooks.push(record);
  saveWebhooks(hooks);
}

export function deleteWebhook(id: string, owner: string): boolean {
  const hooks = loadWebhooks();
  const idx = hooks.findIndex((h) => h.id === id && h.owner === owner);
  if (idx === -1) return false;
  hooks.splice(idx, 1);
  saveWebhooks(hooks);
  return true;
}

export function getWebhooksByOwner(owner: string): WebhookRecord[] {
  return loadWebhooks().filter((h) => h.owner === owner);
}

export function getWebhooksByEvent(event: string): WebhookRecord[] {
  return loadWebhooks().filter(
    (h) => h.active && h.events.includes(event as WebhookRecord['events'][number]),
  );
}

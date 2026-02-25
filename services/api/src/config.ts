import 'dotenv/config';

export interface ApiConfig {
  port: number;
  rpcUrl: string;
  chainId: number;
  arenaCoreAddress: string;
  usdcAddress: string;
  arenaProfilesAddress: string;
  arenaComplianceAddress: string;
  privateKey: string | undefined;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  apiKeysFile: string;
  webhooksFile: string;
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const config: ApiConfig = {
  port: Number(process.env.PORT ?? 3001),
  rpcUrl: env('RPC_URL', 'https://sepolia.base.org'),
  chainId: Number(process.env.CHAIN_ID ?? 84532),
  arenaCoreAddress: env('ARENA_CORE_ADDRESS', '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF'),
  usdcAddress: env('USDC_ADDRESS', '0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf'),
  arenaProfilesAddress: env('ARENA_PROFILES_ADDRESS', '0x0000000000000000000000000000000000000003'),
  arenaComplianceAddress: env('ARENA_COMPLIANCE_ADDRESS', '0x0000000000000000000000000000000000000004'),
  privateKey: process.env.PRIVATE_KEY,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 60),
  apiKeysFile: env('API_KEYS_FILE', './data/api-keys.json'),
  webhooksFile: env('WEBHOOKS_FILE', './data/webhooks.json'),
};

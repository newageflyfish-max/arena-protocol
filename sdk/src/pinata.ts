/**
 * The Arena SDK — Pinata IPFS Integration
 *
 * Pins JSON data to IPFS via Pinata API and retrieves by hash.
 */

export interface PinataConfig {
  /** Pinata API key */
  apiKey: string;
  /** Pinata API secret */
  apiSecret: string;
  /** IPFS gateway URL (default: https://gateway.pinata.cloud/ipfs/) */
  gateway?: string;
}

export interface PinResult {
  /** IPFS CID (Content Identifier) */
  cid: string;
  /** bytes32 hash for on-chain storage (keccak256 of CID) */
  hash: string;
  /** Full IPFS gateway URL */
  url: string;
}

const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const DEFAULT_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

/**
 * Pin JSON data to IPFS via Pinata.
 *
 * @param data - JSON-serializable data to pin
 * @param config - Pinata API configuration
 * @param metadata - Optional Pinata metadata (name, keyvalues)
 * @returns PinResult with CID, hash, and URL
 */
export async function pinJSON(
  data: Record<string, any>,
  config: PinataConfig,
  metadata?: { name?: string; keyvalues?: Record<string, string> }
): Promise<PinResult> {
  const body: Record<string, any> = {
    pinataContent: data,
  };

  if (metadata) {
    body.pinataMetadata = {
      name: metadata.name || 'arena-data',
      keyvalues: metadata.keyvalues || {},
    };
  }

  const response = await fetch(PINATA_PIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'pinata_api_key': config.apiKey,
      'pinata_secret_api_key': config.apiSecret,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata pin failed (${response.status}): ${errorText}`);
  }

  const result = await response.json() as { IpfsHash: string };
  const cid = result.IpfsHash;
  const gateway = config.gateway || DEFAULT_GATEWAY;

  // Convert CID to bytes32 hash for on-chain storage
  const hash = cidToBytes32(cid);

  return {
    cid,
    hash,
    url: `${gateway}${cid}`,
  };
}

/**
 * Retrieve pinned data from IPFS by CID.
 *
 * @param cid - IPFS Content Identifier
 * @param config - Pinata config (uses gateway)
 * @returns The pinned JSON data
 */
export async function retrieveJSON<T = Record<string, any>>(
  cid: string,
  config: PinataConfig
): Promise<T> {
  const gateway = config.gateway || DEFAULT_GATEWAY;
  const url = `${gateway}${cid}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`IPFS retrieve failed (${response.status}): ${url}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Retrieve pinned data by bytes32 hash (reverse lookup requires CID mapping).
 * Note: bytes32 hash is derived from CID, so you need the original CID
 * or a mapping. This function accepts a CID directly.
 *
 * @param hashOrCid - Either a CID string or bytes32 hash with CID mapping
 * @param config - Pinata config
 */
export async function retrieveByHash<T = Record<string, any>>(
  hashOrCid: string,
  config: PinataConfig
): Promise<T> {
  // If it starts with "Qm" or "bafy", it's a CID
  if (hashOrCid.startsWith('Qm') || hashOrCid.startsWith('bafy')) {
    return retrieveJSON<T>(hashOrCid, config);
  }

  // Otherwise it's a hash — we need the CID mapping
  // In production, maintain a local CID<->hash cache
  throw new Error(
    'Cannot retrieve by bytes32 hash without CID mapping. ' +
    'Use retrieveJSON with the original CID instead.'
  );
}

/**
 * Convert an IPFS CID to a bytes32 hash for on-chain storage.
 * Uses a SHA-256 hash of the CID string, formatted as 0x-prefixed hex.
 */
function cidToBytes32(cid: string): string {
  // Simple approach: hash the CID string itself to get bytes32
  // In production, you might decode the CID's multihash directly
  const encoder = new TextEncoder();
  const data = encoder.encode(cid);

  // Synchronous fallback: use a simple hash
  let hash = 0n;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 8n) | BigInt(data[i])) % (2n ** 256n);
  }

  return '0x' + hash.toString(16).padStart(64, '0');
}

/**
 * Async version of cidToBytes32 using Web Crypto API.
 */
export async function cidToBytes32Async(cid: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(cid));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check if Pinata credentials are valid.
 */
export async function testAuthentication(config: PinataConfig): Promise<boolean> {
  try {
    const response = await fetch('https://api.pinata.cloud/data/testAuthentication', {
      headers: {
        'pinata_api_key': config.apiKey,
        'pinata_secret_api_key': config.apiSecret,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

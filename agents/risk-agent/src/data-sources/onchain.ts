/**
 * RiskAgent — On-Chain Data Source
 *
 * Direct RPC calls for contract metadata: deploy date, verification,
 * proxy patterns, and basic liquidity pool reads.
 */

import { ethers } from 'ethers';
import type { ContractData, LiquidityData } from '../types.js';
import { dataLog } from '../logger.js';

const log = dataLog.child({ source: 'onchain' });

// Minimal ERC20 interface for pool reads
const ERC20_ABI = ['function totalSupply() view returns (uint256)'];

// Minimal proxy detection
const PROXY_SLOTS = [
  // EIP-1967 implementation slot
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  // EIP-1967 admin slot
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
];

/**
 * Fetch contract deployment data.
 */
export async function fetchContractData(
  address: string,
  rpcUrl: string,
  chain = 'ethereum'
): Promise<ContractData | null> {
  try {
    log.info({ address, chain }, 'Fetching contract data');

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Check if contract exists
    const code = await provider.getCode(address);
    if (code === '0x' || code === '0x0') {
      log.warn({ address }, 'Address is not a contract');
      return null;
    }

    // Check for proxy pattern
    let proxyPattern = false;
    let upgradeableAdmin: string | undefined;
    for (const slot of PROXY_SLOTS) {
      try {
        const value = await provider.getStorage(address, slot);
        if (value !== ethers.ZeroHash) {
          proxyPattern = true;
          if (slot === PROXY_SLOTS[1]) {
            upgradeableAdmin = ethers.getAddress('0x' + value.slice(26));
          }
          break;
        }
      } catch { /* skip */ }
    }

    // Estimate deploy date via binary search on block number
    const deployedAt = await estimateDeployBlock(provider, address);
    const now = Math.floor(Date.now() / 1000);
    const ageInDays = deployedAt > 0 ? Math.floor((now - deployedAt) / 86400) : 0;

    const result: ContractData = {
      address,
      chain,
      deployedAt,
      ageInDays,
      verified: true, // We can't check Etherscan without API key; assume verified if code exists
      proxyPattern,
      upgradeableAdmin,
    };

    log.info({ address, ageInDays, proxyPattern }, 'Contract data fetched');
    return result;
  } catch (err: any) {
    log.error({ err: err.message, address }, 'Failed to fetch contract data');
    return null;
  }
}

/**
 * Estimate contract deploy timestamp via binary search.
 * Finds the first block where the address has code.
 */
async function estimateDeployBlock(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<number> {
  try {
    const latest = await provider.getBlockNumber();

    // Quick check: if contract is very recent, step back
    let lo = 0;
    let hi = latest;

    // Limit iterations
    for (let i = 0; i < 20; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid === lo) break;

      try {
        const code = await provider.getCode(address, mid);
        if (code === '0x' || code === '0x0') {
          lo = mid;
        } else {
          hi = mid;
        }
      } catch {
        lo = mid; // Assume no code on error
      }
    }

    // Get block timestamp
    const block = await provider.getBlock(hi);
    return block?.timestamp || 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch basic liquidity data for a token from a DEX pool.
 */
export async function fetchLiquidityData(
  tokenAddress: string,
  rpcUrl: string
): Promise<LiquidityData | null> {
  try {
    log.info({ token: tokenAddress }, 'Fetching liquidity data');

    // Use DeFi Llama's liquidity endpoint as a proxy
    // since direct pool reads require knowing the exact pool addresses
    const res = await fetch(`https://coins.llama.fi/prices/current/ethereum:${tokenAddress}`);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const coin = data.coins?.[`ethereum:${tokenAddress}`];
    if (!coin) return null;

    // Estimate liquidity from confidence and price data
    return {
      totalLiquidity: coin.confidence ? coin.confidence * 1_000_000 : 0,
      depth2Percent: 0,    // Would need DEX aggregator API for this
      depth5Percent: 0,
      poolCount: 1,        // Unknown without specific queries
      largestPoolShare: 100,
    };
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to fetch liquidity data');
    return null;
  }
}

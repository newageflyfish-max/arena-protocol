/**
 * RiskAgent — Execution Pipeline
 *
 * Full lifecycle: parse criteria → fetch data → score → validate → pin → deliver.
 */

import { ethers } from 'ethers';
import { pinJSON, retrieveJSON, validateOutput } from '@arena-protocol/sdk';
import type { PinataConfig } from '@arena-protocol/sdk';
import type { AgentConfig, PositionContext, RiskReport, TrackedTask } from './types.js';
import type { Persistence } from './persistence.js';
import { fetchProtocolData, searchProtocol, fetchTvlRanking } from './data-sources/defillama.js';
import { fetchTokenData, searchToken, fetchPriceHistory, calculateVolatility } from './data-sources/coingecko.js';
import { fetchContractData, fetchLiquidityData } from './data-sources/onchain.js';
import { calculateRiskScore } from './models/scoring.js';
import { execLog } from './logger.js';

const log = execLog;

const ARENA_DELIVER_ABI = [
  'function deliver(uint256 taskId, bytes32 outputHash)',
];

/**
 * Parse criteria from IPFS to extract what we need to analyze.
 * Expected criteria fields:
 *   - protocol: DeFi Llama slug or name
 *   - token: Coingecko ID or symbol
 *   - contractAddress: Ethereum address of the contract
 *   - chain: chain name (default: ethereum)
 */
interface RiskCriteria {
  protocol?: string;
  token?: string;
  contractAddress?: string;
  chain?: string;
  [key: string]: unknown;
}

function parseCriteria(raw: unknown): RiskCriteria {
  if (typeof raw !== 'object' || raw === null) return {};
  return raw as RiskCriteria;
}

/**
 * Execute a full risk assessment for a task.
 */
export async function executeRiskAssessment(
  taskId: number,
  criteriaHash: string,
  config: AgentConfig,
  persistence: Persistence,
): Promise<string | null> {
  try {
    log.info({ taskId, criteriaHash }, 'Starting risk assessment');
    persistence.updateTaskState(taskId, { status: 'executing' });

    const pinataConfig: PinataConfig = {
      apiKey: config.pinataApiKey,
      apiSecret: config.pinataSecret,
    };

    // ── 1. Fetch criteria from IPFS ──
    let rawCriteria: unknown;
    try {
      rawCriteria = await retrieveJSON(criteriaHash, pinataConfig);
      log.info({ taskId, criteriaHash }, 'Criteria retrieved from IPFS');
    } catch (err: any) {
      log.error({ err: err.message, taskId }, 'Failed to fetch criteria — using empty context');
      rawCriteria = {};
    }

    const criteria = parseCriteria(rawCriteria);
    log.info({ taskId, criteria }, 'Parsed criteria');

    // ── 2. Gather data from all sources in parallel ──
    const ctx = await gatherPositionData(criteria, config);

    // ── 3. Run risk model ──
    const report = calculateRiskScore(ctx, config.riskModel);

    // ── 4. Check confidence threshold ──
    if (report.confidence < config.minConfidence) {
      log.warn(
        { taskId, confidence: report.confidence, threshold: config.minConfidence },
        'Confidence below threshold — delivering with low-confidence warning'
      );
    }

    // ── 5. Validate against SDK schema ──
    const schemaReport = {
      score: report.score,
      confidence: report.confidence,
      factors: report.factors.map((f) => ({
        name: f.name,
        category: f.category,
        value: f.value,
        score: f.score,
        weight: f.weight,
        confidence: f.confidence,
        description: f.description,
        dataSource: f.dataSource,
      })),
      timestamp: report.timestamp,
    };

    try {
      validateOutput('risk_validation', schemaReport);
      log.info({ taskId }, 'Output validated against risk_validation schema');
    } catch (err: any) {
      log.warn({ err: err.message, taskId }, 'Schema validation warning — delivering anyway');
    }

    // ── 6. Pin report to IPFS ──
    let outputHash: string;
    let outputCid: string;
    try {
      const pinResult = await pinJSON(schemaReport, pinataConfig);
      outputHash = pinResult.hash;
      outputCid = pinResult.cid;
      log.info({ taskId, outputHash, cid: outputCid }, 'Report pinned to IPFS');
    } catch (err: any) {
      log.error({ err: err.message, taskId }, 'Failed to pin report — cannot deliver');
      persistence.updateTaskState(taskId, { status: 'failed' });
      return null;
    }

    // ── 7. Deliver on-chain ──
    try {
      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const signer = new ethers.Wallet(config.privateKey, provider);
      const contract = new ethers.Contract(config.arenaCoreAddress, ARENA_DELIVER_ABI, signer);

      const tx = await contract.deliver(taskId, outputHash);
      const receipt = await tx.wait();

      log.info({ taskId, txHash: receipt.hash, outputHash }, 'Risk report delivered on-chain');

      persistence.updateTaskState(taskId, {
        status: 'delivered',
        deliveryHash: outputCid,
      });

      return outputCid;
    } catch (err: any) {
      log.error({ err: err.message, taskId }, 'On-chain delivery failed');
      persistence.updateTaskState(taskId, { status: 'failed' });
      return null;
    }
  } catch (err: any) {
    log.error({ err: err.message, taskId }, 'Risk assessment failed');
    persistence.updateTaskState(taskId, { status: 'failed' });
    return null;
  }
}

/**
 * Gather all position data from multiple sources in parallel.
 */
async function gatherPositionData(
  criteria: RiskCriteria,
  config: AgentConfig
): Promise<PositionContext> {
  const ctx: PositionContext = {
    rawCriteria: criteria as Record<string, unknown>,
  };

  // Build parallel fetch tasks
  const tasks: Promise<void>[] = [];

  // ── Protocol data (DeFi Llama) ──
  if (criteria.protocol) {
    tasks.push(
      (async () => {
        try {
          // Try direct slug first, then search
          let slug = criteria.protocol!.toLowerCase().replace(/\s+/g, '-');
          let data = await fetchProtocolData(config.defillamaBaseUrl, slug);
          if (!data) {
            const found = await searchProtocol(config.defillamaBaseUrl, criteria.protocol!);
            if (found) data = await fetchProtocolData(config.defillamaBaseUrl, found);
          }
          if (data) ctx.protocol = data;
        } catch (err: any) {
          log.warn({ err: err.message }, 'Protocol data fetch failed');
        }
      })()
    );
  }

  // ── Token data (Coingecko) ──
  if (criteria.token) {
    tasks.push(
      (async () => {
        try {
          const cgOpts = {
            baseUrl: config.coingeckoBaseUrl,
            apiKey: config.coingeckoApiKey || undefined,
          };

          // Try direct ID first, then search
          let tokenId = criteria.token!.toLowerCase();
          let data = await fetchTokenData(tokenId, cgOpts);
          if (!data) {
            const found = await searchToken(criteria.token!, cgOpts);
            if (found) {
              tokenId = found;
              data = await fetchTokenData(found, cgOpts);
            }
          }
          if (data) {
            ctx.token = data;

            // Also fetch historical prices for better volatility calc
            const prices = await fetchPriceHistory(tokenId, 30, cgOpts);
            if (prices.length > 5) {
              const vol = calculateVolatility(prices);
              if (vol > 0) ctx.token.volatility30d = vol;
            }
          }
        } catch (err: any) {
          log.warn({ err: err.message }, 'Token data fetch failed');
        }
      })()
    );
  }

  // ── On-chain contract data ──
  if (criteria.contractAddress) {
    const rpcUrl = config.mainnetRpcUrl;
    const chain = criteria.chain || 'ethereum';

    tasks.push(
      (async () => {
        try {
          const data = await fetchContractData(criteria.contractAddress!, rpcUrl, chain);
          if (data) ctx.contract = data;
        } catch (err: any) {
          log.warn({ err: err.message }, 'Contract data fetch failed');
        }
      })()
    );

    // ── Liquidity data ──
    tasks.push(
      (async () => {
        try {
          const data = await fetchLiquidityData(criteria.contractAddress!, rpcUrl);
          if (data) ctx.liquidity = data;
        } catch (err: any) {
          log.warn({ err: err.message }, 'Liquidity data fetch failed');
        }
      })()
    );
  }

  // Run all data fetches in parallel
  await Promise.allSettled(tasks);

  log.info(
    {
      hasProtocol: !!ctx.protocol,
      hasToken: !!ctx.token,
      hasContract: !!ctx.contract,
      hasLiquidity: !!ctx.liquidity,
    },
    'Position data gathered'
  );

  return ctx;
}

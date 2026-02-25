/**
 * RiskAgent — DeFi Llama Data Source
 *
 * Fetches protocol-level TVL, chain breakdown, and metadata.
 * Free API — no key needed.
 * Docs: https://defillama.com/docs/api
 */

import type { ProtocolData } from '../types.js';
import { dataLog } from '../logger.js';

const log = dataLog.child({ source: 'defillama' });

export async function fetchProtocolData(
  baseUrl: string,
  protocolSlug: string
): Promise<ProtocolData | null> {
  try {
    log.info({ protocol: protocolSlug }, 'Fetching protocol data');

    const res = await fetch(`${baseUrl}/protocol/${protocolSlug}`);
    if (!res.ok) {
      log.warn({ status: res.status, protocol: protocolSlug }, 'Protocol not found');
      return null;
    }

    const data = await res.json() as any;
    const currentTvl = data.currentChainTvls
      ? Object.values(data.currentChainTvls as Record<string, number>)
          .filter((v): v is number => typeof v === 'number' && !isNaN(v))
          .reduce((sum: number, v: number) => sum + v, 0)
      : (data.tvl || 0);

    // Calculate TVL changes from historical data
    let tvlChange24h = 0;
    let tvlChange7d = 0;
    if (data.tvl && Array.isArray(data.tvl) && data.tvl.length > 0) {
      const latest = data.tvl[data.tvl.length - 1]?.totalLiquidityUSD || currentTvl;
      const day1 = data.tvl.length > 1 ? data.tvl[data.tvl.length - 2]?.totalLiquidityUSD : latest;
      const day7 = data.tvl.length > 7 ? data.tvl[data.tvl.length - 8]?.totalLiquidityUSD : latest;
      tvlChange24h = day1 > 0 ? ((latest - day1) / day1) * 100 : 0;
      tvlChange7d = day7 > 0 ? ((latest - day7) / day7) * 100 : 0;
    }

    const result: ProtocolData = {
      name: data.name || protocolSlug,
      slug: protocolSlug,
      tvl: currentTvl,
      tvlChange24h,
      tvlChange7d,
      chains: data.chains || [],
      category: data.category || 'Unknown',
      audits: data.audits ? Number(data.audits) : 0,
      auditLinks: data.audit_links || [],
      listedAt: data.listedAt,
      mcap: data.mcap,
    };

    log.info({ protocol: protocolSlug, tvl: currentTvl, chains: result.chains.length }, 'Protocol data fetched');
    return result;
  } catch (err: any) {
    log.error({ err: err.message, protocol: protocolSlug }, 'Failed to fetch protocol data');
    return null;
  }
}

/**
 * Search for a protocol by name (fuzzy).
 */
export async function searchProtocol(
  baseUrl: string,
  query: string
): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/protocols`);
    if (!res.ok) return null;

    const protocols = await res.json() as any[];
    const q = query.toLowerCase();

    // Exact slug match
    const exact = protocols.find((p: any) => p.slug === q || p.name?.toLowerCase() === q);
    if (exact) return exact.slug;

    // Partial match
    const partial = protocols.find((p: any) =>
      p.slug?.includes(q) || p.name?.toLowerCase().includes(q)
    );
    return partial?.slug || null;
  } catch {
    return null;
  }
}

/**
 * Fetch TVL ranking data for concentration analysis.
 */
export async function fetchTvlRanking(
  baseUrl: string
): Promise<{ totalTvl: number; top10Share: number } | null> {
  try {
    const res = await fetch(`${baseUrl}/protocols`);
    if (!res.ok) return null;

    const protocols = await res.json() as any[];
    const sorted = protocols
      .filter((p: any) => typeof p.tvl === 'number' && p.tvl > 0)
      .sort((a: any, b: any) => b.tvl - a.tvl);

    const totalTvl = sorted.reduce((sum: number, p: any) => sum + p.tvl, 0);
    const top10Tvl = sorted.slice(0, 10).reduce((sum: number, p: any) => sum + p.tvl, 0);

    return { totalTvl, top10Share: totalTvl > 0 ? (top10Tvl / totalTvl) * 100 : 0 };
  } catch {
    return null;
  }
}

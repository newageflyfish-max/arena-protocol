/**
 * RiskAgent — Coingecko Data Source
 *
 * Fetches token price, market data, and volatility metrics.
 * Supports both free and pro API keys.
 */

import type { TokenData } from '../types.js';
import { dataLog } from '../logger.js';

const log = dataLog.child({ source: 'coingecko' });

interface FetchOptions {
  baseUrl: string;
  apiKey?: string;
}

async function cgFetch(path: string, opts: FetchOptions): Promise<any> {
  const url = `${opts.baseUrl}${path}`;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (opts.apiKey) headers['x-cg-demo-api-key'] = opts.apiKey;

  const res = await fetch(url, { headers });
  if (res.status === 429) {
    log.warn('Rate limited by Coingecko — waiting 30s');
    await new Promise((r) => setTimeout(r, 30_000));
    return cgFetch(path, opts);
  }
  if (!res.ok) throw new Error(`Coingecko ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Fetch token data by Coingecko ID.
 */
export async function fetchTokenData(
  tokenId: string,
  opts: FetchOptions
): Promise<TokenData | null> {
  try {
    log.info({ tokenId }, 'Fetching token data');

    const data = await cgFetch(
      `/coins/${tokenId}?localization=false&tickers=false&community_data=false&developer_data=false`,
      opts
    );

    const market = data.market_data;
    if (!market) {
      log.warn({ tokenId }, 'No market data available');
      return null;
    }

    // Calculate 30d volatility from price change
    const priceChange30d = market.price_change_percentage_30d || 0;
    // Rough annualized volatility estimate from 30d change
    const volatility30d = Math.abs(priceChange30d) * Math.sqrt(365 / 30);

    const result: TokenData = {
      symbol: data.symbol || tokenId,
      name: data.name || tokenId,
      price: market.current_price?.usd || 0,
      priceChange24h: market.price_change_percentage_24h || 0,
      priceChange7d: market.price_change_percentage_7d || 0,
      priceChange30d,
      marketCap: market.market_cap?.usd || 0,
      volume24h: market.total_volume?.usd || 0,
      volatility30d,
      ath: market.ath?.usd || 0,
      athDate: market.ath_date?.usd || '',
      atl: market.atl?.usd || 0,
      atlDate: market.atl_date?.usd || '',
    };

    log.info({ tokenId, price: result.price, mcap: result.marketCap, vol30d: result.volatility30d }, 'Token data fetched');
    return result;
  } catch (err: any) {
    log.error({ err: err.message, tokenId }, 'Failed to fetch token data');
    return null;
  }
}

/**
 * Search for a token by name or symbol.
 */
export async function searchToken(
  query: string,
  opts: FetchOptions
): Promise<string | null> {
  try {
    const data = await cgFetch(`/search?query=${encodeURIComponent(query)}`, opts);
    const coins = data.coins || [];
    if (coins.length === 0) return null;

    // Prefer exact symbol match
    const q = query.toLowerCase();
    const exact = coins.find((c: any) => c.symbol?.toLowerCase() === q);
    return (exact || coins[0]).id;
  } catch {
    return null;
  }
}

/**
 * Fetch market chart data for volatility calculation.
 */
export async function fetchPriceHistory(
  tokenId: string,
  days: number,
  opts: FetchOptions
): Promise<number[]> {
  try {
    const data = await cgFetch(
      `/coins/${tokenId}/market_chart?vs_currency=usd&days=${days}`,
      opts
    );
    return (data.prices || []).map((p: [number, number]) => p[1]);
  } catch {
    return [];
  }
}

/**
 * Calculate historical volatility from daily prices.
 */
export function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const dailyVol = Math.sqrt(variance);

  // Annualize
  return dailyVol * Math.sqrt(365) * 100;
}

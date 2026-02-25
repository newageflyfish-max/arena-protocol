/**
 * RiskAgent — Risk Scoring Engine
 *
 * Calculates a composite risk score (0-100) from multiple data sources.
 * Supports three model profiles with different category weightings.
 */

import type {
  RiskModelName,
  RiskModelWeights,
  RiskFactor,
  RiskCategory,
  RiskReport,
  PositionContext,
} from '../types.js';
import { modelLog } from '../logger.js';

const log = modelLog;

// ═══════════════════════════════════════════════════
// MODEL WEIGHT PROFILES
// ═══════════════════════════════════════════════════

const MODEL_WEIGHTS: Record<RiskModelName, RiskModelWeights> = {
  /** Balanced model — equal emphasis across categories */
  standard: {
    tvl_concentration: 0.18,
    contract_maturity: 0.16,
    audit_status: 0.16,
    token_volatility: 0.16,
    liquidity_depth: 0.16,
    protocol_governance: 0.10,
    historical_incidents: 0.08,
  },
  /** Conservative model — penalizes new/unaudited contracts heavily */
  conservative: {
    tvl_concentration: 0.12,
    contract_maturity: 0.22,
    audit_status: 0.22,
    token_volatility: 0.14,
    liquidity_depth: 0.14,
    protocol_governance: 0.10,
    historical_incidents: 0.06,
  },
  /** DeFi-native model — focuses on liquidity and market dynamics */
  defi_native: {
    tvl_concentration: 0.20,
    contract_maturity: 0.10,
    audit_status: 0.10,
    token_volatility: 0.22,
    liquidity_depth: 0.22,
    protocol_governance: 0.08,
    historical_incidents: 0.08,
  },
};

// ═══════════════════════════════════════════════════
// INDIVIDUAL CATEGORY SCORERS
// ═══════════════════════════════════════════════════

/**
 * Score TVL concentration risk (0-100).
 * Lower TVL = higher risk. High concentration in top protocols = higher systemic risk.
 */
function scoreTvlConcentration(ctx: PositionContext): RiskFactor {
  let score = 50; // default moderate risk
  let confidence = 0.3;
  let value = 0;
  let description = 'Insufficient TVL data';

  if (ctx.protocol) {
    confidence = 0.8;
    const tvl = ctx.protocol.tvl;
    value = tvl;

    if (tvl <= 0) {
      score = 95;
      description = 'No TVL detected — extremely high risk';
    } else if (tvl < 100_000) {
      score = 90;
      description = `Very low TVL ($${formatNum(tvl)}) — high capital flight risk`;
    } else if (tvl < 1_000_000) {
      score = 75;
      description = `Low TVL ($${formatNum(tvl)}) — moderate capital risk`;
    } else if (tvl < 10_000_000) {
      score = 55;
      description = `Moderate TVL ($${formatNum(tvl)}) — some concentration risk`;
    } else if (tvl < 100_000_000) {
      score = 35;
      description = `Good TVL ($${formatNum(tvl)}) — reasonable stability`;
    } else if (tvl < 1_000_000_000) {
      score = 20;
      description = `Strong TVL ($${formatNum(tvl)}) — well-capitalized`;
    } else {
      score = 10;
      description = `Very high TVL ($${formatNum(tvl)}) — deeply established`;
    }

    // Factor in rapid TVL changes (sudden drops are risky)
    if (ctx.protocol.tvlChange24h < -10) {
      score = Math.min(100, score + 15);
      description += ` | WARNING: ${ctx.protocol.tvlChange24h.toFixed(1)}% TVL drop in 24h`;
    } else if (ctx.protocol.tvlChange7d < -20) {
      score = Math.min(100, score + 10);
      description += ` | CAUTION: ${ctx.protocol.tvlChange7d.toFixed(1)}% TVL drop in 7d`;
    }
  }

  return {
    name: 'TVL Concentration',
    category: 'tvl_concentration',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.protocol ? 'defillama' : 'none',
  };
}

/**
 * Score contract maturity risk (0-100).
 * Newer contracts = higher risk. Upgradeable proxies add risk.
 */
function scoreContractMaturity(ctx: PositionContext): RiskFactor {
  let score = 60;
  let confidence = 0.2;
  let value = 0;
  let description = 'No contract metadata available';

  if (ctx.contract) {
    confidence = 0.85;
    const days = ctx.contract.ageInDays;
    value = days;

    if (days < 7) {
      score = 95;
      description = `Brand new contract (${days}d old) — extreme deployment risk`;
    } else if (days < 30) {
      score = 80;
      description = `Very new contract (${days}d old) — limited battle-testing`;
    } else if (days < 90) {
      score = 60;
      description = `Relatively new contract (${days}d old) — moderate maturity`;
    } else if (days < 180) {
      score = 40;
      description = `Moderately mature contract (${days}d old)`;
    } else if (days < 365) {
      score = 25;
      description = `Mature contract (${days}d old) — reasonable track record`;
    } else {
      score = 10;
      description = `Well-established contract (${days}d old) — strong maturity`;
    }

    // Proxy pattern adds risk due to upgradeability
    if (ctx.contract.proxyPattern) {
      score = Math.min(100, score + 15);
      description += ' | Upgradeable proxy detected — admin key risk';
      if (ctx.contract.upgradeableAdmin) {
        description += ` (admin: ${ctx.contract.upgradeableAdmin.slice(0, 10)}…)`;
      }
    }

    // Unverified source adds risk
    if (!ctx.contract.verified) {
      score = Math.min(100, score + 10);
      description += ' | Unverified source code';
    }
  }

  return {
    name: 'Contract Maturity',
    category: 'contract_maturity',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.contract ? 'onchain_rpc' : 'none',
  };
}

/**
 * Score audit status risk (0-100).
 * No audits = high risk. Multiple audits from reputable firms = low risk.
 */
function scoreAuditStatus(ctx: PositionContext): RiskFactor {
  let score = 70;
  let confidence = 0.4;
  let value = 0;
  let description = 'Audit information not available';

  if (ctx.protocol) {
    confidence = 0.7;
    const audits = ctx.protocol.audits;
    const auditLinks = ctx.protocol.auditLinks;
    value = audits;

    if (audits === 0 && auditLinks.length === 0) {
      score = 90;
      description = 'No audits recorded — significant smart contract risk';
    } else if (audits === 1 || auditLinks.length === 1) {
      score = 55;
      description = '1 audit recorded — basic security review completed';
    } else if (audits >= 2 || auditLinks.length >= 2) {
      score = 30;
      description = `${Math.max(audits, auditLinks.length)} audits recorded — multi-firm review`;
    }

    if (audits >= 3 || auditLinks.length >= 3) {
      score = 15;
      description = `${Math.max(audits, auditLinks.length)} audits — comprehensive security review`;
    }
  }

  return {
    name: 'Audit Status',
    category: 'audit_status',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.protocol ? 'defillama' : 'none',
  };
}

/**
 * Score token volatility risk (0-100).
 * High volatility = higher risk of rapid value loss.
 */
function scoreTokenVolatility(ctx: PositionContext): RiskFactor {
  let score = 50;
  let confidence = 0.3;
  let value = 0;
  let description = 'No token price data available';

  if (ctx.token) {
    confidence = 0.85;
    const vol = ctx.token.volatility30d;
    value = vol;

    if (vol > 200) {
      score = 95;
      description = `Extreme volatility (${vol.toFixed(0)}% annualized) — very high price risk`;
    } else if (vol > 100) {
      score = 80;
      description = `Very high volatility (${vol.toFixed(0)}% annualized) — significant price risk`;
    } else if (vol > 60) {
      score = 60;
      description = `High volatility (${vol.toFixed(0)}% annualized) — elevated price risk`;
    } else if (vol > 30) {
      score = 40;
      description = `Moderate volatility (${vol.toFixed(0)}% annualized) — typical DeFi range`;
    } else if (vol > 15) {
      score = 25;
      description = `Low volatility (${vol.toFixed(0)}% annualized) — relatively stable`;
    } else {
      score = 10;
      description = `Very low volatility (${vol.toFixed(0)}% annualized) — stablecoin-like`;
    }

    // ATH distance — if token is far from ATH, additional downside risk may be limited
    if (ctx.token.ath > 0 && ctx.token.price > 0) {
      const athDrawdown = ((ctx.token.ath - ctx.token.price) / ctx.token.ath) * 100;
      if (athDrawdown > 90) {
        score = Math.min(100, score + 10);
        description += ` | ${athDrawdown.toFixed(0)}% below ATH — deep drawdown`;
      }
    }

    // Sharp recent drops are an immediate risk signal
    if (ctx.token.priceChange24h < -15) {
      score = Math.min(100, score + 10);
      description += ` | WARNING: ${ctx.token.priceChange24h.toFixed(1)}% drop in 24h`;
    }
  }

  return {
    name: 'Token Volatility',
    category: 'token_volatility',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.token ? 'coingecko' : 'none',
  };
}

/**
 * Score liquidity depth risk (0-100).
 * Low liquidity = high slippage risk and potential for manipulation.
 */
function scoreLiquidityDepth(ctx: PositionContext): RiskFactor {
  let score = 60;
  let confidence = 0.3;
  let value = 0;
  let description = 'No liquidity data available';

  if (ctx.liquidity) {
    confidence = 0.6;
    const liq = ctx.liquidity.totalLiquidity;
    value = liq;

    if (liq <= 0) {
      score = 95;
      description = 'No detectable liquidity — extremely high exit risk';
    } else if (liq < 50_000) {
      score = 85;
      description = `Very low liquidity ($${formatNum(liq)}) — severe slippage risk`;
    } else if (liq < 500_000) {
      score = 65;
      description = `Low liquidity ($${formatNum(liq)}) — moderate slippage risk`;
    } else if (liq < 5_000_000) {
      score = 40;
      description = `Moderate liquidity ($${formatNum(liq)}) — acceptable depth`;
    } else if (liq < 50_000_000) {
      score = 20;
      description = `Good liquidity ($${formatNum(liq)}) — low slippage expected`;
    } else {
      score = 8;
      description = `Deep liquidity ($${formatNum(liq)}) — minimal exit risk`;
    }

    // Concentrated liquidity in single pool is a risk
    if (ctx.liquidity.largestPoolShare > 90 && ctx.liquidity.poolCount <= 1) {
      score = Math.min(100, score + 10);
      description += ' | Single pool concentration risk';
    }
  } else if (ctx.token) {
    // Fallback: infer from trading volume
    confidence = 0.4;
    const vol24h = ctx.token.volume24h;
    value = vol24h;

    if (vol24h < 10_000) {
      score = 90;
      description = `Negligible 24h volume ($${formatNum(vol24h)}) — illiquid`;
    } else if (vol24h < 100_000) {
      score = 70;
      description = `Low 24h volume ($${formatNum(vol24h)}) — limited liquidity`;
    } else if (vol24h < 1_000_000) {
      score = 45;
      description = `Moderate 24h volume ($${formatNum(vol24h)})`;
    } else {
      score = 20;
      description = `Strong 24h volume ($${formatNum(vol24h)}) — good liquidity inferred`;
    }
  }

  return {
    name: 'Liquidity Depth',
    category: 'liquidity_depth',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.liquidity ? 'defillama' : ctx.token ? 'coingecko' : 'none',
  };
}

/**
 * Score protocol governance risk (0-100).
 * Evaluates multi-chain presence, category maturity, and governance signals.
 */
function scoreProtocolGovernance(ctx: PositionContext): RiskFactor {
  let score = 50;
  let confidence = 0.3;
  let value = 0;
  let description = 'Governance data not available';

  if (ctx.protocol) {
    confidence = 0.6;
    const chains = ctx.protocol.chains.length;
    value = chains;

    // Multi-chain presence is a positive signal (more diverse, harder to rug)
    if (chains >= 5) {
      score = 15;
      description = `Deployed on ${chains} chains — strong multi-chain presence`;
    } else if (chains >= 3) {
      score = 25;
      description = `Deployed on ${chains} chains — good diversification`;
    } else if (chains >= 2) {
      score = 40;
      description = `Deployed on ${chains} chains — some diversification`;
    } else {
      score = 55;
      description = `Single-chain deployment — concentration risk`;
    }

    // Category maturity
    const matureCategories = ['Lending', 'Dexes', 'Bridge', 'Liquid Staking', 'CDP'];
    if (matureCategories.includes(ctx.protocol.category)) {
      score = Math.max(0, score - 10);
      description += ` | Mature category (${ctx.protocol.category})`;
    }

    // Market cap to TVL ratio (if available) — over-valued protocols carry more risk
    if (ctx.protocol.mcap && ctx.protocol.tvl > 0) {
      const ratio = ctx.protocol.mcap / ctx.protocol.tvl;
      if (ratio > 10) {
        score = Math.min(100, score + 10);
        description += ` | High mcap/TVL ratio (${ratio.toFixed(1)}x)`;
      }
    }
  }

  return {
    name: 'Protocol Governance',
    category: 'protocol_governance',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.protocol ? 'defillama' : 'none',
  };
}

/**
 * Score historical incident risk (0-100).
 * Based on protocol listing age as a proxy — longer presence without major hacks = lower risk.
 */
function scoreHistoricalIncidents(ctx: PositionContext): RiskFactor {
  let score = 50;
  let confidence = 0.2;
  let value = 0;
  let description = 'Incident history not available — no listing date found';

  if (ctx.protocol?.listedAt) {
    confidence = 0.5;
    const now = Math.floor(Date.now() / 1000);
    const ageInDays = Math.floor((now - ctx.protocol.listedAt) / 86400);
    value = ageInDays;

    // Longer listing without being delisted = positive signal
    if (ageInDays < 30) {
      score = 75;
      description = `Listed ${ageInDays}d ago — too new for incident history`;
    } else if (ageInDays < 180) {
      score = 55;
      description = `Listed ${ageInDays}d ago — limited operating history`;
    } else if (ageInDays < 365) {
      score = 35;
      description = `Listed ${ageInDays}d ago — moderate track record`;
    } else {
      score = 15;
      description = `Listed ${ageInDays}d ago — established track record`;
    }
  }

  // If we have contract data, cross-reference age
  if (ctx.contract && ctx.contract.ageInDays > 365) {
    confidence = Math.max(confidence, 0.5);
    if (score > 30) {
      score = Math.max(20, score - 15);
      description += ` | Contract deployed ${ctx.contract.ageInDays}d ago`;
    }
  }

  return {
    name: 'Historical Incidents',
    category: 'historical_incidents',
    value,
    score,
    weight: 0,
    confidence,
    description,
    dataSource: ctx.protocol?.listedAt ? 'defillama' : 'none',
  };
}

// ═══════════════════════════════════════════════════
// COMPOSITE SCORING ENGINE
// ═══════════════════════════════════════════════════

const SCORERS: Array<(ctx: PositionContext) => RiskFactor> = [
  scoreTvlConcentration,
  scoreContractMaturity,
  scoreAuditStatus,
  scoreTokenVolatility,
  scoreLiquidityDepth,
  scoreProtocolGovernance,
  scoreHistoricalIncidents,
];

/**
 * Calculate the composite risk score from all data sources.
 */
export function calculateRiskScore(
  ctx: PositionContext,
  modelName: RiskModelName
): RiskReport {
  const weights = MODEL_WEIGHTS[modelName];
  log.info({ model: modelName }, 'Running risk model');

  // Run all scorers
  const factors = SCORERS.map((scorer) => {
    const factor = scorer(ctx);
    // Apply model-specific weight
    factor.weight = weights[factor.category];
    return factor;
  });

  // Weighted average score
  let totalWeight = 0;
  let weightedScore = 0;
  let weightedConfidence = 0;

  for (const f of factors) {
    weightedScore += f.score * f.weight;
    weightedConfidence += f.confidence * f.weight;
    totalWeight += f.weight;
  }

  const score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 50;
  const confidence = totalWeight > 0
    ? Math.round((weightedConfidence / totalWeight) * 100) / 100
    : 0.1;

  log.info(
    {
      model: modelName,
      score,
      confidence,
      factorCount: factors.length,
      factorScores: factors.map((f) => ({ cat: f.category, s: f.score, c: f.confidence })),
    },
    'Risk score calculated'
  );

  return {
    score,
    confidence,
    factors,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get available model names and their descriptions.
 */
export function getModelInfo(name: RiskModelName): { name: string; description: string } {
  const info: Record<RiskModelName, { name: string; description: string }> = {
    standard: {
      name: 'Standard',
      description: 'Balanced weighting across all risk categories',
    },
    conservative: {
      name: 'Conservative',
      description: 'Heavily penalizes new/unaudited contracts; suited for institutional use',
    },
    defi_native: {
      name: 'DeFi Native',
      description: 'Focuses on liquidity depth and token volatility; suited for active DeFi users',
    },
  };
  return info[name];
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

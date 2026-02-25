/**
 * TaskPoster Bot — Task Templates & Criteria Generators
 *
 * Generates realistic task criteria for each task type.
 * Uses real Base Sepolia contract addresses and DeFi protocols
 * to create diverse, authentic-looking tasks.
 */

import type { PostableTaskType, TaskTemplate, BotConfig } from './types.js';
import { templateLog } from './logger.js';

const log = templateLog;

// ═══════════════════════════════════════════════════
// REAL BASE SEPOLIA CONTRACTS (deployed & verified)
// ═══════════════════════════════════════════════════

const BASE_SEPOLIA_CONTRACTS = [
  {
    address: '0x4200000000000000000000000000000000000006',
    name: 'WETH (Wrapped Ether)',
    category: 'Token',
  },
  {
    address: '0x4200000000000000000000000000000000000010',
    name: 'L2ToL1MessagePasser',
    category: 'Bridge',
  },
  {
    address: '0x4200000000000000000000000000000000000007',
    name: 'L2CrossDomainMessenger',
    category: 'Bridge',
  },
  {
    address: '0x4200000000000000000000000000000000000011',
    name: 'SequencerFeeVault',
    category: 'Infrastructure',
  },
  {
    address: '0x4200000000000000000000000000000000000012',
    name: 'OptimismMintableERC20Factory',
    category: 'Token Factory',
  },
  {
    address: '0x4200000000000000000000000000000000000016',
    name: 'L2StandardBridge',
    category: 'Bridge',
  },
  {
    address: '0x4200000000000000000000000000000000000042',
    name: 'GovernanceToken',
    category: 'Governance',
  },
  {
    address: '0x420000000000000000000000000000000000F100',
    name: 'Create2Deployer',
    category: 'Infrastructure',
  },
];

// ═══════════════════════════════════════════════════
// REAL DEFI PROTOCOLS (for risk_validation tasks)
// ═══════════════════════════════════════════════════

const DEFI_PROTOCOLS = [
  { slug: 'aave-v3', name: 'Aave V3', token: 'aave', chain: 'ethereum' },
  { slug: 'uniswap', name: 'Uniswap', token: 'uniswap', chain: 'ethereum' },
  { slug: 'lido', name: 'Lido', token: 'lido-dao', chain: 'ethereum' },
  { slug: 'maker', name: 'MakerDAO', token: 'maker', chain: 'ethereum' },
  { slug: 'curve-dex', name: 'Curve Finance', token: 'curve-dao-token', chain: 'ethereum' },
  { slug: 'compound-v3', name: 'Compound V3', token: 'compound-governance-token', chain: 'ethereum' },
  { slug: 'eigenlayer', name: 'EigenLayer', token: 'eigenlayer', chain: 'ethereum' },
  { slug: 'pendle', name: 'Pendle', token: 'pendle', chain: 'ethereum' },
  { slug: 'gmx', name: 'GMX', token: 'gmx', chain: 'arbitrum' },
  { slug: 'jupiter', name: 'Jupiter', token: 'jupiter-exchange-solana', chain: 'solana' },
  { slug: 'raydium', name: 'Raydium', token: 'raydium', chain: 'solana' },
  { slug: 'morpho', name: 'Morpho', token: 'morpho', chain: 'ethereum' },
];

// ═══════════════════════════════════════════════════
// ETHEREUM MAINNET ADDRESSES (for risk_validation contract checks)
// ═══════════════════════════════════════════════════

const MAINNET_CONTRACTS = [
  '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', // Aave V2 Lending Pool
  '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3 Factory
  '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // Lido stETH
  '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', // MKR Token
  '0xD533a949740bb3306d119CC777fa900bA034cd52', // CRV Token
  '0xc3d688B66703497DAA19211EEdff47f25384cdc3', // Compound cUSDCv3
  '0x858646372CC42E1A627fcE94aa7A7033e7CF075A', // Eigen Strategy Manager
  '0x808507121B80c02388fAd14726482e061B8da827', // Pendle Router
];

// ═══════════════════════════════════════════════════
// CREDIT SCORING ADDRESSES (wallets/contracts to score)
// ═══════════════════════════════════════════════════

const CREDIT_TARGETS = [
  { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'vitalik.eth' },
  { address: '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8', label: 'Binance Hot Wallet' },
  { address: '0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503', label: 'Binance Cold Wallet' },
  { address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD50', label: 'Unknown Whale' },
  { address: '0xF977814e90dA44bFA03b6295A0616a897441aceC', label: 'Binance 8' },
  { address: '0x1B3cB81E51011b549d78bf720b0d924ac763A7C2', label: 'Arbitrum Bridge' },
];

// ═══════════════════════════════════════════════════
// AUDIT FOCUS AREAS
// ═══════════════════════════════════════════════════

const AUDIT_FOCUS_AREAS = [
  'reentrancy',
  'access_control',
  'oracle_manipulation',
  'integer_overflow',
  'flash_loan',
  'front_running',
  'logic_errors',
  'gas_optimization',
] as const;

const AUDIT_SCOPES = [
  'Full contract security audit',
  'Critical vulnerability assessment',
  'Access control and privilege escalation review',
  'Reentrancy and state mutation analysis',
  'Token handling and economic exploit review',
  'Cross-contract interaction audit',
  'Proxy and upgradeability safety review',
  'Gas optimization and DoS resistance audit',
];

// ═══════════════════════════════════════════════════
// RISK ASSESSMENT SCOPES
// ═══════════════════════════════════════════════════

const RISK_SCOPES = [
  'Full protocol risk assessment — TVL, liquidity, and smart contract maturity',
  'Position risk scoring for DeFi yield strategy',
  'Token volatility and liquidity depth analysis',
  'Protocol governance and concentration risk review',
  'Cross-chain bridge risk evaluation',
  'Lending protocol collateral risk assessment',
];

// ═══════════════════════════════════════════════════
// CREDIT SCORING SCOPES
// ═══════════════════════════════════════════════════

const CREDIT_SCOPES = [
  'On-chain credit scoring for DeFi lending eligibility',
  'Wallet activity and repayment history analysis',
  'Cross-protocol credit risk assessment',
  'Institutional wallet creditworthiness evaluation',
  'Borrower default probability estimation',
];

// ═══════════════════════════════════════════════════
// TEMPLATE GENERATORS
// ═══════════════════════════════════════════════════

/**
 * Generate a random audit task.
 */
function generateAuditTask(config: BotConfig): TaskTemplate {
  const contract = pickRandom(BASE_SEPOLIA_CONTRACTS);
  const focusCount = 2 + Math.floor(Math.random() * 3); // 2-4 focus areas
  const focusAreas = shuffle([...AUDIT_FOCUS_AREAS]).slice(0, focusCount);
  const scope = pickRandom(AUDIT_SCOPES);

  const bountyUsdc = randomBounty(config.minBountyUsdc, config.maxBountyUsdc);

  const criteria = {
    target_contract: contract.address,
    contract_name: contract.name,
    contract_category: contract.category,
    chain: 'base_sepolia',
    scope,
    focus_areas: focusAreas,
    severity_threshold: pickRandom(['informational', 'low', 'medium', 'high']),
    expected_deliverable: 'Structured findings report with severity classifications, proof of concept, and remediation recommendations',
    max_findings: 20,
  };

  return {
    taskType: 'audit',
    criteria,
    bountyUsdc,
    description: `Audit ${contract.name} (${contract.category}) — ${scope}`,
  };
}

/**
 * Generate a random risk_validation task.
 */
function generateRiskValidationTask(config: BotConfig): TaskTemplate {
  const protocol = pickRandom(DEFI_PROTOCOLS);
  const mainnetContract = pickRandom(MAINNET_CONTRACTS);
  const scope = pickRandom(RISK_SCOPES);

  const bountyUsdc = randomBounty(config.minBountyUsdc, Math.min(config.maxBountyUsdc, 1500));

  const criteria = {
    protocol: protocol.slug,
    protocol_name: protocol.name,
    token: protocol.token,
    contractAddress: mainnetContract,
    chain: protocol.chain,
    scope,
    risk_categories: shuffle([
      'tvl_concentration',
      'contract_maturity',
      'audit_status',
      'token_volatility',
      'liquidity_depth',
      'protocol_governance',
      'historical_incidents',
    ]).slice(0, 4 + Math.floor(Math.random() * 3)),
    min_confidence: 0.5 + Math.random() * 0.3,
    expected_deliverable: 'Risk score 0-100 with confidence level and detailed factor breakdown',
  };

  return {
    taskType: 'risk_validation',
    criteria,
    bountyUsdc,
    description: `Risk assessment for ${protocol.name} — ${scope}`,
  };
}

/**
 * Generate a random credit_scoring task.
 */
function generateCreditScoringTask(config: BotConfig): TaskTemplate {
  const target = pickRandom(CREDIT_TARGETS);
  const scope = pickRandom(CREDIT_SCOPES);

  const bountyUsdc = randomBounty(config.minBountyUsdc, Math.min(config.maxBountyUsdc, 1000));

  const criteria = {
    target_address: target.address,
    target_label: target.label,
    chain: 'ethereum',
    scope,
    evaluation_period_days: pickRandom([30, 60, 90, 180, 365]),
    scoring_factors: shuffle([
      'transaction_volume',
      'wallet_age',
      'protocol_diversity',
      'repayment_history',
      'collateral_ratio',
      'liquidation_history',
      'token_holdings_diversity',
      'defi_interaction_frequency',
    ]).slice(0, 4 + Math.floor(Math.random() * 3)),
    min_confidence: 0.4 + Math.random() * 0.3,
    expected_deliverable: 'Default probability 0-1 with confidence level and factor breakdown',
  };

  return {
    taskType: 'credit_scoring',
    criteria,
    bountyUsdc,
    description: `Credit scoring for ${target.label} — ${scope}`,
  };
}

// ═══════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════

const GENERATORS: Record<PostableTaskType, (config: BotConfig) => TaskTemplate> = {
  audit: generateAuditTask,
  risk_validation: generateRiskValidationTask,
  credit_scoring: generateCreditScoringTask,
};

/**
 * Select a random task type based on configured weights.
 */
export function selectTaskType(config: BotConfig): PostableTaskType {
  const weights: [PostableTaskType, number][] = [
    ['audit', config.weightAudit],
    ['risk_validation', config.weightRiskValidation],
    ['credit_scoring', config.weightCreditScoring],
  ];

  const totalWeight = weights.reduce((sum, [, w]) => sum + w, 0);
  if (totalWeight === 0) return 'audit'; // fallback

  let rand = Math.random() * totalWeight;
  for (const [type, weight] of weights) {
    rand -= weight;
    if (rand <= 0) return type;
  }

  return weights[weights.length - 1][0];
}

/**
 * Generate a task template for the given type.
 */
export function generateTask(taskType: PostableTaskType, config: BotConfig): TaskTemplate {
  const generator = GENERATORS[taskType];
  const template = generator(config);

  log.info(
    { taskType, bounty: template.bountyUsdc, description: template.description },
    'Task template generated'
  );

  return template;
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomBounty(min: number, max: number): number {
  // Round to nearest 50
  const raw = min + Math.random() * (max - min);
  return Math.round(raw / 50) * 50;
}

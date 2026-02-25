/**
 * AgentOrchestrator — Agent Wrappers
 *
 * Wraps each agent type into a standardized AgentInstance interface.
 * Each wrapper constructs the agent's specific config from the unified
 * orchestrator config. Agents run independently but share the same wallet
 * (nonce management happens at the transaction level).
 *
 * Since each agent creates its own internal ethers.Contract instances,
 * the nonce manager serialization happens externally at the orchestrator
 * level. The agents themselves are unmodified — they run their normal
 * event-driven loops.
 */

import type {
  OrchestratorConfig,
  AgentId,
  RegisteredAgent,
  AgentInstance,
} from './types.js';
import { orchLog } from './logger.js';

const log = orchLog;

// ═══════════════════════════════════════════════════
// GENERIC AGENT WRAPPER
// ═══════════════════════════════════════════════════

/**
 * Wraps a dynamically-imported agent class into our AgentInstance interface.
 * Uses dynamic imports so the orchestrator doesn't hard-depend on agent packages.
 */
class DynamicAgentWrapper implements AgentInstance {
  private agentId: AgentId;
  private agentInstance: { start(): Promise<void>; stop(): Promise<void> } | null = null;
  private factory: () => Promise<{ start(): Promise<void>; stop(): Promise<void> }>;

  constructor(
    agentId: AgentId,
    factory: () => Promise<{ start(): Promise<void>; stop(): Promise<void> }>
  ) {
    this.agentId = agentId;
    this.factory = factory;
  }

  async start(): Promise<void> {
    log.info({ agentId: this.agentId }, 'Starting agent');
    this.agentInstance = await this.factory();
    await this.agentInstance.start();
    log.info({ agentId: this.agentId }, 'Agent started');
  }

  async stop(): Promise<void> {
    if (this.agentInstance) {
      log.info({ agentId: this.agentId }, 'Stopping agent');
      await this.agentInstance.stop();
      this.agentInstance = null;
      log.info({ agentId: this.agentId }, 'Agent stopped');
    }
  }
}

// ═══════════════════════════════════════════════════
// AGENT CONFIG BUILDERS
// ═══════════════════════════════════════════════════

/**
 * Build an AuditAgent config from orchestrator config.
 */
function buildAuditConfig(config: OrchestratorConfig): Record<string, string> {
  return {
    RPC_URL: config.rpcUrl,
    PRIVATE_KEY: config.privateKey,
    ARENA_CORE_ADDRESS: config.arenaCoreAddress,
    USDC_ADDRESS: config.usdcAddress,
    PINATA_API_KEY: config.pinataApiKey,
    PINATA_SECRET: config.pinataSecret,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    MIN_BOUNTY_USDC: String(config.minBountyUsdc),
    MAX_BID_USDC: String(config.maxBidUsdc),
    MAX_STAKE_PERCENT: String(config.maxStakePercent),
    RISK_TOLERANCE: config.riskTolerance,
    POLL_INTERVAL_MS: String(config.pollIntervalMs),
    DATA_DIR: config.dataDir + '/audit-agent',
  };
}

/**
 * Build a VerifierAgent config from orchestrator config.
 */
function buildVerifierConfig(config: OrchestratorConfig): Record<string, string> {
  return {
    RPC_URL: config.rpcUrl,
    PRIVATE_KEY: config.privateKey,
    ARENA_CORE_ADDRESS: config.arenaCoreAddress,
    USDC_ADDRESS: config.usdcAddress,
    PINATA_API_KEY: config.pinataApiKey,
    PINATA_SECRET: config.pinataSecret,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    POOL_STAKE_USDC: String(config.poolStakeUsdc),
    AUTO_JOIN_POOL: String(config.autoJoinPool),
    APPROVAL_THRESHOLD: String(config.approvalThreshold),
    AUTO_REJECT_MISSED_CRITICAL: String(config.autoRejectMissedCritical),
    USE_COMPARISON_MODE: String(config.useComparisonMode),
    POLL_INTERVAL_MS: String(config.pollIntervalMs),
    DATA_DIR: config.dataDir + '/verifier-agent',
  };
}

/**
 * Build a RiskAgent config from orchestrator config.
 */
function buildRiskConfig(config: OrchestratorConfig): Record<string, string> {
  return {
    RPC_URL: config.rpcUrl,
    PRIVATE_KEY: config.privateKey,
    ARENA_CORE_ADDRESS: config.arenaCoreAddress,
    USDC_ADDRESS: config.usdcAddress,
    PINATA_API_KEY: config.pinataApiKey,
    PINATA_SECRET: config.pinataSecret,
    DEFILLAMA_BASE_URL: config.defillamaBaseUrl,
    COINGECKO_BASE_URL: config.coingeckoBaseUrl,
    COINGECKO_API_KEY: config.coingeckoApiKey,
    MAINNET_RPC_URL: config.mainnetRpcUrl,
    MIN_BOUNTY_USDC: String(config.minBountyUsdc),
    MAX_BID_USDC: String(config.maxBidUsdc),
    MAX_STAKE_PERCENT: String(config.maxStakePercent),
    RISK_TOLERANCE: config.riskTolerance,
    RISK_MODEL: config.riskModel,
    MIN_CONFIDENCE: String(config.minConfidence),
    POLL_INTERVAL_MS: String(config.pollIntervalMs),
    DATA_DIR: config.dataDir + '/risk-agent',
  };
}

/**
 * Inject environment variables for a child agent.
 * Agents read config from process.env via their own config.ts loaders.
 */
function injectEnv(envVars: Record<string, string>): void {
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }
}

// ═══════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════

/**
 * Create all registered agents based on config toggles.
 */
export function createAgentRegistry(config: OrchestratorConfig): RegisteredAgent[] {
  const agents: RegisteredAgent[] = [];

  if (config.enableAuditAgent) {
    // Pre-inject env vars so the audit agent's config.ts can read them
    injectEnv(buildAuditConfig(config));

    const wrapper = new DynamicAgentWrapper('audit', async () => {
      // Dynamic import of the audit agent
      try {
        const mod = await import('@arena-protocol/audit-agent/dist/agent.js' as string);
        const AgentClass = mod.AuditAgent || mod.default;
        const configMod = await import('@arena-protocol/audit-agent/dist/config.js' as string);
        const agentConfig = configMod.loadConfig();
        return new AgentClass(agentConfig);
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to import audit-agent — using stub');
        return createStubAgent('audit');
      }
    });

    agents.push({
      id: 'audit',
      name: 'AuditAgent',
      taskTypes: ['audit'],
      status: 'stopped',
      instance: wrapper,
    });
  }

  if (config.enableVerifierAgent) {
    injectEnv(buildVerifierConfig(config));

    const wrapper = new DynamicAgentWrapper('verifier', async () => {
      try {
        const mod = await import('@arena-protocol/verifier-agent/dist/agent.js' as string);
        const AgentClass = mod.VerifierAgent || mod.default;
        const configMod = await import('@arena-protocol/verifier-agent/dist/config.js' as string);
        const agentConfig = configMod.loadConfig();
        return new AgentClass(agentConfig);
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to import verifier-agent — using stub');
        return createStubAgent('verifier');
      }
    });

    agents.push({
      id: 'verifier',
      name: 'VerifierAgent',
      taskTypes: ['audit'],
      status: 'stopped',
      instance: wrapper,
    });
  }

  if (config.enableRiskAgent) {
    injectEnv(buildRiskConfig(config));

    const wrapper = new DynamicAgentWrapper('risk', async () => {
      try {
        const mod = await import('@arena-protocol/risk-agent/dist/agent.js' as string);
        const AgentClass = mod.RiskAgent || mod.default;
        const configMod = await import('@arena-protocol/risk-agent/dist/config.js' as string);
        const agentConfig = configMod.loadConfig();
        return new AgentClass(agentConfig);
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to import risk-agent — using stub');
        return createStubAgent('risk');
      }
    });

    agents.push({
      id: 'risk',
      name: 'RiskAgent',
      taskTypes: ['risk_validation'],
      status: 'stopped',
      instance: wrapper,
    });
  }

  return agents;
}

/**
 * Create a stub agent for when the real agent can't be imported.
 * This lets the orchestrator run even if not all agent packages are installed.
 */
function createStubAgent(agentId: string): AgentInstance {
  return {
    async start() {
      log.warn({ agentId }, 'Stub agent started — install the agent package for real functionality');
    },
    async stop() {
      log.info({ agentId }, 'Stub agent stopped');
    },
  };
}

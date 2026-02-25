/**
 * The Arena SDK
 *
 * TypeScript SDK for interacting with The Arena protocol —
 * an adversarial execution protocol where AI agents stake
 * capital on task performance.
 *
 * @example
 * ```ts
 * import { Arena } from '@arena-protocol/sdk';
 * import { ethers } from 'ethers';
 *
 * const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
 * const signer = new ethers.Wallet(PRIVATE_KEY, provider);
 *
 * const arena = new Arena({ rpcUrl: 'https://sepolia.base.org', chainId: 84532, signer });
 *
 * // Create a task with automatic USDC approval
 * const { taskId } = await arena.createAndFundTask({
 *   type: 'audit',
 *   bounty: '2500',
 *   deadline: '4h',
 *   slashWindow: '30d',
 *   verifiers: 2,
 *   criteria: { description: 'Audit the vault contract' },
 * });
 *
 * // Get full task details from all contracts
 * const details = await arena.getTaskFullDetails(taskId);
 * ```
 */

// ─── Client ───
export { Arena } from './client';
export { Arena as default } from './client';

// ─── Types ───
export type {
  // Enums & Literals
  TaskType,
  TaskStatus,
  SlashSeverity,
  VerifierVote,
  Chain,
  InsuranceStatus,
  ArbitrationStatus,
  ReportReason,
  // Configuration
  ArenaConfig,
  // Write Params
  TaskParams,
  BidParams,
  DeliverParams,
  VerifyParams,
  VerificationVoteParams,
  // Read Results — Basic
  TaskInfo,
  AssignmentInfo,
  AgentStats,
  BidInfo,
  VerificationInfo,
  TransactionResult,
  // Read Results — Aggregate (Convenience Methods)
  InsurancePolicyInfo,
  TaskFullDetails,
  AgentProfile,
  DelegationPoolInfo,
  ProtocolStats,
  CreateAndFundResult,
  BidOnTaskResult,
} from './types';

// ─── Addresses ───
export {
  BASE_SEPOLIA_ADDRESSES,
  getAddresses,
  getAddressesOrThrow,
} from './addresses';

export type {
  DeploymentAddresses,
} from './addresses';

// ─── ABIs ───
export {
  ERC20_ABI,
  ARENA_MAIN_ABI,
  ARENA_AUCTION_ABI,
  ARENA_VRF_ABI,
  ARENA_CORE_ABI,
  ARENA_ARBITRATION_ABI,
  ARENA_REPUTATION_ABI,
  ARENA_INSURANCE_ABI,
  ARENA_OUTCOMES_ABI,
  ARENA_CONTINUOUS_ABI,
  ARENA_SYNDICATES_ABI,
  ARENA_DELEGATION_ABI,
  ARENA_COMPLIANCE_ABI,
} from './abis';

// ─── Utilities ───
export {
  parseDuration,
  formatAmount,
  parseAmount,
  generateSalt,
  computeCommitHash,
  parseStatus,
  parseVote,
  formatReceipt,
} from './utils';

// ─── Errors ───
export {
  ArenaError,
  parseContractError,
  BountyError,
  DeadlineError,
  BidError,
  StakeError,
  AuthorizationError,
  PausedError,
  BannedError,
} from './errors';

// ─── Events ───
export {
  ArenaEventListener,
} from './events';

export type {
  TaskCreatedEvent,
  BidCommittedEvent,
  BidRevealedEvent,
  AgentAssignedEvent,
  TaskDeliveredEvent,
  VerifierAssignedEvent,
  VerificationSubmittedEvent,
  TaskCompletedEvent,
  AgentSlashedEvent,
  VerifierSlashedEvent,
  TaskDisputedEvent,
  TaskCancelledEvent,
  SlashBondClaimedEvent,
  HoneypotSettledEvent,
  ArenaEvent,
  ArenaEventType,
  EventCallback,
} from './events';

// ─── Pinata IPFS ───
export {
  pinJSON,
  retrieveJSON,
  retrieveByHash,
  cidToBytes32Async,
  testAuthentication,
} from './pinata';

export type {
  PinataConfig,
  PinResult,
} from './pinata';

// ─── Bid Manager ───
export { BidManager } from './bid-manager';

export type {
  ManagedBid,
  BidManagerConfig,
} from './bid-manager';

// ─── Output Schema Validation ───
export {
  validateOutput,
  getOutputSchema,
  computeSchemaHash,
  getSchemaTaskTypes,
  OUTPUT_SCHEMAS,
} from './validation';

export type {
  SchemaProperty,
  SchemaDefinition,
  ValidationError,
  ValidationResult,
} from './validation';

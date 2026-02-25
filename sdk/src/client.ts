/**
 * The Arena SDK — Main Client Class
 *
 * Provides a typed interface to all Arena protocol contracts.
 * Routes calls to the correct contract in the 3-contract architecture:
 * - ArenaCoreMain: task creation, escrow, shared state, admin
 * - ArenaCoreAuction: sealed-bid auctions, delivery, verification, settlement
 * - ArenaCoreVRF: verifier pool management, random selection
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
 * ```
 */

import { ethers as ethersLib } from 'ethers';

import type {
  ArenaConfig,
  TaskParams,
  BidParams,
  DeliverParams,
  VerifyParams,
  VerificationVoteParams,
  TaskInfo,
  AssignmentInfo,
  AgentStats,
  BidInfo,
  VerificationInfo,
  TransactionResult,
  TaskType,
  TaskFullDetails,
  AgentProfile,
  ProtocolStats,
  CreateAndFundResult,
  BidOnTaskResult,
  InsurancePolicyInfo,
  InsuranceStatus,
  DelegationPoolInfo,
} from './types';

import {
  parseDuration,
  parseAmount,
  formatAmount,
  generateSalt,
  computeCommitHash,
  parseStatus,
  parseVote,
  formatReceipt,
} from './utils';

import { parseContractError, ArenaError } from './errors';
import { ArenaEventListener } from './events';
import { pinJSON } from './pinata';
import { validateOutput } from './validation';
import { getAddressesOrThrow, type DeploymentAddresses } from './addresses';
import {
  ERC20_ABI,
  ARENA_MAIN_ABI,
  ARENA_AUCTION_ABI,
  ARENA_VRF_ABI,
  ARENA_ARBITRATION_ABI,
  ARENA_REPUTATION_ABI,
  ARENA_INSURANCE_ABI,
  ARENA_OUTCOMES_ABI,
  ARENA_CONTINUOUS_ABI,
  ARENA_SYNDICATES_ABI,
  ARENA_DELEGATION_ABI,
  ARENA_COMPLIANCE_ABI,
} from './abis';

// ═══════════════════════════════════════════════════
// INSURANCE STATUS PARSER
// ═══════════════════════════════════════════════════

const INSURANCE_STATUSES: InsuranceStatus[] = ['open', 'active', 'claimed', 'settled', 'cancelled'];
function parseInsuranceStatus(s: number): InsuranceStatus {
  return INSURANCE_STATUSES[s] ?? 'open';
}

// ═══════════════════════════════════════════════════
// ZERO ADDRESS CONSTANT
// ═══════════════════════════════════════════════════

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ═══════════════════════════════════════════════════
// MAIN CLIENT
// ═══════════════════════════════════════════════════

/**
 * The Arena SDK client.
 *
 * Connects to all Arena protocol contracts and provides typed methods
 * for every protocol action — from task creation to dispute resolution.
 *
 * Routes calls to the correct contract:
 * - `main`: task creation, cancellation, escrow, state reads, admin
 * - `auction`: bidding, delivery, verification, settlement, slashing
 * - `vrf`: verifier pool join/leave, cooldown config
 */
export class Arena {
  /** SDK configuration. */
  private config: ArenaConfig;

  /** Resolved deployment addresses. */
  public readonly addresses: DeploymentAddresses;

  /** ArenaCoreMain contract instance — task creation, escrow, state. */
  public readonly main: ethersLib.Contract;

  /** ArenaCoreAuction contract instance — bidding, settlement, slashing. */
  public readonly auction: ethersLib.Contract;

  /** ArenaCoreVRF contract instance — verifier pool, random selection. */
  public readonly vrf: ethersLib.Contract;

  /** ERC-20 settlement token contract. */
  public readonly token: ethersLib.Contract;

  /** ArenaArbitration contract instance. */
  public readonly arbitration: ethersLib.Contract;

  /** ArenaReputation contract instance. */
  public readonly reputation: ethersLib.Contract;

  /** ArenaInsurance contract instance. */
  public readonly insurance: ethersLib.Contract;

  /** ArenaOutcomes contract instance. */
  public readonly outcomes: ethersLib.Contract;

  /** ArenaContinuous contract instance. */
  public readonly continuous: ethersLib.Contract;

  /** ArenaSyndicates contract instance. */
  public readonly syndicates: ethersLib.Contract;

  /** ArenaDelegation contract instance. */
  public readonly delegation: ethersLib.Contract;

  /** ArenaCompliance contract instance. */
  public readonly compliance: ethersLib.Contract;

  /** Typed event listener for Arena events (listens on Main + Auction + VRF). */
  public readonly events: ArenaEventListener;

  /**
   * Create a new Arena SDK instance.
   *
   * Supply either a `chainId` to auto-resolve all addresses, or provide
   * `mainAddress` + `auctionAddress` + `vrfAddress` explicitly.
   *
   * @param config - SDK configuration
   *
   * @example
   * ```ts
   * // Auto-resolve from chain ID
   * const arena = new Arena({ rpcUrl: '...', chainId: 84532, signer });
   *
   * // Or supply addresses explicitly
   * const arena = new Arena({
   *   rpcUrl: '...',
   *   mainAddress: '0x...',
   *   auctionAddress: '0x...',
   *   vrfAddress: '0x...',
   *   tokenAddress: '0x...',
   *   signer,
   * });
   * ```
   */
  constructor(config: ArenaConfig) {
    this.config = {
      chain: 'base',
      ipfsGateway: 'https://ipfs.io/ipfs/',
      ...config,
    };

    // Resolve addresses
    if (config.chainId) {
      this.addresses = getAddressesOrThrow(config.chainId);
    } else if (config.mainAddress && config.auctionAddress && config.vrfAddress) {
      // Build DeploymentAddresses from explicit config
      this.addresses = {
        token: config.tokenAddress || ZERO_ADDRESS,
        main: config.mainAddress,
        auction: config.auctionAddress,
        vrf: config.vrfAddress,
        arbitration: ZERO_ADDRESS,
        reputation: ZERO_ADDRESS,
        consensus: ZERO_ADDRESS,
        profiles: ZERO_ADDRESS,
        recurring: ZERO_ADDRESS,
        syndicates: ZERO_ADDRESS,
        insurance: ZERO_ADDRESS,
        delegation: ZERO_ADDRESS,
        outcomes: ZERO_ADDRESS,
        compliance: ZERO_ADDRESS,
        timelock: ZERO_ADDRESS,
      };
    } else if (config.contractAddress) {
      // Legacy single-address mode: treat contractAddress as main
      this.addresses = {
        token: config.tokenAddress || ZERO_ADDRESS,
        main: config.contractAddress,
        auction: ZERO_ADDRESS,
        vrf: ZERO_ADDRESS,
        arbitration: ZERO_ADDRESS,
        reputation: ZERO_ADDRESS,
        consensus: ZERO_ADDRESS,
        profiles: ZERO_ADDRESS,
        recurring: ZERO_ADDRESS,
        syndicates: ZERO_ADDRESS,
        insurance: ZERO_ADDRESS,
        delegation: ZERO_ADDRESS,
        outcomes: ZERO_ADDRESS,
        compliance: ZERO_ADDRESS,
        timelock: ZERO_ADDRESS,
      };
    } else {
      throw new ArenaError(
        'ARENA_CONFIG',
        'Either chainId or mainAddress + auctionAddress + vrfAddress must be provided'
      );
    }

    // Instantiate core contracts
    const signer = config.signer;
    this.main = new ethersLib.Contract(this.addresses.main, ARENA_MAIN_ABI, signer);
    this.auction = new ethersLib.Contract(this.addresses.auction, ARENA_AUCTION_ABI, signer);
    this.vrf = new ethersLib.Contract(this.addresses.vrf, ARENA_VRF_ABI, signer);
    this.token = new ethersLib.Contract(this.addresses.token, ERC20_ABI, signer);

    // Instantiate satellite contracts
    this.arbitration = new ethersLib.Contract(this.addresses.arbitration, ARENA_ARBITRATION_ABI, signer);
    this.reputation = new ethersLib.Contract(this.addresses.reputation, ARENA_REPUTATION_ABI, signer);
    this.insurance = new ethersLib.Contract(this.addresses.insurance, ARENA_INSURANCE_ABI, signer);
    this.outcomes = new ethersLib.Contract(this.addresses.outcomes, ARENA_OUTCOMES_ABI, signer);
    this.continuous = new ethersLib.Contract(this.addresses.recurring, ARENA_CONTINUOUS_ABI, signer);
    this.syndicates = new ethersLib.Contract(this.addresses.syndicates, ARENA_SYNDICATES_ABI, signer);
    this.delegation = new ethersLib.Contract(this.addresses.delegation, ARENA_DELEGATION_ABI, signer);
    this.compliance = new ethersLib.Contract(this.addresses.compliance, ARENA_COMPLIANCE_ABI, signer);

    // Event listener spans Main + Auction + VRF
    this.events = new ArenaEventListener(this.main, this.auction, this.vrf);
  }

  // ═══════════════════════════════════════════════════
  // CONVENIENCE METHOD 1: createAndFundTask
  // ═══════════════════════════════════════════════════

  /**
   * Create a new task with automatic USDC approval and escrow funding.
   *
   * Calls `token.approve()` for the bounty amount targeting ArenaCoreMain,
   * then `main.createTask()`, and extracts the `taskId` from the `TaskCreated` event.
   *
   * @param params - Task parameters (type, bounty, deadline, etc.)
   * @returns The task ID, approval tx, and creation tx
   */
  async createAndFundTask(params: TaskParams): Promise<CreateAndFundResult> {
    const bountyWei = parseAmount(params.bounty);
    const deadline = Math.floor(Date.now() / 1000) + parseDuration(params.deadline);
    const slashWindow = parseDuration(params.slashWindow);
    const bidDuration = parseDuration(params.bidDuration || '1h');
    const revealDuration = parseDuration(params.revealDuration || '30m');
    const tokenAddr = params.token || this.addresses.token;

    // Pin criteria to IPFS
    const criteriaHash = await this.pinToIPFS(params.criteria);

    // Step 1: Approve token spend (bounty goes to Main for escrow)
    const approveTx = await this.token.approve(this.addresses.main, bountyWei);
    const approveReceipt = await approveTx.wait();

    // Step 2: Create the task on Main
    try {
      const tx = await this.main.createTask(
        bountyWei,
        deadline,
        slashWindow,
        bidDuration,
        revealDuration,
        params.verifiers,
        criteriaHash,
        params.type,
        tokenAddr,
      );

      const receipt = await tx.wait();

      // Extract taskId from TaskCreated event
      const event = receipt.logs?.find((l: any) => {
        try { return this.main.interface.parseLog(l)?.name === 'TaskCreated'; } catch { return false; }
      });
      const taskId = event
        ? this.main.interface.parseLog(event)!.args[0].toString()
        : '0';

      return {
        taskId,
        approveTx: formatReceipt(approveReceipt),
        createTx: formatReceipt(receipt),
      };
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // CONVENIENCE METHOD 2: bidOnTask
  // ═══════════════════════════════════════════════════

  /**
   * Submit a sealed bid on a task with automatic approval and salt generation.
   *
   * Generates a random 32-byte salt, computes the commit hash, checks USDC
   * allowance for Auction contract (approving if needed), then calls
   * `auction.commitBid()`. The salt is returned and **must be persisted**
   * for the reveal phase.
   *
   * @param params - Bid parameters (taskId, stake, price, eta)
   * @returns The salt (keep it!), optional approve tx, and commit tx
   */
  async bidOnTask(params: BidParams): Promise<BidOnTaskResult> {
    const stakeWei = parseAmount(params.stake);
    const priceWei = parseAmount(params.price);
    const etaSeconds = parseDuration(params.eta);
    const salt = generateSalt();

    const agentAddress = await this.config.signer.getAddress();
    const commitHash = computeCommitHash(ethersLib, agentAddress, stakeWei, priceWei, etaSeconds, salt);

    // Generate criteria acknowledgement hash
    const criteriaAckHash = ethersLib.keccak256(ethersLib.toUtf8Bytes('ack'));

    // Check and approve allowance for Auction (stakes go to Auction)
    let approveTx: TransactionResult | null = null;
    const currentAllowance = await this.token.allowance(agentAddress, this.addresses.auction);
    if (currentAllowance < stakeWei) {
      const tx = await this.token.approve(this.addresses.auction, stakeWei);
      const receipt = await tx.wait();
      approveTx = formatReceipt(receipt);
    }

    // Submit sealed bid to Auction
    try {
      const tx = await this.auction.commitBid(params.taskId, commitHash, criteriaAckHash);
      const receipt = await tx.wait();

      return {
        salt,
        approveTx,
        commitTx: formatReceipt(receipt),
      };
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // CONVENIENCE METHOD 3: getTaskFullDetails
  // ═══════════════════════════════════════════════════

  /**
   * Get comprehensive task details aggregated from multiple contracts.
   *
   * Fetches data from Main (task + assignment), Auction (verifications),
   * Insurance (policy), Outcomes (risk/credit), Compliance (suspension),
   * and Arbitration (dispute) — all in parallel where possible.
   *
   * @param taskId - The task ID to query
   * @returns Full task details
   */
  async getTaskFullDetails(taskId: string): Promise<TaskFullDetails> {
    // Fetch core task info first (needed for subsequent queries)
    const task = await this.getTask(taskId);

    // Determine if assigned
    const isAssigned = ['assigned', 'delivered', 'verifying', 'completed', 'failed', 'disputed'].includes(task.status);

    // Parallel fetch everything else
    const [
      assignmentRaw,
      verifications,
      insurancePolicyId,
      isSuspended,
      isRiskRegistered,
      isCreditRegistered,
      disputeId,
    ] = await Promise.all([
      isAssigned ? this.safeCall(() => this.main.getAssignment(taskId)) : null,
      this.safeCall(() => this.getVerifications(taskId), []),
      this.safeCall(() => this.insurance.getTaskInsurancePolicy(taskId), BigInt(0)),
      this.safeCall(() => this.compliance.isTaskSuspended(taskId), false),
      this.safeCall(() => this.outcomes.isRiskRegistered(taskId), false),
      this.safeCall(() => this.outcomes.isCreditRegistered(taskId), false),
      this.safeCall(() => this.arbitration.getTaskDisputeId(taskId), BigInt(0)),
    ]);

    // Parse assignment
    let assignment: AssignmentInfo | null = null;
    if (assignmentRaw && assignmentRaw.agent !== ZERO_ADDRESS) {
      assignment = {
        agent: assignmentRaw.agent,
        stake: formatAmount(assignmentRaw.stake),
        price: formatAmount(assignmentRaw.price),
        assignedAt: Number(assignmentRaw.assignedAt),
        deliveredAt: Number(assignmentRaw.deliveredAt),
        outputHash: assignmentRaw.outputHash,
      };
    }

    // Fetch agent reputation if assigned
    let agentReputation: number | null = null;
    if (assignment) {
      const stats = await this.safeCall(() => this.getAgentStats(assignment!.agent));
      if (stats) {
        agentReputation = stats.reputation;
      }
    }

    // Fetch insurance policy if exists
    let insuranceInfo: InsurancePolicyInfo | null = null;
    const policyIdNum = Number(insurancePolicyId);
    if (policyIdNum > 0) {
      const policy = await this.safeCall(() => this.insurance.getInsurancePolicy(policyIdNum));
      if (policy) {
        insuranceInfo = {
          hasPolicy: true,
          policyId: policyIdNum,
          insurer: policy.insurer,
          insured: policy.insured,
          coverageBps: Number(policy.coverageBps),
          maxCoverage: formatAmount(policy.maxCoverage),
          premiumPaid: formatAmount(policy.premiumPaid),
          status: parseInsuranceStatus(Number(policy.status)),
        };
      }
    }

    return {
      task,
      assignment,
      verifications: verifications || [],
      insurance: insuranceInfo,
      agentReputation,
      isSuspended: isSuspended as boolean,
      hasOutcomeRegistered: (isRiskRegistered as boolean) || (isCreditRegistered as boolean),
      disputeId: Number(disputeId),
    };
  }

  // ═══════════════════════════════════════════════════
  // CONVENIENCE METHOD 4: getAgentProfile
  // ═══════════════════════════════════════════════════

  /**
   * Get a comprehensive agent profile aggregated from all protocol contracts.
   *
   * @param agentAddress - The agent's wallet address
   * @returns Full agent profile
   */
  async getAgentProfile(agentAddress: string): Promise<AgentProfile> {
    // Parallel fetch from all contracts
    const [
      stats,
      nftBalance,
      delegationPool,
      insurerStatus,
      tosAccepted,
      isSanctioned,
    ] = await Promise.all([
      this.getAgentStats(agentAddress),
      this.safeCall(() => this.reputation.balanceOf(agentAddress), BigInt(0)),
      this.safeCall(() => this.delegation.getAgentDelegationPool(agentAddress)),
      this.safeCall(() => this.insurance.getInsurerCapitalStatus(agentAddress)),
      this.safeCall(() => this.compliance.hasAcceptedCurrentTos(agentAddress), false),
      this.safeCall(() => this.compliance.isSanctioned(agentAddress), false),
    ]);

    // Calculate total earnings from TaskCompleted events (on Auction)
    let totalEarnings = BigInt(0);
    try {
      const filter = this.auction.filters.TaskCompleted(null, agentAddress);
      const events = await this.auction.queryFilter(filter);
      for (const event of events) {
        const parsed = this.auction.interface.parseLog(event as any);
        if (parsed) {
          totalEarnings += parsed.args[2]; // payout
        }
      }
    } catch {
      // Event query may fail on some RPC providers
    }

    // Parse delegation pool
    let delegationPoolInfo: DelegationPoolInfo | null = null;
    if (delegationPool && delegationPool.totalDelegated > BigInt(0)) {
      delegationPoolInfo = {
        token: delegationPool.token,
        totalDelegated: formatAmount(delegationPool.totalDelegated),
        delegatorCount: Number(delegationPool.delegatorCount),
        revenueShareBps: Number(delegationPool.revenueShareBps),
        acceptingDelegations: delegationPool.acceptingDelegations,
        lockedCapital: formatAmount(delegationPool.lockedCapital),
      };
    }

    return {
      address: agentAddress,
      totalCompleted: stats.tasksCompleted,
      totalFailed: stats.tasksFailed,
      winRate: stats.successRate,
      totalEarnings: formatAmount(totalEarnings),
      activeStake: stats.activeStake,
      reputation: stats.reputation,
      banned: stats.banned,
      hasReputationNFT: Number(nftBalance) > 0,
      delegationPool: delegationPoolInfo,
      insurerActivePolicies: insurerStatus ? Number(insurerStatus.activePolicies) : 0,
      insurerLockedCapital: insurerStatus ? formatAmount(insurerStatus.locked) : '0',
      tosAccepted: tosAccepted as boolean,
      isSanctioned: isSanctioned as boolean,
    };
  }

  // ═══════════════════════════════════════════════════
  // CONVENIENCE METHOD 5: getProtocolStats
  // ═══════════════════════════════════════════════════

  /**
   * Get protocol-wide statistics aggregated across all contracts.
   *
   * @returns Protocol statistics overview
   */
  async getProtocolStats(): Promise<ProtocolStats> {
    // Parallel fetch — taskCount from Main, verifierPoolLength from VRF
    const [
      taskCount,
      verifierPoolLength,
      treasuryBalance,
    ] = await Promise.all([
      this.safeCall(() => this.main.taskCount(), BigInt(0)),
      this.safeCall(() => this.vrf.verifierPoolLength(), BigInt(0)),
      this.safeCall(() => this.token.balanceOf(this.addresses.main), BigInt(0)),
    ]);

    // Calculate GMV from TaskCreated events (on Main)
    let totalGMV = BigInt(0);
    const uniqueAgents = new Set<string>();

    try {
      const createdFilter = this.main.filters.TaskCreated();
      const createdEvents = await this.main.queryFilter(createdFilter);
      for (const event of createdEvents) {
        const parsed = this.main.interface.parseLog(event as any);
        if (parsed) {
          totalGMV += parsed.args[2]; // bounty
        }
      }
    } catch {
      // Event query may not be available
    }

    // Count unique agents from AgentAssigned events (on Auction)
    try {
      const assignedFilter = this.auction.filters.AgentAssigned();
      const assignedEvents = await this.auction.queryFilter(assignedFilter);
      for (const event of assignedEvents) {
        const parsed = this.auction.interface.parseLog(event as any);
        if (parsed) {
          uniqueAgents.add(parsed.args[1]); // agent address
        }
      }
    } catch {
      // Event query may not be available
    }

    return {
      totalTasks: Number(taskCount),
      totalGMV: formatAmount(totalGMV),
      treasuryBalance: formatAmount(treasuryBalance as bigint),
      activeAgents: uniqueAgents.size,
      activeVerifiers: Number(verifierPoolLength),
    };
  }

  // ═══════════════════════════════════════════════════
  // TASK MANAGEMENT (→ Main)
  // ═══════════════════════════════════════════════════

  /**
   * Submit a new task to The Arena.
   * Handles token approval and escrow deposit automatically.
   */
  async submitTask(params: TaskParams): Promise<{ taskId: string; tx: TransactionResult }> {
    const result = await this.createAndFundTask(params);
    return { taskId: result.taskId, tx: result.createTx };
  }

  /**
   * Cancel an open task (before assignment). Only the poster can cancel.
   */
  async cancelTask(taskId: string): Promise<TransactionResult> {
    try {
      const tx = await this.main.cancelTask(taskId);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // BIDDING (→ Auction)
  // ═══════════════════════════════════════════════════

  /**
   * Submit a sealed bid for a task. Returns the salt — agent MUST persist it.
   */
  async bid(params: BidParams): Promise<{ salt: string; tx: TransactionResult }> {
    const result = await this.bidOnTask(params);
    return { salt: result.salt, tx: result.commitTx };
  }

  /**
   * Reveal a previously committed bid. Transfers stake to Auction escrow.
   */
  async revealBid(
    taskId: string,
    stake: string,
    price: string,
    eta: string,
    salt: string,
  ): Promise<TransactionResult> {
    const stakeWei = parseAmount(stake);
    const priceWei = parseAmount(price);
    const etaSeconds = parseDuration(eta);

    // Approve stake for Auction contract
    await this.approveTokenForAuction(stakeWei);

    try {
      const tx = await this.auction.revealBid(taskId, stakeWei, priceWei, etaSeconds, salt);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  /**
   * Resolve auction after reveal deadline. Can be called by anyone.
   */
  async resolveAuction(taskId: string): Promise<TransactionResult> {
    try {
      const tx = await this.auction.resolveAuction(taskId);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // EXECUTION (→ Auction)
  // ═══════════════════════════════════════════════════

  /**
   * Deliver task output. Validates against the output schema before submission.
   */
  async deliver(params: DeliverParams & { skipValidation?: boolean }): Promise<TransactionResult> {
    if (!params.skipValidation) {
      const task = await this.getTask(params.taskId);
      const result = validateOutput(task.taskType, params.output);
      if (!result.valid) {
        throw new ArenaError(
          'ARENA_SCHEMA',
          `Output does not match required schema for "${task.taskType}": ${result.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`
        );
      }
    }

    const outputHash = await this.pinToIPFS(params.output);

    try {
      const tx = await this.auction['deliverTask(uint256,bytes32)'](params.taskId, outputHash);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // VERIFICATION (→ Auction for register/submit, VRF for pool)
  // ═══════════════════════════════════════════════════

  /**
   * Register as a verifier for a task with automatic stake approval.
   * Stake is sent to Auction contract.
   */
  async registerAsVerifier(params: VerifyParams): Promise<TransactionResult> {
    const stakeWei = parseAmount(params.stake);
    await this.approveTokenForAuction(stakeWei);

    try {
      const tx = await this.auction.registerVerifier(params.taskId, stakeWei);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  /**
   * Submit a verification vote (approved or rejected) with report.
   */
  async submitVerification(params: VerificationVoteParams): Promise<TransactionResult> {
    const reportHash = await this.pinToIPFS(params.report);
    const voteEnum = params.vote === 'approved' ? 1 : 2;

    try {
      const tx = await this.auction.submitVerification(params.taskId, voteEnum, reportHash);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  /**
   * Join the verifier pool. Stake is sent to VRF contract.
   */
  async joinVerifierPool(stake: string): Promise<TransactionResult> {
    const stakeWei = parseAmount(stake);
    await this.approveTokenForVRF(stakeWei);

    try {
      const tx = await this.vrf.joinVerifierPool(stakeWei);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  /**
   * Leave the verifier pool and reclaim staked tokens.
   */
  async leaveVerifierPool(): Promise<TransactionResult> {
    try {
      const tx = await this.vrf.leaveVerifierPool();
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // DISPUTES (→ Arbitration satellite)
  // ═══════════════════════════════════════════════════

  /**
   * Raise a dispute on a task via ArenaArbitration.
   */
  async raiseDispute(taskId: string): Promise<TransactionResult> {
    try {
      const tx = await this.arbitration.raiseDispute(taskId);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // DEADLINE ENFORCEMENT (→ Auction)
  // ═══════════════════════════════════════════════════

  /**
   * Enforce deadline on an overdue task. Can be called by anyone.
   */
  async enforceDeadline(taskId: string): Promise<TransactionResult> {
    try {
      const tx = await this.auction.enforceDeadline(taskId);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // SLASH BOND (→ Auction)
  // ═══════════════════════════════════════════════════

  /**
   * Claim the slash bond after the slash window expires.
   */
  async claimSlashBond(taskId: string): Promise<TransactionResult> {
    try {
      const tx = await this.auction.claimSlashBond(taskId);
      return formatReceipt(await tx.wait());
    } catch (error) {
      throw parseContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════
  // READ FUNCTIONS
  // ═══════════════════════════════════════════════════

  /**
   * Get task details from ArenaCoreMain.
   */
  async getTask(taskId: string): Promise<TaskInfo> {
    const task = await this.main.getTask(taskId);
    return {
      id: taskId,
      poster: task.poster,
      token: task.token,
      bounty: formatAmount(task.bounty),
      deadline: Number(task.deadline),
      slashWindow: Number(task.slashWindow),
      createdAt: Number(task.createdAt),
      bidDeadline: Number(task.bidDeadline),
      revealDeadline: Number(task.revealDeadline),
      requiredVerifiers: Number(task.requiredVerifiers),
      status: parseStatus(Number(task.status)),
      criteriaHash: task.criteriaHash,
      taskType: task.taskType as TaskType,
    };
  }

  /**
   * Get assignment details for a task from ArenaCoreMain.
   */
  async getAssignment(taskId: string): Promise<AssignmentInfo> {
    const a = await this.main.getAssignment(taskId);
    return {
      agent: a.agent,
      stake: formatAmount(a.stake),
      price: formatAmount(a.price),
      assignedAt: Number(a.assignedAt),
      deliveredAt: Number(a.deliveredAt),
      outputHash: a.outputHash,
    };
  }

  /**
   * Get agent statistics from ArenaCoreMain state mappings.
   */
  async getAgentStats(agentAddress: string): Promise<AgentStats> {
    // Read directly from Main's state mappings
    const [reputation, completed, failed, activeStake, banned] = await Promise.all([
      this.safeCall(() => this.main.agentReputation(agentAddress), BigInt(0)),
      this.safeCall(() => this.main.agentTasksCompleted(agentAddress), BigInt(0)),
      this.safeCall(() => this.main.agentTasksFailed(agentAddress), BigInt(0)),
      this.safeCall(() => this.main.agentActiveStake(agentAddress), BigInt(0)),
      this.safeCall(() => this.main.agentBanned(agentAddress), false),
    ]);

    const completedNum = Number(completed);
    const failedNum = Number(failed);
    const total = completedNum + failedNum;

    return {
      address: agentAddress,
      reputation: Number(reputation),
      tasksCompleted: completedNum,
      tasksFailed: failedNum,
      activeStake: formatAmount(activeStake as bigint),
      banned: banned as boolean,
      successRate: total > 0 ? (completedNum / total) * 100 : 0,
    };
  }

  /**
   * Get all bids for a task (from Auction contract).
   */
  async getTaskBids(taskId: string): Promise<BidInfo[]> {
    const bidInfos: BidInfo[] = [];

    try {
      const bidders = await this.auction.getTaskBidders(taskId);
      for (const bidder of bidders) {
        const bid = await this.auction.getBid(taskId, bidder);
        if (bid.revealed) {
          bidInfos.push({
            agent: bid.agent,
            stake: formatAmount(bid.stake),
            price: formatAmount(bid.price),
            eta: Number(bid.eta),
            revealed: true,
          });
        }
      }
    } catch {
      // Fallback: try from events
      try {
        const filter = this.auction.filters.BidRevealed(taskId);
        const events = await this.auction.queryFilter(filter);
        for (const event of events) {
          const parsed = this.auction.interface.parseLog(event as any);
          if (parsed) {
            bidInfos.push({
              agent: parsed.args[1],
              stake: formatAmount(parsed.args[2]),
              price: formatAmount(parsed.args[3]),
              eta: Number(parsed.args[4]),
              revealed: true,
            });
          }
        }
      } catch {
        // No bid data available
      }
    }

    return bidInfos;
  }

  /**
   * Get verifications for a task (from Auction events).
   */
  async getVerifications(taskId: string): Promise<VerificationInfo[]> {
    const verifications: VerificationInfo[] = [];

    try {
      const filter = this.auction.filters.VerificationSubmitted(taskId);
      const events = await this.auction.queryFilter(filter);

      for (const event of events) {
        const parsed = this.auction.interface.parseLog(event as any);
        if (parsed) {
          verifications.push({
            verifier: parsed.args[1],
            stake: '0', // not in event
            vote: parseVote(Number(parsed.args[2])),
            reportHash: '',
          });
        }
      }
    } catch {
      // fallback: no verification data available
    }

    return verifications;
  }

  /**
   * Get open tasks (paginated).
   */
  async getOpenTasks(offset: number = 0, limit: number = 20): Promise<TaskInfo[]> {
    const tasks: TaskInfo[] = [];
    const total = await this.main.taskCount();

    for (let i = offset; i < Math.min(Number(total), offset + limit); i++) {
      const task = await this.getTask(i.toString());
      if (task.status === 'open') {
        tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * Get the total number of tasks created.
   */
  async getTaskCount(): Promise<number> {
    const count = await this.main.taskCount();
    return Number(count);
  }

  /**
   * Get the verifier pool size from VRF.
   */
  async getVerifierPoolLength(): Promise<number> {
    const count = await this.vrf.verifierPoolLength();
    return Number(count);
  }

  // ═══════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════

  /**
   * Approve token spend for ArenaCoreMain (bounties).
   * @internal
   */
  private async approveTokenForMain(amount: bigint): Promise<void> {
    const allowance = await this.token.allowance(
      await this.config.signer.getAddress(),
      this.addresses.main,
    );
    if (allowance < amount) {
      const tx = await this.token.approve(this.addresses.main, amount);
      await tx.wait();
    }
  }

  /**
   * Approve token spend for ArenaCoreAuction (stakes).
   * @internal
   */
  private async approveTokenForAuction(amount: bigint): Promise<void> {
    const allowance = await this.token.allowance(
      await this.config.signer.getAddress(),
      this.addresses.auction,
    );
    if (allowance < amount) {
      const tx = await this.token.approve(this.addresses.auction, amount);
      await tx.wait();
    }
  }

  /**
   * Approve token spend for ArenaCoreVRF (verifier pool stakes).
   * @internal
   */
  private async approveTokenForVRF(amount: bigint): Promise<void> {
    const allowance = await this.token.allowance(
      await this.config.signer.getAddress(),
      this.addresses.vrf,
    );
    if (allowance < amount) {
      const tx = await this.token.approve(this.addresses.vrf, amount);
      await tx.wait();
    }
  }

  /**
   * Pin JSON data to IPFS (via Pinata if configured, otherwise SHA-256 fallback).
   * @internal
   */
  private async pinToIPFS(data: Record<string, any>): Promise<string> {
    if (this.config.pinataApiKey && this.config.pinataSecret) {
      const result = await pinJSON(data, {
        apiKey: this.config.pinataApiKey,
        apiSecret: this.config.pinataSecret,
        gateway: this.config.ipfsGateway,
      });
      return result.hash;
    }

    // Fallback: SHA-256 hash (no actual IPFS pinning)
    const json = JSON.stringify(data);
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(json));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Safe contract call wrapper — returns default value on failure.
   * @internal
   */
  private async safeCall<T>(fn: () => Promise<T>, fallback?: T): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return fallback !== undefined ? fallback : null;
    }
  }
}

export default Arena;

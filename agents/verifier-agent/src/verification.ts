/**
 * VerifierAgent — Verification Pipeline
 *
 * Full verification flow:
 * 1. Fetch agent's output from IPFS
 * 2. Fetch task criteria (to get the contract source)
 * 3. Run independent analysis (Slither + Mythril + Claude)
 * 4. Compare agent's findings against ours
 * 5. Make approve/reject decision
 * 6. Pin verification report to IPFS
 * 7. Submit vote on-chain (standard or comparison mode)
 */

import { ethers } from 'ethers';
import { retrieveJSON, pinJSON } from '@arena-protocol/sdk';
import type { PinataConfig } from '@arena-protocol/sdk';
import { runSlither } from './analyzers/slither.js';
import { runMythril } from './analyzers/mythril.js';
import { analyzeWithClaude, mergeFindings } from './analyzers/ai-analyst.js';
import { compareReports, buildVerificationReport } from './comparison.js';
import type { AgentConfig, AuditReport, VerificationDecision, TrackedVerification } from './types.js';
import type { Persistence } from './persistence.js';
import type { WalletManager } from './wallet.js';
import { verifyLog } from './logger.js';

// ArenaCore ABI for verification submission
const ARENA_VERIFY_ABI = [
  'function submitVerification(uint256 _taskId, uint8 _vote, bytes32 _reportHash)',
  'function submitComparisonVerification(uint256 _taskId, bytes32 _findingsHash, uint16 _matchScore, bool _missedCritical)',
  'function getTask(uint256 taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function comparisonMode(uint256) view returns (bool)',
];

export class VerificationPipeline {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletManager;
  private arenaContract: ethers.Contract;
  private pinataConfig: PinataConfig;

  constructor(config: AgentConfig, persistence: Persistence, wallet: WalletManager) {
    this.config = config;
    this.persistence = persistence;
    this.wallet = wallet;

    this.arenaContract = new ethers.Contract(
      config.arenaCoreAddress,
      ARENA_VERIFY_ABI,
      wallet.signer
    );

    this.pinataConfig = {
      apiKey: config.pinataApiKey,
      apiSecret: config.pinataSecret,
    };
  }

  /**
   * Execute the full verification pipeline for a task.
   */
  async verify(taskId: number): Promise<VerificationDecision> {
    const log = verifyLog.child({ taskId });

    try {
      log.info('Starting verification pipeline');
      this.persistence.updateVerification(taskId, { status: 'analyzing' });

      // ─── Step 1: Fetch agent's output from IPFS ───
      log.info('Fetching agent output from IPFS');
      const assignment = await this.arenaContract.getAssignment(taskId);
      const outputHash = assignment.outputHash;

      let agentReport: AuditReport;
      try {
        agentReport = await retrieveJSON(outputHash, this.pinataConfig) as AuditReport;
      } catch (err) {
        log.error({ err }, 'Failed to retrieve agent output from IPFS');
        throw new Error('Cannot retrieve agent output — unable to verify');
      }

      log.info(
        { agentFindings: agentReport.findings?.length || 0 },
        'Agent report retrieved'
      );

      // ─── Step 2: Fetch task criteria (contract source) ───
      log.info('Fetching task criteria');
      const task = await this.arenaContract.getTask(taskId);
      const criteriaHash = task.criteriaHash;

      let criteria: any;
      try {
        criteria = await retrieveJSON(criteriaHash, this.pinataConfig);
      } catch (err) {
        log.warn({ err }, 'Failed to retrieve criteria from IPFS');
        criteria = {};
      }

      const soliditySource = extractSoliditySource(criteria);
      if (!soliditySource) {
        throw new Error('No Solidity source code found in task criteria');
      }

      log.info({ sourceLength: soliditySource.length }, 'Solidity source extracted');

      // ─── Step 3: Run independent analysis ───
      log.info('Running independent analysis (Slither + Mythril)');
      const [slitherResult, mythrilResult] = await Promise.all([
        runSlither(soliditySource),
        runMythril(soliditySource),
      ]);

      log.info(
        {
          slitherFindings: slitherResult.findings.length,
          mythrilFindings: mythrilResult.findings.length,
        },
        'Static analysis complete'
      );

      // Claude AI analysis
      log.info('Running Claude AI analysis');
      const claudeResult = await analyzeWithClaude(
        this.config.anthropicApiKey,
        soliditySource,
        slitherResult,
        mythrilResult
      );

      log.info({ claudeFindings: claudeResult.findings.length }, 'Claude analysis complete');

      // Merge our independent findings
      const verifierFindings = mergeFindings(slitherResult, mythrilResult, claudeResult);
      log.info({ totalFindings: verifierFindings.length }, 'Independent findings merged');

      // ─── Step 4: Compare against agent's report ───
      log.info('Comparing agent report against independent analysis');
      const decision = compareReports(agentReport, verifierFindings, this.config);

      log.info(
        {
          vote: decision.vote,
          matchScore: decision.comparison.matchScore,
          missedCritical: decision.comparison.missedCritical,
          reason: decision.reason,
        },
        'Verification decision made'
      );

      // ─── Step 5: Build and pin verification report ───
      const report = buildVerificationReport(decision, verifierFindings, agentReport);
      log.info('Pinning verification report to IPFS');
      const pinResult = await pinJSON(report, this.pinataConfig);
      const reportHash = pinResult.hash;

      decision.reportHash = reportHash;
      log.info({ reportHash }, 'Verification report pinned');

      // ─── Step 6: Submit vote on-chain ───
      const isComparisonMode = await this.checkComparisonMode(taskId);

      if (isComparisonMode && this.config.useComparisonMode) {
        await this.submitComparisonVote(taskId, reportHash, decision);
      } else {
        await this.submitStandardVote(taskId, reportHash, decision);
      }

      // Update state
      this.persistence.updateVerification(taskId, {
        status: 'voted',
        vote: decision.vote,
        comparison: decision.comparison,
        reportHash,
        completedAt: Date.now(),
      });

      log.info(
        {
          vote: decision.vote,
          matchScore: decision.comparison.matchScore,
          comparisonMode: isComparisonMode,
        },
        'Verification complete'
      );

      return decision;
    } catch (err: any) {
      log.error({ err: err.message, stack: err.stack }, 'Verification failed');
      this.persistence.updateVerification(taskId, { status: 'failed' });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════
  // ON-CHAIN SUBMISSION
  // ═══════════════════════════════════════════════════

  /**
   * Submit a standard verification vote (Approved=1, Rejected=2).
   */
  private async submitStandardVote(
    taskId: number,
    reportHash: string,
    decision: VerificationDecision
  ): Promise<void> {
    const log = verifyLog.child({ taskId, mode: 'standard' });
    const voteEnum = decision.vote === 'approve' ? 1 : 2;

    log.info({ vote: decision.vote, voteEnum }, 'Submitting standard verification vote');

    const tx = await this.arenaContract.submitVerification(taskId, voteEnum, reportHash);
    const receipt = await tx.wait();

    log.info(
      { txHash: receipt.hash, gasUsed: receipt.gasUsed?.toString() },
      'Standard vote submitted'
    );
  }

  /**
   * Submit a comparison verification with match score and missed-critical flag.
   * Score thresholds (on-chain): >=8000 BPS = approve, <5000 BPS = reject.
   */
  private async submitComparisonVote(
    taskId: number,
    findingsHash: string,
    decision: VerificationDecision
  ): Promise<void> {
    const log = verifyLog.child({ taskId, mode: 'comparison' });
    const scoreBps = decision.comparison.matchScoreBps;
    const missedCrit = decision.comparison.missedCritical;

    log.info(
      { scoreBps, missedCritical: missedCrit },
      'Submitting comparison verification'
    );

    const tx = await this.arenaContract.submitComparisonVerification(
      taskId,
      findingsHash,
      scoreBps,
      missedCrit
    );
    const receipt = await tx.wait();

    log.info(
      { txHash: receipt.hash, gasUsed: receipt.gasUsed?.toString() },
      'Comparison vote submitted'
    );
  }

  /**
   * Check if comparison mode is enabled for a task.
   */
  private async checkComparisonMode(taskId: number): Promise<boolean> {
    try {
      return await this.arenaContract.comparisonMode(taskId);
    } catch {
      // comparisonMode may be internal — fall back to standard
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function extractSoliditySource(criteria: any): string | null {
  if (typeof criteria === 'string') {
    if (criteria.includes('pragma solidity') || criteria.includes('contract ')) {
      return criteria;
    }
    return null;
  }
  if (typeof criteria !== 'object') return null;

  const fields = ['source', 'source_code', 'sourceCode', 'contract_source',
    'contractSource', 'solidity', 'code', 'content'];

  for (const field of fields) {
    if (criteria[field] && typeof criteria[field] === 'string') return criteria[field];
  }

  if (criteria.contract && typeof criteria.contract === 'object') {
    for (const field of fields) {
      if (criteria.contract[field] && typeof criteria.contract[field] === 'string') {
        return criteria.contract[field];
      }
    }
  }

  if (Array.isArray(criteria.files)) {
    const solFiles = criteria.files
      .filter((f: any) => f.name?.endsWith('.sol') || f.path?.endsWith('.sol'))
      .map((f: any) => f.content || f.source || '')
      .filter(Boolean);
    if (solFiles.length > 0) return solFiles.join('\n\n');
  }

  return null;
}

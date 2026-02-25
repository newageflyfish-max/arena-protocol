/**
 * AuditAgent — Task Execution Pipeline
 *
 * Full execution flow:
 * 1. Fetch task criteria from IPFS
 * 2. Extract Solidity source code
 * 3. Run Slither + Mythril in parallel
 * 4. Run Claude AI analysis with all results
 * 5. Merge and deduplicate findings
 * 6. Validate against output schema
 * 7. Pin report to IPFS
 * 8. Deliver output hash on-chain
 */

import { ethers } from 'ethers';
import {
  retrieveJSON,
  pinJSON,
  validateOutput,
} from '@arena-protocol/sdk';
import type { PinataConfig } from '@arena-protocol/sdk';
import { runSlither } from './analyzers/slither.js';
import { runMythril } from './analyzers/mythril.js';
import { analyzeWithClaude, mergeFindings, generateSummary } from './analyzers/ai-analyst.js';
import type { AgentConfig, AuditReport } from './types.js';
import type { Persistence } from './persistence.js';
import type { WalletTracker } from './wallet.js';
import { execLog } from './logger.js';

// Minimal ABI for deliverTask
const ARENA_DELIVER_ABI = [
  'function deliverTask(uint256 taskId, bytes32 outputHash)',
  'function getTask(uint256 taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
];

export class ExecutionPipeline {
  private config: AgentConfig;
  private persistence: Persistence;
  private wallet: WalletTracker;
  private arenaContract: ethers.Contract;
  private pinataConfig: PinataConfig;

  constructor(config: AgentConfig, persistence: Persistence, wallet: WalletTracker) {
    this.config = config;
    this.persistence = persistence;
    this.wallet = wallet;

    this.arenaContract = new ethers.Contract(
      config.arenaCoreAddress,
      ARENA_DELIVER_ABI,
      wallet.signer
    );

    this.pinataConfig = {
      apiKey: config.pinataApiKey,
      apiSecret: config.pinataSecret,
    };
  }

  /**
   * Execute the full audit pipeline for an assigned task.
   */
  async execute(taskId: number): Promise<void> {
    const log = execLog.child({ taskId });

    try {
      log.info('Starting task execution');
      this.persistence.updateTaskState(taskId, { status: 'executing' });

      // ─── Step 1: Fetch criteria from IPFS ───
      log.info('Fetching task criteria from IPFS');
      const task = await this.arenaContract.getTask(taskId);
      const criteriaHash = task.criteriaHash;

      let criteria: any;
      try {
        criteria = await retrieveJSON(criteriaHash, this.pinataConfig);
      } catch (err) {
        log.warn({ err }, 'Failed to retrieve criteria from IPFS, using hash as reference');
        criteria = { description: `Audit task ${taskId}`, criteriaHash };
      }

      // ─── Step 2: Extract Solidity source ───
      const soliditySource = extractSoliditySource(criteria);
      if (!soliditySource) {
        throw new Error('No Solidity source code found in task criteria');
      }

      log.info({ sourceLength: soliditySource.length }, 'Solidity source extracted');

      // ─── Step 3: Run static analyzers in parallel ───
      log.info('Running static analysis (Slither + Mythril)');
      const [slitherResult, mythrilResult] = await Promise.all([
        runSlither(soliditySource),
        runMythril(soliditySource),
      ]);

      log.info(
        {
          slitherFindings: slitherResult.findings.length,
          mythrilFindings: mythrilResult.findings.length,
          slitherError: slitherResult.error || null,
          mythrilError: mythrilResult.error || null,
        },
        'Static analysis complete'
      );

      // ─── Step 4: Claude AI analysis ───
      log.info('Running Claude AI analysis');
      const claudeResult = await analyzeWithClaude(
        this.config.anthropicApiKey,
        soliditySource,
        slitherResult,
        mythrilResult
      );

      log.info(
        { claudeFindings: claudeResult.findings.length, claudeError: claudeResult.error || null },
        'Claude analysis complete'
      );

      // ─── Step 5: Merge and deduplicate findings ───
      const findings = mergeFindings(slitherResult, mythrilResult, claudeResult);
      const summary = generateSummary(findings, claudeResult);

      log.info({ totalFindings: findings.length }, 'Findings merged and deduplicated');

      // ─── Step 6: Build and validate report ───
      const report: AuditReport = {
        findings,
        summary,
        timestamp: Math.floor(Date.now() / 1000),
      };

      // Validate against SDK schema
      const validation = validateOutput('audit', report);
      if (!validation.valid) {
        log.error(
          { errors: validation.errors },
          'Report failed schema validation — attempting to fix'
        );
        // Try to fix common issues
        fixValidationErrors(report, validation.errors);
        const revalidation = validateOutput('audit', report);
        if (!revalidation.valid) {
          throw new Error(
            `Report still invalid after fix attempt: ${revalidation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`
          );
        }
      }

      log.info('Report validated against schema');

      // ─── Step 7: Pin report to IPFS ───
      log.info('Pinning report to IPFS');
      const pinResult = await pinJSON(report, this.pinataConfig);
      const outputHash = pinResult.hash;

      log.info({ outputHash, cid: pinResult.cid }, 'Report pinned to IPFS');

      // ─── Step 8: Deliver on-chain ───
      log.info('Delivering output on-chain');
      const tx = await this.arenaContract.deliverTask(taskId, outputHash);
      const receipt = await tx.wait();

      log.info(
        {
          txHash: receipt.hash,
          gasUsed: receipt.gasUsed?.toString(),
          outputHash,
          findingCount: findings.length,
        },
        'Task delivered successfully'
      );

      // Update state
      this.persistence.updateTaskState(taskId, {
        status: 'delivered',
        deliveryHash: outputHash,
      });
    } catch (err: any) {
      log.error({ err: err.message, stack: err.stack }, 'Task execution failed');
      this.persistence.updateTaskState(taskId, { status: 'failed' });
      throw err;
    }
  }
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

/**
 * Extract Solidity source from task criteria.
 * Supports multiple formats: direct source, source field, contract_source, etc.
 */
function extractSoliditySource(criteria: any): string | null {
  if (typeof criteria === 'string') {
    // Direct source code
    if (criteria.includes('pragma solidity') || criteria.includes('contract ')) {
      return criteria;
    }
    return null;
  }

  if (typeof criteria !== 'object') return null;

  // Try common field names
  const sourceFields = [
    'source',
    'source_code',
    'sourceCode',
    'contract_source',
    'contractSource',
    'solidity',
    'code',
    'content',
  ];

  for (const field of sourceFields) {
    if (criteria[field] && typeof criteria[field] === 'string') {
      return criteria[field];
    }
  }

  // Try nested structures
  if (criteria.contract && typeof criteria.contract === 'object') {
    for (const field of sourceFields) {
      if (criteria.contract[field] && typeof criteria.contract[field] === 'string') {
        return criteria.contract[field];
      }
    }
  }

  // If criteria has a files array, concatenate all .sol files
  if (Array.isArray(criteria.files)) {
    const solFiles = criteria.files
      .filter((f: any) => f.name?.endsWith('.sol') || f.path?.endsWith('.sol'))
      .map((f: any) => f.content || f.source || '')
      .filter(Boolean);
    if (solFiles.length > 0) return solFiles.join('\n\n');
  }

  return null;
}

/**
 * Attempt to fix common schema validation errors.
 */
function fixValidationErrors(report: AuditReport, errors: Array<{ path: string; message: string }>): void {
  const validSeverities = ['informational', 'low', 'medium', 'high', 'critical'];
  const validVulnTypes = [
    'reentrancy', 'access_control', 'oracle_manipulation', 'integer_overflow',
    'flash_loan', 'front_running', 'logic_errors', 'gas_optimization',
  ];

  for (const finding of report.findings) {
    if (!validSeverities.includes(finding.severity)) {
      finding.severity = 'informational';
    }
    if (!validVulnTypes.includes(finding.vulnerability_type)) {
      finding.vulnerability_type = 'logic_errors';
    }
    if (!finding.location) finding.location = 'Unknown';
    if (!finding.description) finding.description = 'No description provided';
    if (!finding.proof_of_concept) finding.proof_of_concept = 'N/A';
    if (!finding.recommendation) finding.recommendation = 'Review and fix';
  }
}

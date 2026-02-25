/**
 * AuditAgent — Mythril Symbolic Analyzer
 *
 * Runs Mythril via subprocess, parses JSON output,
 * and maps findings to the Arena audit schema.
 */

import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AuditFinding, VulnerabilityType, Severity, AnalyzerResult } from '../types.js';
import { analyzerLog } from '../logger.js';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════
// SWC ID → VULNERABILITY TYPE MAPPING
// https://swcregistry.io/
// ═══════════════════════════════════════════════════

const SWC_MAP: Record<string, VulnerabilityType> = {
  'SWC-100': 'logic_errors',         // Function default visibility
  'SWC-101': 'integer_overflow',      // Integer overflow/underflow
  'SWC-102': 'logic_errors',         // Outdated compiler version
  'SWC-103': 'logic_errors',         // Floating pragma
  'SWC-104': 'logic_errors',         // Unchecked call return value
  'SWC-105': 'access_control',       // Unprotected ether withdrawal
  'SWC-106': 'access_control',       // Unprotected self-destruct
  'SWC-107': 'reentrancy',           // Reentrancy
  'SWC-108': 'logic_errors',         // State variable default visibility
  'SWC-109': 'logic_errors',         // Uninitialized storage pointer
  'SWC-110': 'logic_errors',         // Assert violation
  'SWC-111': 'logic_errors',         // Use of deprecated functions
  'SWC-112': 'access_control',       // Delegatecall to untrusted callee
  'SWC-113': 'logic_errors',         // DoS with failed call
  'SWC-114': 'front_running',        // Transaction order dependence
  'SWC-115': 'access_control',       // Authorization through tx.origin
  'SWC-116': 'logic_errors',         // Block values as time proxy
  'SWC-117': 'logic_errors',         // Signature malleability
  'SWC-118': 'logic_errors',         // Incorrect constructor name
  'SWC-119': 'logic_errors',         // Shadowing state variables
  'SWC-120': 'oracle_manipulation',  // Weak sources of randomness
  'SWC-121': 'integer_overflow',     // Missing protection against sig replay
  'SWC-122': 'logic_errors',         // Lack of proper signature verification
  'SWC-123': 'logic_errors',         // Requirement violation
  'SWC-124': 'logic_errors',         // Write to arbitrary storage location
  'SWC-125': 'logic_errors',         // Incorrect inheritance order
  'SWC-126': 'logic_errors',         // Insufficient gas griefing
  'SWC-127': 'front_running',        // Arbitrary jump with function type variable
  'SWC-128': 'gas_optimization',     // DoS with block gas limit
  'SWC-129': 'logic_errors',         // Typographical error
  'SWC-130': 'logic_errors',         // Right-to-left override control character
  'SWC-131': 'logic_errors',         // Presence of unused variables
  'SWC-132': 'logic_errors',         // Unexpected ether balance
  'SWC-133': 'logic_errors',         // Hash collisions with multiple variable length args
  'SWC-134': 'logic_errors',         // Message call with hardcoded gas amount
  'SWC-135': 'logic_errors',         // Code with no effects
  'SWC-136': 'logic_errors',         // Unencrypted private data on-chain
};

// ═══════════════════════════════════════════════════
// SEVERITY MAPPING
// ═══════════════════════════════════════════════════

function mapMythrilSeverity(severity: string): Severity {
  const s = severity.toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'informational';
}

// ═══════════════════════════════════════════════════
// MYTHRIL RUNNER
// ═══════════════════════════════════════════════════

export async function runMythril(soliditySource: string): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'mythril' });

  // Create temp directory with Solidity file
  const tmpDir = mkdtempSync(join(tmpdir(), 'arena-mythril-'));
  const solFile = join(tmpDir, 'Target.sol');

  try {
    writeFileSync(solFile, soliditySource, 'utf-8');

    log.info('Running Mythril analysis...');

    const { stdout, stderr } = await execFileAsync(
      'myth',
      ['analyze', solFile, '-o', 'json', '--execution-timeout', '90'],
      {
        timeout: 180_000, // 3 minute timeout (Mythril is slower)
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    );

    // Parse JSON output
    let results: any;
    try {
      results = JSON.parse(stdout);
    } catch {
      log.warn({ stdout: stdout.slice(0, 500) }, 'Failed to parse Mythril output');
      return { source: 'mythril', findings: [], rawOutput: stdout, error: 'Failed to parse output' };
    }

    const findings = parseMythrilResults(results);
    log.info({ findingCount: findings.length }, 'Mythril analysis complete');

    return { source: 'mythril', findings, rawOutput: stdout };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      log.warn('Mythril not installed — skipping symbolic analysis');
      return { source: 'mythril', findings: [], error: 'Mythril not installed' };
    }

    // Mythril may exit non-zero with results
    if (err.stdout) {
      try {
        const results = JSON.parse(err.stdout);
        const findings = parseMythrilResults(results);
        log.info({ findingCount: findings.length }, 'Mythril analysis complete (with findings)');
        return { source: 'mythril', findings, rawOutput: err.stdout };
      } catch {
        // Fall through
      }
    }

    log.error({ err: err.message }, 'Mythril execution failed');
    return { source: 'mythril', findings: [], error: err.message };
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ═══════════════════════════════════════════════════
// RESULT PARSER
// ═══════════════════════════════════════════════════

function parseMythrilResults(results: any): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // Mythril output format: { success: true, issues: [...] }
  const issues = results?.issues || results?.result?.issues || [];

  for (const issue of issues) {
    // Extract SWC ID for mapping
    const swcId = issue.swc_id || issue.swcID || '';
    const swcKey = swcId ? `SWC-${swcId}` : '';
    const vulnType = SWC_MAP[swcKey] || 'logic_errors';
    const severity = mapMythrilSeverity(issue.severity || 'Medium');

    // Build location
    const filename = issue.filename || issue.contract || 'Unknown';
    const lineno = issue.lineno || issue.sourceMap?.split(':')[0] || '';
    const location = lineno ? `${filename}:${lineno}` : filename;

    findings.push({
      severity,
      vulnerability_type: vulnType,
      location,
      description: issue.description?.head || issue.title || `${swcKey} detected`,
      proof_of_concept: issue.description?.tail || issue.debug || 'See Mythril output for details',
      recommendation: getRecommendation(swcKey, vulnType),
    });
  }

  return findings;
}

function getRecommendation(swcId: string, vulnType: VulnerabilityType): string {
  // Specific SWC recommendations
  const swcRecs: Record<string, string> = {
    'SWC-101': 'Use Solidity 0.8+ built-in overflow checks or SafeMath library',
    'SWC-107': 'Apply checks-effects-interactions pattern or use OpenZeppelin ReentrancyGuard',
    'SWC-105': 'Add access control modifiers to withdrawal functions',
    'SWC-106': 'Add access control to self-destruct or remove it entirely',
    'SWC-114': 'Implement commit-reveal pattern to prevent front-running',
    'SWC-115': 'Use msg.sender instead of tx.origin for authorization',
    'SWC-120': 'Use Chainlink VRF or similar verifiable randomness source',
  };

  if (swcRecs[swcId]) return swcRecs[swcId];

  // Generic recommendations by vulnerability type
  const typeRecs: Record<VulnerabilityType, string> = {
    reentrancy: 'Apply checks-effects-interactions pattern or use ReentrancyGuard',
    access_control: 'Add appropriate access control modifiers',
    integer_overflow: 'Ensure Solidity 0.8+ or use SafeMath',
    oracle_manipulation: 'Use TWAP or multiple oracle sources',
    front_running: 'Implement commit-reveal or use private mempool',
    logic_errors: 'Review logic flow and add proper validation',
    gas_optimization: 'Optimize storage patterns and reduce operations',
    flash_loan: 'Add multi-block checks or delay mechanisms',
  };

  return typeRecs[vulnType] || 'Review and fix the identified issue';
}

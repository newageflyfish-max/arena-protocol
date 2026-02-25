/**
 * AuditAgent — Slither Static Analyzer
 *
 * Runs Slither via subprocess, parses JSON output,
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
// SLITHER DETECTOR → VULNERABILITY TYPE MAPPING
// ═══════════════════════════════════════════════════

const DETECTOR_MAP: Record<string, VulnerabilityType> = {
  // Reentrancy
  'reentrancy-eth': 'reentrancy',
  'reentrancy-no-eth': 'reentrancy',
  'reentrancy-benign': 'reentrancy',
  'reentrancy-events': 'reentrancy',
  'reentrancy-unlimited-gas': 'reentrancy',

  // Access control
  'unprotected-upgrade': 'access_control',
  'suicidal': 'access_control',
  'arbitrary-send-erc20': 'access_control',
  'arbitrary-send-eth': 'access_control',
  'tx-origin': 'access_control',
  'uninitialized-state': 'access_control',
  'controlled-delegatecall': 'access_control',
  'protected-vars': 'access_control',

  // Integer overflow
  'divide-before-multiply': 'integer_overflow',
  'tautology': 'integer_overflow',

  // Oracle manipulation
  'weak-prng': 'oracle_manipulation',

  // Front-running
  'front-run': 'front_running',

  // Logic errors
  'unchecked-transfer': 'logic_errors',
  'unchecked-lowlevel': 'logic_errors',
  'unchecked-send': 'logic_errors',
  'incorrect-equality': 'logic_errors',
  'missing-zero-check': 'logic_errors',
  'shadowing-state': 'logic_errors',
  'shadowing-local': 'logic_errors',
  'uninitialized-local': 'logic_errors',
  'unused-return': 'logic_errors',
  'locked-ether': 'logic_errors',
  'dead-code': 'logic_errors',
  'incorrect-shift': 'logic_errors',
  'boolean-cst': 'logic_errors',
  'void-cst': 'logic_errors',

  // Gas optimization
  'constable-states': 'gas_optimization',
  'external-function': 'gas_optimization',
  'costly-loop': 'gas_optimization',
  'cache-array-length': 'gas_optimization',
  'immutable-states': 'gas_optimization',
};

// ═══════════════════════════════════════════════════
// SEVERITY MAPPING
// ═══════════════════════════════════════════════════

const SEVERITY_MAP: Record<string, Severity> = {
  'High': 'high',
  'Medium': 'medium',
  'Low': 'low',
  'Informational': 'informational',
  'Optimization': 'informational',
};

// ═══════════════════════════════════════════════════
// SLITHER RUNNER
// ═══════════════════════════════════════════════════

export async function runSlither(soliditySource: string): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'slither' });

  // Create temp directory with Solidity file
  const tmpDir = mkdtempSync(join(tmpdir(), 'arena-slither-'));
  const solFile = join(tmpDir, 'Target.sol');

  try {
    writeFileSync(solFile, soliditySource, 'utf-8');

    log.info('Running Slither analysis...');

    const { stdout, stderr } = await execFileAsync(
      'slither',
      [solFile, '--json', '-', '--solc-disable-warnings'],
      {
        timeout: 120_000, // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    );

    // Parse JSON output
    let results: any;
    try {
      results = JSON.parse(stdout);
    } catch {
      // Slither sometimes outputs JSON on stderr
      try {
        results = JSON.parse(stderr);
      } catch {
        log.warn({ stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) }, 'Failed to parse Slither output');
        return { source: 'slither', findings: [], rawOutput: stdout, error: 'Failed to parse output' };
      }
    }

    const findings = parseSlitherResults(results);
    log.info({ findingCount: findings.length }, 'Slither analysis complete');

    return { source: 'slither', findings, rawOutput: stdout };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      log.warn('Slither not installed — skipping static analysis');
      return { source: 'slither', findings: [], error: 'Slither not installed' };
    }

    // Slither exits with non-zero when it finds issues
    if (err.stdout) {
      try {
        const results = JSON.parse(err.stdout);
        const findings = parseSlitherResults(results);
        log.info({ findingCount: findings.length }, 'Slither analysis complete (with findings)');
        return { source: 'slither', findings, rawOutput: err.stdout };
      } catch {
        // Fall through
      }
    }

    log.error({ err: err.message }, 'Slither execution failed');
    return { source: 'slither', findings: [], error: err.message };
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

function parseSlitherResults(results: any): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (!results?.results?.detectors) return findings;

  for (const detector of results.results.detectors) {
    const detectorId: string = detector.check || detector.id || 'unknown';
    const vulnType = DETECTOR_MAP[detectorId] || 'logic_errors';
    const severity = SEVERITY_MAP[detector.impact] || 'informational';

    // Build location string from elements
    let location = 'Unknown';
    if (detector.elements && detector.elements.length > 0) {
      const el = detector.elements[0];
      const name = el.name || el.source_mapping?.filename_short || 'Unknown';
      const lines = el.source_mapping?.lines;
      if (lines && lines.length > 0) {
        location = `${name} (line ${lines[0]}${lines.length > 1 ? `-${lines[lines.length - 1]}` : ''})`;
      } else {
        location = name;
      }
    }

    findings.push({
      severity,
      vulnerability_type: vulnType,
      location,
      description: detector.description || `${detectorId} detected`,
      proof_of_concept: detector.markdown || detector.description || 'See Slither output for details',
      recommendation: detector.recommendation || getDefaultRecommendation(vulnType),
    });
  }

  return findings;
}

function getDefaultRecommendation(vulnType: VulnerabilityType): string {
  switch (vulnType) {
    case 'reentrancy':
      return 'Apply checks-effects-interactions pattern or use ReentrancyGuard';
    case 'access_control':
      return 'Add appropriate access control modifiers (onlyOwner, role-based)';
    case 'integer_overflow':
      return 'Use SafeMath or Solidity 0.8+ built-in overflow checks';
    case 'oracle_manipulation':
      return 'Use TWAP or multiple oracle sources for price feeds';
    case 'front_running':
      return 'Implement commit-reveal pattern or use private mempool';
    case 'logic_errors':
      return 'Review logic flow and add proper validation checks';
    case 'gas_optimization':
      return 'Optimize storage access patterns and reduce unnecessary operations';
    case 'flash_loan':
      return 'Add flash loan protection (e.g., multi-block checks, delay mechanisms)';
  }
}

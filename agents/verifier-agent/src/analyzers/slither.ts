/**
 * VerifierAgent — Slither Static Analyzer
 *
 * Identical to AuditAgent's Slither runner — independent analysis
 * of the same contract to compare against the agent's submission.
 */

import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AuditFinding, VulnerabilityType, Severity, AnalyzerResult } from '../types.js';
import { analyzerLog } from '../logger.js';

const execFileAsync = promisify(execFile);

const DETECTOR_MAP: Record<string, VulnerabilityType> = {
  'reentrancy-eth': 'reentrancy',
  'reentrancy-no-eth': 'reentrancy',
  'reentrancy-benign': 'reentrancy',
  'reentrancy-events': 'reentrancy',
  'reentrancy-unlimited-gas': 'reentrancy',
  'unprotected-upgrade': 'access_control',
  'suicidal': 'access_control',
  'arbitrary-send-erc20': 'access_control',
  'arbitrary-send-eth': 'access_control',
  'tx-origin': 'access_control',
  'uninitialized-state': 'access_control',
  'controlled-delegatecall': 'access_control',
  'protected-vars': 'access_control',
  'divide-before-multiply': 'integer_overflow',
  'tautology': 'integer_overflow',
  'weak-prng': 'oracle_manipulation',
  'front-run': 'front_running',
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
  'constable-states': 'gas_optimization',
  'external-function': 'gas_optimization',
  'costly-loop': 'gas_optimization',
  'cache-array-length': 'gas_optimization',
  'immutable-states': 'gas_optimization',
};

const SEVERITY_MAP: Record<string, Severity> = {
  'High': 'high',
  'Medium': 'medium',
  'Low': 'low',
  'Informational': 'informational',
  'Optimization': 'informational',
};

export async function runSlither(soliditySource: string): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'slither' });
  const tmpDir = mkdtempSync(join(tmpdir(), 'verifier-slither-'));
  const solFile = join(tmpDir, 'Target.sol');

  try {
    writeFileSync(solFile, soliditySource, 'utf-8');
    log.info('Running Slither analysis...');

    const { stdout, stderr } = await execFileAsync(
      'slither',
      [solFile, '--json', '-', '--solc-disable-warnings'],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
    );

    let results: any;
    try {
      results = JSON.parse(stdout);
    } catch {
      try { results = JSON.parse(stderr); } catch {
        return { source: 'slither', findings: [], rawOutput: stdout, error: 'Failed to parse output' };
      }
    }

    const findings = parseSlitherResults(results);
    log.info({ findingCount: findings.length }, 'Slither analysis complete');
    return { source: 'slither', findings, rawOutput: stdout };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      log.warn('Slither not installed — skipping');
      return { source: 'slither', findings: [], error: 'Slither not installed' };
    }
    if (err.stdout) {
      try {
        const results = JSON.parse(err.stdout);
        const findings = parseSlitherResults(results);
        log.info({ findingCount: findings.length }, 'Slither analysis complete (with findings)');
        return { source: 'slither', findings, rawOutput: err.stdout };
      } catch { /* fall through */ }
    }
    log.error({ err: err.message }, 'Slither execution failed');
    return { source: 'slither', findings: [], error: err.message };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function parseSlitherResults(results: any): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!results?.results?.detectors) return findings;

  for (const detector of results.results.detectors) {
    const detectorId: string = detector.check || detector.id || 'unknown';
    const vulnType = DETECTOR_MAP[detectorId] || 'logic_errors';
    const severity = SEVERITY_MAP[detector.impact] || 'informational';

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
      proof_of_concept: detector.markdown || detector.description || 'See Slither output',
      recommendation: detector.recommendation || getDefaultRecommendation(vulnType),
    });
  }
  return findings;
}

function getDefaultRecommendation(vulnType: VulnerabilityType): string {
  const recs: Record<VulnerabilityType, string> = {
    reentrancy: 'Apply checks-effects-interactions pattern or use ReentrancyGuard',
    access_control: 'Add appropriate access control modifiers',
    integer_overflow: 'Use Solidity 0.8+ built-in overflow checks',
    oracle_manipulation: 'Use TWAP or multiple oracle sources',
    front_running: 'Implement commit-reveal pattern',
    logic_errors: 'Review logic flow and add proper validation',
    gas_optimization: 'Optimize storage access patterns',
    flash_loan: 'Add flash loan protection mechanisms',
  };
  return recs[vulnType];
}

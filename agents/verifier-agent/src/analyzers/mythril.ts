/**
 * VerifierAgent — Mythril Symbolic Analyzer
 */

import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AuditFinding, VulnerabilityType, Severity, AnalyzerResult } from '../types.js';
import { analyzerLog } from '../logger.js';

const execFileAsync = promisify(execFile);

const SWC_MAP: Record<string, VulnerabilityType> = {
  'SWC-100': 'logic_errors',
  'SWC-101': 'integer_overflow',
  'SWC-102': 'logic_errors',
  'SWC-103': 'logic_errors',
  'SWC-104': 'logic_errors',
  'SWC-105': 'access_control',
  'SWC-106': 'access_control',
  'SWC-107': 'reentrancy',
  'SWC-108': 'logic_errors',
  'SWC-109': 'logic_errors',
  'SWC-110': 'logic_errors',
  'SWC-111': 'logic_errors',
  'SWC-112': 'access_control',
  'SWC-113': 'logic_errors',
  'SWC-114': 'front_running',
  'SWC-115': 'access_control',
  'SWC-116': 'logic_errors',
  'SWC-117': 'logic_errors',
  'SWC-118': 'logic_errors',
  'SWC-119': 'logic_errors',
  'SWC-120': 'oracle_manipulation',
  'SWC-121': 'integer_overflow',
  'SWC-122': 'logic_errors',
  'SWC-123': 'logic_errors',
  'SWC-124': 'logic_errors',
  'SWC-125': 'logic_errors',
  'SWC-126': 'logic_errors',
  'SWC-127': 'front_running',
  'SWC-128': 'gas_optimization',
  'SWC-129': 'logic_errors',
  'SWC-130': 'logic_errors',
  'SWC-131': 'logic_errors',
  'SWC-132': 'logic_errors',
  'SWC-133': 'logic_errors',
  'SWC-134': 'logic_errors',
  'SWC-135': 'logic_errors',
  'SWC-136': 'logic_errors',
};

function mapSeverity(severity: string): Severity {
  const s = severity.toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'informational';
}

export async function runMythril(soliditySource: string): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'mythril' });
  const tmpDir = mkdtempSync(join(tmpdir(), 'verifier-mythril-'));
  const solFile = join(tmpDir, 'Target.sol');

  try {
    writeFileSync(solFile, soliditySource, 'utf-8');
    log.info('Running Mythril analysis...');

    const { stdout } = await execFileAsync(
      'myth',
      ['analyze', solFile, '-o', 'json', '--execution-timeout', '90'],
      { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
    );

    let results: any;
    try { results = JSON.parse(stdout); } catch {
      return { source: 'mythril', findings: [], rawOutput: stdout, error: 'Failed to parse output' };
    }

    const findings = parseMythrilResults(results);
    log.info({ findingCount: findings.length }, 'Mythril analysis complete');
    return { source: 'mythril', findings, rawOutput: stdout };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      log.warn('Mythril not installed — skipping');
      return { source: 'mythril', findings: [], error: 'Mythril not installed' };
    }
    if (err.stdout) {
      try {
        const results = JSON.parse(err.stdout);
        const findings = parseMythrilResults(results);
        log.info({ findingCount: findings.length }, 'Mythril analysis complete (with findings)');
        return { source: 'mythril', findings, rawOutput: err.stdout };
      } catch { /* fall through */ }
    }
    log.error({ err: err.message }, 'Mythril execution failed');
    return { source: 'mythril', findings: [], error: err.message };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function parseMythrilResults(results: any): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const issues = results?.issues || results?.result?.issues || [];

  for (const issue of issues) {
    const swcId = issue.swc_id || issue.swcID || '';
    const swcKey = swcId ? `SWC-${swcId}` : '';
    const vulnType = SWC_MAP[swcKey] || 'logic_errors';
    const severity = mapSeverity(issue.severity || 'Medium');

    const filename = issue.filename || issue.contract || 'Unknown';
    const lineno = issue.lineno || issue.sourceMap?.split(':')[0] || '';
    const location = lineno ? `${filename}:${lineno}` : filename;

    findings.push({
      severity,
      vulnerability_type: vulnType,
      location,
      description: issue.description?.head || issue.title || `${swcKey} detected`,
      proof_of_concept: issue.description?.tail || issue.debug || 'See Mythril output',
      recommendation: getRecommendation(vulnType),
    });
  }
  return findings;
}

function getRecommendation(vulnType: VulnerabilityType): string {
  const recs: Record<VulnerabilityType, string> = {
    reentrancy: 'Apply checks-effects-interactions pattern or use ReentrancyGuard',
    access_control: 'Add appropriate access control modifiers',
    integer_overflow: 'Ensure Solidity 0.8+ or use SafeMath',
    oracle_manipulation: 'Use TWAP or multiple oracle sources',
    front_running: 'Implement commit-reveal pattern',
    logic_errors: 'Review logic flow and add proper validation',
    gas_optimization: 'Optimize storage patterns',
    flash_loan: 'Add multi-block checks or delay mechanisms',
  };
  return recs[vulnType] || 'Review and fix the identified issue';
}

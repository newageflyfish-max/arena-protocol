/**
 * VerifierAgent — Comparison & Scoring Engine
 *
 * Compares the agent's submitted audit report against our independent
 * analysis. Produces a match score, identifies missed findings, and
 * makes an approve/reject decision.
 *
 * Scoring methodology:
 * 1. Match findings by vulnerability_type + normalized location
 * 2. Penalize for missed critical/high findings (configurable auto-reject)
 * 3. Weight severity in the match score calculation
 * 4. Factor in false positive rate (agent findings we didn't find)
 *
 * On-chain comparison mode uses basis points (0-10000) for score.
 */

import type {
  AgentConfig,
  AuditFinding,
  AuditReport,
  ComparisonResult,
  VoteDecision,
  VerificationDecision,
  Severity,
} from './types.js';
import { compareLog } from './logger.js';

// Severity weights for scoring
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 2,
  informational: 1,
};

/**
 * Compare agent's report against our independent findings.
 */
export function compareReports(
  agentReport: AuditReport,
  verifierFindings: AuditFinding[],
  config: AgentConfig
): VerificationDecision {
  const comparison = computeComparison(agentReport.findings, verifierFindings);

  compareLog.info(
    {
      agentFindings: comparison.agentFindingCount,
      verifierFindings: comparison.verifierFindingCount,
      matched: comparison.matchedFindings,
      missedByAgent: comparison.missedFindings.length,
      extraByAgent: comparison.extraFindings.length,
      matchScore: comparison.matchScore,
      missedCritical: comparison.missedCritical,
    },
    'Comparison complete'
  );

  // ─── Decision Logic ───

  // Auto-reject: agent missed critical findings we found
  if (config.autoRejectMissedCritical && comparison.missedCritical) {
    const criticalMissed = comparison.missedFindings.filter(
      (f) => f.severity === 'critical' || (config.autoRejectMissedHigh && f.severity === 'high')
    );

    if (criticalMissed.length > 0) {
      const severities = criticalMissed.map((f) => f.severity).join(', ');
      return {
        vote: 'reject',
        reason: `Agent missed ${criticalMissed.length} critical/high finding(s) [${severities}]: ${criticalMissed.map((f) => f.vulnerability_type).join(', ')}`,
        comparison,
      };
    }
  }

  // Score-based decision
  if (comparison.matchScore >= config.approvalThreshold) {
    return {
      vote: 'approve',
      reason: `Match score ${comparison.matchScore}% meets threshold ${config.approvalThreshold}%. ${comparison.assessment}`,
      comparison,
    };
  } else {
    return {
      vote: 'reject',
      reason: `Match score ${comparison.matchScore}% below threshold ${config.approvalThreshold}%. ${comparison.assessment}`,
      comparison,
    };
  }
}

/**
 * Compute detailed comparison between agent and verifier findings.
 */
function computeComparison(
  agentFindings: AuditFinding[],
  verifierFindings: AuditFinding[]
): ComparisonResult {
  // Normalize for matching
  const agentKeys = agentFindings.map((f) => ({
    finding: f,
    key: normalizeKey(f),
  }));
  const verifierKeys = verifierFindings.map((f) => ({
    finding: f,
    key: normalizeKey(f),
  }));

  // Find matches
  const matchedAgentIndices = new Set<number>();
  const matchedVerifierIndices = new Set<number>();

  for (let vi = 0; vi < verifierKeys.length; vi++) {
    for (let ai = 0; ai < agentKeys.length; ai++) {
      if (matchedAgentIndices.has(ai)) continue;

      if (keysMatch(verifierKeys[vi].key, agentKeys[ai].key)) {
        matchedVerifierIndices.add(vi);
        matchedAgentIndices.add(ai);
        break;
      }
    }
  }

  // Missed findings: verifier found but agent didn't
  const missedFindings = verifierKeys
    .filter((_, i) => !matchedVerifierIndices.has(i))
    .map((v) => v.finding);

  // Extra findings: agent reported but verifier didn't find
  const extraFindings = agentKeys
    .filter((_, i) => !matchedAgentIndices.has(i))
    .map((a) => a.finding);

  // Check if critical/high findings were missed
  const missedCritical = missedFindings.some(
    (f) => f.severity === 'critical' || f.severity === 'high'
  );

  // ─── Calculate match score ───

  let matchScore: number;

  if (verifierFindings.length === 0 && agentFindings.length === 0) {
    // Both found nothing — perfect agreement
    matchScore = 100;
  } else if (verifierFindings.length === 0) {
    // We found nothing, agent found things — could be false positives
    // Give moderate score (agent may have found things we missed)
    matchScore = 60;
  } else {
    // Weighted scoring based on severity
    let totalWeight = 0;
    let matchedWeight = 0;

    // Weight of findings we expect (verifier's findings are ground truth)
    for (let vi = 0; vi < verifierKeys.length; vi++) {
      const weight = SEVERITY_WEIGHT[verifierKeys[vi].finding.severity];
      totalWeight += weight;
      if (matchedVerifierIndices.has(vi)) {
        matchedWeight += weight;
      }
    }

    // Base score: how much of what we found did the agent also find?
    const coverageScore = totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 100;

    // Penalty for false positives (agent found things we didn't)
    // Mild penalty — agent may have found real issues we missed
    const falsePosRatio = agentFindings.length > 0
      ? extraFindings.length / agentFindings.length
      : 0;
    const falsPosPenalty = Math.min(falsePosRatio * 15, 15); // max 15% penalty

    matchScore = Math.max(0, Math.round(coverageScore - falsPosPenalty));
  }

  // Severity analysis
  const severityAnalysis = buildSeverityAnalysis(agentFindings, verifierFindings, matchedAgentIndices, matchedVerifierIndices);

  // Assessment
  const assessment = buildAssessment(matchScore, missedFindings, extraFindings, missedCritical);

  return {
    matchScore,
    matchScoreBps: Math.round(matchScore * 100),
    missedCritical,
    agentFindingCount: agentFindings.length,
    verifierFindingCount: verifierFindings.length,
    matchedFindings: matchedVerifierIndices.size,
    missedFindings,
    extraFindings,
    severityAnalysis,
    assessment,
  };
}

// ═══════════════════════════════════════════════════
// MATCHING HELPERS
// ═══════════════════════════════════════════════════

interface FindingKey {
  vulnType: string;
  location: string;
  severityGroup: string;
}

function normalizeKey(finding: AuditFinding): FindingKey {
  return {
    vulnType: finding.vulnerability_type,
    location: finding.location
      .toLowerCase()
      .replace(/\s*\(line\s*\d+(-\d+)?\)/g, '')
      .replace(/:\d+$/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    severityGroup: severityGroup(finding.severity),
  };
}

function severityGroup(s: Severity): string {
  if (s === 'critical' || s === 'high') return 'serious';
  if (s === 'medium') return 'moderate';
  return 'minor';
}

function keysMatch(a: FindingKey, b: FindingKey): boolean {
  // Exact vulnerability type match required
  if (a.vulnType !== b.vulnType) return false;

  // Location: fuzzy match — same function or contract name
  if (a.location === b.location) return true;

  // Check if one contains the other (e.g., "Vault.withdraw" matches "Vault.withdraw (line 42)")
  if (a.location.includes(b.location) || b.location.includes(a.location)) return true;

  // Same vulnerability type with similar location words
  const aWords = new Set(a.location.split(/[.\s/\\:]+/).filter(Boolean));
  const bWords = new Set(b.location.split(/[.\s/\\:]+/).filter(Boolean));
  const overlap = [...aWords].filter((w) => bWords.has(w)).length;
  const maxWords = Math.max(aWords.size, bWords.size);
  if (maxWords > 0 && overlap / maxWords >= 0.5) return true;

  return false;
}

// ═══════════════════════════════════════════════════
// REPORT BUILDERS
// ═══════════════════════════════════════════════════

function buildSeverityAnalysis(
  agentFindings: AuditFinding[],
  verifierFindings: AuditFinding[],
  matchedAgent: Set<number>,
  matchedVerifier: Set<number>
): string {
  const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];
  const lines: string[] = [];

  for (const sev of severities) {
    const agentCount = agentFindings.filter((f) => f.severity === sev).length;
    const verifierCount = verifierFindings.filter((f) => f.severity === sev).length;

    if (agentCount > 0 || verifierCount > 0) {
      lines.push(`${sev}: agent=${agentCount}, verifier=${verifierCount}`);
    }
  }

  return lines.length > 0 ? lines.join('; ') : 'No findings from either party';
}

function buildAssessment(
  score: number,
  missed: AuditFinding[],
  extra: AuditFinding[],
  missedCritical: boolean
): string {
  const parts: string[] = [];

  if (missedCritical) {
    const critCount = missed.filter((f) => f.severity === 'critical').length;
    const highCount = missed.filter((f) => f.severity === 'high').length;
    if (critCount > 0) parts.push(`${critCount} CRITICAL finding(s) missed by agent`);
    if (highCount > 0) parts.push(`${highCount} HIGH finding(s) missed by agent`);
  }

  if (missed.length > 0 && !missedCritical) {
    parts.push(`${missed.length} finding(s) missed by agent`);
  }

  if (extra.length > 0) {
    parts.push(`${extra.length} finding(s) reported by agent not found in independent analysis`);
  }

  if (parts.length === 0) {
    if (score >= 90) return 'Excellent agreement between agent and verifier analysis.';
    if (score >= 70) return 'Good agreement with minor differences.';
    return 'Moderate agreement — some discrepancies noted.';
  }

  return parts.join('. ') + '.';
}

/**
 * Build a verification report suitable for on-chain submission.
 */
export function buildVerificationReport(
  decision: VerificationDecision,
  verifierFindings: AuditFinding[],
  agentReport: AuditReport
): Record<string, unknown> {
  return {
    vote: decision.vote,
    reason: decision.reason,
    matchScore: decision.comparison.matchScore,
    matchScoreBps: decision.comparison.matchScoreBps,
    missedCritical: decision.comparison.missedCritical,
    agentFindingCount: decision.comparison.agentFindingCount,
    verifierFindingCount: decision.comparison.verifierFindingCount,
    matchedFindings: decision.comparison.matchedFindings,
    severityAnalysis: decision.comparison.severityAnalysis,
    assessment: decision.comparison.assessment,
    missedFindings: decision.comparison.missedFindings.map((f) => ({
      severity: f.severity,
      vulnerability_type: f.vulnerability_type,
      location: f.location,
      description: f.description,
    })),
    extraFindings: decision.comparison.extraFindings.map((f) => ({
      severity: f.severity,
      vulnerability_type: f.vulnerability_type,
      location: f.location,
    })),
    verifierFindingsSummary: verifierFindings.map((f) => ({
      severity: f.severity,
      vulnerability_type: f.vulnerability_type,
      location: f.location,
      description: f.description.slice(0, 200),
    })),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

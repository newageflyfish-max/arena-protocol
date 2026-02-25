/**
 * AuditAgent — AI Analyst (Claude)
 *
 * Uses the Anthropic Claude API to perform deep smart contract analysis.
 * Synthesizes findings from static analyzers, identifies additional issues,
 * deduplicates, and generates an executive summary.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AuditFinding, AuditReport, AnalyzerResult, VulnerabilityType, Severity } from '../types.js';
import { analyzerLog } from '../logger.js';

const VALID_SEVERITIES: Severity[] = ['informational', 'low', 'medium', 'high', 'critical'];
const VALID_VULN_TYPES: VulnerabilityType[] = [
  'reentrancy', 'access_control', 'oracle_manipulation', 'integer_overflow',
  'flash_loan', 'front_running', 'logic_errors', 'gas_optimization',
];

const SYSTEM_PROMPT = `You are an expert smart contract security auditor. Your job is to analyze Solidity smart contracts for vulnerabilities, security issues, and gas optimization opportunities.

You will receive:
1. The Solidity source code to audit
2. Results from Slither static analysis (if available)
3. Results from Mythril symbolic analysis (if available)

Your task:
1. Analyze the contract for vulnerabilities that automated tools may have missed
2. Validate and enrich findings from the static analyzers
3. Identify any additional security concerns
4. Produce a comprehensive audit report

IMPORTANT: Your response must be valid JSON with this exact structure:
{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "informational",
      "vulnerability_type": "reentrancy" | "access_control" | "oracle_manipulation" | "integer_overflow" | "flash_loan" | "front_running" | "logic_errors" | "gas_optimization",
      "location": "ContractName.functionName (line X)",
      "description": "Clear description of the vulnerability",
      "proof_of_concept": "Step-by-step attack vector or code demonstrating the issue",
      "recommendation": "Specific fix recommendation"
    }
  ],
  "summary": "Executive summary of the audit findings and overall security assessment"
}

Rules:
- severity MUST be one of: informational, low, medium, high, critical
- vulnerability_type MUST be one of: reentrancy, access_control, oracle_manipulation, integer_overflow, flash_loan, front_running, logic_errors, gas_optimization
- Do NOT duplicate findings from the static analyzers — instead, validate and enrich them
- Focus on real, exploitable vulnerabilities rather than theoretical issues
- Be specific about locations (contract name, function, line numbers if identifiable)
- Provide actionable recommendations
- The summary should be 2-4 sentences covering the overall security posture`;

export async function analyzeWithClaude(
  apiKey: string,
  soliditySource: string,
  slitherResult: AnalyzerResult,
  mythrilResult: AnalyzerResult
): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'claude' });

  const client = new Anthropic({ apiKey });

  // Build the analysis prompt
  const staticResults = formatStaticResults(slitherResult, mythrilResult);

  const userPrompt = `## Solidity Source Code

\`\`\`solidity
${soliditySource}
\`\`\`

## Static Analysis Results

${staticResults}

Please analyze this contract and provide your findings as JSON.`;

  log.info({ sourceLength: soliditySource.length }, 'Starting Claude analysis');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text from response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = extractJSON(text);
    if (!jsonStr) {
      log.warn({ text: text.slice(0, 500) }, 'Failed to extract JSON from Claude response');
      return { source: 'claude', findings: [], rawOutput: text, error: 'Failed to parse JSON response' };
    }

    const parsed = JSON.parse(jsonStr);
    const findings = validateAndCleanFindings(parsed.findings || []);

    log.info({ findingCount: findings.length }, 'Claude analysis complete');

    return {
      source: 'claude',
      findings,
      rawOutput: text,
    };
  } catch (err: any) {
    log.error({ err: err.message }, 'Claude analysis failed');
    return { source: 'claude', findings: [], error: err.message };
  }
}

/**
 * Merge and deduplicate findings from all analyzers.
 * Priority: Claude > Slither > Mythril for duplicates.
 */
export function mergeFindings(
  slitherResult: AnalyzerResult,
  mythrilResult: AnalyzerResult,
  claudeResult: AnalyzerResult
): AuditFinding[] {
  const allFindings: AuditFinding[] = [
    ...claudeResult.findings,
    ...slitherResult.findings,
    ...mythrilResult.findings,
  ];

  // Deduplicate by similarity (same vulnerability_type + similar location)
  const seen = new Set<string>();
  const deduped: AuditFinding[] = [];

  for (const finding of allFindings) {
    const key = `${finding.vulnerability_type}:${normalizeLocation(finding.location)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(finding);
    }
  }

  // Sort by severity (critical first)
  const severityOrder: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    informational: 4,
  };

  deduped.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return deduped;
}

/**
 * Generate an executive summary from the merged findings.
 */
export function generateSummary(findings: AuditFinding[], claudeResult: AnalyzerResult): string {
  // If Claude provided a summary, use it as the base
  if (claudeResult.rawOutput) {
    try {
      const parsed = JSON.parse(extractJSON(claudeResult.rawOutput) || '{}');
      if (parsed.summary) return parsed.summary;
    } catch {
      // Fall through to auto-generated summary
    }
  }

  // Auto-generate summary
  const counts: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, informational: 0,
  };
  for (const f of findings) counts[f.severity]++;

  const parts: string[] = [];
  if (counts.critical > 0) parts.push(`${counts.critical} critical`);
  if (counts.high > 0) parts.push(`${counts.high} high`);
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(`${counts.low} low`);
  if (counts.informational > 0) parts.push(`${counts.informational} informational`);

  if (findings.length === 0) {
    return 'No security vulnerabilities were identified in the audited contract. The contract follows standard security practices.';
  }

  const severityStr = parts.join(', ');
  const hasSerious = counts.critical > 0 || counts.high > 0;
  const assessment = hasSerious
    ? 'Immediate attention is recommended before deployment.'
    : 'No critical issues were found, but the identified issues should be addressed before production deployment.';

  return `Audit identified ${findings.length} finding(s): ${severityStr}. ${assessment}`;
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function formatStaticResults(slither: AnalyzerResult, mythril: AnalyzerResult): string {
  const parts: string[] = [];

  if (slither.findings.length > 0) {
    parts.push('### Slither Findings');
    for (const f of slither.findings) {
      parts.push(`- **[${f.severity.toUpperCase()}]** ${f.vulnerability_type}: ${f.description} (${f.location})`);
    }
  } else if (slither.error) {
    parts.push(`### Slither: ${slither.error}`);
  } else {
    parts.push('### Slither: No findings');
  }

  parts.push('');

  if (mythril.findings.length > 0) {
    parts.push('### Mythril Findings');
    for (const f of mythril.findings) {
      parts.push(`- **[${f.severity.toUpperCase()}]** ${f.vulnerability_type}: ${f.description} (${f.location})`);
    }
  } else if (mythril.error) {
    parts.push(`### Mythril: ${mythril.error}`);
  } else {
    parts.push('### Mythril: No findings');
  }

  return parts.join('\n');
}

function extractJSON(text: string): string | null {
  // Try parsing the whole text first
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Try to extract from markdown code block
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        JSON.parse(codeBlockMatch[1]);
        return codeBlockMatch[1];
      } catch {
        // Fall through
      }
    }

    // Try to find a JSON object in the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]);
        return jsonMatch[0];
      } catch {
        // Fall through
      }
    }
  }

  return null;
}

function validateAndCleanFindings(findings: any[]): AuditFinding[] {
  if (!Array.isArray(findings)) return [];

  return findings
    .filter((f) => f && typeof f === 'object')
    .map((f): AuditFinding => ({
      severity: VALID_SEVERITIES.includes(f.severity) ? f.severity : 'informational',
      vulnerability_type: VALID_VULN_TYPES.includes(f.vulnerability_type) ? f.vulnerability_type : 'logic_errors',
      location: String(f.location || 'Unknown'),
      description: String(f.description || 'No description'),
      proof_of_concept: String(f.proof_of_concept || 'N/A'),
      recommendation: String(f.recommendation || 'Review and fix'),
    }));
}

function normalizeLocation(location: string): string {
  // Normalize location for dedup (strip line numbers, lowercase)
  return location
    .toLowerCase()
    .replace(/\s*\(line\s*\d+(-\d+)?\)/g, '')
    .replace(/:\d+$/, '')
    .trim();
}

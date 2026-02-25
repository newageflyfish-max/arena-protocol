/**
 * VerifierAgent — AI Analyst (Claude)
 *
 * Uses Claude to independently analyze the contract AND to compare
 * our findings against the agent's submitted report.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AuditFinding, AuditReport, AnalyzerResult, VulnerabilityType, Severity } from '../types.js';
import { analyzerLog } from '../logger.js';

const VALID_SEVERITIES: Severity[] = ['informational', 'low', 'medium', 'high', 'critical'];
const VALID_VULN_TYPES: VulnerabilityType[] = [
  'reentrancy', 'access_control', 'oracle_manipulation', 'integer_overflow',
  'flash_loan', 'front_running', 'logic_errors', 'gas_optimization',
];

const ANALYSIS_PROMPT = `You are an expert smart contract security auditor performing INDEPENDENT verification. Your job is to analyze this Solidity contract for vulnerabilities, completely independently from any previous audit.

You will receive:
1. The Solidity source code
2. Results from Slither static analysis (if available)
3. Results from Mythril symbolic analysis (if available)

Produce a thorough audit. Your response MUST be valid JSON:
{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "informational",
      "vulnerability_type": "reentrancy" | "access_control" | "oracle_manipulation" | "integer_overflow" | "flash_loan" | "front_running" | "logic_errors" | "gas_optimization",
      "location": "ContractName.functionName (line X)",
      "description": "Clear description",
      "proof_of_concept": "Attack steps or code",
      "recommendation": "Specific fix"
    }
  ],
  "summary": "Executive summary"
}

Focus on REAL, exploitable vulnerabilities. Be thorough — missed critical findings undermine verification quality.`;

export async function analyzeWithClaude(
  apiKey: string,
  soliditySource: string,
  slitherResult: AnalyzerResult,
  mythrilResult: AnalyzerResult
): Promise<AnalyzerResult> {
  const log = analyzerLog.child({ analyzer: 'claude' });
  const client = new Anthropic({ apiKey });

  const staticResults = formatStaticResults(slitherResult, mythrilResult);
  const userPrompt = `## Solidity Source Code\n\n\`\`\`solidity\n${soliditySource}\n\`\`\`\n\n## Static Analysis Results\n\n${staticResults}\n\nAnalyze independently and provide findings as JSON.`;

  log.info({ sourceLength: soliditySource.length }, 'Starting Claude analysis');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: ANALYSIS_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const jsonStr = extractJSON(text);
    if (!jsonStr) {
      log.warn('Failed to extract JSON from Claude response');
      return { source: 'claude', findings: [], rawOutput: text, error: 'Failed to parse' };
    }

    const parsed = JSON.parse(jsonStr);
    const findings = cleanFindings(parsed.findings || []);
    log.info({ findingCount: findings.length }, 'Claude analysis complete');
    return { source: 'claude', findings, rawOutput: text };
  } catch (err: any) {
    log.error({ err: err.message }, 'Claude analysis failed');
    return { source: 'claude', findings: [], error: err.message };
  }
}

/**
 * Merge and deduplicate findings from all analyzers.
 */
export function mergeFindings(
  slither: AnalyzerResult,
  mythril: AnalyzerResult,
  claude: AnalyzerResult
): AuditFinding[] {
  const all = [...claude.findings, ...slither.findings, ...mythril.findings];
  const seen = new Set<string>();
  const deduped: AuditFinding[] = [];

  for (const f of all) {
    const key = `${f.vulnerability_type}:${f.location.toLowerCase().replace(/\s*\(line\s*\d+(-\d+)?\)/g, '').trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  deduped.sort((a, b) => order[a.severity] - order[b.severity]);
  return deduped;
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
  } else {
    parts.push(`### Slither: ${slither.error || 'No findings'}`);
  }
  parts.push('');
  if (mythril.findings.length > 0) {
    parts.push('### Mythril Findings');
    for (const f of mythril.findings) {
      parts.push(`- **[${f.severity.toUpperCase()}]** ${f.vulnerability_type}: ${f.description} (${f.location})`);
    }
  } else {
    parts.push(`### Mythril: ${mythril.error || 'No findings'}`);
  }
  return parts.join('\n');
}

function extractJSON(text: string): string | null {
  try { JSON.parse(text); return text; } catch { /* continue */ }
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlock) {
    try { JSON.parse(codeBlock[1]); return codeBlock[1]; } catch { /* continue */ }
  }
  const jsonObj = text.match(/\{[\s\S]*\}/);
  if (jsonObj) {
    try { JSON.parse(jsonObj[0]); return jsonObj[0]; } catch { /* continue */ }
  }
  return null;
}

function cleanFindings(findings: any[]): AuditFinding[] {
  if (!Array.isArray(findings)) return [];
  return findings.filter((f) => f && typeof f === 'object').map((f): AuditFinding => ({
    severity: VALID_SEVERITIES.includes(f.severity) ? f.severity : 'informational',
    vulnerability_type: VALID_VULN_TYPES.includes(f.vulnerability_type) ? f.vulnerability_type : 'logic_errors',
    location: String(f.location || 'Unknown'),
    description: String(f.description || 'No description'),
    proof_of_concept: String(f.proof_of_concept || 'N/A'),
    recommendation: String(f.recommendation || 'Review and fix'),
  }));
}

import { readFile } from 'node:fs/promises';

export const APPROVED = 'APPROVED';
export const CHANGES_REQUESTED = 'CHANGES_REQUESTED';

/**
 * Pull the JSON object out of whatever the reviewer wrote.
 *
 * Agents fence JSON in markdown often enough that rejecting it would be
 * pedantic, so tolerate the fence — but tolerate nothing about the contents.
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Verdict file is not valid JSON: ${error.message}`);
  }
}

/**
 * Validate a verdict.
 *
 * This fails closed on purpose. A missing, malformed, or unrecognized verdict
 * stalls the run rather than defaulting to either outcome: defaulting to
 * approval ships unreviewed code, and defaulting to changes burns rounds
 * against a reviewer that is not actually reporting.
 */
export function parseVerdict(text) {
  const data = extractJson(text);
  const verdict = String(data.verdict ?? '').toUpperCase();
  if (![APPROVED, CHANGES_REQUESTED].includes(verdict)) {
    throw new Error(`Verdict must be ${APPROVED} or ${CHANGES_REQUESTED}, got ${JSON.stringify(data.verdict)}.`);
  }
  const blocking = Array.isArray(data.blocking) ? data.blocking : [];
  if (verdict === CHANGES_REQUESTED && blocking.length === 0) {
    throw new Error(`Verdict is ${CHANGES_REQUESTED} but lists no blocking findings.`);
  }
  return {
    verdict,
    blocking,
    nits: Array.isArray(data.nits) ? data.nits : [],
    summary: typeof data.summary === 'string' ? data.summary : '',
  };
}

export async function readVerdict(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`The review phase did not write a verdict to ${path}.`);
    }
    throw error;
  }
  return parseVerdict(text);
}

export function formatFindings(findings) {
  if (!findings.length) return '(none)';
  return findings
    .map((finding, index) => {
      const where = [finding.file, finding.line].filter(Boolean).join(':');
      return `${index + 1}. ${where ? `${where} — ` : ''}${finding.issue ?? finding.summary ?? ''}`;
    })
    .join('\n');
}

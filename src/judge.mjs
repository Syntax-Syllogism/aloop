import { readFile } from 'node:fs/promises';
import { runCommand } from './command.mjs';

export const MAX_BLOCKERS = 40;
export const MAX_ISSUE_LENGTH = 1_000;
export const JUDGE_CONTEXT =
  "An automated code reviewer reviewed a change, a developer agent tried to address the blocking findings, and the reviewer reviewed again. Decide whether each new finding is the same underlying issue as one of the previous round's findings.";
export const JUDGE_INSTRUCTIONS =
  'Which previous finding does `current_findings.{id}` repeat? A repeat is the same underlying problem, even if reworded, at a different line, or after an attempted fix the reviewer still rejects. A different problem in the same file is not a repeat.';

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function issueText(finding) {
  return String(finding.issue ?? finding.summary ?? '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .slice(0, MAX_ISSUE_LENGTH);
}

export function renderFinding(finding) {
  const where = [finding.file, finding.line]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(':');
  return `${where ? `${where} — ` : ''}${issueText(finding)}`.slice(0, MAX_ISSUE_LENGTH);
}

export function buildSystemOneRequest(previous, current) {
  const previousFindings = Object.fromEntries(previous.map((finding, index) => [`p${index}`, renderFinding(finding)]));
  const currentFindings = Object.fromEntries(current.map((finding, index) => [`c${index}`, renderFinding(finding)]));
  const questions = Object.fromEntries(
    current.map((_, index) => {
      const id = `c${index}`;
      return [
        id,
        {
          type: 'choice',
          instructions: JUDGE_INSTRUCTIONS.replace('{id}', id),
          criteria: { ...previousFindings, new: 'Not the same issue as any previous finding' },
        },
      ];
    }),
  );
  return {
    state: { context: JUDGE_CONTEXT, previous_findings: previousFindings, current_findings: currentFindings },
    questions,
  };
}

function probabilityFor(answer, choice) {
  const value = answer.x_p_max ?? answer.probabilities?.[choice];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Judge answer for ${choice} has an invalid probability.`);
  }
  return value;
}

export function parseSystemOneResponse(response, request, minProbability) {
  const answers = asObject(asObject(response, 'Judge response').answers, 'Judge response.answers');
  const matches = [];
  const unmatched = [];
  for (const [current, question] of Object.entries(request.questions)) {
    const answer = asObject(answers[current], `Judge response.answers.${current}`);
    if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) {
      throw new Error(`Judge answer for ${current} has an invalid choice.`);
    }
    const probability = probabilityFor(answer, answer.choice);
    if (answer.choice !== 'new' && probability >= minProbability) {
      matches.push({ current, previous: answer.choice, probability });
    } else {
      unmatched.push(current);
    }
  }
  for (const key of Object.keys(answers)) {
    if (!Object.hasOwn(request.questions, key)) throw new Error(`Judge response has an unknown answer key ${key}.`);
  }
  return { repeated: Object.keys(request.questions).length > 0 && unmatched.length === 0, matches, unmatched };
}

function stderrTail(error) {
  return String(error.stderr ?? error.output ?? error.message).slice(-500);
}

async function commandJson(command, request, timeoutMs) {
  try {
    const result = await runCommand(command[0], command.slice(1), { input: JSON.stringify(request), timeoutMs });
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Judge command returned invalid JSON: ${error.message}`);
    }
  } catch (error) {
    if (error.message?.startsWith('Judge command returned')) throw error;
    throw new Error(`Judge command failed: ${stderrTail(error)}`);
  }
}

async function httpJson(entry, request, timeoutMs) {
  const headers = { 'content-type': 'application/json' };
  if (entry.apiKeyEnv) {
    const key = process.env[entry.apiKeyEnv];
    if (!key) throw new Error(`Judge API key environment variable ${entry.apiKeyEnv} is not set.`);
    headers.authorization = `Bearer ${key}`;
  }
  let response;
  try {
    response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Judge HTTP request failed: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`Judge HTTP request failed: ${response.status} ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Judge HTTP response was invalid JSON: ${error.message}`);
  }
}

async function functionJson(judge, request, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => judge(request)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Judge function timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseGenericResponse(response, currentLength, previousLength) {
  const matches = asObject(response, 'Judge response').matches;
  if (!Array.isArray(matches)) throw new Error('Judge response.matches must be an array.');
  const seen = new Set();
  for (const match of matches) {
    asObject(match, 'Judge response match');
    if (!Number.isInteger(match.current) || match.current < 0 || match.current >= currentLength)
      throw new Error('Judge response has an invalid current id.');
    if (!Number.isInteger(match.previous) || match.previous < 0 || match.previous >= previousLength)
      throw new Error('Judge response has an invalid previous id.');
    if (seen.has(match.current)) throw new Error('Judge response has duplicate current ids.');
    seen.add(match.current);
  }
  const unmatched = Array.from({ length: currentLength }, (_, index) => index).filter((index) => !seen.has(index));
  return { repeated: currentLength > 0 && unmatched.length === 0, matches, unmatched };
}

/** Run a resolved judge entry and return its pure decision. */
export async function judgeBlockers(entry, { phase, round, previous, current, response = null }) {
  const started = performance.now();
  if (previous.length > MAX_BLOCKERS || current.length > MAX_BLOCKERS) return { skipped: 'too many blockers' };
  const kind = entry.kind;
  let decision;
  if (kind === 'systemone') {
    const request = buildSystemOneRequest(previous, current);
    const result = entry.baseUrl
      ? await httpJson(entry, request, entry.timeoutMs)
      : await commandJson(entry.command, request, entry.timeoutMs);
    decision = parseSystemOneResponse(result, request, entry.minProbability);
  } else {
    const request = {
      version: 1,
      phase,
      round,
      previous: previous.map((finding, id) => ({ id, ...finding })),
      current: current.map((finding, id) => ({ id, ...finding })),
      response: response?.slice(0, 4_000) ?? null,
    };
    const result =
      typeof entry.judge === 'function'
        ? await functionJson(entry.judge, request, entry.timeoutMs)
        : await commandJson(entry.command, request, entry.timeoutMs);
    decision = parseGenericResponse(result, current.length, previous.length);
  }
  return {
    ...decision,
    durationMs: Math.round(performance.now() - started),
    judge: {
      name: entry.name ?? null,
      kind,
      transport: entry.baseUrl ? 'http' : typeof entry.judge === 'function' ? 'function' : 'command',
    },
  };
}

export async function readResponse(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Classify a `judge` or `review-override` manifest entry. Repeated decisions
 * only count as stalls once the runner marks the entry stalled.
 */
export function judgeOutcome(entry) {
  if (entry.role === 'review-override') return 'review-override';
  if (entry.failure) return 'failed-closed';
  if (entry.decision?.skipped) return 'skipped';
  return entry.decision?.repeated ? 'repeated' : 'not-repeated';
}

/** One-line summary of a judge decision or review override, shared by run logs and `aloop watch`. */
export function describeJudgeEntry(entry) {
  const round = entry.round === undefined || entry.round === null ? '' : ` (round ${entry.round})`;
  const outcome = judgeOutcome(entry);
  if (outcome === 'review-override') {
    const count = entry.findings?.length ?? 0;
    return `review-override${round}: continuing with ${count} unresolved finding${count === 1 ? '' : 's'} (${entry.reason})`;
  }
  if (outcome === 'failed-closed') return `judge${round}: failed closed (${entry.failure.reason}) → stall`;
  if (outcome === 'skipped') return `judge${round}: skipped (${entry.decision.skipped})`;
  const matches = entry.decision?.matches ?? [];
  const blockers = matches.length + (entry.decision?.unmatched?.length ?? 0);
  const probabilities = matches.map((match) => match.probability).filter((value) => typeof value === 'number');
  const minimum = probabilities.length ? `, min p ${Math.min(...probabilities)}` : '';
  // Entries written before `action` existed: only a repeated decision stalls. A not-repeated
  // entry can also be marked stalled when the round cap ends the loop on it.
  const action = entry.action ?? (outcome === 'repeated' && entry.status === 'stalled' ? 'stall' : null);
  return `judge${round}: ${outcome === 'repeated' ? 'repeated' : 'not repeated'} (${matches.length}/${blockers} blockers matched${minimum})${action ? ` → ${action}` : ''}`;
}

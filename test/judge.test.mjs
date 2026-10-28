import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  JUDGE_CONTEXT,
  JUDGE_INSTRUCTIONS,
  buildSystemOneRequest,
  describeJudgeEntry,
  judgeBlockers,
  parseSystemOneResponse,
  renderFinding,
} from '../src/judge.mjs';

const previous = [{ file: 'src/a.mjs', line: 12, issue: '[review-security] missing authorization' }];
const current = [{ file: 'src/a.mjs', line: 20, issue: 'authorization is still absent' }];

test('judge builds stable System One questions and strips review prefixes', () => {
  const request = buildSystemOneRequest(previous, current);
  assert.equal(request.state.context, JUDGE_CONTEXT);
  assert.equal(request.questions.c0.instructions, JUDGE_INSTRUCTIONS.replace('{id}', 'c0'));
  assert.equal(request.state.previous_findings.p0, 'src/a.mjs:12 — missing authorization');
  assert.equal(request.questions.c0.criteria.new, 'Not the same issue as any previous finding');
  assert.equal(renderFinding({ issue: 'x'.repeat(1_200) }).length, 1_000);
});

test('judge validates System One answers and uses probabilities fallback', () => {
  const request = buildSystemOneRequest(previous, current);
  const decision = parseSystemOneResponse(
    { answers: { c0: { choice: 'p0', probabilities: { p0: 0.8 } } } },
    request,
    0.7,
  );
  assert.equal(decision.repeated, true);
  assert.throws(() => parseSystemOneResponse({ answers: {} }, request, 0.7), /must be an object/);
  assert.throws(
    () => parseSystemOneResponse({ answers: { c0: { choice: 'bad', x_p_max: 0.8 } } }, request, 0.7),
    /invalid choice/,
  );
  assert.throws(
    () => parseSystemOneResponse({ answers: { c0: { choice: 'p0', x_p_max: 2 } } }, request, 0.7),
    /invalid probability/,
  );
});

test('systemone HTTP judge sends its JSON request and accepts a matching answer', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {any} */
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify({ answers: { c0: { choice: 'p0', x_p_max: 0.9 } } }), { status: 200 });
  };
  process.env.JUDGE_TEST_KEY = 'secret';
  try {
    const decision = await judgeBlockers(
      {
        name: 'test',
        kind: 'systemone',
        baseUrl: 'http://127.0.0.1:8000',
        apiKeyEnv: 'JUDGE_TEST_KEY',
        timeoutMs: 1_000,
        minProbability: 0.7,
      },
      { phase: 'review', round: 2, previous, current },
    );
    assert.ok('repeated' in decision && decision.repeated);
    assert.equal(request.headers.authorization, 'Bearer secret');
    assert.match(request.body, /previous_findings/);
  } finally {
    delete process.env.JUDGE_TEST_KEY;
    globalThis.fetch = originalFetch;
  }
});

test('generic function judge rejects duplicate current ids', async () => {
  await assert.rejects(
    judgeBlockers(
      {
        kind: 'command',
        judge: async () => ({
          matches: [
            { current: 0, previous: 0 },
            { current: 0, previous: 0 },
          ],
        }),
        timeoutMs: 1_000,
      },
      { phase: 'review', round: 2, previous, current },
    ),
    /duplicate/,
  );
});

test('function judges time out rather than hanging the runner', async () => {
  await assert.rejects(
    judgeBlockers(
      { kind: 'command', judge: () => new Promise(() => {}), timeoutMs: 10 },
      { phase: 'review', round: 2, previous, current },
    ),
    /Judge function timed out after 10ms/,
  );
});

test('Laya System One shim uses the direct SDK and preserves the System One envelope', async () => {
  const shim = await readFile(new URL('../examples/judges/laya-systemone.py', import.meta.url), 'utf8');
  assert.match(shim, /import laya/);
  assert.match(shim, /default='convaiinnovations\/laya-typed-decisions'/);
  assert.match(shim, /laya\.load\(args\.repo\)/);
  assert.match(shim, /model\.predict\(request\['state'\], request\['questions'\]\)/);
  assert.match(shim, /json\.dump\(.+, sys\.stdout\)/);
});

test('judge decisions and review overrides render as one log line each', () => {
  const judge = (details) => describeJudgeEntry({ role: 'judge', round: 3, status: 'completed', ...details });
  assert.equal(
    judge({
      action: 'stall',
      decision: {
        repeated: true,
        matches: [
          { current: 0, previous: 0, probability: 0.9 },
          { current: 1, previous: 0, probability: 0.82 },
        ],
        unmatched: [],
      },
    }),
    'judge (round 3): repeated (2/2 blockers matched, min p 0.82) → stall',
  );
  assert.equal(
    judge({
      action: 'keep going',
      decision: { repeated: false, matches: [{ current: 0, previous: 0 }], unmatched: [1, 2] },
    }),
    'judge (round 3): not repeated (1/3 blockers matched) → keep going',
  );
  assert.equal(judge({ decision: { skipped: 'too many blockers' } }), 'judge (round 3): skipped (too many blockers)');
  assert.equal(
    judge({ status: 'stalled', failure: { reason: 'timeout' } }),
    'judge (round 3): failed closed (timeout) → stall',
  );
  // Entries written before `action` existed still read as a stall once marked.
  assert.equal(
    judge({ status: 'stalled', decision: { repeated: true, matches: [{ current: 0, previous: 0 }], unmatched: [] } }),
    'judge (round 3): repeated (1/1 blockers matched) → stall',
  );
  // A not-repeated entry marked stalled by the round cap doesn't claim the judge stalled.
  assert.equal(
    judge({ status: 'stalled', decision: { repeated: false, matches: [], unmatched: [0] } }),
    'judge (round 3): not repeated (0/1 blockers matched)',
  );
  assert.equal(
    describeJudgeEntry({ role: 'review-override', round: 3, reason: 'repeated-blockers', findings: [{}, {}] }),
    'review-override (round 3): continuing with 2 unresolved findings (repeated-blockers)',
  );
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { computeAggregateMetrics, computeRunMetrics } from '../src/metrics.mjs';
import { publishingAttestation } from '../src/policy.mjs';
import { runLoop } from '../src/pipeline.mjs';
import { RunState } from '../src/state.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd })).stdout.trim();
}

async function judgeFixture({
  judge = 'repeat',
  onRepeat = 'stall',
  maxRounds = 2,
  timeoutMs = 1_000,
  laterBlockers = null,
  nextPhase = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'loop-judge-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'config', 'user.email', 'loop@example.com');
  await git(root, 'config', 'user.name', 'Loop Test');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, '.gitignore'), '.loop/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'chore: init');
  const taskFile = join(root, 'task.md');
  await writeFile(taskFile, '# Task\n');
  await git(root, 'add', 'task.md');
  await git(root, 'commit', '-m', 'chore: add task');
  const bin = await mkdtemp(join(tmpdir(), 'loop-judge-bin-'));
  const judgePath = join(bin, 'judge.mjs');
  await writeFile(
    judgePath,
    judge === 'failure'
      ? "process.stderr.write('unavailable'); process.exit(1);\n"
      : `import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const matches = ${JSON.stringify(judge)} === 'partial'
  ? [{ current: 0, previous: 0 }]
  : request.current.map((_, current) => ({ current, previous: 0 }));
process.stdout.write(JSON.stringify({ matches }));
`,
  );
  await writeFile(
    join(bin, 'claude'),
    `#!/bin/sh
prompt="$2"
case "$prompt" in
  *"Machine-readable verdict"*)
    verdict_path=$(printf '%s\\n' "$prompt" | sed -n 's/^.*write this JSON to \`\\([^\`]*\\)\`.*/\\1/p')
    case "$prompt" in
      *"round 1 of"*) printf '%s' '{"verdict":"CHANGES_REQUESTED","blocking":[{"file":"src/a.mjs","line":1,"issue":"missing authorization"}]}' > "$verdict_path" ;;
      *) printf '%s' '${JSON.stringify({
        verdict: 'CHANGES_REQUESTED',
        blocking: laterBlockers ?? [
          { file: 'src/a.mjs', line: 2, issue: 'authorization remains missing' },
          ...(judge === 'partial' ? [{ file: 'src/b.mjs', line: 1, issue: 'new validation issue' }] : []),
        ],
      })}' > "$verdict_path" ;;
    esac
    ;;
  *)
    response_path=$(printf '%s\\n' "$prompt" | sed -n 's/^.*Write any rebuttal to \`\\([^\`]*\\)\`.*/\\1/p')
    printf 'The finding is disputed.\\n' > "$response_path"
    ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, 'loop.config.mjs'),
    `export default {
  worktrees: false,
  gate: ['true'],
  phases: ['gate', 'review', 'address'${nextPhase ? ", { name: 'finish', kind: 'gate', commands: ['true'] }" : ''}],
  maxRounds: ${maxRounds},
  judge: {
    kind: 'command',
    judge: ${
      judge === 'failure'
        ? "async () => { throw new Error('unavailable'); }"
        : judge === 'timeout'
          ? '() => new Promise(() => {})'
          : `async (request) => ({ matches: ${JSON.stringify(judge)} === 'partial'
      ? [{ current: 0, previous: 0 }]
      : request.current.map((_, current) => ({ current, previous: 0 })) })`
    },
    onRepeat: ${JSON.stringify(onRepeat)},
    timeoutMs: ${timeoutMs},
  },
};\n`,
  );
  await git(root, 'add', 'loop.config.mjs');
  await git(root, 'commit', '-m', 'chore: configure loop');
  return { root, taskFile, bin };
}

async function withFixturePath(bin, operation, lines = []) {
  const previousPath = process.env.PATH;
  const previousLog = console.log;
  const previousExitCode = process.exitCode;
  process.env.PATH = `${bin}:${previousPath}`;
  console.log = (message) => lines.push(String(message));
  try {
    return await operation();
  } finally {
    console.log = previousLog;
    process.env.PATH = previousPath;
    process.exitCode = previousExitCode;
  }
}

test('runner stalls repeated blockers before the final-round cap and records matched pairs', async () => {
  const { root, taskFile, bin } = await judgeFixture();
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.equal(summary.stalled.reason, 'repeated blockers');
  assert.match(summary.stalled.output, /authorization remains missing.*missing authorization/s);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const entry = manifest.phases.find((phase) => phase.role === 'judge');
  assert.equal(entry.decision.repeated, true);
  assert.match(entry.matchSummary, /authorization/);
});

test('runner records partial repeats and continues to the ordinary round cap', async () => {
  const { root, taskFile, bin } = await judgeFixture({ judge: 'partial' });
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.equal(summary.stalled.reason, 'round cap reached');
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const entry = manifest.phases.find((phase) => phase.role === 'judge');
  assert.equal(entry.decision.repeated, false);
  assert.deepEqual(entry.decision.unmatched, [1]);
});

test('runner records and logs a skipped judgement when a round has too many blockers', async () => {
  const laterBlockers = Array.from({ length: 41 }, (_, line) => ({
    file: 'src/a.mjs',
    line: line + 1,
    issue: 'missing check',
  }));
  const { root, taskFile, bin } = await judgeFixture({ laterBlockers });
  const lines = [];
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }), lines);
  assert.equal(summary.stalled.reason, 'round cap reached');
  assert.ok(lines.includes('  judge (round 2): skipped (too many blockers)'));
  const manifest = await manifestFor(summary);
  const entry = manifest.phases.find((phase) => phase.role === 'judge');
  assert.deepEqual(entry.decision, { skipped: 'too many blockers' });
  assert.equal(entry.round, 2);
  assert.deepEqual(computeRunMetrics(manifest).judge, {
    decisions: 1,
    repeatedBlockerStalls: 0,
    failedClosedStalls: 0,
    reviewOverrides: 0,
  });
});

test('runner fails closed when a function judge times out', async () => {
  const { root, taskFile, bin } = await judgeFixture({ judge: 'timeout', timeoutMs: 10 });
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.match(summary.stalled.reason, /judge failed: Judge function timed out after 10ms/);
  assert.match(summary.stalled.reason, /--no-judge/);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.phases.find((phase) => phase.role === 'judge').status, 'stalled');
});

test('runner resumes with a cached same-SHA judgement without invoking a broken judge', async () => {
  const { root, taskFile, bin } = await judgeFixture({ maxRounds: 1 });
  const initial = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.equal(initial.stalled.reason, 'round cap reached');
  const state = await RunState.open(join(root, '.loop/runs'), 'task', {}, { resume: true, lock: false });
  const sha = await git(root, 'rev-parse', 'HEAD');
  await state.record({
    judgements: {
      review: {
        2: {
          reviewedSha: sha,
          repeated: true,
          matches: [{ current: 0, previous: 0 }],
          unmatched: [],
          judge: { name: null, kind: 'command', transport: 'command' },
        },
      },
    },
  });
  await writeFile(join(bin, 'judge.mjs'), "process.stderr.write('should not run'); process.exit(1);\n");
  const resumed = await withFixturePath(bin, () =>
    runLoop({
      args: { taskFile, cwd: root, resume: true, maxRounds: 2, yes: true },
    }),
  );
  assert.equal(resumed.stalled.reason, 'repeated blockers');
});

test('continue override completes the review and is publish-attestable after its gate', async () => {
  const { root, taskFile, bin } = await judgeFixture({ onRepeat: 'continue' });
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.equal(summary.stalled, null);
  const state = await RunState.open(join(root, '.loop/runs'), 'task', {}, { resume: true, lock: false });
  const sha = await git(root, 'rev-parse', 'HEAD');
  assert.equal(publishingAttestation(state, sha).overridden, true);
  assert.deepEqual(
    state.data.unresolvedFindings.map((finding) => finding.issue),
    ['authorization remains missing'],
  );
});

async function manifestFor(summary) {
  return JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
}

test('runner logs each judge decision and counts judge stalls in metrics', async () => {
  const repeated = await judgeFixture();
  const repeatedLines = [];
  const repeatedSummary = await withFixturePath(
    repeated.bin,
    () =>
      runLoop({
        args: { taskFile: repeated.taskFile, cwd: repeated.root, yes: true },
      }),
    repeatedLines,
  );
  assert.ok(repeatedLines.includes('  judge (round 2): repeated (1/1 blockers matched) → stall'));

  const partial = await judgeFixture({ judge: 'partial' });
  const partialLines = [];
  const partialSummary = await withFixturePath(
    partial.bin,
    () =>
      runLoop({
        args: { taskFile: partial.taskFile, cwd: partial.root, yes: true },
      }),
    partialLines,
  );
  assert.ok(partialLines.includes('  judge (round 2): not repeated (1/2 blockers matched) → keep going'));

  const failed = await judgeFixture({ judge: 'timeout', timeoutMs: 10 });
  const failedLines = [];
  const failedSummary = await withFixturePath(
    failed.bin,
    () =>
      runLoop({
        args: { taskFile: failed.taskFile, cwd: failed.root, yes: true },
      }),
    failedLines,
  );
  assert.ok(failedLines.includes('  judge (round 2): failed closed (Judge function timed out after 10ms.) → stall'));

  const manifests = await Promise.all([repeatedSummary, partialSummary, failedSummary].map(manifestFor));
  assert.deepEqual(computeRunMetrics(manifests[0]).judge, {
    decisions: 1,
    repeatedBlockerStalls: 1,
    failedClosedStalls: 0,
    reviewOverrides: 0,
  });
  // A partial repeat that later hits the round cap is not a judge stall.
  assert.deepEqual(computeRunMetrics(manifests[1]).judge, {
    decisions: 1,
    repeatedBlockerStalls: 0,
    failedClosedStalls: 0,
    reviewOverrides: 0,
  });
  assert.deepEqual(computeAggregateMetrics(manifests).judge, {
    decisions: 3,
    repeatedBlockerStalls: 1,
    failedClosedStalls: 1,
    reviewOverrides: 0,
  });
});

test('runner logs a review override and metrics count it separately from stalls', async () => {
  const { root, taskFile, bin } = await judgeFixture({ onRepeat: 'continue' });
  const lines = [];
  const summary = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }), lines);
  assert.ok(lines.includes('  judge (round 2): repeated (1/1 blockers matched) → continue'));
  assert.ok(lines.includes('  review-override (round 2): continuing with 1 unresolved finding (repeated-blockers)'));
  assert.deepEqual(computeRunMetrics(await manifestFor(summary)).judge, {
    decisions: 1,
    repeatedBlockerStalls: 0,
    failedClosedStalls: 0,
    reviewOverrides: 1,
  });
});

test('quiet mode prints judge decisions while dropping raw output', async () => {
  const { root, taskFile, bin } = await judgeFixture();
  const written = [];
  const previousWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? (rest.at(-1)() ?? true) : true;
  };
  try {
    await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true, quiet: true } }));
  } finally {
    process.stdout.write = previousWrite;
  }
  assert.ok(written.includes('  judge (round 2): repeated (1/1 blockers matched) → stall\n'));
});

test('resume continues cached repeated blockers at the same round without repairs', async () => {
  const { root, taskFile, bin } = await judgeFixture({ nextPhase: true });
  const initial = await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  assert.equal(initial.stalled.reason, 'repeated blockers');
  const before = await manifestFor(initial);
  const lines = [];
  const resumed = await withFixturePath(
    bin,
    () =>
      runLoop({
        args: { taskFile, cwd: root, resume: true, onRepeat: 'continue', yes: true },
      }),
    lines,
  );
  assert.equal(resumed.stalled, null);
  const manifest = await manifestFor(resumed);
  const added = manifest.phases.slice(before.phases.length);
  assert.ok(!added.some((entry) => entry.phase === 'address' || entry.role === 'verdict' || entry.round === 3));
  assert.equal(added.find((entry) => entry.role === 'review-override').round, 2);
  assert.equal(added.find((entry) => entry.role === 'judge').action, 'continue');
  assert.ok(lines.includes('  judge (round 2): repeated (1/1 blockers matched) → continue'));
  const state = await RunState.open(join(root, '.loop/runs'), 'task', {}, { resume: true, lock: false });
  assert.equal(state.data.pendingRepairs.review, undefined);
  assert.ok(state.data.completed.includes('review'));
  assert.ok(state.data.completed.includes('finish'));
  assert.ok(added.some((entry) => entry.phase === 'finish' && entry.status === 'completed'));
  assert.equal(publishingAttestation(state, await git(root, 'rev-parse', 'HEAD')).overridden, true);
});

test('resume skips the judge when legacy review entries lack previous blockers and repairs continue', async () => {
  const { root, taskFile, bin } = await judgeFixture({ maxRounds: 1 });
  await withFixturePath(bin, () => runLoop({ args: { taskFile, cwd: root, yes: true } }));
  const state = await RunState.open(join(root, '.loop/runs'), 'task', {}, { resume: true, lock: false });
  for (const entry of state.manifest.entries) {
    if (entry.verdict && typeof entry.verdict === 'object') Reflect.deleteProperty(entry.verdict, 'blocking');
  }
  await state.save();
  const lines = [];
  const summary = await withFixturePath(
    bin,
    () =>
      runLoop({
        args: { taskFile, cwd: root, resume: true, maxRounds: 3, yes: true },
      }),
    lines,
  );
  const manifest = await manifestFor(summary);
  const skippedIndex = manifest.phases.findIndex((entry) => entry.role === 'judge' && entry.round === 2);
  assert.deepEqual(manifest.phases[skippedIndex].decision, { skipped: 'no previous blocking findings' });
  assert.ok(lines.includes('  judge (round 2): skipped (no previous blocking findings)'));
  assert.ok(manifest.phases.slice(skippedIndex + 1).some((entry) => entry.phase === 'address' && entry.round === 2));
});

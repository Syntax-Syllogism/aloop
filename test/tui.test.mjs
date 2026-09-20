import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoopArgs } from '../bin/loop.mjs';
import { banner, log, resetRenderer, setRenderer, writeOutput } from '../src/reporter.mjs';
import { createTuiRenderer, tuiEnabled } from '../src/tui.mjs';

function fakeOutput() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), chunks, text: () => chunks.join('') };
}

function fakeState(entries = [], completed = []) {
  return { manifest: { entries }, data: { completed } };
}

const config = {
  resolvedPhases: [{ name: 'implement' }, { name: 'review' }, { name: 'publish' }],
};

test('tuiEnabled is on for any interactive run not opting out', () => {
  assert.equal(tuiEnabled({ isTTY: true }), true);
  assert.equal(tuiEnabled({ isTTY: false }), false);
  assert.equal(tuiEnabled({ isTTY: true, noTui: true }), false);
  assert.equal(tuiEnabled({ isTTY: true, yes: true }), true);
  assert.equal(tuiEnabled({ isTTY: false, yes: true }), false);
});

test('--no-tui parses to args.noTui', () => {
  const args = parseLoopArgs(['run', '--no-tui', '--yes']);
  assert.equal(args.noTui, true);
});

test('createTuiRenderer renders the phase list with the active phase marked', () => {
  const output = fakeOutput();
  const state = fakeState();
  const summary = { task: 'demo', branch: 'feat/demo', worktree: null };
  const renderer = createTuiRenderer({ config, state, summary, output, diffStat: () => '' });

  renderer.banner('implement');
  const frame = output.text();
  assert.match(frame, /▶ implement/);
  assert.match(frame, /\s{2}implement/);
  assert.match(frame, /review/);
  assert.match(frame, /publish/);
});

test('createTuiRenderer reflects phase transitions, findings, and cost from the manifest', () => {
  const output = fakeOutput();
  const state = fakeState(
    [
      { phase: 'implement', status: 'completed', durationMs: 1000, tokens: 500, cost: 0.5, artifacts: ['implement.md'] },
      {
        phase: 'review',
        status: 'completed',
        round: 1,
        durationMs: 2000,
        tokens: 300,
        cost: 0.3,
        artifacts: ['verdict-round-1.json'],
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ issue: 'missing null check', file: 'a.mjs', line: 12 }], nits: [] },
      },
    ],
    ['implement'],
  );
  const summary = { task: 'demo', branch: 'feat/demo', worktree: null };
  const renderer = createTuiRenderer({ config, state, summary, output, diffStat: () => '' });

  renderer.banner('review (round 1/3)');
  renderer.log('  verdict: CHANGES_REQUESTED — needs a null check');

  const frame = output.text();
  assert.match(frame, /✓ implement/);
  assert.match(frame, /▶ review \(round 1, CHANGES_REQUESTED\)/);
  assert.match(frame, /Cost: duration=3000ms tokens=800 cost=0\.8/);
  assert.match(frame, /Findings \(review, CHANGES_REQUESTED\)/);
  assert.match(frame, /missing null check/);
  assert.match(frame, /Artifacts: implement\.md, verdict-round-1\.json/);
  assert.match(frame, /verdict: CHANGES_REQUESTED — needs a null check/);
});

test('createTuiRenderer.output buffers chunks into whole lines instead of writing them raw', () => {
  const output = fakeOutput();
  const state = fakeState();
  const summary = { task: 'demo', branch: 'feat/demo', worktree: null };
  const renderer = createTuiRenderer({ config, state, summary, output, diffStat: () => '' });

  renderer.banner('implement');
  const chunksBeforeOutput = output.chunks.length;
  renderer.output('partial ');
  // A fragment with no newline yet completes no line, so nothing visible
  // changed — it must not spend a repaint (and the git spawn behind it).
  assert.equal(output.chunks.length, chunksBeforeOutput);
  renderer.output('line\nsecond line\ntrail');
  const frame = output.text();

  // The chunk that completes lines still goes through the same
  // clear+repaint path as banner/log — there is no separate raw write mixed
  // into the stream.
  assert.equal(output.chunks.length, chunksBeforeOutput + 1);
  assert.match(frame, /partial line/);
  assert.match(frame, /second line/);
  assert.doesNotMatch(frame, /trail\n/);
});

test('createTuiRenderer caches the diff-stat per phase instead of re-spawning git on every repaint', () => {
  const output = fakeOutput();
  const state = fakeState();
  const summary = { task: 'demo', branch: 'feat/demo', worktree: '/repo' };
  let calls = 0;
  const diffStat = () => {
    calls += 1;
    return `call-${calls}`;
  };
  const renderer = createTuiRenderer({ config, state, summary, output, diffStat });

  renderer.banner('implement');
  assert.equal(calls, 1);
  renderer.log('one');
  renderer.log('two');
  renderer.output('three\n');
  assert.equal(calls, 1, 'log/output repaints must reuse the diff-stat computed at the last banner');

  renderer.banner('review');
  assert.equal(calls, 2, 'a new banner recomputes the diff-stat');
});

test('writeOutput routes through the active renderer instead of process.stdout when the TUI is live', () => {
  const calls = [];
  const stub = { banner() {}, log() {}, output: (text) => calls.push(text) };
  setRenderer(stub);
  const originalWrite = process.stdout.write;
  let rawWrites = 0;
  process.stdout.write = () => {
    rawWrites += 1;
    return true;
  };
  try {
    writeOutput('engine output\n');
  } finally {
    process.stdout.write = originalWrite;
    resetRenderer();
  }
  assert.deepEqual(calls, ['engine output\n']);
  assert.equal(rawWrites, 0);
});

test('writeOutput falls back to process.stdout when no renderer is active', () => {
  const originalWrite = process.stdout.write;
  const rawWrites = [];
  process.stdout.write = (text) => {
    rawWrites.push(text);
    return true;
  };
  try {
    writeOutput('plain output\n');
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(rawWrites, ['plain output\n']);
});

test('createTuiRenderer.stop repaints once more and restores the cursor', () => {
  const output = fakeOutput();
  const renderer = createTuiRenderer({ config, state: fakeState(), summary: { task: 't', branch: 'b', worktree: null }, output, diffStat: () => '' });
  renderer.banner('implement');
  const writesBeforeStop = output.chunks.length;
  renderer.stop();
  assert.equal(output.chunks.length, writesBeforeStop + 2);
  assert.equal(output.chunks.at(-1), '\x1b[?25h');
});

test('reporter.mjs dispatches banner/log to the active renderer and resets cleanly', () => {
  const calls = [];
  const stub = { banner: (text) => calls.push(['banner', text]), log: (message) => calls.push(['log', message]) };
  setRenderer(stub);
  try {
    banner('phase-one');
    log('hello');
    assert.deepEqual(calls, [['banner', 'phase-one'], ['log', 'hello']]);
  } finally {
    resetRenderer();
  }

  const originalLog = console.log;
  const plainCalls = [];
  console.log = (message) => plainCalls.push(message);
  try {
    log('plain output');
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(plainCalls, ['plain output']);
});

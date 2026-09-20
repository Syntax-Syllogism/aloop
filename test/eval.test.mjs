import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatEvalSummaryTable,
  formatEvalTable,
  runEval,
  runEvalCell,
  summarizeEval,
} from '../src/eval.mjs';

// A fake "approve everything" engine: it recognizes the review phase by the
// verdict-file marker every review prompt contains, and otherwise applies
// `task.fix` (files + a commit message) as if it were the implement phase.
// This lets the harness be exercised end-to-end without a real model.
function fakeEngineConfigSource(task) {
  const script = `
const { writeFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const prompt = process.argv[1];
const marker = 'write this JSON to';
if (prompt.includes(marker)) {
  const path = prompt.slice(prompt.indexOf(marker)).split('\\\`')[1];
  writeFileSync(path, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
} else {
  const files = ${JSON.stringify(task.fix.files)};
  for (const rel of Object.keys(files)) {
    const full = join(process.cwd(), rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, files[rel]);
  }
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-m', ${JSON.stringify(task.fix.message)}]);
}
`;
  return `export default {
  gate: ${JSON.stringify(task.gate ?? [])},
  worktrees: false,
  phases: ['implement', 'gate', 'review'],
  adapters: {
    fake: {
      command: ({ prompt }) => ({
        command: ${JSON.stringify(process.execPath)},
        args: ['-e', ${JSON.stringify(script)}, prompt],
      }),
    },
  },
  engines: { default: 'fake' },
};
`;
}

const fakeEngineConfig = { name: 'fake-engine', configSource: fakeEngineConfigSource };

async function silently(fn) {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
}

const correctTask = {
  id: 'greet-correct',
  files: {
    'greet.js': 'module.exports = () => "TODO";\n',
    'gate-check.js': `
const greet = require('./greet.js');
if (typeof greet() !== 'string' || greet().length === 0) process.exit(1);
`,
    'hidden-check.js': `
const greet = require('./greet.js');
if (greet() !== 'hello') process.exit(1);
`,
  },
  task: 'Make greet.js return "hello".',
  gate: ['node gate-check.js'],
  heldOutCheck: ['node hidden-check.js'],
  fix: { files: { 'greet.js': 'module.exports = () => "hello";\n' }, message: 'feat: implement greet' },
};

const escapedDefectTask = {
  ...correctTask,
  id: 'greet-escaped-defect',
  // Satisfies the visible gate (non-empty string) but not the held-out check
  // (must equal "hello") — the review still approves it.
  fix: { files: { 'greet.js': 'module.exports = () => "nope";\n' }, message: 'feat: implement greet (wrong)' },
};

test('runEvalCell runs a task through the loop and reports completion, cost, and rounds', async () => {
  const result = await silently(() => runEvalCell({ task: correctTask, config: fakeEngineConfig }));
  assert.equal(result.task, 'greet-correct');
  assert.equal(result.config, 'fake-engine');
  assert.equal(result.completed, true);
  assert.equal(result.escapedDefect, false);
  assert.equal(result.roundsToConverge, 1);
  assert.match(result.approvedSha, /^[0-9a-f]{40}$/);
  assert.equal(typeof result.durationMs, 'number');
});

test('runEvalCell detects an escaped defect via the held-out check', async () => {
  const result = await silently(() => runEvalCell({ task: escapedDefectTask, config: fakeEngineConfig }));
  assert.equal(result.completed, true, 'the loop still approves the change');
  assert.equal(result.escapedDefect, true, 'the hidden check catches what the gate/review missed');
});

test('runEval sweeps a corpus x matrix and summarizeEval aggregates per config', async () => {
  const results = await silently(() => runEval({
    corpus: [correctTask, escapedDefectTask],
    matrix: [fakeEngineConfig],
  }));
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((cell) => cell.task).sort(), ['greet-correct', 'greet-escaped-defect']);

  const summaries = summarizeEval(results);
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.equal(summary.config, 'fake-engine');
  assert.equal(summary.cells, 2);
  assert.equal(summary.completionRate, 1);
  assert.equal(summary.escapedDefectRate, 0.5);

  const table = formatEvalTable(results);
  assert.match(table, /TASK\tCONFIG\tCOMPLETED\tESCAPED_DEFECT\tROUNDS\tCOST\tDURATION_MS/);
  assert.match(table, /greet-correct\tfake-engine\ttrue\tfalse/);
  assert.match(table, /greet-escaped-defect\tfake-engine\ttrue\ttrue/);

  const summaryTable = formatEvalSummaryTable(summaries);
  assert.match(summaryTable, /CONFIG\tCELLS\tCOMPLETION_RATE\tESCAPED_DEFECT_RATE\tAVG_ROUNDS\tTOTAL_COST\tTOTAL_DURATION_MS/);
  assert.match(summaryTable, /fake-engine\t2\t1\t0\.5/);
});

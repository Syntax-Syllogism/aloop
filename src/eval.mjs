/** @typedef {import('./types.js').Summary} Summary */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { computeRunMetrics, readRunManifest } from './metrics.mjs';
import { runLoop } from './pipeline.mjs';

const exec = promisify(execFile);

/**
 * A task corpus entry: a self-contained repo fixture plus a task description
 * and (optionally) a held-out check that never appears in the visible gate.
 * Escaped defects are the gap between what the gate/review approved and what
 * the held-out check demands.
 *
 * @typedef {Object} EvalTask
 * @property {string} id
 * @property {Record<string, string>} [files] - initial repo contents, relative to the fixture root
 * @property {string} [task] - inline task text written to the run's task file
 * @property {string[]} [gate] - visible gate commands (what the loop enforces)
 * @property {string[]} [heldOutCheck] - hidden verification commands run after approval
 * @property {string[]} [phases] - phase list override (default: implement, gate, review)
 */

/**
 * A matrix cell: a model/engine/config to run every task under. `configSource`
 * gives full control over the generated `loop.config.mjs` (needed for custom
 * adapters, e.g. a fake engine in tests); when omitted, a minimal config is
 * generated from `engine`, `phases`, and `configExtra`.
 *
 * @typedef {Object} EvalConfig
 * @property {string} name
 * @property {string} [engine]
 * @property {string[]} [phases]
 * @property {Record<string, unknown>} [configExtra]
 * @property {((task: EvalTask) => string)|string} [configSource]
 * @property {Record<string, unknown>} [runArgs]
 */

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd })).stdout.trim();
}

async function writeTaskFiles(root, files) {
  for (const [relPath, contents] of Object.entries(files ?? {})) {
    const full = join(root, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
}

async function runShellChecks(cwd, commands) {
  for (const command of commands ?? []) {
    try {
      await exec('sh', ['-c', command], { cwd });
    } catch {
      return false;
    }
  }
  return true;
}

function defaultConfigSource(task, config) {
  const body = {
    gate: task.gate ?? [],
    worktrees: false,
    phases: config.phases ?? task.phases ?? ['implement', 'gate', 'review'],
    engines: { default: config.engine ?? 'claude' },
    ...(config.configExtra ?? {}),
  };
  return `export default ${JSON.stringify(body, null, 2)};\n`;
}

function resolveConfigSource(task, config) {
  if (typeof config.configSource === 'function') return config.configSource(task);
  if (typeof config.configSource === 'string') return config.configSource;
  return defaultConfigSource(task, config);
}

/**
 * Run one task through the loop under one config, in a throwaway repo, and
 * report completion, escaped defects (via the held-out check), convergence,
 * cost, and time — reading cost/convergence from the run's own manifest so the
 * numbers are exactly what {@link computeRunMetrics} would report for a single
 * real run.
 *
 * @param {{ task: EvalTask, config: EvalConfig, baseDir?: string }} options
 */
export async function runEvalCell({ task, config, baseDir }) {
  const root = await mkdtemp(join(baseDir ?? tmpdir(), 'aloop-eval-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'config', 'user.email', 'eval@example.com');
  await git(root, 'config', 'user.name', 'Eval Harness');
  await writeTaskFiles(root, task.files);
  // The loop writes its run state (manifest, logs, lock files) under .loop/
  // inside the repo it's driving; without ignoring it, that bookkeeping shows
  // up as untracked changes and trips the implement/review clean-tree check.
  if (!task.files?.['.gitignore']) await writeFile(join(root, '.gitignore'), '.loop/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'chore: init eval fixture');

  await writeFile(join(root, 'loop.config.mjs'), resolveConfigSource(task, config));
  const taskFile = join(root, 'TASK.md');
  await writeFile(taskFile, task.task ?? '');

  let summary = null;
  let error = null;
  try {
    summary = await runLoop({ args: { taskFile, cwd: root, name: task.id, yes: true, ...(config.runArgs ?? {}) } });
  } catch (caught) {
    error = caught;
  }

  const completed = Boolean(summary && summary.stalled === null);
  const manifest = summary ? await readRunManifest(summary.runDir) : null;
  const metrics = manifest ? computeRunMetrics(manifest) : null;

  let escapedDefect = null;
  if (completed && task.heldOutCheck?.length) {
    escapedDefect = !(await runShellChecks(summary.worktree, task.heldOutCheck));
  }

  const approvedSha = completed ? await git(summary.worktree, 'rev-parse', 'HEAD').catch(() => null) : null;

  return {
    task: task.id,
    config: config.name,
    completed,
    stalled: summary?.stalled ?? null,
    escapedDefect,
    roundsToConverge: metrics?.convergence.roundsToConverge ?? null,
    cost: metrics?.total.cost ?? null,
    durationMs: metrics?.total.durationMs ?? null,
    approvedSha,
    runDir: summary?.runDir ?? null,
    snapshotPath: summary ? join(summary.runDir, 'snapshot.json') : null,
    error: error ? error.message : null,
  };
}

/**
 * Run every task × config cell in the matrix.
 *
 * @param {{ corpus: EvalTask[], matrix: EvalConfig[], baseDir?: string }} options
 */
export async function runEval({ corpus, matrix, baseDir }) {
  const results = [];
  for (const task of corpus) {
    for (const config of matrix) {
      results.push(await runEvalCell({ task, config, baseDir }));
    }
  }
  return results;
}

/** Aggregate per-config totals across every task cell. */
export function summarizeEval(results) {
  const byConfig = new Map();
  for (const cell of results) {
    if (!byConfig.has(cell.config)) byConfig.set(cell.config, []);
    byConfig.get(cell.config).push(cell);
  }
  return [...byConfig.entries()].map(([config, cells]) => {
    const escapedChecked = cells.filter((cell) => cell.escapedDefect !== null);
    const escaped = escapedChecked.filter((cell) => cell.escapedDefect).length;
    const converged = cells.filter((cell) => cell.roundsToConverge !== null);
    const costKnown = cells.length > 0 && cells.every((cell) => cell.cost !== null);
    return {
      config,
      cells: cells.length,
      completionRate: cells.length ? cells.filter((cell) => cell.completed).length / cells.length : null,
      escapedDefectRate: escapedChecked.length ? escaped / escapedChecked.length : null,
      avgRoundsToConverge: converged.length
        ? converged.reduce((total, cell) => total + cell.roundsToConverge, 0) / converged.length
        : null,
      totalCost: costKnown ? cells.reduce((total, cell) => total + cell.cost, 0) : null,
      totalDurationMs: cells.reduce((total, cell) => total + (cell.durationMs ?? 0), 0),
    };
  });
}

function fmt(value) {
  return value === null || value === undefined ? 'unknown' : String(value);
}

/** Render per-cell results as a tab-separated table. */
export function formatEvalTable(results) {
  const header = ['TASK', 'CONFIG', 'COMPLETED', 'ESCAPED_DEFECT', 'ROUNDS', 'COST', 'DURATION_MS'];
  const rows = results.map((cell) => [
    cell.task,
    cell.config,
    String(cell.completed),
    cell.escapedDefect === null ? 'n/a' : String(cell.escapedDefect),
    fmt(cell.roundsToConverge),
    fmt(cell.cost),
    fmt(cell.durationMs),
  ]);
  return [header, ...rows].map((row) => row.join('\t')).join('\n');
}

/** Render per-config aggregate summaries as a tab-separated table. */
export function formatEvalSummaryTable(summaries) {
  const header = ['CONFIG', 'CELLS', 'COMPLETION_RATE', 'ESCAPED_DEFECT_RATE', 'AVG_ROUNDS', 'TOTAL_COST', 'TOTAL_DURATION_MS'];
  const rows = summaries.map((summary) => [
    summary.config,
    String(summary.cells),
    fmt(summary.completionRate),
    fmt(summary.escapedDefectRate),
    fmt(summary.avgRoundsToConverge),
    fmt(summary.totalCost),
    String(summary.totalDurationMs),
  ]);
  return [header, ...rows].map((row) => row.join('\t')).join('\n');
}

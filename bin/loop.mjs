#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainEntrypoint } from '../src/entrypoint.mjs';
import {
  cancelRun,
  cleanRuns,
  doctor,
  getAggregateMetrics,
  getRun,
  inspectRun,
  listRuns,
  resolveRunsDir,
} from '../src/operations.mjs';
import { computeRunMetrics } from '../src/metrics.mjs';
import { runLoop } from '../src/pipeline.mjs';

const commands = new Set(['run', 'list', 'status', 'inspect', 'cancel', 'clean', 'doctor', 'metrics']);

export function parseLoopArgs(argv) {
  const command = commands.has(argv[0]) ? argv[0] : 'run';
  const commandArgv = command === 'run' && argv[0] !== 'run' ? argv : argv.slice(1);
  const { values, positionals } = parseArgs({
    args: commandArgv,
    options: {
      task: { type: 'string', short: 't' },
      'task-file': { type: 'string', short: 'f' },
      name: { type: 'string', short: 'n' },
      branch: { type: 'string', short: 'b' },
      'base-branch': { type: 'string' },
      engine: { type: 'string', short: 'e' },
      'override-engine': { type: 'boolean' },
      config: { type: 'string' },
      phases: { type: 'string' },
      'max-rounds': { type: 'string' },
      from: { type: 'string' },
      resume: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-worktree': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      metrics: { type: 'boolean' },
      'older-than': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { command, help: true };
  const maxRounds = values['max-rounds'] ? Number(values['max-rounds']) : undefined;
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    throw new Error('--max-rounds must be a positive integer');
  }
  const olderThanDays = values['older-than'] === undefined ? undefined : Number(values['older-than']);
  if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    throw new Error('--older-than must be a non-negative number of days');
  }
  const [runName] = positionals;
  if (positionals.length > 1 || (['status', 'inspect', 'cancel'].includes(command) && !runName)) {
    throw new Error(`${command} requires exactly one run name`);
  }
  if (command !== 'run' && !['status', 'inspect', 'cancel'].includes(command) && positionals.length) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  return {
    command,
    runName,
    task: values.task,
    taskFile: values['task-file'],
    name: values.name,
    branch: values.branch,
    baseBranch: values['base-branch'],
    engine: values.engine,
    overrideEngine: values['override-engine'],
    config: values.config,
    phases: values.phases ? values.phases.split(',').map((phase) => phase.trim()).filter(Boolean) : undefined,
    maxRounds,
    from: values.from,
    resume: values.resume,
    yes: values.yes,
    noWorktree: values['no-worktree'],
    dryRun: values['dry-run'],
    json: values.json,
    metrics: values.metrics,
    olderThanDays,
  };
}

export function usage() {
  return [
    'Usage: aloop [command] [options]',
    '',
    'Commands:',
    '  list                    List persisted runs',
    '  status <name>           Show current phase, verdict, and metrics',
    '  inspect <name>          Show manifest, phase evidence, and metrics',
    '  metrics                 Show aggregate metrics across runs',
    '  cancel <name>           Stop a run and release its lock',
    '  clean                   Preview/remove completed runs older than 30 days',
    '  doctor                  Check configuration and local tooling',
    '  run                     Start or resume a run (the default)',
    '',
    'Operational options:',
    '      --json              Emit machine-readable JSON',
    '      --metrics           Include per-run metrics in list output',
    '      --older-than <n>    Clean completed runs older than n days',
    '  -y, --yes               Confirm destructive clean operations',
    '      --dry-run           Preview clean operations without changing files',
    '',
    'Run options:',
    '  -t, --task <text>       Inline task description',
    '  -f, --task-file <path>  Path to a task/plan/spec file',
    '  -n, --name <slug>       Explicit run identity/slug',
    '  -b, --branch <name>     Branch to build on (default: <branchPrefix><name>)',
    '      --base-branch <branch>  Base to branch from and PR against (default: baseBranch config)',
    '  -e, --engine <name>     Default engine: claude | codex | agy | gemini',
    '      --override-engine   With --resume and --engine, replace saved agent executables',
    '      --config <path>     Load loop configuration from this file (also overrides saved config on resume)',
    '      --phases a,b,c      Override the configured phase list',
    '      --max-rounds <n>    Cap on review/repair rounds',
    '      --from <phase>      Start at this phase',
    '      --resume            Skip phases already recorded complete',
    '      --no-worktree       Work in the current checkout instead of a worktree',
    '  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)',
    '      --dry-run           Print the plan and rendered prompts, run nothing',
  ].join('\n');
}

function formatMetric(value) {
  return value === null || value === undefined ? '?' : String(value);
}

async function metricsForRun(run) {
  try {
    const manifest = JSON.parse(await readFile(join(run.runDir, 'manifest.json'), 'utf8'));
    return computeRunMetrics(manifest);
  } catch {
    return computeRunMetrics({ phases: [] });
  }
}

function printList(runs, output = console, includeMetrics = false) {
  if (!runs.length) return output.log('No runs found.');
  const header = ['NAME', 'STATUS', 'PHASE', 'BRANCH', 'UPDATED', 'PR'];
  if (includeMetrics) header.push('DURATION', 'TOKENS', 'COST');
  output.log(header.join('\t'));
  for (const run of runs) {
    const row = [run.name, run.status, run.currentPhase ?? '-', run.branch ?? '-', run.updatedAt ?? run.startedAt ?? '-', run.prUrl ?? '-'];
    if (includeMetrics && run.metrics) {
      row.push(`${run.metrics.total.durationMs}ms`, formatMetric(run.metrics.total.tokens), formatMetric(run.metrics.total.cost));
    }
    output.log(row.join('\t'));
  }
}

function printMetricsLines(metrics, output = console) {
  output.log(`duration : ${metrics.total.durationMs}ms`);
  output.log(`tokens   : ${formatMetric(metrics.total.tokens)}`);
  output.log(`cost     : ${formatMetric(metrics.total.cost)}`);
  output.log(`catch    : ${formatMetric(metrics.reviewer.catchRate)}`);
}

function printStatus(run, output = console, metrics = null) {
  output.log(`run      : ${run.name}`);
  output.log(`status   : ${run.status}`);
  output.log(`phase    : ${run.currentPhase ?? '-'}`);
  output.log(`verdict  : ${run.verdict ?? '-'}`);
  output.log(`gate     : ${run.gateStatus ?? '-'}`);
  output.log(`branch   : ${run.branch ?? '-'}`);
  output.log(`updated  : ${run.updatedAt ?? run.startedAt ?? '-'}`);
  output.log(`PR       : ${run.prUrl ?? '-'}`);
  if (metrics) printMetricsLines(metrics, output);
}

function printAggregate(metrics, output = console) {
  output.log(`runs        : ${metrics.runs}`);
  output.log(`duration    : ${metrics.total.durationMs}ms`);
  output.log(`tokens      : ${formatMetric(metrics.total.tokens)}`);
  output.log(`cost        : ${formatMetric(metrics.total.cost)}`);
  output.log(`convergence : ${formatMetric(metrics.convergence.convergenceRate)}`);
  output.log(`catch       : ${formatMetric(metrics.reviewer.catchRate)}`);
}

function printInspect(run, output = console, metrics = null) {
  printStatus(run, output, metrics);
  output.log(`run dir  : ${run.runDir}`);
  for (const phase of run.phases) {
    output.log(`\n[${phase.phase}] ${phase.status}`);
    for (const field of ['inputSha', 'outputSha', 'promptHash', 'configHash', 'engine', 'verdict', 'gateReceipts', 'artifacts']) {
      if (phase[field] !== undefined && phase[field] !== null) output.log(`${field} : ${JSON.stringify(phase[field])}`);
    }
  }
}

export async function runOperationalCommand(args, { cwd = process.cwd(), output = console } = {}) {
  const options = { cwd, configPath: args.config };
  if (args.command === 'list') {
    const result = await listRuns(options);
    if (args.metrics) {
      for (const run of result) run.metrics = await metricsForRun(run);
    }
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else printList(result, output, args.metrics);
    return result;
  }
  if (args.command === 'status') {
    const run = await getRun(args.runName, options);
    const metrics = computeRunMetrics(run.manifest);
    const result = { ...run.summary, metrics };
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else printStatus(run.summary, output, metrics);
    return result;
  }
  if (args.command === 'inspect') {
    const result = await inspectRun(args.runName, options);
    const metrics = computeRunMetrics(result.manifest ?? { phases: result.phases });
    if (args.json) output.log(JSON.stringify({ ...result, metrics }, null, 2));
    else printInspect(result, output, metrics);
    return result;
  }
  if (args.command === 'metrics') {
    const { runsDir } = await resolveRunsDir(cwd, args.config);
    const result = await getAggregateMetrics(runsDir);
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else printAggregate(result, output);
    return result;
  }
  if (args.command === 'cancel') {
    const result = await cancelRun(args.runName, options);
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else printStatus(result, output);
    return result;
  }
  if (args.command === 'clean') {
    const result = await cleanRuns({
      ...options,
      olderThanDays: args.olderThanDays ?? 30,
      dryRun: args.dryRun,
      yes: args.yes,
    });
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else {
      output.log(`${result.dryRun ? 'Would remove' : 'Removed'} ${result.dryRun ? result.candidates.length : result.removed.length} run(s).`);
      for (const run of result.candidates) output.log(`  ${run.name} (${run.updatedAt ?? run.startedAt ?? 'unknown date'})`);
      if (!args.yes && !args.dryRun && result.candidates.length) output.log('Preview only: rerun with --yes to remove these runs.');
      for (const error of result.errors) output.error?.(`  ${error.name}: ${error.error}`);
    }
    return result;
  }
  if (args.command === 'doctor') {
    const result = await doctor(options);
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else {
      for (const check of result.checks) output.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
      output.log(result.ok ? 'Doctor: OK' : 'Doctor: problems found');
    }
    return result;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (isMainEntrypoint(import.meta.url)) {
  try {
    const args = parseLoopArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else if (args.command === 'run') {
      await runLoop({ args });
    } else {
      const result = await runOperationalCommand(args);
      if (args.command === 'doctor' && !result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    if (!error.command) console.error(usage());
    process.exitCode = 1;
  }
}

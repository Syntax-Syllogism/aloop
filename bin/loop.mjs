#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMainEntrypoint } from '../src/entrypoint.mjs';
import { readPackageVersion } from '../src/version.mjs';
import {
  cancelRun,
  cleanRuns,
  doctor,
  getAggregateMetrics,
  getRun,
  init,
  inspectRun,
  listRuns,
  replayRun,
  resolveRunsDir,
  watchRuns,
} from '../src/operations.mjs';
import { computeRunMetrics } from '../src/metrics.mjs';
import { runLoop } from '../src/pipeline.mjs';
import { COMMAND_MANUALS, listGuides, renderCommandManual, renderGuide, suggestHelpTopics } from '../src/help-topics.mjs';

/** @typedef {import('../src/types.js').OperationalOutput} OperationalOutput */
/** @typedef {import('../src/types.js').OperationalResult} OperationalResult */

const commands = new Set([
  'run',
  'list',
  'status',
  'inspect',
  'replay',
  'cancel',
  'clean',
  'doctor',
  'metrics',
  'init',
  'watch',
  'help',
]);

const OPTION_BLOCKS = {
  general: [
    '  -h, --help              Show this help',
    '      --version           Print the package version',
  ],
  operational: [
    '      --json              Emit machine-readable JSON',
    '      --metrics           Include per-run metrics in list output',
    '      --older-than <n>    Clean completed runs older than n days',
    '  -y, --yes               Confirm destructive clean operations',
    '      --dry-run           Preview clean operations without changing files',
  ],
  config: ['      --config <path>     Load loop configuration from this file'],
  json: ['      --json              Emit machine-readable JSON'],
  list: [
    '      --json              Emit machine-readable JSON',
    '      --metrics           Include per-run metrics in list output',
  ],
  clean: [
    '      --json              Emit machine-readable JSON',
    '      --older-than <n>    Clean completed runs older than n days',
    '  -y, --yes               Confirm destructive clean operations',
    '      --dry-run           Preview clean operations without changing files',
  ],
  doctor: [
    '      --config <path>     Load loop configuration from this file',
    '      --json              Emit machine-readable JSON',
  ],
  watch: [
    '      --repo <path>       Repository to watch (repeatable; default: cwd)',
    '      --interval <secs>   Poll interval, at least 1 second (default: 15)',
    '      --once              Exit after the first non-snapshot event',
    '      --timeout <duration> Exit with code 2 after an idle timeout (e.g. 10m)',
    '      --only status       Suppress phase-only and judge decision events',
    '      --initial           Emit a snapshot of existing runs',
  ],
  init: [
    '      --preset <name>     Seed init from a bundled preset (e.g. work-item)',
    '      --force             Overwrite existing scaffold files',
  ],
  help: [
    '  -a, --all               List commands and guides',
    '  -g, --guides            List guides only',
  ],
  run: [
    '  -t, --task <text>       Inline task description',
    '  -f, --task-file <path>  Path to a task/plan/spec file',
    '  -n, --name <slug>       Explicit run identity/slug',
    '  -b, --branch <name>     Branch to build on (default: <branchPrefix><name>)',
    '      --base-branch <branch>  Base to branch from and PR against (default: baseBranch config)',
    '  -e, --engine <name>     Default engine: claude | codex | agy | gemini',
    '  -m, --model <name>      Model for the default engine (overrides config; switching engines without it uses the new engine default)',
    '      --effort <level>    Reasoning effort for the default engine (overrides config; ignored by engines without effort)',
    '      --override-engine   With --resume and --engine, replace saved agent executables',
    '      --config <path>     Load loop configuration from this file (also overrides saved config on resume)',
    '      --phases a,b,c      Override the configured phase list',
    '      --max-rounds <n>    Cap on review/repair rounds',
    '      --no-judge          Disable a configured repeated-blocker judge for this run',
    '      --on-repeat <action> Judge action: stall or continue',
    '      --from <phase>      Start at this phase (with --resume, re-run it even if complete)',
    '      --preset <name|path> Activate a bundled preset or external preset directory',
    '      --resume            Skip phases already recorded complete',
    '      --note <text>       Give the resumed phase an authoritative instruction',
    '      --note-file <path>  Read the instruction from a file (--note wins)',
    '      --no-worktree       Work in the current checkout instead of a worktree',
    '      --no-tui            Force plain streaming output (TUI is on by default on a TTY)',
    '      --quiet             Print only phase transitions, status lines, and a periodic heartbeat (disables the TUI)',
    '      --no-quiet          Override quiet: true from the config',
    '      --heartbeat <min>   Heartbeat interval in minutes for quiet mode (default 10; 0 = transitions only; implies --quiet)',
    '  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)',
    '      --dry-run           Print the plan and rendered prompts, run nothing',
  ],
};

const COMMAND_HELP = {
  list: { usage: 'list', summary: 'List persisted runs', optionGroups: ['config', 'list'] },
  status: { usage: 'status <name>', summary: 'Show current phase, verdict, and metrics', optionGroups: ['config', 'json'] },
  inspect: { usage: 'inspect <name>', summary: 'Show manifest, phase evidence, and metrics', optionGroups: ['config', 'json'] },
  replay: { usage: 'replay <name>', summary: 'Verify recorded prompt inputs and show phase transitions', optionGroups: ['config', 'json'] },
  metrics: { usage: 'metrics', summary: 'Show aggregate metrics across runs', optionGroups: ['config', 'json'] },
  cancel: { usage: 'cancel <name>', summary: 'Stop a run and release its lock', optionGroups: ['config', 'json'] },
  clean: { usage: 'clean', summary: 'Preview/remove completed runs older than 30 days', optionGroups: ['config', 'clean'] },
  doctor: { usage: 'doctor', summary: 'Check configuration and local tooling', optionGroups: ['doctor'] },
  watch: { usage: 'watch [names...]', summary: 'Stream run status/phase/judge-decision changes as NDJSON', optionGroups: ['config', 'watch'] },
  init: { usage: 'init', summary: 'Scaffold loop.config.mjs and .loop/prompts', optionGroups: ['init', 'json'] },
  help: { usage: 'help [command|guide]', summary: 'Show full command manuals and documentation guides', optionGroups: ['help'] },
  run: { usage: 'run', summary: 'Start or resume a run (the default)', optionGroups: ['run'] },
};

function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text);
  if (!match) throw new Error('--timeout must be a duration like 90s, 10m, or 1h');
  const value = Number(match[1]);
  const multiplier = match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : 1_000;
  const milliseconds = value * multiplier;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error('--timeout must be a duration like 90s, 10m, or 1h');
  }
  return milliseconds;
}

export function parseLoopArgs(argv) {
  const explicitCommand = commands.has(argv[0]);
  const command = explicitCommand ? argv[0] : 'run';
  if (argv.includes('--version')) return { command, version: true };
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
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
      'override-engine': { type: 'boolean' },
      config: { type: 'string' },
      repo: { type: 'string', multiple: true },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      timeout: { type: 'string' },
      only: { type: 'string' },
      initial: { type: 'boolean' },
      phases: { type: 'string' },
      'max-rounds': { type: 'string' },
      'no-judge': { type: 'boolean' },
      'on-repeat': { type: 'string' },
      from: { type: 'string' },
      resume: { type: 'boolean' },
      note: { type: 'string' },
      'note-file': { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-worktree': { type: 'boolean' },
      'no-tui': { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-quiet': { type: 'boolean' },
      heartbeat: { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      metrics: { type: 'boolean' },
      'older-than': { type: 'string' },
      preset: { type: 'string' },
      force: { type: 'boolean' },
      all: { type: 'boolean', short: 'a' },
      guides: { type: 'boolean', short: 'g' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { command, help: true, explicitCommand };
  if (command === 'help') {
    if (positionals.length > 1) throw new Error('help accepts at most one command or guide');
    if (values.all && values.guides) throw new Error('--all and --guides are mutually exclusive');
    if ((values.all || values.guides) && positionals.length) throw new Error('--all and --guides do not accept a topic');
    return { command, helpTopic: positionals[0], helpAll: values.all, helpGuides: values.guides };
  }
  const maxRounds = values['max-rounds'] ? Number(values['max-rounds']) : undefined;
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    throw new Error('--max-rounds must be a positive integer');
  }
  if (values['on-repeat'] !== undefined && !['stall', 'continue'].includes(values['on-repeat'])) {
    throw new Error('--on-repeat must be stall or continue');
  }
  const olderThanDays = values['older-than'] === undefined ? undefined : Number(values['older-than']);
  if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    throw new Error('--older-than must be a non-negative number of days');
  }
  const heartbeatMinutes = values.heartbeat === undefined ? undefined : Number(values.heartbeat);
  if (
    heartbeatMinutes !== undefined &&
    (values.heartbeat.trim() === '' || !Number.isFinite(heartbeatMinutes) || heartbeatMinutes < 0)
  ) {
    throw new Error('--heartbeat must be a non-negative number of minutes');
  }
  if (values.quiet && values['no-quiet']) {
    throw new Error('--quiet and --no-quiet are mutually exclusive');
  }
  const watchOptionsUsed =
    values.repo !== undefined ||
    values.interval !== undefined ||
    values.once ||
    values.timeout !== undefined ||
    values.only !== undefined ||
    values.initial;
  if (command !== 'watch' && watchOptionsUsed) {
    throw new Error('--repo, --interval, --once, --timeout, --only, and --initial are only valid with watch');
  }
  const intervalSeconds = values.interval === undefined ? undefined : Number(values.interval);
  if (intervalSeconds !== undefined && (!Number.isFinite(intervalSeconds) || intervalSeconds < 1)) {
    throw new Error('--interval must be a positive number of seconds');
  }
  const timeoutMs = values.timeout === undefined ? undefined : parseDuration(values.timeout);
  if (values.only !== undefined && values.only !== 'status') {
    throw new Error('--only must be status');
  }
  const [runName] = positionals;
  if (
    (command !== 'watch' && positionals.length > 1) ||
    (['status', 'inspect', 'replay', 'cancel'].includes(command) && !runName)
  ) {
    throw new Error(`${command} requires exactly one run name`);
  }
  if (
    command !== 'run' && command !== 'help' &&
    command !== 'watch' &&
    !['status', 'inspect', 'replay', 'cancel'].includes(command) &&
    positionals.length
  ) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  return {
    command,
    runName,
    runNames: command === 'watch' ? positionals : undefined,
    task: values.task,
    taskFile: values['task-file'],
    name: values.name,
    branch: values.branch,
    baseBranch: values['base-branch'],
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    overrideEngine: values['override-engine'],
    config: values.config,
    phases: values.phases
      ? values.phases
          .split(',')
          .map((phase) => phase.trim())
          .filter(Boolean)
      : undefined,
    maxRounds,
    noJudge: values['no-judge'],
    onRepeat: values['on-repeat'],
    from: values.from,
    resume: values.resume,
    note: values.note,
    noteFile: values['note-file'],
    yes: values.yes,
    noWorktree: values['no-worktree'],
    noTui: values['no-tui'],
    quiet: values.quiet,
    noQuiet: values['no-quiet'],
    heartbeatMinutes,
    dryRun: values['dry-run'],
    json: values.json,
    metrics: values.metrics,
    olderThanDays,
    preset: values.preset,
    force: values.force,
    repo: values.repo,
    intervalMs: intervalSeconds === undefined ? undefined : intervalSeconds * 1000,
    once: values.once,
    timeoutMs,
    only: values.only,
    initial: values.initial,
  };
}

function renderOptions(blocks) {
  return blocks.flatMap((name) => OPTION_BLOCKS[name]);
}

export function commandUsage(command) {
  const help = COMMAND_HELP[command];
  if (!help) throw new Error(`Unknown command: ${command}`);
  return [
    `Usage: aloop ${help.usage} [options]`,
    '',
    help.summary,
    '',
    'Options:',
    ...renderOptions(['general', ...help.optionGroups]),
    '',
    "Run 'aloop --help' for all commands.",
    "Run 'aloop help <command|guide>' for full documentation.",
  ].join('\n');
}

export function usage() {
  return [
    'Usage: aloop [command] [options]',
    '',
    'Commands:',
    ...Object.values(COMMAND_HELP).map(({ usage: commandUsageText, summary }) =>
      `  ${commandUsageText.padEnd(24)}${summary}`,
    ),
    '',
    'General options:',
    ...OPTION_BLOCKS.general,
    '',
    'Operational options:',
    ...OPTION_BLOCKS.operational,
    '',
    'Watch options:',
    ...OPTION_BLOCKS.watch,
    '',
    'Init options:',
    ...OPTION_BLOCKS.init,
    '',
    'Run options:',
    ...OPTION_BLOCKS.run,
    '',
    "Run 'aloop help <command|guide>' for full documentation.",
  ].join('\n');
}

async function runHelp(args, { output = console.log, error = console.error } = {}) {
  const guides = await listGuides();
  const guideByName = new Map(guides.map((guide) => [guide.name, guide]));
  if (args.helpTopic) {
    const topic = args.helpTopic;
    if (topic === 'help') {
      output(commandUsage('help'));
      return 0;
    }
    if (COMMAND_MANUALS[topic]) {
      output(await renderCommandManual(topic, commandUsage(topic)));
      return 0;
    }
    if (guideByName.has(topic)) {
      output(await renderGuide(topic));
      return 0;
    }
    error(`aloop help: no command or guide named '${topic}'`);
    const matches = suggestHelpTopics(topic, [...Object.keys(COMMAND_MANUALS), ...guideByName.keys()]);
    if (matches.length) error(`Closest matches: ${matches.join(', ')}`);
    error("Run 'aloop help -a' to see all commands and guides.");
    return 1;
  }

  const showCommands = !args.helpGuides;
  const showGuides = true;
  const lines = [];
  if (showCommands) {
    lines.push('Commands:');
    for (const [name, { summary }] of Object.entries(COMMAND_HELP)) lines.push(`  ${name.padEnd(12)}${summary}`);
  }
  if (showGuides) {
    if (lines.length) lines.push('');
    lines.push('Guides:');
    for (const guide of guides) lines.push(`  ${guide.name.padEnd(16)}${guide.description}`);
  }
  output(lines.join('\n'));
  return 0;
}

function writeWatchLine(output, event) {
  return new Promise((resolveWrite, rejectWrite) => {
    const line = `${JSON.stringify(event)}\n`;
    try {
      output.write(line, (error) => (error ? rejectWrite(error) : resolveWrite()));
      if (output.write.length < 2) resolveWrite();
    } catch (error) {
      rejectWrite(error);
    }
  });
}

/**
 * @param {ReturnType<typeof parseLoopArgs>} args
 * @param {{
 *   cwd?: string,
 *   output?: {
 *     write: (line: string, callback?: (error?: Error | null) => void) => unknown,
 *     error?: (message: string) => void,
 *     on?: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => unknown,
 *     removeListener?: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => unknown,
 *   },
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function watchCommand(args, { cwd = process.cwd(), output = process.stdout, signal } = {}) {
  const writeError = output.error ?? console.error;
  const swallowBrokenPipe = (error) => {
    if (error.code !== 'EPIPE') writeError(error.message);
  };
  output.on?.('error', swallowBrokenPipe);
  const controller = new AbortController();
  const watchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const now = () => new Date();
  const timeoutMs = args.timeoutMs;
  let lastEventAt = Date.now();
  const repos = args.repo?.length ? args.repo.map((repo) => resolve(cwd, repo)) : [resolve(cwd)];
  const iterator = watchRuns({
    repos,
    configPath: args.config ? resolve(cwd, args.config) : undefined,
    names: args.runNames,
    intervalMs: args.intervalMs ?? 15_000,
    initial: args.initial,
    signal: watchSignal,
    warn: (message) => writeError(message),
  });
  let next = iterator.next();
  try {
    while (true) {
      let timer;
      let timeoutHandle;
      let timeoutWon = false;
      if (timeoutMs !== undefined) {
        const remaining = Math.max(0, timeoutMs - (Date.now() - lastEventAt));
        timer = new Promise((resolveTimer) => {
          timeoutHandle = setTimeout(() => {
            timeoutWon = true;
            resolveTimer(null);
          }, remaining).unref?.();
        });
      }
      const result = timeoutMs === undefined ? await next : await Promise.race([next, timer]);
      if (timeoutHandle && !timeoutWon) clearTimeout(timeoutHandle);
      if (timeoutWon) {
        controller.abort();
        await iterator.return();
        await writeWatchLine(output, { type: 'timeout', at: now().toISOString(), idleMs: Date.now() - lastEventAt });
        return 2;
      }
      if (result.done) return 0;
      const event = result.value;
      if (args.only === 'status' && (event.type === 'phase' || event.type === 'decision')) {
        next = iterator.next();
        continue;
      }
      try {
        await writeWatchLine(output, event);
      } catch (error) {
        if (error.code === 'EPIPE') return 0;
        throw error;
      }
      if (event.type !== 'snapshot') {
        lastEventAt = Date.now();
        if (args.once) {
          controller.abort();
          await iterator.return();
          return 0;
        }
      }
      next = iterator.next();
    }
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError' || error.code === 'EPIPE') return 0;
    writeError(error.message);
    return 1;
  } finally {
    controller.abort();
    await iterator.return().catch(() => {});
    output.removeListener?.('error', swallowBrokenPipe);
  }
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

/** @param {OperationalOutput} [output] */
function printList(runs, output = console, includeMetrics = false) {
  if (!runs.length) return output.log('No runs found.');
  const header = ['NAME', 'STATUS', 'PHASE', 'BRANCH', 'UPDATED', 'PR'];
  if (includeMetrics) header.push('DURATION', 'TOKENS', 'COST');
  output.log(header.join('\t'));
  for (const run of runs) {
    const row = [
      run.name,
      run.status,
      run.currentPhase ?? '-',
      run.branch ?? '-',
      run.updatedAt ?? run.startedAt ?? '-',
      run.prUrl ?? '-',
    ];
    if (includeMetrics && run.metrics) {
      row.push(
        `${run.metrics.total.durationMs}ms`,
        formatMetric(run.metrics.total.tokens),
        formatMetric(run.metrics.total.cost),
      );
    }
    output.log(row.join('\t'));
  }
}

// Judge stall reasons and review overrides; omitted when none occurred.
function formatJudgeMetrics(judge) {
  if (!judge?.repeatedBlockerStalls && !judge?.failedClosedStalls && !judge?.reviewOverrides) return null;
  return `${judge.repeatedBlockerStalls} repeated-blocker stall(s), ${judge.failedClosedStalls} failed-closed stall(s), ${judge.reviewOverrides} review override(s)`;
}

/** @param {OperationalOutput} [output] */
function printMetricsLines(metrics, output = console) {
  output.log(`duration : ${metrics.total.durationMs}ms`);
  output.log(`tokens   : ${formatMetric(metrics.total.tokens)}`);
  output.log(`cost     : ${formatMetric(metrics.total.cost)}`);
  output.log(`catch    : ${formatMetric(metrics.reviewer.catchRate)}`);
  const judge = formatJudgeMetrics(metrics.judge);
  if (judge) output.log(`stalls   : ${judge}`);
}

/** @param {OperationalOutput} [output] */
function printStatus(run, output = console, metrics = null) {
  output.log(`run      : ${run.name}`);
  output.log(`status   : ${run.status}`);
  output.log(`phase    : ${run.currentPhase ?? '-'}`);
  output.log(`started  : ${run.phaseStartedAt ?? '-'}`);
  output.log(`verdict  : ${run.verdict ?? '-'}`);
  output.log(`gate     : ${run.gateStatus ?? '-'}`);
  if (run.judge) {
    const outcome = run.judge.failure
      ? `failed: ${run.judge.failure}`
      : run.judge.skipped
        ? `skipped (${run.judge.skipped})`
        : run.judge.repeated
          ? `repeated${run.judge.action ? ` (${run.judge.action})` : ''}`
          : 'not repeated';
    output.log(`judge    : round ${run.judge.round ?? '-'} ${outcome}`);
    if (run.judge.matchSummary) output.log(`matches  : ${run.judge.matchSummary}`);
  }
  output.log(`branch   : ${run.branch ?? '-'}`);
  output.log(`updated  : ${run.updatedAt ?? run.startedAt ?? '-'}`);
  output.log(`PR       : ${run.prUrl ?? '-'}`);
  if (metrics) printMetricsLines(metrics, output);
}

/** @param {OperationalOutput} [output] */
function printAggregate(metrics, output = console) {
  output.log(`runs        : ${metrics.runs}`);
  output.log(`duration    : ${metrics.total.durationMs}ms`);
  output.log(`tokens      : ${formatMetric(metrics.total.tokens)}`);
  output.log(`cost        : ${formatMetric(metrics.total.cost)}`);
  output.log(`convergence : ${formatMetric(metrics.convergence.convergenceRate)}`);
  output.log(`catch       : ${formatMetric(metrics.reviewer.catchRate)}`);
  const judge = formatJudgeMetrics(metrics.judge);
  if (judge) output.log(`stalls      : ${judge}`);
}

/** @param {OperationalOutput} [output] */
function printReplay(result, output = console) {
  output.log(`run      : ${result.name}`);
  output.log(`base SHA : ${result.baseSha.value ?? '-'} (${result.baseSha.available ? 'available' : 'unavailable'})`);
  output.log(`worktree : ${result.worktree.path ?? '-'} (${result.worktree.available ? 'available' : 'unavailable'})`);
  for (const entry of result.timeline) {
    const prompt = entry.prompt ? ` prompt=${entry.prompt.status}` : '';
    output.log(`${entry.phase}  ${entry.status}  ${entry.inputSha ?? '-'} → ${entry.outputSha ?? '-'}${prompt}`);
  }
  for (const divergence of result.divergences) output.log(`! ${divergence.message}`);
}

/** @param {OperationalOutput} [output] */
function printInspect(run, output = console, metrics = null) {
  printStatus(run, output, metrics);
  output.log(`run dir  : ${run.runDir}`);
  const settings = Object.entries(run.agentSettings ?? {});
  if (settings.length) {
    const width = Math.max(...settings.map(([phaseName]) => phaseName.length));
    settings.forEach(([phaseName, agent], index) => {
      const details = `${agent.name}${agent.agent ? ` agent: ${agent.agent}` : ''}${agent.model ? ` model=${agent.model}` : ''}${agent.effort ? ` effort=${agent.effort}` : ''}`;
      output.log(`${index === 0 ? 'engines  :' : '          '} ${phaseName.padEnd(width)}  ${details}`);
    });
  }
  for (const phase of run.phases) {
    output.log(`\n[${phase.phase}] ${phase.status}`);
    for (const field of [
      'inputSha',
      'outputSha',
      'promptHash',
      'configHash',
      'engine',
      'agentStatus',
      'agentSource',
      'verdict',
      'gateReceipts',
      'matchSummary',
      'decision',
      'failure',
      'artifacts',
    ]) {
      if (phase[field] !== undefined && phase[field] !== null) output.log(`${field} : ${JSON.stringify(phase[field])}`);
    }
  }
}

/**
 * @param {object} args
 * @param {{cwd?: string, output?: OperationalOutput}} [options]
 * @returns {Promise<OperationalResult>}
 */
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
  if (args.command === 'replay') {
    const result = await replayRun(args.runName, options);
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else printReplay(result, output);
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
      output.log(
        `${result.dryRun ? 'Would remove' : 'Removed'} ${result.dryRun ? result.candidates.length : result.removed.length} run(s).`,
      );
      for (const run of result.candidates)
        output.log(`  ${run.name} (${run.updatedAt ?? run.startedAt ?? 'unknown date'})`);
      if (!args.yes && !args.dryRun && result.candidates.length)
        output.log('Preview only: rerun with --yes to remove these runs.');
      for (const error of result.errors) output.error?.(`  ${error.name}: ${error.error}`);
    }
    return result;
  }
  if (args.command === 'doctor') {
    const result = await doctor(options);
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else {
      for (const check of result.checks) {
        output.log(`${check.warn ? '⚠' : check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
        if (check.hint) output.log(`  → ${check.hint}${check.docs ? ` (${check.docs})` : ''}`);
      }
      const warnings = result.checks.filter((check) => check.warn).length;
      output.log(result.ok ? `Doctor: OK${warnings ? ` (${warnings} warnings)` : ''}` : 'Doctor: problems found');
    }
    return result;
  }
  if (args.command === 'init') {
    const result = await init({ cwd, preset: args.preset, force: args.force });
    if (args.json) output.log(JSON.stringify(result, null, 2));
    else {
      for (const file of result.created) output.log(`  create  ${file}`);
      for (const file of result.skipped) output.log(`  skip    ${file} (exists)`);
      output.log(result.preset ? `Initialized aloop with preset "${result.preset}".` : 'Initialized aloop.');
    }
    return result;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (isMainEntrypoint(import.meta.url)) {
  try {
    const args = parseLoopArgs(process.argv.slice(2));
    if (args.help) {
      console.log(args.explicitCommand ? commandUsage(args.command) : usage());
    } else if (args.version) {
      console.log(`aloop ${await readPackageVersion()}`);
    } else if (args.command === 'help') {
      process.exitCode = await runHelp(args);
    } else if (args.command === 'run') {
      await runLoop({ args });
    } else if (args.command === 'watch') {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        process.exitCode = await watchCommand(args, {
          cwd: process.cwd(),
          output: process.stdout,
          signal: controller.signal,
        });
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    } else {
      const result = await runOperationalCommand(args);
      if (args.command === 'doctor' && !(/** @type {any} */ (result).ok)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    if (!error.command) console.error(usage());
    process.exitCode = 1;
  }
}

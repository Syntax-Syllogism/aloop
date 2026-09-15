import { access, readFile, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapterFor, agentForPhase } from './adapters.mjs';
import { runCommand, signalProcessGroup } from './command.mjs';
import { defaults, loadConfig, loadRunsDir } from './config.mjs';
import { GitFacade } from './git.mjs';
import { computeAggregateMetrics, computeRunMetrics, readRunManifests } from './metrics.mjs';
import { RunState, slugFor } from './state.mjs';

const PULL_REQUEST_URL = /https?:\/\/[^\s"'`<>]+(?:\/pull\/\d+|\/merge_requests\/\d+)[^\s"'`<>]*/i;

async function readJson(path, { optional = true } = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (optional) return null;
      throw new Error(`Unable to read ${path}: ${error.message}`, { cause: error });
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}.`);
    throw error;
  }
}

// --- Metrics-oriented read API (runsDir based) -----------------------------

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isLocked(path) {
  try {
    await access(join(path, 'lock'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function statusFor(state, manifest, locked) {
  if (locked) return 'active';
  if (state?.status) return state.status;
  const last = manifest?.phases?.at(-1);
  if (last?.status === 'stalled') return 'stalled';
  if (last?.status === 'completed' && state?.completed?.length) return 'completed';
  return 'unknown';
}

function currentPhase(manifest) {
  return manifest?.phases?.at(-1)?.phase ?? null;
}

async function runInfo(runsDir, name) {
  const dir = join(runsDir, name);
  if (!(await isDirectory(dir))) throw new Error(`Run "${name}" was not found in ${runsDir}.`);
  const [state, manifest, locked] = await Promise.all([
    readJson(join(dir, 'state.json')),
    readJson(join(dir, 'manifest.json')),
    isLocked(dir),
  ]);
  if (!manifest) throw new Error(`Run "${name}" has no manifest.json.`);
  const metrics = computeRunMetrics(manifest);
  return {
    name,
    runId: state?.runId ?? manifest.runId ?? null,
    status: statusFor(state, manifest, locked),
    phase: currentPhase(manifest),
    branch: state?.branch ?? manifest.branch ?? null,
    worktree: state?.worktree ?? manifest.worktree ?? null,
    startedAt: state?.startedAt ?? manifest.startedAt ?? null,
    updatedAt: state?.updatedAt ?? null,
    taskFile: state?.taskFile ?? manifest.taskFile ?? null,
    prUrl: state?.prUrl ?? manifest.prUrl ?? null,
    manifest,
    metrics,
  };
}

export async function resolveRunsDir(cwd, configPath) {
  const repoRoot = await new GitFacade(cwd).toplevel();
  const runsDir = await loadRunsDir(repoRoot, configPath ? resolve(cwd, configPath) : undefined);
  return { repoRoot, runsDir: join(repoRoot, runsDir) };
}

export async function getRunStatus(runsDir, name) {
  const info = await runInfo(runsDir, name);
  return {
    name: info.name,
    runId: info.runId,
    status: info.status,
    phase: info.phase,
    branch: info.branch,
    startedAt: info.startedAt,
    updatedAt: info.updatedAt,
    prUrl: info.prUrl,
    metrics: info.metrics,
  };
}

function inspectRunMetrics(info) {
  return {
    ...getRunStatusFields(info),
    phases: info.manifest.phases ?? [],
    metrics: info.metrics,
  };
}

function getRunStatusFields(info) {
  return {
    name: info.name,
    runId: info.runId,
    status: info.status,
    phase: info.phase,
    branch: info.branch,
    worktree: info.worktree,
    startedAt: info.startedAt,
    updatedAt: info.updatedAt,
    taskFile: info.taskFile,
    prUrl: info.prUrl,
  };
}

export async function listRunStatuses(runsDir, { includeMetrics = false } = {}) {
  const manifests = await readRunManifests(runsDir);
  const statuses = [];
  for (const { name } of manifests) {
    const info = await runInfo(runsDir, name);
    statuses.push({
      ...getRunStatusFields(info),
      ...(includeMetrics ? { metrics: info.metrics } : {}),
    });
  }
  return statuses;
}

export async function getAggregateMetrics(runsDir) {
  const manifests = await readRunManifests(runsDir);
  return computeAggregateMetrics(manifests.map(({ manifest }) => manifest));
}

function formatValue(value) {
  return value === null || value === undefined ? '?' : String(value);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printRunTable(runs, includeMetrics) {
  if (!runs.length) {
    console.log('No runs found.');
    return;
  }
  console.log('NAME  STATUS  PHASE  BRANCH');
  for (const run of runs) {
    const metrics = includeMetrics
      ? `  duration=${run.metrics.total.durationMs}ms tokens=${formatValue(run.metrics.total.tokens)} cost=${formatValue(run.metrics.total.cost)}`
      : '';
    console.log(`${run.name}  ${run.status}  ${run.phase ?? '-'}  ${run.branch ?? '-'}${metrics}`);
  }
}

function printStatus(status) {
  console.log(`${status.name}: ${status.status}`);
  console.log(`phase: ${status.phase ?? '-'}`);
  console.log(`branch: ${status.branch ?? '-'}`);
  console.log(`duration: ${status.metrics.total.durationMs}ms`);
  console.log(`tokens: ${formatValue(status.metrics.total.tokens)}`);
  console.log(`cost: ${formatValue(status.metrics.total.cost)}`);
  console.log(`reviewer catch rate: ${formatValue(status.metrics.reviewer.catchRate)}`);
}

function printAggregate(metrics) {
  console.log(`${metrics.runs} run${metrics.runs === 1 ? '' : 's'}`);
  console.log(`duration: ${metrics.total.durationMs}ms`);
  console.log(`tokens: ${formatValue(metrics.total.tokens)}`);
  console.log(`cost: ${formatValue(metrics.total.cost)}`);
  console.log(`convergence: ${formatValue(metrics.convergence.convergenceRate)}`);
  console.log(`reviewer catch rate: ${formatValue(metrics.reviewer.catchRate)}`);
}

function printInspection(result) {
  console.log(`${result.name}: ${result.status}`);
  for (const phase of result.phases) {
    console.log(`  ${phase.phase}  ${phase.status}  ${phase.durationMs ?? '?'}ms`);
  }
  printAggregate({
    runs: 1,
    total: result.metrics.total,
    convergence: result.metrics.convergence.roundsToConverge === null
      ? { convergenceRate: 0 }
      : { convergenceRate: 1 },
    reviewer: result.metrics.reviewer,
  });
}

// Metrics-focused command dispatch used by the aggregate `metrics` reporting
// and retained for programmatic callers. The operator CLI (bin/loop.mjs) owns
// the run/list/status/inspect/cancel/clean/doctor surface.
export async function runOperationalCommand(args) {
  const { runsDir } = await resolveRunsDir(args.cwd ?? process.cwd(), args.config);
  if (args.command === 'status') {
    if (!args.name) throw new Error('status requires a run name.');
    const result = await getRunStatus(runsDir, args.name);
    if (args.json) printJson(result); else printStatus(result);
    return result;
  }
  if (args.command === 'inspect') {
    if (!args.name) throw new Error('inspect requires a run name.');
    const result = inspectRunMetrics(await runInfo(runsDir, args.name));
    if (args.json) printJson(result); else printInspection(result);
    return result;
  }
  if (args.command === 'list') {
    const result = await listRunStatuses(runsDir, { includeMetrics: args.metrics });
    if (args.json) printJson(result); else printRunTable(result, args.metrics);
    return result;
  }
  if (args.command === 'metrics') {
    const result = await getAggregateMetrics(runsDir);
    if (args.json) printJson(result); else printAggregate(result);
    return result;
  }
  throw new Error(`Unknown command "${args.command}".`);
}

// --- Operational command API (cwd/config based, lock aware) ----------------

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isProcessGroupAlive(groupId) {
  if (process.platform === 'win32' || !Number.isInteger(groupId) || groupId <= 0 || groupId === process.pid) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isActiveProcessAlive({ pid, processGroupId }) {
  return isProcessGroupAlive(processGroupId) || isProcessAlive(pid);
}

async function readLock(runDir) {
  const lockDir = join(runDir, 'lock');
  const activeProcessRecord = await readJson(join(runDir, 'active-command.json'), { optional: true });
  const activeProcessPid = activeProcessRecord?.pid ?? null;
  const activeProcessGroupId = activeProcessRecord?.processGroupId ?? null;
  const activeProcess = { pid: activeProcessPid, processGroupId: activeProcessGroupId };
  let entries;
  try {
    entries = await readdir(lockDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        present: false,
        active: isActiveProcessAlive(activeProcess),
        owner: null,
        activeProcessPid,
        activeProcessGroupId,
      };
    }
    throw error;
  }
  const ownerName = entries.find((entry) => /^owner-\d+-[0-9a-f-]+$/.test(entry));
  if (!ownerName) {
    return {
      present: true,
      active: isActiveProcessAlive(activeProcess),
      owner: null,
      activeProcessPid,
      activeProcessGroupId,
    };
  }
  const owner = await readJson(join(lockDir, ownerName));
  return {
    present: true,
    active: isProcessAlive(owner.pid) || isActiveProcessAlive(activeProcess),
    owner: { ...owner, path: join(lockDir, ownerName) },
    activeProcessPid,
    activeProcessGroupId,
  };
}

function latestEntry(entries, predicate = () => true) {
  return [...entries].reverse().find(predicate) ?? null;
}

function prUrl(value) {
  return typeof value === 'string' ? value.match(PULL_REQUEST_URL)?.[0] ?? null : null;
}

function canonicalPrUrl(state, manifest) {
  const phaseUrls = (manifest.phases ?? []).flatMap((phase) => [
    phase.prUrl,
    phase.pullRequest?.url,
  ]);
  return [
    state.prUrl,
    state.pullRequest?.url,
    manifest.prUrl,
    manifest.pullRequest?.url,
    ...phaseUrls,
  ].map(prUrl).find(Boolean) ?? null;
}

function deriveStatus(data, manifest, lock) {
  if (lock.active) return 'running';
  if (data.status) return data.status;
  if (data.cancelledAt) return 'cancelled';
  const stalled = latestEntry(manifest.phases, (entry) => entry.status === 'stalled');
  if (stalled) return 'stalled';
  if (data.completed?.length) return 'completed';
  return 'unknown';
}

function deriveCurrentPhase(data, phases) {
  if (data.currentPhase) return data.currentPhase;
  return latestEntry(phases, (entry) => entry.status !== 'skipped')?.phase ?? null;
}

function deriveVerdict(data, phases) {
  const entry = latestEntry(phases, (candidate) => candidate.verdict);
  return entry?.verdict?.verdict ?? entry?.verdict ?? data.verdict ?? null;
}

function deriveGateStatus(phases) {
  return latestEntry(phases, (entry) => entry.role === 'gate' || entry.kind === 'gate')?.status ?? null;
}

function summarizeRun(slug, runDir, state, manifest, lock) {
  const phases = manifest.phases ?? [];
  return {
    name: state.name ?? manifest.name ?? slug,
    slug,
    runId: state.runId ?? null,
    status: deriveStatus(state, { phases }, lock),
    branch: state.branch ?? manifest.branch ?? null,
    baseBranch: state.baseBranch ?? manifest.baseBranch ?? null,
    worktree: state.worktree ?? manifest.worktree ?? null,
    repoRoot: state.repoRoot ?? manifest.repoRoot ?? null,
    startedAt: state.startedAt ?? manifest.startedAt ?? null,
    updatedAt: state.updatedAt ?? manifest.updatedAt ?? null,
    currentPhase: deriveCurrentPhase(state, phases),
    verdict: deriveVerdict(state, phases),
    gateStatus: deriveGateStatus(phases),
    prUrl: canonicalPrUrl(state, manifest),
    runDir,
    lock: {
      present: lock.present,
      active: lock.active,
      pid: lock.owner?.pid ?? null,
      activeProcessPid: lock.activeProcessPid,
      activeProcessGroupId: lock.activeProcessGroupId,
    },
  };
}

async function readRun(runsDir, slug) {
  const runDir = join(runsDir, slug);
  const state = await readJson(join(runDir, 'state.json'), { optional: true });
  if (!state) return null;
  const manifest = await readJson(join(runDir, 'manifest.json'), { optional: true }) ?? { phases: [] };
  const lock = await readLock(runDir);
  return {
    summary: summarizeRun(slug, runDir, state, manifest, lock),
    state,
    manifest,
    lock,
  };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadRunsConfig(repoRoot, configPath) {
  const path = configPath ? resolve(configPath) : join(repoRoot, 'loop.config.mjs');
  // Distinguish an absent entry config from a config that exists but fails to
  // import (e.g. a missing local module/package). Only the former may fall back
  // to defaults; a broken config must surface so operational commands do not
  // silently target the wrong runsDir. This mirrors `loadConfig` in config.mjs.
  if (!(await pathExists(path))) {
    if (configPath) throw new Error(`Loop config file does not exist: ${path}`);
    return { ...defaults };
  }
  const configured = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)).default ?? {};
  return { ...defaults, ...configured };
}

async function operationalContext(cwd, configPath, { validate = false } = {}) {
  const rootGit = new GitFacade(cwd);
  const repoRoot = await rootGit.toplevel();
  const config = validate
    ? await loadConfig(repoRoot, {}, configPath ? resolve(cwd, configPath) : undefined)
    : await loadRunsConfig(repoRoot, configPath ? resolve(cwd, configPath) : undefined);
  return { config, repoRoot, rootGit, runsDir: resolve(repoRoot, config.runsDir) };
}

export async function listRuns({ cwd = process.cwd(), configPath } = {}) {
  const context = await operationalContext(cwd, configPath);
  let entries;
  try {
    entries = await readdir(context.runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const run = await readRun(context.runsDir, entry.name);
    if (run) runs.push(run.summary);
  }
  return runs.sort((a, b) => (b.updatedAt ?? b.startedAt ?? '').localeCompare(a.updatedAt ?? a.startedAt ?? ''));
}

export async function getRun(name, { cwd = process.cwd(), configPath } = {}) {
  const slug = slugFor(name);
  if (!slug) throw new Error('A run name is required.');
  const context = await operationalContext(cwd, configPath);
  const run = await readRun(context.runsDir, slug);
  if (!run) throw new Error(`Run "${name}" was not found in ${context.runsDir}.`);
  return run;
}

export async function inspectRun(name, options = {}) {
  const run = await getRun(name, options);
  return {
    ...run.summary,
    state: run.state,
    manifest: run.manifest,
    phases: run.manifest.phases ?? [],
  };
}

export async function cancelRun(name, { cwd = process.cwd(), configPath } = {}) {
  const context = await operationalContext(cwd, configPath);
  const slug = slugFor(name);
  if (!slug) throw new Error('A run name is required.');
  const run = await readRun(context.runsDir, slug);
  if (!run) throw new Error(`Run "${name}" was not found in ${context.runsDir}.`);
  if (!run.lock.active || run.state.status === 'completed') {
    throw new Error(`Run "${name}" is not active and cannot be cancelled.`);
  }

  const cancelledAt = new Date().toISOString();
  let killedPid = null;
  let activeProcess = {
    pid: run.lock.activeProcessPid,
    processGroupId: run.lock.activeProcessGroupId,
  };
  if (!isActiveProcessAlive(activeProcess) && run.lock.owner?.pid && run.lock.owner.pid !== process.pid) {
    activeProcess = await discoverActiveProcess(run.summary.runDir, run.lock.owner.pid);
  }
  if (activeProcess && !await stopProcesses([activeProcess])) {
    throw new Error(`Cancellation timed out for run "${name}"; its lock was retained.`);
  }
  const runnerTargets = [];
  if (run.lock.owner?.pid && run.lock.owner.pid !== process.pid && run.lock.active) {
    killedPid = run.lock.owner.pid;
    runnerTargets.push({ pid: run.lock.owner.pid });
  }
  if (runnerTargets.length && !await stopProcesses(runnerTargets)) {
    throw new Error(`Cancellation timed out for run "${name}"; its lock was retained.`);
  }
  if (!await stopActiveProcessesAfterRunner(run.summary.runDir, runnerTargets[0]?.pid ?? null)) {
    throw new Error(`Cancellation timed out for run "${name}"; its lock was retained.`);
  }

  // No runner can write state after this point, so this record cannot be
  // overwritten by a final command/phase save from the cancelled run.
  const state = await RunState.open(context.runsDir, slug, {}, { resume: true, lock: false });
  await state.record({ status: 'cancelled', cancelledAt, cancelReason: 'cancelled by operator' });

  if (run.lock.owner) {
    await RunState.releaseLock(run.summary.runDir, run.lock.owner);
  } else if (run.lock.present) {
    await rm(join(run.summary.runDir, 'lock'), { recursive: true, force: true });
  }

  const refreshed = await readRun(context.runsDir, slug);
  return { ...refreshed.summary, killedPid, status: 'cancelled' };
}

function ageTimestamp(run) {
  return Date.parse(run.updatedAt ?? run.startedAt ?? '') || 0;
}

function signalProcess(pid, signal) {
  if (!isProcessAlive(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

async function waitForProcessesToStop(targets, timeoutMs) {
  const watched = targets.filter(({ pid, processGroupId }) =>
    (Number.isInteger(processGroupId) && processGroupId > 0 && processGroupId !== process.pid)
    || (Number.isInteger(pid) && pid > 0 && pid !== process.pid));
  const deadline = Date.now() + timeoutMs;
  while (watched.some(isActiveProcessAlive) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !watched.some(isActiveProcessAlive);
}

async function discoverActiveProcess(runDir, runnerPid) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const activeProcess = await readJson(join(runDir, 'active-command.json'), { optional: true });
    if (activeProcess && isActiveProcessAlive(activeProcess)) return activeProcess;
    if (!isProcessAlive(runnerPid)) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return null;
}

async function stopActiveProcessesAfterRunner(runDir, runnerPid) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const activeProcess = await readJson(join(runDir, 'active-command.json'), { optional: true });
    if (activeProcess && isActiveProcessAlive(activeProcess) && !await stopProcesses([activeProcess])) {
      return false;
    }

    const remainingProcess = await readJson(join(runDir, 'active-command.json'), { optional: true });
    const runnerAlive = runnerPid !== null && isProcessAlive(runnerPid);
    if (!runnerAlive && (!remainingProcess || !isActiveProcessAlive(remainingProcess))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

function signalTarget(target, signal) {
  if (process.platform === 'win32') return signalProcessGroup(target.pid, signal);
  if (target.processGroupId && signalProcessGroup(target.processGroupId, signal)) return true;
  return signalProcess(target.pid, signal);
}

async function stopProcesses(targets) {
  const watched = targets.filter(({ pid, processGroupId }) =>
    (Number.isInteger(processGroupId) && processGroupId > 0 && processGroupId !== process.pid)
    || (Number.isInteger(pid) && pid > 0 && pid !== process.pid));
  if (!watched.length) return true;
  for (const target of watched) signalTarget(target, 'SIGTERM');
  if (await waitForProcessesToStop(watched, 1000)) return true;
  for (const target of watched) signalTarget(target, 'SIGKILL');
  return waitForProcessesToStop(watched, 5000);
}

export async function cleanRuns({ cwd = process.cwd(), configPath, olderThanDays = 30, dryRun = false, yes = false } = {}) {
  const context = await operationalContext(cwd, configPath);
  const runs = await listRuns({ cwd, configPath });
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = runs.filter((run) => run.status === 'completed' && ageTimestamp(run) <= cutoff);
  const previewOnly = dryRun || !yes;
  const removed = [];
  const errors = [];

  if (!previewOnly) {
    for (const run of candidates) {
      try {
        if (run.worktree && resolve(run.worktree) !== resolve(context.repoRoot)) {
          await context.rootGit.removeWorktree(run.worktree);
        }
        await rm(run.runDir, { recursive: true, force: true });
        removed.push(run.name);
      } catch (error) {
        errors.push({ name: run.name, error: error.message });
      }
    }
  }

  return {
    olderThanDays,
    cutoff: new Date(cutoff).toISOString(),
    dryRun: previewOnly,
    candidates,
    removed,
    errors,
  };
}

async function checkCommand(command, args, cwd) {
  try {
    await runCommand(command, args, { cwd });
    return { ok: true, detail: `${command} is available` };
  } catch (error) {
    return { ok: false, detail: error.code === 'ENOENT' ? `${command} is not installed` : (error.output || error.message).trim() };
  }
}

export async function doctor({ cwd = process.cwd(), configPath } = {}) {
  const checks = [];
  let context;
  try {
    context = await operationalContext(cwd, configPath, { validate: true });
    checks.push({ name: 'config', ok: true, detail: `loaded ${configPath ?? 'loop.config.mjs (or defaults)'}` });
  } catch (error) {
    checks.push({ name: 'config', ok: false, detail: error.message });
  }

  const repoRoot = context?.repoRoot ?? cwd;
  checks.push({ name: 'git', ...(await checkCommand('git', ['--version'], repoRoot)) });
  if (context) {
    try {
      await context.rootGit.run(['worktree', 'list', '--porcelain']);
      checks.push({ name: 'git worktree', ok: true, detail: 'worktree support is available' });
    } catch (error) {
      checks.push({ name: 'git worktree', ok: false, detail: error.message });
    }
    const agents = new Map();
    for (const phase of context.config.resolvedPhases.flatMap((item) => [item, ...(item.repair ?? [])])) {
      if (phase.kind !== 'agent') continue;
      const agent = agentForPhase(context.config, phase.name);
      agents.set(agent.name, agent);
    }
    for (const [name, agent] of agents) {
      try {
        const command = adapterFor(name, context.config.adapters).command({ prompt: '', cwd: repoRoot, addDirs: [], agent }).command;
        checks.push({ name: `engine ${name}`, ...(await checkCommand(process.platform === 'win32' ? 'where' : 'which', [command], repoRoot)) });
      } catch (error) {
        checks.push({ name: `engine ${name}`, ok: false, detail: error.message });
      }
    }
  }
  checks.push({ name: 'gh auth', ...(await checkCommand('gh', ['auth', 'status'], repoRoot)) });
  return { ok: checks.every((check) => check.ok), checks };
}

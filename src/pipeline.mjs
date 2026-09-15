import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { adapterFor, agentForPhase, permissionLevel, PERMISSIONS, passthroughRenderer, validateAgent } from './adapters.mjs';
import { runCommand } from './command.mjs';
import { loadConfig } from './config.mjs';
import { GitFacade } from './git.mjs';
import { hermeticEnvironment, hermeticInvocation, hermeticSnapshot } from './hermetic.mjs';
import { canonicalizeConfig, hashConfig, hashText } from './manifest.mjs';
import { computeRunMetrics } from './metrics.mjs';
import { publish } from './publish.mjs';
import { renderPrompt } from './prompts.mjs';
import { banner, describeAgent, ensureConfirmationAvailable, log, openTerminalInput, report } from './reporter.mjs';
import { RunState, slugFor } from './state.mjs';
import { runPhases } from './runner.mjs';
import { formatFindings } from './verdict.mjs';
import { planWorktree, resumedWorktree, setupWorktree } from './worktree.mjs';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function buildTaskContext({ task, taskFile }) {
  if (task && taskFile) {
    return `Your task:\n\n${task}\n\nFull details in \`${taskFile}\`.`;
  }
  if (task) {
    return `Your task:\n\n${task}`;
  }
  if (taskFile) {
    return `Your task is described in \`${taskFile}\`.`;
  }
  return '';
}

function overrideSavedEngines(agentSettings, engine, customAdapters) {
  const overrides = {};
  const overriddenSettings = Object.fromEntries(
    Object.entries(agentSettings).map(([phaseName, agent]) => {
      if (agent.name === engine) return [phaseName, agent];
      const overridden = validateAgent({ ...agent, name: engine }, customAdapters);
      overrides[phaseName] = { from: agent, to: overridden };
      return [phaseName, overridden];
    }),
  );
  return { agentSettings: overriddenSettings, overrides };
}

function configOverrideRecord(config, path) {
  const { resolvedPhases, ...values } = config;
  return {
    at: new Date().toISOString(),
    path,
    values,
  };
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function createSourceSnapshot(ctx) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aloop-source-'));
  const snapshot = join(temporaryRoot, 'repo');
  try {
    await runCommand('git', ['clone', '--no-hardlinks', '--no-local', ctx.worktree, snapshot], {
      cwd: temporaryRoot,
      timeoutMs: ctx.config.timeoutMs,
    });
    const snapshotGit = new GitFacade(snapshot);
    if (!(await snapshotGit.localBranchExists(ctx.baseBranch))) {
      await snapshotGit.run(['branch', ctx.baseBranch, await ctx.git.revParse(ctx.baseBranch)]);
    }
    return {
      path: snapshot,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}


async function tee(path, text) {
  await appendFile(path, text);
}

function phaseInvocation(phase, ctx, { command, args, cwd, mounts }) {
  if (!phase.hermetic) {
    return { command, args, env: undefined, policy: { mode: 'host' } };
  }
  return hermeticInvocation({
    settings: phase.hermetic,
    command,
    args,
    cwd,
    mounts,
  });
}

function gitMetadataMount(ctx, mode) {
  if (!ctx.gitCommonDir) return [];
  const relativePath = relative(ctx.worktree, ctx.gitCommonDir);
  const isInsideWorktree = relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  return isInsideWorktree ? [] : [{ path: ctx.gitCommonDir, mode }];
}

function manifestRole(phase) {
  if (phase.verdict) return 'verdict';
  if (phase.kind === 'gate') return 'gate';
  if (phase.kind === 'publish') return 'publish';
  if (phase.role === 'repair') return 'repair';
  return 'agent';
}

function engineRecord(agent) {
  if (!agent) return null;
  return {
    name: agent.name,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
  };
}

function manifestEntry(phase, ctx, values = {}) {
  return {
    phase: phase.name,
    kind: phase.kind,
    role: manifestRole(phase),
    inputSha: null,
    outputSha: null,
    promptHash: null,
    configHash: ctx.configHash,
    artifacts: [],
    gateReceipts: [],
    engine: null,
    status: 'completed',
    durationMs: 0,
    ...values,
  };
}

function budgetUsage(ctx) {
  const total = computeRunMetrics(ctx.state.manifest).total;
  const startedAt = Date.parse(ctx.state.data.startedAt);
  const hasUsageEntries = total.usageCoverage.applicableEntries > 0;
  return {
    tokens: total.tokens ?? (hasUsageEntries ? null : 0),
    usd: total.cost ?? (hasUsageEntries ? null : 0),
    wallClockMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
  };
}

function budgetWarning(ctx, field, message) {
  if (ctx.budgetWarnings.has(field)) return;
  ctx.budgetWarnings.add(field);
  log(`  warning: ${message}`);
}

function budgetStatus(ctx) {
  if (ctx.dryRun) return null;
  const budget = ctx.config.budget;
  if (!budget || !Object.keys(budget).length) return null;

  const usage = budgetUsage(ctx);
  const checks = [
    ['tokens', 'tokens', 'token usage is unavailable; the token budget cannot be enforced.'],
    ['usd', 'usd', 'cost usage is unavailable; the dollar budget cannot be enforced.'],
    ['wallClockMs', 'wallClockMs', 'the run start time is unavailable; the wall-clock budget cannot be enforced.'],
  ];
  for (const [field, label, warning] of checks) {
    if (budget[field] === undefined) continue;
    if (usage[field] === null) {
      budgetWarning(ctx, field, warning);
      continue;
    }
    if (usage[field] >= budget[field]) {
      return {
        reason: `budget exhausted: ${label}`,
        output: `${label} usage ${usage[field]} reached the configured limit ${budget[field]}.`,
        usage: usage[field],
        limit: budget[field],
      };
    }
  }
  return null;
}

function logBudgetStall(budget) {
  log(`  ${budget.reason}; ${budget.output}`);
}

async function recordBudgetStall(ctx, phase, budget) {
  logBudgetStall(budget);
  await recordManifest(ctx, manifestEntry(phase, ctx, {
    status: 'stalled',
    budgetStall: true,
    failure: { reason: budget.reason, usage: budget.usage, limit: budget.limit },
  }));
  return { phase: phase.name, reason: budget.reason, output: budget.output };
}

async function markBudgetExhaustedComplete(state, phase, details = {}) {
  await state.markComplete(phase.name, { ...details, budgetExhausted: true });
}

async function recordManifest(ctx, entry) {
  if (ctx.dryRun) return;
  ctx.state.manifest.append(entry);
  await ctx.state.save();
}

async function markStalledManifest(ctx, phase, result, startIndex) {
  const stalledPhase = result.stalledPhase ?? phase.name;
  const entry = ctx.state.manifest.entries
    .slice(startIndex)
    .findLast((candidate) => candidate.phase === stalledPhase);
  if (entry) {
    entry.status = 'stalled';
    await ctx.state.save();
    return;
  }
  await recordManifest(ctx, manifestEntry(phase, ctx, { status: 'stalled' }));
}

async function runGate(phase, ctx) {
  const commands = phase.commands ?? ctx.config.gate;
  const logFile = ctx.state.logPath(phase.name);
  await tee(logFile, '');
  const started = performance.now();
  const gateReceipts = [];
  const execution = phaseInvocation(phase, ctx, {
    command: ctx.config.shell,
    args: ['-c', commands.join(' && ')],
    cwd: ctx.worktree,
    mounts: [
      { path: ctx.worktree, mode: 'ro' },
      { path: ctx.state.dir, mode: 'rw' },
      ...gitMetadataMount(ctx, 'ro'),
    ],
  });
  for (const command of commands) {
    log(`  $ ${command}`);
    const commandStarted = performance.now();
    try {
      // Gate commands run through a shell on purpose: they are user-authored
      // strings that routinely need quoting, pipes, `&&`, and env vars, and
      // naive whitespace splitting mangles all four without complaining.
      const commandExecution = phaseInvocation(phase, ctx, {
        command: ctx.config.shell,
        args: ['-c', command],
        cwd: ctx.worktree,
        mounts: [
          { path: ctx.worktree, mode: 'ro' },
          { path: ctx.state.dir, mode: 'rw' },
          ...gitMetadataMount(ctx, 'ro'),
        ],
      });
      await runCommand(commandExecution.command, commandExecution.args, {
        cwd: commandExecution.policy.mode === 'host' ? ctx.worktree : undefined,
        env: commandExecution.env,
        timeoutMs: ctx.config.timeoutMs,
        activeProcessPath: ctx.activeProcessPath,
        onOutput: (text) => {
          process.stdout.write(text);
          void tee(logFile, text);
        },
      });
      gateReceipts.push({ command, exitCode: 0, durationMs: Math.round(performance.now() - commandStarted) });
    } catch (error) {
      await tee(logFile, `\n${error.output ?? error.message}\n`);
      gateReceipts.push({
        command,
        exitCode: typeof error.code === 'number' ? error.code : null,
        durationMs: Math.round(performance.now() - commandStarted),
      });
      return {
        ok: false,
        command,
        output: error.output ?? error.message,
        gateReceipts,
        durationMs: Math.round(performance.now() - started),
        execution: execution.policy,
      };
    }
  }
  return { ok: true, gateReceipts, durationMs: Math.round(performance.now() - started), execution: execution.policy };
}

async function runPublish(phase, ctx, { remote, branch, base, approvedSha }) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const inputSha = await ctx.git.revParse();
  const descriptionPath = join(ctx.state.dir, 'pr.md');
  let result;
  let failure = null;
  try {
    result = await publish({
      git: ctx.git,
      remote,
      branch,
      base,
      prBodyPath: descriptionPath,
      draft: ctx.config.publish.draft ?? true,
      backend: ctx.config.publish.backend ?? 'github',
      approvedSha,
      ...(phase.hermetic ? { env: hermeticEnvironment(phase.hermetic) } : {}),
    });
  } catch (error) {
    failure = error;
  }
  const outputSha = await ctx.git.revParse();
  const manifest = manifestEntry(phase, ctx, {
    inputSha,
    outputSha,
    approvedSha,
    artifacts: [
      ...(await fileExists(descriptionPath) ? ['pr.md'] : []),
    ],
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...(result ? {
      remoteSha: result.remoteSha,
      prUrl: result.pullRequest.url,
      pullRequest: result.pullRequest,
      status: 'completed',
    } : {
      status: 'stalled',
      failure: { reason: failure?.message ?? 'publishing failed' },
    }),
  });
  return { ok: Boolean(result), result, manifest, failure };
}

async function withRetries(phase, operation, { failed = () => false } = {}) {
  const maxAttempts = phase.retry?.maxAttempts ?? 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation();
      if (!failed(result)) return result;
      if (attempt === maxAttempts) return result;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
    }
    log(`  ${phase.name} attempt ${attempt}/${maxAttempts} failed; retrying`);
  }
  throw new Error(`Phase "${phase.name}" exhausted its retry policy.`);
}

async function runSetup(commands, ctx) {
  const logFile = ctx.state.logPath('setup');
  for (const command of commands) {
    log(`  $ ${command}`);
    try {
      await runCommand(ctx.config.shell, ['-c', command], {
        cwd: ctx.worktree,
        timeoutMs: ctx.config.timeoutMs,
        activeProcessPath: ctx.activeProcessPath,
        onOutput: (text) => {
          process.stdout.write(text);
          void tee(logFile, text);
        },
      });
    } catch (error) {
      const detail = error.output ?? error.message;
      throw new Error(`Worktree setup failed for \`${command}\`: ${detail}`, { cause: error });
    }
  }
}

async function captureEngineVersions(agentSettings, customAdapters, cwd) {
  const versions = {};
  const engines = new Map(Object.values(agentSettings).map((agent) => [agent.name, agent]));
  for (const [name, agent] of engines) {
    const adapter = adapterFor(name, customAdapters);
    if (!adapter.version) continue;
    try {
      const version = await adapter.version({ agent, cwd });
      if (typeof version === 'string' && version.trim()) versions[name] = version.trim();
    } catch {
      // Version capture is diagnostic context and must not make a run fail.
    }
  }
  return versions;
}

async function captureRunSnapshot({ state, rootGit, baseBranch, branch, config, agentSettings, cwd, worktree }) {
  const capturedAt = new Date().toISOString();
  const gateDefinitions = {
    default: [...config.gate],
    phases: config.resolvedPhases
      .flatMap((phase) => [phase, ...(phase.repair ?? [])])
      .filter((phase) => phase.kind === 'gate')
      .map((phase) => ({ name: phase.name, commands: [...(phase.commands ?? config.gate)] })),
  };
  const configHash = hashConfig(config);
  return {
    snapshotVersion: 1,
    capturedAt,
    runId: state.data.runId,
    baseSha: await rootGit.revParse(baseBranch),
    branch,
    baseBranch,
    resolvedConfig: canonicalizeConfig(config),
    configHash,
    // Prompt context is only fully known when each invocation runs. Keep the
    // immutable snapshot honest by pointing at the manifest's actual hashes.
    promptHashes: {
      source: 'manifest.json',
      selector: 'phases[*].promptHash',
    },
    engineVersions: await captureEngineVersions(agentSettings, config.adapters, worktree),
    aloopVersion: packageJson.version,
    gateDefinitions,
    hermetic: hermeticSnapshot(config),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      timestamp: capturedAt,
    },
    worktree,
    runDirectory: state.dir,
    cwd,
  };
}

async function runAgent(phase, ctx, variables) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const inputSha = ctx.dryRun ? null : await ctx.git.revParse();
  const agent = ctx.agentSettings[phase.name] ?? agentForPhase(ctx.config, phase.name);
  const engineOverride = ctx.engineOverrides[phase.name];
  const adapter = adapterFor(agent.name, ctx.config.adapters);
  const worktreeWrite = permissionLevel(phase.permissions) === PERMISSIONS.WRITE_WORKTREE;
  const artifactOnly = !worktreeWrite;
  const sourceSnapshot = artifactOnly && !ctx.dryRun ? await createSourceSnapshot(ctx) : null;
  const agentRepo = sourceSnapshot?.path ?? ctx.worktree;

  try {
  const { prompt, path } = await renderPrompt(phase.prompt, {
    ...variables,
    ...(sourceSnapshot ? { REPO: agentRepo } : {}),
  }, {
    projectPromptDir: ctx.promptDir,
  });
  const promptHash = hashText(prompt);
  log(`  engine: ${agent.name}${agent.model ? `   model: ${agent.model}` : ''}${agent.effort ? `   effort: ${agent.effort}` : ''}   prompt: ${path}`);
  if (engineOverride) log(`  resumed override: ${describeAgent(engineOverride.from)} → ${describeAgent(engineOverride.to)}`);

  // Every read-only agent starts in the driver-owned artifact directory. The
  // source snapshot is disposable, so an adapter's writable added directories
  // cannot reach the real worktree while the agent can still inspect a Git tree.
  const agentCwd = artifactOnly ? ctx.state.dir : ctx.worktree;
  // Only the verdict phase's prompt is instructed to edit the task file (its
  // Code Review section), so only it is granted the external task-file repo as
  // writable. Every other artifact-only phase — pr-description included — gets
  // just its own run directory; it has no business touching the task file repo.
  const artifactOnlyDirs = phase.role === 'verdict' ? ctx.artifactDirs : [ctx.state.dir];
  const { command, args } = adapter.command({
    prompt,
    cwd: agentCwd,
    addDirs: worktreeWrite ? ctx.addDirs : [...artifactOnlyDirs, ...(sourceSnapshot ? [sourceSnapshot.path] : [])],
    timeoutMs: ctx.config.timeoutMs,
    agent,
    permissions: phase.permissions,
    artifactOnly,
  });
  const execution = phaseInvocation(phase, ctx, {
    command,
    args,
    cwd: agentCwd,
    mounts: [
      { path: ctx.worktree, mode: worktreeWrite ? 'rw' : 'ro' },
      ...(worktreeWrite
        ? ctx.addDirs.filter((path) => path !== ctx.worktree).map((path) => ({ path, mode: 'rw' }))
        : artifactOnlyDirs.map((path) => ({ path, mode: 'rw' }))),
      ...(sourceSnapshot ? [{ path: sourceSnapshot.path, mode: 'ro' }] : []),
      ...gitMetadataMount(ctx, worktreeWrite ? 'rw' : 'ro'),
    ],
  });
  if (ctx.dryRun) {
    log(`  would run: ${[execution.command, ...execution.args].map((value) => JSON.stringify(String(value))).join(' ')}`);
    log(`\n${prompt}\n`);
    return { agent, command, args, execution, dryRun: true };
  }
  const logFile = ctx.state.logPath(phase.name);
  const overrideNote = engineOverride ? ` (resumed override: ${describeAgent(engineOverride.from)} → ${describeAgent(engineOverride.to)})` : '';
  await tee(logFile, `\n=== ${new Date().toISOString()} ${describeAgent(agent)} ${phase.name}${overrideNote} ===\n`);
  // Only stdout carries the engine's structured stream; stderr is already
  // human text and passes through, so a vendor warning is never swallowed.
  const renderer = adapter.createRenderer?.() ?? passthroughRenderer();
  let bytesEmitted = 0;
  const pendingLogWrites = [];
  const emit = (text) => {
    if (!text) return;
    bytesEmitted += Buffer.byteLength(text);
    process.stdout.write(text);
    pendingLogWrites.push(tee(logFile, text));
  };
  let commandError;
  try {
    await runCommand(execution.command, execution.args, {
      cwd: execution.policy.mode === 'host' ? agentCwd : undefined,
      env: execution.env,
      timeoutMs: ctx.config.timeoutMs,
      activeProcessPath: ctx.activeProcessPath,
      onOutput: (text, stream) => emit(stream === 'stderr' ? text : renderer.write(text)),
    });
  } catch (error) {
    commandError = error;
  } finally {
    // A killed or failed run still has a partial line worth reading.
    emit(renderer.end());
    await Promise.all(pendingLogWrites);
  }
  const usage = renderer.usage?.() ?? adapter.usage?.() ?? null;

  const manifest = manifestEntry(phase, ctx, {
    inputSha,
    outputSha: await ctx.git.revParse(),
    promptHash,
    artifacts: [`${phase.name}.log`],
    engine: engineRecord(agent),
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...(usage?.tokens !== undefined ? { tokens: usage.tokens } : {}),
    ...(usage?.cost !== undefined ? { cost: usage.cost } : {}),
    ...(commandError ? {
      status: 'stalled',
      failure: {
        command,
        code: commandError.code ?? null,
        timedOut: Boolean(commandError.timedOut),
      },
    } : {}),
    execution: execution.policy,
    ...(!commandError && phase.name === 'pr-description' && await fileExists(join(ctx.state.dir, 'pr.md'))
      ? { artifacts: [`${phase.name}.log`, 'pr.md'] }
      : {}),
  });
  if (commandError) {
    await recordManifest(ctx, manifest);
    throw commandError;
  }

  return {
    agent,
    bytesEmitted,
    execution: execution.policy,
    manifest,
  };
  } finally {
    await sourceSnapshot?.cleanup();
  }
}

export async function runLoop(options = {}) {
  const { args, confirmInput = null, terminalOpener = openTerminalInput } = options;
  const cwd = args.cwd ?? process.cwd();
  const rootGit = new GitFacade(cwd);
  const repoRoot = await rootGit.toplevel();

  if (args.config && args.overrideEngine) {
    throw new Error('--config and --override-engine cannot be used together; configure engines in the supplied config file.');
  }
  const config = await loadConfig(repoRoot, {
    ...(args.maxRounds ? { maxRounds: args.maxRounds } : {}),
    ...(args.phases ? { phases: args.phases } : {}),
    ...(args.noWorktree ? { worktrees: false } : {}),
  }, args.config ? resolve(cwd, args.config) : undefined);
  if (args.engine && !args.overrideEngine) {
    config.engines.default = validateAgent({ ...config.engines.default, name: args.engine }, config.adapters);
  }
  if (args.overrideEngine && !args.resume) {
    throw new Error('--override-engine requires --resume.');
  }
  if (args.overrideEngine && !args.engine) {
    throw new Error('--override-engine requires --engine <name>.');
  }

  let task = args.task ?? null;
  let rawTaskFile = args.taskFile ?? null;
  let taskFile = rawTaskFile
    ? (rawTaskFile === '-' ? '-' : (isAbsolute(rawTaskFile) ? rawTaskFile : resolve(cwd, rawTaskFile)))
    : null;

  const name = args.name
    ? slugFor(args.name)
    : (taskFile && taskFile !== '-' ? slugFor(taskFile) : null);

  if (!name) {
    throw new Error('A run needs an identity: pass --name <slug>, or --task-file <path> to derive one.');
  }
  const slug = name;
  const configuredBranch = args.branch ?? `${config.branchPrefix}${slug}`;
  const runsDir = join(repoRoot, config.runsDir);
  const state = await RunState.open(
    runsDir,
    slug,
    { task, taskFile: taskFile === '-' ? null : taskFile, name, branch: configuredBranch, repoRoot },
    { readOnly: Boolean(args.dryRun), resume: Boolean(args.resume), lock: !args.dryRun },
  );

  let runStarted = false;
  try {
  const persistedName = args.resume ? state.data.name : null;
  if (persistedName && args.name && slugFor(args.name) !== persistedName) {
    throw new Error(
      `Saved run used identity "${persistedName}"; cannot resume with --name "${args.name}".`,
    );
  }
  const persistedTaskFile = args.resume ? state.data.taskFile : null;
  const taskPathInRunDir = rawTaskFile === '-' ? join(state.dir, 'task.md') : null;
  const intendedTaskFile = taskPathInRunDir ?? taskFile;
  if (persistedTaskFile && intendedTaskFile && intendedTaskFile !== persistedTaskFile) {
    throw new Error(
      `Saved run used task file "${persistedTaskFile}"; cannot resume with --task-file "${intendedTaskFile}".`,
    );
  }
  const persistedTask = args.resume ? state.data.task ?? null : null;
  if (args.resume && args.task != null && args.task !== persistedTask) {
    throw new Error(
      `Saved run used task "${persistedTask ?? ''}"; cannot resume with --task "${args.task}".`,
    );
  }

  if (args.resume) {
    if (!taskFile && persistedTaskFile) taskFile = persistedTaskFile;
    if (task == null && persistedTask != null) task = persistedTask;
  }

  const persistedBranch = args.resume ? state.data.branch : null;
  if (persistedBranch && args.branch && args.branch !== persistedBranch) {
    throw new Error(
      `Saved run used branch "${persistedBranch}"; cannot resume with --branch "${args.branch}". Start a new run instead of resuming with a different branch.`,
    );
  }
  const branch = persistedBranch ?? configuredBranch;
  const persistedBaseBranch = args.resume ? state.data.baseBranch : null;
  if (persistedBaseBranch && args.baseBranch && args.baseBranch !== persistedBaseBranch) {
    throw new Error(
      `Saved run used base branch "${persistedBaseBranch}"; cannot resume with --base-branch "${args.baseBranch}". Start a new run instead of resuming with a different base.`,
    );
  }
  const baseBranch = persistedBaseBranch ?? args.baseBranch ?? config.baseBranch;
  if (args.baseBranch && !(await rootGit.localBranchExists(baseBranch))) {
    throw new Error(`--base-branch "${baseBranch}" does not exist locally. Fetch or check it out first.`);
  }

  if (!args.yes && !args.dryRun) {
    await ensureConfirmationAvailable(confirmInput, terminalOpener);
  }

  if (rawTaskFile === '-') {
    const canReuseMaterializedTask = args.resume
      && state.data.taskFile === taskPathInRunDir
      && await fileExists(taskPathInRunDir);
    if (canReuseMaterializedTask) {
      taskFile = taskPathInRunDir;
    } else {
      const content = await readStdin();
      if (!content || !content.trim()) {
        throw new Error('no data on stdin for --task-file -');
      }
      taskFile = taskPathInRunDir;
      if (!args.dryRun) {
        await writeFile(taskFile, content, 'utf8');
      }
      await state.record({ taskFile });
    }
  }
  await state.record({ status: 'running' });
  runStarted = true;
  const configuredAgentSettings = Object.fromEntries(
    config.resolvedPhases
      .flatMap((phase) => [phase, ...(phase.repair ?? [])])
      .filter((phase) => phase.kind === 'agent')
      .map((phase) => [phase.name, agentForPhase(config, phase.name)]),
  );
  const savedAgentSettings = args.resume && !args.config ? state.data.agentSettings : null;
  if (savedAgentSettings) {
    for (const phaseName of Object.keys(configuredAgentSettings)) {
      if (!savedAgentSettings[phaseName]) {
        throw new Error(`Saved run settings do not include agent phase "${phaseName}"; start a new run instead of resuming with a different phase list.`);
      }
      validateAgent(savedAgentSettings[phaseName], config.adapters);
    }
  }
  let agentSettings = savedAgentSettings ?? configuredAgentSettings;
  let engineOverrides = {};
  if (args.overrideEngine) {
    if (!savedAgentSettings) {
      throw new Error('--override-engine requires saved agent settings from an earlier run.');
    }
    ({ agentSettings, overrides: engineOverrides } = overrideSavedEngines(savedAgentSettings, args.engine, config.adapters));
    if (Object.keys(engineOverrides).length > 0) {
      const engineOverride = {
        at: new Date().toISOString(),
        engine: args.engine,
        phases: engineOverrides,
      };
      await state.record({
        agentSettings,
        engineOverrides: [...(state.data.engineOverrides ?? []), engineOverride],
      });
      log('  resumed engine override:');
      for (const [phaseName, override] of Object.entries(engineOverrides)) {
        log(`    ${phaseName}: ${describeAgent(override.from)} → ${describeAgent(override.to)}`);
      }
    }
  } else if (!savedAgentSettings) {
    const configOverrides = args.resume && args.config
      ? [...(state.data.configOverrides ?? []), configOverrideRecord(config, resolve(cwd, args.config))]
      : state.data.configOverrides;
    await state.record({ agentSettings, ...(configOverrides ? { configOverrides } : {}) });
  }

  const savedWorktree = args.resume
    ? await resumedWorktree(rootGit, repoRoot, branch, state.data.worktree)
    : null;
  const { worktree, created, worktreeCreated } = savedWorktree
    ? { worktree: savedWorktree, created: false, worktreeCreated: false }
    : args.dryRun
      ? { ...(await planWorktree(rootGit, config, slug, branch, repoRoot)), created: false, worktreeCreated: false }
      : await setupWorktree(rootGit, config, slug, branch, repoRoot, baseBranch);
  const worktreeGit = new GitFacade(worktree);
  const hermeticPhaseExists = config.resolvedPhases
    .flatMap((phase) => [phase, ...(phase.repair ?? [])])
    .some((phase) => phase.hermetic);
  const gitCommonDir = args.dryRun || !hermeticPhaseExists
    ? null
    : resolve(worktree, await worktreeGit.commonDir());
  await state.record({ worktree, branch, baseBranch });
  await state.saveManifest({
    runId: state.data.runId,
    name: state.data.name,
    task: task ?? null,
    taskFile,
    branch,
    baseBranch,
    repoRoot,
    worktree,
    snapshot: 'snapshot.json',
  });
  if (args.baseBranch && !created) {
    log(`  note: branch "${branch}" already has a worktree or exists; --base-branch has no effect on this run.`);
  }

  // The agent's writable set: its checkout, the run directory it must write the
  // verdict into, and the task-file directory when the file is outside the
  // agent's checkout. Same-repository task files retain their source path, so
  // their containing directory must be granted explicitly in worktree mode.
  const taskFileGit = taskFile ? new GitFacade(dirname(taskFile)) : null;
  const taskFileRepo = taskFileGit ? await taskFileGit.toplevel().catch(() => null) : null;
  const taskFileAccessDir = taskFileRepo === repoRoot ? dirname(taskFile) : taskFileRepo;

  const artifactDirs = [state.dir];
  if (taskFileAccessDir && !artifactDirs.includes(taskFileAccessDir)) artifactDirs.push(taskFileAccessDir);

  const remote = config.remote ?? (await rootGit.defaultRemote()) ?? 'origin';
  if (config.remote && !(await rootGit.remoteExists(config.remote))) {
    throw new Error(`Configured remote "${config.remote}" does not exist in ${repoRoot}.`);
  }
  const ctx = {
    config,
    worktree,
    gitCommonDir,
    addDirs: [worktree, ...artifactDirs],
    artifactDirs,
    state,
    git: worktreeGit,
    agentSettings,
    engineOverrides,
    budgetWarnings: new Set(),
    configHash: hashConfig(config),
    resume: Boolean(args.resume),
    dryRun: args.dryRun,
    remote,
    baseBranch,
    promptDir: join(repoRoot, config.promptDir),
    activeProcessPath: join(state.dir, 'active-command.json'),
  };

  if (worktreeCreated && !args.dryRun && config.setup.length) {
    log(`setup     : ${config.setup.join(' && ')}`);
    await runSetup(config.setup, ctx);
  }

  const variables = {
    TASK: task ?? '',
    TASK_FILE: taskFile ?? '',
    TASK_NAME: name,
    TASK_DIR: taskFile ? dirname(taskFile) : cwd,
    TASK_CONTEXT: buildTaskContext({ task, taskFile }),
    BRANCH: branch,
    BASE_BRANCH: baseBranch,
    REPO: worktree,
    RUN_DIR: state.dir,
    REMOTE: remote,
    GATE_COMMANDS: config.gate.join('\n') || '(none configured)',
  };

  if (!args.dryRun && !(await state.hasSnapshot())) {
    await state.saveSnapshot(await captureRunSnapshot({
      state,
      rootGit,
      baseBranch,
      branch,
      config,
      agentSettings,
      cwd,
      worktree,
    }));
  }

  log(`task      : ${name}`);
  if (taskFile) log(`task file : ${taskFile}`);
  log(`branch    : ${branch}${created ? ' (created)' : ''}`);
  log(`base      : ${baseBranch}`);
  log(`worktree  : ${worktree}`);
  log(`run dir   : ${state.dir}`);
  log(`phases    : ${config.resolvedPhases.map((phase) => phase.name).join(' → ')}`);

  const summary = {
    phases: [],
    stalled: null,
    branch,
    baseBranch,
    remote,
    worktree,
    runDir: state.dir,
    task: name,
    taskFile,
    prUrl: state.data.prUrl ?? state.manifestMetadata.prUrl ?? null,
    pullRequest: state.data.pullRequest ?? state.manifestMetadata.pullRequest ?? null,
  };

  await runPhases({
    args,
    config,
    state,
    ctx,
    variables,
    summary,
    remote,
    branch,
    baseBranch,
    confirmInput,
    terminalOpener,
    operations: {
      budgetStatus,
      markBudgetExhaustedComplete,
      manifestEntry,
      markStalledManifest,
      recordBudgetStall,
      recordManifest,
      runAgent,
      runGate,
      runPublish,
      withRetries,
    },
  });

  await state.record({
    status: summary.stalled ? 'stalled' : 'completed',
    ...(summary.stalled ? { stalled: summary.stalled } : {}),
  });
  report(summary, formatFindings);
  return summary;

  } catch (error) {
    if (runStarted && !args.dryRun) await state.record({ status: 'stalled' }).catch(() => {});
    throw error;
  } finally {
    await state.release();
  }
}

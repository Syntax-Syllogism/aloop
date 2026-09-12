import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { adapterFor, agentForPhase, passthroughRenderer, validateAgent } from './adapters.mjs';
import { runCommand } from './command.mjs';
import { loadConfig } from './config.mjs';
import { GitFacade } from './git.mjs';
import { renderPrompt } from './prompts.mjs';
import { RunState, slugFor } from './state.mjs';
import { APPROVED, CHANGES_REQUESTED, formatFindings, readVerdict } from './verdict.mjs';

const CODE_PHASES = new Set(['implement', 'address']);

function log(message) {
  console.log(message);
}

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

function banner(text) {
  log(`\n── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}`);
}

function describeAgent(agent) {
  return `${agent.name}${agent.model ? ` model=${agent.model}` : ''}${agent.effort ? ` effort=${agent.effort}` : ''}`;
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

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resumedWorktree(git, repoRoot, branch, savedPath) {
  if (!savedPath) return null;
  if (resolve(savedPath) === resolve(repoRoot)) {
    if (await directoryExists(savedPath)) return savedPath;
  } else {
    const registeredPath = await git.worktreePath(branch);
    if (registeredPath && await directoryExists(registeredPath)) return registeredPath;
  }
  throw new Error(
    `Saved worktree "${savedPath}" for branch "${branch}" is unavailable. Restore it or re-register it with git worktree before resuming.`,
  );
}

function openTerminalInput() {
  return new Promise((resolveInput, rejectInput) => {
    const input = createReadStream('/dev/tty');
    const onOpen = () => {
      input.off('error', onError);
      resolveInput(input);
    };
    const onError = (error) => {
      input.off('open', onOpen);
      input.destroy();
      rejectInput(error);
    };
    input.once('open', onOpen);
    input.once('error', onError);
  });
}

async function ensureConfirmationAvailable(input, terminalOpener) {
  if (input || process.stdin.isTTY) return;
  let terminalInput;
  try {
    terminalInput = await terminalOpener();
  } catch {
    throw new Error('no terminal available to confirm phases; re-run with --yes to run unattended');
  }
  terminalInput.destroy();
}

async function confirm(question, { input = null, terminalOpener = openTerminalInput } = {}) {
  let confirmationInput = input;
  let closeInput = false;
  if (!confirmationInput) {
    if (process.stdin.isTTY) {
      confirmationInput = process.stdin;
    } else {
      try {
        confirmationInput = await terminalOpener();
      } catch {
        throw new Error('no terminal available to confirm phases; re-run with --yes to run unattended');
      }
      closeInput = true;
    }
  }
  const rl = createInterface({ input: confirmationInput, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [Y/n/q] `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'q') return 'quit';
    return normalized === '' || normalized === 'y' ? 'yes' : 'skip';
  } finally {
    rl.close();
    if (closeInput) confirmationInput.destroy();
  }
}

async function tee(path, text) {
  await appendFile(path, text);
}

async function runGate(phase, ctx) {
  const commands = phase.commands ?? ctx.config.gate;
  const logFile = ctx.state.logPath(phase.name);
  for (const command of commands) {
    log(`  $ ${command}`);
    try {
      // Gate commands run through a shell on purpose: they are user-authored
      // strings that routinely need quoting, pipes, `&&`, and env vars, and
      // naive whitespace splitting mangles all four without complaining.
      await runCommand('sh', ['-c', command], {
        cwd: ctx.worktree,
        timeoutMs: ctx.config.timeoutMs,
        onOutput: (text) => {
          process.stdout.write(text);
          void tee(logFile, text);
        },
      });
    } catch (error) {
      await tee(logFile, `\n${error.output ?? error.message}\n`);
      return { ok: false, command, output: error.output ?? error.message };
    }
  }
  return { ok: true };
}

async function runSetup(commands, ctx) {
  const logFile = ctx.state.logPath('setup');
  for (const command of commands) {
    log(`  $ ${command}`);
    try {
      await runCommand('sh', ['-c', command], {
        cwd: ctx.worktree,
        timeoutMs: ctx.config.timeoutMs,
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

function isCodePhase(phase) {
  return CODE_PHASES.has(phase.name);
}

async function noOpReason(phase, result, ctx, { hasFindings = true, headBefore = null } = {}) {
  if (ctx.dryRun || !isCodePhase(phase) || (phase.name === 'address' && !hasFindings)) return null;
  const pending = await ctx.git.status();
  const headChanged = headBefore !== null && headBefore !== (await ctx.git.revParse());
  if (pending || headChanged || (result.bytesEmitted ?? 0) > 0) return null;
  return `${phase.name} produced no changes and no output — the engine likely did nothing. Check ${ctx.state.logPath(phase.name)}.`;
}

async function runAgent(phase, ctx, variables) {
  const agent = ctx.agentSettings[phase.name] ?? agentForPhase(ctx.config, phase.name);
  const engineOverride = ctx.engineOverrides[phase.name];
  const adapter = adapterFor(agent.name, ctx.config.adapters);
  const { prompt, path } = await renderPrompt(phase.prompt, variables, {
    projectPromptDir: ctx.promptDir,
  });
  log(`  engine: ${agent.name}${agent.model ? `   model: ${agent.model}` : ''}${agent.effort ? `   effort: ${agent.effort}` : ''}   prompt: ${path}`);
  if (engineOverride) log(`  resumed override: ${describeAgent(engineOverride.from)} → ${describeAgent(engineOverride.to)}`);

  const { command, args } = adapter.command({
    prompt,
    cwd: ctx.worktree,
    addDirs: ctx.addDirs,
    timeoutMs: ctx.config.timeoutMs,
    agent,
  });
  if (ctx.dryRun) {
    log(`  would run: ${[command, ...args].map((value) => JSON.stringify(String(value))).join(' ')}`);
    log(`\n${prompt}\n`);
    return { agent, command, args, dryRun: true };
  }
  const logFile = ctx.state.logPath(phase.name);
  const overrideNote = engineOverride ? ` (resumed override: ${describeAgent(engineOverride.from)} → ${describeAgent(engineOverride.to)})` : '';
  await tee(logFile, `\n=== ${new Date().toISOString()} ${describeAgent(agent)} ${phase.name}${overrideNote} ===\n`);
  // Only stdout carries the engine's structured stream; stderr is already
  // human text and passes through, so a vendor warning is never swallowed.
  const renderer = adapter.createRenderer?.() ?? passthroughRenderer();
  let bytesEmitted = 0;
  const emit = (text) => {
    if (!text) return;
    bytesEmitted += Buffer.byteLength(text);
    process.stdout.write(text);
    void tee(logFile, text);
  };
  try {
    await runCommand(command, args, {
      cwd: ctx.worktree,
      timeoutMs: ctx.config.timeoutMs,
      onOutput: (text, stream) => emit(stream === 'stderr' ? text : renderer.write(text)),
    });
  } finally {
    // A killed or failed run still has a partial line worth reading.
    emit(renderer.end());
  }
  return { agent, bytesEmitted };
}

function reviewResumePoint(state, phase, resume) {
  if (!resume) return { round: 1, sinceSha: null };

  const pending = state.data.pendingRepairs?.[phase.name];
  if (pending) {
    return {
      atCap: pending.round >= phase.maxRounds,
      pending,
      resumed: true,
      round: pending.round,
      sinceSha: pending.reviewedSha,
    };
  }

  const previousRound = state.data.rounds?.[phase.name] ?? 0;
  const sinceSha = state.data.reviewedShas?.[phase.name]?.[previousRound] ?? null;
  if (!sinceSha) return { round: 1, sinceSha: null };

  return {
    atCap: previousRound >= phase.maxRounds,
    resumed: true,
    round: previousRound + 1,
    sinceSha,
  };
}

async function clearPendingRepair(phase, state) {
  const pendingRepairs = { ...state.data.pendingRepairs };
  delete pendingRepairs[phase.name];
  await state.record({ pendingRepairs });
}

async function runRepairs(phase, ctx, baseVariables, pending) {
  let gateOk = true;
  let gateFailure = null;
  for (let index = pending.nextRepair; index < phase.repair.length; index += 1) {
    const repair = phase.repair[index];
    banner(`${repair.name} (round ${pending.round}${ctx.resume ? ' resume' : ''})`);
    if (repair.kind === 'gate') {
      if (ctx.dryRun) {
        log(`  would run: ${(repair.commands ?? ctx.config.gate).join(' && ')}`);
        gateOk = true;
      } else {
        const result = await runGate(repair, ctx);
        gateOk = result.ok;
        gateFailure = result.ok ? null : `${result.command}\n${result.output}`;
      }
    } else {
      const headBefore = isCodePhase(repair) && !ctx.dryRun ? await ctx.git.revParse() : null;
      const result = await runAgent(repair, ctx, {
        ...baseVariables,
        ROUND: pending.round,
        MAX_ROUNDS: phase.maxRounds,
        VERDICT_FILE: ctx.state.verdictPath(pending.round),
        FINDINGS: formatFindings(pending.verdict.blocking),
        SINCE_SHA: pending.reviewedSha,
        GATE_STATUS: gateOk ? 'passing' : `FAILING\n${gateFailure}`,
      });
      const stalledReason = await noOpReason(repair, result, ctx, {
        hasFindings: pending.verdict?.blocking?.length > 0,
        headBefore,
      });
      if (stalledReason) return { gateOk, gateFailure, stalled: stalledReason, stalledPhase: repair.name };
    }
    await ctx.state.record({
      pendingRepairs: {
        ...ctx.state.data.pendingRepairs,
        [phase.name]: { ...pending, nextRepair: index + 1 },
      },
    });
  }
  await clearPendingRepair(phase, ctx.state);
  return { gateOk, gateFailure };
}

/**
 * Run a verdict phase and its repair phases until the verdict clears.
 *
 * Two guards keep this from spinning: a hard round cap, and a refusal to exit
 * on approval while the last gate re-check was red. Without the second one an
 * agreeable reviewer can wave through a tree that does not build.
 */
async function runVerdictLoop(phase, ctx, baseVariables) {
  const resumePoint = reviewResumePoint(ctx.state, phase, ctx.resume);
  if (resumePoint.atCap) {
    return { verdict: CHANGES_REQUESTED, rounds: phase.maxRounds, stalled: 'round cap reached' };
  }

  let round = resumePoint.round;
  let gateOk = true;
  let gateFailure = null;
  let sinceSha = resumePoint.sinceSha;

  if (resumePoint.pending) {
    const result = await runRepairs(phase, ctx, baseVariables, resumePoint.pending);
    gateOk = result.gateOk;
    gateFailure = result.gateFailure;
    if (result.stalled) {
      return { verdict: CHANGES_REQUESTED, rounds: resumePoint.pending.round, stalled: result.stalled, stalledPhase: result.stalledPhase };
    }
    round += 1;
  } else if (resumePoint.resumed) {
    // Runs created before repair checkpoints existed cannot tell whether address
    // completed, so fail closed by rechecking before asking for another verdict.
    const legacyGate = phase.repair.find((repair) => repair.kind === 'gate' && repair.recheck);
    if (legacyGate) {
      const result = await runRepairs(phase, ctx, baseVariables, {
        round: round - 1,
        reviewedSha: sinceSha,
        verdict: { blocking: [] },
        nextRepair: phase.repair.indexOf(legacyGate),
      });
      gateOk = result.gateOk;
      gateFailure = result.gateFailure;
      if (result.stalled) {
        return { verdict: CHANGES_REQUESTED, rounds: round, stalled: result.stalled, stalledPhase: result.stalledPhase };
      }
    }
  }

  for (;;) {
    const verdictPath = ctx.state.verdictPath(round);
    banner(`${phase.name} (round ${round}/${phase.maxRounds})`);
    await runAgent(phase, ctx, {
      ...baseVariables,
      ROUND: round,
      MAX_ROUNDS: phase.maxRounds,
      VERDICT_FILE: verdictPath,
      SINCE_SHA: sinceSha ?? '(none — review the cumulative branch diff)',
      GATE_STATUS: gateOk ? 'passing' : `FAILING\n${gateFailure}`,
    });

    if (ctx.dryRun) return { verdict: APPROVED, rounds: round, dryRun: true };

    const reviewedSha = await ctx.git.revParse();
    const verdict = await readVerdict(verdictPath);
    const reviewState = {
      rounds: { ...ctx.state.data.rounds, [phase.name]: round },
      reviewedShas: {
        ...ctx.state.data.reviewedShas,
        [phase.name]: {
          ...(ctx.state.data.reviewedShas?.[phase.name] ?? {}),
          [round]: reviewedSha,
        },
      },
    };
    // Checkpoint the owed repair even when this is the final allowed round.
    // The cap stops *this* process below, but the last review's findings are
    // still unaddressed; recording them lets a resume (with a raised cap) run
    // the address phase before re-reviewing, instead of burning a fresh review
    // round on the identical tree. Resuming without raising the cap stays a
    // no-op: reviewResumePoint reports atCap while pending.round >= maxRounds.
    if (verdict.verdict === CHANGES_REQUESTED && phase.repair.length) {
      reviewState.pendingRepairs = {
        ...ctx.state.data.pendingRepairs,
        [phase.name]: { round, reviewedSha, verdict, nextRepair: 0 },
      };
    }
    await ctx.state.record(reviewState);
    sinceSha = reviewedSha;
    log(`\n  verdict: ${verdict.verdict}${verdict.summary ? ` — ${verdict.summary}` : ''}`);

    if (verdict.verdict === APPROVED && gateOk) return { verdict: APPROVED, rounds: round };
    if (verdict.verdict === APPROVED && !gateOk) {
      log('  approval withheld: the gate is still failing.');
      return {
        verdict: CHANGES_REQUESTED,
        rounds: round,
        stalled: 'approval withheld: repair gate remains failing',
        output: gateFailure,
      };
    }
    if (!phase.repair.length) {
      return { verdict: verdict.verdict, rounds: round, stalled: 'no repair phase configured' };
    }
    if (round >= phase.maxRounds) {
      return { verdict: verdict.verdict, rounds: round, stalled: 'round cap reached', findings: verdict.blocking };
    }

    const result = await runRepairs(phase, ctx, baseVariables, ctx.state.data.pendingRepairs[phase.name]);
    gateOk = result.gateOk;
    gateFailure = result.gateFailure;
    if (result.stalled) {
      return { verdict: CHANGES_REQUESTED, rounds: round, stalled: result.stalled, stalledPhase: result.stalledPhase };
    }
    round += 1;
  }
}

async function setupWorktree(git, config, slug, branch, repoRoot, baseBranch) {
  if (!config.worktrees) return { worktree: repoRoot, created: false, worktreeCreated: false };
  const root = config.worktreeRoot
    ? resolve(repoRoot, config.worktreeRoot)
    : join(dirname(repoRoot), '.loop-worktrees');
  await mkdir(root, { recursive: true });
  const existing = await git.worktreePath(branch);
  if (existing) return { worktree: existing, created: false, worktreeCreated: false };
  const path = join(root, slug);
  const result = await git.addWorktree(path, branch, baseBranch);
  return { worktree: path, created: result.created, worktreeCreated: true };
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
    { readOnly: Boolean(args.dryRun) },
  );

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
    : await setupWorktree(rootGit, config, slug, branch, repoRoot, baseBranch);
  const worktreeGit = new GitFacade(worktree);
  await state.record({ worktree, branch, baseBranch });
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

  const addDirs = [state.dir];
  if (taskFileAccessDir && !addDirs.includes(taskFileAccessDir)) addDirs.push(taskFileAccessDir);

  const remote = config.remote ?? (await rootGit.defaultRemote()) ?? 'origin';
  if (config.remote && !(await rootGit.remoteExists(config.remote))) {
    throw new Error(`Configured remote "${config.remote}" does not exist in ${repoRoot}.`);
  }
  const ctx = {
    config,
    worktree,
    addDirs,
    state,
    git: worktreeGit,
    agentSettings,
    engineOverrides,
    resume: Boolean(args.resume),
    dryRun: args.dryRun,
    promptDir: join(repoRoot, config.promptDir),
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

  log(`task      : ${name}`);
  if (taskFile) log(`task file : ${taskFile}`);
  log(`branch    : ${branch}${created ? ' (created)' : ''}`);
  log(`base      : ${baseBranch}`);
  log(`worktree  : ${worktree}`);
  log(`run dir   : ${state.dir}`);
  log(`phases    : ${config.resolvedPhases.map((phase) => phase.name).join(' → ')}`);

  const summary = { phases: [], stalled: null, branch, worktree, runDir: state.dir, task: name, taskFile };

  let startIndex = 0;
  if (args.from) {
    startIndex = config.resolvedPhases.findIndex((phase) => phase.name === args.from);
    if (startIndex < 0) throw new Error(`--from names a phase that is not in the pipeline: ${args.from}`);
  }

  for (const phase of config.resolvedPhases.slice(startIndex)) {
    if (args.resume && state.isComplete(phase.name)) {
      log(`\n── ${phase.name}: already complete, skipping`);
      continue;
    }
    if (!args.yes && !args.dryRun) {
      const answer = await confirm(`\nRun phase "${phase.name}"?`, {
        input: confirmInput,
        terminalOpener,
      });
      if (answer === 'quit') {
        summary.stalled = { phase: phase.name, reason: 'stopped by user' };
        break;
      }
      if (answer === 'skip') {
        log(`  skipped ${phase.name}`);
        continue;
      }
    }

    // A verdict phase prints its own per-round banner.
    if (!phase.verdict) banner(phase.name);

    // A publishing phase must run on a clean tree. This is a deterministic
    // guard, not the agent's job: an earlier phase failing to commit its work
    // leaves the tree dirty, and without this stop the git agent — told the
    // tree is already clean but forbidden from committing — improvises an
    // uncommittable "fix" and spins until its timeout. Unresolved review
    // findings deliberately do NOT block here; a clean tree with open findings
    // is a valid state to resume through docs and git.
    if (phase.requiresCleanTree && !ctx.dryRun) {
      const pending = await ctx.git.status();
      if (pending) {
        log('  worktree is not clean; refusing to run this phase over uncommitted changes.');
        summary.stalled = {
          phase: phase.name,
          reason: 'worktree has uncommitted changes; a publishing phase must run on a clean tree',
          output: pending,
        };
        break;
      }
    }

    if (phase.kind === 'gate') {
      if (ctx.dryRun) {
        log(`  would run: ${(phase.commands ?? config.gate).join(' && ')}`);
        continue;
      }
      const result = await runGate(phase, ctx);
      if (!result.ok) {
        summary.stalled = { phase: phase.name, reason: `gate failed: ${result.command}`, output: result.output };
        break;
      }
      await state.markComplete(phase.name);
      summary.phases.push({ name: phase.name, ok: true });
      continue;
    }

    if (phase.verdict) {
      const result = await runVerdictLoop(phase, ctx, variables);
      summary.phases.push({ name: phase.name, rounds: result.rounds, verdict: result.verdict });
      if (result.stalled) {
        summary.stalled = {
          phase: result.stalledPhase ?? phase.name,
          reason: result.stalled,
          findings: result.findings,
          rounds: result.rounds,
          output: result.output,
        };
        break;
      }
      await state.markComplete(phase.name, { rounds: result.rounds });
      continue;
    }

    const headBefore = isCodePhase(phase) && !ctx.dryRun ? await ctx.git.revParse() : null;
    const result = await runAgent(phase, ctx, variables);
    const stalledReason = await noOpReason(phase, result, ctx, { headBefore });
    if (stalledReason) {
      log(`  ${stalledReason}`);
      summary.stalled = { phase: phase.name, reason: stalledReason };
      break;
    }
    await state.markComplete(phase.name);
    summary.phases.push({ name: phase.name, ok: true });
  }

  report(summary);
  return summary;
}

function report(summary) {
  banner('summary');
  for (const phase of summary.phases) {
    const detail = phase.rounds ? ` (${phase.rounds} round${phase.rounds === 1 ? '' : 's'}, ${phase.verdict})` : '';
    log(`  ✓ ${phase.name}${detail}`);
  }
  if (!summary.stalled) {
    log(`\nPipeline finished. Branch ${summary.branch} is ready.`);
    log(`Logs: ${summary.runDir}`);
    return;
  }
  log(`\n  ✗ stalled in "${summary.stalled.phase}": ${summary.stalled.reason}`);
  if (summary.stalled.findings?.length) {
    log(`\nOutstanding blocking findings:\n${formatFindings(summary.stalled.findings)}`);
  }
  if (summary.stalled.output) log(`\n${summary.stalled.output.trim().split('\n').slice(-20).join('\n')}`);
  log(`\nWorktree: ${summary.worktree}`);
  log(`Logs:     ${summary.runDir}`);
  const resumeArgs = [`--name ${summary.task}`];
  if (summary.taskFile && summary.taskFile !== join(summary.runDir, 'task.md')) {
    resumeArgs.push(`--task-file ${summary.taskFile}`);
  }
  log(`Resume:   aloop ${resumeArgs.join(' ')} --resume`);
  process.exitCode = 1;
}

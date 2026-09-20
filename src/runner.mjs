/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Operations} Operations */
/** @typedef {import('./types.js').RunState} RunState */
/** @typedef {import('./types.js').Summary} Summary */

import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { codePhasePostcondition, hasPostcondition, phaseIsSkippable, publishingAttestation } from './policy.mjs';
import { banner, confirm, log } from './reporter.mjs';
import { APPROVED, CHANGES_REQUESTED, formatFindings, readVerdict } from './verdict.mjs';

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function clearVerdict(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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

function requiresCommitBaseline(phase) {
  return hasPostcondition(phase, 'head-advanced') || hasPostcondition(phase, 'head-advanced-or-rebuttal');
}

async function phaseHeadBefore(phase, ctx) {
  if (ctx.dryRun) return null;
  if (requiresCommitBaseline(phase)) {
    return ctx.state.baselineFor(phase.name, () => ctx.git.revParse());
  }
  if (hasPostcondition(phase, 'head-unchanged')) return ctx.git.revParse();
  return null;
}

async function invalidateGateCompletion(state, reviewedSha) {
  const gate = state.manifest.entries.findLast((entry) => entry.role === 'gate'
    && entry.status === 'completed'
    && entry.outputSha === reviewedSha);
  if (!gate || !state.data.completed.includes(gate.phase)) return;
  await state.record({ completed: state.data.completed.filter((name) => name !== gate.phase) });
}

function phaseAndRepairNames(phase) {
  return [phase.name, ...(phase.repair ?? []).flatMap(phaseAndRepairNames)];
}

async function invalidateFollowingPhaseState(state, phases, phaseName) {
  const phaseIndex = phases.findIndex((phase) => phase.name === phaseName);
  if (phaseIndex < 0) return;
  const invalidatedNames = new Set(phases.slice(phaseIndex).flatMap(phaseAndRepairNames));

  const completed = state.data.completed.filter((name) => !invalidatedNames.has(name));
  const phaseState = Object.fromEntries(
    Object.entries(state.data.phases ?? {}).filter(([name]) => !invalidatedNames.has(name)),
  );
  const pendingRepairs = Object.fromEntries(
    Object.entries(state.data.pendingRepairs ?? {}).filter(([name]) => !invalidatedNames.has(name)),
  );
  const rounds = Object.fromEntries(
    Object.entries(state.data.rounds ?? {}).filter(([name]) => !invalidatedNames.has(name)),
  );
  const reviewedShas = Object.fromEntries(
    Object.entries(state.data.reviewedShas ?? {}).filter(([name]) => !invalidatedNames.has(name)),
  );
  const phaseBaselines = Object.fromEntries(
    Object.entries(state.data.phaseBaselines ?? {}).filter(([name]) => !invalidatedNames.has(name)),
  );
  await state.record({ completed, phases: phaseState, pendingRepairs, rounds, reviewedShas, phaseBaselines });
}

async function runRepairs(phase, ctx, baseVariables, pending, operations, { retainCheckpoint = false } = {}) {
  const {
    budgetStatus, manifestEntry, recordBudgetStall, recordManifest, runAgent, runGate, withRetries,
  } = operations;
  let gateOk = pending.gateOk ?? true;
  let gateFailure = pending.gateFailure ?? null;
  for (let index = pending.nextRepair; index < phase.repair.length; index += 1) {
    const repair = phase.repair[index];
    const budget = budgetStatus(ctx);
    if (budget) {
      await recordBudgetStall(ctx, repair, budget);
      return {
        gateOk,
        gateFailure,
        stalled: budget.reason,
        stalledPhase: repair.name,
        output: budget.output,
        budgetStall: true,
      };
    }
    banner(`${repair.name} (round ${pending.round}${ctx.resume ? ' resume' : ''})`);
    if (repair.kind === 'gate') {
      if (ctx.dryRun) {
        log(`  would run: ${(repair.commands ?? ctx.config.gate).join(' && ')}`);
        gateOk = true;
      } else {
        const startedAt = new Date().toISOString();
        const inputSha = await ctx.git.revParse();
        const result = await withRetries(repair, () => runGate(repair, ctx), { failed: (attempt) => !attempt.ok });
        gateOk = result.ok;
        gateFailure = result.ok ? null : `${result.command}\n${result.output}`;
        await recordManifest(ctx, manifestEntry(repair, ctx, {
          inputSha,
          outputSha: await ctx.git.revParse(),
          round: pending.round,
          artifacts: [`${repair.name}.log`],
          gateReceipts: result.gateReceipts,
          execution: result.execution,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          status: result.ok ? 'completed' : 'stalled',
        }));
      }
    } else {
      const headBefore = await phaseHeadBefore(repair, ctx);
      const forceNotedRepair = ctx.resume && ctx.note?.targetPhase === phase.name;
      if (!ctx.dryRun && ctx.resume && requiresCommitBaseline(repair) && !forceNotedRepair) {
        const stalledReason = await codePhasePostcondition(repair, ctx, {
          hasFindings: pending.verdict?.blocking?.length > 0,
          headBefore,
          round: pending.round,
        });
        if (!stalledReason) {
          const outputSha = await ctx.git.revParse();
          const responsePath = join(ctx.state.dir, `response-round-${pending.round}.md`);
          await recordManifest(ctx, manifestEntry(repair, ctx, {
            inputSha: headBefore,
            outputSha,
            round: pending.round,
            artifacts: [
              ...(await fileExists(responsePath) ? [`response-round-${pending.round}.md`] : []),
            ],
            status: 'completed',
          }));
          await ctx.state.record({
            pendingRepairs: {
              ...ctx.state.data.pendingRepairs,
              [phase.name]: { ...pending, nextRepair: index + 1 },
            },
          });
          continue;
        }
      }
      const repairCtx = ctx.note?.targetPhase === phase.name
        ? { ...ctx, note: { ...ctx.note, repairPhase: repair.name } }
        : ctx;
      const result = await withRetries(repair, () => runAgent(repair, repairCtx, {
        ...baseVariables,
        ROUND: pending.round,
        MAX_ROUNDS: phase.maxRounds,
        VERDICT_FILE: ctx.state.verdictPath(pending.round),
        FINDINGS: formatFindings(pending.verdict?.blocking ?? []),
        SINCE_SHA: pending.reviewedSha,
        GATE_STATUS: gateOk ? 'passing' : `FAILING\n${gateFailure}`,
      }));
      const stalledReason = await codePhasePostcondition(repair, ctx, {
        hasFindings: pending.verdict?.blocking?.length > 0,
        headBefore,
        round: pending.round,
      });
      if (!ctx.dryRun) {
        const responsePath = join(ctx.state.dir, `response-round-${pending.round}.md`);
        const artifacts = [
          ...result.manifest.artifacts,
          ...(await fileExists(responsePath) ? [`response-round-${pending.round}.md`] : []),
        ];
        await recordManifest(ctx, {
          ...result.manifest,
          round: pending.round,
          artifacts,
          status: stalledReason ? 'stalled' : 'completed',
        });
      }
      if (stalledReason) return { gateOk, gateFailure, stalled: stalledReason, stalledPhase: repair.name };
    }
    await ctx.state.record({
      pendingRepairs: {
        ...ctx.state.data.pendingRepairs,
        [phase.name]: { ...pending, nextRepair: index + 1 },
      },
    });
  }
  if (!retainCheckpoint) await clearPendingRepair(phase, ctx.state);
  return { gateOk, gateFailure };
}

async function runGateAttempt(phase, ctx, operations, options = {}) {
  const { round } = /** @type {any} */ (options);
  const { manifestEntry, recordManifest, runGate, withRetries } = operations;
  const startedAt = new Date().toISOString();
  const inputSha = await ctx.git.revParse();
  const result = await withRetries(phase, () => runGate(phase, ctx), { failed: (attempt) => !attempt.ok });
  await recordManifest(ctx, manifestEntry(phase, ctx, {
    inputSha,
    outputSha: await ctx.git.revParse(),
    artifacts: [`${phase.name}.log`],
    gateReceipts: result.gateReceipts,
    execution: result.execution,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    status: result.ok ? 'completed' : 'stalled',
    ...(round === undefined ? {} : { round }),
  }));
  return result;
}

async function runGateRepairLoop(phase, ctx, variables, operations) {
  let result = null;
  let pending = ctx.resume ? ctx.state.data.pendingRepairs?.[phase.name] : null;
  let round = pending?.round ?? 1;

  while (round <= phase.maxRounds) {
    if (pending) {
      result = {
        ok: false,
        command: phase.name,
        output: pending.gateFailure ?? '',
      };
      const repairResult = await runRepairs(phase, ctx, variables, pending, operations, { retainCheckpoint: true });
      if (repairResult.stalled) {
        return { result, stalled: repairResult.stalled, stalledPhase: repairResult.stalledPhase, budgetStall: repairResult.budgetStall };
      }
      // The checkpoint's repairs have completed, so re-gate deliberately before
      // deciding whether another repair round is needed.
      result = await runGateAttempt(phase, ctx, operations, { round });
      if (result.ok) {
        await clearPendingRepair(phase, ctx.state);
        return { result };
      }
      pending = null;
      round += 1;
      continue;
    }

    result ??= await runGateAttempt(phase, ctx, operations);
    if (result.ok) return { result };

    pending = {
      round,
      reviewedSha: await ctx.git.revParse(),
      verdict: { blocking: [] },
      gateOk: false,
      gateFailure: `${result.command}\n${result.output}`,
      nextRepair: 0,
    };
    await ctx.state.record({
      pendingRepairs: { ...ctx.state.data.pendingRepairs, [phase.name]: pending },
    });
  }
  return { result };
}

/**
 * Run a verdict phase and its repair phases until the verdict clears.
 *
 * Two guards keep this from spinning: a hard round cap, and a refusal to exit
 * on approval while the last gate re-check was red. Without the second one an
 * agreeable reviewer can wave through a tree that does not build.
 */
async function runVerdictLoop(phase, ctx, baseVariables, operations) {
  const { budgetStatus, recordBudgetStall, recordManifest, runAgent, withRetries } = operations;
  const resumePoint = reviewResumePoint(ctx.state, phase, ctx.resume);
  if (resumePoint.atCap) {
    return { verdict: CHANGES_REQUESTED, rounds: phase.maxRounds, stalled: 'round cap reached' };
  }

  let round = resumePoint.round;
  let gateOk = true;
  let gateFailure = null;
  let sinceSha = resumePoint.sinceSha;

  if (resumePoint.pending) {
    const result = await runRepairs(phase, ctx, baseVariables, resumePoint.pending, operations);
    gateOk = result.gateOk;
    gateFailure = result.gateFailure;
    if (result.stalled) {
      return {
        verdict: CHANGES_REQUESTED,
        rounds: resumePoint.pending.round,
        stalled: result.stalled,
        stalledPhase: result.stalledPhase,
        budgetStall: result.budgetStall,
      };
    }
    round += 1;
  } else if (resumePoint.resumed) {
    const legacyGate = phase.repair.find((repair) => repair.kind === 'gate' && repair.recheck);
    if (legacyGate) {
      const result = await runRepairs(phase, ctx, baseVariables, {
        round: round - 1,
        reviewedSha: sinceSha,
        verdict: { blocking: [] },
        nextRepair: phase.repair.indexOf(legacyGate),
      }, operations);
      gateOk = result.gateOk;
      gateFailure = result.gateFailure;
      if (result.stalled) {
        return {
          verdict: CHANGES_REQUESTED,
          rounds: round,
          stalled: result.stalled,
          stalledPhase: result.stalledPhase,
          budgetStall: result.budgetStall,
        };
      }
    }
  }

  for (;;) {
    const budget = budgetStatus(ctx);
    if (budget) {
      const stalled = await recordBudgetStall(ctx, phase, budget);
      return {
        verdict: CHANGES_REQUESTED,
        rounds: Math.max(0, round - 1),
        stalled: stalled.reason,
        stalledPhase: stalled.phase,
        output: stalled.output,
        budgetStall: true,
      };
    }
    const verdictPath = ctx.state.verdictPath(round);
    banner(`${phase.name} (round ${round}/${phase.maxRounds})`);
    const reviewStatusBefore = ctx.dryRun ? null : await ctx.git.status();
    const attempt = await withRetries(phase, async () => {
      if (!ctx.dryRun) await clearVerdict(verdictPath);
      const agentResult = await runAgent(phase, ctx, {
        ...baseVariables,
        ROUND: round,
        MAX_ROUNDS: phase.maxRounds,
        VERDICT_FILE: verdictPath,
        SINCE_SHA: sinceSha ?? '(none — review the cumulative branch diff)',
        GATE_STATUS: gateOk ? 'passing' : `FAILING\n${gateFailure}`,
      });
      if (ctx.dryRun) return { verdict: { verdict: APPROVED, blocking: [] }, agentResult };
      return { verdict: await readVerdict(verdictPath), agentResult };
    });

    if (ctx.dryRun) return { verdict: APPROVED, rounds: round, dryRun: true };

    const { verdict, agentResult } = attempt;
    const reviewInputSha = agentResult.manifest.inputSha;
    const reviewedSha = agentResult.manifest.outputSha;
    const reviewStatusAfter = await ctx.git.status();
    if (reviewInputSha !== reviewedSha || reviewStatusBefore !== reviewStatusAfter) {
      const reason = reviewInputSha !== reviewedSha
        ? `review phase advanced HEAD from ${reviewInputSha} to ${reviewedSha}; review changes must be gated and reviewed in a later round`
        : 'review phase changed files in the worktree; review must leave the worktree unchanged';
      if (reviewInputSha !== reviewedSha) await invalidateGateCompletion(ctx.state, reviewInputSha);
      await recordManifest(ctx, {
        ...agentResult.manifest,
        status: 'stalled',
        failure: { reason },
      });
      return {
        verdict: CHANGES_REQUESTED,
        rounds: round,
        stalled: reason,
        output: `review input SHA: ${reviewInputSha}\nreview output SHA: ${reviewedSha}`,
      };
    }
    const reviewPath = join(ctx.state.dir, `review-round-${round}.md`);
    await recordManifest(ctx, {
      ...agentResult.manifest,
      round,
      artifacts: [
        ...agentResult.manifest.artifacts,
        ...(await fileExists(reviewPath) ? [`review-round-${round}.md`] : []),
        `verdict-round-${round}.json`,
      ],
      verdict: { ...verdict, sha: reviewedSha },
    });
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

    const result = await runRepairs(phase, ctx, baseVariables, ctx.state.data.pendingRepairs[phase.name], operations);
    gateOk = result.gateOk;
    gateFailure = result.gateFailure;
    if (result.stalled) {
      return {
        verdict: CHANGES_REQUESTED,
        rounds: round,
        stalled: result.stalled,
        stalledPhase: result.stalledPhase,
        budgetStall: result.budgetStall,
      };
    }
    round += 1;
  }
}

/**
 * Drive phase descriptors using operations supplied by the composition root.
 *
 * @param {{
 *   args: Record<string, any>, config: Config, state: RunState, ctx: any,
 *   variables: Record<string, unknown>, summary: Summary, remote: string,
 *   branch: string, baseBranch: string, confirmInput: any,
 *   terminalOpener: any, operations: Operations,
 * }} input
 */
export async function runPhases({
  args, config, state, ctx, variables, summary, remote, branch, baseBranch,
  confirmInput, terminalOpener, operations,
}) {
  const {
    budgetStatus, markBudgetExhaustedComplete, manifestEntry, markStalledManifest,
    recordBudgetStall, recordManifest, runAgent, runGate, runPublish, withRetries,
  } = operations;
  let startIndex = 0;
  if (args.from) {
    startIndex = config.resolvedPhases.findIndex((phase) => phase.name === args.from);
    if (startIndex < 0) throw new Error(`--from names a phase that is not in the pipeline: ${args.from}`);
  }

  const phasesToRun = config.resolvedPhases.slice(startIndex);
  const noteTarget = args.from ?? (args.resume
    ? phasesToRun.find((phase) => !state.isComplete(phase.name))?.name
    : phasesToRun[0]?.name);
  if (ctx.note) {
    const target = config.resolvedPhases.find((phase) => phase.name === noteTarget);
    if (!target) throw new Error('--note needs a phase to run; use --from to target a completed phase.');
    const hasAgentRepair = target.kind === 'gate' && target.repair?.some((repair) => repair.kind === 'agent');
    if (target.kind !== 'agent' && !hasAgentRepair) {
      throw new Error(`--note cannot target ${target.kind} phase "${target.name}" without an agent repair phase.`);
    }
    ctx.note = { ...ctx.note, targetPhase: target.name };
  }
  for (const [phaseIndex, phase] of phasesToRun.entries()) {
    const isFinalPhase = phaseIndex === phasesToRun.length - 1;
    const forceNotedPhase = args.resume && args.from === phase.name && ctx.note?.targetPhase === phase.name;
    if (args.resume && state.data.phases?.[phase.name]?.budgetExhausted && !forceNotedPhase) {
      const budget = budgetStatus(ctx);
      if (budget) {
        summary.stalled = await recordBudgetStall(ctx, phase, budget);
        break;
      }
      log(`\n── ${phase.name}: completed before budget exhaustion, finalizing`);
      await state.markComplete(phase.name, { ...state.data.phases[phase.name], budgetExhausted: false });
      summary.phases.push({ name: phase.name, ok: true });
      continue;
    }
    if (args.resume && state.isComplete(phase.name) && !forceNotedPhase) {
      log(`\n── ${phase.name}: already complete, skipping`);
      await recordManifest(ctx, manifestEntry(phase, ctx, { status: 'skipped' }));
      continue;
    }
    if (!ctx.dryRun) {
      const budget = budgetStatus(ctx);
      if (budget) {
        summary.stalled = await recordBudgetStall(ctx, phase, budget);
        break;
      }
    }
    if (!args.yes && !args.dryRun) {
      let refusedRequiredSkip = false;
      let skipPhase = false;
      while (true) {
        const answer = await confirm(`\nRun phase "${phase.name}"?`, { input: confirmInput, terminalOpener });
        if (answer === 'yes') break;
        if (answer === 'quit') {
          await recordManifest(ctx, manifestEntry(phase, ctx, { status: 'stalled' }));
          summary.stalled = { phase: phase.name, reason: refusedRequiredSkip ? 'required phase not run (skipped by user)' : 'stopped by user' };
          break;
        }
        if (phaseIsSkippable(phase)) {
          log(`  skipped ${phase.name}`);
          skipPhase = true;
          break;
        }
        refusedRequiredSkip = true;
        log(`  ${phase.name} is required and cannot be skipped; run it or quit.`);
      }
      if (summary.stalled) break;
      if (skipPhase) {
        await recordManifest(ctx, manifestEntry(phase, ctx, { status: 'skipped' }));
        continue;
      }
    }
    if (forceNotedPhase) {
      await invalidateFollowingPhaseState(state, config.resolvedPhases, phase.name);
    }
    if (!phase.verdict) banner(phase.name);
    if (phase.requiresCleanTree && !ctx.dryRun) {
      const pending = await ctx.git.status();
      if (pending) {
        log('  worktree is not clean; refusing to run this phase over uncommitted changes.');
        const sha = await ctx.git.revParse();
        await recordManifest(ctx, manifestEntry(phase, ctx, { inputSha: sha, outputSha: sha, status: 'stalled' }));
        summary.stalled = { phase: phase.name, reason: 'worktree has uncommitted changes; a publishing phase must run on a clean tree', output: pending };
        break;
      }
      if (phase.kind === 'publish') {
        const currentSha = await ctx.git.revParse();
        const attestation = publishingAttestation(state, currentSha);
        if (attestation) {
          log(`  ${attestation.reason}; refusing to publish.`);
          await recordManifest(ctx, manifestEntry(phase, ctx, { inputSha: currentSha, outputSha: currentSha, approvedSha: attestation.approvedSha, status: 'stalled' }));
          summary.stalled = { phase: phase.name, reason: `${attestation.reason}; publishing requires the approved SHA`, output: `approved SHA: ${attestation.approvedSha ?? '(none)'}\ncurrent HEAD: ${attestation.currentSha}` };
          break;
        }
      }
    }
    if (phase.kind === 'publish') {
      if (ctx.dryRun) {
        log(`  would push ${remote}/${branch} and create a ${ctx.config.publish.draft ? 'draft ' : ''}PR to ${baseBranch}`);
        continue;
      }
      const approvedSha = await ctx.git.revParse();
      const result = await withRetries(phase, () => runPublish(phase, ctx, { remote, branch, base: baseBranch, approvedSha }), { failed: (attempt) => !attempt.ok });
      await recordManifest(ctx, result.manifest);
      if (!result.ok) {
        summary.stalled = { phase: phase.name, reason: `publish failed: ${result.failure?.message ?? 'unverified publish result'}` };
        break;
      }
      summary.prUrl = result.result.pullRequest.url;
      summary.pullRequest = result.result.pullRequest;
      await state.record({ prUrl: summary.prUrl, pullRequest: summary.pullRequest });
      await state.saveManifest({ prUrl: summary.prUrl, pullRequest: summary.pullRequest });
      await state.markComplete(phase.name);
      summary.phases.push({ name: phase.name, ok: true, prUrl: summary.prUrl, number: summary.pullRequest.number });
      continue;
    }
    if (phase.kind === 'gate') {
      if (ctx.dryRun) {
        log(`  would run: ${(phase.commands ?? config.gate).join(' && ')}`);
        continue;
      }
      if (phase.repair?.length) {
        const repaired = await runGateRepairLoop(phase, ctx, variables, operations);
        if (repaired.stalled) {
          if (!repaired.budgetStall) {
            await markStalledManifest(ctx, phase, repaired, state.manifest.entries.length - 1);
          }
          summary.stalled = {
            phase: repaired.stalledPhase ?? phase.name,
            reason: repaired.stalled,
            output: repaired.result.output,
          };
          break;
        }
        if (!repaired.result.ok) {
          summary.stalled = { phase: phase.name, reason: `gate failed: ${repaired.result.command}`, output: repaired.result.output };
          break;
        }
      } else {
        const result = await runGateAttempt(phase, ctx, operations);
        if (!result.ok) {
          summary.stalled = { phase: phase.name, reason: `gate failed: ${result.command}`, output: result.output };
          break;
        }
      }
      if (isFinalPhase) {
        const budget = budgetStatus(ctx);
        if (budget) {
          summary.stalled = await recordBudgetStall(ctx, phase, budget);
          await markBudgetExhaustedComplete(state, phase);
          break;
        }
      }
      await state.markComplete(phase.name);
      summary.phases.push({ name: phase.name, ok: true });
      continue;
    }
    if (phase.verdict) {
      const manifestStart = state.manifest.entries.length;
      const result = await runVerdictLoop(phase, ctx, variables, operations);
      summary.phases.push({ name: phase.name, rounds: result.rounds, verdict: result.verdict });
      if (result.stalled) {
        if (!result.budgetStall) await markStalledManifest(ctx, phase, result, manifestStart);
        summary.stalled = { phase: result.stalledPhase ?? phase.name, reason: result.stalled, findings: result.findings, rounds: result.rounds, output: result.output };
        break;
      }
      if (isFinalPhase) {
        const budget = budgetStatus(ctx);
        if (budget) {
          summary.stalled = await recordBudgetStall(ctx, phase, budget);
          await markBudgetExhaustedComplete(state, phase, { rounds: result.rounds });
          break;
        }
      }
      await state.markComplete(phase.name, { rounds: result.rounds });
      continue;
    }
    const headBefore = await phaseHeadBefore(phase, ctx);
    if (!ctx.dryRun && args.resume && requiresCommitBaseline(phase) && !forceNotedPhase) {
      const stalledReason = await codePhasePostcondition(phase, ctx, { headBefore });
      if (!stalledReason) {
        const outputSha = await ctx.git.revParse();
        log(`  ${phase.name} already satisfies its commit postcondition; skipping agent on resume`);
        await recordManifest(ctx, manifestEntry(phase, ctx, {
          inputSha: headBefore,
          outputSha,
          status: 'completed',
        }));
        await state.markComplete(phase.name);
        summary.phases.push({ name: phase.name, ok: true });
        continue;
      }
    }
    const result = await withRetries(phase, () => runAgent(phase, ctx, variables));
    const stalledReason = await codePhasePostcondition(phase, ctx, { headBefore });
    if (stalledReason) {
      log(`  ${stalledReason}`);
      await recordManifest(ctx, { ...result.manifest, status: 'stalled' });
      summary.stalled = { phase: phase.name, reason: stalledReason };
      break;
    }
    await recordManifest(ctx, result.manifest);
    if (isFinalPhase) {
      const budget = budgetStatus(ctx);
      if (budget) {
        summary.stalled = await recordBudgetStall(ctx, phase, budget);
        await markBudgetExhaustedComplete(state, phase);
        break;
      }
    }
    await state.markComplete(phase.name);
    summary.phases.push({ name: phase.name, ok: true });
  }
}

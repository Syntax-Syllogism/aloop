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

async function invalidateGateCompletion(state, reviewedSha) {
  const gate = state.manifest.entries.findLast((entry) => entry.role === 'gate'
    && entry.status === 'completed'
    && entry.outputSha === reviewedSha);
  if (!gate || !state.data.completed.includes(gate.phase)) return;
  await state.record({ completed: state.data.completed.filter((name) => name !== gate.phase) });
}

async function runRepairs(phase, ctx, baseVariables, pending, operations) {
  const {
    budgetStatus, manifestEntry, recordBudgetStall, recordManifest, runAgent, runGate, withRetries,
  } = operations;
  let gateOk = true;
  let gateFailure = null;
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
      const headBefore = !ctx.dryRun && (hasPostcondition(repair, 'head-advanced') || hasPostcondition(repair, 'head-advanced-or-rebuttal'))
        ? await ctx.git.revParse()
        : null;
      const result = await withRetries(repair, () => runAgent(repair, ctx, {
        ...baseVariables,
        ROUND: pending.round,
        MAX_ROUNDS: phase.maxRounds,
        VERDICT_FILE: ctx.state.verdictPath(pending.round),
        FINDINGS: formatFindings(pending.verdict.blocking),
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

/** Drive phase descriptors using operations supplied by the composition root. */
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
  for (const [phaseIndex, phase] of phasesToRun.entries()) {
    const isFinalPhase = phaseIndex === phasesToRun.length - 1;
    if (args.resume && state.data.phases?.[phase.name]?.budgetExhausted) {
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
    if (args.resume && state.isComplete(phase.name)) {
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
      const startedAt = new Date().toISOString();
      const inputSha = await ctx.git.revParse();
      const result = await withRetries(phase, () => runGate(phase, ctx), { failed: (attempt) => !attempt.ok });
      await recordManifest(ctx, manifestEntry(phase, ctx, {
        inputSha, outputSha: await ctx.git.revParse(), artifacts: [`${phase.name}.log`],
        gateReceipts: result.gateReceipts, startedAt, completedAt: new Date().toISOString(),
        execution: result.execution,
        durationMs: result.durationMs, status: result.ok ? 'completed' : 'stalled',
      }));
      if (!result.ok) {
        summary.stalled = { phase: phase.name, reason: `gate failed: ${result.command}`, output: result.output };
        break;
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
    const headBefore = !ctx.dryRun && (hasPostcondition(phase, 'head-advanced') || hasPostcondition(phase, 'head-advanced-or-rebuttal') || hasPostcondition(phase, 'head-unchanged'))
      ? await ctx.git.revParse() : null;
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

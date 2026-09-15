import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePullRequestDescription } from './publish.mjs';
import { APPROVED } from './verdict.mjs';

export function hasPostcondition(phase, name) {
  return phase.postconditions?.includes(name) ?? false;
}

export function phaseIsSkippable(phase) {
  return phase.optional && !phase.verdict && phase.kind !== 'gate';
}

export async function codePhasePostcondition(phase, ctx, {
  hasFindings = true,
  headBefore = null,
  round = null,
} = {}) {
  if (ctx.dryRun) return null;
  const logPath = ctx.state.logPath(phase.name);
  if (hasPostcondition(phase, 'clean-tree') && await ctx.git.status()) {
    return `${phase.name} left uncommitted changes; the reviewer inspects base...HEAD and will not see them. Commit the work. Check ${logPath}.`;
  }
  if (hasPostcondition(phase, 'pr-description-valid')) {
    try {
      parsePullRequestDescription(await readFile(join(ctx.state.dir, 'pr.md'), 'utf8'));
    } catch (error) {
      const reason = error.code === 'ENOENT' ? 'file is missing' : error.message;
      return `${phase.name} did not produce a valid pr.md (${reason}). Check ${logPath}.`;
    }
  }
  const requiresHeadAdvance = hasPostcondition(phase, 'head-advanced');
  const permitsRebuttal = hasPostcondition(phase, 'head-advanced-or-rebuttal');
  const requiresHeadUnchanged = hasPostcondition(phase, 'head-unchanged');
  const headChanged = (requiresHeadAdvance || permitsRebuttal || requiresHeadUnchanged)
    && headBefore !== null && headBefore !== (await ctx.git.revParse());
  if (requiresHeadAdvance && !headChanged) return `${phase.name} produced no commit. Commit the work. Check ${logPath}.`;
  if (requiresHeadUnchanged && headChanged) return `${phase.name} changed HEAD from ${headBefore} to ${await ctx.git.revParse()}; it may only write the PR description. Check ${logPath}.`;
  if (!permitsRebuttal || headChanged || !hasFindings) return null;
  const rebuttalPath = round === null ? null : join(ctx.state.dir, `response-round-${round}.md`);
  try {
    if (rebuttalPath && (await stat(rebuttalPath)).isFile()) return null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return `${phase.name} produced no fix commit and no rebuttal recorded. Commit the fix or record a rebuttal. Check ${logPath}.`;
}

function latestApprovedReview(state) {
  const index = state.manifest.entries.findLastIndex((entry) => entry.role === 'verdict' && entry.status !== 'skipped');
  const entry = index === -1 ? null : state.manifest.entries[index];
  if (entry?.status !== 'completed' || entry.verdict?.verdict !== APPROVED || typeof entry.verdict.sha !== 'string') return null;
  return { index, sha: entry.verdict.sha };
}

export function publishingAttestation(state, currentSha) {
  const approved = latestApprovedReview(state);
  if (!approved) return { approvedSha: null, currentSha, reason: `current HEAD ${currentSha} has no completed approval from a review phase` };
  if (approved.sha !== currentSha) return { approvedSha: approved.sha, currentSha, reason: `current HEAD ${currentSha} does not match the approved review SHA ${approved.sha}` };
  const gatePassed = state.manifest.entries.slice(0, approved.index).some((entry) => entry.role === 'gate' && entry.status === 'completed' && entry.outputSha === approved.sha);
  if (!gatePassed) return { approvedSha: approved.sha, currentSha, reason: `approved review SHA ${approved.sha} has no passing gate receipt preceding its review` };
  return null;
}

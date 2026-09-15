import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function entriesFrom(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest?.entries)) return manifest.entries;
  return Array.isArray(manifest?.phases) ? manifest.phases : [];
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumKnown(entries, field) {
  if (!entries.length || entries.some((entry) => finiteNumber(entry[field]) === null)) return null;
  return entries.reduce((total, entry) => total + entry[field], 0);
}

function isUsageApplicable(entry) {
  return !entry.budgetStall && entry.kind !== 'gate' && entry.role !== 'gate';
}

function usageCoverage(entries) {
  const applicableEntries = entries.filter(isUsageApplicable);
  const tokensReported = applicableEntries.filter((entry) => finiteNumber(entry.tokens) !== null).length;
  const costReported = applicableEntries.filter((entry) => finiteNumber(entry.cost) !== null).length;
  return {
    applicableEntries: applicableEntries.length,
    tokensReported,
    costReported,
    tokenCoverage: applicableEntries.length ? tokensReported / applicableEntries.length : null,
    costCoverage: applicableEntries.length ? costReported / applicableEntries.length : null,
  };
}

function roundFor(entry) {
  if (Number.isInteger(entry.round) && entry.round > 0) return entry.round;
  const artifact = (entry.artifacts ?? []).find((path) => /verdict-round-\d+\.json$/.test(path));
  const match = artifact?.match(/verdict-round-(\d+)\.json$/);
  return match ? Number(match[1]) : null;
}

function phaseSummary(name, entries) {
  const attempts = entries.filter((entry) => entry.status !== 'skipped');
  const stalled = attempts.filter((entry) => entry.status === 'stalled').length;
  return {
    phase: name,
    entries: entries.length,
    attempts: attempts.length,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    stalled,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
    stallRate: attempts.length ? stalled / attempts.length : 0,
    durationMs: attempts.reduce((total, entry) => total + (finiteNumber(entry.durationMs) ?? 0), 0),
    tokens: sumKnown(attempts, 'tokens'),
    cost: sumKnown(attempts, 'cost'),
  };
}

function usageTotals(entries) {
  const applicableEntries = entries.filter(isUsageApplicable);
  return {
    durationMs: entries.reduce((total, entry) => total + (finiteNumber(entry.durationMs) ?? 0), 0),
    tokens: sumKnown(applicableEntries, 'tokens'),
    cost: sumKnown(applicableEntries, 'cost'),
    usageCoverage: usageCoverage(entries),
  };
}

function reviewerMetrics(entries) {
  const rounds = entries
    .filter((entry) => entry.verdict && (entry.role === 'verdict' || entry.verdict.verdict))
    .sort((a, b) => (roundFor(a) ?? Number.MAX_SAFE_INTEGER) - (roundFor(b) ?? Number.MAX_SAFE_INTEGER));
  const approvals = rounds.filter((entry) => entry.verdict.verdict === 'APPROVED').length;
  const caught = rounds.filter((entry) => entry.verdict.verdict === 'CHANGES_REQUESTED').length;
  let findingsCleared = 0;
  let repairRounds = 0;
  for (let index = 0; index < rounds.length - 1; index += 1) {
    const before = rounds[index].verdict.blocking?.length ?? 0;
    const after = rounds[index + 1].verdict.blocking?.length ?? 0;
    if (before > 0) {
      repairRounds += 1;
      findingsCleared += Math.max(0, before - after);
    }
  }
  return {
    rounds: rounds.length,
    approvals,
    changesRequested: caught,
    catchRate: rounds.length ? caught / rounds.length : null,
    findingsCleared,
    repairRounds,
    findingsClearedPerRound: repairRounds ? findingsCleared / repairRounds : null,
  };
}

function convergenceMetrics(entries, reviewer) {
  const reviewRounds = entries
    .filter((entry) => entry.verdict && (entry.role === 'verdict' || entry.verdict.verdict))
    .map(roundFor)
    .filter((round) => round !== null);
  const approval = entries
    .filter((entry) => entry.verdict?.verdict === 'APPROVED')
    .map(roundFor)
    .filter((round) => round !== null)
    .sort((a, b) => a - b)[0] ?? null;
  const distribution = {};
  if (approval !== null) distribution[approval] = 1;
  return {
    roundsToConverge: approval,
    roundsToApproval: approval,
    roundsObserved: reviewRounds.length || reviewer.rounds,
    approved: approval !== null,
    roundsToApprovalDistribution: distribution,
  };
}

/** Compute run-level cost, convergence, and reviewer metrics from one manifest. */
export function computeRunMetrics(manifest) {
  const entries = entriesFrom(manifest);
  const names = [...new Set(entries.map((entry) => entry.phase).filter(Boolean))];
  const phases = Object.fromEntries(names.map((name) => [
    name,
    phaseSummary(name, entries.filter((entry) => entry.phase === name)),
  ]));
  const totalEntries = entries.filter((entry) => entry.status !== 'skipped');
  const total = usageTotals(totalEntries);
  const reviewer = reviewerMetrics(entries);
  return {
    total,
    phases,
    phaseMetrics: phases,
    convergence: convergenceMetrics(entries, reviewer),
    reviewer,
    stalled: names.filter((name) => phases[name].stalled > 0),
  };
}

function aggregatePhase(name, summaries) {
  const attempts = summaries.reduce((total, summary) => total + summary.attempts, 0);
  const stalled = summaries.reduce((total, summary) => total + summary.stalled, 0);
  return {
    phase: name,
    entries: summaries.reduce((total, summary) => total + summary.entries, 0),
    attempts,
    completed: summaries.reduce((total, summary) => total + summary.completed, 0),
    stalled,
    skipped: summaries.reduce((total, summary) => total + summary.skipped, 0),
    stallRate: attempts ? stalled / attempts : 0,
    durationMs: summaries.reduce((total, summary) => total + summary.durationMs, 0),
    tokens: summaries.every((summary) => summary.tokens !== null)
      ? summaries.reduce((total, summary) => total + summary.tokens, 0)
      : null,
    cost: summaries.every((summary) => summary.cost !== null)
      ? summaries.reduce((total, summary) => total + summary.cost, 0)
      : null,
  };
}

function aggregateUsageCoverage(runMetrics) {
  const coverage = runMetrics.reduce((totals, metrics) => ({
    applicableEntries: totals.applicableEntries + metrics.total.usageCoverage.applicableEntries,
    tokensReported: totals.tokensReported + metrics.total.usageCoverage.tokensReported,
    costReported: totals.costReported + metrics.total.usageCoverage.costReported,
  }), { applicableEntries: 0, tokensReported: 0, costReported: 0 });
  return {
    ...coverage,
    tokenCoverage: coverage.applicableEntries ? coverage.tokensReported / coverage.applicableEntries : null,
    costCoverage: coverage.applicableEntries ? coverage.costReported / coverage.applicableEntries : null,
  };
}

/** Compute cross-run aggregates from manifest objects or raw phase arrays. */
export function computeAggregateMetrics(manifests) {
  const runMetrics = manifests.map((manifest) => computeRunMetrics(manifest));
  const phaseNames = [...new Set(runMetrics.flatMap((metrics) => Object.keys(metrics.phases)))];
  const phases = Object.fromEntries(phaseNames.map((name) => [
    name,
    aggregatePhase(name, runMetrics.map((metrics) => metrics.phases[name]).filter(Boolean)),
  ]));
  const converged = runMetrics.filter((metrics) => metrics.convergence.roundsToConverge !== null);
  const distribution = {};
  for (const metrics of converged) {
    const round = metrics.convergence.roundsToConverge;
    distribution[round] = (distribution[round] ?? 0) + 1;
  }
  const reviewer = {
    rounds: runMetrics.reduce((total, metrics) => total + metrics.reviewer.rounds, 0),
    approvals: runMetrics.reduce((total, metrics) => total + metrics.reviewer.approvals, 0),
    changesRequested: runMetrics.reduce((total, metrics) => total + metrics.reviewer.changesRequested, 0),
    findingsCleared: runMetrics.reduce((total, metrics) => total + metrics.reviewer.findingsCleared, 0),
    repairRounds: runMetrics.reduce((total, metrics) => total + metrics.reviewer.repairRounds, 0),
  };
  reviewer.catchRate = reviewer.rounds ? reviewer.changesRequested / reviewer.rounds : null;
  reviewer.findingsClearedPerRound = reviewer.repairRounds
    ? reviewer.findingsCleared / reviewer.repairRounds
    : null;
  return {
    runs: runMetrics.length,
    total: {
      durationMs: runMetrics.reduce((total, metrics) => total + metrics.total.durationMs, 0),
      tokens: runMetrics.every((metrics) => metrics.total.tokens !== null)
        ? runMetrics.reduce((total, metrics) => total + metrics.total.tokens, 0)
        : null,
      cost: runMetrics.every((metrics) => metrics.total.cost !== null)
        ? runMetrics.reduce((total, metrics) => total + metrics.total.cost, 0)
        : null,
      usageCoverage: aggregateUsageCoverage(runMetrics),
    },
    phases,
    phaseMetrics: phases,
    convergence: {
      runs: runMetrics.length,
      converged: converged.length,
      stalled: runMetrics.length - converged.length,
      convergenceRate: runMetrics.length ? converged.length / runMetrics.length : null,
      roundsToApprovalDistribution: distribution,
      roundsToConvergeDistribution: distribution,
      averageRoundsToConverge: converged.length
        ? converged.reduce((total, metrics) => total + metrics.convergence.roundsToConverge, 0) / converged.length
        : null,
    },
    reviewer,
    runMetrics,
  };
}

export async function readRunManifest(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Unable to read manifest in ${runDir}: ${error.message}`, { cause: error });
  }
}

export async function readRunManifests(runsDir) {
  let directories;
  try {
    directories = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = await readRunManifest(join(runsDir, directory.name));
    if (manifest) runs.push({ name: directory.name, manifest });
  }
  return runs;
}

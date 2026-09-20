/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').PhaseDescriptor} PhaseDescriptor */

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PERMISSIONS, validateAgent } from './adapters.mjs';
import { normalizeHermeticConfig, resolvePhaseHermetic } from './hermetic.mjs';

// Monotonic counter that makes every config import URL unique. `Date.now()`
// alone has millisecond granularity, so two loadConfig calls of the same file
// within one millisecond (routine on fast CI runners) would otherwise reuse the
// cached module and miss a rewritten config on disk.
let configImportCounter = 0;

const defaults = {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  // Null means "detect", which prefers `origin`. Set this explicitly in any
  // repo with several remotes — pushing a feature branch to the wrong one is
  // not something the run can undo for you.
  remote: null,
  adapters: {},
  engines: { default: { name: 'claude' } },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  publish: { backend: 'github', draft: true },
  gate: [],
  // Commands run once in a newly created worktree before the first phase.
  // An empty list keeps the generic runner package-manager agnostic.
  setup: [],
  // Shell used for user-authored setup and gate commands.
  shell: 'sh',
  maxRounds: 3,
  // Per-command budget. An implement phase on a real work item routinely
  // runs past half an hour; a cap that tight kills healthy runs mid-edit.
  timeoutMs: 60 * 60 * 1000,
  // Optional run-level ceilings. Unknown usage is retained as unknown by the
  // metrics layer and is never silently treated as zero by budget checks.
  budget: {},
  worktrees: true,
  worktreeRoot: null,
  promptDir: '.loop/prompts',
  runsDir: '.loop/runs',
  // Container execution is opt-in per phase. These are inherited defaults,
  // not an instruction to run every phase in a container.
  hermetic: {
    runtime: 'docker',
    image: null,
    network: [],
    env: [],
    secrets: [],
  },
};

/**
 * Built-in phase descriptors.
 *
 * A verdict owns its repair transition explicitly. The string phase list stays
 * supported as a shorthand, but adjacency no longer creates a transition.
 */
const builtinPhases = {
  implement: {
    kind: 'agent',
    prompt: 'implement',
    inputs: ['task'],
    outputs: ['commit'],
    postconditions: ['clean-tree', 'head-advanced'],
    permissions: [PERMISSIONS.WRITE_WORKTREE],
    retry: { maxAttempts: 1 },
  },
  gate: {
    kind: 'gate',
    inputs: ['worktree'],
    outputs: ['gate-result'],
    postconditions: ['gate-passes'],
    permissions: [PERMISSIONS.READ_ONLY],
    retry: { maxAttempts: 1 },
  },
  review: {
    kind: 'agent',
    prompt: 'review',
    verdict: true,
    role: 'verdict',
    inputs: ['commit', 'gate-result'],
    outputs: ['verdict'],
    postconditions: ['verdict-recorded'],
    permissions: [PERMISSIONS.READ_ONLY],
    retry: { maxAttempts: 1 },
    repair: ['address', { name: 'gate', recheck: true }],
  },
  address: {
    kind: 'agent',
    prompt: 'address',
    role: 'repair',
    inputs: ['verdict'],
    outputs: ['commit', 'rebuttal'],
    postconditions: ['clean-tree', 'head-advanced-or-rebuttal'],
    permissions: [PERMISSIONS.WRITE_WORKTREE],
    retry: { maxAttempts: 1 },
  },
  docs: {
    kind: 'agent',
    prompt: 'docs',
    optional: true,
    inputs: ['commit'],
    outputs: ['commit'],
    permissions: [PERMISSIONS.WRITE_WORKTREE],
    retry: { maxAttempts: 1 },
  },
  // The description agent may only author the run-dir PR description. The
  // driver owns all remote mutations in the following publish phase.
  'pr-description': {
    kind: 'agent',
    prompt: 'pr-description',
    requiresCleanTree: true,
    inputs: ['commit'],
    outputs: ['pull-request-description'],
    postconditions: ['clean-tree', 'head-unchanged', 'pr-description-valid'],
    permissions: [PERMISSIONS.READ_ONLY],
    retry: { maxAttempts: 1 },
  },
  publish: {
    kind: 'publish',
    requiresCleanTree: true,
    inputs: ['pull-request-description'],
    outputs: ['pull-request'],
    postconditions: ['remote-matches', 'pull-request-verified'],
    permissions: [PERMISSIONS.PUBLISH],
    retry: { maxAttempts: 1 },
  },
};

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function toPhase(entry, index) {
  if (typeof entry === 'string') {
    const builtin = builtinPhases[entry];
    if (!builtin) throw new Error(`Unknown phase "${entry}"; define it as an object to add a custom phase.`);
    entry = { name: entry };
  }
  if (!entry?.name) throw new Error(`Phase at position ${index} is missing a name.`);
  const builtin = builtinPhases[entry.name] ?? {};
  const phase = { optional: false, ...builtin, ...entry };
  // Only an explicit boolean true permits skipping a custom phase. This keeps
  // configuration typos such as `optional: 'false'` required by default.
  phase.optional = phase.optional === true;
  if (!['agent', 'gate', 'publish'].includes(phase.kind)) {
    throw new Error(`Phase "${phase.name}" needs kind "agent", "gate", or "publish".`);
  }
  if (phase.kind === 'agent' && !phase.prompt) phase.prompt = phase.name;
  for (const field of ['inputs', 'outputs', 'postconditions', 'permissions']) {
    if (phase[field] === undefined) phase[field] = [];
    if (!Array.isArray(phase[field]) || phase[field].some((value) => typeof value !== 'string')) {
      throw new Error(`Phase "${phase.name}" has invalid ${field}; expected an array of strings.`);
    }
  }
  if (phase.permissions.some((permission) => !Object.values(PERMISSIONS).includes(permission))) {
    throw new Error(`Phase "${phase.name}" has invalid permissions; expected ${Object.values(PERMISSIONS).join(', ')}.`);
  }
  if (phase.permissions.length === 0) {
    phase.permissions = [phase.kind === 'publish' ? PERMISSIONS.PUBLISH : PERMISSIONS.READ_ONLY];
  }
  if (phase.retry === undefined) phase.retry = { maxAttempts: 1 };
  if (!phase.retry || typeof phase.retry !== 'object' || Array.isArray(phase.retry)) {
    throw new Error(`Phase "${phase.name}" has an invalid retry descriptor.`);
  }
  phase.retry = { maxAttempts: 1, ...phase.retry };
  if (!Number.isInteger(phase.retry.maxAttempts) || phase.retry.maxAttempts < 1) {
    throw new Error(`Phase "${phase.name}" has an invalid retry.maxAttempts; expected a positive integer.`);
  }
  return phase;
}

/**
 * Normalize phase descriptors and their explicit repair transitions.
 *
 * Legacy lists such as `[gate, review, address]` continue to work because the
 * built-in review descriptor names `address` and the gate recheck explicitly.
 * A custom verdict phase must declare its own `repair` list; merely placing a
 * repair phase after it no longer changes control flow.
 */
/** @returns {PhaseDescriptor[]} */
export function normalizePhases(entries, { maxRounds }) {
  const list = entries.map(toPhase);
  const phaseIndexes = new Map();
  list.forEach((phase, index) => {
    if (!phaseIndexes.has(phase.name)) phaseIndexes.set(phase.name, index);
  });
  const consumedRepairs = new Set();

  function resolveRepair(reference, parentName, index, { allowMissing = false } = {}) {
    const referenceName = typeof reference === 'string' ? reference : reference?.name;
    const sourceIndex = referenceName ? phaseIndexes.get(referenceName) : undefined;
    if (sourceIndex === undefined && allowMissing) return null;
    const source = sourceIndex === undefined
      ? (referenceName ? builtinPhases[referenceName] : null)
      : list[sourceIndex];
    if (sourceIndex === undefined && !source && typeof reference === 'string') {
      throw new Error(`Phase "${parentName}" references unknown repair phase "${referenceName}".`);
    }
    const descriptor = typeof reference === 'string'
      ? { name: referenceName, ...source }
      : { name: referenceName, ...source, ...reference };
    const repair = toPhase(descriptor, index);
    if (sourceIndex !== undefined && list[sourceIndex].role === 'repair') consumedRepairs.add(sourceIndex);
    if (repair.verdict) {
      throw new Error(`Phase "${parentName}" cannot repair verdict phase "${repair.name}".`);
    }
    return repair;
  }

  for (let index = 0; index < list.length; index += 1) {
    const phase = list[index];
    if (!phase.verdict && !(phase.kind === 'gate' && phase.repair)) continue;
    const repair = phase.repair ?? [];
    if (!Array.isArray(repair)) {
      throw new Error(`Phase "${phase.name}" has an invalid repair transition; expected an array.`);
    }
    phase.maxRounds = phase.maxRounds ?? phase.retry.maxRounds ?? maxRounds;
    const allowMissing = phase.repair === builtinPhases[phase.name]?.repair;
    const resolvedRepair = repair
      .map((reference, repairIndex) => resolveRepair(reference, phase.name, repairIndex, { allowMissing }))
      .filter(Boolean);
    const hasRepairTransition = resolvedRepair.some((repairPhase) => !repairPhase.recheck);
    phase.repair = resolvedRepair.filter((repairPhase) => !repairPhase.recheck || hasRepairTransition);
  }

  const result = [];
  for (let index = 0; index < list.length; index += 1) {
    const phase = list[index];
    if (phase.role === 'repair' && !consumedRepairs.has(index)) {
      throw new Error(`Phase "${phase.name}" is a repair phase and must be declared by a phase that emits a verdict or gate repair transition.`);
    }
    if (!consumedRepairs.has(index)) result.push(phase);
  }
  return result;
}

function assertPublishablePhaseOrder(resolvedPhases) {
  const isPublishingPhase = (phase) => phase.kind === 'publish'
    || phase.requiresCleanTree === true
    || phase.outputs.includes('pull-request')
    || phase.outputs.includes('pull-request-description');
  let violation;

  for (let publishingIndex = 0; publishingIndex < resolvedPhases.length; publishingIndex += 1) {
    if (!isPublishingPhase(resolvedPhases[publishingIndex])) continue;

    const verdictIndex = resolvedPhases.findLastIndex((phase, index) => index < publishingIndex
      && (phase.role === 'verdict' || phase.verdict === true));
    if (verdictIndex === -1) continue;

    const offenders = resolvedPhases
      .slice(verdictIndex + 1, publishingIndex)
      .filter((phase) => phase.outputs.includes('commit'))
      .map((phase) => phase.name);
    if (!offenders.length) continue;

    violation = { verdictIndex, publishingIndex, offenders };
  }

  if (violation) {
    const { verdictIndex, publishingIndex, offenders } = violation;
    throw new Error(
      `Phase order publishes an unreviewed tree: ${offenders.join(', ')} `
      + `commit${offenders.length > 1 ? 's' : ''} after the `
      + `"${resolvedPhases[verdictIndex].name}" verdict but before `
      + `"${resolvedPhases[publishingIndex].name}" publishes. A commit after `
      + `approval advances HEAD off the approved SHA and stalls publishing. Move `
      + `${offenders.join(', ')} before the gate/review loop `
      + `(e.g. ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish']).`,
    );
  }
}

function normalizeAgent(entry, phaseName, customAdapters) {
  const agent = typeof entry === 'string' ? { name: entry } : entry;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error(`Engine "${phaseName}" must be a name string or descriptor object.`);
  }
  if (typeof agent.name !== 'string' || !agent.name) {
    throw new Error(`Engine "${phaseName}" is missing a non-empty name.`);
  }
  if (agent.model !== undefined && (typeof agent.model !== 'string' || !agent.model)) {
    throw new Error(`Engine "${phaseName}" has an invalid model; expected a non-empty string.`);
  }
  if (agent.effort !== undefined && (typeof agent.effort !== 'string' || !agent.effort)) {
    throw new Error(`Engine "${phaseName}" has an invalid effort; expected a non-empty string.`);
  }
  return validateAgent(
    { name: agent.name, ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) },
    customAdapters,
  );
}

function normalizeEngines(engines, customAdapters) {
  if (!engines || typeof engines !== 'object' || Array.isArray(engines)) {
    throw new Error('`engines` must be an object with a `default` entry.');
  }
  const normalized = Object.fromEntries(
    Object.entries(engines).map(([phaseName, entry]) => [phaseName, normalizeAgent(entry, phaseName, customAdapters)]),
  );
  if (!normalized.default) throw new Error('`engines` must define a `default` entry.');
  return normalized;
}

function normalizeBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new Error('`budget` must be an object with optional tokens, usd, and wallClockMs limits.');
  }
  const normalized = {};
  for (const field of ['tokens', 'usd', 'wallClockMs']) {
    const value = budget[field];
    if (value === undefined) continue;
    const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (field !== 'tokens' || Number.isInteger(value));
    if (!valid) {
      const kind = field === 'tokens' ? 'a nonnegative integer' : 'a nonnegative finite number';
      throw new Error(`\`budget.${field}\` must be ${kind}.`);
    }
    normalized[field] = value;
  }
  return normalized;
}

async function importConfigFile(cwd, configPath) {
  const path = configPath ? resolve(configPath) : join(cwd, 'loop.config.mjs');
  if (configPath && !(await exists(path))) {
    throw new Error(`Loop config file does not exist: ${path}`);
  }
  return (await exists(path))
    ? ((await import(`${pathToFileURL(path).href}?t=${Date.now()}-${configImportCounter++}`)).default ?? {})
    : {};
}

/**
 * Resolve only the configured runs directory, skipping pipeline validation.
 *
 * Read-only operations (status/inspect/list/metrics) must inspect saved runs
 * even when the current pipeline config is unrunnable — for example after a
 * config change leaves a gate phase without commands, which `loadConfig`
 * rejects. They need the runs location, not a runnable pipeline, so this reads
 * `runsDir` from the config file (or the default) without normalizing engines
 * or phases.
 */
export async function loadRunsDir(cwd, configPath) {
  const configured = await importConfigFile(cwd, configPath);
  const runsDir = configured.runsDir ?? defaults.runsDir;
  if (typeof runsDir !== 'string' || !runsDir) {
    throw new Error('`runsDir` must be a non-empty string.');
  }
  return runsDir;
}

/** @returns {Promise<Config>} */
export async function loadConfig(cwd, overrides = {}, configPath) {
  const configured = await importConfigFile(cwd, configPath);
  const merged = {
    ...defaults,
    ...configured,
    ...overrides,
    adapters: { ...defaults.adapters, ...configured.adapters, ...overrides.adapters },
    engines: { ...defaults.engines, ...configured.engines, ...overrides.engines },
  };
  merged.engines = normalizeEngines(merged.engines, merged.adapters);
  merged.budget = normalizeBudget(merged.budget);
  merged.hermetic = normalizeHermeticConfig(merged.hermetic);
  if (!merged.publish || typeof merged.publish !== 'object' || Array.isArray(merged.publish)) {
    throw new Error('`publish` must be an object with backend and draft settings.');
  }
  if (merged.publish.backend !== undefined
    && typeof merged.publish.backend !== 'string'
    && (typeof merged.publish.backend !== 'object' || merged.publish.backend === null)) {
    throw new Error('`publish.backend` must be "github" or a backend object.');
  }
  if (merged.publish.draft !== undefined && typeof merged.publish.draft !== 'boolean') {
    throw new Error('`publish.draft` must be a boolean.');
  }
  if (!Array.isArray(merged.setup) || merged.setup.some((command) => typeof command !== 'string')) {
    throw new Error('`setup` must be an array of command strings.');
  }
  if (typeof merged.shell !== 'string' || !merged.shell.trim()) {
    throw new Error('`shell` must be a non-empty string.');
  }
  merged.resolvedPhases = normalizePhases(merged.phases, { maxRounds: merged.maxRounds });
  for (const phase of merged.resolvedPhases.flatMap((entry) => [entry, ...(entry.repair ?? [])])) {
    phase.hermetic = resolvePhaseHermetic(phase.hermetic, merged.hermetic, phase.kind);
  }
  assertPublishablePhaseOrder(merged.resolvedPhases);
  const allResolvedPhases = merged.resolvedPhases.flatMap((phase) => [phase, ...(phase.repair ?? [])]);
  if (allResolvedPhases.some((phase) => phase.kind === 'gate' && !(phase.commands ?? merged.gate).length)) {
    throw new Error('The pipeline has a gate phase but no gate commands; set `gate: [...]` in loop.config.mjs.');
  }
  return merged;
}

export { defaults, builtinPhases };

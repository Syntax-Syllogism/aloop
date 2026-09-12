import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAgent } from './adapters.mjs';

const defaults = {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  // Null means "detect", which prefers `origin`. Set this explicitly in any
  // repo with several remotes — pushing a feature branch to the wrong one is
  // not something the run can undo for you.
  remote: null,
  adapters: {},
  engines: { default: { name: 'claude' } },
  phases: ['implement', 'gate', 'review', 'address', 'docs', 'git'],
  gate: [],
  // Commands run once in a newly created worktree before the first phase.
  // An empty list keeps the generic runner package-manager agnostic.
  setup: [],
  maxRounds: 3,
  // Per-command budget. An implement phase on a real work item routinely
  // runs past half an hour; a cap that tight kills healthy runs mid-edit.
  timeoutMs: 60 * 60 * 1000,
  worktrees: true,
  worktreeRoot: null,
  promptDir: '.loop/prompts',
  runsDir: '.loop/runs',
};

/**
 * Built-in phase definitions.
 *
 * `verdict: true` marks a phase whose agent must emit a machine-readable
 * verdict; `role: 'repair'` marks a phase that exists to answer one. The
 * runner pairs them during normalization, which is what turns a flat list into
 * a loop without the config having to describe control flow.
 */
const builtinPhases = {
  implement: { kind: 'agent', prompt: 'implement' },
  gate: { kind: 'gate' },
  review: { kind: 'agent', prompt: 'review', verdict: true },
  address: { kind: 'agent', prompt: 'address', role: 'repair' },
  docs: { kind: 'agent', prompt: 'docs' },
  // `requiresCleanTree` makes the runner assert a clean worktree before this
  // phase runs. The git phase pushes and opens a PR; it must never start over
  // uncommitted work an earlier phase left behind, and its prompt forbids it
  // from committing, so a dirty tree there is a pipeline error, not something
  // for the agent to reconcile.
  git: { kind: 'agent', prompt: 'git', requiresCleanTree: true },
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
    return { name: entry, ...builtin };
  }
  if (!entry?.name) throw new Error(`Phase at position ${index} is missing a name.`);
  const builtin = builtinPhases[entry.name] ?? {};
  const phase = { ...builtin, ...entry };
  if (!['agent', 'gate'].includes(phase.kind)) {
    throw new Error(`Phase "${phase.name}" needs kind "agent" or "gate".`);
  }
  if (phase.kind === 'agent' && !phase.prompt) phase.prompt = phase.name;
  return phase;
}

/**
 * Collapse a flat phase list into the shape the runner executes.
 *
 * A verdict phase absorbs the repair phases that follow it, plus any gate that
 * immediately preceded it, so `[gate, review, address]` becomes "gate, then
 * review, and while the verdict asks for changes: address, gate, review again".
 * Declaring the loop this way keeps the config readable while leaving the
 * iteration cap in the runner where it belongs.
 */
export function normalizePhases(entries, { maxRounds }) {
  const list = entries.map(toPhase);
  const result = [];
  for (let index = 0; index < list.length; index += 1) {
    const phase = list[index];
    if (phase.role === 'repair') {
      throw new Error(`Phase "${phase.name}" is a repair phase and must follow a phase that emits a verdict.`);
    }
    if (!phase.verdict) {
      result.push(phase);
      continue;
    }
    const repair = [];
    let next = index + 1;
    while (next < list.length && list[next].role === 'repair') {
      repair.push(list[next]);
      next += 1;
    }
    const precedingGate = result.at(-1)?.kind === 'gate' ? result.at(-1) : null;
    result.push({
      ...phase,
      maxRounds: phase.maxRounds ?? maxRounds,
      repair: repair.length
        ? [...repair, ...(precedingGate ? [{ ...precedingGate, recheck: true }] : [])]
        : [],
    });
    index = next - 1;
  }
  return result;
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

export async function loadConfig(cwd, overrides = {}, configPath) {
  const path = configPath ? resolve(configPath) : join(cwd, 'loop.config.mjs');
  if (configPath && !(await exists(path))) {
    throw new Error(`Loop config file does not exist: ${path}`);
  }
  const configured = (await exists(path))
    ? ((await import(`${pathToFileURL(path).href}?t=${Date.now()}`)).default ?? {})
    : {};
  const merged = {
    ...defaults,
    ...configured,
    ...overrides,
    adapters: { ...defaults.adapters, ...configured.adapters, ...overrides.adapters },
    engines: { ...defaults.engines, ...configured.engines, ...overrides.engines },
  };
  merged.engines = normalizeEngines(merged.engines, merged.adapters);
  if (!Array.isArray(merged.setup) || merged.setup.some((command) => typeof command !== 'string')) {
    throw new Error('`setup` must be an array of command strings.');
  }
  merged.resolvedPhases = normalizePhases(merged.phases, { maxRounds: merged.maxRounds });
  if (merged.resolvedPhases.some((phase) => phase.kind === 'gate' && !(phase.commands ?? merged.gate).length)) {
    throw new Error('The pipeline has a gate phase but no gate commands; set `gate: [...]` in loop.config.mjs.');
  }
  return merged;
}

export { defaults, builtinPhases };

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePrompts = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const packagePresets = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function availableBundledPresets() {
  const entries = await readdir(packagePresets, { withFileTypes: true });
  const available = [];
  for (const entry of entries) {
    if (entry.isDirectory() && await isDirectory(join(packagePresets, entry.name, 'prompts'))) {
      available.push(entry.name);
    }
  }
  return available.sort();
}

/**
 * Resolve a bundled preset name or an external preset directory to its prompts.
 */
export async function resolvePresetPromptDir(preset, { cwd = process.cwd() } = {}) {
  if (preset === null || preset === undefined || (typeof preset === 'string' && !preset.trim())) return null;
  if (typeof preset !== 'string') throw new Error('Preset must be a non-empty string.');

  const isPath = preset.includes('/') || preset.includes('\\') || preset.startsWith('.') || isAbsolute(preset);
  const presetRoot = isPath ? resolve(cwd, preset) : join(packagePresets, preset);
  const promptDir = join(presetRoot, 'prompts');
  if (await isDirectory(promptDir)) return promptDir;

  if (isPath) throw new Error(`Preset directory has no prompts/: ${presetRoot}`);
  const available = (await availableBundledPresets()).join(', ') || '(none)';
  throw new Error(`Unknown preset "${preset}". Available: ${available}.`);
}

/** @typedef {{ promptDirs?: string[], projectPromptDir?: string }} PromptOptions */

/**
 * Load a prompt template from ordered override directories before the packaged one.
 *
 * Overriding is per-file rather than all-or-nothing: a project that only needs
 * a different reviewer drops in `review.md` and keeps receiving improvements to
 * every other phase.
 */
/** @param {PromptOptions} [options] */
export async function loadTemplate(name, options = {}) {
  const { promptDirs = [], projectPromptDir } = options;
  const overrideDirs = promptDirs.length ? promptDirs : (projectPromptDir ? [projectPromptDir] : []);
  const candidates = [...overrideDirs, packagePrompts].map((dir) => join(dir, `${name}.md`));
  for (const candidate of candidates) {
    try {
      return { path: candidate, body: await readFile(candidate, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`No prompt template "${name}.md" in ${[...overrideDirs, packagePrompts].join(' or ')}.`);
}

/**
 * Substitute `{{VARIABLE}}` placeholders, failing on any that go unresolved.
 *
 * An unresolved placeholder reaching an agent is worse than a crash: the agent
 * reads it as literal text and improvises around it, producing work that looks
 * plausible and targets the wrong thing.
 */
export function interpolate(body, variables) {
  const missing = new Set();
  const filled = body.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      missing.add(key);
      return match;
    }
    return String(value);
  });
  if (missing.size) {
    throw new Error(`Prompt has unresolved variables: ${[...missing].sort().join(', ')}`);
  }
  return filled;
}

export function withOperatorNote(prompt, note) {
  if (!note) return prompt;
  return `## Operator note (read this first)\n\nAn operator is resuming this phase and has provided the following instruction. Treat it as authoritative for what remains to be done. Do not redo or revert work that is already complete; do only what is needed to satisfy it and the phase's postconditions.\n\n${note}\n\n---\n\n${prompt}`;
}

export async function renderPrompt(name, variables, options) {
  const { path, body } = await loadTemplate(name, options);
  return { path, body, prompt: interpolate(body, variables) };
}

export { packagePrompts, packagePresets };

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePrompts = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/**
 * Load a prompt template, preferring the project's copy over the packaged one.
 *
 * Overriding is per-file rather than all-or-nothing: a project that only needs
 * a different reviewer drops in `review.md` and keeps receiving improvements to
 * every other phase.
 */
export async function loadTemplate(name, { projectPromptDir }) {
  const candidates = [join(projectPromptDir, `${name}.md`), join(packagePrompts, `${name}.md`)];
  for (const candidate of candidates) {
    try {
      return { path: candidate, body: await readFile(candidate, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`No prompt template "${name}.md" in ${projectPromptDir} or ${packagePrompts}.`);
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

export async function renderPrompt(name, variables, options) {
  const { path, body } = await loadTemplate(name, options);
  return { path, prompt: interpolate(body, variables) };
}

export { packagePrompts };

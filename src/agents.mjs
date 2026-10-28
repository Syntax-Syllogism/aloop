/** Named-agent definitions and shared, nonfatal setup diagnostics. */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { adapterFor, resolvePhaseAgent } from './adapters.mjs';
import { runCommand } from './command.mjs';
import { hashText } from './manifest.mjs';
import { parse as parseToml } from 'smol-toml';

export function agentPhases(config) {
  return config.resolvedPhases
    .flatMap((phase) => [phase, ...(phase.reviewers ?? []), ...(phase.repair ?? [])])
    .filter((phase) => phase.kind === 'agent');
}

/** Read only the diagnostic fields, not arbitrary YAML or vendor configuration. */
function parseDefinition(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const field = lines[i].match(/^(name|model|tools):\s*(.*)$/);
      if (!field) continue;
      let value = field[2].trim();
      if (field[1] === 'tools' && !value) {
        const tools = [];
        while (lines[i + 1]?.match(/^\s+-\s+/)) tools.push(lines[++i].replace(/^\s+-\s+/, ''));
        value = tools.join(', ');
      }
      frontmatter[field[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
  }
  return { frontmatter, body: match ? text.slice(match[0].length) : text };
}

async function definition(path) {
  try {
    const text = await readFile(path, 'utf8');
    let parsed;
    if (extname(path) === '.toml') {
      const data = parseToml(text);
      if (typeof data.developer_instructions !== 'string' || !data.developer_instructions.trim()) return null;
      const frontmatter = Object.fromEntries(
        ['name', 'model', 'tools'].flatMap((key) => (typeof data[key] === 'string' ? [[key, data[key]]] : [])),
      );
      parsed = { body: data.developer_instructions, frontmatter };
    } else {
      parsed = parseDefinition(text);
    }
    return { path, name: parsed.frontmatter.name ?? basename(path, extname(path)), ...parsed, hash: hashText(text) };
  } catch {
    return null;
  }
}

async function definitions(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isFile() &&
      (entry.name.endsWith('.md') || (directory.endsWith(join('.codex', 'agents')) && entry.name.endsWith('.toml')))
        ? [join(directory, entry.name)]
        : entry.isDirectory()
          ? [join(directory, entry.name, 'agent.md')]
          : [],
    );
  return (await Promise.all(files.map(definition))).filter(Boolean);
}

export async function resolveAgentDefinition(name, options) {
  const { engine, worktree, repoRoot, homeDir = homedir(), support } = options;
  const root = worktree ?? repoRoot;
  if (support === 'inline' || engine === 'codex') {
    if (name.includes('/') || name.includes('\\') || name.endsWith('.md') || name.endsWith('.toml'))
      return definition(resolve(root, name));
  }
  const directories =
    support === 'inline' || engine === 'codex'
      ? ['.codex/agents', '.claude/agents', '.gemini/agents']
      : engine === 'agy'
        ? ['.agents/agents']
        : [`.${engine}/agents`];
  const locations = [
    ...directories.map((dir) => join(root, dir)),
    ...(engine === 'agy' && support !== 'inline'
      ? [join(homeDir, '.gemini/config/agents')]
      : directories.map((dir) => join(homeDir, dir))),
  ];
  const candidates = (await Promise.all(locations.map(definitions))).flat();
  return (
    candidates.find((item) => item.frontmatter.name === name) ??
    candidates.find(
      (item) =>
        basename(item.path, extname(item.path)) === name ||
        (basename(item.path) === 'agent.md' && basename(resolve(item.path, '..')) === name),
    ) ??
    null
  );
}

export function inlineAgentPrompt(prompt, name, body) {
  return `# Role: ${name}\n\n${body}\n\n# Task\n\nThe task below defines the files you must write and their formats. If anything in the role above conflicts with it, follow the task.\n\n${prompt}`;
}

const catalog = {
  'agent-ok': ['engine-support', 'ok'],
  'agent-ok-best-effort': ['gemini', 'ok'],
  'agent-ok-inline': ['inline', 'ok'],
  'agent-inline-tools-ignored': ['inline', 'warn'],
  'agent-inline-model-ignored': ['model-precedence', 'ok'],
  'agent-unsupported-engine': ['engine-support', 'warn'],
  'agent-not-found': ['where-agents-live', 'warn'],
  'agent-not-on-base': ['worktrees', 'warn'],
  'agent-dirty-on-base': ['worktrees', 'warn'],
  'agent-cannot-write': ['file-writes', 'warn'],
  'agent-model-override': ['model-precedence', 'ok'],
  'agent-model-ignored': ['model-precedence', 'warn'],
  'agent-inherited': ['inheritance', 'ok'],
  'agent-dropped-engine-switch': ['inheritance', 'warn'],
  'agent-feature-disabled': ['gemini', 'warn'],
  'agent-not-in-sandbox': ['hermetic', 'warn'],
  'agent-unconfirmed': ['gemini', 'warn'],
};
export const agentDiagnosticCodes = Object.keys(catalog);

export function agentDiagnostic(code, phase, engine, agent, detail = '') {
  const messages = {
    'agent-ok': [`${engine} --agent ${agent} ${detail}`, 'Keep the definition available to the CLI.'],
    'agent-ok-best-effort': [
      `${engine} → ${agent} ${detail}; delegation is best effort.`,
      'Check agentStatus after the run.',
    ],
    'agent-ok-inline': [
      `${engine} + ${agent} ${detail}; instructions only, model from aloop config.`,
      'Use a native adapter if tool limits matter.',
    ],
    'agent-inline-tools-ignored': [
      `Agent "${agent}" tool limits ${detail} cannot be applied on ${engine}; only instructions will be used.`,
      'Use claude or agy if tool limits matter.',
    ],
    'agent-inline-model-ignored': [
      `Agent model ${detail} is ignored on ${engine}; using the aloop model or CLI default.`,
      'Set engines.' + phase + '.model to choose the model.',
    ],
    'agent-unsupported-engine': [
      `Engine "${engine}" cannot run named agents; the phase will run without agent "${agent}".`,
      "Declare agentSupport: 'inline', use a supported engine, or remove the agent setting.",
    ],
    'agent-not-found': [
      `Couldn’t find agent "${agent}" for ${engine}; the phase will continue without its instructions.`,
      'Create the definition in a CLI agent directory or correct its name; inline engines also accept a Markdown path.',
    ],
    'agent-not-on-base': [
      `${detail} is not committed on the base branch; new worktrees will not contain this agent.`,
      'Commit the definition to the configured base branch or use a user-level agent.',
    ],
    'agent-dirty-on-base': [
      `${detail} differs from the base branch; new worktrees use the committed version.`,
      'Commit the definition changes to the base branch first.',
    ],
    'agent-cannot-write': [
      `Agent "${agent}" tools ${detail} cannot write required artifacts; the run may stall on a missing verdict.`,
      'Add Write or Edit (or a shell tool) to the agent tools.',
    ],
    'agent-model-override': [
      `engines.${phase}.model ${detail} overrides the agent model.`,
      'Omit the phase model to defer to the agent.',
    ],
    'agent-model-ignored': [
      `engines.${phase}.model sets the main Gemini model; agent "${agent}" uses its own model.`,
      'Set the model in the agent definition or remove the phase model.',
    ],
    'agent-inherited': [
      `Agent "${agent}" inherited from engines.default on ${engine}.`,
      'Set a per-phase agent to override it.',
    ],
    'agent-dropped-engine-switch': [
      `engines.${phase} switches to ${engine}; agent "${agent}" is dropped and the phase runs without it.`,
      'Set engines.' + phase + '.agent if you want an agent on this engine.',
    ],
    'agent-feature-disabled': [
      `Gemini subagents are disabled; delegation to "${agent}" will fail and the main session will continue.`,
      'Set experimental.enableAgents to true in Gemini settings.',
    ],
    'agent-not-in-sandbox': [
      `User-level agent "${agent}" is outside the hermetic mounts; the CLI will not see it.`,
      'Commit a repo-level definition or include the agent in the container image.',
    ],
    'agent-unconfirmed': [
      `Agent "${agent}" was not observed being invoked; the result may not reflect that agent.`,
      'Enable the subagent and inspect the phase log; see the Gemini setup guide.',
    ],
  };
  const [anchor, level] = catalog[code];
  const [message, hint] = messages[code];
  return { phase, engine, agent, code, level, message, hint, docs: `docs/agents.md#${anchor}` };
}

/** Ignore session listings (some Claude versions use `agents` for background sessions). */
async function listedAgents(engine, repoRoot, commandRunner) {
  try {
    const result = await commandRunner(engine, engine === 'claude' ? ['agents', '--json'] : ['agents'], {
      cwd: repoRoot,
      timeoutMs: 3000,
    });
    try {
      const data = JSON.parse(result.stdout);
      const entries = Array.isArray(data) ? data : data.agents;
      if (!Array.isArray(entries)) return [];
      return entries
        .filter((entry) => typeof entry === 'string' || (!entry.sessionId && !entry.state))
        .map((entry) => (typeof entry === 'string' ? entry : entry.name))
        .filter(Boolean);
    } catch {
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().match(/^([\w-]+)(?:\s|$)/)?.[1])
        .filter(Boolean);
    }
  } catch {
    return [];
  }
}

export async function diagnoseAgents(config, options) {
  const {
    repoRoot,
    baseBranch = config.baseBranch,
    homeDir = homedir(),
    commandRunner = runCommand,
    agentSettings,
  } = options;
  const results = [];
  const listings = new Map();
  for (const phase of agentPhases(config)) {
    const engine = agentSettings?.[phase.name] ?? resolvePhaseAgent(config, phase);
    const own = config.engines[phase.name];
    const add = (code, detail = '', name = engine.agent) =>
      results.push(agentDiagnostic(code, phase.name, engine.name, name, detail));
    if (!engine.agent) {
      if (!phase.reviewGroup && config.engines.default.agent && engine.name !== config.engines.default.name) {
        add('agent-dropped-engine-switch', '', config.engines.default.agent);
      }
      continue;
    }
    const support = adapterFor(engine.name, config.adapters).agentSupport;
    if (!support) {
      add('agent-unsupported-engine');
      continue;
    }
    const customNative = support === 'native' && Object.hasOwn(config.adapters ?? {}, engine.name);
    const found = customNative
      ? null
      : await resolveAgentDefinition(engine.agent, { engine: engine.name, repoRoot, homeDir, support });
    if (!customNative && !found && support === 'native' && ['claude', 'agy'].includes(engine.name)) {
      if (!listings.has(engine.name))
        listings.set(engine.name, await listedAgents(engine.name, repoRoot, commandRunner));
    }
    if (!customNative && !found && !listings.get(engine.name)?.includes(engine.agent)) {
      add('agent-not-found');
    } else {
      const model =
        support === 'inline'
          ? `aloop model ${engine.model ?? '(CLI default)'}`
          : engine.model
            ? `explicit phase model ${engine.model}`
            : 'model from agent (inherited aloop model omitted)';
      add(
        support === 'inline' ? 'agent-ok-inline' : support === 'delegate' ? 'agent-ok-best-effort' : 'agent-ok',
        `${customNative ? 'resolution managed by custom adapter CLI' : found ? `found ${found.path}` : 'found in CLI listing'}; ${model}`,
      );
    }
    if (!own?.agent && !phase.reviewGroup && config.engines.default.agent === engine.agent) add('agent-inherited');
    if (support === 'native' && own?.model) add('agent-model-override', engine.model);
    if (support === 'delegate' && own?.model) add('agent-model-ignored');
    if (found) {
      const { tools, model } = found.frontmatter;
      if (support === 'inline') {
        if (tools !== undefined) add('agent-inline-tools-ignored', tools);
        if (model) add('agent-inline-model-ignored', model);
      } else if (
        support === 'native' &&
        tools !== undefined &&
        !/(?:^|[\s,\[])(?:Write|Edit|MultiEdit|Bash|write_file|edit_file|run_shell_command|write_to_file|replace_file_content|multi_replace_file_content|run_command|\*)(?:$|[\s,\]])/i.test(
          tools.replaceAll(/["']/g, ''),
        )
      ) {
        add('agent-cannot-write', tools);
      }
      const rel = relative(repoRoot, found.path);
      const inRepo =
        rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
      if (inRepo && config.worktrees !== false) {
        try {
          await commandRunner('git', ['cat-file', '-e', `${baseBranch}:${rel.replaceAll('\\', '/')}`], {
            cwd: repoRoot,
          });
          try {
            await commandRunner('git', ['diff', '--quiet', baseBranch, '--', rel], { cwd: repoRoot });
          } catch {
            add('agent-dirty-on-base', rel);
          }
        } catch {
          add('agent-not-on-base', rel);
        }
      }
      if (!inRepo && phase.hermetic && support !== 'inline') add('agent-not-in-sandbox');
    }
    if (support === 'delegate' && engine.name === 'gemini') {
      let enabled;
      for (const root of [homeDir, repoRoot]) {
        try {
          const settings = JSON.parse(await readFile(join(root, '.gemini/settings.json'), 'utf8'));
          if (settings.experimental?.enableAgents !== undefined) enabled = settings.experimental.enableAgents;
        } catch {
          /* Missing or invalid settings remain the CLI's responsibility. */
        }
      }
      if (enabled === false) add('agent-feature-disabled');
    }
  }
  return results;
}

/**
 * Engine adapters.
 *
 * Every adapter turns the same request — a prompt, a working directory, and a
 * set of extra writable directories — into one CLI invocation. That is the
 * entire portability story: phases, prompts, and the verdict contract are
 * shared, and only this file knows which vendor is running.
 *
 * Adapters deliberately do not parse stdout for *results*. Steps communicate by
 * writing files the runner reads, because stdout formats are per-vendor and
 * change between releases while a JSON file on disk does not.
 *
 * Rendering progress is the one exception, and it stays here for the same
 * reason: only this file knows a vendor's stdout format. An adapter may expose
 * `createRenderer()` to turn its stdout into human-readable lines; the runner
 * treats the result as opaque text.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './command.mjs';

/** Fields worth showing for a tool call, most specific first. */
const toolSummaryFields = ['command', 'file_path', 'pattern', 'path', 'url', 'description', 'prompt'];

export const PERMISSIONS = Object.freeze({
  READ_ONLY: 'read-only',
  WRITE_WORKTREE: 'write-worktree',
  PUBLISH: 'publish',
});

/** Resolve a phase permission conservatively for adapters and BYO engines. */
export function permissionLevel(permissions) {
  const requested = Array.isArray(permissions) ? permissions : [];
  if (requested.includes(PERMISSIONS.READ_ONLY)) return PERMISSIONS.READ_ONLY;
  if (requested.includes(PERMISSIONS.WRITE_WORKTREE)) return PERMISSIONS.WRITE_WORKTREE;
  if (requested.includes(PERMISSIONS.PUBLISH)) return PERMISSIONS.PUBLISH;
  return PERMISSIONS.READ_ONLY;
}

function condense(text, limit = 120) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const field of toolSummaryFields) {
    if (typeof input[field] === 'string' && input[field].trim()) return condense(input[field]);
  }
  return '';
}

/**
 * Summarize an agy tool call's parameters.
 *
 * agy names its parameters differently from Claude (`CommandLine`, `AbsolutePath`,
 * …), so try the most descriptive keys first and fall back to the first string
 * value — robust to tools this list has never seen.
 */
function summarizeAgyParams(params) {
  if (!params || typeof params !== 'object') return '';
  const preferred = ['CommandLine', 'Command', 'AbsolutePath', 'FilePath', 'Path', 'Query', 'Url', 'Pattern'];
  for (const key of preferred) {
    if (typeof params[key] === 'string' && params[key].trim()) return condense(params[key]);
  }
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && value.trim()) return condense(value);
  }
  return '';
}

function cliVersion(command) {
  return async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aloop-version-'));
    try {
      return (await runCommand(command, ['--version'], { cwd, timeoutMs: 5000 })).stdout.trim();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

function renderClaudeBlock(block) {
  if (block.type === 'text') return block.text?.trim() ? `${block.text.trimEnd()}\n` : '';
  if (block.type === 'thinking') return '  \u00b7 thinking\n';
  if (block.type === 'tool_use') {
    const detail = summarizeToolInput(block.input);
    return `  \u2192 ${block.name}${detail ? ` ${detail}` : ''}\n`;
  }
  return '';
}

/**
 * Turn one Claude stream-json event into the line a watching human wants.
 *
 * Unrecognized events render as nothing rather than raw JSON: the vendor adds
 * event types between releases, and a log that dumps every one of them is as
 * unreadable as no log at all.
 */
export function renderClaudeEvent(event) {
  if (event.type === 'assistant') return (event.message?.content ?? []).map(renderClaudeBlock).join('');
  if (event.type === 'user') {
    return (event.message?.content ?? [])
      .filter((block) => block.type === 'tool_result' && block.is_error)
      .map((block) => `  \u2717 ${condense(String(block.content ?? 'tool call failed'), 160)}\n`)
      .join('');
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return `  \u00b7 session ${String(event.session_id ?? '').slice(0, 8)}${event.model ? ` model ${event.model}` : ''}\n`;
  }
  if (event.type === 'system' && event.subtype === 'permission_denied') {
    return `  \u26a0 permission denied: ${event.tool_name ?? 'tool'}\n`;
  }
  if (event.type === 'result') {
    const turns = event.num_turns ? ` ${event.num_turns} turns` : '';
    const seconds = event.duration_ms ? ` ${Math.round(event.duration_ms / 1000)}s` : '';
    return `  ${event.is_error ? '\u2717 failed' : '\u2713 done'}${turns}${seconds}\n`;
  }
  return '';
}

/**
 * Turn one agy stream-json event into the line a watching human wants.
 *
 * agy's events are `init` (session), `step_update` (per-step progress: user
 * input, agent text deltas, tool calls), and `result` (final status). As with
 * the Claude renderer, an unrecognized shape renders as nothing rather than raw
 * JSON — notably the enormous `init` tool list is collapsed to one line.
 */
export function renderAgyEvent(event) {
  if (event.event === 'init') {
    const id = String(event.conversation_id ?? '').slice(0, 8);
    const model = event.init?.model;
    return `  · session ${id}${model ? ` model ${model}` : ''}\n`;
  }
  if (event.event === 'step_update') {
    const step = event.step_update ?? {};
    // Assistant text arrives as deltas; stream them through verbatim.
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') return step.text_delta;
    if (step.step_type === 'tool') {
      if (step.state === 'ACTIVE') {
        const detail = summarizeAgyParams(step.tool_info?.parameters);
        return `  → ${step.tool_name ?? 'tool'}${detail ? ` ${detail}` : ''}\n`;
      }
      if (step.state === 'DONE' && step.tool_info?.error) {
        return `  ✗ ${condense(String(step.tool_info.error), 160)}\n`;
      }
    }
    return '';
  }
  if (event.event === 'result') {
    const result = event.result ?? {};
    const turns = result.num_turns ? ` ${result.num_turns} turn${result.num_turns === 1 ? '' : 's'}` : '';
    const seconds = result.duration_seconds ? ` ${Math.round(result.duration_seconds)}s` : '';
    if (result.status && result.status !== 'SUCCESS') {
      const why = result.error ? `: ${condense(String(result.error), 160)}` : '';
      return `  ✗ ${String(result.status).toLowerCase()}${why}${turns}${seconds}\n`;
    }
    return `  ✓ done${turns}${seconds}\n`;
  }
  return '';
}

/**
 * Line-buffer a JSONL stream and render each complete event.
 *
 * Chunks split mid-line, so the tail is held until its newline arrives. A line
 * that is not JSON passes through untouched — that is how a vendor warning
 * printed alongside the stream still reaches the log.
 */
export function createJsonlRenderer(renderEvent) {
  let pending = '';
  let usage = null;
  const recordUsage = (event) => {
    if (!event || typeof event !== 'object') return;
    const source = event.usage ?? event.result?.usage ?? event;
    if (!source || typeof source !== 'object') return;
    const tokenValues = [
      source.tokens,
      source.total_tokens,
      source.totalTokens,
      source.input_tokens !== undefined && source.output_tokens !== undefined
        ? Number(source.input_tokens) + Number(source.output_tokens)
        : undefined,
      source.prompt_tokens !== undefined && source.completion_tokens !== undefined
        ? Number(source.prompt_tokens) + Number(source.completion_tokens)
        : undefined,
    ].filter((value) => Number.isFinite(value));
    const cost = [event.usage, event.result?.usage, event]
      .filter((candidate) => candidate && typeof candidate === 'object')
      .flatMap((candidate) => [candidate.cost, candidate.total_cost, candidate.totalCost, candidate.total_cost_usd])
      .find((value) => Number.isFinite(value));
    if (tokenValues.length || cost !== undefined) {
      usage = {
        ...(tokenValues.length ? { tokens: tokenValues.at(-1) } : usage?.tokens !== undefined ? { tokens: usage.tokens } : {}),
        ...(cost !== undefined ? { cost } : usage?.cost !== undefined ? { cost: usage.cost } : {}),
      };
    }
  };
  const renderLine = (line) => {
    if (!line.trim()) return '';
    try {
      const event = JSON.parse(line);
      recordUsage(event);
      return renderEvent(event);
    } catch {
      return `${line}\n`;
    }
  };
  return {
    write(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      return lines.map(renderLine).join('');
    },
    end() {
      const rest = pending;
      pending = '';
      return renderLine(rest);
    },
    usage() {
      return usage;
    },
  };
}

/** A renderer for engines whose stdout is already meant to be read. */
export function passthroughRenderer() {
  return { write: (text) => text, end: () => '' };
}

const claudeAdapter = {
  name: 'claude',
  version: cliVersion('claude'),
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  command({ prompt, addDirs, permissions, artifactOnly = false, agent = {} }) {
    // `auto`, not `acceptEdits`, is used for worktree-writing and
    // artifact-only phases: under acceptEdits a non-interactive `-p` run
    // auto-denies every Bash call, because there is no one to answer the
    // prompt it raises. Phases that have to build, test, and commit then spin
    // until the timeout kills them.
    // stream-json, not text: `--output-format text` withholds every byte until
    // the process exits, so a phase that runs for half an hour looks identical
    // to one that has hung. stream-json emits an event per step, which
    // `createRenderer` turns back into readable lines.
    const canWrite = permissionLevel(permissions) === PERMISSIONS.WRITE_WORKTREE || artifactOnly;
    const permissionMode = canWrite ? 'auto' : 'plan';
    const args = ['-p', prompt, '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose'];
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return { command: 'claude', args };
  },
  createRenderer: () => createJsonlRenderer(renderClaudeEvent),
};

const codexAdapter = {
  name: 'codex',
  version: cliVersion('codex'),
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  command({ prompt, cwd, addDirs, permissions, artifactOnly = false, agent = {} }) {
    const canWrite = permissionLevel(permissions) === PERMISSIONS.WRITE_WORKTREE || artifactOnly;
    const sandbox = canWrite ? 'workspace-write' : 'read-only';
    const args = ['exec', prompt, '--sandbox', sandbox, '--cd', cwd];
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return { command: 'codex', args };
  },
};

const agyAdapter = {
  name: 'agy',
  version: cliVersion('agy'),
  efforts: ['low', 'medium', 'high'],
  command({ prompt, addDirs, timeoutMs, permissions, artifactOnly = false, agent = {} }) {
    // `--dangerously-skip-permissions`, not bare `accept-edits`: in headless
    // `--print` mode agy cannot prompt for the `command` permission its Bash-
    // style tools need, so it auto-denies the first one and exits 0 having done
    // nothing — the phase then "completes" instantly with an empty log. This is
    // agy's equivalent of the claude adapter's `--permission-mode auto` above;
    // agy has no `auto` mode (`--mode` is accept-edits|plan only).
    //
    // stream-json, not the default `text`: agy's text output withholds every
    // byte until the process exits, so a multi-minute phase is indistinguishable
    // from a hang (the run log shows only the header). stream-json emits an
    // event per step, which `createRenderer` turns back into readable lines —
    // same reasoning as the claude adapter above.
    const canWrite = permissionLevel(permissions) === PERMISSIONS.WRITE_WORKTREE || artifactOnly;
    const args = [
      '--print', prompt,
      '--mode', canWrite ? 'accept-edits' : 'plan',
      '--output-format', 'stream-json',
    ];
    if (canWrite) args.splice(4, 0, '--dangerously-skip-permissions');
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    if (timeoutMs) args.push('--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return { command: 'agy', args };
  },
  createRenderer: () => createJsonlRenderer(renderAgyEvent),
};

const adapters = { claude: claudeAdapter, codex: codexAdapter, agy: agyAdapter };

function validateConfiguredAdapter(name, adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter) || typeof adapter.command !== 'function') {
    throw new Error(`Invalid adapter "${name}": expected an object with a command function.`);
  }
  if (adapter.efforts !== undefined && (!Array.isArray(adapter.efforts) || adapter.efforts.some((effort) => typeof effort !== 'string'))) {
    throw new Error(`Invalid adapter "${name}": efforts must be an array of strings.`);
  }
  if (adapter.createRenderer !== undefined && typeof adapter.createRenderer !== 'function') {
    throw new Error(`Invalid adapter "${name}": createRenderer must be a function.`);
  }
  if (adapter.version !== undefined && typeof adapter.version !== 'function') {
    throw new Error(`Invalid adapter "${name}": version must be a function.`);
  }
  return adapter;
}

export function adapterFor(engine, customAdapters = {}) {
  const configuredNames = customAdapters && typeof customAdapters === 'object' ? Object.keys(customAdapters) : [];
  const hasConfiguredAdapter = customAdapters && typeof customAdapters === 'object'
    && Object.hasOwn(customAdapters, engine);
  const adapter = hasConfiguredAdapter ? validateConfiguredAdapter(engine, customAdapters[engine]) : adapters[engine];
  if (!adapter) {
    const available = [...new Set([...Object.keys(adapters), ...configuredNames])];
    throw new Error(`Unsupported engine "${engine}"; expected one of ${available.join(', ')}.`);
  }
  return adapter;
}

export function validateAgent(agent, customAdapters = {}) {
  const adapter = adapterFor(agent.name, customAdapters);
  if (agent.effort && adapter.efforts && !adapter.efforts.includes(agent.effort)) {
    throw new Error(`Engine "${agent.name}" does not support effort "${agent.effort}"; expected one of ${adapter.efforts.join(', ')}.`);
  }
  return agent;
}

/** Resolve an agent descriptor: per-phase override, else the default. */
export function agentForPhase(config, phaseName) {
  return config.engines[phaseName] ?? config.engines.default;
}

/** Resolve which executable runs a phase. Retained for string-based callers. */
export function engineForPhase(config, phaseName) {
  return agentForPhase(config, phaseName).name;
}

export { adapters };

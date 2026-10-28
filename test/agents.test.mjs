import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { adapterFor, resolveEngine, resolvePhaseAgent } from '../src/adapters.mjs';
import {
  agentDiagnostic,
  agentDiagnosticCodes,
  diagnoseAgents,
  inlineAgentPrompt,
  resolveAgentDefinition,
} from '../src/agents.mjs';
import { runLoop } from '../src/pipeline.mjs';
import { hashText } from '../src/manifest.mjs';
import { runOperationalCommand } from '../bin/loop.mjs';
import { replayRun } from '../src/operations.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aloop-agents-'));
  const root = join(directory, 'repo');
  const homeDir = join(directory, 'home');
  await Promise.all([mkdir(root), mkdir(homeDir)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=master');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Agent Test');
  await writeFile(join(root, '.gitignore'), '.loop/\n');
  git('add', '.');
  git('commit', '-m', 'chore: init');
  const put = async (path, text = '---\nname: specialist\n---\nReview carefully.\n') => {
    const target = path.startsWith('home/') ? join(homeDir, path.slice(5)) : join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    return target;
  };
  return { root, homeDir, git, put };
}

const phase = { name: 'implement', kind: 'agent' };
const noListing = async () => {
  throw new Error('listing unavailable');
};

async function config(root, engine, overrides = {}) {
  return loadConfig(root, {
    phases: ['implement'],
    worktrees: false,
    engines: { default: { name: engine, agent: 'specialist' } },
    ...overrides,
  });
}

test('agent config validates, preserves agent names, and reports allowed keys', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await config(root, 'claude')).engines.default.agent, 'specialist');
  for (const agent of ['', '  ', 1, false, []]) {
    await assert.rejects(config(root, 'claude', { engines: { default: { name: 'claude', agent } } }), /invalid agent/);
  }
  await assert.rejects(
    config(root, 'claude', { engines: { default: { name: 'claude', persona: 'x' } } }),
    /expected name, model, effort, agent/,
  );
});

test('agent inheritance and model precedence respect support mode and specialized reviewers', () => {
  const base = { name: 'claude', model: 'base', effort: 'high', agent: 'specialist' };
  assert.deepEqual(resolveEngine(undefined, base), { name: 'claude', agent: 'specialist' });
  assert.deepEqual(resolveEngine({ model: 'explicit' }, base), {
    name: 'claude',
    agent: 'specialist',
    model: 'explicit',
  });
  assert.deepEqual(resolveEngine({ effort: 'low' }, base), { name: 'claude', agent: 'specialist', effort: 'low' });
  assert.deepEqual(resolveEngine('codex', base), { name: 'codex' });
  assert.deepEqual(resolveEngine(undefined, { ...base, name: 'codex' }), { ...base, name: 'codex' });
  assert.deepEqual(resolveEngine({ agent: 'other', model: 'explicit', effort: 'low' }, base), {
    name: 'claude',
    agent: 'other',
    model: 'explicit',
    effort: 'low',
  });
  const cfg = /** @type {any} */ ({ engines: { default: base, review: { model: 'review' } }, adapters: {} });
  assert.equal(
    resolvePhaseAgent(cfg, /** @type {any} */ ({ name: 'review-security', reviewGroup: 'review' })).agent,
    undefined,
  );
  cfg.engines['review-security'] = { agent: 'security' };
  assert.equal(
    resolvePhaseAgent(cfg, /** @type {any} */ ({ name: 'review-security', reviewGroup: 'review' })).agent,
    'security',
  );
  assert.equal(base.model, 'base', 'resolution never mutates the base');
});

test('native arguments, Gemini preamble and stream confirmation, and custom adapter validation', () => {
  const prompt = 'Do the task verbatim.\nWrite verdict.json.';
  const options = { prompt, cwd: '/tmp', addDirs: [], agent: { agent: 'specialist' } };
  for (const name of ['claude', 'agy']) {
    const adapter = adapterFor(name);
    const args = adapter.command(options).args;
    assert.equal(args[args.indexOf('--agent') + 1], 'specialist');
    assert.ok(!adapter.command({ ...options, agent: {} }).args.includes('--agent'));
  }
  const gemini = adapterFor('gemini');
  const command = gemini.command(options);
  assert.ok(command.input.startsWith('@specialist '));
  assert.ok(command.input.endsWith(prompt));
  assert.deepEqual(command.args, gemini.command({ ...options, agent: {} }).args);
  const renderer = gemini.createRenderer();
  renderer.write('{"type":"message","role":"assistant","content":"specialist"}\n');
  assert.equal(renderer.agentInvoked('specialist'), false);
  const event = JSON.stringify({ type: 'tool_use', tool_name: 'specialist', parameters: { task: 'review' } });
  renderer.write(event.slice(0, 15));
  renderer.write(event.slice(15));
  renderer.end();
  assert.equal(renderer.agentInvoked('specialist'), true);
  const unified = gemini.createRenderer();
  unified.write(
    JSON.stringify({ type: 'tool_use', tool_name: 'invoke_agent', parameters: { agent_name: 'specialist' } }) + '\n',
  );
  assert.equal(unified.agentInvoked('specialist'), true);
  for (const invalid of [{ agentSupport: true }, { agentSupport: 'bad' }, { delegatePrompt: 'bad' }]) {
    assert.throws(
      () => adapterFor('custom', { custom: { command: () => ({ command: 'x', args: [] }), ...invalid } }),
      /Invalid adapter/,
    );
  }
});

test('inline lookup prioritizes names, repository files and explicit paths, strips frontmatter, hashes source', async (t) => {
  const { root, homeDir, put } = await fixture(t);
  await put('home/.codex/agents/specialist.md', 'Home role.');
  await put('.claude/agents/specialist.md', 'Filename fallback.');
  const source = '---\nname: specialist\nmodel: opus\ntools:\n  - Read\n  - Grep\n---\nNamed role.\n';
  const path = await put('.gemini/agents/other.md', source);
  const options = { engine: 'codex', worktree: root, homeDir };
  const found = await resolveAgentDefinition('specialist', options);
  assert.equal(found.path, path);
  assert.equal(found.body, 'Named role.\n');
  assert.equal(found.hash, hashText(source));
  assert.equal(found.frontmatter.tools, 'Read, Grep');
  const explicit = await resolveAgentDefinition('.claude/agents/specialist.md', options);
  assert.equal(explicit.body, 'Filename fallback.');
  await put('.codex/agents/priority.md', source.replace('Named role.', 'Codex role.'));
  assert.match((await resolveAgentDefinition('specialist', options)).body, /Codex role/);
  assert.equal(await resolveAgentDefinition('missing', options), null);
  const wrapped = inlineAgentPrompt('Original task', 'specialist', found.body);
  assert.ok(wrapped.indexOf('Named role') < wrapped.indexOf('Original task'));
  assert.match(wrapped, /If anything in the role above conflicts with it, follow the task/);
});

test('diagnostics cover models, tools, inheritance, engine switches, feature settings and hermetic home agents', async (t) => {
  const { root, homeDir, put } = await fixture(t);
  await put('.claude/agents/specialist.md', '---\nname: specialist\nmodel: opus\ntools: Read, Grep\n---\nBody');
  await put('home/.gemini/agents/specialist.md');
  await put('.gemini/settings.json', '{"experimental":{"enableAgents":false}}');
  const diagnose = async (cfg) => diagnoseAgents(cfg, { repoRoot: root, homeDir, commandRunner: noListing });
  const native = await config(root, 'claude', {
    engines: { default: { name: 'claude', agent: 'specialist' }, implement: { model: 'explicit' } },
  });
  const codes = (items) => items.map((item) => item.code);
  assert.deepEqual(
    codes(await diagnose(native)).sort(),
    ['agent-ok', 'agent-cannot-write', 'agent-inherited', 'agent-model-override'].sort(),
  );
  const inline = await diagnose(await config(root, 'codex'));
  assert.ok(codes(inline).includes('agent-ok-inline'));
  assert.ok(codes(inline).includes('agent-inline-tools-ignored'));
  assert.ok(codes(inline).includes('agent-inline-model-ignored'));
  const gemini = await config(root, 'gemini', {
    engines: { default: { name: 'gemini', agent: 'specialist' }, implement: { model: 'main' } },
  });
  gemini.resolvedPhases[0].hermetic = /** @type {any} */ ({ mode: 'container' });
  assert.deepEqual(
    codes(await diagnose(gemini)).sort(),
    [
      'agent-ok-best-effort',
      'agent-inherited',
      'agent-model-ignored',
      'agent-feature-disabled',
      'agent-not-in-sandbox',
    ].sort(),
  );
  const switched = await config(root, 'claude', {
    engines: { default: { name: 'claude', agent: 'specialist' }, implement: 'codex' },
  });
  assert.deepEqual(codes(await diagnose(switched)), ['agent-dropped-engine-switch']);
  const custom = await config(root, 'custom', {
    adapters: { custom: { command: () => ({ command: 'x', args: [] }) } },
  });
  assert.deepEqual(codes(await diagnose(custom)), ['agent-unsupported-engine']);
});

test('diagnostics distinguish missing, off-base and dirty definitions, and fall back after listing failure', async (t) => {
  const { root, homeDir, put, git } = await fixture(t);
  const cfg = await config(root, 'claude', { worktrees: true });
  const diagnose = () => diagnoseAgents(cfg, { repoRoot: root, homeDir });
  const missing = await diagnoseAgents(cfg, { repoRoot: root, homeDir, commandRunner: noListing });
  assert.equal(missing[0].code, 'agent-not-found');
  assert.match(missing[0].message, /Couldn’t find/);
  const file = '.claude/agents/specialist.md';
  await put(file);
  assert.ok((await diagnose()).some((item) => item.code === 'agent-not-on-base'));
  git('add', file);
  git('commit', '-m', 'feat: definition');
  assert.ok(!(await diagnose()).some((item) => item.level === 'warn'));
  await put(file, 'Changed role.');
  assert.ok((await diagnose()).some((item) => item.code === 'agent-dirty-on-base'));
  // A definition committed on the current feature branch is still absent on master.
  git('checkout', '-b', 'fixture-agent');
  await put('.claude/agents/branch-only.md', '---\nname: branch-only\n---\nBranch role');
  git('add', '.claude');
  git('commit', '-m', 'feat: branch role');
  cfg.engines.default.agent = 'branch-only';
  assert.ok((await diagnose()).some((item) => item.code === 'agent-not-on-base'));
});

test('custom native adapters own resolution, including overrides of built-in engine names', async (t) => {
  const { root, homeDir, put } = await fixture(t);
  await put('.claude/agents/specialist.md', '---\nname: specialist\ntools: Read\n---\nUnrelated definition');
  for (const name of ['custom', 'claude']) {
    const cfg = await config(root, name, {
      adapters: { [name]: { agentSupport: 'native', command: () => ({ command: 'x', args: [] }) } },
    });
    const results = await diagnoseAgents(cfg, {
      repoRoot: root,
      homeDir,
      commandRunner: async () => assert.fail('custom resolution must not use built-in CLI listings'),
    });
    assert.ok(results.some((item) => item.code === 'agent-ok' && item.message.includes('custom adapter CLI')));
    assert.ok(results.every((item) => item.level === 'ok'));
  }
});

test('CLI listings accept plugin definitions but exclude background sessions; agy nested locations work', async (t) => {
  const { root, homeDir, put } = await fixture(t);
  const cfg = await config(root, 'claude');
  let calls = 0;
  const commandRunner = async () => {
    calls++;
    return { stdout: '[{"name":"specialist"}]' };
  };
  const results = await diagnoseAgents(cfg, { repoRoot: root, homeDir, commandRunner });
  assert.equal(calls, 1);
  assert.equal(results[0].code, 'agent-ok');
  const sessions = await diagnoseAgents(cfg, {
    repoRoot: root,
    homeDir,
    commandRunner: async () => ({ stdout: '[{"name":"specialist","sessionId":"abc"}]' }),
  });
  assert.equal(sessions[0].code, 'agent-not-found');
  const path = await put('home/.gemini/config/agents/specialist/agent.md');
  assert.equal((await resolveAgentDefinition('specialist', { engine: 'agy', repoRoot: root, homeDir })).path, path);
});

test('every diagnostic has an actionable hint and a documented anchor', async () => {
  const guide = await readFile(new URL('../docs/agents.md', import.meta.url), 'utf8');
  for (const code of agentDiagnosticCodes) {
    const diagnostic = agentDiagnostic(code, 'review', 'claude', 'specialist');
    assert.ok(diagnostic.message && diagnostic.hint);
    assert.ok(['ok', 'warn'].includes(diagnostic.level));
    const anchor = diagnostic.docs.split('#')[1];
    assert.ok(guide.includes(`id="${anchor}"`) || guide.includes(`## ${anchor}`), `${code}: ${anchor}`);
  }
});

for (const mode of ['inline', 'delegate', 'wrapped', 'unsupported', 'missing', 'confirmed', 'native']) {
  test(`pipeline ${mode}: warnings stay nonfatal, command fields, prompt hash and resume settings`, async (t) => {
    const { root, put, git } = await fixture(t);
    if (mode !== 'missing' && mode !== 'native') await put('.claude/agents/specialist.md');
    const support = mode === 'missing' ? 'inline' : ['confirmed', 'wrapped'].includes(mode) ? 'delegate' : mode;
    const implementation = `const fs = require('node:fs'); const cp = require('node:child_process');
      fs.writeFileSync('implemented.txt', 'done');
      cp.execFileSync('git', ['add', 'implemented.txt']);
      cp.execFileSync('git', ['commit', '-m', 'feat: fixture']);`;
    await put(
      'loop.config.mjs',
      `export default {
      worktrees: false, phases: ['implement', 'gate'], gate: ['git --version'],
      engines: { default: { name: 'fake', model: 'inherited', agent: 'specialist' } },
      adapters: { fake: {
        ${mode === 'unsupported' ? '' : `agentSupport: '${support}',`}
        ${
          support === 'delegate'
            ? mode === 'wrapped'
              ? 'delegatePrompt: (prompt, agent) => JSON.stringify({ task: prompt.toUpperCase(), agent }),'
              : "delegatePrompt: (prompt, agent) => '@' + agent + '\\n' + prompt,"
            : ''
        }
        ${mode === 'confirmed' ? "createRenderer: () => ({ write: text => text, end: () => '', agentInvoked: name => name === 'specialist' })," : ''}
        command({prompt, agent}) {
          if (${mode === 'native' ? "agent.agent !== 'specialist'" : 'agent.agent !== undefined'}) throw new Error('wrong agent forwarding');
          ${mode === 'inline' ? "if (!prompt.startsWith('# Role: specialist')) throw new Error('missing role');" : ''}
          return { command: process.execPath, args: ['-e', ${JSON.stringify(implementation)} + '\\nfs.writeFileSync(".loop/received-prompt.txt", ' + JSON.stringify(prompt) + ');'] };
        }
      } }
    };`,
    );
    git('add', '.');
    git('commit', '-m', 'chore: fixture config');
    const logs = [];
    const original = console.log;
    console.log = (text) => logs.push(String(text));
    let summary;
    try {
      summary = await runLoop({ args: { cwd: root, task: 'Implement', name: 'agent-test', yes: true, noTui: true } });
    } finally {
      console.log = original;
    }
    assert.equal(summary.stalled, null);
    const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
    const entry = manifest.phases.find((item) => item.phase === 'implement');
    assert.equal(
      entry.agentStatus,
      ['delegate', 'wrapped'].includes(mode) ? 'unconfirmed' : mode === 'missing' ? 'unresolved' : mode,
    );
    assert.equal(entry.engine.agent, 'specialist');
    const state = JSON.parse(await readFile(join(summary.runDir, 'state.json'), 'utf8'));
    assert.equal(state.agentSettings.implement.agent, 'specialist');
    assert.equal(
      entry.promptHash,
      hashText(
        entry.promptInput.wrappedPrompt ??
          (entry.promptInput.agentPrefix ?? '') +
            (await import('../src/prompts.mjs')).interpolate(
              entry.promptInput.templateBody,
              entry.promptInput.variables,
            ),
      ),
    );
    assert.equal(entry.promptHash, hashText(await readFile(join(root, '.loop/received-prompt.txt'), 'utf8')));
    const replay = await replayRun('agent-test', { cwd: root });
    assert.equal(replay.timeline.find((item) => item.phase === 'implement').prompt.status, 'verified');
    if (mode === 'wrapped') {
      assert.equal(entry.promptInput.agentPrefix, undefined);
      assert.equal(JSON.parse(entry.promptInput.wrappedPrompt).agent, 'specialist');
      entry.promptInput.wrappedPrompt += 'tampered';
      await writeFile(join(summary.runDir, 'manifest.json'), JSON.stringify(manifest));
      const tampered = await replayRun('agent-test', { cwd: root });
      assert.equal(tampered.timeline.find((item) => item.phase === 'implement').prompt.status, 'mismatch');
    }
    if (mode === 'inline') {
      assert.equal(entry.engine.model, 'inherited');
      assert.ok(entry.agentSource.path.endsWith('specialist.md'));
      assert.match(entry.agentSource.hash, /^[a-f0-9]{64}$/);
    } else if (mode === 'delegate') assert.match(logs.join('\n'), /not observed being invoked/);
    else if (mode === 'unsupported') assert.match(logs.join('\n'), /cannot run named agents/);
    else if (mode === 'missing') assert.match(logs.join('\n'), /Couldn’t find/);
    else if (mode === 'native') assert.doesNotMatch(logs.join('\n'), /Couldn’t find|continue without its instructions/);
    if (support === 'native' || support === 'delegate') assert.equal(entry.engine.model, undefined);
    const phaseLog = await readFile(join(summary.runDir, 'implement.log'), 'utf8');
    assert.match(phaseLog, /agent: specialist/);
    if (mode === 'unsupported') assert.equal(logs.filter((line) => line.includes('cannot run named agents')).length, 1);
    console.log = () => {};
    try {
      const resumed = await runLoop({ args: { cwd: root, name: 'agent-test', resume: true, yes: true } });
      assert.equal(resumed.stalled, null);
      for (const engine of ['fake', 'codex']) {
        const lines = [];
        console.log = (text) => lines.push(String(text));
        await runLoop({
          args: {
            cwd: root,
            name: 'agent-test',
            resume: true,
            yes: true,
            overrideEngine: true,
            engine,
            model: 'override',
          },
        });
        const overridden = JSON.parse(await readFile(join(summary.runDir, 'state.json'), 'utf8'));
        assert.equal(overridden.agentSettings.implement.agent, engine === 'fake' ? 'specialist' : undefined);
      }
    } finally {
      console.log = original;
    }
  });
}

test('native Codex TOML definitions inline developer instructions, including multiline escaped strings', async (t) => {
  const { root, homeDir, put } = await fixture(t);
  const path = await put(
    '.codex/agents/other.toml',
    `name = "specialist"
model = "vendor-model"
developer_instructions = """
Review carefully.
Preserve \"quoted\" text and Unicode \u263A.
"""
`,
  );
  const found = await resolveAgentDefinition('specialist', { engine: 'codex', worktree: root, homeDir });
  assert.equal(found.path, path);
  assert.match(found.body, /Review carefully/);
  assert.match(found.body, /"quoted"/);
  assert.equal(found.frontmatter.model, 'vendor-model');
  assert.equal(
    (await resolveAgentDefinition('.codex/agents/other.toml', { engine: 'codex', worktree: root, homeDir })).hash,
    found.hash,
  );
  await put('.codex/agents/broken.toml', 'developer_instructions = [');
  assert.equal(await resolveAgentDefinition('broken', { engine: 'codex', worktree: root, homeDir }), null);
  await put('another-tree/.codex/agents/other.toml', 'name = "specialist"\ndeveloper_instructions = "Worktree role"');
  assert.equal(
    (
      await resolveAgentDefinition('specialist', {
        engine: 'codex',
        worktree: join(root, 'another-tree'),
        repoRoot: root,
        homeDir,
      })
    ).body,
    'Worktree role',
  );
});

test('doctor renders agent warnings without failing, exposes JSON fields and includes specialized reviewers', async (t) => {
  const { root, put } = await fixture(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  await put(
    'loop.config.mjs',
    `export default {
    phases: ['review'], reviewRoles: ['security'], worktrees: false,
    engines: { default: { name: 'fake' }, review: { agent: 'general' }, 'review-security': { agent: 'security' } },
    adapters: { fake: { command: () => ({ command: process.execPath, args: [] }) } }
  };`,
  );
  const lines = [];
  const result = await runOperationalCommand(
    { command: 'doctor' },
    { cwd: root, output: { log: (line) => lines.push(line) } },
  );
  assert.equal(result.ok, true);
  for (const name of ['review', 'review-security']) {
    const check = result.checks.find((item) => item.name === `agent ${name}`);
    assert.equal(check.warn, true);
    assert.equal(check.code, 'agent-unsupported-engine');
    assert.ok(check.hint && check.docs);
  }
  assert.match(lines.join('\n'), /⚠ agent review-security/);
  assert.match(lines.join('\n'), /→/);
  assert.match(lines.join('\n'), /Doctor: OK \(2 warnings\)/);
  const json = [];
  await runOperationalCommand(
    { command: 'doctor', json: true },
    { cwd: root, output: { log: (line) => json.push(line) } },
  );
  assert.equal(JSON.parse(json[0]).checks.find((item) => item.code === 'agent-unsupported-engine').warn, true);
  // Dry runs expose the configured name even when the adapter is unsupported.
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await runLoop({ args: { cwd: root, task: 'Review', name: 'dry-agent', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /agent: general/);
  assert.match(lines.join('\n'), /agent: security/);
});

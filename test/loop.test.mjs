import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoopArgs } from '../bin/loop.mjs';
import { defaults, normalizePhases, loadConfig } from '../src/config.mjs';
import { adapterFor, agentForPhase, createJsonlRenderer, engineForPhase, renderAgyEvent, renderClaudeEvent } from '../src/adapters.mjs';
import { interpolate, packagePrompts, renderPrompt } from '../src/prompts.mjs';
import { parseVerdict, formatFindings } from '../src/verdict.mjs';
import { slugFor, RunState } from '../src/state.mjs';
import { runLoop, buildTaskContext } from '../src/pipeline.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd })).stdout.trim();
}

async function repoFixture({ config = null, phases = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'loop-repo-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'config', 'user.email', 'loop@example.com');
  await git(root, 'config', 'user.name', 'Loop Test');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'chore: init');

  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const body = config ?? `export default {
  gate: ['git --version'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
  ${phases ? `phases: ${JSON.stringify(phases)},` : ''}
};
`;
  await writeFile(join(root, 'loop.config.mjs'), body);

  const wiki = await mkdtemp(join(tmpdir(), 'loop-wiki-'));
  await git(wiki, 'init', '--initial-branch=master');
  const workItem = join(wiki, 'ss-demo-feature.md');
  await writeFile(workItem, '---\nstatus: TODO\n---\n\n# Demo\n\n## Implementation Notes\n\nDo the thing.\n');

  return { root, workItem, worktreeRoot };
}

async function createBranchWithCommit(root, branch, file, contents) {
  await git(root, 'checkout', '-b', branch);
  await writeFile(join(root, file), contents);
  await git(root, 'add', file);
  await git(root, 'commit', '-m', `feat: ${branch} work`);
  await git(root, 'checkout', 'master');
}

test('normalizePhases folds repair phases into the verdict phase', () => {
  const phases = normalizePhases(['implement', 'gate', 'review', 'address', 'docs'], { maxRounds: 3 });
  assert.deepEqual(phases.map((phase) => phase.name), ['implement', 'gate', 'review', 'docs']);
  const review = phases.find((phase) => phase.name === 'review');
  assert.equal(review.maxRounds, 3);
  assert.deepEqual(review.repair.map((phase) => phase.name), ['address', 'gate']);
  assert.equal(review.repair.at(-1).recheck, true, 'the trailing gate re-runs after repair');
});

test('normalizePhases leaves a verdict phase with no repair phase unlooped', () => {
  const phases = normalizePhases(['review'], { maxRounds: 2 });
  assert.deepEqual(phases[0].repair, []);
});

test('normalizePhases rejects an orphaned repair phase', () => {
  assert.throws(() => normalizePhases(['address'], { maxRounds: 3 }), /must follow a phase that emits a verdict/);
});

test('normalizePhases rejects an unknown phase name', () => {
  assert.throws(() => normalizePhases(['deploy'], { maxRounds: 3 }), /Unknown phase "deploy"/);
});

test('normalizePhases accepts a custom phase object', () => {
  const phases = normalizePhases(
    ['implement', { name: 'perf', kind: 'gate', commands: ['echo bench'] }],
    { maxRounds: 3 },
  );
  assert.equal(phases[1].kind, 'gate');
  assert.deepEqual(phases[1].commands, ['echo bench']);
});

test('the git phase requires a clean worktree before it runs', () => {
  const phases = normalizePhases(['git'], { maxRounds: 3 });
  assert.equal(phases[0].requiresCleanTree, true);
});

test('loadConfig rejects a gate phase with no commands', async () => {
  const { root } = await repoFixture({ config: 'export default { gate: [] };\n' });
  await assert.rejects(loadConfig(root), /gate phase but no gate commands/);
});

test('loadConfig merges overrides over the config file', async () => {
  const { root } = await repoFixture();
  const config = await loadConfig(root, { maxRounds: 7, engines: { review: 'codex' } });
  assert.equal(config.maxRounds, 7);
  assert.deepEqual(config.setup, []);
  assert.equal(engineForPhase(config, 'review'), 'codex');
  assert.equal(engineForPhase(config, 'implement'), 'claude');
});

test('loadConfig normalizes engine descriptors and inherits the default settings', async () => {
  const { root } = await repoFixture({ config: `export default {
  engines: {
    default: { name: 'claude', model: 'sonnet', effort: 'high' },
    review: { name: 'codex', effort: 'medium' },
  },
  gate: ['true'],
};
` });
  const config = await loadConfig(root);
  assert.deepEqual(agentForPhase(config, 'implement'), { name: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(agentForPhase(config, 'review'), { name: 'codex', effort: 'medium' });
});

test('loadConfig rejects unsupported engine effort combinations', async () => {
  const { root } = await repoFixture({ config: `export default {
  engines: { default: { name: 'agy', effort: 'xhigh' } },
  gate: ['true'],
};
` });
  await assert.rejects(loadConfig(root), /does not support effort "xhigh"/);
});

test('loadConfig accepts a custom adapter and its dry-run command is rendered', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    mytool: {
      command({ prompt, cwd, addDirs, agent = {} }) {
        const args = ['run', prompt, '--cwd', cwd];
        if (agent.model) args.push('--model', agent.model);
        if (agent.effort) args.push('--effort', agent.effort);
        for (const dir of addDirs) args.push('--add-dir', dir);
        return { command: 'mytool', args };
      },
    },
  },
  engines: { default: { name: 'mytool', model: 'custom-model', effort: 'custom-effort' } },
  gate: ['true'],
  phases: ['implement'],
  worktrees: false,
};
` });
  const config = await loadConfig(root);
  assert.equal(config.engines.default.name, 'mytool');
  assert.equal(adapterFor('mytool', config.adapters), config.adapters.mytool);

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /would run: "mytool" "run"/);
  assert.match(lines.join('\n'), /"--cwd"/);
  assert.match(lines.join('\n'), /"--model" "custom-model"/);
  assert.match(lines.join('\n'), /"--effort" "custom-effort"/);
});

test('custom adapters without efforts accept any configured effort', async () => {
  const { root } = await repoFixture({ config: `export default {
  adapters: { mytool: { command: () => ({ command: 'mytool', args: [] }) } },
  engines: { default: { name: 'mytool', effort: 'custom-effort' } },
  gate: ['true'],
};
` });
  const config = await loadConfig(root);
  assert.equal(config.engines.default.effort, 'custom-effort');
});

test('custom adapter efforts reject unsupported values', async () => {
  const { root } = await repoFixture({ config: `export default {
  adapters: { mytool: { command: () => ({ command: 'mytool', args: [] }), efforts: ['fast', 'slow'] } },
  engines: { default: { name: 'mytool', effort: 'custom-effort' } },
  gate: ['true'],
};
` });
  await assert.rejects(loadConfig(root), /Engine "mytool" does not support effort "custom-effort"; expected one of fast, slow/);
});

test('interpolate fills variables and rejects unresolved ones', () => {
  assert.equal(interpolate('branch {{BRANCH}}', { BRANCH: 'feat/x' }), 'branch feat/x');
  assert.throws(() => interpolate('{{BRANCH}} {{MISSING}}', { BRANCH: 'x' }), /unresolved variables: MISSING/);
});

test('default prompts render cleanly for every task input mode', async () => {
  const promptNames = ['implement', 'review', 'address', 'docs', 'git'];
  const taskModes = [
    { task: 'Do the inline task.', taskFile: null },
    { task: null, taskFile: '/plans/example.md' },
    { task: null, taskFile: null },
  ];

  for (const { task, taskFile } of taskModes) {
    const variables = {
      TASK: task ?? '',
      TASK_FILE: taskFile ?? '',
      TASK_NAME: 'example',
      TASK_DIR: '/plans',
      TASK_CONTEXT: buildTaskContext({ task, taskFile }),
      BRANCH: 'feat/example',
      BASE_BRANCH: 'master',
      REPO: '/repo',
      RUN_DIR: '/repo/.loop/runs/example',
      REMOTE: 'origin',
      GATE_COMMANDS: 'npm test',
      ROUND: 1,
      MAX_ROUNDS: 3,
      VERDICT_FILE: '/repo/.loop/runs/example/verdict-round-1.json',
      FINDINGS: '(none)',
      GATE_STATUS: 'passing',
      SINCE_SHA: '(none)',
    };

    for (const name of promptNames) {
      const { prompt } = await renderPrompt(name, variables, { projectPromptDir: '/missing-project-prompts' });
      assert.doesNotMatch(prompt, /\{\{[^}]+\}\}/, `${name} has no unresolved placeholders`);
    }
  }
});

test('default prompts contain no work-item-specific references', async () => {
  const forbidden = /WORK_ITEM|## Code Review|## Changelog|IN PROGRESS|AGENTS\.md|CLAUDE\.md/;
  const promptFiles = (await readdir(packagePrompts)).filter((file) => file.endsWith('.md'));

  assert.deepEqual(promptFiles.sort(), ['address.md', 'docs.md', 'git.md', 'implement.md', 'review.md']);
  for (const file of promptFiles) {
    const body = await readFile(join(packagePrompts, file), 'utf8');
    assert.doesNotMatch(body, forbidden, `${file} should remain generic`);
  }
});

test('parseVerdict fails closed on malformed, empty, and unknown verdicts', () => {
  assert.throws(() => parseVerdict('not json'), /not valid JSON/);
  assert.throws(() => parseVerdict('{"verdict":"LGTM"}'), /must be APPROVED or CHANGES_REQUESTED/);
  assert.throws(
    () => parseVerdict('{"verdict":"CHANGES_REQUESTED","blocking":[]}'),
    /lists no blocking findings/,
  );
});

test('parseVerdict tolerates a markdown fence around the JSON', () => {
  const parsed = parseVerdict('```json\n{"verdict":"APPROVED","summary":"ok"}\n```');
  assert.equal(parsed.verdict, 'APPROVED');
  assert.equal(parsed.summary, 'ok');
  assert.deepEqual(parsed.blocking, []);
});

test('formatFindings renders file:line citations', () => {
  const text = formatFindings([{ file: 'src/a.ts', line: 4, issue: 'leaks a handle' }]);
  assert.match(text, /src\/a\.ts:4 — leaks a handle/);
  assert.equal(formatFindings([]), '(none)');
});

test('adapters place the prompt and every extra directory on the command line', () => {
  const request = { prompt: 'do it', cwd: '/w', addDirs: ['/runs', '/wiki'], timeoutMs: 60000 };
  for (const engine of ['claude', 'codex', 'agy']) {
    const { command, args } = adapterFor(engine).command(request);
    assert.equal(command, engine);
    assert.ok(args.includes('do it'), `${engine} passes the prompt`);
    assert.ok(args.includes('/runs') && args.includes('/wiki'), `${engine} passes add-dirs`);
  }
  assert.throws(() => adapterFor('gpt'), /Unsupported engine "gpt".*claude, codex, agy/);
});

test('configured adapters override built-ins and unknown errors list configured names', () => {
  const customClaude = { command: () => ({ command: 'custom-claude', args: [] }) };
  assert.equal(adapterFor('claude', { claude: customClaude }), customClaude);
  assert.throws(
    () => adapterFor('missing', { mytool: customClaude }),
    /Unsupported engine "missing".*claude, codex, agy, mytool/,
  );
});

test('configured adapters reject malformed command and effort definitions', () => {
  assert.throws(() => adapterFor('broken', { broken: {} }), /Invalid adapter "broken".*command function/);
  assert.throws(
    () => adapterFor('broken', { broken: { command: () => ({ command: 'broken', args: [] }), efforts: ['ok', 1] } }),
    /Invalid adapter "broken".*efforts must be an array of strings/,
  );
});

test('adapters emit the configured model and engine-specific effort option', () => {
  const request = { prompt: 'do it', cwd: '/w', addDirs: [], agent: { model: 'chosen-model', effort: 'high' } };
  const claude = adapterFor('claude').command(request).args;
  assert.deepEqual(claude.slice(-4), ['--model', 'chosen-model', '--effort', 'high']);
  const codex = adapterFor('codex').command(request).args;
  assert.ok(codex.includes('--model') && codex.includes('chosen-model'));
  assert.ok(codex.includes('model_reasoning_effort="high"'));
  const agy = adapterFor('agy').command(request).args;
  assert.ok(agy.includes('--model') && agy.includes('chosen-model'));
  assert.ok(agy.includes('--effort') && agy.includes('high'));
});

test('the claude adapter asks for a streaming format so a long phase stays watchable', () => {
  const args = adapterFor('claude').command({ prompt: 'do it', cwd: '/w', addDirs: [] }).args;
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'streams events');
  assert.ok(args.includes('--verbose'), 'stream-json needs verbose to emit every event');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto', 'a non-interactive run cannot answer a prompt');
  assert.equal(args.includes('text'), false, 'text output withholds every byte until exit');
});

test('the claude renderer turns stream events into readable progress lines', () => {
  assert.equal(
    renderClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn  test' } }] } }),
    '  \u2192 Bash yarn test\n',
  );
  assert.equal(
    renderClaudeEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }),
    '  \u26a0 permission denied: Bash\n',
  );
  assert.equal(
    renderClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } }),
    'all done\n',
  );
  assert.equal(renderClaudeEvent({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }), '');
});

test('the agy adapter auto-approves tools and streams so a long phase is not mistaken for a hang', () => {
  const args = adapterFor('agy').command({ prompt: 'do it', cwd: '/w', addDirs: [] }).args;
  // Headless agy cannot answer a permission prompt, so without this it denies the
  // first command tool and exits 0 having done nothing.
  assert.ok(args.includes('--dangerously-skip-permissions'), 'auto-approves tools in headless mode');
  // Default `text` output buffers every byte until exit — a working multi-minute
  // phase then looks identical to a hang.
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'streams events');
  assert.equal(args.includes('text'), false, 'text output withholds every byte until exit');
});

test('the agy renderer turns stream events into readable progress lines', () => {
  assert.equal(
    renderAgyEvent({ event: 'init', conversation_id: '4358ea87-71e3-4662', init: { model: 'gemini-3.6-flash' } }),
    '  · session 4358ea87 model gemini-3.6-flash\n',
  );
  assert.equal(
    renderAgyEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'echo  hi' } } } }),
    '  → run_command echo hi\n',
  );
  assert.equal(
    renderAgyEvent({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'all done' } }),
    'all done',
  );
  assert.equal(
    renderAgyEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: { error: 'boom' } } }),
    '  ✗ boom\n',
  );
  assert.equal(renderAgyEvent({ event: 'result', result: { status: 'SUCCESS', num_turns: 1, duration_seconds: 1.96 } }), '  ✓ done 1 turn 2s\n');
  assert.equal(
    renderAgyEvent({ event: 'result', result: { status: 'ERROR', error: 'invalid model', num_turns: 0 } }),
    '  ✗ error: invalid model\n',
  );
  // The enormous init tool list and user-input steps render as nothing.
  assert.equal(renderAgyEvent({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } }), '');
});

test('the jsonl renderer reassembles events split across chunks and passes plain text through', () => {
  const renderer = createJsonlRenderer((event) => `[${event.n}]`);
  const stream = '{"n":1}\nnot json\n{"n":2}\n{"n":3}';
  let out = '';
  for (let index = 0; index < stream.length; index += 5) out += renderer.write(stream.slice(index, index + 5));
  assert.equal(out, '[1]not json\n[2]');
  assert.equal(renderer.end(), '[3]', 'a trailing line with no newline is still rendered');
});

test('the default per-command timeout leaves room for a real implement phase', () => {
  assert.ok(defaults.timeoutMs >= 60 * 60 * 1000, 'an hour or more');
});

test('slugFor derives a filesystem-safe slug from bare names and paths with various extensions', () => {
  assert.equal(slugFor('/home/j/wiki/work-items/afmt-Clippy_Cleanup.md'), 'afmt-clippy-cleanup');
  assert.equal(slugFor('my-spec.txt'), 'my-spec');
  assert.equal(slugFor('/path/to/feature.markdown'), 'feature');
  assert.equal(slugFor('bare-name'), 'bare-name');
  assert.equal(slugFor(null), '');
});

test('buildTaskContext formats all four combinations of task and taskFile', () => {
  assert.equal(
    buildTaskContext({ task: 'Do X', taskFile: 'spec.md' }),
    'Your task:\n\nDo X\n\nFull details in `spec.md`.',
  );
  assert.equal(
    buildTaskContext({ task: 'Do X', taskFile: null }),
    'Your task:\n\nDo X',
  );
  assert.equal(
    buildTaskContext({ task: null, taskFile: 'spec.md' }),
    'Your task is described in `spec.md`.',
  );
  assert.equal(
    buildTaskContext({ task: null, taskFile: null }),
    '',
  );
});

test('RunState persists phase completion across reopen', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', { branch: 'feat/demo' });
  await state.markComplete('implement');
  const reopened = await RunState.open(runs, 'demo', {});
  assert.equal(reopened.isComplete('implement'), true);
  assert.equal(reopened.isComplete('review'), false);
  assert.equal(reopened.data.branch, 'feat/demo');
});

test('RunState persists the reviewed commit for each verdict round', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', {});
  await state.record({
    rounds: { review: 2 },
    reviewedShas: { review: { 1: 'abc123', 2: 'def456' } },
  });
  const reopened = await RunState.open(runs, 'demo', {});
  assert.deepEqual(reopened.data.reviewedShas.review, { 1: 'abc123', 2: 'def456' });
});

test('parseLoopArgs validates task options and numeric bounds', () => {
  const args = parseLoopArgs([
    '--task-file', 'wi.md',
    '--task', 'do it',
    '--name', 'my-name',
    '--phases', 'implement, gate',
    '--max-rounds', '2',
    '--base-branch', 'other-branch',
    '-y',
  ]);
  assert.equal(args.taskFile, 'wi.md');
  assert.equal(args.task, 'do it');
  assert.equal(args.name, 'my-name');
  assert.deepEqual(args.phases, ['implement', 'gate']);
  assert.equal(args.maxRounds, 2);
  assert.equal(args.baseBranch, 'other-branch');
  assert.equal(args.yes, true);
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--config', 'configs/fast.mjs']).config, 'configs/fast.mjs');
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--resume', '--engine', 'agy', '--override-engine']).overrideEngine, true);
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--max-rounds', 'zero']), /positive integer/);
});

test('a dry run creates the worktree and plans every phase without invoking an engine', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture();
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(summary.branch, 'feat/ss-demo-feature');
  assert.equal(summary.stalled, null);
  assert.equal(summary.worktree, join(worktreeRoot, 'ss-demo-feature'));
  assert.equal(await git(summary.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/ss-demo-feature');

  const output = lines.join('\n');
  assert.match(output, /implement → gate → review → docs → git/);
  assert.match(output, /would run: git --version/, 'gate is planned, not executed');
  assert.match(output, /Your task is described in `.*ss-demo-feature\.md`/, 'the implement prompt is rendered');
  assert.match(output, /record the question and assumption in `.*notes\.md`/);
  assert.match(output, /commit the implementation and its targeted tests/, 'implementation commits before review');
  assert.match(output, /review-round-1\.md/);
  assert.match(output, /Machine-readable verdict/);
  assert.doesNotMatch(output, /Commit it separately|commit .* in .* as a separate commit/i);
  assert.match(output, /git diff master\.\.\.HEAD/, 'review inspects the cumulative branch diff');
  assert.match(output, /\(none — review the cumulative branch diff\)/, 'first review has no prior review SHA');
  assert.doesNotMatch(output, /\{\{/, 'no placeholder survives rendering');
});

test('setup runs in a new worktree before the first phase', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: ['echo setup > setup-marker'],
  gate: ['test -f setup-marker'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(summary.worktree, 'setup-marker'), 'utf8'), 'setup\n');
});

test('setup runs in a fresh worktree for an existing branch', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: ['echo setup > setup-marker'],
  gate: ['test -f setup-marker'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  await git(root, 'branch', 'feat/ss-demo-feature');

  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(summary.worktree, 'setup-marker'), 'utf8'), 'setup\n');
});

test('a failing setup command aborts before any phase runs', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: ['false'],
  gate: ['echo should-not-run'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });

  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, yes: true } }),
    /Worktree setup failed for `false`/,
  );
  await assert.rejects(
    readFile(join(root, '.loop/runs/ss-demo-feature/gate.log')),
    { code: 'ENOENT' },
  );
});

test('setup is skipped when resuming a reused worktree', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: ['echo setup >> setup-count'],
  gate: ['test "$(wc -l < setup-count)" -eq 1'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(await readFile(join(worktreeRoot, 'ss-demo-feature/setup-count'), 'utf8'), 'setup\n');
});

test('setup is skipped during a dry run', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: ['echo setup > setup-marker'],
  gate: ['true'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  await assert.rejects(readFile(join(summary.worktree, 'setup-marker')), { code: 'ENOENT' });
});

test('a code phase that exits cleanly without output or changes stalls', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'implement');
  assert.match(summary.stalled.reason, /implement produced no changes and no output/);
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(state.isComplete('implement'), false);
});

test('a code phase with a tree change completes normally', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('changed.txt', 'changed\\n');\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['implement']);
});

test('a silent code phase that commits completes normally', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
printf 'committed\\n' > committed.txt
git add committed.txt
git commit -m 'feat: silent implementation' >/dev/null
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['implement']);
  assert.equal(await git(summary.worktree, 'log', '-1', '--pretty=%s'), 'feat: silent implementation');
});

test('a non-code phase may complete without output or changes', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['docs'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['docs']);
});

test('a new branch and its prompts use the requested base branch', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['review'] });
  await createBranchWithCommit(root, 'feat/parent', 'PARENT.md', 'parent work\n');

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({
      args: { taskFile: workItem, cwd: root, baseBranch: 'feat/parent', dryRun: true, yes: true },
    });
  } finally {
    console.log = original;
  }

  assert.equal(summary.worktree, join(worktreeRoot, 'ss-demo-feature'));
  await git(summary.worktree, 'merge-base', '--is-ancestor', 'feat/parent', 'HEAD');
  await git(summary.worktree, 'cat-file', '-e', 'HEAD:PARENT.md');
  assert.match(lines.join('\n'), /git diff feat\/parent\.\.\.HEAD/);
});

test('a missing explicit base is rejected before worktree creation', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture();

  await assert.rejects(
    runLoop({
      args: { taskFile: workItem, cwd: root, baseBranch: 'does-not-exist', dryRun: true, yes: true },
    }),
    /--base-branch "does-not-exist" does not exist locally/,
  );
  assert.deepEqual(await readdir(worktreeRoot), []);
});

test('resume stays pinned to its persisted base branch', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  await createBranchWithCommit(root, 'feat/parent', 'PARENT.md', 'parent work\n');
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ baseBranch: 'feat/parent' });

  await assert.rejects(
    runLoop({
      args: {
        taskFile: workItem,
        cwd: root,
        resume: true,
        dryRun: true,
        yes: true,
        baseBranch: 'feat/other',
      },
    }),
    /cannot resume with --base-branch/,
  );

  const original = console.log;
  const matchingLines = [];
  console.log = (message) => matchingLines.push(String(message));
  try {
    await runLoop({
      args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true, baseBranch: 'feat/parent' },
    });
  } finally {
    console.log = original;
  }
  assert.match(matchingLines.join('\n'), /git diff feat\/parent\.\.\.HEAD/);

  const resumedLines = [];
  console.log = (message) => resumedLines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(resumedLines.join('\n'), /base      : feat\/parent/);
  assert.match(resumedLines.join('\n'), /git diff feat\/parent\.\.\.HEAD/);
});

test('reusing a branch warns when an explicit base would have no effect', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  await createBranchWithCommit(root, 'feat/parent', 'PARENT.md', 'parent work\n');
  await git(root, 'branch', 'feat/ss-demo-feature');

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({
      args: { taskFile: workItem, cwd: root, baseBranch: 'feat/parent', dryRun: true, yes: true },
    });
  } finally {
    console.log = original;
  }

  assert.match(lines.join('\n'), /--base-branch has no effect on this run/);
});

test('resume renders the next verdict round from persisted review state', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    rounds: { review: 1 },
    reviewedShas: { review: { 1: 'abc123' } },
  });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /review \(round 2\/3\)/);
  assert.match(output, /git diff abc123\.\.HEAD/);
  assert.doesNotMatch(output, /none — review the cumulative branch diff/);
});

test('resume completes a persisted repair checkpoint before the next verdict round', async () => {
  const { root, workItem } = await repoFixture({
    phases: ['gate', 'review', 'address'],
  });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    completed: ['gate'],
    rounds: { review: 1 },
    reviewedShas: { review: { 1: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 1,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] },
        nextRepair: 0,
      },
    },
  });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /address \(round 1 resume\)/);
  assert.match(output, /gate \(round 1 resume\)/);
  assert.match(output, /would run: git --version/);
  assert.ok(output.indexOf('would run: git --version') < output.indexOf('review (round 2/3)'));
});

test('resume starts at an interrupted address phase even with uncommitted repair edits', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    rounds: { review: 1 },
    reviewedShas: { review: { 1: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 1,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] },
        nextRepair: 0,
      },
    },
  });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /address \(round 1 resume\)/);
  assert.ok(output.indexOf('address (round 1 resume)') < output.indexOf('review (round 2/3)'));
});

test('resume stops at the persisted review round cap without invoking an agent', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    rounds: { review: 3 },
    reviewedShas: { review: { 3: 'abc123' } },
  });

  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.reason, 'round cap reached');
  assert.doesNotMatch(lines.join('\n'), /engine:/);
});

test('a cap reached with outstanding findings checkpoints the owed repair', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review', 'address'],
  maxRounds: 1,
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('Machine-readable verdict')) {
  const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
  writeFileSync(verdictPath, JSON.stringify({ verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] }));
}
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.reason, 'round cap reached');
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(state.data.pendingRepairs.review.round, 1, 'the last round is checkpointed as owed');
  assert.equal(state.data.pendingRepairs.review.nextRepair, 0);
});

test('resuming a capped run with a raised cap runs the owed repair before the next review', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    rounds: { review: 3 },
    reviewedShas: { review: { 3: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 3,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] },
        nextRepair: 0,
      },
    },
  });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, maxRounds: 5, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /address \(round 3 resume\)/);
  assert.match(output, /review \(round 4\/5\)/);
  assert.ok(
    output.indexOf('address (round 3 resume)') < output.indexOf('review (round 4/5)'),
    'the owed repair runs before the next review round',
  );
});

test('resuming a capped run without raising the cap is a no-op', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    rounds: { review: 3 },
    reviewedShas: { review: { 3: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 3,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] },
        nextRepair: 0,
      },
    },
  });

  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.reason, 'round cap reached');
  assert.doesNotMatch(lines.join('\n'), /engine:/, 'no address or review agent runs');
  assert.doesNotMatch(lines.join('\n'), /round 3 resume/);
});

test('a configured remote is used and validated before the run starts', async () => {
  const trees = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: ['true'],
  remote: 'jprichter',
  worktreeRoot: ${JSON.stringify(trees)},
};
`,
  });
  const original = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } }),
      /Configured remote "jprichter" does not exist/,
      'a misconfigured remote fails before any phase runs',
    );
    await git(root, 'remote', 'add', 'jprichter', 'git@github.com:jprichter/fixture.git');
    await git(root, 'remote', 'add', 'origin', 'git@github.com:elsewhere/fixture.git');
    const lines = [];
    console.log = (message) => lines.push(String(message));
    await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['git'], dryRun: true, yes: true } });
    assert.match(lines.join('\n'), /Push to `jprichter`/, 'the configured remote wins over origin');
  } finally {
    console.log = original;
  }
});

test('a dry run records no state, so a later resume does not skip real work', async () => {
  const { root, workItem } = await repoFixture();
  const original = console.log;
  console.log = () => {};
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.deepEqual(state.data.completed, [], 'a dry run must not mark phases complete');
});

test('a dry-run stdin task is materialized when a later resume reads stdin', async () => {
  const { root } = await repoFixture();
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  let dryRunSummary;
  try {
    const dryRunStdin = Readable.from(['dry-run task\n']);
    dryRunStdin.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: dryRunStdin, configurable: true });
    dryRunSummary = await runLoop({
      args: { taskFile: '-', name: 'stdin-resume-task', cwd: root, dryRun: true, yes: true, phases: ['gate'] },
    });
    await assert.rejects(readFile(join(dryRunSummary.runDir, 'task.md')), { code: 'ENOENT' });

    const resumeStdin = Readable.from(['resumed task\n']);
    resumeStdin.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: resumeStdin, configurable: true });
    const resumedSummary = await runLoop({
      args: { taskFile: '-', name: 'stdin-resume-task', cwd: root, resume: true, yes: true, phases: ['gate'] },
    });

    assert.equal(resumedSummary.taskFile, join(dryRunSummary.runDir, 'task.md'));
    assert.equal(await readFile(resumedSummary.taskFile, 'utf8'), 'resumed task\n');
  } finally {
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
});

test('a failing gate stalls the run and exits non-zero', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: ['node -e "process.exit(3)"'],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
  assert.equal(summary.stalled.phase, 'gate');
  assert.match(summary.stalled.reason, /gate failed/);
  assert.deepEqual(summary.phases, [], 'a failing gate is not recorded as a completed phase');
  assert.match(lines.join('\n'), /stalled in "gate"/);
});

test('gate commands run through a shell so quoting and && survive', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: ['test "a b" = "a b" && node -e "process.exit(0)"'],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['gate']);
});

test('an approving reviewer after a failed repair gate stalls cleanly', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['test ! -f review-one'],
  phases: ['gate', 'review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('Machine-readable verdict')) {
  const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
  const firstReview = !existsSync('review-one');
  if (firstReview) writeFileSync('review-one', '');
  writeFileSync(verdictPath, JSON.stringify(firstReview
    ? { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] }
    : { verdict: 'APPROVED', blocking: [] }));
}
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  let summary;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'review');
  assert.equal(summary.stalled.reason, 'approval withheld: repair gate remains failing');
  assert.match(summary.stalled.output, /test ! -f review-one/);
});

test('a dry run honours an overridden phase list', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement', 'gate'] });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['implement']);
});

test('the runtime engine override keeps the configured model and effort', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'sonnet', effort: 'high' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, engine: 'codex', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: codex\s+model: sonnet\s+effort: high/);
});

test('resume uses persisted agent settings when the config has changed', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'high' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    agentSettings: { implement: { name: 'agy', model: 'saved-model', effort: 'low' } },
  });
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: agy\s+model: saved-model\s+effort: low/);
});

test('a supplied config file replaces the repository config', async () => {
  const { root } = await repoFixture({ config: 'export default { gate: [\'false\'] };\n' });
  const suppliedConfig = join(await mkdtemp(join(tmpdir(), 'loop-config-')), 'loop.config.mjs');
  await writeFile(suppliedConfig, 'export default { gate: [\'true\'], phases: [\'gate\'], maxRounds: 7 };\n');

  const config = await loadConfig(root, {}, suppliedConfig);

  assert.deepEqual(config.gate, ['true']);
  assert.deepEqual(config.phases, ['gate']);
  assert.equal(config.maxRounds, 7);
});

test('a supplied config overrides saved agent settings and phase list on resume', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'repository-model', effort: 'high' } },
  gate: ['false'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const suppliedConfig = join(await mkdtemp(join(tmpdir(), 'loop-config-')), 'resume.config.mjs');
  await writeFile(suppliedConfig, `export default {
  engines: { default: { name: 'codex', model: 'override-model', effort: 'medium' } },
  gate: ['true'],
  phases: ['gate', 'review'],
  maxRounds: 5,
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
`);
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    agentSettings: { implement: { name: 'agy', model: 'saved-model', effort: 'low' } },
  });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, config: suppliedConfig, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /phases    : gate → review/);
  assert.match(output, /would run: true/);
  assert.match(output, /engine: codex\s+model: override-model\s+effort: medium/);
  assert.match(output, /review \(round 1\/5\)/);
});

test('a supplied resume config is snapshot in run state', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement'] });
  const suppliedConfig = join(await mkdtemp(join(tmpdir(), 'loop-config-')), 'resume.config.mjs');
  await writeFile(suppliedConfig, "export default { gate: ['true'], phases: ['gate'], maxRounds: 7, worktrees: false };\n");
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ agentSettings: { implement: { name: 'agy', model: 'saved-model', effort: 'low' } } });

  await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, config: suppliedConfig, yes: true } });

  const resumedState = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  const override = resumedState.data.configOverrides.at(-1);
  assert.deepEqual(resumedState.data.agentSettings, {});
  assert.equal(override.path, suppliedConfig);
  assert.deepEqual(override.values.gate, ['true']);
  assert.deepEqual(override.values.phases, ['gate']);
  assert.equal(override.values.maxRounds, 7);
});

test('resume fails clearly when its saved worktree is no longer available', async () => {
  const { root, workItem } = await repoFixture({ phases: ['gate'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  const missingWorktree = join(await mkdtemp(join(tmpdir(), 'loop-missing-worktree-')), 'removed');
  await state.record({ branch: 'feat/ss-demo-feature', worktree: missingWorktree, baseBranch: 'master' });

  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } }),
    /Saved worktree .* is unavailable/,
  );
});

test('a supplied resume config retains the saved branch and worktree', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ phases: ['gate'] });
  const savedWorktree = join(worktreeRoot, 'existing-run');
  await git(root, 'worktree', 'add', '-b', 'feat/saved-run', savedWorktree, 'master');
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ branch: 'feat/saved-run', worktree: savedWorktree, baseBranch: 'master' });
  const suppliedConfig = join(await mkdtemp(join(tmpdir(), 'loop-config-')), 'resume.config.mjs');
  await writeFile(suppliedConfig, "export default { branchPrefix: 'feat/other-', gate: ['true'], phases: ['gate'], worktrees: false };\n");

  const summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, config: suppliedConfig, dryRun: true, yes: true } });

  assert.equal(summary.branch, 'feat/saved-run');
  assert.equal(summary.worktree, savedWorktree);
});

test('a supplied config must exist and cannot be combined with an engine-only resume override', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement'] });
  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, config: 'missing.config.mjs', dryRun: true, yes: true } }),
    /Loop config file does not exist/,
  );
  await assert.rejects(
    runLoop({
      args: { taskFile: workItem, cwd: root, resume: true, config: 'loop.config.mjs', engine: 'agy', overrideEngine: true, dryRun: true, yes: true },
    }),
    /--config and --override-engine cannot be used together/,
  );
});

test('resume can override saved engines and records the change in state and phase logs', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'xhigh' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    agentSettings: { implement: { name: 'claude', model: 'saved-model', effort: 'low' } },
  });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'agy'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  const lines = [];
  process.env.PATH = `${binDir}:${originalPath}`;
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, engine: 'agy', overrideEngine: true, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  const resumedState = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.deepEqual(resumedState.data.agentSettings.implement, { name: 'agy', model: 'saved-model', effort: 'low' });
  assert.deepEqual(resumedState.data.engineOverrides.at(-1).phases.implement, {
    from: { name: 'claude', model: 'saved-model', effort: 'low' },
    to: { name: 'agy', model: 'saved-model', effort: 'low' },
  });
  assert.match(lines.join('\n'), /resumed engine override:[\s\S]*implement: claude model=saved-model effort=low → agy model=saved-model effort=low/);
  const phaseLog = await readFile(join(root, '.loop/runs/ss-demo-feature/implement.log'), 'utf8');
  assert.match(phaseLog, /resumed override: claude model=saved-model effort=low → agy model=saved-model effort=low/);
});

test('resume engine override validates a config-registered adapter', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command: ({ prompt }) => ({ command: 'mytool', args: [prompt] }) } },
  engines: { default: 'claude' },
  gate: ['true'],
  phases: ['implement'],
  worktrees: false,
};
` });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ agentSettings: { implement: { name: 'claude', effort: 'low' } } });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    const summary = await runLoop({
      args: { taskFile: workItem, cwd: root, resume: true, engine: 'mytool', overrideEngine: true, dryRun: true, yes: true },
    });
    assert.equal(summary.stalled, null);
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: mytool/);
  assert.match(lines.join('\n'), /resumed override: claude effort=low → mytool effort=low/);
});

test('resume engine override requires both resume and an engine', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement'] });
  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, engine: 'agy', overrideEngine: true, dryRun: true, yes: true } }),
    /--override-engine requires --resume/,
  );
  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, resume: true, overrideEngine: true, dryRun: true, yes: true } }),
    /--override-engine requires --engine/,
  );
});

test('a publishing phase stalls on a dirty worktree without invoking an agent', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['git'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');
  // An earlier phase leaving work uncommitted is exactly the state that used to
  // send the git agent into an uncommittable-repair spin until its timeout.
  await writeFile(join(worktree, 'DIRTY.txt'), 'uncommitted work\n');

  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['git'], yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'git');
  assert.match(summary.stalled.reason, /uncommitted changes/);
  assert.match(summary.stalled.output, /DIRTY\.txt/);
  assert.deepEqual(summary.phases, [], 'the stalled phase is not recorded as complete');
  assert.doesNotMatch(lines.join('\n'), /engine:/, 'no agent runs over the dirty tree');
});

test('a clean worktree passes the publishing precheck and runs the phase', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['git'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['git'], yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  assert.equal(summary.stalled, null, 'a clean tree does not trip the precheck');
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['git']);
});

test('unresolved review findings do not block a resume through the git phase', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['git'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');
  // A capped review left owed findings, but the tree is clean: this is the
  // "call it good enough and ship" path, and it must reach the git phase.
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    branch: 'feat/ss-demo-feature',
    worktree,
    baseBranch: 'master',
    rounds: { review: 3 },
    reviewedShas: { review: { 3: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 3,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'later' }] },
        nextRepair: 0,
      },
    },
  });

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, phases: ['git'], yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  assert.equal(summary.stalled, null, 'open findings on a clean tree do not block publishing');
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['git']);
});

test('resume keeps persisted settings for a nested repair phase', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'high' } },
  gate: ['true'],
  phases: ['review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    agentSettings: {
      review: { name: 'agy', model: 'saved-review', effort: 'low' },
      address: { name: 'agy', model: 'saved-address', effort: 'low' },
    },
    rounds: { review: 1 },
    reviewedShas: { review: { 1: 'abc123' } },
    pendingRepairs: {
      review: {
        round: 1,
        reviewedSha: 'abc123',
        verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }] },
        nextRepair: 0,
      },
    },
  });
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: agy\s+model: saved-address\s+effort: low/);
});

test('inline task only mode sets variables and adds no extra repo dir', async () => {
  const { root } = await repoFixture();
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({
      args: { task: 'Add --json flag', name: 'json-flag', cwd: root, dryRun: true, yes: true },
    });
  } finally {
    console.log = original;
  }
  assert.equal(summary.branch, 'feat/json-flag');
  assert.equal(summary.task, 'json-flag');
  assert.equal(summary.taskFile, null);

  const output = lines.join('\n');
  assert.match(output, /task\s+: json-flag/);
  assert.doesNotMatch(output, /task file\s+:/);
  assert.match(output, /Your task:\n\nAdd --json flag/);
  assert.match(output, /Your task:\n\nAdd --json flag[\s\S]*Take on the role of a senior developer/);
  assert.doesNotMatch(output, /Your task is described in/);
});

test('task file only mode derives slug and handles external repo dir', async () => {
  const { root } = await repoFixture();
  const externalRepo = await repoFixture();
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({
      args: { taskFile: externalRepo.workItem, cwd: root, dryRun: true, yes: true },
    });
  } finally {
    console.log = original;
  }
  assert.equal(summary.branch, 'feat/ss-demo-feature');
  assert.equal(summary.taskFile, externalRepo.workItem);

  const output = lines.join('\n');
  assert.match(output, new RegExp(`task file : ${externalRepo.workItem}`));
  assert.match(output, new RegExp(`Your task is described in \`${externalRepo.workItem}\``));
  assert.notEqual(externalRepo.root, root);

  const externalTaskRepo = await git(dirname(externalRepo.workItem), 'rev-parse', '--show-toplevel');
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  const capturedArgsFile = join(binDir, 'captured-args.json');
  await writeFile(
    join(binDir, 'claude'),
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capturedArgsFile)}, JSON.stringify(process.argv));
process.stdout.write('adapter args captured\\n');
`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await runLoop({
      args: { taskFile: externalRepo.workItem, cwd: root, phases: ['implement'], yes: true },
    });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
  }

  const capturedArgs = JSON.parse(await readFile(capturedArgsFile, 'utf8'));
  const addDirs = [];
  for (let i = 0; i < capturedArgs.length; i += 1) {
    if (capturedArgs[i] === '--add-dir' && capturedArgs[i + 1]) {
      addDirs.push(capturedArgs[i + 1]);
    }
  }

  assert.ok(addDirs.includes(externalTaskRepo), `expected adapter command args to include external repo dir ${externalTaskRepo}`);
  assert.notEqual(externalTaskRepo, root);
});

test('same-repository task file grants its source directory to the adapter', async () => {
  const { root } = await repoFixture();
  const taskFile = join(root, 'tasks', 'same-repo.md');
  await mkdir(dirname(taskFile), { recursive: true });
  await writeFile(taskFile, '# Same-repository task\n');

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  const capturedArgsFile = join(binDir, 'captured-args.json');
  await writeFile(
    join(binDir, 'claude'),
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capturedArgsFile)}, JSON.stringify(process.argv));
process.stdout.write('adapter args captured\\n');
`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({
      args: { taskFile, cwd: root, phases: ['implement'], yes: true },
    });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
  }

  const capturedArgs = JSON.parse(await readFile(capturedArgsFile, 'utf8'));
  const addDirs = [];
  for (let i = 0; i < capturedArgs.length; i += 1) {
    if (capturedArgs[i] === '--add-dir' && capturedArgs[i + 1]) {
      addDirs.push(capturedArgs[i + 1]);
    }
  }

  assert.notEqual(summary.worktree, root, 'the adapter should run in a separate worktree');
  assert.equal(summary.taskFile, taskFile);
  assert.ok(addDirs.includes(dirname(taskFile)), `expected adapter command args to include task-file directory ${dirname(taskFile)}`);
});

test('name-only mode runs with empty TASK and TASK_FILE', async () => {
  const { root } = await repoFixture();
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({
      args: { name: 'adhoc-run', cwd: root, dryRun: true, yes: true },
    });
  } finally {
    console.log = original;
  }
  assert.equal(summary.branch, 'feat/adhoc-run');
  assert.equal(summary.task, 'adhoc-run');
  assert.equal(summary.taskFile, null);

  const output = lines.join('\n');
  assert.match(output, /task\s+: adhoc-run/);
  assert.doesNotMatch(output, /task file\s+:/);
  assert.doesNotMatch(output, /Your task:\n\n/);
  assert.doesNotMatch(output, /Your task is described in/);
});

test('no identity provided throws a clear error', async () => {
  const { root } = await repoFixture();
  await assert.rejects(
    runLoop({ args: { cwd: root, dryRun: true, yes: true } }),
    /A run needs an identity: pass --name <slug>, or --task-file <path> to derive one\./,
  );
});

test('resuming with a conflicting identity flag throws an error', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ name: 'ss-demo-feature', taskFile: workItem });

  await assert.rejects(
    runLoop({
      args: { name: 'ss-demo-feature', taskFile: 'other-file.md', cwd: root, resume: true, dryRun: true, yes: true },
    }),
    /Saved run used task file .* cannot resume with --task-file/,
  );
});

test('resume task-file conflicts are rejected before stdin or state mutation', async () => {
  const { root } = await repoFixture();
  const realTaskFile = join(root, 'real-plan.md');
  await writeFile(realTaskFile, '# Real plan\n');
  const state = await RunState.open(join(root, '.loop/runs'), 'x', {});
  await state.record({ name: 'x', taskFile: realTaskFile });
  const stateBefore = await readFile(state.path, 'utf8');
  const { Readable } = await import('node:stream');
  const stdin = Readable.from(['replacement from stdin\n']);
  stdin.isTTY = false;
  const currentStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  try {
    await assert.rejects(
      runLoop({
        args: { taskFile: '-', name: 'x', cwd: root, resume: true, yes: true, phases: ['gate'] },
      }),
      /Saved run used task file .* cannot resume with --task-file/,
    );
    assert.equal(stdin.readableEnded, false, 'conflicting stdin must not be consumed');
  } finally {
    Object.defineProperty(process, 'stdin', { value: currentStdin, configurable: true });
  }
  assert.equal(await readFile(state.path, 'utf8'), stateBefore, 'state.json must remain unchanged');
});

test('resume inline task conflicts are rejected before state mutation', async () => {
  const { root } = await repoFixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'x', {});
  await state.record({ name: 'x', task: 'original requirements' });
  const stateBefore = await readFile(state.path, 'utf8');

  await assert.rejects(
    runLoop({
      args: {
        name: 'x',
        task: 'replacement requirements',
        cwd: root,
        resume: true,
        yes: true,
        phases: ['gate'],
      },
    }),
    /Saved run used task "original requirements"; cannot resume with --task "replacement requirements"\./,
  );

  assert.equal(await readFile(state.path, 'utf8'), stateBefore, 'state.json must remain unchanged');
});

test('task-file - reads stdin, writes to RUN_DIR/task.md, and restores path on resume', async () => {
  const { root } = await repoFixture();
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  let summary;
  try {
    const stream = Readable.from(['spec from stdin\n']);
    stream.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    summary = await runLoop({
      args: { taskFile: '-', name: 'stdin-task', cwd: root, dryRun: false, yes: true, phases: ['gate'] },
    });
    assert.equal(summary.task, 'stdin-task');
    const writtenPath = join(summary.runDir, 'task.md');
    assert.equal(summary.taskFile, writtenPath);
    const written = await readFile(writtenPath, 'utf8');
    assert.equal(written, 'spec from stdin\n');
  } finally {
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let resumedSummary;
  try {
    resumedSummary = await runLoop({
      args: { taskFile: '-', name: 'stdin-task', cwd: root, resume: true, dryRun: true, yes: true, phases: ['gate'] },
    });
  } finally {
    console.log = original;
  }
  const expectedPath = join(summary.runDir, 'task.md');
  assert.equal(resumedSummary.taskFile, expectedPath);
  const resumedOutput = lines.join('\n');
  assert.match(resumedOutput, new RegExp(`task file : ${expectedPath}`));
});

test('task-file - with empty stdin throws an error', async () => {
  const { root } = await repoFixture();
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  try {
    const stream = Readable.from([]);
    stream.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    await assert.rejects(
      runLoop({ args: { taskFile: '-', name: 'stdin-task', cwd: root, yes: true, phases: ['gate'] } }),
      /no data on stdin for --task-file -/,
    );
  } finally {
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
});

test('task-file - confirms through an injected terminal opener with piped stdin', async () => {
  const { root } = await repoFixture();
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  const openedInputs = [];
  try {
    const taskInput = Readable.from(['spec from stdin\n']);
    taskInput.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: taskInput, configurable: true });
    const summary = await runLoop({
      args: { taskFile: '-', name: 'stdin-task-confirmed', cwd: root, phases: ['gate'] },
      terminalOpener: async () => {
        const input = Readable.from(openedInputs.length === 0 ? [] : ['y\n']);
        openedInputs.push(input);
        return input;
      },
    });
    assert.equal(summary.stalled, null);
    assert.equal(openedInputs.length, 2, 'terminal opener must be used for availability and confirmation');
    assert.equal(openedInputs.every((input) => input.destroyed), true, 'terminal inputs must be closed');
  } finally {
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
});

test('a piped non-yes run without a controlling terminal gives an actionable error', async () => {
  const { root } = await repoFixture();
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  const taskInput = Readable.from(['spec from stdin\n']);
  taskInput.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: taskInput, configurable: true });
  try {
    await assert.rejects(
      runLoop({
        args: { taskFile: '-', name: 'stdin-no-terminal', cwd: root, phases: ['gate'] },
        terminalOpener: async () => { throw new Error('not attached to a terminal'); },
      }),
      /no terminal available to confirm phases; re-run with --yes to run unattended/,
    );
    assert.equal(taskInput.readableEnded, false, 'task stdin must not be consumed before terminal validation');
  } finally {
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
});

test('stalled resume hints preserve a named real task-file identity', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root } = await repoFixture({
    config: `export default {
  gate: ['false'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
`,
  });
  const taskFile = join(root, 'feature.md');
  await writeFile(taskFile, '# Feature\n');
  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { name: 'custom', taskFile, cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  const resumeLine = lines.find((line) => line.startsWith('Resume:'));
  assert.equal(resumeLine, `Resume:   aloop --name custom --task-file ${taskFile} --resume`);
});

test('stalled stdin resume hints use the saved name without the materialized path', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root } = await repoFixture({
    config: `export default {
  gate: ['false'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
`,
  });
  const { Readable } = await import('node:stream');
  const oldStdin = process.stdin;
  const stdin = Readable.from(['spec from stdin\n']);
  stdin.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: '-', name: 'stdin-stalled', cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
  const resumeLine = lines.find((line) => line.startsWith('Resume:'));
  assert.equal(resumeLine, 'Resume:   aloop --name stdin-stalled --resume');
  assert.doesNotMatch(resumeLine, /task\.md/);
});

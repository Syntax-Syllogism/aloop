import { mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseLoopArgs, runOperationalCommand as runCliOperationalCommand } from '../bin/loop.mjs';
import { defaults, normalizeCommandEntry, normalizeCommandList, normalizePhases, loadConfig, loadRunsDir } from '../src/config.mjs';
import { adapterFor, agentForPhase, createJsonlRenderer, engineForPhase, renderAgyEvent, renderClaudeEvent, renderGeminiEvent } from '../src/adapters.mjs';
import { interpolate, loadTemplate, packagePresets, packagePrompts, renderPrompt, resolvePresetPromptDir } from '../src/prompts.mjs';
import { parseVerdict, formatFindings } from '../src/verdict.mjs';
import { hashConfig, hashText } from '../src/manifest.mjs';
import { computeAggregateMetrics, computeRunMetrics } from '../src/metrics.mjs';
import { getAggregateMetrics, getRunStatus, init as initScaffold, listRunStatuses, runOperationalCommand } from '../src/operations.mjs';
import { slugFor, RunState } from '../src/state.mjs';
import { GitFacade } from '../src/git.mjs';
import { githubBackend, parsePullRequestDescription, publish } from '../src/publish.mjs';
import { runLoop, buildTaskContext } from '../src/pipeline.mjs';
import { hermeticEnvironment, hermeticInvocation, normalizeHermeticConfig, resolvePhaseHermetic } from '../src/hermetic.mjs';
import { phaseIsSkippable, publishingAttestation } from '../src/policy.mjs';
import { APPROVED } from '../src/verdict.mjs';
import { formatPhase } from '../src/reporter.mjs';
import workItemPreset from '../presets/work-item/loop.config.mjs';

const exec = promisify(execFile);

test('policy allows skipping only optional non-gate, non-verdict phases', () => {
  assert.equal(phaseIsSkippable({ optional: true, kind: 'agent' }), true);
  assert.equal(phaseIsSkippable({ optional: false, kind: 'agent' }), false);
  assert.equal(phaseIsSkippable({ optional: true, kind: 'gate' }), false);
  assert.equal(phaseIsSkippable({ optional: true, kind: 'agent', verdict: true }), false);
});

test('publishing policy requires a passing gate before the approved review', () => {
  const sha = 'a'.repeat(40);
  const state = { manifest: { entries: [
    { role: 'gate', status: 'completed', outputSha: sha },
    { role: 'verdict', status: 'completed', verdict: { verdict: APPROVED, sha } },
  ] } };
  assert.equal(publishingAttestation(state, sha), null);
  assert.match(publishingAttestation({ manifest: { entries: state.manifest.entries.slice(1) } }, sha).reason, /no passing gate receipt/);
});

test('reporter formats verdict rounds with singular and plural labels', () => {
  assert.equal(formatPhase({ name: 'review', rounds: 1, verdict: APPROVED }), '  ✓ review (1 round, APPROVED)');
  assert.equal(formatPhase({ name: 'review', rounds: 2, verdict: APPROVED }), '  ✓ review (2 rounds, APPROVED)');
});

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

async function openFixtureState(runs, slug, seed, options = {}) {
  return RunState.open(runs, slug, seed, { resume: true, ...options, lock: false });
}

async function createBranchWithCommit(root, branch, file, contents) {
  await git(root, 'checkout', '-b', branch);
  await writeFile(join(root, file), contents);
  await git(root, 'add', file);
  await git(root, 'commit', '-m', `feat: ${branch} work`);
  await git(root, 'checkout', 'master');
}

test('publish pushes an attested SHA and verifies a created pull request', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-'));
  const approvedSha = 'a'.repeat(40);
  const calls = [];
  let pullRequest = null;
  await writeFile(join(runDir, 'pr.md'), 'Title: Add the feature\n\nThis explains the change.\n');
  const result = await publish({
    git: {
      cwd: runDir,
      async push(...args) { calls.push(['push', ...args]); },
      async lsRemote(...args) { calls.push(['lsRemote', ...args]); return approvedSha; },
    },
    remote: 'origin',
    branch: 'feat/example',
    base: 'master',
    prBodyPath: join(runDir, 'pr.md'),
    approvedSha,
    backend: {
      async precheck() { calls.push(['precheck']); },
      async view() { calls.push(['view']); return pullRequest; },
      async create(options) {
        calls.push(['create', options.title, options.body]);
        pullRequest = {
          url: 'https://github.com/example/project/pull/42',
          number: 42,
          baseRefName: 'master',
          headRefOid: approvedSha,
          isDraft: true,
        };
      },
      async update() { throw new Error('create path expected'); },
    },
  });

  assert.equal(result.remoteSha, approvedSha);
  assert.equal(result.created, true);
  assert.equal(result.pullRequest.url, 'https://github.com/example/project/pull/42');
  assert.deepEqual(calls.map(([name]) => name), ['precheck', 'push', 'lsRemote', 'view', 'create', 'view']);
  assert.equal(await readFile(join(runDir, '.aloop-pr-body.md'), 'utf8').catch(() => null), null);
});

test('hermetic publishing rejects in-process custom backends', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-'));
  await writeFile(join(runDir, 'pr.md'), 'Title: Hermetic backend\n\nThe backend must be isolated.\n');
  let called = false;

  await assert.rejects(
    publish({
      git: {
        cwd: runDir,
        async push() { called = true; },
        async lsRemote() { return 'a'.repeat(40); },
      },
      remote: 'origin',
      branch: 'feat/example',
      base: 'master',
      prBodyPath: join(runDir, 'pr.md'),
      approvedSha: 'a'.repeat(40),
      env: { PATH: '/bin', GH_TOKEN: 'secret' },
      backend: {
        async precheck() {},
        async view() { return null; },
        async create() {},
        async update() {},
      },
    }),
    /does not support in-process custom backends/,
  );
  assert.equal(called, false);
});

test('publish fails closed before PR creation when the remote SHA diverges', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-'));
  const approvedSha = 'a'.repeat(40);
  let viewed = false;
  await writeFile(join(runDir, 'pr.md'), 'Title: Divergence\n\nThe remote moved.\n');

  await assert.rejects(
    publish({
      git: {
        cwd: runDir,
        async push() {},
        async lsRemote() { return 'b'.repeat(40); },
      },
      remote: 'origin',
      branch: 'feat/example',
      base: 'master',
      prBodyPath: join(runDir, 'pr.md'),
      approvedSha,
      backend: {
        async precheck() {},
        async view() { viewed = true; return null; },
        async create() {},
        async update() {},
      },
    }),
    /does not match approved SHA/,
  );
  assert.equal(viewed, false);
});

test('publish updates an existing pull request instead of creating a duplicate', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-'));
  const approvedSha = 'c'.repeat(40);
  const calls = [];
  const existing = {
    url: 'https://github.com/example/project/pull/7',
    number: 7,
    baseRefName: 'master',
    headRefOid: approvedSha,
    isDraft: true,
  };
  await writeFile(join(runDir, 'pr.md'), 'Title: Refresh the feature\n\nUpdated body.\n');

  const result = await publish({
    git: {
      cwd: runDir,
      async push() { calls.push('push'); },
      async lsRemote() { calls.push('lsRemote'); return approvedSha; },
    },
    remote: 'origin',
    branch: 'feat/example',
    base: 'master',
    prBodyPath: join(runDir, 'pr.md'),
    approvedSha,
    backend: {
      async precheck() { calls.push('precheck'); },
      async view() { calls.push('view'); return existing; },
      async create() { calls.push('create'); },
      async update(options) { calls.push(['update', options.title]); },
    },
  });

  assert.equal(result.created, false);
  assert.deepEqual(calls, ['precheck', 'push', 'lsRemote', 'view', ['update', 'Refresh the feature'], 'view']);
});

test('the GitHub publish backend drives gh and verifies the created draft PR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-publish-repo-'));
  const remoteRepo = await mkdtemp(join(tmpdir(), 'loop-publish-remote-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'config', 'user.email', 'loop@example.com');
  await git(root, 'config', 'user.name', 'Loop Test');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'chore: init');
  await git(remoteRepo, 'init', '--bare');
  await git(root, 'remote', 'add', 'origin', remoteRepo);
  await git(root, 'checkout', '-b', 'feat/publish');
  await writeFile(join(root, 'change.txt'), 'change\n');
  await git(root, 'add', 'change.txt');
  await git(root, 'commit', '-m', 'feat: publish fixture');
  const approvedSha = await git(root, 'rev-parse', 'HEAD');
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-run-'));
  await writeFile(join(runDir, 'pr.md'), 'Title: Publish fixture\n\nThis is a fixture PR.\n');
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  const prState = join(runDir, 'gh-pr.json');
  await writeFile(join(binDir, 'gh'), `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  if [ -f "$FAKE_PR_STATE" ]; then cat "$FAKE_PR_STATE"; exit 0; fi
  echo 'no pull requests found' >&2
  exit 1
fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  printf '%s\\n' '{"url":"https://github.com/example/project/pull/42","number":42,"baseRefName":"master","headRefOid":"'$FAKE_SHA'","isDraft":true}' > "$FAKE_PR_STATE"
  exit 0
fi
if [ "$1" = pr ] && [ "$2" = edit ]; then exit 0; fi
exit 1
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalSha = process.env.FAKE_SHA;
  const originalState = process.env.FAKE_PR_STATE;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FAKE_SHA = approvedSha;
  process.env.FAKE_PR_STATE = prState;
  const realGit = new GitFacade(root);
  const publishGit = {
    cwd: root,
    async remoteUrl() { return 'git@github.com:example/project.git'; },
    async revParse(...args) { return realGit.revParse(...args); },
    async push(...args) { return realGit.push(...args); },
    async lsRemote(...args) { return realGit.lsRemote(...args); },
  };
  try {
    const result = await publish({
      git: publishGit,
      remote: 'origin',
      branch: 'feat/publish',
      base: 'master',
      prBodyPath: join(runDir, 'pr.md'),
      draft: true,
    });
    assert.equal(result.pullRequest.number, 42);
    assert.equal(await git(root, 'ls-remote', 'origin', 'refs/heads/feat/publish').then((value) => value.split(/\s+/)[0]), approvedSha);
  } finally {
    process.env.PATH = originalPath;
    if (originalSha === undefined) delete process.env.FAKE_SHA;
    else process.env.FAKE_SHA = originalSha;
    if (originalState === undefined) delete process.env.FAKE_PR_STATE;
    else process.env.FAKE_PR_STATE = originalState;
  }
});

test('the GitHub publish backend binds every PR command to the configured remote repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-publish-repo-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:inferred/project.git');
  await git(root, 'remote', 'add', 'publish', 'git@github.com:configured/project.git');
  const approvedSha = 'd'.repeat(40);
  const runDir = await mkdtemp(join(tmpdir(), 'loop-publish-run-'));
  await writeFile(join(runDir, 'pr.md'), 'Title: Publish fixture\n\nThis is a fixture PR.\n');
  const ghCalls = [];
  let pullRequest = null;
  const repository = 'configured/project';
  const gitFacade = {
    cwd: root,
    async remoteUrl(remote) { return new GitFacade(root).remoteUrl(remote); },
    async push() {},
    async lsRemote() { return approvedSha; },
  };
  const backend = githubBackend({
    cwd: root,
    git: gitFacade,
    runner: async (command, args) => {
      assert.equal(command, 'gh');
      ghCalls.push(args);
      if (args[0] === 'auth') return { stdout: '', stderr: '' };
      assert.equal(args[args.indexOf('--repo') + 1], repository, 'PR commands must target the configured remote');
      if (args[1] === 'view') {
        if (!pullRequest) {
          const error = new Error('no pull requests found');
          error.output = 'no pull requests found';
          throw error;
        }
        return { stdout: JSON.stringify(pullRequest), stderr: '' };
      }
      if (args[1] === 'create') {
        pullRequest = {
          url: 'https://github.com/configured/project/pull/42',
          number: 42,
          baseRefName: 'master',
          headRefOid: approvedSha,
          isDraft: true,
        };
        return { stdout: '', stderr: '' };
      }
      if (args[1] === 'edit') return { stdout: '', stderr: '' };
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    },
  });

  const publishOptions = {
    git: gitFacade,
    remote: 'publish',
    branch: 'feat/publish',
    base: 'master',
    prBodyPath: join(runDir, 'pr.md'),
    approvedSha,
    backend,
  };
  await publish(publishOptions);
  await publish(publishOptions);

  assert.deepEqual(ghCalls.map((args) => args[0] === 'pr' ? args[1] : args[0]), [
    'auth', 'view', 'create', 'view', 'auth', 'view', 'edit', 'view',
  ]);
  for (const args of ghCalls.filter((args) => args[0] === 'pr')) {
    assert.equal(args[args.indexOf('--repo') + 1], repository);
  }
});

test('normalizePhases preserves the built-in plan with an explicit repair transition', () => {
  const phases = normalizePhases(defaults.phases, { maxRounds: 3 });
  assert.deepEqual(phases.map((phase) => phase.name), ['implement', 'docs', 'gate', 'review', 'pr-description', 'publish']);
  const review = phases.find((phase) => phase.name === 'review');
  assert.equal(review.maxRounds, 3);
  assert.deepEqual(review.repair.map((phase) => phase.name), ['address', 'gate']);
  assert.equal(review.repair.at(-1).recheck, true, 'the trailing gate re-runs after repair');
  assert.deepEqual(review.postconditions, ['verdict-recorded']);
  assert.deepEqual(review.permissions, ['read-only']);
  assert.deepEqual(review.repair[0].permissions, ['write-worktree']);
  assert.deepEqual(phases.find((phase) => phase.name === 'implement').permissions, ['write-worktree']);
  assert.deepEqual(phases.find((phase) => phase.name === 'publish').permissions, ['publish']);
  assert.deepEqual(phases.find((phase) => phase.name === 'implement').postconditions, ['clean-tree', 'head-advanced']);
});

test('the work-item preset puts docs before the gated review loop', () => {
  assert.deepEqual(workItemPreset.phases, ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish']);
});

test('normalizePhases leaves an explicitly repair-free verdict phase unlooped', () => {
  const phases = normalizePhases(['review'], { maxRounds: 2 });
  assert.deepEqual(phases[0].repair, []);
});

test('normalizePhases drops the default gate recheck when address is absent', () => {
  const phases = normalizePhases(['gate', 'review'], { maxRounds: 2 });
  assert.deepEqual(phases.map((phase) => phase.name), ['gate', 'review']);
  assert.deepEqual(phases[1].repair, []);
});

test('normalizePhases keeps retry attempts separate from verdict rounds', () => {
  const phases = normalizePhases([
    { name: 'check', kind: 'agent', verdict: true, retry: { maxAttempts: 2 }, repair: [] },
  ], { maxRounds: 3 });
  assert.equal(phases[0].retry.maxAttempts, 2);
  assert.equal(phases[0].maxRounds, 3);
});

test('normalizePhases resolves a standalone gate repair transition', () => {
  const phases = normalizePhases([
    {
      name: 'gate',
      repair: [{ name: 'fix-gate', kind: 'agent', role: 'repair', prompt: 'fix-gate', permissions: ['write-worktree'] }],
    },
  ], { maxRounds: 2 });
  assert.equal(phases[0].maxRounds, 2);
  assert.deepEqual(phases[0].repair.map((phase) => phase.name), ['fix-gate']);
});

test('normalizePhases rejects a repair phase not named by a verdict transition', () => {
  assert.throws(() => normalizePhases(['address'], { maxRounds: 3 }), /must be declared by a phase that emits a verdict/);
});

test('normalizePhases does not infer a repair loop from adjacency', () => {
  assert.throws(
    () => normalizePhases([
      { name: 'check', kind: 'agent', verdict: true, prompt: 'review' },
      { name: 'fix', kind: 'agent', role: 'repair', prompt: 'address' },
    ], { maxRounds: 3 }),
    /must be declared by a phase that emits a verdict/,
  );
});

test('normalizePhases accepts an explicit custom repair transition', () => {
  const phases = normalizePhases([
    { name: 'check', kind: 'agent', verdict: true, prompt: 'review', repair: ['fix'] },
    { name: 'fix', kind: 'agent', role: 'repair', prompt: 'address', postconditions: ['clean-tree'] },
  ], { maxRounds: 3 });
  assert.deepEqual(phases.map((phase) => phase.name), ['check']);
  assert.deepEqual(phases[0].repair.map((phase) => phase.name), ['fix']);
});

test('normalizePhases accepts a standalone inline repair descriptor', () => {
  const phases = normalizePhases([
    {
      name: 'check',
      kind: 'agent',
      verdict: true,
      prompt: 'review',
      repair: [{ name: 'fix', kind: 'agent', role: 'repair', prompt: 'address' }],
    },
  ], { maxRounds: 3 });

  assert.deepEqual(phases.map((phase) => phase.name), ['check']);
  assert.deepEqual(phases[0].repair.map((phase) => phase.name), ['fix']);
  assert.equal(phases[0].repair[0].role, 'repair');
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
  assert.equal(phases[1].optional, false);
});

test('normalizePhases makes custom phases optional only for literal true', () => {
  const phases = normalizePhases(
    [
      { name: 'explicitly-optional', kind: 'agent', optional: true },
      { name: 'string-false', kind: 'agent', optional: 'false' },
    ],
    { maxRounds: 3 },
  );
  assert.deepEqual(phases.map((phase) => phase.optional), [true, false]);
});

test('normalizePhases gives custom phases a safe permission default and rejects unknown permissions', () => {
  const phases = normalizePhases([
    { name: 'custom', kind: 'agent' },
    { name: 'custom-gate', kind: 'gate', commands: ['true'] },
    { name: 'custom-publish', kind: 'publish' },
  ], { maxRounds: 3 });
  assert.deepEqual(phases.map((phase) => phase.permissions), [['read-only'], ['read-only'], ['publish']]);
  assert.throws(
    () => normalizePhases([{ name: 'unsafe', kind: 'agent', permissions: ['dangerous'] }], { maxRounds: 3 }),
    /has invalid permissions; expected read-only, write-worktree, publish/,
  );
});

test('normalizePhases marks only docs optional by default', () => {
  const phases = normalizePhases(['implement', 'docs', 'gate', 'review', 'publish'], { maxRounds: 3 });
  assert.deepEqual(phases.map((phase) => phase.optional), [false, true, false, false, false]);
});

test('a required gate cannot be skipped interactively', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: ['true'],
  phases: ['gate', 'publish'],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const confirmInput = new PassThrough();
  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => {
    lines.push(String(message));
    if (String(message).includes('gate is required and cannot be skipped')) confirmInput.end('q\n');
  };
  let summary;
  try {
    const run = runLoop({ args: { taskFile: workItem, cwd: root }, confirmInput });
    confirmInput.write('n\n');
    summary = await run;
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.deepEqual(summary.phases, []);
  assert.deepEqual(summary.stalled, { phase: 'gate', reason: 'required phase not run (skipped by user)' });
  assert.match(lines.join('\n'), /gate is required and cannot be skipped/);
  assert.doesNotMatch(lines.join('\n'), /── publish/);
});

test('a verdict phase cannot be skipped even when configured optional', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  phases: [{ name: 'review', kind: 'agent', prompt: 'review', verdict: true, optional: true }],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const confirmInput = new PassThrough();
  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => {
    lines.push(String(message));
    if (String(message).includes('review is required and cannot be skipped')) confirmInput.end('q\n');
  };
  let summary;
  try {
    const run = runLoop({ args: { taskFile: workItem, cwd: root }, confirmInput });
    confirmInput.write('n\n');
    summary = await run;
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.deepEqual(summary.phases, []);
  assert.deepEqual(summary.stalled, { phase: 'review', reason: 'required phase not run (skipped by user)' });
  assert.match(lines.join('\n'), /review is required and cannot be skipped/);
});

test('an optional docs phase can still be skipped interactively', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  phases: ['docs'],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const confirmInput = new PassThrough();
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    const run = runLoop({ args: { taskFile: workItem, cwd: root }, confirmInput });
    confirmInput.end('n\n');
    summary = await run;
  } finally {
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases, []);
  assert.match(lines.join('\n'), /skipped docs/);
});

test('the publish phase requires a clean worktree before it runs', () => {
  const phases = normalizePhases(['publish'], { maxRounds: 3 });
  assert.equal(phases[0].requiresCleanTree, true);
});

test('loadConfig rejects a gate phase with no commands', async () => {
  const { root } = await repoFixture({ config: 'export default { gate: [] };\n' });
  await assert.rejects(loadConfig(root), /gate phase but no gate commands/);
});

test('loadConfig rejects commit phases after the final verdict before publishing', async () => {
  const { root } = await repoFixture({
    phases: ['implement', 'gate', 'review', 'address', 'docs', 'pr-description', 'publish'],
  });
  await assert.rejects(
    loadConfig(root),
    /docs commit after the "review" verdict but before "publish" publishes/,
  );
});

test('loadConfig accepts docs before the gated review loop', async () => {
  const { root } = await repoFixture({
    phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  });
  const config = await loadConfig(root);
  assert.deepEqual(config.resolvedPhases.map((phase) => phase.name), [
    'implement', 'docs', 'gate', 'review', 'pr-description', 'publish',
  ]);
  assert.deepEqual(config.resolvedPhases.find((phase) => phase.name === 'review').repair.map((phase) => phase.name), [
    'address', 'gate',
  ]);
});

test('loadConfig accepts commit phases after review when nothing publishes', async () => {
  const { root } = await repoFixture({ phases: ['implement', 'gate', 'review', 'address', 'docs'] });
  await assert.doesNotReject(loadConfig(root));
});

test('loadConfig accepts a publishing pipeline with no verdict phase', async () => {
  const { root } = await repoFixture({ phases: ['implement', 'gate', 'publish'] });
  await assert.doesNotReject(loadConfig(root));
});

test('loadConfig rejects custom commit-producing phases after review before publishing', async () => {
  const { root } = await repoFixture({
    phases: [
      'implement',
      'gate',
      'review',
      { name: 'generate-artifact', kind: 'agent', outputs: ['commit'] },
      'pr-description',
      'publish',
    ],
  });
  await assert.rejects(loadConfig(root), /generate-artifact commit after the "review" verdict/);
});

test('loadConfig rejects commit phases between the description and actual publish phases', async () => {
  const { root } = await repoFixture({
    phases: ['implement', 'gate', 'review', 'pr-description', 'docs', 'publish'],
  });
  await assert.rejects(
    loadConfig(root),
    /docs commit after the "review" verdict but before "publish" publishes/,
  );
});

test('loadConfig checks an early publish against its latest preceding verdict', async () => {
  const { root } = await repoFixture({
    phases: [
      'implement',
      'gate',
      'review',
      'docs',
      'publish',
      { name: 'final-review', kind: 'agent', prompt: 'review', verdict: true, role: 'verdict', repair: [] },
    ],
  });
  await assert.rejects(
    loadConfig(root),
    /docs commit after the "review" verdict but before "publish" publishes/,
  );
});

test('loadConfig merges overrides over the config file', async () => {
  const { root } = await repoFixture();
  const config = await loadConfig(root, { maxRounds: 7, engines: { review: 'codex' } });
  assert.equal(config.maxRounds, 7);
  assert.deepEqual(config.setup, []);
  assert.equal(config.shell, null);
  assert.equal(engineForPhase(config, 'review'), 'codex');
  assert.equal(engineForPhase(config, 'implement'), 'claude');
});

test('loadConfig exposes the preset key and defaults it to null', async () => {
  const { root } = await repoFixture({ config: "export default { preset: 'work-item', gate: ['true'] };\n" });
  const config = await loadConfig(root);
  assert.equal(config.preset, 'work-item');
  assert.equal(defaults.preset, null);
  const invalidRoot = await repoFixture({ config: "export default { preset: '   ' };\n" });
  await assert.rejects(loadConfig(invalidRoot.root), /`preset` must be null or a non-empty string/);
});

test('loadConfig rejects an empty configured shell', async () => {
  const { root } = await repoFixture({ config: 'export default { shell: "  " };\n' });
  await assert.rejects(loadConfig(root), /`shell` must be null \(auto-detect\) or a non-empty string/);
});

test('normalizeCommandEntry accepts string, argv, and per-platform forms', () => {
  assert.deepEqual(
    normalizeCommandEntry('npm test', { label: 'gate', index: 0 }),
    { kind: 'shell', shellString: 'npm test', display: 'npm test' },
  );
  assert.deepEqual(
    normalizeCommandEntry({ argv: ['npm', 'ci'] }, { label: 'setup', index: 0 }),
    { kind: 'argv', argv: ['npm', 'ci'], display: 'npm ci' },
  );
  assert.deepEqual(
    normalizeCommandEntry({ posix: 'npm test', windows: 'npm.cmd test' }, { label: 'gate', index: 0, platform: 'win32' }),
    { kind: 'shell', shellString: 'npm.cmd test', display: 'npm.cmd test' },
  );
  assert.deepEqual(
    normalizeCommandEntry({ posix: 'npm test', windows: 'npm.cmd test' }, { label: 'gate', index: 0, platform: 'linux' }),
    { kind: 'shell', shellString: 'npm test', display: 'npm test' },
  );
});

test('normalizeCommandEntry tags pwsh/cmd variants with a shellHint that pins the resolved shell', () => {
  assert.deepEqual(
    normalizeCommandEntry({ posix: 'npm test', pwsh: 'npm test' }, { label: 'gate', index: 0, platform: 'win32' }),
    { kind: 'shell', shellString: 'npm test', display: 'npm test', shellHint: 'pwsh' },
  );
  assert.deepEqual(
    normalizeCommandEntry({ posix: 'npm test', cmd: 'npm test' }, { label: 'gate', index: 0, platform: 'win32' }),
    { kind: 'shell', shellString: 'npm test', display: 'npm test', shellHint: 'cmd' },
  );
  // `windows` is the generic key; it does not pin a specific shell.
  assert.deepEqual(
    normalizeCommandEntry({ posix: 'npm test', windows: 'npm test', pwsh: 'npm test' }, { label: 'gate', index: 0, platform: 'win32' }),
    { kind: 'shell', shellString: 'npm test', display: 'npm test' },
  );
});

test('normalizeCommandEntry rejects invalid entries with a phase-named message', () => {
  assert.throws(
    () => normalizeCommandEntry('   ', { label: 'gate', index: 2 }),
    /gate\[2\] must be a non-empty command string/,
  );
  assert.throws(
    () => normalizeCommandEntry({ argv: 'npm ci' }, { label: 'setup', index: 1 }),
    /setup\[1\]\.argv must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => normalizeCommandEntry({ argv: [] }, { label: 'setup', index: 1 }),
    /setup\[1\]\.argv must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => normalizeCommandEntry(42, { label: 'gate', index: 0 }),
    /gate\[0\] must be a command string, \{ argv: \[\.\.\.\] \}, or a per-platform command object/,
  );
  assert.throws(
    () => normalizeCommandEntry({}, { label: 'gate', index: 0 }),
    /gate\[0\] must define `argv` or at least one of posix, windows, pwsh, cmd/,
  );
});

test('normalizeCommandEntry fails fast when the current platform has no matching variant', () => {
  assert.throws(
    () => normalizeCommandEntry({ posix: 'npm test' }, { label: 'phases.gate.gate', index: 0, platform: 'win32' }),
    /phases\.gate\.gate\[0\] has no `windows` \(or `pwsh`\/`cmd`\) variant.*only posix defined/,
  );
  assert.throws(
    () => normalizeCommandEntry({ windows: 'npm.cmd test' }, { label: 'gate', index: 0, platform: 'linux' }),
    /gate\[0\] has no `posix` variant.*only windows defined/,
  );
});

test('normalizeCommandList validates the whole array and rejects non-array input', () => {
  assert.deepEqual(
    normalizeCommandList(['true', { argv: ['npm', 'test'] }], { label: 'gate' }),
    [
      { kind: 'shell', shellString: 'true', display: 'true' },
      { kind: 'argv', argv: ['npm', 'test'], display: 'npm test' },
    ],
  );
  assert.throws(() => normalizeCommandList('true', { label: 'gate' }), /`gate` must be an array of commands/);
});

test('loadConfig fails fast on a posix-only gate command when the host is Windows', async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const { root } = await repoFixture({ config: "export default { gate: [{ posix: 'npm test' }] };\n" });
    await assert.rejects(loadConfig(root), /gate\[0\] has no `windows`/);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('loadConfig accepts argv and per-platform gate commands on the current platform', async () => {
  const { root } = await repoFixture({
    config: `export default {
  gate: [{ argv: ['true'] }, { posix: 'true', windows: 'cmd /c exit 0' }],
};
`,
  });
  const config = await loadConfig(root);
  assert.deepEqual(config.gate, [{ argv: ['true'] }, { posix: 'true', windows: 'cmd /c exit 0' }]);
});

test('loadConfig validates run budget limits', async () => {
  const { root } = await repoFixture({ config: `export default {
  budget: { tokens: 12, usd: 0.75, wallClockMs: 5000 },
  gate: ['true'],
};
` });
  const config = await loadConfig(root);
  assert.deepEqual(config.budget, { tokens: 12, usd: 0.75, wallClockMs: 5000 });

  await writeFile(join(root, 'loop.config.mjs'), 'export default { budget: { tokens: 1.5 } };\n');
  await assert.rejects(loadConfig(root), /budget\.tokens.*nonnegative integer/);
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

test('a normal agent phase honors retry.maxAttempts', async () => {
  const attemptScript = `
const fs = require('node:fs');
const path = 'attempts';
const attempt = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) + 1 : 1;
fs.writeFileSync(path, String(attempt));
if (attempt < 2) process.exit(1);
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    mytool: {
      command({ prompt }) {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(attemptScript)}, prompt] };
      },
    },
  },
  engines: { default: 'mytool' },
  phases: [{ name: 'recoverable', kind: 'agent', prompt: 'docs', permissions: ['write-worktree'], retry: { maxAttempts: 2 } }],
  worktrees: false,
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
  assert.equal(await readFile(join(root, 'attempts'), 'utf8'), '2');
});

test('a verdict phase honors retry.maxAttempts independently of maxRounds', async () => {
  const verdictScript = `
const fs = require('node:fs');
const path = require('node:path');
const prompt = process.argv[1];
const verdictPath = prompt.match(/write this JSON to \`([^\`]+)\`/)[1];
const attemptsPath = path.join(path.dirname(verdictPath), 'verdict-attempts');
const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempt));
if (attempt < 2) process.exit(1);
fs.writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    mytool: {
      command({ prompt }) {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(verdictScript)}, prompt] };
      },
    },
  },
  engines: { default: 'mytool' },
  phases: [{ name: 'review', kind: 'agent', verdict: true, repair: [], maxRounds: 1, retry: { maxAttempts: 2 } }],
  worktrees: false,
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
  assert.equal(summary.phases[0].rounds, 1);
  assert.equal(await readFile(join(summary.runDir, 'verdict-attempts'), 'utf8'), '2');
});

test('a publish retry budget bounds push and PR attempts', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-publish-retry-trees-'));
  const attemptsPath = join(await mkdtemp(join(tmpdir(), 'loop-publish-retry-')), 'attempts');
  const { root, workItem } = await repoFixture({ config: `
import { appendFile } from 'node:fs/promises';

const backend = {
  async precheck() {},
  async view() { return null; },
  async create() {
    await appendFile(process.env.PUBLISH_ATTEMPTS, 'create\\n');
    throw new Error('transient publish failure');
  },
  async update() {},
};

export default {
  gate: ['true'],
  remote: 'origin',
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
  publish: { backend, draft: true },
  phases: ['gate', 'review', 'pr-description', { name: 'publish', retry: { maxAttempts: 2 } }],
};
` });
  const remoteRepo = await mkdtemp(join(tmpdir(), 'loop-publish-retry-remote-'));
  await git(remoteRepo, 'init', '--bare');
  await git(root, 'remote', 'add', 'origin', remoteRepo);

  const binDir = await mkdtemp(join(tmpdir(), 'loop-publish-retry-bin-'));
  const realGitPath = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(join(binDir, 'git'), `#!/bin/sh
if [ "$1" = push ]; then printf '%s\\n' push >> "$PUBLISH_ATTEMPTS"; fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *'Take on the role of a senior developer'*)
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[]}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Write \`'*'/pr.md'*)
    printf '%s\\n\\n%s\\n' 'Title: Retry fixture' 'The description is ready.' > "$FIXTURE_PR_PATH"
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalAttempts = process.env.PUBLISH_ATTEMPTS;
  const originalRealGit = process.env.REAL_GIT;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalPrPath = process.env.FIXTURE_PR_PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.PUBLISH_ATTEMPTS = attemptsPath;
  process.env.REAL_GIT = realGitPath;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  process.env.FIXTURE_PR_PATH = join(root, '.loop/runs/ss-demo-feature/pr.md');
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalAttempts === undefined) delete process.env.PUBLISH_ATTEMPTS;
    else process.env.PUBLISH_ATTEMPTS = originalAttempts;
    if (originalRealGit === undefined) delete process.env.REAL_GIT;
    else process.env.REAL_GIT = originalRealGit;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    if (originalPrPath === undefined) delete process.env.FIXTURE_PR_PATH;
    else process.env.FIXTURE_PR_PATH = originalPrPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'publish');
  const attempts = (await readFile(attemptsPath, 'utf8')).trim().split('\n');
  assert.deepEqual(attempts, ['push', 'create', 'push', 'create']);
});

test('a verdict retry cannot consume an artifact from a failed attempt', async () => {
const verdictScript = `
const fs = require('node:fs');
const { dirname, join } = require('node:path');
const prompt = process.argv[1];
const verdictPath = prompt.match(/write this JSON to \`([^\`]+)\`/)[1];
const path = join(dirname(verdictPath), 'verdict-attempts');
const attempt = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) + 1 : 1;
fs.writeFileSync(path, String(attempt));
if (attempt === 1) {
  fs.writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
  process.exit(1);
}
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    mytool: {
      command({ prompt }) {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(verdictScript)}, prompt] };
      },
    },
  },
  engines: { default: 'mytool' },
  phases: [{ name: 'review', kind: 'agent', verdict: true, repair: [], maxRounds: 1, retry: { maxAttempts: 2 } }],
  worktrees: false,
};
` });
  const original = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, yes: true } }),
      /did not write a verdict/,
    );
  } finally {
    console.log = original;
  }

  assert.equal(await readFile(join(root, '.loop/runs/ss-demo-feature', 'verdict-attempts'), 'utf8'), '2');
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

test('preset prompt resolution supports bundled, external, and unset values', async () => {
  const bundled = await resolvePresetPromptDir('work-item');
  assert.equal(bundled, join(packagePresets, 'work-item', 'prompts'));
  assert.equal(await resolvePresetPromptDir(''), null);
  assert.equal(await resolvePresetPromptDir('   '), null);
  await assert.rejects(resolvePresetPromptDir('missing'), /Unknown preset "missing"\. Available: work-item/);

  const root = await mkdtemp(join(tmpdir(), 'loop-preset-'));
  await mkdir(join(root, 'preset', 'prompts'), { recursive: true });
  assert.equal(await resolvePresetPromptDir('./preset', { cwd: root }), join(root, 'preset', 'prompts'));
  await assert.rejects(resolvePresetPromptDir('./missing', { cwd: root }), /Preset directory has no prompts/);
});

test('loadTemplate searches project overrides, preset overrides, then packaged prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-prompt-chain-'));
  const project = join(root, 'project');
  const preset = join(root, 'preset');
  await mkdir(project);
  await mkdir(preset);
  await writeFile(join(project, 'implement.md'), 'project');
  await writeFile(join(preset, 'docs.md'), 'preset');

  assert.equal((await loadTemplate('implement', { promptDirs: [project, preset] })).body, 'project');
  assert.equal((await loadTemplate('docs', { promptDirs: [project, preset] })).body, 'preset');
  assert.equal((await loadTemplate('review', { promptDirs: [project, preset] })).path, join(packagePrompts, 'review.md'));
});

test('default prompts render cleanly for every task input mode', async () => {
  const promptNames = ['implement', 'review', 'address', 'docs', 'pr-description'];
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

  assert.deepEqual(promptFiles.sort(), ['address.md', 'docs.md', 'fix-gate.md', 'implement.md', 'pr-description.md', 'review.md']);
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
  assert.throws(
    () => parseVerdict('{"verdict":"APPROVED","blocking":[{"issue":"must fix"}]}'),
    /APPROVED.*1 blocking findings/,
  );
});

test('parseVerdict validates blocking and nit finding shapes', () => {
  const malformedFindings = [
    ['{}', /blocking\[0\] is malformed: expected a non-empty issue or summary string/],
    ['{"issue":"valid","file":1}', /blocking\[0\] is malformed: file must be a string/],
    ['{"issue":"valid","line":"1"}', /blocking\[0\] is malformed: line must be a number/],
  ];

  for (const [finding, message] of malformedFindings) {
    assert.throws(
      () => parseVerdict(`{"verdict":"CHANGES_REQUESTED","blocking":[${finding}]}`),
      /** @type {any} */ (message),
    );
  }
  assert.throws(
    () => parseVerdict('{"verdict":"APPROVED","nits":[[]]}'),
    /nits\[0\] is malformed: expected an object/,
  );
  assert.throws(
    () => parseVerdict('{"verdict":"APPROVED","blocking":[{}]}'),
    /blocking\[0\] is malformed: expected a non-empty issue or summary string/,
  );
  assert.doesNotThrow(() => parseVerdict('{"verdict":"APPROVED","blocking":[]}'));
});

test('parseVerdict rejects non-array finding collections', () => {
  assert.throws(
    () => parseVerdict('{"verdict":"APPROVED","blocking":"must fix"}'),
    /blocking must be an array/,
  );
  assert.throws(
    () => parseVerdict('{"verdict":"APPROVED","nits":{}}'),
    /nits must be an array/,
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
  const request = {
    prompt: 'do it', cwd: '/w', addDirs: ['/runs', '/wiki'], timeoutMs: 60000, permissions: ['write-worktree'],
  };
  for (const engine of ['claude', 'codex', 'agy', 'gemini']) {
    const { command, args, input } = adapterFor(engine).command(request);
    assert.equal(command, engine);
    // gemini carries the prompt on stdin (`input`) to dodge the cmd.exe
    // command-line limit on Windows; the others place it on the command line.
    assert.ok(args.includes('do it') || input === 'do it', `${engine} passes the prompt`);
    assert.ok(args.includes('/runs') && args.includes('/wiki'), `${engine} passes add-dirs`);
  }
  assert.throws(() => adapterFor('gpt'), /Unsupported engine "gpt".*claude, codex, agy, gemini/);
});

test('configured adapters override built-ins and unknown errors list configured names', () => {
  const customClaude = { command: () => ({ command: 'custom-claude', args: [] }) };
  assert.equal(adapterFor('claude', { claude: customClaude }), customClaude);
  assert.throws(
    () => adapterFor('missing', { mytool: customClaude }),
    /Unsupported engine "missing".*claude, codex, agy, gemini, mytool/,
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
  const args = adapterFor('claude').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['write-worktree'] }).args;
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'streams events');
  assert.ok(args.includes('--verbose'), 'stream-json needs verbose to emit every event');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto', 'a non-interactive run cannot answer a prompt');
  assert.equal(args.includes('text'), false, 'text output withholds every byte until exit');
});

test('built-in adapters map read-only permissions to their safest modes', () => {
  const claude = adapterFor('claude').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['read-only'] }).args;
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'plan');

  const codex = adapterFor('codex').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['read-only'] }).args;
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');

  const agy = adapterFor('agy').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['read-only'] }).args;
  assert.equal(agy[agy.indexOf('--mode') + 1], 'plan');
  assert.equal(agy.includes('--dangerously-skip-permissions'), false);

  const gemini = adapterFor('gemini').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['read-only'] }).args;
  assert.equal(gemini[gemini.indexOf('--approval-mode') + 1], 'plan');
  assert.equal(gemini.includes('yolo'), false);
});

test('built-in adapters scope artifact-only writes away from the worktree', () => {
  const request = {
    prompt: 'do it',
    cwd: '/runs/example',
    addDirs: ['/runs/example', '/wiki', '/source-snapshot'],
    readOnlyDirs: ['/worktree/example'],
    permissions: ['read-only'],
    artifactOnly: true,
  };
  const claude = adapterFor('claude').command(request).args;
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(claude.includes('/source-snapshot'));
  assert.equal(claude.includes('/worktree/example'), false);

  const codex = adapterFor('codex').command(request).args;
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(codex[codex.indexOf('--cd') + 1], '/runs/example');
  assert.ok(codex.includes('/source-snapshot'));
  assert.equal(codex.includes('/worktree/example'), false, 'Codex never gets a writable worktree root');

  const agy = adapterFor('agy').command(request).args;
  assert.equal(agy[agy.indexOf('--mode') + 1], 'accept-edits');
  assert.ok(agy.includes('--dangerously-skip-permissions'));
  assert.ok(agy.includes('/source-snapshot'));
  assert.equal(agy.includes('/worktree/example'), false);

  const gemini = adapterFor('gemini').command(request).args;
  assert.equal(gemini[gemini.indexOf('--approval-mode') + 1], 'yolo');
  assert.ok(gemini.includes('--skip-trust'));
  assert.ok(gemini.includes('/source-snapshot'));
  assert.equal(gemini.includes('/worktree/example'), false);
});

test('a native Codex artifact-only review isolates source reads from worktree writes', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  engines: { default: 'codex' },
  phases: ['review'],
  worktrees: false,
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'codex'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
const prompt = args[args.indexOf('exec') + 1];
const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
const runDir = dirname(verdictPath);
const taskDir = ${JSON.stringify(dirname(workItem))};
const taskFile = ${JSON.stringify(workItem)};
const worktree = process.env.FIXTURE_WORKTREE;
const addDirs = args.flatMap((value, index) => value === '--add-dir' ? [args[index + 1]] : []);
const sourceDir = prompt.match(/worktree at \x60([^\x60]+)\x60/)[1];

// A native Codex invocation treats every --add-dir as writable. If the real
// worktree is ever granted that way, fail before touching it.
if (addDirs.includes(worktree)) {
  writeFileSync(join(worktree, 'native-worktree-write.txt'), 'must be denied');
  process.exit(3);
}
if (!addDirs.includes(sourceDir) || sourceDir === worktree) process.exit(4);
writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
writeFileSync(join(runDir, 'review-round-1.md'), 'review complete\\n');
writeFileSync(join(runDir, 'README.md'), 'artifact cwd\\n');
writeFileSync(join(runDir, 'custom-cwd.txt'), process.cwd());
writeFileSync(join(runDir, 'source-read.md'), readFileSync(join(sourceDir, 'README.md')));
if (addDirs.includes(taskDir)) appendFileSync(taskFile, '\\n## Code Review\\n\\nReview complete.\\n');
` , { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_WORKTREE = root;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# fixture\n');
  assert.equal(await readFile(join(summary.runDir, 'README.md'), 'utf8'), 'artifact cwd\n');
  const reviewCwd = (await readFile(join(summary.runDir, 'custom-cwd.txt'), 'utf8')).trim();
  assert.notEqual(reviewCwd, summary.runDir);
  assert.match(reviewCwd, /aloop-source-[^/]+\/repo$/);
  assert.equal(await readFile(join(summary.runDir, 'review-round-1.md'), 'utf8'), 'review complete\n');
  assert.equal(await readFile(join(summary.runDir, 'source-read.md'), 'utf8'), '# fixture\n');
  assert.match(await readFile(workItem, 'utf8'), /## Code Review/);
});

test('a native Codex pr-description phase does not receive the external task-file repo as writable', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  engines: { default: 'codex' },
  phases: ['pr-description'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'codex'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
const prompt = args[args.indexOf('exec') + 1];
const prPath = prompt.slice(prompt.indexOf('Write ')).split(String.fromCharCode(96))[1];
const taskDir = ${JSON.stringify(dirname(workItem))};
const addDirs = args.flatMap((value, index) => value === '--add-dir' ? [args[index + 1]] : []);

// pr-description only writes RUN_DIR/pr.md; only the verdict (review) phase's
// prompt is instructed to edit the external task-file repo. Receiving it as
// writable here would be a privilege leak — fail before touching it.
if (addDirs.includes(taskDir)) {
  writeFileSync(taskDir + '/native-task-file-write.txt', 'must be denied');
  process.exit(3);
}
writeFileSync(join(dirname(prPath), 'custom-cwd.txt'), process.cwd());
writeFileSync(prPath, 'Title: fixture pr\\n\\nBody text.\\n');
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(summary.runDir, 'pr.md'), 'utf8'), 'Title: fixture pr\n\nBody text.\n');
  const descriptionCwd = (await readFile(join(summary.runDir, 'custom-cwd.txt'), 'utf8')).trim();
  assert.notEqual(descriptionCwd, summary.runDir);
  assert.match(descriptionCwd, /aloop-source-[^/]+\/repo$/);
  assert.equal(await readFile(join(dirname(workItem), 'native-task-file-write.txt'), 'utf8').catch(() => null), null);
});

test('an unaware custom read-only adapter starts in the source snapshot', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    unaware: {
      command: ({ prompt }) => ({
        command: process.execPath,
        args: ['-e', ${JSON.stringify(`
          const { writeFileSync } = require('node:fs');
          const { join, dirname } = require('node:path');
          const prompt = process.argv[1];
          const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
          writeFileSync(join(dirname(verdictPath), 'README.md'), 'custom artifact cwd\\n');
          writeFileSync(join(dirname(verdictPath), 'custom-cwd.txt'), process.cwd());
          writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
        `)}, prompt],
      }),
    },
  },
  engines: { default: 'unaware' },
  phases: ['review'],
  worktrees: false,
};
` });

  const originalLog = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = originalLog;
  }

  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# fixture\n');
  assert.equal(await readFile(join(summary.runDir, 'README.md'), 'utf8'), 'custom artifact cwd\n');
  const reviewCwd = (await readFile(join(summary.runDir, 'custom-cwd.txt'), 'utf8')).trim();
  assert.notEqual(reviewCwd, summary.runDir);
  assert.match(reviewCwd, /aloop-source-[^/]+\/repo$/);
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
  const args = adapterFor('agy').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['write-worktree'] }).args;
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

test('the gemini adapter carries the prompt on stdin, not the command line', () => {
  const result = adapterFor('gemini').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['write-worktree'] });
  // The Windows launcher is a .cmd/.ps1 shim, so on Git Bash the prompt would
  // ride through cmd.exe, which truncates past ~8191 chars and mangles newlines
  // and metacharacters. stdin is a pipe cmd.exe never parses.
  assert.equal(result.input, 'do it', 'prompt travels on stdin');
  assert.equal(result.args.includes('do it'), false, 'prompt is never an argv element');
  // `-p ""` still selects headless mode; Gemini appends --prompt to stdin, so an
  // empty flag leaves the stdin prompt as the whole prompt.
  assert.equal(result.args[result.args.indexOf('--prompt') + 1], '', 'empty --prompt selects headless mode');
});

test('the gemini adapter trusts the workspace, auto-approves tools, and streams', () => {
  const args = adapterFor('gemini').command({ prompt: 'do it', cwd: '/w', addDirs: [], permissions: ['write-worktree'] }).args;
  // Headless gemini cannot answer a permission prompt, so a worktree-writing
  // phase needs yolo to auto-approve the shell tools that build/test/commit.
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo', 'auto-approves tools in headless mode');
  // A fresh worktree is untrusted; without this gemini refuses to run and does nothing.
  assert.ok(args.includes('--skip-trust'), 'trusts the untrusted worktree for this run');
  // Default `text` output buffers every byte until exit — a working multi-minute
  // phase then looks identical to a hang.
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'streams events');
  assert.equal(args.includes('text'), false, 'text output withholds every byte until exit');
});

test('the gemini adapter passes a configured model and never emits an effort flag', () => {
  const args = adapterFor('gemini').command({ prompt: 'do it', cwd: '/w', addDirs: [], agent: { model: 'gemini-3-pro', effort: 'high' } }).args;
  assert.ok(args.includes('--model') && args.includes('gemini-3-pro'));
  // Gemini CLI has no effort flag; a configured effort is silently ignored.
  assert.equal(args.includes('--effort'), false);
  assert.equal(args.includes('high'), false);
});

test('the gemini renderer turns real stream events into readable progress lines', () => {
  // Event shapes below match the Gemini CLI headless emitter (init, message,
  // tool_use, tool_result, error, result); see renderGeminiEvent's doc comment.
  assert.equal(
    renderGeminiEvent({ type: 'init', session_id: 'ca1237fb-71fc-43e3', model: 'auto' }),
    '  · session ca1237fb model auto\n',
  );
  // Assistant text streams as deltas, passed through verbatim (no forced newline).
  assert.equal(
    renderGeminiEvent({ type: 'message', role: 'assistant', content: 'all done', delta: true }),
    'all done',
  );
  // The user turn is the prompt aloop already wrote; echoing it back is noise.
  assert.equal(renderGeminiEvent({ type: 'message', role: 'user', content: 'do it' }), '');
  // A tool call surfaces the tool and its most descriptive parameter.
  assert.equal(
    renderGeminiEvent({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'call-1', parameters: { command: 'npm  test' } }),
    '  → run_shell_command npm test\n',
  );
  // A failed tool result is surfaced; a successful one is not (its output is huge).
  assert.equal(
    renderGeminiEvent({ type: 'tool_result', tool_id: 'call-1', status: 'error', error: { type: 'TOOL_EXECUTION_ERROR', message: 'boom' } }),
    '  ✗ boom\n',
  );
  assert.equal(renderGeminiEvent({ type: 'tool_result', tool_id: 'call-2', status: 'success', output: 'ok' }), '');
  // Non-fatal warnings and system errors stay visible so a stall is not silent.
  assert.equal(renderGeminiEvent({ type: 'error', severity: 'warning', message: 'Agent execution blocked' }), '  ⚠ Agent execution blocked\n');
  assert.equal(renderGeminiEvent({ type: 'error', severity: 'error', message: 'quota exhausted' }), '  ✗ quota exhausted\n');
  assert.equal(
    renderGeminiEvent({ type: 'result', status: 'success', stats: { tool_calls: 1, duration_ms: 1960 } }),
    '  ✓ done 1 tool call 2s\n',
  );
  assert.equal(
    renderGeminiEvent({ type: 'result', status: 'error', error: { message: 'invalid model' } }),
    '  ✗ error: invalid model\n',
  );
  // An unrecognized event renders as nothing rather than raw JSON.
  assert.equal(renderGeminiEvent({ type: 'thinking', content: 'hmm' }), '');
});

test('the jsonl renderer captures Gemini token counts reported under result stats', () => {
  const renderer = createJsonlRenderer(renderGeminiEvent);
  renderer.write('{"type":"result","status":"success","stats":{"total_tokens":42,"input_tokens":30,"output_tokens":12}}\n');
  assert.deepEqual(renderer.usage(), { tokens: 42 });
});

test('the jsonl renderer reassembles events split across chunks and passes plain text through', () => {
  const renderer = createJsonlRenderer((event) => `[${event.n}]`);
  const stream = '{"n":1}\nnot json\n{"n":2}\n{"n":3}';
  let out = '';
  for (let index = 0; index < stream.length; index += 5) out += renderer.write(stream.slice(index, index + 5));
  assert.equal(out, '[1]not json\n[2]');
  assert.equal(renderer.end(), '[3]', 'a trailing line with no newline is still rendered');
});

test('the jsonl renderer exposes normalized token and cost usage when reported', () => {
  const renderer = createJsonlRenderer(() => '');
  renderer.write('{"usage":{"input_tokens":12,"output_tokens":8,"cost":0.25}}\n');
  assert.deepEqual(renderer.usage(), { tokens: 20, cost: 0.25 });
});

test('the jsonl renderer captures Claude result total_cost_usd', () => {
  const renderer = createJsonlRenderer(renderClaudeEvent);
  renderer.write('{"type":"result","subtype":"success","total_cost_usd":0.37}\n');
  assert.deepEqual(renderer.usage(), { cost: 0.37 });
});

test('the jsonl renderer combines Claude result usage and total cost', () => {
  const renderer = createJsonlRenderer(renderClaudeEvent);
  renderer.write('{"type":"result","subtype":"success","usage":{"input_tokens":12,"output_tokens":8},"total_cost_usd":0.37}\n');
  assert.deepEqual(renderer.usage(), { tokens: 20, cost: 0.37 });
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

test('manifest hashes are deterministic and ignore function-valued config', async () => {
  const first = { z: 2, nested: { b: 'two', a: 'one' }, adapter: () => 'first' };
  const second = { adapter: () => 'second', nested: { a: 'one', b: 'two' }, z: 2 };
  assert.equal(hashConfig(first), hashConfig(second));
  assert.equal(hashText('same prompt'), hashText('same prompt'));
  assert.notEqual(hashText('same prompt'), hashText('changed prompt'));

  const renderVariables = (taskContext) => ({
    TASK_CONTEXT: taskContext,
    REPO: '/repo',
    BRANCH: 'feat/demo',
    BASE_BRANCH: 'master',
    RUN_DIR: '/run',
    GATE_COMMANDS: 'true',
  });
  const firstRender = await renderPrompt('implement', renderVariables('same task'), { projectPromptDir: '/missing-project-prompts' });
  const secondRender = await renderPrompt('implement', renderVariables('same task'), { projectPromptDir: '/missing-project-prompts' });
  const changedRender = await renderPrompt('implement', renderVariables('changed task'), { projectPromptDir: '/missing-project-prompts' });
  assert.equal(hashText(firstRender.prompt), hashText(secondRender.prompt));
  assert.notEqual(hashText(firstRender.prompt), hashText(changedRender.prompt));
});

test('run metrics aggregate phase usage and reviewer convergence', () => {
  const metrics = computeRunMetrics({ phases: [
    { phase: 'implement', role: 'agent', status: 'completed', durationMs: 100, tokens: 10, cost: 0.1 },
    {
      phase: 'review', role: 'verdict', round: 1, status: 'completed', durationMs: 20,
      tokens: 5, cost: 0.05, verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ issue: 'fix' }] },
    },
    { phase: 'address', role: 'repair', round: 1, status: 'completed', durationMs: 30, tokens: 7, cost: 0.07 },
    {
      phase: 'review', role: 'verdict', round: 2, status: 'completed', durationMs: 25,
      tokens: 6, cost: 0.06, verdict: { verdict: 'APPROVED', blocking: [] },
    },
  ] });

  assert.deepEqual(metrics.total, {
    durationMs: 175,
    tokens: 28,
    cost: 0.28,
    usageCoverage: {
      applicableEntries: 4,
      tokensReported: 4,
      costReported: 4,
      tokenCoverage: 1,
      costCoverage: 1,
    },
  });
  assert.equal(metrics.phases.review.durationMs, 45);
  assert.equal(metrics.convergence.roundsToConverge, 2);
  assert.deepEqual(metrics.convergence.roundsToApprovalDistribution, { 2: 1 });
  assert.equal(metrics.reviewer.catchRate, 0.5);
  assert.equal(metrics.reviewer.findingsCleared, 1);
  assert.equal(metrics.reviewer.findingsClearedPerRound, 1);
});

test('metrics preserve unknown usage while reporting duration', () => {
  const metrics = computeRunMetrics({ phases: [
    { phase: 'gate', role: 'gate', status: 'completed', durationMs: 42, gateReceipts: [] },
  ] });
  assert.deepEqual(metrics.total, {
    durationMs: 42,
    tokens: null,
    cost: null,
    usageCoverage: {
      applicableEntries: 0,
      tokensReported: 0,
      costReported: 0,
      tokenCoverage: null,
      costCoverage: null,
    },
  });
  assert.equal(metrics.phases.gate.durationMs, 42);
  assert.equal(metrics.phases.gate.tokens, null);
  assert.equal(metrics.phases.gate.cost, null);
});

test('run metrics sum agent usage without gate entries erasing totals', () => {
  const metrics = computeRunMetrics({ phases: [
    { phase: 'implement', kind: 'agent', role: 'agent', status: 'completed', durationMs: 80, tokens: 10, cost: 0.1 },
    { phase: 'gate', kind: 'gate', role: 'gate', status: 'completed', durationMs: 40, gateReceipts: [] },
  ] });

  assert.equal(metrics.total.durationMs, 120);
  assert.equal(metrics.total.tokens, 10);
  assert.equal(metrics.total.cost, 0.1);
  assert.deepEqual(metrics.total.usageCoverage, {
    applicableEntries: 1,
    tokensReported: 1,
    costReported: 1,
    tokenCoverage: 1,
    costCoverage: 1,
  });
});

test('aggregate metrics combine runs and calculate distributions', () => {
  const first = { phases: [
    { phase: 'review', role: 'verdict', round: 1, status: 'completed', durationMs: 10, tokens: 2, cost: 0.02, verdict: { verdict: 'APPROVED', blocking: [] } },
  ] };
  const second = { phases: [
    { phase: 'review', role: 'verdict', round: 1, status: 'completed', durationMs: 20, verdict: { verdict: 'CHANGES_REQUESTED', blocking: [{ issue: 'fix' }] } },
  ] };
  const metrics = computeAggregateMetrics([first, second]);
  assert.equal(metrics.runs, 2);
  assert.equal(metrics.total.durationMs, 30);
  assert.equal(metrics.total.tokens, null);
  assert.deepEqual(metrics.total.usageCoverage, {
    applicableEntries: 2,
    tokensReported: 1,
    costReported: 1,
    tokenCoverage: 0.5,
    costCoverage: 0.5,
  });
  assert.deepEqual(metrics.convergence.roundsToApprovalDistribution, { 1: 1 });
  assert.equal(metrics.reviewer.rounds, 2);
  assert.equal(metrics.reviewer.catchRate, 0.5);
});

test('read operations surface per-run and aggregate metrics from saved manifests', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const runDir = join(runs, 'demo');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'state.json'), JSON.stringify({
    runId: 'run-1', status: 'completed', completed: ['review'], branch: 'feat/demo',
    startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
  }));
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
    phases: [{
      phase: 'review', role: 'verdict', round: 1, status: 'completed', durationMs: 60,
      verdict: { verdict: 'APPROVED', blocking: [] },
    }],
  }));

  const status = await getRunStatus(runs, 'demo');
  assert.equal(status.status, 'completed');
  assert.equal(status.metrics.total.durationMs, 60);
  assert.equal((await listRunStatuses(runs, { includeMetrics: true }))[0].metrics.reviewer.approvals, 1);
  assert.equal((await getAggregateMetrics(runs)).convergence.converged, 1);
});

test('loadRunsDir resolves the runs directory without validating the pipeline', async () => {
  const { root } = await repoFixture({
    // A gate phase with no gate commands makes loadConfig reject; loadRunsDir
    // must still resolve the configured runs directory.
    config: 'export default { gate: [], runsDir: "custom/runs" };\n',
  });
  await assert.rejects(loadConfig(root), /gate phase but no gate commands/);
  assert.equal(await loadRunsDir(root), 'custom/runs');
});

test('read-only commands inspect saved runs when the pipeline config is invalid', async () => {
  const { root } = await repoFixture({
    // No gate commands: the current pipeline is unrunnable, but saved runs must
    // remain inspectable for postmortem after a config change.
    config: 'export default { gate: [] };\n',
  });
  await assert.rejects(loadConfig(root), /gate phase but no gate commands/);

  const runDir = join(root, '.loop', 'runs', 'demo');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'state.json'), JSON.stringify({
    runId: 'run-1', status: 'completed', completed: ['review'], branch: 'feat/demo',
  }));
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
    phases: [{
      phase: 'review', role: 'verdict', round: 1, status: 'completed', durationMs: 60,
      verdict: { verdict: 'APPROVED', blocking: [] },
    }],
  }));

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  /** @type {any} */
  let metrics;
  /** @type {any} */
  let status;
  try {
    metrics = await runOperationalCommand({ command: 'metrics', json: true, cwd: root });
    status = await runOperationalCommand({ command: 'status', name: 'demo', json: true, cwd: root });
  } finally {
    console.log = original;
  }

  assert.equal(metrics.runs, 1);
  assert.equal(metrics.total.durationMs, 60);
  assert.equal(status.status, 'completed');
  assert.equal(status.metrics.total.durationMs, 60);
});

test('RunState persists phase completion across reopen', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await openFixtureState(runs, 'demo', { branch: 'feat/demo' });
  await state.markComplete('implement');
  const reopened = await openFixtureState(runs, 'demo', {});
  assert.equal(reopened.isComplete('implement'), true);
  assert.equal(reopened.isComplete('review'), false);
  assert.equal(reopened.data.branch, 'feat/demo');
});

test('RunState persists the append-only manifest beside state', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await openFixtureState(runs, 'demo', {});
  state.manifest.append({ phase: 'gate', status: 'completed' });
  await state.save();

  const saved = JSON.parse(await readFile(join(state.dir, 'manifest.json'), 'utf8'));
  assert.equal(saved.manifestVersion, 1);
  assert.equal(saved.phases[0].phase, 'gate');
  const reopened = await openFixtureState(runs, 'demo', {});
  assert.equal(reopened.manifest.entries.length, 1);
  assert.equal(reopened.manifest.entries[0].status, 'completed');
});

test('RunState persists the reviewed commit for each verdict round', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await openFixtureState(runs, 'demo', {});
  await state.record({
    rounds: { review: 2 },
    reviewedShas: { review: { 1: 'abc123', 2: 'def456' } },
  });
  const reopened = await openFixtureState(runs, 'demo', {});
  assert.deepEqual(reopened.data.reviewedShas.review, { 1: 'abc123', 2: 'def456' });
});

test('a read-only RunState stays in memory and ignores persisted state', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const persisted = await openFixtureState(runs, 'demo', { branch: 'feat/saved' });
  await persisted.record({ task: 'saved task' });

  const preview = await openFixtureState(runs, 'demo', { branch: 'feat/planned' }, { readOnly: true });
  assert.equal(preview.data.branch, 'feat/planned');
  assert.equal(preview.data.task, undefined);

  await openFixtureState(runs, 'uncreated', {}, { readOnly: true });
  await assert.rejects(readdir(join(runs, 'uncreated')), { code: 'ENOENT' });
});

test('RunState keeps the last good state and manifest when a temp write is abandoned', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', {});
  await state.record({ task: 'saved' });
  await state.saveManifest({ task: 'saved' });
  const stateBefore = await readFile(state.path, 'utf8');
  const manifestBefore = await readFile(state.manifestPath, 'utf8');
  await writeFile(`${state.path}.tmp`, '{ incomplete state');
  await writeFile(`${state.manifestPath}.tmp`, '{ incomplete manifest');
  await state.release();

  const reopened = await RunState.open(runs, 'demo', {}, { resume: true });
  assert.equal(reopened.data.task, 'saved');
  assert.equal(await readFile(reopened.path, 'utf8'), stateBefore);
  assert.equal(await readFile(reopened.manifestPath, 'utf8'), manifestBefore);
  assert.equal(reopened.data.schemaVersion, 1);
  assert.match(reopened.data.runId, /^[a-z0-9]+-[0-9a-f]{8}$/);
  await reopened.release();
});

test('RunState rejects a second active open and releases the lock', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', {});
  await assert.rejects(
    RunState.open(runs, 'demo', {}),
    /Run already active/,
  );
  await state.release();

  const reopened = await RunState.open(runs, 'demo', {}, { resume: true });
  await reopened.release();
});

test('RunState recovers from an interrupted initial lock publication', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const runDir = join(runs, 'demo');
  await mkdir(join(runDir, 'lock'), { recursive: true });

  const state = await RunState.open(runs, 'demo', {}, { resume: true });
  assert.ok(state.lockToken, 'the empty lock was replaced with a published owner');
  await state.release();
});

test('RunState serializes concurrent stale-lock takeover', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const runDir = join(runs, 'demo');
  const lockDir = join(runDir, 'lock');
  await mkdir(runDir);
  await mkdir(lockDir);
  await writeFile(
    join(lockDir, 'owner-2147483647-deadbeef'),
    JSON.stringify({ pid: 2147483647, token: 'deadbeef' }),
  );

  const results = await Promise.allSettled([
    RunState.acquireLock(runDir, 'first'),
    RunState.acquireLock(runDir, 'second'),
  ]);

  const acquired = results.filter(({ status }) => status === 'fulfilled');
  const rejected = results.filter(({ status }) => status === 'rejected');
  assert.equal(acquired.length, 1, 'exactly one contender may take over the stale lock');
  assert.equal(rejected.length, 1, 'the other contender must observe the new active lock');
  assert.match((/** @type {any} */ (rejected[0])).reason.message, /Run already active/);
  await RunState.releaseLock(runDir, (/** @type {any} */ (acquired[0])).value);
});

test('RunState refuses unsupported and non-integer state and manifest schema versions', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', {});
  await state.record({ task: 'saved' });
  await state.release();
  const saved = JSON.parse(await readFile(join(runs, 'demo', 'state.json'), 'utf8'));
  await writeFile(join(runs, 'demo', 'state.json'), JSON.stringify({ ...saved, schemaVersion: 999 }));
  await assert.rejects(
    RunState.open(runs, 'demo', {}, { resume: true }),
    /Unsupported state schemaVersion 999/,
  );
  await writeFile(join(runs, 'demo', 'state.json'), JSON.stringify({ ...saved, schemaVersion: 'corrupt' }));
  await assert.rejects(
    RunState.open(runs, 'demo', {}, { resume: true }),
    /Unsupported state schemaVersion corrupt; expected an integer version/,
  );

  const valid = await RunState.open(runs, 'other', {});
  await valid.release();
  await writeFile(join(runs, 'other', 'manifest.json'), JSON.stringify({ schemaVersion: 999, task: 'bad' }));
  await assert.rejects(
    RunState.open(runs, 'other', {}, { resume: true }),
    /Unsupported manifest schemaVersion 999/,
  );
});

test('RunState refuses to reuse an existing slug without --resume', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'loop-runs-'));
  const state = await RunState.open(runs, 'demo', {});
  await state.markComplete('gate');
  await state.release();

  await assert.rejects(
    RunState.open(runs, 'demo', {}),
    /already contains a run.*--resume.*new --name/,
  );
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
  assert.equal(parseLoopArgs(['--preset', 'work-item']).preset, 'work-item');
  assert.deepEqual(parseLoopArgs(['status', 'demo', '--json']), {
    command: 'status',
    runName: 'demo',
    name: undefined,
    json: true,
    metrics: undefined,
    olderThanDays: undefined,
    task: undefined,
    taskFile: undefined,
    branch: undefined,
    baseBranch: undefined,
    engine: undefined,
    model: undefined,
    effort: undefined,
    overrideEngine: undefined,
    config: undefined,
    phases: undefined,
    maxRounds: undefined,
    from: undefined,
    resume: undefined,
    note: undefined,
    noteFile: undefined,
    yes: undefined,
    noWorktree: undefined,
    noTui: undefined,
    dryRun: undefined,
    preset: undefined,
    force: undefined,
  });
  assert.deepEqual(parseLoopArgs(['init', '--preset', 'work-item', '--force']), {
    command: 'init',
    runName: undefined,
    task: undefined,
    taskFile: undefined,
    name: undefined,
    branch: undefined,
    baseBranch: undefined,
    engine: undefined,
    model: undefined,
    effort: undefined,
    overrideEngine: undefined,
    config: undefined,
    phases: undefined,
    maxRounds: undefined,
    from: undefined,
    resume: undefined,
    note: undefined,
    noteFile: undefined,
    yes: undefined,
    noWorktree: undefined,
    noTui: undefined,
    dryRun: undefined,
    json: undefined,
    metrics: undefined,
    olderThanDays: undefined,
    preset: 'work-item',
    force: true,
  });
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--config', 'configs/fast.mjs']).config, 'configs/fast.mjs');
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--resume', '--engine', 'agy', '--override-engine']).overrideEngine, true);
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--note', 'finish']).note, 'finish');
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--note-file', 'note.md']).noteFile, 'note.md');
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--max-rounds', 'zero']), /positive integer/);
});

test('init scaffolds an importable config and complete editable default prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-init-'));
  const result = await initScaffold({ cwd: root });
  const promptNames = (await readdir(packagePrompts)).filter((name) => name.endsWith('.md')).sort();

  assert.equal(result.preset, null);
  assert.deepEqual((await readdir(join(root, '.loop', 'prompts'))).sort(), promptNames);
  const configPath = join(root, 'loop.config.mjs');
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /REVIEW THESE before your first run/);
  assert.match(config, /Prompts live in \.loop\/prompts/);
  assert.match(config, /happy agentic looping/);
  const loaded = await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
  assert.equal(loaded.default.baseBranch, 'master');
  assert.deepEqual(loaded.default.gate, []);
});

test('init uses bundled preset config and overlays its prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-init-preset-'));
  const result = await initScaffold({ cwd: root, preset: 'work-item' });
  const presetPrompt = await readFile(join(dirname(packagePrompts), 'presets', 'work-item', 'prompts', 'implement.md'), 'utf8');
  const copiedPrompt = await readFile(join(root, '.loop', 'prompts', 'implement.md'), 'utf8');
  const config = await readFile(join(root, 'loop.config.mjs'), 'utf8');

  assert.equal(result.preset, 'work-item');
  assert.equal(copiedPrompt, presetPrompt);
  assert.match(config, /gate: \['npm test'\]/);
  assert.match(config, /happy agentic looping/);
});

test('init refuses partial clobbers, supports force, and leaves extra prompts intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-init-clobber-'));
  await writeFile(join(root, 'loop.config.mjs'), 'export default {};\n');

  await assert.rejects(initScaffold({ cwd: root }), /Refusing to overwrite existing files:.*loop\.config\.mjs/s);
  await assert.rejects(readdir(join(root, '.loop', 'prompts')), { code: 'ENOENT' });

  await initScaffold({ cwd: root, force: true });
  await writeFile(join(root, '.loop', 'prompts', 'custom.md'), 'keep me\n');
  await initScaffold({ cwd: root, force: true });
  assert.equal(await readFile(join(root, '.loop', 'prompts', 'custom.md'), 'utf8'), 'keep me\n');
  await assert.rejects(initScaffold({ cwd: root, preset: 'unknown' }), /Unknown preset "unknown"\. Available: work-item/);
});

test('init command dispatch returns JSON scaffold results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-init-command-'));
  const output = [];
  const result = /** @type {any} */ (await runCliOperationalCommand(
    parseLoopArgs(['init', '--json']),
    /** @type {any} */ ({ cwd: root, output: { log: (line) => output.push(line) } }),
  ));

  assert.equal(result.preset, null);
  assert.deepEqual(JSON.parse(output[0]), result);
});

test('a run-time preset renders bundled prompts and logs its selection', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement'] });
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, preset: 'work-item', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }

  const output = lines.join('\n');
  assert.match(output, /preset\s+: work-item .*presets[\\/]work-item[\\/]prompts/);
  assert.match(output, /IN PROGRESS/);

  const genericLines = [];
  console.log = (message) => genericLines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['implement'], dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.doesNotMatch(genericLines.join('\n'), /IN PROGRESS/);
});

test('a saved preset is reused on resume and rejects a conflicting flag', async () => {
  const { root, workItem } = await repoFixture({
    config: "export default { phases: ['gate'], gate: ['true'], worktrees: false, preset: 'work-item' };\n",
  });
  await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });

  const statePath = join(root, '.loop', 'runs', 'ss-demo-feature', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.preset, 'work-item');

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /preset\s+: work-item/);
  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, resume: true, preset: 'other', yes: true } }),
    /Saved run used preset "work-item"; cannot resume with --preset "other"\. Start a new run instead\./,
  );
});

test('a relative external preset stays anchored to its original cwd on resume', async () => {
  const { root, workItem } = await repoFixture({
    config: "export default { phases: ['gate'], gate: ['true'], worktrees: false };\n",
  });
  const initialPreset = join(root, 'preset', 'prompts');
  const alternatePreset = join(root, 'resume', 'preset', 'prompts');
  await mkdir(initialPreset, { recursive: true });
  await mkdir(alternatePreset, { recursive: true });

  await runLoop({ args: { taskFile: workItem, cwd: root, preset: './preset', yes: true } });

  const statePath = join(root, '.loop', 'runs', 'ss-demo-feature', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.preset, './preset');
  assert.equal(state.presetCwd, root);

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await runLoop({
      args: { taskFile: workItem, cwd: join(root, 'resume'), resume: true, preset: './preset', yes: true },
    });
  } finally {
    console.log = original;
  }

  assert.ok(lines.includes(`preset    : ./preset (${initialPreset})`));
  assert.ok(!lines.includes(`preset    : ./preset (${alternatePreset})`));
});

test('a dry run plans every phase without creating state, a worktree, or a branch', async () => {
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
  assert.equal(summary.runDir, join(root, '.loop/runs/ss-demo-feature'));
  await assert.rejects(readdir(summary.worktree), { code: 'ENOENT' });
  await assert.rejects(readdir(summary.runDir), { code: 'ENOENT' });
  await assert.rejects(readFile(join(summary.runDir, 'snapshot.json')), { code: 'ENOENT' });
  assert.equal(await git(root, 'branch', '--list', 'feat/ss-demo-feature'), '');

  const output = lines.join('\n');
  assert.match(output, /implement → docs → gate → review → pr-description → publish/);
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

test('a completed agent phase writes a commit-attested manifest entry', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
printf 'done\\n' > implemented.txt
git add implemented.txt
git commit -m 'feat: implement fixture'
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
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.phases.length, 1);
  const [entry] = manifest.phases;
  assert.equal(entry.phase, 'implement');
  assert.equal(entry.role, 'agent');
  assert.equal(entry.status, 'completed');
  assert.match(entry.inputSha, /^[0-9a-f]{40}$/);
  assert.match(entry.outputSha, /^[0-9a-f]{40}$/);
  assert.notEqual(entry.inputSha, entry.outputSha);
  assert.match(entry.promptHash, /^[0-9a-f]{64}$/);
  assert.equal(entry.promptInput.template, 'implement');
  assert.equal(typeof entry.promptInput.templateBody, 'string');
  assert.equal(entry.promptInput.variables.TASK_NAME, 'ss-demo-feature');
  assert.equal(entry.promptInput.operatorNote, null);
  assert.match(entry.configHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.engine, { name: 'claude' });
  assert.ok(entry.artifacts.includes('implement.log'));
  assert.equal(typeof entry.durationMs, 'number');
});

test('a token budget stalls before the next phase and resumes after raising the limit', async () => {
  const meteredScript = `
n=$(find . -maxdepth 1 -name 'budget-phase-*.txt' | wc -l)
next=$((n + 1))
file="budget-phase-$next.txt"
printf 'done\\n' > "$file"
git add "$file"
git commit -m "feat: metered phase $next"
printf '%s\\n' '{"type":"result","usage":{"input_tokens":6,"output_tokens":4,"cost":0.1}}'
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    metered: {
      command() {
        return { command: 'sh', args: ['-c', ${JSON.stringify(meteredScript)}] };
      },
      usage: () => ({ tokens: 10, cost: 0.1 }),
    },
  },
  engines: { default: 'metered' },
  phases: [
    { name: 'first', kind: 'agent', prompt: 'docs' },
    { name: 'second', kind: 'agent', prompt: 'docs' },
  ],
  budget: { tokens: 10, usd: 0.2 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let firstSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(firstSummary.stalled.phase, 'second');
  assert.equal(firstSummary.stalled.reason, 'budget exhausted: tokens');
  const firstManifest = JSON.parse(await readFile(join(firstSummary.runDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(firstManifest.phases.map((entry) => [entry.phase, entry.status]), [
    ['first', 'completed'],
    ['second', 'stalled'],
  ]);

  await writeFile(join(root, 'loop.config.mjs'), `export default {
  adapters: {
    metered: {
      command() {
        return { command: 'sh', args: ['-c', ${JSON.stringify(meteredScript)}] };
      },
      usage: () => ({ tokens: 10, cost: 0.1 }),
    },
  },
  engines: { default: 'metered' },
  phases: [
    { name: 'first', kind: 'agent', prompt: 'docs' },
    { name: 'second', kind: 'agent', prompt: 'docs' },
  ],
  budget: { tokens: 30, usd: 0.3 },
  worktrees: false,
};
`);
  let resumedSummary;
  try {
    resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.equal(resumedSummary.stalled, null);
  assert.deepEqual(resumedSummary.phases.map((phase) => phase.name), ['second']);
});

async function assertZeroBudgetStopsBeforeAgent(field) {
  const marker = `zero-${field}-agent-ran`;
  const agentScript = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    metered: {
      command() {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(agentScript)}] };
      },
    },
  },
  engines: { default: 'metered' },
  phases: [{ name: 'agent', kind: 'agent', prompt: 'docs' }],
  budget: { ${field}: 0 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'agent');
  assert.equal(summary.stalled.reason, `budget exhausted: ${field}`);
  await assert.rejects(readFile(join(root, marker)), { code: 'ENOENT' });
}

test('a zero token budget stalls before the first agent invocation', async () => {
  await assertZeroBudgetStopsBeforeAgent('tokens');
});

test('a zero dollar budget stalls before the first agent invocation', async () => {
  await assertZeroBudgetStopsBeforeAgent('usd');
});

test('a budget stall inside a review repair preserves usage and blocks unchanged resume', async () => {
const verdictScript = `
const fs = require('node:fs');
const { dirname, join } = require('node:path');
const prompt = process.argv[1];
const verdictPath = prompt.split('write this JSON to ')[1].split(String.fromCharCode(96))[1];
const attemptsPath = join(dirname(verdictPath), 'review-attempts');
const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempts));
fs.writeFileSync(verdictPath, JSON.stringify({ verdict: 'CHANGES_REQUESTED', blocking: [{ issue: 'fix it' }] }));
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    metered: {
      command({ prompt }) {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(verdictScript)}, prompt] };
      },
      usage: () => ({ tokens: 10, cost: 0.1 }),
    },
  },
  engines: { default: 'metered' },
  phases: ['review', 'address'],
  budget: { tokens: 10 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let firstSummary;
  let resumedSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(firstSummary.stalled.phase, 'address');
  assert.equal(firstSummary.stalled.reason, 'budget exhausted: tokens');
  assert.equal(resumedSummary.stalled.phase, 'review');
  assert.equal(resumedSummary.stalled.reason, 'budget exhausted: tokens');
  assert.equal(await readFile(join(firstSummary.runDir, 'review-attempts'), 'utf8'), '1', 'unchanged resume must not invoke the reviewer again');

  const manifest = JSON.parse(await readFile(join(firstSummary.runDir, 'manifest.json'), 'utf8'));
  const repairStall = manifest.phases.find((entry) => entry.phase === 'address');
  assert.equal(repairStall.budgetStall, true);
  assert.equal(repairStall.tokens, undefined);
  assert.equal(repairStall.cost, undefined);
  const metrics = computeRunMetrics(manifest);
  assert.equal(metrics.total.tokens, 10, 'budget bookkeeping must not make known usage unknown');
  assert.equal(metrics.total.cost, 0.1);
});

test('a final-phase budget stall finalizes after raising the limit without rerunning', async () => {
  const finalScript = `
const fs = require('node:fs');
const attempts = fs.existsSync('final-runs') ? Number(fs.readFileSync('final-runs', 'utf8')) + 1 : 1;
fs.writeFileSync('final-runs', String(attempts));
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    metered: {
      command() {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(finalScript)}] };
      },
      usage: () => ({ tokens: 10, cost: 0.1 }),
    },
  },
  engines: { default: 'metered' },
  phases: [{ name: 'final', kind: 'agent', prompt: 'docs', permissions: ['write-worktree'] }],
  budget: { tokens: 10 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let firstSummary;
  let resumedSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(firstSummary.stalled.phase, 'final');
  assert.equal(firstSummary.stalled.reason, 'budget exhausted: tokens');
  assert.equal(resumedSummary.stalled.phase, 'final');
  assert.equal(resumedSummary.stalled.reason, 'budget exhausted: tokens');
  assert.equal(await readFile(join(root, 'final-runs'), 'utf8'), '1', 'unchanged resume must not rerun the final phase');

  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.deepEqual(state.data.completed, ['final'], 'terminal budget exhaustion must checkpoint the completed final phase');
  assert.equal(state.data.phases.final.budgetExhausted, true);
  const manifest = JSON.parse(await readFile(join(firstSummary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'final').length, 3);
  assert.equal(manifest.phases.at(-1).budgetStall, true);

  await writeFile(join(root, 'loop.config.mjs'), `export default {
  adapters: {
    metered: {
      command() {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(finalScript)}] };
      },
      usage: () => ({ tokens: 10, cost: 0.1 }),
    },
  },
  engines: { default: 'metered' },
  phases: [{ name: 'final', kind: 'agent', prompt: 'docs', permissions: ['write-worktree'] }],
  budget: { tokens: 20 },
  worktrees: false,
};
`);
  const completedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  assert.equal(completedSummary.stalled, null);
  assert.deepEqual(completedSummary.phases.map((phase) => phase.name), ['final']);
  assert.equal(await readFile(join(root, 'final-runs'), 'utf8'), '1', 'raised-budget resume must not rerun the final phase');

  const completedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.deepEqual(completedState.data.completed, ['final']);
  assert.equal(completedState.data.phases.final.budgetExhausted, false);
});

test('a wall-clock budget stalls between phases', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  phases: [
    { name: 'slow', kind: 'gate', commands: ['sleep 0.6'] },
    { name: 'next', kind: 'gate', commands: ['true'] },
  ],
  budget: { wallClockMs: 500 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  assert.equal(summary.stalled.phase, 'next');
  assert.equal(summary.stalled.reason, 'budget exhausted: wallClockMs');
});

test('an agent with unavailable cost warns and does not silently pass a dollar budget', async () => {
  const marker = 'unavailable-cost-agent-ran';
  const agentScript = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    unmetered: {
      command() {
        return { command: process.execPath, args: ['-e', ${JSON.stringify(agentScript)}] };
      },
    },
  },
  engines: { default: 'unmetered' },
  phases: [{ name: 'agent', kind: 'agent', prompt: 'docs', permissions: ['write-worktree'] }],
  budget: { usd: 1 },
  worktrees: false,
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(root, marker), 'utf8'), 'ran');
  assert.match(lines.join('\n'), /cost usage is unavailable; the dollar budget cannot be enforced/);
});

test('a failing implementation agent writes a stalled manifest entry before rejecting', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nprintf \'implementation failed\\n\' >&2\nexit 7\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, yes: true } }),
      /Command failed: claude/,
    );
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  const runDir = join(root, '.loop/runs/ss-demo-feature');
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const [entry] = manifest.phases;
  assert.equal(entry.phase, 'implement');
  assert.equal(entry.role, 'agent');
  assert.equal(entry.status, 'stalled');
  assert.match(entry.inputSha, /^[0-9a-f]{40}$/);
  assert.match(entry.outputSha, /^[0-9a-f]{40}$/);
  assert.match(entry.promptHash, /^[0-9a-f]{64}$/);
  assert.match(entry.configHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.engine, { name: 'claude' });
  assert.deepEqual(entry.failure, { command: 'claude', code: 7, timedOut: false });
  await readFile(join(runDir, 'implement.log'));
});

test('a failing verdict agent writes a stalled manifest entry before rejecting', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  phases: ['review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nprintf \'review failed\\n\' >&2\nexit 9\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, yes: true } }),
      /Command failed: claude/,
    );
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
  }

  const runDir = join(root, '.loop/runs/ss-demo-feature');
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const [entry] = manifest.phases;
  assert.equal(entry.phase, 'review');
  assert.equal(entry.role, 'verdict');
  assert.equal(entry.status, 'stalled');
  assert.deepEqual(entry.failure, { command: 'claude', code: 9, timedOut: false });
  await readFile(join(runDir, 'review.log'));
});

test('a gate manifest entry records each command receipt and a stall', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true', 'false'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
  ` });
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'gate');
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const [entry] = manifest.phases;
  assert.equal(entry.role, 'gate');
  assert.equal(entry.status, 'stalled');
  assert.deepEqual(entry.gateReceipts.map((receipt) => [receipt.command, receipt.exitCode]), [['true', 0], ['false', 1]]);
  assert.ok(entry.gateReceipts.every((receipt) => typeof receipt.durationMs === 'number'));
});

test('a silent passing gate declares a log artifact that exists', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
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

  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const [entry] = manifest.phases;
  assert.equal(entry.status, 'completed');
  assert.deepEqual(entry.artifacts, ['gate.log']);
  await readFile(join(summary.runDir, 'gate.log'));
});

test('a verdict manifest entry binds the verdict to its reviewed SHA', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  phases: ['review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [], nits: [], summary: 'looks good' }));
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

  const state = await RunState.open(join(root, '.loop/runs'), 'ss-demo-feature', {}, { resume: true });
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const [entry] = manifest.phases;
  assert.equal(entry.role, 'verdict');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.verdict.verdict, 'APPROVED');
  assert.equal(entry.verdict.sha, state.data.reviewedShas.review[1]);
  assert.equal(entry.artifacts.includes('verdict-round-1.json'), true);
});

test('the approved description is pushed and published with verified PR metadata', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  remote: 'origin',
  phases: ['implement', 'docs', 'gate', 'review', 'pr-description', 'publish'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const remoteRepo = await mkdtemp(join(tmpdir(), 'loop-remote-'));
  await git(remoteRepo, 'init', '--bare');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  const realGitPath = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(join(binDir, 'git'), `#!/bin/sh
if [ "$1" = push ] && [ "$3" = origin ]; then
  exec "$FAKE_GIT_PATH" push "$2" "$FAKE_REMOTE" "$4"
fi
if [ "$1" = ls-remote ] && [ "$2" = origin ]; then
  exec "$FAKE_GIT_PATH" ls-remote "$FAKE_REMOTE" "$3"
fi
exec "$FAKE_GIT_PATH" "$@"
`, { mode: 0o755 });
  const prState = join(root, '.loop/runs/ss-demo-feature/gh-pr.json');
  const ghLog = join(root, '.loop/runs/ss-demo-feature/gh.log');
  await writeFile(join(binDir, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  if [ -f "$FAKE_PR_STATE" ]; then cat "$FAKE_PR_STATE"; exit 0; fi
  printf '%s\\n' 'no pull requests found' >&2
  exit 1
fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  head=$(git rev-parse HEAD)
  printf '%s\\n' '{"url":"https://github.com/example/project/pull/42","number":42,"baseRefName":"master","headRefOid":"'"$head"'","isDraft":true}' > "$FAKE_PR_STATE"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *documentation-as-built*)
    printf '%s\\n' '# as built' > docs-as-built.md
    git add docs-as-built.md
    git commit -m 'docs: reconcile fixture documentation'
    ;;
  *'Take on the role of a senior developer'*)
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[],"nits":[],"summary":"documentation is covered"}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Write \`'*'/pr.md'*)
    printf '%s\\n\\n%s\\n' 'Title: Fixture description' 'The description is ready.' > "$FIXTURE_PR_PATH"
    ;;
  *'Push to '*)
    ;;
  *)
    printf '%s\\n' implemented > implemented.txt
    git add implemented.txt
    git commit -m 'feat: implement fixture'
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalPrPath = process.env.FIXTURE_PR_PATH;
  const originalPrState = process.env.FAKE_PR_STATE;
  const originalGhLog = process.env.FAKE_GH_LOG;
  const originalGitPath = process.env.FAKE_GIT_PATH;
  const originalRemote = process.env.FAKE_REMOTE;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  process.env.FIXTURE_PR_PATH = join(root, '.loop/runs/ss-demo-feature/pr.md');
  process.env.FAKE_PR_STATE = prState;
  process.env.FAKE_GH_LOG = ghLog;
  process.env.FAKE_GIT_PATH = realGitPath;
  process.env.FAKE_REMOTE = remoteRepo;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    if (originalPrPath === undefined) delete process.env.FIXTURE_PR_PATH;
    else process.env.FIXTURE_PR_PATH = originalPrPath;
    if (originalPrState === undefined) delete process.env.FAKE_PR_STATE;
    else process.env.FAKE_PR_STATE = originalPrState;
    if (originalGhLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = originalGhLog;
    if (originalGitPath === undefined) delete process.env.FAKE_GIT_PATH;
    else process.env.FAKE_GIT_PATH = originalGitPath;
    if (originalRemote === undefined) delete process.env.FAKE_REMOTE;
    else process.env.FAKE_REMOTE = originalRemote;
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.phases.map((entry) => entry.phase), ['implement', 'docs', 'gate', 'review', 'pr-description', 'publish']);
  const gate = manifest.phases.find((entry) => entry.phase === 'gate');
  const review = manifest.phases.find((entry) => entry.phase === 'review');
  const description = manifest.phases.find((entry) => entry.phase === 'pr-description');
  const publishPhase = manifest.phases.find((entry) => entry.phase === 'publish');
  assert.equal(gate.outputSha, review.verdict.sha);
  assert.equal(description.status, 'completed');
  assert.equal(description.artifacts.includes('pr.md'), true);
  assert.equal(await readFile(join(summary.runDir, 'pr.md'), 'utf8'), 'Title: Fixture description\n\nThe description is ready.\n');
  assert.equal(await git(remoteRepo, 'rev-parse', 'refs/heads/feat/ss-demo-feature'), review.verdict.sha);
  assert.deepEqual(publishPhase.pullRequest, {
    url: 'https://github.com/example/project/pull/42',
    number: 42,
    baseRefName: 'master',
    headRefOid: review.verdict.sha,
    isDraft: true,
  });
  assert.equal(publishPhase.remoteSha, review.verdict.sha);
  assert.deepEqual(summary.pullRequest, publishPhase.pullRequest);
  assert.equal(summary.prUrl, publishPhase.prUrl);
  assert.match(await readFile(ghLog, 'utf8'), /pr create/);
});

test('an approved run can resume PR description after a clean-tree stall', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['gate', 'review', 'pr-description'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *documentation-as-built*)
    printf '%s\\n' '# as built' > docs-as-built.md
    git add docs-as-built.md
    git commit -m 'docs: reconcile fixture documentation'
    ;;
  *'Take on the role of a senior developer'*)
   printf '%s\\n' '{"verdict":"APPROVED","blocking":[],"nits":[]}' > "$FIXTURE_VERDICT_PATH"
   ;;
 *'Write \`'*'/pr.md'*)
    attempts_file="\${FIXTURE_PR_PATH%/*}/description-attempts"
    if test -f "$attempts_file"; then
      printf '%s\\n\\n%s\\n' 'Title: Fixture description' 'The description is ready.' > "$FIXTURE_PR_PATH"
    else
      : > "$attempts_file"
      printf '%s\\n' 'clean this before publishing' > "$FIXTURE_WORKTREE/review-dirty.txt"
    fi
   ;;
  *)
    printf '%s\\n' implemented > implemented.txt
    git add implemented.txt
    git commit -m 'feat: implement fixture'
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalPrPath = process.env.FIXTURE_PR_PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  process.env.FIXTURE_PR_PATH = join(root, '.loop/runs/ss-demo-feature/pr.md');
  process.env.FIXTURE_WORKTREE = join(worktreeRoot, 'ss-demo-feature');
  let firstSummary;
  let resumedSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    process.exitCode = originalExitCode;
    await unlink(join(firstSummary.worktree, 'review-dirty.txt'));
    resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    if (originalPrPath === undefined) delete process.env.FIXTURE_PR_PATH;
    else process.env.FIXTURE_PR_PATH = originalPrPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(firstSummary.stalled.phase, 'pr-description');
  assert.equal(resumedSummary.stalled, null);
  const manifest = JSON.parse(await readFile(join(resumedSummary.runDir, 'manifest.json'), 'utf8'));
  const reviews = manifest.phases.filter((entry) => entry.role === 'verdict');
  const approvedReview = reviews.findLast((entry) => entry.status === 'completed');
  const gitPhase = manifest.phases.at(-1);
  assert.ok(reviews.some((entry) => entry.status === 'skipped'), 'resume should record skipped review bookkeeping');
  assert.ok(approvedReview, 'the completed approval should remain discoverable');
  assert.equal(approvedReview.verdict.verdict, 'APPROVED');
  assert.equal(gitPhase.phase, 'pr-description');
  assert.equal(gitPhase.status, 'completed');
  assert.equal(gitPhase.inputSha, approvedReview.verdict.sha);
});

test('a missing or malformed PR description stalls and can resume', async () => {
  for (const mode of ['missing', 'malformed']) {
    const worktreeRoot = await mkdtemp(join(tmpdir(), `loop-pr-description-${mode}-trees-`));
    const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
  phases: ['gate', 'review', 'pr-description'],
};
` });
    const binDir = await mkdtemp(join(tmpdir(), `loop-pr-description-${mode}-`));
    await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *'Take on the role of a senior developer'*)
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[]}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Write \`'*'/pr.md'*)
    attempt=1
    if [ -f "$FIXTURE_DESCRIPTION_ATTEMPTS" ]; then attempt=$(($(cat "$FIXTURE_DESCRIPTION_ATTEMPTS") + 1)); fi
    printf '%s\\n' "$attempt" > "$FIXTURE_DESCRIPTION_ATTEMPTS"
    if [ "$attempt" -ge 2 ]; then
      printf '%s\\n\\n%s\\n' 'Title: Resumed description' 'The description is valid.' > "$FIXTURE_PR_PATH"
    elif [ "$DESCRIPTION_MODE" = malformed ]; then
      printf '%s\\n' 'not a valid PR description' > "$FIXTURE_PR_PATH"
    fi
    ;;
esac
`, { mode: 0o755 });

    const originalPath = process.env.PATH;
    const originalMode = process.env.DESCRIPTION_MODE;
    const originalAttempts = process.env.FIXTURE_DESCRIPTION_ATTEMPTS;
    const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
    const originalPrPath = process.env.FIXTURE_PR_PATH;
    const originalExitCode = process.exitCode;
    const original = console.log;
    console.log = () => {};
    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.DESCRIPTION_MODE = mode;
    process.env.FIXTURE_DESCRIPTION_ATTEMPTS = join(root, 'description-attempts');
    process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
    process.env.FIXTURE_PR_PATH = join(root, '.loop/runs/ss-demo-feature/pr.md');
    let firstSummary;
    let resumedSummary;
    try {
      firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
      const firstManifest = JSON.parse(await readFile(join(firstSummary.runDir, 'manifest.json'), 'utf8'));
      const firstDescription = firstManifest.phases.findLast((entry) => entry.phase === 'pr-description');
      assert.equal(firstDescription.status, 'stalled');
      resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
    } finally {
      process.env.PATH = originalPath;
      if (originalMode === undefined) delete process.env.DESCRIPTION_MODE;
      else process.env.DESCRIPTION_MODE = originalMode;
      if (originalAttempts === undefined) delete process.env.FIXTURE_DESCRIPTION_ATTEMPTS;
      else process.env.FIXTURE_DESCRIPTION_ATTEMPTS = originalAttempts;
      if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
      else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
      if (originalPrPath === undefined) delete process.env.FIXTURE_PR_PATH;
      else process.env.FIXTURE_PR_PATH = originalPrPath;
      process.exitCode = originalExitCode;
      console.log = original;
    }

    assert.equal(firstSummary.stalled.phase, 'pr-description');
    assert.match(firstSummary.stalled.reason, mode === 'missing' ? /file is missing/ : /must start/);
    assert.equal(resumedSummary.stalled, null);
    const manifest = JSON.parse(await readFile(join(resumedSummary.runDir, 'manifest.json'), 'utf8'));
    const description = manifest.phases.findLast((entry) => entry.phase === 'pr-description');
    assert.equal(description.status, 'completed');
    assert.equal(description.artifacts.includes('pr.md'), true);
  }
});

test('a review that advances HEAD is rejected before its verdict is approved', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['gate', 'review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *'Take on the role of a senior developer'*)
    printf '%s\\n' mutated > "$FIXTURE_WORKTREE/review-mutation.txt"
    git -C "$FIXTURE_WORKTREE" add review-mutation.txt
    git -C "$FIXTURE_WORKTREE" commit -m 'chore: mutate during review'
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[],"nits":[]}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Push to '*)
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  process.env.FIXTURE_WORKTREE = join(worktreeRoot, 'ss-demo-feature');
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'review');
  assert.match(summary.stalled.reason, /review phase advanced HEAD/);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.phases.map((entry) => entry.phase), ['gate', 'review']);
  const gate = manifest.phases.find((entry) => entry.phase === 'gate');
  const review = manifest.phases.find((entry) => entry.phase === 'review');
  assert.equal(gate.outputSha, review.inputSha);
  assert.notEqual(review.inputSha, review.outputSha);
  assert.equal(review.status, 'stalled');
  assert.equal(review.verdict, undefined);
});

test('a reviewer mutation forces the completed gate to run again before resume approval', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['gate', 'review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *'Take on the role of a senior developer'*)
    if [ ! -f "$FIXTURE_WORKTREE/review-mutation.txt" ]; then
      printf '%s\\n' mutated > "$FIXTURE_WORKTREE/review-mutation.txt"
      git -C "$FIXTURE_WORKTREE" add review-mutation.txt
      git -C "$FIXTURE_WORKTREE" commit -m 'chore: mutate during review'
    fi
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[],"nits":[]}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Push to '*)
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  process.env.FIXTURE_WORKTREE = join(worktreeRoot, 'ss-demo-feature');
  let firstSummary;
  let resumedSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(firstSummary.stalled.phase, 'review');
  assert.equal(resumedSummary.stalled, null);
  const manifest = JSON.parse(await readFile(join(resumedSummary.runDir, 'manifest.json'), 'utf8'));
  const gates = manifest.phases.filter((entry) => entry.phase === 'gate');
  const reviews = manifest.phases.filter((entry) => entry.phase === 'review');
  assert.equal(gates.length, 2, 'resume must rerun the completed gate');
  assert.equal(gates.at(-1).status, 'completed');
  assert.equal(gates.at(-1).outputSha, reviews.at(-1).verdict.sha);
  assert.equal(reviews.at(-1).status, 'completed');
  assert.equal(reviews.at(-1).verdict.verdict, 'APPROVED');
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

test('an implement phase with no commit stalls and points to its log', async () => {
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
  assert.match(summary.stalled.reason, /implement produced no commit/);
  assert.match(summary.stalled.reason, /implement\.log/);
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(state.isComplete('implement'), false);
  assert.equal(state.manifest.entries.at(-1).status, 'stalled');
});

test('a phase with only head-advanced stalls without a commit', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: [{ name: 'commit-only', kind: 'agent', prompt: 'implement', postconditions: ['head-advanced'] }],
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

  assert.equal(summary.stalled.phase, 'commit-only');
  assert.match(summary.stalled.reason, /commit-only produced no commit/);
});

test('resume recognizes a manual commit from the stalled phase baseline', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const attemptsPath = join(await mkdtemp(join(tmpdir(), 'loop-attempts-')), 'count');
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: {
    recorder: {
      command: () => ({ command: 'sh', args: ['-c', ${JSON.stringify(`printf x >> ${attemptsPath}`)}] }),
    },
  },
  engines: { default: 'recorder' },
  phases: [{ name: 'implement', kind: 'agent', prompt: 'implement', postconditions: ['clean-tree', 'head-advanced'] }],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let firstSummary;
  try {
    firstSummary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(firstSummary.stalled.phase, 'implement');
  const firstState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  const baseline = firstState.data.phaseBaselines.implement;
  assert.match(baseline, /^[0-9a-f]{40}$/);

  await writeFile(join(firstSummary.worktree, 'manual-fix.txt'), 'fixed\n');
  await git(firstSummary.worktree, 'add', 'manual-fix.txt');
  await git(firstSummary.worktree, 'commit', '-m', 'fix: manual implementation');

  const resumedSummary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  assert.equal(resumedSummary.stalled, null);
  assert.deepEqual(resumedSummary.phases.map((phase) => phase.name), ['implement']);
  assert.equal(await readFile(attemptsPath, 'utf8'), 'x', 'resume must not invoke the agent again');

  const resumedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(resumedState.data.phaseBaselines.implement, baseline);
  assert.equal(resumedState.isComplete('implement'), true);
  const implementationEntries = resumedState.manifest.entries.filter((entry) => entry.phase === 'implement');
  assert.equal(implementationEntries.at(-1).status, 'completed');
  assert.equal(implementationEntries.at(-1).inputSha, baseline);
  assert.notEqual(implementationEntries.at(-1).outputSha, baseline);

  const secondResume = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  assert.equal(secondResume.stalled, null);
  const finalState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(finalState.data.phaseBaselines.implement, baseline);
  assert.equal(await readFile(attemptsPath, 'utf8'), 'x');
});

test('an implement phase that leaves edits uncommitted stalls', async () => {
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
  const originalExitCode = process.exitCode;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'implement');
  assert.match(summary.stalled.reason, /left uncommitted changes/);
});

test('resume with a note re-drives only the stalled phase and records it in the prompt hash', async () => {
  const promptCapture = join(await mkdtemp(join(tmpdir(), 'loop-prompts-')), 'prompts.txt');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const agentScript = `prompt=$1
printf '%s\\n---\\n' "$prompt" >> ${JSON.stringify(promptCapture)}
if [ ! -f changed.txt ]; then printf 'changed\\n' > changed.txt; fi
case "$prompt" in *'commit and stop'*) git add changed.txt && git commit -m 'fix: finish implementation' >/dev/null ;; esac`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command({ prompt }) { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(agentScript)}, 'note-agent', prompt] }; } } },
  engines: { default: 'mytool' },
  phases: ['implement', 'docs'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let initial;
  let resumed;
  try {
    initial = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumed = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, note: 'commit and stop', yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  assert.match(initial.stalled.reason, /left uncommitted changes/);
  assert.equal(resumed.stalled, null);
  const prompts = (await readFile(promptCapture, 'utf8')).split('---\n').filter(Boolean);
  const notedPrompt = prompts.find((prompt) => prompt.includes('## Operator note (read this first)'));
  assert.ok(notedPrompt);
  assert.match(notedPrompt, /commit and stop/);
  assert.equal(prompts.filter((prompt) => prompt.includes('## Operator note (read this first)')).length, 1);
  const manifest = JSON.parse(await readFile(join(resumed.runDir, 'manifest.json'), 'utf8'));
  const initialEntry = manifest.phases.find((entry) => entry.phase === 'implement');
  const notedEntry = manifest.phases.findLast((entry) => entry.phase === 'implement');
  assert.notEqual(notedEntry.promptHash, initialEntry.promptHash, 'the note changes the recorded prompt hash');
});

test('operator notes prefer --note over --note-file and reject blank input', async () => {
  const { root, workItem } = await repoFixture({ phases: ['implement'] });
  await writeFile(join(root, 'operator-note.md'), 'from file');
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    await runLoop({
      args: { taskFile: workItem, cwd: root, dryRun: true, yes: true, note: 'from flag', noteFile: 'operator-note.md' },
    });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /from flag/);
  assert.doesNotMatch(lines.join('\n'), /from file/);
  await assert.rejects(
    runLoop({ args: { taskFile: workItem, cwd: root, dryRun: true, yes: true, note: '   ' } }),
    /non-whitespace text/,
  );
});

test('--from with a note re-runs an already completed phase', async () => {
  const promptCapture = join(await mkdtemp(join(tmpdir(), 'loop-prompts-')), 'from-prompts.txt');
  const agentScript = `printf '%s\\n---\\n' "$1" >> ${JSON.stringify(promptCapture)}`;
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command({ prompt }) { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(agentScript)}, 'from-agent', prompt] }; } } },
  engines: { default: 'mytool' },
  phases: ['docs'],
  worktrees: false,
};
` });
  const original = console.log;
  console.log = () => {};
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, from: 'docs', note: 'run docs again', yes: true } });
  } finally {
    console.log = original;
  }
  const prompts = await readFile(promptCapture, 'utf8');
  assert.equal((prompts.match(/## Operator note \(read this first\)/g) ?? []).length, 1);
  const state = JSON.parse(await readFile(join(root, '.loop/runs/ss-demo-feature/state.json'), 'utf8'));
  assert.equal(state.completed.includes('docs'), true);
});

test('an implement phase that only prints text stalls', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\necho "could not complete"\n', { mode: 0o755 });
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
  assert.match(summary.stalled.reason, /implement produced no commit/);
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

test('an address phase that commits its fix completes normally', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt="$2"
case "$prompt" in
  *"Machine-readable verdict"*)
    verdict_path=$(printf '%s\\n' "$prompt" | sed -n 's/^.*write this JSON to \`\\([^\`]*\\)\`.*/\\1/p')
    case "$prompt" in
      *"round 2 of"*) printf '%s' '{"verdict":"APPROVED","blocking":[]}' > "$verdict_path" ;;
      *) printf '%s' '{"verdict":"CHANGES_REQUESTED","blocking":[{"file":"src/x.mjs","line":1,"issue":"fix it"}]}' > "$verdict_path" ;;
    esac
    ;;
  *)
    printf 'fixed\\n' > fixed.txt
    git add fixed.txt
    git commit -m 'fix: address finding' >/dev/null
    ;;
esac
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
  assert.equal(await git(summary.worktree, 'log', '-1', '--pretty=%s'), 'fix: address finding');

  const snapshot = JSON.parse(await readFile(join(summary.runDir, 'snapshot.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(snapshot.promptHashes, {
    source: 'manifest.json',
    selector: 'phases[*].promptHash',
  });
  const agentInvocations = manifest.phases.filter((entry) => entry.promptHash);
  assert.deepEqual(agentInvocations.map((entry) => entry.phase), ['review', 'address', 'review']);
  assert.ok(agentInvocations.every((entry) => /^[a-f0-9]{64}$/.test(entry.promptHash)));
  assert.notEqual(agentInvocations[0].promptHash, agentInvocations[2].promptHash, 'later review uses its actual round context');
});

test('an address phase with a written rebuttal may complete without a commit', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('Machine-readable verdict')) {
  const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
  const approved = prompt.includes('round 2 of');
  writeFileSync(verdictPath, JSON.stringify(approved
    ? { verdict: 'APPROVED', blocking: [] }
    : { verdict: 'CHANGES_REQUESTED', blocking: [{ file: 'src/x.mjs', line: 1, issue: 'not a bug' }] }));
} else {
  const rebuttalPath = prompt.slice(prompt.indexOf('Write any rebuttal to')).split(String.fromCharCode(96))[1];
  writeFileSync(rebuttalPath, 'The finding does not apply.\\n');
}
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
  assert.equal(await readFile(join(summary.runDir, 'response-round-1.md'), 'utf8'), 'The finding does not apply.\n');
});

test('an address phase with findings but no fix or rebuttal stalls', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('Machine-readable verdict')) {
  const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
  writeFileSync(verdictPath, JSON.stringify({
    verdict: 'CHANGES_REQUESTED',
    blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }],
  }));
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

  assert.equal(summary.stalled.phase, 'address');
  assert.match(summary.stalled.reason, /no fix commit and no rebuttal recorded/);
});

test('an inline repair with only head-advanced-or-rebuttal stalls without a fix or rebuttal', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: [{
    name: 'check',
    kind: 'agent',
    prompt: 'review',
    verdict: true,
    repair: [{
      name: 'fix',
      kind: 'agent',
      prompt: 'address',
      role: 'repair',
      postconditions: ['head-advanced-or-rebuttal'],
    }],
  }],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.includes('Machine-readable verdict')) {
  const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
  writeFileSync(verdictPath, JSON.stringify({
    verdict: 'CHANGES_REQUESTED',
    blocking: [{ file: 'src/x.mjs', line: 1, issue: 'fix it' }],
  }));
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

  assert.equal(summary.stalled.phase, 'fix');
  assert.match(summary.stalled.reason, /no fix commit and no rebuttal recorded/);
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

test('a dry run reports prompts for the requested base branch without creating it', async () => {
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
  await assert.rejects(readdir(summary.worktree), { code: 'ENOENT' });
  assert.equal(await git(root, 'branch', '--list', 'feat/ss-demo-feature'), '');
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

test('a dry-run resume does not consume its persisted base branch', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  await createBranchWithCommit(root, 'feat/parent', 'PARENT.md', 'parent work\n');
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ baseBranch: 'feat/parent' });

  const original = console.log;
  const resumedLines = [];
  console.log = (message) => resumedLines.push(String(message));
  try {
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(resumedLines.join('\n'), /base      : master/);
  assert.match(resumedLines.join('\n'), /git diff master\.\.\.HEAD/);
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

test('a dry-run resume starts from a fresh verdict round', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.match(output, /review \(round 1\/3\)/);
  assert.match(output, /none — review the cumulative branch diff/);
});

test('a dry-run resume does not replay a persisted repair checkpoint', async () => {
  const { root, workItem } = await repoFixture({
    phases: ['gate', 'review', 'address'],
  });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.doesNotMatch(output, /address \(round 1 resume\)/);
  assert.match(output, /review \(round 1\/3\)/);
  assert.match(output, /would run: git --version/);
  assert.ok(output.indexOf('would run: git --version') < output.indexOf('review (round 1/3)'));
});

test('a dry-run resume does not start at a persisted address phase', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.doesNotMatch(output, /address \(round 1 resume\)/);
  assert.match(output, /review \(round 1\/3\)/);
});

test('a dry-run resume ignores a persisted review round cap', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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

  assert.equal(summary.stalled, null);
  assert.match(lines.join('\n'), /review \(round 1\/3\)/);
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(state.data.pendingRepairs.review.round, 1, 'the last round is checkpointed as owed');
  assert.equal(state.data.pendingRepairs.review.nextRepair, 0);
});

test('a dry-run resume with a raised cap ignores an owed repair', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.doesNotMatch(output, /address \(round 3 resume\)/);
  assert.match(output, /review \(round 1\/5\)/);
});

test('a dry-run resume without a raised cap ignores the saved cap', async () => {
  const { root, workItem } = await repoFixture({ phases: ['review', 'address'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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

  assert.equal(summary.stalled, null);
  assert.match(lines.join('\n'), /review \(round 1\/3\)/);
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
    await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['publish'], dryRun: true, yes: true } });
    assert.match(lines.join('\n'), /would push jprichter\/feat\//, 'the configured remote wins over origin');
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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

test('a failing gate uses its bounded repair transition and re-gates', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const repairScript = "printf 'fixed\\n' > gate-fixed\ngit add gate-fixed && git commit -m 'fix: repair gate' >/dev/null";
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command() { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(repairScript)}] }; } } },
  engines: { default: 'mytool' },
  gate: ['test -f gate-fixed'],
  phases: [{ name: 'gate', repair: [{ name: 'fix-gate', kind: 'agent', role: 'repair', prompt: 'fix-gate', permissions: ['write-worktree'], postconditions: ['clean-tree', 'head-advanced'] }] }],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true, maxRounds: 2 } });
  } finally {
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.deepEqual(summary.phases.map((phase) => phase.name), ['gate']);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.phases.map((entry) => entry.status), ['stalled', 'completed', 'completed']);
  assert.equal(manifest.phases.at(-1).outputSha, await git(summary.worktree, 'rev-parse', 'HEAD'));
});

test('a resumed gate repair starts at its saved repair checkpoint before re-gating', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const eventLog = join(await mkdtemp(join(tmpdir(), 'loop-events-')), 'events.log');
  const repairScript = [`printf 'repair\\n' >> ${JSON.stringify(eventLog)}`, 'printf fixed > gate-fixed', "git add gate-fixed && git commit -m 'fix: repair gate' >/dev/null"].join('\n');
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command() { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(repairScript)}] }; } } },
  engines: { default: 'mytool' },
  gate: [${JSON.stringify(`printf 'gate\\n' >> ${eventLog}; test -f gate-fixed`)}],
  phases: [{ name: 'gate', repair: [{ name: 'fix-gate', kind: 'agent', role: 'repair', prompt: 'fix-gate', permissions: ['write-worktree'], postconditions: ['clean-tree', 'head-advanced'] }] }],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    pendingRepairs: {
      gate: {
        round: 1,
        reviewedSha: await git(root, 'rev-parse', 'HEAD'),
        verdict: { blocking: [] },
        gateOk: false,
        gateFailure: 'test -f gate-fixed\\ngate was red',
        nextRepair: 0,
      },
    },
  });

  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(summary.stalled, null);
  assert.deepEqual((await readFile(eventLog, 'utf8')).trim().split('\n'), ['repair', 'gate']);
  const resumedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(resumedState.data.pendingRepairs?.gate, undefined, 'the passing re-gate clears the saved checkpoint');
});

test('a noted completed phase invalidates downstream gate and review attestations', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const gateLog = join(await mkdtemp(join(tmpdir(), 'loop-events-')), 'gates.log');
  const agentScript = [
    'prompt=$1',
    `case "$prompt" in *'Take on the role of a senior developer'*)`,
    "  verdict_path=$(printf '%s\\n' \"$prompt\" | sed -n 's/.*write this JSON to `\\([^`]*\\)`.*/\\1/p')",
    "  printf '%s\\n' '{\"verdict\":\"APPROVED\",\"blocking\":[]}' > \"$verdict_path\"",
    '  ;;',
    `*'second implementation'*) printf implemented > second.txt; git add second.txt && git commit -m 'feat: implement fixture' >/dev/null ;;`,
    "*) printf implemented > first.txt; git add first.txt && git commit -m 'feat: implement fixture' >/dev/null ;;",
    'esac',
  ].join('\n');
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command({ prompt }) { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(agentScript)}, 'note-agent', prompt] }; } } },
  engines: { default: 'mytool' },
  gate: [${JSON.stringify(`printf 'gate\\n' >> ${gateLog}`)}],
  phases: ['implement', 'gate', 'review'],
  maxRounds: 1,
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });

  const original = console.log;
  console.log = () => {};
  let initial;
  let resumed;
  try {
    initial = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumed = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, from: 'implement', note: 'second implementation', yes: true } });
  } finally {
    console.log = original;
  }

  assert.equal(initial.stalled, null);
  assert.equal(resumed.stalled, null);
  assert.deepEqual((await readFile(gateLog, 'utf8')).trim().split('\n'), ['gate', 'gate']);
  const manifest = JSON.parse(await readFile(join(resumed.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'gate' && entry.status === 'completed').length, 2);
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'review' && entry.status === 'completed').length, 2);
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'gate' && entry.status === 'skipped').length, 0);
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'review' && entry.status === 'skipped').length, 0);
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  assert.equal(state.data.rounds.review, 1, 'the re-run review starts from its first round');
  assert.equal(state.data.reviewedShas.review[1], await git(resumed.worktree, 'rev-parse', 'HEAD'));
});

test('a noted review rerun clears nested repair baselines before addressing findings', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const agentScript = [
    'prompt=$1',
    'if printf "%s" "$prompt" | grep -q "Machine-readable verdict"; then',
    "  verdict_path=$(printf '%s\\n' \"$prompt\" | sed -n 's/.*write this JSON to `\\([^`]*\\)`.*/\\1/p')",
    '  if printf "%s" "$prompt" | grep -q "round 2 of"; then',
    `    printf '%s\\n' '{"verdict":"APPROVED","blocking":[]}' > "$verdict_path"`,
    '  else',
    `    printf '%s\\n' '{"verdict":"CHANGES_REQUESTED","blocking":[{"file":"src/x.mjs","line":1,"issue":"fix it"}]}' > "$verdict_path"`,
    '  fi',
    'elif test -f repair.txt; then',
    '  :',
    'else',
    "  printf repaired > repair.txt; git add repair.txt && git commit -m 'fix: address finding' >/dev/null",
    'fi',
  ].join('\n');
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command({ prompt }) { return { command: '/bin/sh', args: ['-c', ${JSON.stringify(agentScript)}, 'review-agent', prompt] }; } } },
  engines: { default: 'mytool' },
  gate: ['true'],
  phases: ['review', 'address'],
  maxRounds: 2,
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });

  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let initial;
  let resumed;
  try {
    initial = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
    resumed = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, from: 'review', note: 'recheck the review', yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(initial.stalled, null);
  assert.equal(resumed.stalled.phase, 'address');
  assert.match(resumed.stalled.reason, /no fix commit and no rebuttal recorded/);
});

test('a gate repair cap stalls with the last gate output', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command() { return { command: '/bin/sh', args: ['-c', ''] }; } } },
  engines: { default: 'mytool' },
  gate: ['printf last-gate >&2; exit 1'],
  phases: [{ name: 'gate', repair: [{ name: 'fix-gate', kind: 'agent', role: 'repair', prompt: 'fix-gate', permissions: ['write-worktree'], postconditions: ['clean-tree'] }] }],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true, maxRounds: 2 } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  assert.match(summary.stalled.reason, /gate failed/);
  assert.match(summary.stalled.output, /last-gate/);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.phases.filter((entry) => entry.phase === 'gate').length, 3);
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

test('gate commands accept argv entries and run without a shell', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: [{ argv: ['node', '-e', 'process.exit(0)'] }],
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
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const gateEntry = manifest.phases.find((entry) => entry.phase === 'gate');
  assert.equal(gateEntry.gateReceipts.length, 1);
  assert.equal(gateEntry.gateReceipts[0].command, 'node -e process.exit(0)');
  assert.equal(gateEntry.gateReceipts[0].exitCode, 0);
});

test('gate commands accept per-platform entries and pick the current platform variant', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: [{ posix: 'true', windows: 'cmd /c exit 0' }],
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
});

test('setup commands accept argv entries and run without a shell', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  setup: [{ argv: ['node', '-e', "require('fs').writeFileSync('setup-marker', 'ok')"] }],
  gate: [{ argv: ['node', '-e', "process.exit(require('fs').readFileSync('setup-marker', 'utf8') === 'ok' ? 0 : 1)"] }],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(summary.worktree, 'setup-marker'), 'utf8'), 'ok');
});

test('configured shell runs setup and gate commands', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  shell: 'bash',
  setup: ['[[ "setup" == "setup" ]] && printf setup > shell-marker'],
  gate: ['[[ -f shell-marker ]] && [[ "$(cat shell-marker)" == setup ]]'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['gate'], yes: true } });
  } finally {
    console.log = original;
  }
  assert.equal(summary.stalled, null);
  assert.equal(await readFile(join(summary.worktree, 'shell-marker'), 'utf8'), 'setup');
});

test('a normal run writes a schema-versioned manifest', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  gate: ['true'],
  phases: ['gate'],
  worktreeRoot: ${JSON.stringify(await mkdtemp(join(tmpdir(), 'loop-trees-')))},
};
`,
  });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
  }

  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(summary.runDir, 'state.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runId, state.runId);
  assert.equal(manifest.name, summary.task);
  assert.equal(manifest.worktree, summary.worktree);
  assert.equal(manifest.taskFile, workItem);
  assert.equal(manifest.snapshot, 'snapshot.json');
});

test('a normal run writes a reproducibility snapshot at start', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  adapters: {
    mytool: {
      command: () => ({ command: process.execPath, args: ['-e', ''] }),
      version: () => 'mytool 1.2.3',
    },
  },
  engines: { default: 'mytool' },
  gate: ['true'],
  phases: [
    { name: 'work', kind: 'agent', prompt: 'implement', postconditions: [] },
    { name: 'checks', kind: 'gate', commands: ['true'] },
  ],
  worktrees: false,
};
`,
  });
  const baseSha = await git(root, 'rev-parse', 'master');
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
  }

  const snapshot = JSON.parse(await readFile(join(summary.runDir, 'snapshot.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(snapshot.snapshotVersion, 1);
  assert.equal(snapshot.baseSha, baseSha);
  assert.equal(snapshot.branch, summary.branch);
  assert.equal(snapshot.baseBranch, 'master');
  assert.equal(snapshot.configHash, hashConfig(snapshot.resolvedConfig));
  assert.equal(snapshot.configHash, manifest.phases.find((phase) => phase.phase === 'work').configHash);
  assert.deepEqual(snapshot.promptHashes, {
    source: 'manifest.json',
    selector: 'phases[*].promptHash',
  });
  assert.deepEqual(snapshot.engineVersions, { mytool: 'mytool 1.2.3' });
  assert.deepEqual(snapshot.gateDefinitions, {
    default: ['true'],
    phases: [{ name: 'checks', commands: ['true'] }],
  });
  assert.equal(snapshot.environment.nodeVersion, process.version);
  assert.equal(snapshot.environment.platform, process.platform);
  assert.equal(snapshot.environment.cwd, process.cwd());
  assert.equal(snapshot.environment.timestamp, snapshot.capturedAt);
  assert.match(snapshot.aloopVersion, /^\d+\.\d+\.\d+/);
});

test('a snapshot omits unavailable engine versions', async () => {
  const { root, workItem } = await repoFixture({
    config: `export default {
  adapters: {
    mytool: { command: () => ({ command: process.execPath, args: ['-e', ''] }) },
  },
  engines: { default: 'mytool' },
  phases: [{ name: 'work', kind: 'agent', prompt: 'implement', postconditions: [] }],
  worktrees: false,
};
`,
  });
  const original = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    console.log = original;
  }

  const snapshot = JSON.parse(await readFile(join(summary.runDir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(snapshot.engineVersions, {});
});

test('an approving reviewer after a failed repair gate stalls cleanly', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const reviewMarker = `review-one-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['test ! -f ${reviewMarker}'],
  phases: ['gate', 'review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt="$2"
if [ "$1" = '--version' ]; then
  exit 0
fi
case "$prompt" in
  *"Machine-readable verdict"*)
    verdict_path=$(printf '%s\\n' "$prompt" | sed -n 's/^.*write this JSON to \`\\([^\`]*\\)\`.*/\\1/p')
    if test -f "$FIXTURE_WORKTREE/${reviewMarker}"; then
      printf '%s' '{"verdict":"APPROVED","blocking":[]}' > "$verdict_path"
    else
      printf '%s' '{"verdict":"CHANGES_REQUESTED","blocking":[{"file":"src/x.mjs","line":1,"issue":"fix it"}]}' > "$verdict_path"
    fi
    ;;
  *)
    : > "$FIXTURE_WORKTREE/${reviewMarker}"
    git -C "$FIXTURE_WORKTREE" add ${reviewMarker}
    git -C "$FIXTURE_WORKTREE" commit -m 'fix: preserve failed repair gate' >/dev/null
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalExitCode = process.exitCode;
  let summary;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_WORKTREE = join(worktreeRoot, 'ss-demo-feature');
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'review');
  assert.equal(summary.stalled.reason, 'approval withheld: repair gate remains failing');
  assert.match(summary.stalled.output, new RegExp(`test ! -f ${reviewMarker}`));
});

test('a read-only reviewer stalls when it changes a worktree file', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review'],
  worktrees: false,
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (process.argv[2] === '--version') process.exit(0);
const verdictPath = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
const worktree = process.env.FIXTURE_WORKTREE;
writeFileSync(join(worktree, 'review-tampered.txt'), 'must be rejected');
writeFileSync(verdictPath, JSON.stringify({ verdict: 'APPROVED', blocking: [] }));
` , { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalWorktree = process.env.FIXTURE_WORKTREE;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_WORKTREE = root;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalWorktree === undefined) delete process.env.FIXTURE_WORKTREE;
    else process.env.FIXTURE_WORKTREE = originalWorktree;
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }

  assert.equal(await readFile(join(root, 'review-tampered.txt'), 'utf8'), 'must be rejected');
  assert.equal(summary.stalled.phase, 'review');
  assert.match(summary.stalled.reason, /changed files in the worktree/);
});

test('a reviewer cannot consume a stale approval from the same round', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const runDir = join(root, '.loop/runs/ss-demo-feature');
  await mkdir(runDir, { recursive: true });
  const verdictPath = join(runDir, 'verdict-round-1.json');
  await writeFile(verdictPath, '{"verdict":"APPROVED","blocking":[]}');

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const path = prompt.slice(prompt.indexOf('write this JSON to')).split(String.fromCharCode(96))[1];
writeFileSync(path, JSON.stringify({ verdict: 'CHANGES_REQUESTED', blocking: [{ issue: 'fix it' }] }));
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'review');
  assert.equal(summary.stalled.reason, 'no repair phase configured');
  assert.equal(summary.phases[0].verdict, 'CHANGES_REQUESTED');
  assert.deepEqual(JSON.parse(await readFile(verdictPath, 'utf8')), {
    verdict: 'CHANGES_REQUESTED',
    blocking: [{ issue: 'fix it' }],
  });
});

test('a silent reviewer stalls instead of consuming a stale verdict', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const runDir = join(root, '.loop/runs/ss-demo-feature');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'verdict-round-1.json'), '{"verdict":"APPROVED","blocking":[]}');

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.env.PATH = `${binDir}:${originalPath}`;
  console.log = () => {};
  try {
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, yes: true } }),
      /The review phase did not write a verdict to .*verdict-round-1\.json\./,
    );
  } finally {
    process.env.PATH = originalPath;
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
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

test('switching engines drops the configured model and effort (they are vendor-specific)', async () => {
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
  // `sonnet` is a claude model; handing it to codex is nonsense, so the switch
  // drops it and codex falls back to its own default.
  assert.match(lines.join('\n'), /engine: codex\s+prompt:/);
  assert.doesNotMatch(lines.join('\n'), /model: sonnet/);
});

test('--engine keeps the configured model and effort when the engine is unchanged', async () => {
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
    await runLoop({ args: { taskFile: workItem, cwd: root, engine: 'claude', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: claude\s+model: sonnet\s+effort: high/);
});

test('--model and --effort override the default engine model and effort', async () => {
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
    await runLoop({ args: { taskFile: workItem, cwd: root, model: 'opus', effort: 'low', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: claude\s+model: opus\s+effort: low/);
});

test('--engine and --model together select a new engine and its model', async () => {
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
    await runLoop({ args: { taskFile: workItem, cwd: root, engine: 'gemini', model: 'gemini-3-pro', dryRun: true, yes: true } });
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /engine: gemini\s+model: gemini-3-pro/);
});

test('a dry-run resume uses configured agent settings instead of persisted settings', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'high' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.match(lines.join('\n'), /engine: claude\s+model: new-model\s+effort: high/);
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ agentSettings: { implement: { name: 'agy', model: 'saved-model', effort: 'low' } } });

  await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, config: suppliedConfig, yes: true } });

  const resumedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  const override = resumedState.data.configOverrides.at(-1);
  assert.deepEqual(resumedState.data.agentSettings, {});
  assert.equal(override.path, suppliedConfig);
  assert.deepEqual(override.values.gate, ['true']);
  assert.deepEqual(override.values.phases, ['gate']);
  assert.equal(override.values.maxRounds, 7);
});

test('a dry-run resume does not inspect a saved worktree', async () => {
  const { root, workItem } = await repoFixture({ phases: ['gate'] });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  const missingWorktree = join(await mkdtemp(join(tmpdir(), 'loop-missing-worktree-')), 'removed');
  await state.record({ branch: 'feat/ss-demo-feature', worktree: missingWorktree, baseBranch: 'master' });

  const summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, dryRun: true, yes: true } });
  assert.notEqual(summary.worktree, missingWorktree);
  assert.equal(summary.worktree.endsWith('ss-demo-feature'), true);
});

test('a dry-run resume config does not consume a saved branch or worktree', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ phases: ['gate'] });
  const savedWorktree = join(worktreeRoot, 'existing-run');
  await git(root, 'worktree', 'add', '-b', 'feat/saved-run', savedWorktree, 'master');
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ branch: 'feat/saved-run', worktree: savedWorktree, baseBranch: 'master' });
  const suppliedConfig = join(await mkdtemp(join(tmpdir(), 'loop-config-')), 'resume.config.mjs');
  await writeFile(suppliedConfig, "export default { branchPrefix: 'feat/other-', gate: ['true'], phases: ['gate'], worktrees: false };\n");

  const summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, config: suppliedConfig, dryRun: true, yes: true } });

  assert.equal(summary.branch, 'feat/other-ss-demo-feature');
  assert.equal(summary.worktree, root);
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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

  const resumedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  // Switching engines drops the saved model/effort — `saved-model` is a claude
  // model and means nothing to agy — so the override leaves only the new name.
  assert.deepEqual(resumedState.data.agentSettings.implement, { name: 'agy' });
  assert.deepEqual(resumedState.data.engineOverrides.at(-1).phases.implement, {
    from: { name: 'claude', model: 'saved-model', effort: 'low' },
    to: { name: 'agy' },
  });
  assert.match(lines.join('\n'), /resumed engine override:[\s\S]*implement: claude model=saved-model effort=low → agy/);
  const phaseLog = await readFile(join(root, '.loop/runs/ss-demo-feature/implement.log'), 'utf8');
  assert.match(phaseLog, /resumed override: claude model=saved-model effort=low → agy/);
});

test('a resume engine override applies --model and --effort to the new engine', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'xhigh' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
    await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, engine: 'agy', model: 'agy-pro', effort: 'high', overrideEngine: true, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  const resumedState = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  // --model/--effort replace the dropped vendor-specific saved values on the new engine.
  assert.deepEqual(resumedState.data.agentSettings.implement, { name: 'agy', model: 'agy-pro', effort: 'high' });
  assert.deepEqual(resumedState.data.engineOverrides.at(-1).phases.implement, {
    from: { name: 'claude', model: 'saved-model', effort: 'low' },
    to: { name: 'agy', model: 'agy-pro', effort: 'high' },
  });
  assert.match(lines.join('\n'), /resumed engine override:[\s\S]*implement: claude model=saved-model effort=low → agy model=agy-pro effort=high/);
});

test('a resume engine override rejects an effort the new engine cannot honor', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'xhigh' } },
  gate: ['true'],
  phases: ['implement'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({
    agentSettings: { implement: { name: 'claude', model: 'saved-model', effort: 'low' } },
  });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'agy'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    // agy supports low/medium/high, so xhigh must be rejected before any phase runs.
    await assert.rejects(
      runLoop({ args: { taskFile: workItem, cwd: root, resume: true, engine: 'agy', effort: 'xhigh', overrideEngine: true, yes: true } }),
      /does not support effort "xhigh"/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a dry-run engine override cannot consume persisted agent settings', async () => {
  const { root, workItem } = await repoFixture({ config: `export default {
  adapters: { mytool: { command: ({ prompt }) => ({ command: 'mytool', args: [prompt] }) } },
  engines: { default: 'claude' },
  gate: ['true'],
  phases: ['implement'],
  worktrees: false,
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ agentSettings: { implement: { name: 'claude', effort: 'low' } } });

  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  try {
    await assert.rejects(
      runLoop({
        args: { taskFile: workItem, cwd: root, resume: true, engine: 'mytool', overrideEngine: true, dryRun: true, yes: true },
      }),
      /--override-engine requires saved agent settings from an earlier run/,
    );
  } finally {
    console.log = original;
  }
  assert.equal(lines.join('\n'), '');
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
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['publish'] });
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
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, phases: ['publish'], yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  assert.equal(summary.stalled.phase, 'publish');
  assert.match(summary.stalled.reason, /uncommitted changes/);
  assert.match(summary.stalled.output, /DIRTY\.txt/);
  assert.deepEqual(summary.phases, [], 'the stalled phase is not recorded as complete');
  assert.doesNotMatch(lines.join('\n'), /engine:/, 'no agent runs over the dirty tree');
});

test('an unauthenticated GitHub CLI stalls publishing before it can push', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['publish'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');
  const approvedSha = await git(worktree, 'rev-parse', 'HEAD');
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ branch: 'feat/ss-demo-feature', worktree, baseBranch: 'master' });
  state.manifest.append({
    phase: 'gate',
    kind: 'gate',
    role: 'gate',
    status: 'completed',
    outputSha: approvedSha,
  });
  state.manifest.append({
    phase: 'review',
    kind: 'agent',
    role: 'verdict',
    status: 'completed',
    verdict: { verdict: 'APPROVED', blocking: [], nits: [], sha: approvedSha },
  });
  await state.save();

  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'gh'), "#!/bin/sh\nprintf 'not authenticated\\n' >&2\nexit 1\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, phases: ['publish'], yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'publish');
  assert.match(summary.stalled.reason, /GitHub publishing precheck failed/);
  assert.deepEqual(summary.phases, []);
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const publishPhase = manifest.phases.find((phase) => phase.phase === 'publish');
  assert.equal(publishPhase.status, 'stalled');
});

test('publishing stalls when the approved SHA has no gate receipt before its review', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  // A partial run that begins at `review` never runs a gate: the review loop
  // starts with gateOk defaulted true and can approve HEAD. Publishing must
  // refuse a SHA no gate ever exercised.
  const { root, workItem } = await repoFixture({ config: `export default {
  gate: ['true'],
  phases: ['review', 'publish'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  await writeFile(join(binDir, 'claude'), `#!/bin/sh
prompt=$2
case "$prompt" in
  *'Take on the role of a senior developer'*)
    printf '%s\\n' '{"verdict":"APPROVED","blocking":[],"nits":[]}' > "$FIXTURE_VERDICT_PATH"
    ;;
  *'Push to '*)
    ;;
esac
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalVerdictPath = process.env.FIXTURE_VERDICT_PATH;
  const originalExitCode = process.exitCode;
  const original = console.log;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FIXTURE_VERDICT_PATH = join(root, '.loop/runs/ss-demo-feature/verdict-round-1.json');
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalVerdictPath === undefined) delete process.env.FIXTURE_VERDICT_PATH;
    else process.env.FIXTURE_VERDICT_PATH = originalVerdictPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'publish');
  assert.equal(summary.stalled.reason, `current HEAD matches approved review SHA ${await git(summary.worktree, 'rev-parse', 'HEAD')}, but no passing gate receipt for that SHA was recorded before the review`);
  assert.doesNotMatch(summary.stalled.reason, /publishing requires the approved SHA/);
  assert.doesNotMatch(lines.join('\n'), /Push to/, 'the git agent never runs over an ungated approval');
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.phases.some((entry) => entry.role === 'gate'), false, 'no gate ran in this partial pipeline');
  const publishPhase = manifest.phases.at(-1);
  assert.equal(publishPhase.phase, 'publish');
  assert.equal(publishPhase.status, 'stalled');
});

test('publishing stalls when HEAD advanced after an approved review', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['publish'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');
  const approvedSha = await git(worktree, 'rev-parse', 'HEAD');
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ branch: 'feat/ss-demo-feature', worktree, baseBranch: 'master' });
  state.manifest.append({
    phase: 'review',
    kind: 'agent',
    role: 'verdict',
    status: 'completed',
    verdict: { verdict: 'APPROVED', blocking: [], nits: [], sha: approvedSha },
  });
  await state.save();

  await writeFile(join(worktree, 'post-approval.txt'), 'advanced\\n');
  await git(worktree, 'add', 'post-approval.txt');
  await git(worktree, 'commit', '-m', 'chore: advance after approval');

  const original = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];
  console.log = (message) => lines.push(String(message));
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, phases: ['publish'], yes: true } });
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }

  const currentSha = await git(worktree, 'rev-parse', 'HEAD');
  assert.equal(summary.stalled.phase, 'publish');
  assert.match(summary.stalled.reason, /does not match the approved review SHA/);
  assert.match(summary.stalled.output, new RegExp(approvedSha));
  assert.match(summary.stalled.output, new RegExp(currentSha));
  assert.doesNotMatch(lines.join('\\n'), /engine:/, 'no agent runs over an unattested tree');
  const manifest = JSON.parse(await readFile(join(summary.runDir, 'manifest.json'), 'utf8'));
  const entry = manifest.phases.at(-1);
  assert.equal(entry.phase, 'publish');
  assert.equal(entry.status, 'stalled');
  assert.equal(entry.approvedSha, approvedSha);
  assert.equal(entry.inputSha, currentSha);
});

test('a resume through the publish phase stalls without a completed current-SHA approval', async () => {
  const { root, workItem, worktreeRoot } = await repoFixture({ phases: ['publish'] });
  const worktree = join(worktreeRoot, 'ss-demo-feature');
  await git(root, 'worktree', 'add', '-b', 'feat/ss-demo-feature', worktree, 'master');
  // A capped review left owed findings, but the tree is clean. Publishing still
  // requires a completed approval for the current SHA.
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  const originalExitCode = process.exitCode;
  const original = console.log;
  console.log = () => {};
  process.env.PATH = `${binDir}:${originalPath}`;
  let summary;
  try {
    summary = await runLoop({ args: { taskFile: workItem, cwd: root, resume: true, phases: ['publish'], yes: true } });
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    console.log = original;
  }

  assert.equal(summary.stalled.phase, 'publish');
  assert.match(summary.stalled.reason, /no completed approval from a review phase/);
  assert.match(summary.stalled.output, /approved SHA: \(none\)/);
  assert.deepEqual(summary.phases, []);
});

test('a dry-run resume does not use persisted nested repair settings', async () => {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-trees-'));
  const { root, workItem } = await repoFixture({ config: `export default {
  engines: { default: { name: 'claude', model: 'new-model', effort: 'high' } },
  gate: ['true'],
  phases: ['review', 'address'],
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
};
` });
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
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
  assert.match(lines.join('\n'), /engine: claude\s+model: new-model\s+effort: high/);
  assert.doesNotMatch(lines.join('\n'), /saved-address/);
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'ss-demo-feature', {});
  await state.record({ name: 'ss-demo-feature', taskFile: workItem });

  await assert.rejects(
    runLoop({
      args: { name: 'ss-demo-feature', taskFile: 'other-file.md', cwd: root, resume: true, yes: true },
    }),
    /Saved run used task file .* cannot resume with --task-file/,
  );
});

test('resume task-file conflicts are rejected before stdin or state mutation', async () => {
  const { root } = await repoFixture();
  const realTaskFile = join(root, 'real-plan.md');
  await writeFile(realTaskFile, '# Real plan\n');
  const state = await openFixtureState(join(root, '.loop/runs'), 'x', {});
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
  const state = await openFixtureState(join(root, '.loop/runs'), 'x', {});
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

test('task-file - reads stdin, writes to RUN_DIR/task.md, and previews a fresh stdin task on dry-run resume', async () => {
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
  const previewStdin = Readable.from(['preview task from stdin\n']);
  previewStdin.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: previewStdin, configurable: true });
  try {
    resumedSummary = await runLoop({
      args: { taskFile: '-', name: 'stdin-task', cwd: root, resume: true, dryRun: true, yes: true, phases: ['gate'] },
    });
  } finally {
    console.log = original;
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
  }
  const expectedPath = join(summary.runDir, 'task.md');
  assert.equal(resumedSummary.taskFile, expectedPath);
  assert.equal(previewStdin.readableEnded, true);
  assert.equal(await readFile(expectedPath, 'utf8'), 'spec from stdin\n');
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

test('hermetic settings normalize phase network and publish secret policies', async () => {
  const { root } = await repoFixture({
    config: `export default {
  hermetic: {
    runtime: 'podman',
    image: 'aloop:node',
    network: [],
    env: ['CI'],
  },
  phases: [
    { name: 'work', kind: 'agent', prompt: 'implement', hermetic: { network: ['registry-net'] } },
    { name: 'publish', kind: 'publish', hermetic: { secrets: ['GH_TOKEN'] } },
  ],
};
`,
  });
  const config = await loadConfig(root);
  assert.deepEqual(config.resolvedPhases[0].hermetic, {
    runtime: 'podman', image: 'aloop:node', networks: ['registry-net'], env: ['CI'], secrets: [],
  });
  assert.deepEqual(config.resolvedPhases[1].hermetic.secrets, ['GH_TOKEN']);
  assert.deepEqual(normalizeHermeticConfig(false).networks, []);
  assert.throws(
    () => resolvePhaseHermetic({ image: 'aloop:node', secrets: ['GH_TOKEN'] }, normalizeHermeticConfig(), 'agent'),
    /may only be declared by the publish phase/,
  );
});

test('hermetic invocation denies network by default and mounts declared paths', () => {
  const invocation = hermeticInvocation({
    settings: {
      runtime: 'docker', image: 'aloop:node', networks: [], env: ['CI'], secrets: [],
    },
    command: 'codex',
    args: ['exec', 'do it'],
    cwd: '/worktree',
    mounts: [
      { path: '/worktree', mode: 'ro' },
      { path: '/run', mode: 'rw' },
    ],
    env: { PATH: '/bin', CI: '1' },
  });
  assert.equal(invocation.command, 'docker');
  assert.deepEqual(invocation.args.slice(0, 6), ['run', '--rm', '--workdir', '/worktree', '--network', 'none']);
  assert.ok(invocation.args.includes('type=bind,src=/worktree,dst=/worktree,readonly'));
  assert.ok(invocation.args.includes('type=bind,src=/run,dst=/run'));
  assert.ok(invocation.args.includes('--env') && invocation.args.includes('CI'));
  assert.equal(invocation.args.at(-4), 'aloop:node');
  assert.deepEqual(invocation.policy.networks, []);
});

test('hermetic environment exposes only declared publish credentials', () => {
  const settings = {
    runtime: 'docker', image: 'aloop:node', networks: [], env: ['CI'], secrets: ['GH_TOKEN'],
  };
  assert.deepEqual(
    hermeticEnvironment(settings, { PATH: '/bin', CI: '1', GH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'hidden' }),
    { PATH: '/bin', CI: '1', GH_TOKEN: 'secret' },
  );
  assert.throws(
    () => hermeticEnvironment(settings, { PATH: '/bin', CI: '1' }),
    /secret "GH_TOKEN" is not set/,
  );
});

test('a hermetic agent is wrapped by the configured runtime and recorded in the snapshot', async () => {
  const runtimeLog = join(await mkdtemp(join(tmpdir(), 'loop-hermetic-')), 'runtime.json');
  const binDir = await mkdtemp(join(tmpdir(), 'loop-bin-'));
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-hermetic-trees-'));
  const runtimePath = join(binDir, 'fake-runtime');
  await writeFile(runtimePath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RUNTIME_LOG, JSON.stringify(args) + '\\n');
const workdir = args[args.indexOf('--workdir') + 1];
const imageIndex = args.indexOf('fixture-image');
const result = spawnSync(args[imageIndex + 1], args.slice(imageIndex + 2), { cwd: workdir, env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const { root } = await repoFixture({
    config: `export default {
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
  hermetic: {
    runtime: 'fake-runtime',
    image: 'fixture-image',
    network: ['registry-net'],
    env: ['FAKE_RUNTIME_LOG'],
  },
  adapters: {
    fixture: {
      command: () => ({ command: process.execPath, args: ['-e', ${JSON.stringify("require('node:fs').writeFileSync('hermetic.txt', 'ran\\n')")} ] }),
    },
  },
  engines: { default: 'fixture' },
  phases: [{ name: 'work', kind: 'agent', prompt: 'implement', permissions: ['write-worktree'], hermetic: true, postconditions: [] }],
};
`,
  });
  const originalPath = process.env.PATH;
  const originalRuntimeLog = process.env.FAKE_RUNTIME_LOG;
  const originalLog = console.log;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FAKE_RUNTIME_LOG = runtimeLog;
  console.log = () => {};
  let summary;
  try {
    summary = await runLoop({ args: { name: 'hermetic', task: 'run', cwd: root, yes: true } });
  } finally {
    process.env.PATH = originalPath;
    if (originalRuntimeLog === undefined) delete process.env.FAKE_RUNTIME_LOG;
    else process.env.FAKE_RUNTIME_LOG = originalRuntimeLog;
    console.log = originalLog;
  }

  assert.equal(summary.stalled, null);
  assert.notEqual(summary.worktree, root, 'the integration path must use the default linked worktree');
  assert.equal(await readFile(join(summary.worktree, 'hermetic.txt'), 'utf8'), 'ran\n');
  const runtimeArgs = JSON.parse((await readFile(runtimeLog, 'utf8')).trim());
  assert.deepEqual(runtimeArgs.slice(0, 6), ['run', '--rm', '--workdir', summary.worktree, '--network', 'registry-net']);
  assert.ok(runtimeArgs.some((arg) => arg === `type=bind,src=${summary.worktree},dst=${summary.worktree}`));
  assert.ok(runtimeArgs.some((arg) => arg === `type=bind,src=${join(root, '.git')},dst=${join(root, '.git')}`));
  const snapshot = JSON.parse(await readFile(join(summary.runDir, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.hermetic.runtime, 'fake-runtime');
  assert.equal(snapshot.hermetic.image, 'fixture-image');
  assert.deepEqual(snapshot.hermetic.phases[0], {
    name: 'work', enabled: true, runtime: 'fake-runtime', image: 'fixture-image',
    networks: ['registry-net'], env: ['FAKE_RUNTIME_LOG'], secrets: [],
  });
});

async function detectHermeticIntegrationRuntime() {
  const image = process.env.ALOOP_HERMETIC_IMAGE;
  if (!image) return null;
  const configuredRuntime = process.env.ALOOP_HERMETIC_RUNTIME;
  const runtimes = configuredRuntime ? [configuredRuntime] : ['docker', 'podman'];
  for (const runtime of runtimes) {
    try {
      await exec(runtime, ['info'], { timeout: 5_000 });
      await exec(runtime, ['image', 'inspect', image], { timeout: 5_000 });
      await exec(runtime, ['run', '--rm', image, 'sh', '-c', 'command -v git >/dev/null && command -v wget >/dev/null'], { timeout: 10_000 });
      return { runtime, image };
    } catch {
      // Try the next installed runtime; capability-gated tests must stay green
      // on machines without a daemon or a suitable test image.
    }
  }
  return null;
}

test('real hermetic runtime mounts the default worktree and enforces network policy', async (t) => {
  const capability = await detectHermeticIntegrationRuntime();
  if (!capability) {
    t.skip('set ALOOP_HERMETIC_IMAGE to a local Docker/Podman image containing git, sh, and wget');
    return;
  }

  const server = createServer((request, response) => {
    response.end(request.url === '/hermetic-probe' ? 'ok\n' : 'not found\n');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'loop-hermetic-trees-'));
  const commitCommand = [
    'git config --global --add safe.directory "$PWD"',
    'printf "committed\\n" > hermetic-commit.txt',
    'git add hermetic-commit.txt',
    'git commit -m "feat: hermetic integration commit"',
  ].join(' && ');
  const deniedNetworkCommand = `if wget -q -T 3 -O /dev/null http://127.0.0.1:${port}/hermetic-probe; then exit 1; else exit 0; fi`;
  const allowedNetworkCommand = `wget -q -T 3 -O /dev/null http://127.0.0.1:${port}/hermetic-probe`;
  const { root } = await repoFixture({
    config: `export default {
  worktreeRoot: ${JSON.stringify(worktreeRoot)},
  adapters: {
    commit: { command: () => ({ command: 'sh', args: ['-c', ${JSON.stringify(commitCommand)}] }) },
    deny: { command: () => ({ command: 'sh', args: ['-c', ${JSON.stringify(deniedNetworkCommand)}] }) },
    allow: { command: () => ({ command: 'sh', args: ['-c', ${JSON.stringify(allowedNetworkCommand)}] }) },
  },
  engines: { default: 'commit', 'deny-network': 'deny', 'allow-network': 'allow' },
  phases: [
    { name: 'commit', kind: 'agent', permissions: ['write-worktree'], postconditions: [], hermetic: { runtime: ${JSON.stringify(capability.runtime)}, image: ${JSON.stringify(capability.image)}, network: [] } },
    { name: 'deny-network', kind: 'agent', permissions: ['write-worktree'], postconditions: [], hermetic: { runtime: ${JSON.stringify(capability.runtime)}, image: ${JSON.stringify(capability.image)}, network: [] } },
    { name: 'allow-network', kind: 'agent', permissions: ['write-worktree'], postconditions: [], hermetic: { runtime: ${JSON.stringify(capability.runtime)}, image: ${JSON.stringify(capability.image)}, network: ['host'] } },
  ],
};
`,
  });

  try {
    const summary = await runLoop({ args: { name: 'hermetic-runtime', task: 'exercise the runtime boundary', cwd: root, yes: true } });
    assert.equal(summary.stalled, null);
    assert.notEqual(summary.worktree, root);
    assert.equal(await readFile(join(summary.worktree, 'hermetic-commit.txt'), 'utf8'), 'committed\n');
    assert.equal(await git(summary.worktree, 'status', '--porcelain'), '');
    assert.equal(await git(summary.worktree, 'log', '-1', '--format=%s'), 'feat: hermetic integration commit');
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

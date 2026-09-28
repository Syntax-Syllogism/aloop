import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoopArgs, runOperationalCommand, watchCommand } from '../bin/loop.mjs';
import { hashConfig, hashText } from '../src/manifest.mjs';
import { cancelRun, cleanRuns, doctor, getRun, getRunStatus, inspectRun, listRuns, replayRun, watchRuns } from '../src/operations.mjs';
import { RunState } from '../src/state.mjs';

const exec = promisify(execFile);

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'loop-operations-'));
  await git(root, 'init', '--initial-branch=master');
  await git(root, 'config', 'user.email', 'loop@example.com');
  await git(root, 'config', 'user.name', 'Loop Test');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'chore: init');
  await writeFile(join(root, 'loop.config.mjs'), "export default { worktrees: false, phases: ['gate'], gate: ['true'] };\n");
  return root;
}

async function completedRun(root, name, { worktree = root, branch = `feat/${name}` } = {}) {
  const state = await RunState.open(join(root, '.loop/runs'), name, {
    name,
    branch,
    worktree,
  });
  state.manifest.append({
    phase: 'gate',
    kind: 'gate',
    role: 'gate',
    status: 'completed',
    inputSha: 'before',
    outputSha: 'after',
    gateReceipts: [{ command: 'true', ok: true }],
    artifacts: ['gate.log'],
  });
  await state.record({ status: 'completed', prUrl: `https://github.com/example/project/pull/${name === 'old' ? 1 : 2}` });
  await state.release();
  return state;
}

test('operational read commands summarize state and manifest evidence', async () => {
  const root = await fixture();
  await completedRun(root, 'demo');

  const [listed] = await listRuns({ cwd: root });
  assert.equal(listed.name, 'demo');
  assert.equal(listed.status, 'completed');
  assert.equal(listed.currentPhase, 'gate');
  assert.equal(listed.gateStatus, 'completed');
  assert.equal(listed.prUrl, 'https://github.com/example/project/pull/2');

  const inspected = await inspectRun('demo', { cwd: root });
  assert.equal(inspected.phases[0].inputSha, 'before');
  assert.deepEqual(inspected.phases[0].gateReceipts, [{ command: 'true', ok: true }]);
  assert.deepEqual(inspected.phases[0].artifacts, ['gate.log']);
});

test('status, list, and watch prefer the entered phase over the finished manifest phase', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'in-flight', { name: 'in-flight' });
  state.manifest.append({ phase: 'gate', kind: 'gate', status: 'completed' });
  await state.record({ status: 'running' });
  await state.enterPhase('review');
  const startedAt = state.data.phaseStartedAt;
  assert.equal(new Date(startedAt).toISOString(), startedAt);
  const [listed] = await listRuns({ cwd: root });
  assert.equal(listed.currentPhase, 'review');
  assert.equal(listed.phaseStartedAt, startedAt);
  const status = await getRunStatus(join(root, '.loop/runs'), 'in-flight');
  assert.equal(status.phase, 'review');
  assert.equal(status.phaseStartedAt, startedAt);
  const lines = [];
  await runOperationalCommand(parseLoopArgs(['status', 'in-flight']), {
    cwd: root, output: { log: (line) => lines.push(line) },
  });
  assert.ok(lines.includes(`phase    : review`));
  assert.ok(lines.includes(`started  : ${startedAt}`));
  const events = [];
  const controller = new AbortController();
  for await (const event of watchRuns({ repos: [root], initial: true, signal: controller.signal,
    sleep: async () => controller.abort(),
  })) events.push(event);
  assert.equal(events[0].currentPhase, 'review');
  assert.equal(events[0].phaseStartedAt, startedAt);
  await state.release();
});

async function replayableRun(root, name, { promptHash = hashText('Implement demo.'), baseSha = null, worktree = root } = {}) {
  const state = await RunState.open(join(root, '.loop/runs'), name, { name, worktree });
  const resolvedConfig = { promptDir: '.loop/prompts' };
  state.manifest.append({
    phase: 'implement',
    kind: 'agent',
    role: 'agent',
    status: 'completed',
    inputSha: 'before',
    outputSha: 'after',
    promptHash,
    configHash: hashConfig(resolvedConfig),
    promptInput: {
      template: 'implement',
      templateBody: 'Implement {{TASK}}.',
      variables: { TASK: 'demo' },
      operatorNote: null,
    },
  });
  state.manifest.append({
    phase: 'gate',
    kind: 'gate',
    role: 'gate',
    status: 'completed',
    inputSha: 'after',
    outputSha: 'after',
    configHash: hashConfig(resolvedConfig),
    gateReceipts: [{ command: 'npm test', exitCode: 0 }],
  });
  await state.saveSnapshot({
    baseSha: baseSha ?? await git(root, 'rev-parse', 'HEAD'),
    configHash: hashConfig(resolvedConfig),
    resolvedConfig,
    worktree,
  });
  await state.record({ status: 'completed' });
  await state.release();
}

test('replay verifies recorded prompt inputs and reconstructs the phase timeline', async () => {
  const root = await fixture();
  await replayableRun(root, 'replayable');

  const result = await replayRun('replayable', { cwd: root });
  assert.equal(result.dryRun, true);
  assert.equal(result.baseSha.available, true);
  assert.equal(result.worktree.available, true);
  assert.equal(result.timeline[0].prompt.status, 'verified');
  assert.deepEqual(result.timeline[1].gateReceipts, [{ command: 'npm test', exitCode: 0 }]);
  assert.deepEqual(result.divergences, []);

  const output = [];
  const cliResult = await runOperationalCommand(
    parseLoopArgs(['replay', 'replayable', '--json']),
    { cwd: root, output: { log: (line) => output.push(line) } },
  );
  assert.equal(cliResult.timeline[0].prompt.status, 'verified');
  assert.equal(JSON.parse(output[0]).name, 'replayable');
});

test('replay reports prompt and Git-state divergence without failing', async () => {
  const root = await fixture();
  await replayableRun(root, 'tampered', {
    promptHash: '0'.repeat(64),
    baseSha: 'f'.repeat(40),
    worktree: join(root, 'missing-worktree'),
  });

  const result = await replayRun('tampered', { cwd: root });
  assert.equal(result.timeline[0].prompt.status, 'mismatch');
  assert.deepEqual(result.divergences.map((item) => item.type), ['base-sha', 'worktree', 'prompt-hash']);
});

test('PR summaries ignore URLs in task and manifest text', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'mentions', { name: 'mentions' });
  await state.record({ task: 'Discuss https://github.com/example/project/pull/99 in the task.' });
  await state.saveManifest({ task: 'Artifact text mentions https://github.com/example/project/pull/100.' });
  await state.release();

  const [listed] = await listRuns({ cwd: root });
  assert.equal(listed.prUrl, null);
});

test('lock recovery refuses a dead runner with an active command', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'active', { name: 'active' }, { lock: false });
  await state.record({ status: 'running' });
  await mkdir(join(state.dir, 'lock'), { recursive: true });
  const owner = { pid: 99999999, token: 'cafe', runId: state.data.runId };
  await writeFile(join(state.dir, `lock/owner-${owner.pid}-${owner.token}`), `${JSON.stringify(owner)}\n`);
  const command = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await writeFile(join(state.dir, 'active-command.json'), `${JSON.stringify({ pid: 99999999, processGroupId: command.pid })}\n`);

  try {
    await assert.rejects(
      RunState.open(join(root, '.loop/runs'), 'active', { name: 'active' }, { resume: true }),
      /active command/,
    );
  } finally {
    process.kill(-command.pid, 'SIGKILL');
  }
});

test('cancel marks a run and releases its active lock', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'active', { name: 'active' });
  await state.record({ status: 'running' });
  const result = await cancelRun('active', { cwd: root });

  assert.equal(result.status, 'cancelled');
  const saved = JSON.parse(await readFile(state.path, 'utf8'));
  assert.equal(saved.status, 'cancelled');
  assert.equal(result.lock.active, false);
});

test('cancel records cancellation after a runner finishes its final state write', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'racing', { name: 'racing' }, { lock: false });
  await state.record({ status: 'running' });
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync, writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => setTimeout(() => {
      const data = JSON.parse(readFileSync(process.env.STATE_PATH, 'utf8'));
      data.status = 'running';
      delete data.cancelledAt;
      delete data.cancelReason;
      writeFileSync(process.env.STATE_PATH, JSON.stringify(data) + '\\n');
      process.exit(0);
    }, 100));
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, STATE_PATH: state.path }, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const owner = { pid: runner.pid, token: 'a11ce', runId: state.data.runId };
  await mkdir(join(state.dir, 'lock'), { recursive: true });
  await writeFile(join(state.dir, `lock/owner-${owner.pid}-${owner.token}`), `${JSON.stringify(owner)}\n`);

  try {
    await cancelRun('racing', { cwd: root });
    const saved = JSON.parse(await readFile(state.path, 'utf8'));
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.cancelReason, 'cancelled by operator');
  } finally {
    if (processIsAlive(runner.pid)) runner.kill('SIGKILL');
  }
});

test('cancel stops a command recorded while the runner is shutting down', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'handoff', { name: 'handoff' }, { lock: false });
  await state.record({ status: 'running' });
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.on('SIGTERM', () => {
      const command = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      writeFileSync(join(process.env.RUN_DIR, 'active-command.json'), JSON.stringify({ pid: command.pid, processGroupId: command.pid }) + '\\n');
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, RUN_DIR: state.dir }, stdio: 'ignore' });
  const owner = { pid: runner.pid, token: 'a11ce', runId: state.data.runId };
  await mkdir(join(state.dir, 'lock'), { recursive: true });
  await writeFile(join(state.dir, `lock/owner-${owner.pid}-${owner.token}`), `${JSON.stringify(owner)}\n`);

  try {
    const result = await cancelRun('handoff', { cwd: root });
    assert.equal(result.status, 'cancelled');
    const activeProcess = JSON.parse((await readFile(join(state.dir, 'active-command.json'))).toString());
    assert.equal(processIsAlive(activeProcess.pid), false);
  } finally {
    if (processIsAlive(runner.pid)) runner.kill('SIGKILL');
  }
});

test('cancel rejects a completed run without changing its status', async () => {
  const root = await fixture();
  const state = await completedRun(root, 'finished');

  await assert.rejects(
    cancelRun('finished', { cwd: root }),
    /not active/,
  );
  const saved = JSON.parse(await readFile(state.path, 'utf8'));
  assert.equal(saved.status, 'completed');
});

test('cancel terminates a shell command process group and its child', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'tree', { name: 'tree' });
  await state.record({ status: 'running' });
  const childPath = join(root, 'child.pid');
  const command = spawn('sh', ['-c', `sleep 30 & child=$!; echo $child > ${JSON.stringify(childPath)}; wait $child`], {
    detached: true,
    stdio: 'ignore',
  });
  const childPid = Number((await waitForFile(childPath)).trim());
  await writeFile(join(state.dir, 'active-command.json'), `${JSON.stringify({ pid: command.pid, processGroupId: command.pid })}\n`);

  const result = await cancelRun('tree', { cwd: root });
  assert.equal(result.status, 'cancelled');
  assert.equal(processIsAlive(childPid), false);
});

test('clean previews and then removes only old completed runs', async () => {
  const root = await fixture();
  const old = await completedRun(root, 'old');
  const oldState = JSON.parse(await readFile(old.path, 'utf8'));
  oldState.updatedAt = '2020-01-01T00:00:00.000Z';
  await writeFile(old.path, `${JSON.stringify(oldState)}\n`);
  const recent = await completedRun(root, 'recent');

  const preview = await cleanRuns({ cwd: root, olderThanDays: 30 });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.candidates.map((run) => run.name), ['old']);

  const cleaned = await cleanRuns({ cwd: root, olderThanDays: 30, yes: true });
  assert.deepEqual(cleaned.removed, ['old']);
  await assert.rejects(readFile(old.path));
  await readFile(recent.path);
});

test('clean removes a completed run worktree before its run directory', async () => {
  const root = await fixture();
  const worktree = await mkdtemp(join(tmpdir(), 'loop-operation-tree-'));
  await git(root, 'worktree', 'add', '-b', 'feat/tree', worktree, 'master');
  const state = await completedRun(root, 'tree', { worktree, branch: 'feat/tree' });
  const saved = JSON.parse(await readFile(state.path, 'utf8'));
  saved.updatedAt = '2020-01-01T00:00:00.000Z';
  await writeFile(state.path, `${JSON.stringify(saved)}\n`);

  const result = await cleanRuns({ cwd: root, olderThanDays: 30, yes: true });
  assert.deepEqual(result.removed, ['tree']);
  await assert.rejects(readFile(join(worktree, 'README.md')));
});

test('operational subcommands parse names and machine-readable options', () => {
  assert.deepEqual(parseLoopArgs(['list', '--json']).command, 'list');
  assert.equal(parseLoopArgs(['status', 'demo', '--json']).runName, 'demo');
  assert.equal(parseLoopArgs(['clean', '--older-than', '14', '--yes']).olderThanDays, 14);
  assert.equal(parseLoopArgs(['doctor', '--json']).json, true);
  assert.equal(parseLoopArgs(['replay', 'demo', '--json']).runName, 'demo');
});

test('operational commands honor a custom runsDir and surface a broken config import', async () => {
  const root = await fixture();
  // A config that resolves cleanly but points runs at a non-default directory.
  await writeFile(
    join(root, 'loop.config.mjs'),
    "export default { worktrees: false, phases: ['gate'], gate: ['true'], runsDir: '.loop/custom-runs' };\n",
  );
  await completedRun(root, 'demo', { branch: 'feat/demo' });
  // completedRun writes under the default .loop/runs; move it to the configured dir.
  await mkdir(join(root, '.loop/custom-runs'), { recursive: true });
  await exec('mv', [join(root, '.loop/runs/demo'), join(root, '.loop/custom-runs/demo')]);

  const listed = await listRuns({ cwd: root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'demo');

  // An existing config whose dependency cannot be resolved must not silently
  // fall back to defaults (and the default runsDir); the load error surfaces.
  await writeFile(
    join(root, 'loop.config.mjs'),
    "import './does-not-exist.mjs';\nexport default { runsDir: '.loop/custom-runs' };\n",
  );
  await assert.rejects(listRuns({ cwd: root }), (error) => /** @type {any} */ (error).code === 'ERR_MODULE_NOT_FOUND');
});

test('doctor keeps configuration errors separate from unavailable tooling', async () => {
  const root = await fixture();
  await writeFile(join(root, 'loop.config.mjs'), `export default {
  phases: [{ name: 'check', kind: 'agent', prompt: 'docs' }],
  engines: { default: { name: 'missing-engine' } },
  adapters: { 'missing-engine': { command: () => ({ command: 'missing-engine', args: [] }) } },
};\n`);

  const result = await doctor({ cwd: root });
  assert.equal(result.checks.find((check) => check.name === 'config').ok, true);
  assert.equal(result.checks.find((check) => check.name === 'engine missing-engine').ok, false);
  assert.equal(result.ok, false);
});

test('watch parsing accepts multiple names and repos and validates watch-only options', () => {
  const args = parseLoopArgs(['watch', 'alpha', 'beta', '--repo', '.', '--repo', '../other', '--interval', '2', '--timeout', '1.5m', '--only', 'status', '--initial']);
  assert.deepEqual(args.runNames, ['alpha', 'beta']);
  assert.deepEqual(args.repo, ['.', '../other']);
  assert.equal(args.intervalMs, 2000);
  assert.equal(args.timeoutMs, 90_000);
  assert.equal(args.initial, true);
  assert.throws(() => parseLoopArgs(['watch', '--interval', '0']), /--interval must be a positive number of seconds/);
  assert.throws(() => parseLoopArgs(['watch', '--timeout', 'soon']), /--timeout must be a duration/);
  assert.throws(() => parseLoopArgs(['watch', '--only', 'phase']), /--only must be status/);
  assert.throws(() => parseLoopArgs(['list', '--once']), /only valid with watch/);
});

test('watch snapshots existing runs and coalesces simultaneous status and phase changes', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'watched', { name: 'watched', branch: 'feat/watched' });
  state.manifest.append({ phase: 'implement', kind: 'agent', status: 'completed' });
  await state.record({ status: 'running', currentPhase: 'implement', phaseStartedAt: '2026-09-28T10:00:00.000Z' });
  const controller = new AbortController();
  let sleeps = 0;
  const events = [];
  for await (const event of watchRuns({
    repos: [root], initial: true, signal: controller.signal, intervalMs: 1,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await state.release();
        state.manifest.append({ phase: 'gate', kind: 'gate', status: 'completed' });
        await state.record({ status: 'stalled', currentPhase: 'gate', phaseStartedAt: '2026-09-28T10:01:00.000Z', stalled: { phase: 'gate', reason: 'round cap reached', findings: ['private detail'] } });
      } else controller.abort();
    },
  })) events.push(event);

  assert.equal(events[0].type, 'snapshot');
  assert.deepEqual(events.slice(1).map(({ type, from, to }) => ({ type, from, to })), [
    { type: 'status', from: 'running', to: 'stalled' },
  ]);
  assert.equal(events[1].currentPhase, 'gate');
  assert.equal(events[1].phaseStartedAt, '2026-09-28T10:01:00.000Z');
  assert.deepEqual(events[1].stalled, { phase: 'gate', reason: 'round cap reached' });
  assert.equal(JSON.stringify(events[1]).includes('private detail'), false);
  assert.equal(events[1].repo, root);
});

test('watch emits phase-only changes when status stays the same', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'phase-only', { name: 'phase-only' });
  await state.record({ status: 'running', currentPhase: 'implement' });
  const controller = new AbortController();
  const events = [];
  let sleeps = 0;
  for await (const event of watchRuns({
    repos: [root], signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await state.record({ status: 'running', currentPhase: 'gate' });
      else controller.abort();
    },
  })) events.push(event);
  await state.release();

  assert.deepEqual(events.map(({ type, from, to }) => ({ type, from, to })), [
    { type: 'phase', from: 'implement', to: 'gate' },
  ]);
});

test('watch does not emit a phase event for a new start time with the same phase', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'same-phase', { name: 'same-phase' });
  await state.record({ status: 'running', currentPhase: 'gate', phaseStartedAt: '2026-09-28T10:00:00.000Z' });
  const controller = new AbortController();
  const events = [];
  let sleeps = 0;
  for await (const event of watchRuns({ repos: [root], signal: controller.signal,
    sleep: async () => {
      if (++sleeps === 1) await state.enterPhase('gate');
      else controller.abort();
    },
  })) events.push(event);
  assert.deepEqual(events, []);
  await state.release();
});

test('watch --only status ignores phase events and --once waits past initial snapshots', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'filtered', { name: 'filtered' });
  await state.record({ status: 'running', currentPhase: 'implement' });
  const output = [];
  let snapshotWritten;
  const snapshot = new Promise((resolve) => { snapshotWritten = resolve; });
  let settled = false;
  const watching = watchCommand(parseLoopArgs([
    'watch', '--only', 'status', '--initial', '--once', '--interval', '1',
  ]), {
    cwd: root,
    output: {
      write: (line, callback) => { output.push(line); snapshotWritten(); callback?.(); },
      error: (line) => output.push(line),
    },
  }).finally(() => { settled = true; });

  await snapshot;
  state.manifest.append({ phase: 'gate', kind: 'gate', status: 'completed' });
  await state.record({ status: 'running', currentPhase: 'gate' });
  // Hold the phase-only change across at least one 1s poll before completing.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.deepEqual(output.map((line) => JSON.parse(line).type), ['snapshot']);
  assert.equal(settled, false);

  await state.record({ status: 'completed', currentPhase: 'gate' });
  await state.release();
  const result = await watching;

  assert.equal(result, 0);
  assert.deepEqual(output.map((line) => JSON.parse(line).type), ['snapshot', 'status']);
  assert.equal(JSON.parse(output[1]).to, 'completed');
});

test('watch recovers after a transient unreadable run manifest', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'recover', { name: 'recover' });
  await state.record({ status: 'running', currentPhase: 'implement' });
  const manifestPath = join(state.dir, 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8');
  const controller = new AbortController();
  const events = [];
  const warnings = [];
  let sleeps = 0;
  for await (const event of watchRuns({
    repos: [root], initial: true, signal: controller.signal,
    warn: (message) => warnings.push(message),
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await writeFile(manifestPath, '{ invalid json');
      else if (sleeps === 2) await writeFile(manifestPath, manifest);
      else controller.abort();
    },
  })) events.push(event);
  await state.release();

  assert.deepEqual(events.map(({ type }) => type), ['snapshot']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read runs/);
});

test('watch keeps a persisted running run active while its command child lives', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'child-active', { name: 'child-active' });
  await state.record({ status: 'running', currentPhase: 'implement' });
  await state.release();
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await writeFile(join(state.dir, 'active-command.json'), `${JSON.stringify({ pid: child.pid, processGroupId: child.pid })}\n`);
  const controller = new AbortController();
  const events = [];

  try {
    for await (const event of watchRuns({
      repos: [root], initial: true, signal: controller.signal,
      sleep: async () => controller.abort(),
    })) events.push(event);
  } finally {
    process.kill(-child.pid, 'SIGKILL');
  }

  assert.equal(events[0].status, 'running');
  assert.notEqual(events[0].status, 'interrupted');
});

test('watch omits stale stalled details after a stalled run resumes', async () => {
  const root = await fixture();
  const runsDir = join(root, '.loop/runs');
  const state = await RunState.open(runsDir, 'resumed', { name: 'resumed' });
  await state.record({ status: 'stalled', currentPhase: 'review', stalled: { phase: 'review', reason: 'round cap reached' } });
  await state.release();
  const controller = new AbortController();
  const events = [];
  let sleeps = 0;
  for await (const event of watchRuns({
    repos: [root], initial: true, signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        const resumed = await RunState.open(runsDir, 'resumed', { name: 'resumed' }, { resume: true });
        await resumed.record({ status: 'running', currentPhase: 'address' });
      } else {
        controller.abort();
      }
    },
  })) events.push(event);

  assert.equal(events[0].status, 'stalled');
  assert.deepEqual(events[0].stalled, { phase: 'review', reason: 'round cap reached' });
  assert.equal(events[1].status, 'running');
  assert.equal(Object.hasOwn(events[1], 'stalled'), false);
});

test('watch detects a persisted running state with no live lock as interrupted', async () => {
  const root = await fixture();
  const state = await RunState.open(join(root, '.loop/runs'), 'interrupted', { name: 'interrupted' });
  await state.record({ status: 'running', currentPhase: 'implement' });
  await state.release();

  assert.equal((await getRun('interrupted', { cwd: root })).summary.status, 'interrupted');
  assert.equal((await listRuns({ cwd: root }))[0].status, 'interrupted');
  const controller = new AbortController();
  const events = [];
  for await (const event of watchRuns({
    repos: [root], initial: true, signal: controller.signal,
    sleep: async () => controller.abort(),
  })) events.push(event);
  assert.equal(events[0].type, 'snapshot');
  assert.equal(events[0].status, 'interrupted');
  assert.equal((await cancelRun('interrupted', { cwd: root })).status, 'cancelled');
});

test('watch timeout emits one NDJSON timeout event and returns exit code 2', async () => {
  const root = await fixture();
  const output = [];
  const result = await watchCommand(parseLoopArgs(['watch', '--timeout', '0.01s']), {
    cwd: root,
    output: { write: (line, callback) => { output.push(line); callback?.(); }, error: (line) => output.push(line) },
  });
  assert.equal(result, 2);
  assert.equal(JSON.parse(output[0]).type, 'timeout');
});

test('watch reports appeared and removed runs independently across repositories', async () => {
  const first = await fixture();
  const second = await fixture();
  const controller = new AbortController();
  let sleeps = 0;
  const events = [];
  for await (const event of watchRuns({
    repos: [first, second], names: ['same-name'], signal: controller.signal, intervalMs: 1,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        for (const root of [first, second]) {
          const state = await RunState.open(join(root, '.loop/runs'), 'same-name', { name: 'same-name' });
          await state.record({ status: 'running' });
          await state.release();
        }
      } else if (sleeps === 2) {
        await rm(join(first, '.loop/runs/same-name'), { recursive: true });
      } else controller.abort();
    },
  })) events.push(event);

  assert.deepEqual(events.map(({ type, repo, name }) => ({ type, repo, name })), [
    { type: 'appeared', repo: first, name: 'same-name' },
    { type: 'appeared', repo: second, name: 'same-name' },
    { type: 'removed', repo: first, name: 'same-name' },
  ]);
});

test('watch --once exits after the first appeared event', async () => {
  const root = await fixture();
  const output = [];
  const createRun = async () => {
    const state = await RunState.open(join(root, '.loop/runs'), 'new-run', { name: 'new-run' });
    await state.record({ status: 'running' });
    await state.release();
  };
  const creation = new Promise((resolve) => setTimeout(() => createRun().then(resolve), 300));
  const result = await watchCommand(parseLoopArgs(['watch', '--once', '--interval', '1']), {
    cwd: root,
    output: { write: (line, callback) => { output.push(line); callback?.(); }, error: (line) => output.push(line) },
  });
  await creation;
  assert.equal(result, 0);
  assert.equal(JSON.parse(output[0]).type, 'appeared');
  assert.equal(output.length, 1);
});

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoopArgs, runOperationalCommand } from '../bin/loop.mjs';
import { hashConfig, hashText } from '../src/manifest.mjs';
import { cancelRun, cleanRuns, doctor, inspectRun, listRuns, replayRun } from '../src/operations.mjs';
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

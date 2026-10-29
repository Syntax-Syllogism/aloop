import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/loop.mjs', import.meta.url));
const commands = ['list', 'status', 'inspect', 'replay', 'metrics', 'cancel', 'clean', 'doctor', 'watch', 'init', 'run', 'help'];

test('each aloop command prints its own help and relevant options', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aloop-command-help-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const command of commands) {
    const { stdout, stderr } = await exec(process.execPath, [cli, command, '--help'], { cwd });
    assert.deepEqual(await readdir(cwd), [], `${command} help should leave no state or lock files`);
    assert.equal(stderr, '', `${command} help should not write to stderr`);
    assert.ok(stdout.startsWith(`Usage: aloop ${command}`), `${command} help should start with its usage`);
    assert.match(stdout.trimEnd(), /Run 'aloop help <command\|guide>' for full documentation\.$/);
    if (command !== 'run') assert.doesNotMatch(stdout, /--task-file/);
    if (command !== 'watch') assert.doesNotMatch(stdout, /--interval/);
    if (command !== 'clean') assert.doesNotMatch(stdout, /--older-than/);
    if (command !== 'init') assert.doesNotMatch(stdout, /--force/);
    if (command === 'init') {
      assert.doesNotMatch(stdout, /--config/);
    } else if (command !== 'help') {
      assert.match(stdout, /--config <path>/, `${command} help should document the config path option`);
    }
  }
});

test('aloop --help retains the complete command list', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aloop-help-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { stdout, stderr } = await exec(process.execPath, [cli, '--help'], { cwd });
  assert.deepEqual(await readdir(cwd), [], 'help should leave no state or lock files');
  assert.equal(stderr, '');
  assert.match(stdout, /^Usage: aloop \[command\] \[options\]/);
  for (const command of commands) assert.match(stdout, new RegExp(`^  ${command}\\b`, 'm'));
});

test('aloop-eval --help prints usage without creating state', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aloop-eval-help-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const evalCli = fileURLToPath(new URL('../bin/eval.mjs', import.meta.url));
  const { stdout, stderr } = await exec(process.execPath, [evalCli, '--help'], { cwd });
  assert.match(stdout, /^Usage: aloop-eval/);
  assert.match(stdout, /--version/);
  assert.equal(stderr, '');
  assert.deepEqual(await readdir(cwd), [], 'help should leave no state or lock files');
});

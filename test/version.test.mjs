import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseLoopArgs } from '../bin/loop.mjs';

const exec = promisify(execFile);
const cli = new URL('../bin/loop.mjs', import.meta.url);

test('aloop --version prints the package version from any working directory', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aloop-version-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  for (const args of [
    ['--version'],
    ['--version', '--help'],
    ['--help', '--version'],
    ['--version', '--bogus'],
    ['--bogus', '--version'],
  ]) {
    assert.deepEqual(parseLoopArgs(args), { command: 'run', version: true });
    const { stdout, stderr } = await exec(process.execPath, [fileURLToPath(cli), ...args], { cwd });
    assert.equal(stdout, `aloop ${version}\n`);
    assert.equal(stderr, '');
    assert.deepEqual(await readdir(cwd), [], 'version should leave no state or lock files');
  }
});

test('aloop-eval --version prints the package version', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aloop-eval-version-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const evalCli = new URL('../bin/eval.mjs', import.meta.url);
  for (const args of [
    ['--version'],
    ['--version', '--help'],
    ['--help', '--version'],
    ['--version', '--bogus'],
    ['--bogus', '--version'],
  ]) {
    const { stdout, stderr } = await exec(process.execPath, [fileURLToPath(evalCli), ...args], { cwd });
    assert.equal(stdout, `aloop-eval ${version}\n`);
    assert.equal(stderr, '');
    assert.deepEqual(await readdir(cwd), [], 'version should leave no state or lock files');
  }
});

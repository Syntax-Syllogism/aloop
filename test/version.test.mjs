import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseLoopArgs } from '../bin/loop.mjs';

const exec = promisify(execFile);
const cli = new URL('../bin/loop.mjs', import.meta.url);

test('aloop --version prints the package version from any working directory', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseLoopArgs(['--version']), { command: 'run', version: true });

  const { stdout, stderr } = await exec(process.execPath, [fileURLToPath(cli), '--version'], { cwd: tmpdir() });
  assert.equal(stdout, `${version}\n`);
  assert.equal(stderr, '');
});

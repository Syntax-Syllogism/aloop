import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowsExecutable, runCommand } from '../src/command.mjs';
import { openTerminalInput } from '../src/reporter.mjs';

function fakeChild(pid = 1234) {
  const child = /** @type {any} */ (new EventEmitter());
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() {} };
  child.kill = () => {
    child.directlyKilled = true;
    child.emit('close', null, 'SIGKILL');
  };
  return child;
}

test('Windows executable resolution searches PATH in PATHEXT order', () => {
  const checked = [];
  const resolved = resolveWindowsExecutable(
    'claude',
    { PATH: 'C:\\Tools;C:\\Other', PATHEXT: '.EXE;.CMD' },
    {
      fileExists(candidate) {
        checked.push(candidate);
        return candidate === 'C:\\Other\\claude.CMD';
      },
    },
  );

  assert.equal(resolved, 'C:\\Other\\claude.CMD');
  assert.deepEqual(checked, [
    'C:\\Tools\\claude.EXE',
    'C:\\Tools\\claude.CMD',
    'C:\\Other\\claude.EXE',
    'C:\\Other\\claude.CMD',
  ]);
});

test('Windows executable resolution canonicalizes the matched path to its real on-disk casing', () => {
  const resolved = resolveWindowsExecutable(
    'git',
    { PATH: 'C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE;.CMD' },
    {
      // existsSync matches case-insensitively, so the upper-cased ".EXE" candidate hits.
      fileExists: (candidate) => candidate === 'C:\\Program Files\\Git\\cmd\\git.EXE',
      // realpathSync.native reports the actual casing stored on disk.
      realPath: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
    },
  );

  assert.equal(resolved, 'C:\\Program Files\\Git\\cmd\\git.exe');
});

test('Windows executable resolution falls back to the matched candidate when realpath fails', () => {
  const resolved = resolveWindowsExecutable(
    'git',
    { PATH: 'C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE' },
    {
      fileExists: (candidate) => candidate === 'C:\\Program Files\\Git\\cmd\\git.EXE',
      realPath: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    },
  );

  assert.equal(resolved, 'C:\\Program Files\\Git\\cmd\\git.EXE');
});

test('runCommand wraps Windows command shims and leaves POSIX commands unchanged', async () => {
  const calls = [];
  const child = fakeChild();
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };

  await runCommand('claude', ['--version'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolveExecutable: () => 'C:\\Tools\\claude.cmd',
    spawnImpl,
  });
  await runCommand('node', ['--version'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolveExecutable: () => 'C:\\Tools\\node.exe',
    spawnImpl,
  });
  await runCommand('script', ['--version'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolveExecutable: () => 'C:\\Tools\\script.ps1',
    spawnImpl,
  });

  const posixChild = fakeChild(1235);
  await runCommand('sh', ['-c', 'true'], {
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      setImmediate(() => posixChild.emit('close', 0, null));
      return posixChild;
    },
  });

  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd', '--version']);
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, false);
  assert.equal(calls[1].command, 'C:\\Tools\\node.exe');
  assert.deepEqual(calls[1].args, ['--version']);
  assert.match(calls[2].command, /powershell\.exe$/i);
  assert.deepEqual(calls[2].args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Tools\\script.ps1', '--version']);
  assert.equal(calls[3].command, 'sh');
  assert.deepEqual(calls[3].args, ['-c', 'true']);
  assert.equal(calls[3].options.detached, true);
});

test('Windows launches a PATH-resolved .cmd fixture through ComSpec', { skip: process.platform !== 'win32' }, async () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'platform-fixtures');
  const result = await runCommand('echo', ['alpha', 'beta'], {
    platform: 'win32',
    cwd: fixtureDir,
    env: { ...process.env, PATH: `${fixtureDir};${process.env.PATH}` },
  });

  assert.equal(result.stdout.trim(), 'platform-fixture alpha beta');
});

test('Windows command timeouts terminate the whole process tree with taskkill', async () => {
  const child = fakeChild(4321);
  /** @type {any} */
  let taskkill;
  const spawnImpl = (command, args, options) => {
    if (command === 'taskkill') {
      taskkill = { command, args, options };
      return new EventEmitter();
    }
    return child;
  };

  const result = runCommand('claude', [], {
    platform: 'win32',
    timeoutMs: 1,
    resolveExecutable: () => 'C:\\Tools\\claude.exe',
    spawnImpl,
  });
  setTimeout(() => taskkill && child.emit('close', null, 'SIGKILL'), 5);

  await assert.rejects(result, (error) => /** @type {any} */ (error).code === 'ETIMEDOUT');
  assert.deepEqual(taskkill.args, ['/PID', '4321', '/T', '/F']);
  assert.equal(child.directlyKilled, undefined);
});

test('Windows command timeouts fall back when taskkill cannot start', async () => {
  const child = fakeChild(4322);
  const taskkill = /** @type {any} */ (new EventEmitter());
  const spawnImpl = (command) => {
    if (command === 'taskkill') {
      setImmediate(() => taskkill.emit('error', new Error('taskkill unavailable')));
      return taskkill;
    }
    return child;
  };

  await assert.rejects(runCommand('claude', [], {
    platform: 'win32',
    timeoutMs: 1,
    resolveExecutable: () => 'C:\\Tools\\claude.exe',
    spawnImpl,
  }), (error) => /** @type {any} */ (error).code === 'ETIMEDOUT');
  assert.equal(child.directlyKilled, true);
});

test('Windows command timeouts fall back when taskkill exits unsuccessfully', async () => {
  const child = fakeChild(4323);
  const taskkill = /** @type {any} */ (new EventEmitter());
  const spawnImpl = (command) => {
    if (command === 'taskkill') {
      setImmediate(() => taskkill.emit('close', 1, null));
      return taskkill;
    }
    return child;
  };

  await assert.rejects(runCommand('claude', [], {
    platform: 'win32',
    timeoutMs: 1,
    resolveExecutable: () => 'C:\\Tools\\claude.exe',
    spawnImpl,
  }), (error) => /** @type {any} */ (error).code === 'ETIMEDOUT');
  assert.equal(child.directlyKilled, true);
});

test('Windows terminal input prefers a TTY and otherwise opens CONIN$', async () => {
  const tty = new PassThrough();
  tty.isTTY = true;
  assert.equal(await openTerminalInput({ platform: 'win32', input: tty }), tty);

  const consoleInput = new PassThrough();
  let requestedPath;
  const opened = openTerminalInput({
    platform: 'win32',
    input: { isTTY: false },
    createInput(path) {
      requestedPath = path;
      setImmediate(() => consoleInput.emit('open'));
      return consoleInput;
    },
  });

  assert.equal(await opened, consoleInput);
  assert.equal(requestedPath, '\\\\.\\CONIN$');
  tty.destroy();
  consoleInput.destroy();
});

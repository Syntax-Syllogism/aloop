import { spawn } from 'node:child_process';
import { existsSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { win32 as windowsPath } from 'node:path';

export function signalProcessGroup(pid, signal, {
  platform = process.platform,
  spawnImpl = spawn,
  onFailure,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (platform === 'win32') {
    const handleFailure = onFailure ?? (() => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    let killer;
    try {
      killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      handleFailure();
      return false;
    }
    const addListener = killer?.once ?? killer?.on;
    if (!addListener) {
      handleFailure();
      return false;
    }
    let completed = false;
    const fail = () => {
      if (completed) return;
      completed = true;
      handleFailure();
    };
    addListener.call(killer, 'error', fail);
    addListener.call(killer, 'close', (code) => {
      if (completed) return;
      completed = true;
      if (code !== 0) handleFailure();
    });
    killer?.unref?.();
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD', '.PS1'];

function environmentValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function resolveWindowsExecutable(command, env = process.env, {
  fileExists = existsSync,
  realPath = realpathSync.native,
} = {}) {
  const pathEntries = (environmentValue(env, 'PATH') ?? '').split(';').filter(Boolean);
  const pathExtensions = (environmentValue(env, 'PATHEXT') ?? WINDOWS_EXECUTABLE_EXTENSIONS.join(';'))
    .split(';')
    .map((extension) => extension.trim().toUpperCase())
    .filter(Boolean);
  const hasDirectory = command.includes('\\') || command.includes('/');
  const bases = hasDirectory ? [command] : pathEntries.map((directory) => windowsPath.join(directory, command));
  const extensions = windowsPath.extname(command) ? [''] : pathExtensions;

  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      // Candidates are assembled from PATHEXT, which is upper-cased by convention
      // (".EXE"), while the file on disk is usually "git.exe". existsSync matches
      // case-insensitively, so a match here would otherwise be handed to spawn with
      // the wrong casing — which fails with ENOENT under Git Bash / MSYS. Canonicalize
      // to the real on-disk path so spawn receives the name that actually exists.
      if (fileExists(candidate)) {
        try {
          return realPath(candidate);
        } catch {
          return candidate;
        }
      }
    }
  }
  return null;
}

function windowsSpawnSpec(command, args, env, resolveExecutable) {
  const resolved = resolveExecutable(command, env) ?? command;
  const extension = windowsPath.extname(resolved).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    return {
      command: environmentValue(env, 'ComSpec') ?? 'cmd.exe',
      args: ['/d', '/s', '/c', resolved, ...args],
    };
  }
  if (extension === '.ps1') {
    return {
      command: environmentValue(env, 'SystemRoot')
        ? windowsPath.join(environmentValue(env, 'SystemRoot'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
    };
  }
  return { command: resolved, args };
}

function clearActiveProcess(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Run a command, capturing its output while optionally streaming it onward.
 *
 * Agent phases run for minutes at a time, so unlike a buffered helper this one
 * forwards each chunk to `onOutput` as it arrives — a run you cannot watch is a
 * run you cannot debug. `timeoutMs` exists because a silently hung agent is the
 * most common unattended failure and it burns tokens for as long as it hangs.
 */
export async function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs,
    onOutput,
    input,
    activeProcessPath,
    platform = process.platform,
    spawnImpl = spawn,
    resolveExecutable = resolveWindowsExecutable,
  } = options;
  return new Promise((resolve, reject) => {
    const spawnSpec = platform === 'win32' ? windowsSpawnSpec(command, args, env, resolveExecutable) : { command, args };
    const child = spawnImpl(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      detached: platform !== 'win32',
      ...(platform === 'win32' ? { windowsVerbatimArguments: false } : {}),
    });
    if (activeProcessPath) {
      writeFileSync(activeProcessPath, `${JSON.stringify({
        pid: child.pid,
        ...(platform !== 'win32' ? { processGroupId: child.pid } : {}),
      })}\n`);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutError = (cause) => {
      const error = new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`, { cause });
      error.code = 'ETIMEDOUT';
      return decorate(error);
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          const killDirectChild = () => {
            try {
              if (child.kill('SIGKILL') === false) reject(timeoutError());
            } catch (error) {
              reject(timeoutError(error));
            }
          };
          if (!signalProcessGroup(child.pid, 'SIGKILL', {
            platform,
            spawnImpl,
            onFailure: killDirectChild,
          })) killDirectChild();
        }, timeoutMs)
      : null;

    const collect = (stream, name) => {
      stream.on('data', (chunk) => {
        const text = String(chunk);
        if (name === 'stdout') stdout += text;
        else stderr += text;
        onOutput?.(text, name);
      });
    };
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');

    const decorate = (error) => {
      if (timer) clearTimeout(timer);
      clearActiveProcess(activeProcessPath);
      error.command = [command, ...args].join(' ');
      error.stdout = stdout;
      error.stderr = stderr;
      error.output = [stdout, stderr].filter(Boolean).join('\n');
      error.timedOut = timedOut;
      return error;
    };

    child.on('error', (error) => reject(decorate(error)));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      clearActiveProcess(activeProcessPath);
      if (timedOut) {
        return reject(timeoutError());
      }
      if (code === 0) return resolve({ stdout, stderr, code });
      const error = decorate(new Error(`Command failed: ${command} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`));
      error.code = code;
      error.signal = signal;
      return reject(error);
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

import { spawn } from 'node:child_process';

/**
 * Run a command, capturing its output while optionally streaming it onward.
 *
 * Agent phases run for minutes at a time, so unlike a buffered helper this one
 * forwards each chunk to `onOutput` as it arrives — a run you cannot watch is a
 * run you cannot debug. `timeoutMs` exists because a silently hung agent is the
 * most common unattended failure and it burns tokens for as long as it hangs.
 */
export async function runCommand(command, args = [], options = {}) {
  const { cwd, env = process.env, timeoutMs, onOutput, input } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
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
      if (timedOut) {
        const error = decorate(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
        error.code = 'ETIMEDOUT';
        return reject(error);
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

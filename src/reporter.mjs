import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

// Renderer seam: `log`/`banner` fan out to whichever renderer is active so a
// second renderer (e.g. the TUI in tui.mjs) can slot in without runner.mjs or
// pipeline.mjs knowing which one is live. `report` is deliberately left alone
// — callers stop the alternate renderer and reset to plain before calling it,
// so the final summary always prints as normal scrollback text.
let activeRenderer = null;

export function setRenderer(renderer) {
  activeRenderer = renderer;
}

export function resetRenderer() {
  activeRenderer = null;
}

export function log(message) {
  if (activeRenderer) {
    activeRenderer.log(message);
    return;
  }
  console.log(message);
}

export function banner(text) {
  if (activeRenderer) {
    activeRenderer.banner(text);
    return;
  }
  log(`\n── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}`);
}

// Raw child-process/engine output (gate commands, setup commands, agent
// streams) goes through this seam too, not straight to process.stdout: a
// renderer that repaints the screen (the TUI) needs to be the only writer,
// or its repaints interleave with the raw bytes into a garbled display.
export function writeOutput(text) {
  if (activeRenderer) {
    activeRenderer.output?.(text);
    return;
  }
  process.stdout.write(text);
}

export function describeAgent(agent) {
  return `${agent.name}${agent.model ? ` model=${agent.model}` : ''}${agent.effort ? ` effort=${agent.effort}` : ''}`;
}

export function formatPhase(phase) {
  const detail = phase.rounds ? ` (${phase.rounds} round${phase.rounds === 1 ? '' : 's'}, ${phase.verdict})` : '';
  return `  ✓ ${phase.name}${detail}`;
}

export function openTerminalInput(options = {}) {
  const { platform = process.platform, input = process.stdin, createInput = createReadStream } = /** @type {any} */ (options);
  if (platform === 'win32' && input.isTTY) return Promise.resolve(input);
  const terminalPath = platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';
  return new Promise((resolveInput, rejectInput) => {
    const terminalInput = createInput(terminalPath);
    const onOpen = () => {
      terminalInput.off('error', onError);
      resolveInput(terminalInput);
    };
    const onError = (error) => {
      terminalInput.off('open', onOpen);
      terminalInput.destroy();
      rejectInput(error);
    };
    terminalInput.once('open', onOpen);
    terminalInput.once('error', onError);
  });
}

export async function ensureConfirmationAvailable(input, terminalOpener) {
  if (input || process.stdin.isTTY) return;
  let terminalInput;
  try {
    terminalInput = await terminalOpener();
  } catch {
    throw new Error('no terminal available to confirm phases; re-run with --yes to run unattended');
  }
  if (terminalInput !== process.stdin) terminalInput.destroy();
}

export async function confirm(question, { input = null, terminalOpener = openTerminalInput } = {}) {
  let confirmationInput = input;
  let closeInput = false;
  if (!confirmationInput) {
    if (process.stdin.isTTY) {
      confirmationInput = process.stdin;
    } else {
      try {
        confirmationInput = await terminalOpener();
      } catch {
        throw new Error('no terminal available to confirm phases; re-run with --yes to run unattended');
      }
      closeInput = confirmationInput !== process.stdin;
    }
  }
  const rl = createInterface({ input: confirmationInput, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [Y/n/q] `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'q') return 'quit';
    return normalized === '' || normalized === 'y' ? 'yes' : 'skip';
  } finally {
    rl.close();
    if (closeInput) confirmationInput.destroy();
  }
}

export function report(summary, formatFindings) {
  banner('summary');
  for (const phase of summary.phases) {
    log(formatPhase(phase));
  }
  if (!summary.stalled) {
    log(`\nPipeline finished. Branch ${summary.branch} is ready.`);
    if (summary.prUrl) log(`Pull request: ${summary.prUrl}`);
    log(`Logs: ${summary.runDir}`);
    return;
  }
  log(`\n  ✗ stalled in "${summary.stalled.phase}": ${summary.stalled.reason}`);
  if (summary.stalled.findings?.length) {
    log(`\nOutstanding blocking findings:\n${formatFindings(summary.stalled.findings)}`);
  }
  if (summary.stalled.output) log(`\n${summary.stalled.output.trim().split('\n').slice(-20).join('\n')}`);
  log(`\nWorktree: ${summary.worktree}`);
  log(`Logs:     ${summary.runDir}`);
  const resumeArgs = [`--name ${summary.task}`];
  if (summary.taskFile && summary.taskFile !== `${summary.runDir}/task.md`) {
    resumeArgs.push(`--task-file ${summary.taskFile}`);
  }
  log(`Resume:   aloop ${resumeArgs.join(' ')} --resume`);
  process.exitCode = 1;
}

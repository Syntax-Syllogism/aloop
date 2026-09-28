// Quiet renderer: for an orchestrator reading a run's stdout, raw engine/gate/
// setup streams are noise — they are already preserved byte-for-byte in the
// run-dir logs (the callers `tee` them separately). This renderer drops them
// from the terminal and prints phase transitions, the structured `log()` lines,
// and a periodic heartbeat that says whether the run is still moving.

const DEFAULT_HEARTBEAT_MINUTES = 10;
const LAST_LINE_LIMIT = 120;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Effective quiet settings for one invocation. Quiet is display-only, so CLI
 * flags always win over the config: `--no-quiet` > `--quiet`/`--heartbeat` >
 * config `quiet` > default off.
 *
 * @param {{ quiet?: boolean, noQuiet?: boolean, heartbeatMinutes?: number }} args
 * @param {{ quiet?: boolean, heartbeatMinutes?: number }} config
 */
export function resolveQuiet(args = {}, config = {}) {
  const minutes = args.heartbeatMinutes ?? config.heartbeatMinutes ?? DEFAULT_HEARTBEAT_MINUTES;
  const heartbeatMs = Math.round(minutes * 60 * 1000);
  if (args.noQuiet) return { enabled: false, heartbeatMs };
  const enabled = Boolean(args.quiet || args.heartbeatMinutes !== undefined || config.quiet);
  return { enabled, heartbeatMs };
}

export function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function formatClock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// A `\r`-redrawn progress bar should read as its latest frame, not every frame.
function visibleText(line) {
  const pieces = line.replace(ANSI_PATTERN, '').split('\r').map((piece) => piece.trim()).filter(Boolean);
  return pieces.at(-1) ?? '';
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * @param {{ heartbeatMs: number, output?: { write: (text: string) => any },
 *           now?: () => number,
 *           setInterval?: (callback: () => void, ms: number) => any,
 *           clearInterval?: (timer: any) => void }} options
 */
export function createQuietRenderer(options) {
  const {
    heartbeatMs,
    output = process.stdout,
    now = Date.now,
    setInterval: startInterval = globalThis.setInterval,
    clearInterval: stopInterval = globalThis.clearInterval,
  } = options;
  const startedAt = now();
  let phaseName = null;
  let phaseStartedAt = startedAt;
  let lastLine = '';
  let pendingLine = '';
  let timer = null;
  let stopped = false;

  const write = (line) => {
    if (!stopped) output.write(`${line}\n`);
  };

  const clearTimer = () => {
    if (timer !== null) stopInterval(timer);
    timer = null;
  };

  const tick = () => {
    const at = now();
    const last = lastLine || visibleText(pendingLine);
    write(`[${formatClock(at)}] ${phaseName ?? 'setup'} · ${formatDuration(at - phaseStartedAt)} in phase · ${formatDuration(at - startedAt)} total${last ? ` · last: ${truncate(last, LAST_LINE_LIMIT)}` : ''}`);
  };

  const restartTimer = () => {
    clearTimer();
    if (stopped || !(heartbeatMs > 0)) return;
    timer = startInterval(tick, heartbeatMs);
    timer?.unref?.();
  };

  restartTimer();

  return {
    banner(text) {
      phaseName = text.trim();
      phaseStartedAt = now();
      lastLine = '';
      pendingLine = '';
      write(`[${formatClock(phaseStartedAt)}] ── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}`);
      restartTimer();
    },
    log(message) {
      write(message);
    },
    output(text) {
      pendingLine += text;
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        const visible = visibleText(line);
        if (visible) lastLine = visible;
      }
    },
    stop() {
      clearTimer();
      stopped = true;
    },
  };
}

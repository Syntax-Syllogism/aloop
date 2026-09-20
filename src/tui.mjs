import { spawnSync } from 'node:child_process';
import { computeRunMetrics } from './metrics.mjs';
import { formatFindings } from './verdict.mjs';

const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RECENT_LOG_LIMIT = 8;

/**
 * A live TUI is only a view over the same run; it never changes what the run
 * does. It is therefore only worth showing where someone can watch it, and
 * must get out of the way the moment that stops being true (piped output/CI, or
 * an explicit `--no-tui`). `--yes` only skips per-phase confirmation, so an
 * unattended run on a real terminal can still be watched live.
 */
export function tuiEnabled(options = {}) {
  const { isTTY, noTui } = /** @type {any} */ (options);
  return Boolean(isTTY) && !noTui;
}

function statusSymbol(status) {
  if (status === 'completed') return '✓';
  if (status === 'stalled') return '✗';
  if (status === 'active') return '▶';
  return ' ';
}

function matchPhaseName(resolvedPhases, text) {
  const found = resolvedPhases.find((phase) => text === phase.name || text.startsWith(`${phase.name} (`));
  return found ? found.name : null;
}

function phaseRows(resolvedPhases, manifestEntries, completed, activeName) {
  return resolvedPhases.map((phase) => {
    const entries = manifestEntries.filter((entry) => entry.phase === phase.name);
    const last = entries.at(-1);
    let status = 'pending';
    if (last?.status === 'stalled') status = 'stalled';
    else if (completed.includes(phase.name)) status = 'completed';
    else if (phase.name === activeName) status = 'active';
    const rounds = entries.filter((entry) => Number.isInteger(entry.round)).length;
    return { name: phase.name, status, rounds, verdict: last?.verdict?.verdict ?? null };
  });
}

export function defaultDiffStat(worktree) {
  if (!worktree) return '';
  try {
    const result = spawnSync('git', ['-C', worktree, 'diff', '--stat', 'HEAD'], { encoding: 'utf8' });
    if (result.status !== 0 || result.error) return '';
    return result.stdout.trim();
  } catch {
    return '';
  }
}

function formatValue(value) {
  return value === null || value === undefined ? '?' : String(value);
}

function latestVerdictEntry(manifestEntries) {
  return [...manifestEntries].reverse().find((entry) => entry.verdict);
}

function renderFrame({ config, summary, state, activeName, recentLog, diff }) {
  const manifestEntries = state.manifest.entries;
  const completed = state.data.completed ?? [];
  const rows = phaseRows(config.resolvedPhases, manifestEntries, completed, activeName);
  const metrics = computeRunMetrics(state.manifest);
  const artifacts = [...new Set(manifestEntries.flatMap((entry) => entry.artifacts ?? []))];
  const verdictEntry = latestVerdictEntry(manifestEntries);

  const lines = [];
  lines.push(`aloop · ${summary.task}  branch=${summary.branch}`);
  lines.push('');
  lines.push('Phases:');
  for (const row of rows) {
    const roundDetail = row.rounds ? ` (round ${row.rounds}${row.verdict ? `, ${row.verdict}` : ''})` : '';
    lines.push(`  ${statusSymbol(row.status)} ${row.name}${roundDetail}`);
  }
  lines.push('');
  lines.push(
    `Cost: duration=${formatValue(metrics.total.durationMs)}ms tokens=${formatValue(metrics.total.tokens)} cost=${formatValue(metrics.total.cost)}`,
  );
  if (diff) {
    lines.push('');
    lines.push('Diff:');
    lines.push(...diff.split('\n'));
  }
  if (verdictEntry) {
    lines.push('');
    lines.push(`Findings (${verdictEntry.phase}, ${verdictEntry.verdict.verdict}):`);
    lines.push(formatFindings([...(verdictEntry.verdict.blocking ?? []), ...(verdictEntry.verdict.nits ?? [])]));
  }
  if (artifacts.length) {
    lines.push('');
    lines.push(`Artifacts: ${artifacts.join(', ')}`);
  }
  if (recentLog.length) {
    lines.push('');
    lines.push('Recent:');
    for (const entry of recentLog) lines.push(`  ${entry}`);
  }
  return lines.join('\n');
}

/**
 * A second renderer behind the `banner`/`log` seam in reporter.mjs. It reads
 * the same manifest/state the run already persists after every phase, so it
 * needs no separate event stream — just a repaint on every `banner`/`log`
 * call, which is exactly when the run's visible state can have changed.
 *
 * `git diff --stat` is a subprocess spawn, not free, and the diff it reports
 * only changes between phases (each phase is what edits the worktree) — so
 * it's computed once per `banner` and reused by every repaint until the next
 * one, instead of being re-spawned on every `log`/`output` call.
 */
export function createTuiRenderer(options = {}) {
  const { config, state, summary, output = process.stdout, diffStat = defaultDiffStat } = /** @type {any} */ (options);
  let activeName = null;
  const recentLog = [];
  let pendingLine = '';
  let cachedDiff = '';

  function repaint() {
    const frame = renderFrame({ config, summary, state, activeName, recentLog, diff: cachedDiff });
    output.write(`${HIDE_CURSOR}${CLEAR_SCREEN}${frame}\n`);
  }

  function pushRecent(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    recentLog.push(trimmed);
    if (recentLog.length > RECENT_LOG_LIMIT) recentLog.shift();
  }

  return {
    banner(text) {
      activeName = matchPhaseName(config.resolvedPhases, text) ?? activeName;
      recentLog.length = 0;
      recentLog.push(text.trim());
      cachedDiff = diffStat(summary.worktree);
      repaint();
    },
    log(message) {
      pushRecent(message);
      repaint();
    },
    // Raw engine/gate/setup output arrives in arbitrary chunks, not lines;
    // buffer until a newline so the "Recent" pane shows whole lines instead
    // of chopped fragments, then fold it into the same repaint the other
    // renderer calls use so nothing else writes to the terminal directly.
    // A chunk with no newline yet changes nothing visible (the fragment
    // isn't shown until it completes a line), so it's buffered without
    // triggering a repaint.
    output(text) {
      pendingLine += text;
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop();
      if (lines.length === 0) return;
      for (const line of lines) pushRecent(line);
      repaint();
    },
    stop() {
      repaint();
      output.write(SHOW_CURSOR);
    },
  };
}

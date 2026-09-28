import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoopArgs, usage } from '../bin/loop.mjs';
import { loadConfig } from '../src/config.mjs';
import { hashConfig } from '../src/manifest.mjs';
import { banner, log, resetRenderer, setRenderer, writeOutput } from '../src/reporter.mjs';
import { createQuietRenderer, formatDuration, resolveQuiet } from '../src/quiet.mjs';

const MINUTE = 60 * 1000;

function fakeOutput() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), chunks, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

function fakeClock(start = new Date(2026, 8, 27, 14, 2).getTime()) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function fakeTimers() {
  const timers = { set: [], cleared: [] };
  return {
    timers,
    setInterval: (callback, ms) => {
      const timer = { callback, ms, unref() { this.unrefed = true; } };
      timers.set.push(timer);
      return timer;
    },
    clearInterval: (timer) => timers.cleared.push(timer),
    tick: () => timers.set.at(-1).callback(),
  };
}

function quietFixture(heartbeatMs = 10 * MINUTE) {
  const output = fakeOutput();
  const clock = fakeClock();
  const timers = fakeTimers();
  const renderer = createQuietRenderer({
    heartbeatMs,
    output,
    now: clock.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { output, clock, timers, renderer };
}

test('quiet renderer drops raw output but prints banners and log lines', () => {
  const { output, renderer } = quietFixture();
  setRenderer(renderer);
  try {
    banner('implement');
    writeOutput('SECRET-STREAM\n');
    log('  review: approve');
  } finally {
    renderer.stop();
    resetRenderer();
  }
  const text = output.chunks.join('');
  assert.doesNotMatch(text, /SECRET-STREAM/);
  assert.match(text, /^\[14:02\] ── implement ─+\n/);
  assert.match(text, /\n {2}review: approve\n$/);
});

test('heartbeat reports phase, time in phase, total time, and last line', () => {
  const { output, clock, timers, renderer } = quietFixture();
  renderer.banner('implement');
  renderer.output('foo\n');
  clock.advance(10 * MINUTE);
  timers.tick();
  assert.equal(timers.timers.set.at(-1).ms, 10 * MINUTE);
  assert.equal(timers.timers.set.at(-1).unrefed, true);
  assert.match(output.lines().at(-1), /^\[\d\d:\d\d\] implement · 10m in phase · 10m total · last: foo$/);
  renderer.stop();
});

test('banner resets the phase clock and restarts the heartbeat timer', () => {
  const { output, clock, timers, renderer } = quietFixture();
  renderer.banner('implement');
  clock.advance(25 * MINUTE);
  const before = timers.timers.set.length;
  renderer.banner('review (round 1/3)');
  assert.equal(timers.timers.set.length, before + 1);
  assert.ok(timers.timers.cleared.includes(timers.timers.set[before - 1]));
  clock.advance(10 * MINUTE);
  timers.tick();
  assert.equal(output.lines().at(-1), '[14:37] review (round 1/3) · 10m in phase · 35m total');
  renderer.stop();
});

test('heartbeat before any banner labels the phase setup', () => {
  const { output, clock, timers, renderer } = quietFixture();
  clock.advance(MINUTE * 2);
  timers.tick();
  assert.equal(output.lines().at(-1), '[14:04] setup · 2m in phase · 2m total');
  renderer.stop();
});

test('last line handles chunks, ANSI, carriage returns, truncation, and partial lines', () => {
  const { output, timers, renderer } = quietFixture();
  renderer.banner('gate');
  renderer.output('par');
  timers.tick();
  assert.match(output.lines().at(-1), / · last: par$/, 'partial line is the fallback');
  renderer.output('tial one\n\n   \n');
  timers.tick();
  assert.match(output.lines().at(-1), / · last: partial one$/, 'blank lines do not clobber the last line');
  renderer.output('\x1b[32mgreen\x1b[0m text\n');
  timers.tick();
  assert.match(output.lines().at(-1), / · last: green text$/);
  renderer.output('progress 10%\rprogress 50%\rprogress 90%\r\n');
  timers.tick();
  assert.match(output.lines().at(-1), / · last: progress 90%$/);
  renderer.output(`${'x'.repeat(300)}\n`);
  timers.tick();
  const last = output.lines().at(-1).split(' · last: ')[1];
  assert.equal(last.length, 120);
  assert.ok(last.endsWith('…'));
  renderer.stop();
});

test('heartbeatMs 0 creates no timer but still prints transitions', () => {
  const { output, timers, renderer } = quietFixture(0);
  renderer.banner('implement');
  assert.equal(timers.timers.set.length, 0);
  assert.match(output.lines()[0], /── implement/);
  renderer.stop();
});

test('stop clears the timer and silences the renderer', () => {
  const { output, timers, renderer } = quietFixture();
  const timer = timers.timers.set.at(-1);
  renderer.stop();
  assert.ok(timers.timers.cleared.includes(timer));
  const count = output.chunks.length;
  timer.callback();
  renderer.log('late');
  assert.equal(output.chunks.length, count);
});

test('formatDuration renders minutes and hours', () => {
  assert.equal(formatDuration(30 * 1000), '<1m');
  assert.equal(formatDuration(59 * MINUTE + 59 * 1000), '59m');
  assert.equal(formatDuration(65 * MINUTE), '1h05m');
});

test('resolveQuiet applies CLI over config over defaults', () => {
  assert.deepEqual(resolveQuiet({}, { quiet: false, heartbeatMinutes: 10 }), { enabled: false, heartbeatMs: 10 * MINUTE });
  assert.deepEqual(resolveQuiet({}, { quiet: true, heartbeatMinutes: 10 }), { enabled: true, heartbeatMs: 10 * MINUTE });
  assert.deepEqual(resolveQuiet({ quiet: true }, {}), { enabled: true, heartbeatMs: 10 * MINUTE });
  assert.deepEqual(resolveQuiet({ heartbeatMinutes: 3 }, { quiet: false, heartbeatMinutes: 10 }), { enabled: true, heartbeatMs: 3 * MINUTE });
  assert.equal(resolveQuiet({ noQuiet: true }, { quiet: true, heartbeatMinutes: 10 }).enabled, false);
  assert.deepEqual(resolveQuiet({ quiet: true }, { quiet: false, heartbeatMinutes: 5 }), { enabled: true, heartbeatMs: 5 * MINUTE });
  assert.deepEqual(resolveQuiet({ heartbeatMinutes: 0 }, {}), { enabled: true, heartbeatMs: 0 });
});

test('quiet CLI flags parse and validate', () => {
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--quiet']).quiet, true);
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--no-quiet']).noQuiet, true);
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--heartbeat', '2.5']).heartbeatMinutes, 2.5);
  assert.equal(parseLoopArgs(['-f', 'wi.md', '--heartbeat', '0']).heartbeatMinutes, 0);
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--heartbeat=-1']), /--heartbeat must be a non-negative number of minutes/);
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--heartbeat', 'x']), /--heartbeat must be/);
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--heartbeat', '']), /--heartbeat must be/);
  assert.throws(() => parseLoopArgs(['-f', 'wi.md', '--quiet', '--no-quiet']), /mutually exclusive/);
  assert.match(usage(), /--quiet/);
  assert.match(usage(), /--heartbeat <min>/);
});

test('loadConfig defaults and validates quiet settings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'loop-quiet-config-'));
  const config = await loadConfig(cwd, { gate: ['true'] });
  assert.equal(config.quiet, false);
  assert.equal(config.heartbeatMinutes, 10);
  await assert.rejects(loadConfig(cwd, { gate: ['true'], quiet: 'yes' }), /`quiet` must be a boolean/);
  await assert.rejects(loadConfig(cwd, { gate: ['true'], heartbeatMinutes: -1 }), /`heartbeatMinutes` must be a nonnegative number/);
  await assert.rejects(loadConfig(cwd, { gate: ['true'], heartbeatMinutes: '5' }), /`heartbeatMinutes`/);
});

test('display-only quiet settings do not change the config hash', () => {
  const base = { gate: ['npm test'], maxRounds: 3 };
  assert.equal(hashConfig({ ...base, quiet: false, heartbeatMinutes: 10 }), hashConfig({ ...base, quiet: true, heartbeatMinutes: 1 }));
  assert.equal(hashConfig({ ...base, quiet: true }), hashConfig(base));
  assert.notEqual(hashConfig({ ...base, maxRounds: 2 }), hashConfig(base));
});

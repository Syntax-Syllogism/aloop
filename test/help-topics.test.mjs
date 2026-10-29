import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_MANUALS,
  extractMarkdownSection,
  listGuides,
  renderCommandManual,
  renderGuide,
  rewriteDocLinks,
} from '../src/help-topics.mjs';
import { commandUsage } from '../bin/loop.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/loop.mjs', import.meta.url));
const commands = [
  'list',
  'status',
  'inspect',
  'replay',
  'metrics',
  'cancel',
  'clean',
  'doctor',
  'watch',
  'init',
  'run',
  'help',
];

test('guide metadata covers every shipped guide except the index', async () => {
  const guides = await listGuides();
  assert.ok(guides.length > 0);
  assert.ok(guides.every(({ name, title, description }) => name !== 'README' && title && description));
});

test('every command manual has its mapped sections and expands short help', async () => {
  assert.deepEqual(Object.keys(COMMAND_MANUALS).sort(), [...commands].sort());
  const guides = await listGuides();
  assert.equal(
    commands.some((command) => guides.some((guide) => guide.name === command)),
    false,
  );
  for (const command of commands) {
    const short = commandUsage(command);
    const manual = await renderCommandManual(command, short);
    assert.ok(manual.startsWith(`Usage: aloop ${command}`));
    assert.ok(manual.length > short.length, `${command} manual should be longer than short help`);
  }
});

test('section extraction ignores headings inside fenced code blocks', () => {
  const fixture = '# Guide\n## Target\nBefore.\n```js\n# Fake heading\n```\nAfter.\n## Next\nOther.';
  assert.equal(extractMarkdownSection(fixture, 'Target'), '## Target\nBefore.\n```js\n# Fake heading\n```\nAfter.');
});

test('guide links become terminal help references with section names', () => {
  assert.equal(
    rewriteDocLinks('See [x](judge.md#stall-and-override).'),
    'See `aloop help judge` (section "Stall and override").',
  );
});

test('aloop help lists topics and renders guides and command manuals', async () => {
  const { stdout: list } = await exec(process.execPath, [cli, 'help'], { cwd: process.cwd() });
  assert.match(list, /Commands:/);
  assert.match(list, /Guides:/);
  const { stdout: guides } = await exec(process.execPath, [cli, 'help', '-g'], { cwd: process.cwd() });
  assert.match(guides, /judge\s+Optional decision model/);
  const { stdout: guide } = await exec(process.execPath, [cli, 'help', 'judge'], { cwd: process.cwd() });
  assert.match(guide, /^# Repeated-blocker judge/m);
  assert.doesNotMatch(guide, /^---$/m);
  const { stdout: run } = await exec(process.execPath, [cli, 'help', 'run'], { cwd: process.cwd() });
  assert.match(run, /## Resuming/);
  const { stdout: self } = await exec(process.execPath, [cli, 'help', 'help'], { cwd: process.cwd() });
  assert.match(self, /^Usage: aloop help/m);
  assert.doesNotMatch(self, /Guides:/);
});

test('unknown help topic reports suggestions and exits unsuccessfully', async () => {
  await assert.rejects(exec(process.execPath, [cli, 'help', 'judg'], { cwd: process.cwd() }), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /aloop help: no command or guide named 'judg'/);
    assert.match(error.stderr, /judge/);
    assert.match(error.stderr, /aloop help -a/);
    return true;
  });
});

test('npm package includes Markdown guides without docs-site output', async () => {
  const { stdout } = await exec(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', '/tmp/aloop-npm-cache'],
    { cwd: process.cwd() },
  );
  const [pack] = JSON.parse(stdout);
  const paths = pack.files.map(({ path }) => path);
  assert.ok(paths.includes('docs/loop.md'));
  assert.equal(
    paths.some((path) => path.startsWith('docs-site/')),
    false,
  );
});

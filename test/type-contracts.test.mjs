// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

/** @typedef {import('../src/types.js').Config} Config */
/** @typedef {import('../src/types.js').PhaseDescriptor} PhaseDescriptor */
/** @typedef {import('../src/types.js').Verdict} Verdict */
/** @typedef {import('../src/types.js').Adapter} Adapter */

/** @type {PhaseDescriptor} */
const phase = {
  name: 'implement',
  kind: 'agent',
  prompt: 'implement',
  inputs: ['task'],
  outputs: ['commit'],
  postconditions: [],
  permissions: ['write-worktree'],
  optional: false,
  retry: { maxAttempts: 1 },
};

/** @type {Verdict} */
const verdict = { verdict: 'APPROVED', blocking: [], nits: [], summary: '' };

/** @type {Adapter} */
const adapter = {
  command: ({ prompt }) => ({ command: 'agent', args: [prompt] }),
};

/** @type {Partial<Config> & Pick<Config, 'adapters'>} */
const config = { resolvedPhases: [phase], adapters: { local: adapter } };

if (false) {
  // @ts-expect-error Verdicts must use the two supported outcomes.
  verdict.verdict = 'PENDING';
  // @ts-expect-error Phase names are strings.
  phase.name = 1;
  // @ts-expect-error Configured adapters must expose command().
  config.adapters = { broken: {} };
}

test('shared type-contract fixtures retain valid runtime shapes', () => {
  assert.equal(phase.kind, 'agent');
  assert.equal(verdict.verdict, 'APPROVED');
  assert.equal(config.adapters.local.command({
    prompt: 'test', cwd: '.', addDirs: [], permissions: ['read-only'],
  }).command, 'agent');
});

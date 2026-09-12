#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { isMainEntrypoint } from '../src/entrypoint.mjs';
import { runLoop } from '../src/pipeline.mjs';

export function parseLoopArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string', short: 't' },
      'task-file': { type: 'string', short: 'f' },
      name: { type: 'string', short: 'n' },
      branch: { type: 'string', short: 'b' },
      'base-branch': { type: 'string' },
      engine: { type: 'string', short: 'e' },
      'override-engine': { type: 'boolean' },
      config: { type: 'string' },
      phases: { type: 'string' },
      'max-rounds': { type: 'string' },
      from: { type: 'string' },
      resume: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-worktree': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { help: true };
  const maxRounds = values['max-rounds'] ? Number(values['max-rounds']) : undefined;
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    throw new Error('--max-rounds must be a positive integer');
  }
  return {
    task: values.task,
    taskFile: values['task-file'],
    name: values.name,
    branch: values.branch,
    baseBranch: values['base-branch'],
    engine: values.engine,
    overrideEngine: values['override-engine'],
    config: values.config,
    phases: values.phases ? values.phases.split(',').map((phase) => phase.trim()).filter(Boolean) : undefined,
    maxRounds,
    from: values.from,
    resume: values.resume,
    yes: values.yes,
    noWorktree: values['no-worktree'],
    dryRun: values['dry-run'],
  };
}

export function usage() {
  return [
    'Usage: aloop [options]',
    '',
    '  -t, --task <text>       Inline task description',
    '  -f, --task-file <path>  Path to a task/plan/spec file',
    '  -n, --name <slug>       Explicit run identity/slug',
    '  -b, --branch <name>     Branch to build on (default: <branchPrefix><name>)',
    '      --base-branch <branch>  Base to branch from and PR against (default: baseBranch config)',
    '  -e, --engine <name>     Default engine: claude | codex | agy',
    '      --override-engine   With --resume and --engine, replace saved agent executables',
    '      --config <path>     Load loop configuration from this file (also overrides saved config on resume)',
    '      --phases a,b,c      Override the configured phase list',
    '      --max-rounds <n>    Cap on review/repair rounds',
    '      --from <phase>      Start at this phase',
    '      --resume            Skip phases already recorded complete',
    '  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)',
    '      --no-worktree       Work in the current checkout instead of a worktree',
    '      --dry-run           Print the plan and rendered prompts, run nothing',
  ].join('\n');
}

if (isMainEntrypoint(import.meta.url)) {
  try {
    const args = parseLoopArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      await runLoop({ args });
    }
  } catch (error) {
    console.error(error.message);
    if (!error.command) console.error(usage());
    process.exitCode = 1;
  }
}

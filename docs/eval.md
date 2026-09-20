---
title: Evaluation harness
description: Run a task corpus across a model/config matrix and compare completion, escaped defects, convergence, and cost.
---

# Evaluation harness

The evaluation harness runs a corpus of tasks through the loop under a matrix
of engine/model configurations, each in its own throwaway git repository, and
reports how each task × config cell fared. It answers questions a single run
can't: which model converges faster on this kind of task, which config lets
defects slip past its own gate and review, and at what cost.

## Usage

```sh
aloop-eval ./eval/spec.mjs
aloop-eval ./eval/spec.mjs --json
```

`<spec.mjs>` is a module exporting a task `corpus` array and a config `matrix`
array, either as a default export (`export default { corpus, matrix }`) or as
named exports (`export const corpus = [...]; export const matrix = [...];`).
Without `--json`, the command prints a per-cell table followed by a per-config
summary table; `--json` emits `{ results, summaries }` instead.

## Spec file

```js
export const corpus = [
  {
    id: 'greet-hello',
    files: {
      'greet.js': 'module.exports = () => "TODO";\n',
      'gate-check.js': 'if (require("./greet.js")().length === 0) process.exit(1);\n',
      'hidden-check.js': 'if (require("./greet.js")() !== "hello") process.exit(1);\n',
    },
    task: 'Make greet.js return "hello".',
    gate: ['node gate-check.js'],
    heldOutCheck: ['node hidden-check.js'],
  },
];

export const matrix = [
  { name: 'claude-high', engine: { name: 'claude', effort: 'high' } },
  { name: 'codex-high', engine: { name: 'codex', effort: 'high' } },
];
```

### Task fields

Each `EvalTask` describes one self-contained fixture:

- `id` — the task's identifier in results and tables.
- `files` — initial repo contents, written relative to the fixture root before
  the first commit.
- `task` — the task text written to the run's task file.
- `gate` — the visible gate commands, i.e. what the loop itself enforces
  during the run (same shape as `gate` in `loop.config.mjs`).
- `heldOutCheck` — hidden verification commands run against the approved
  worktree *after* the run completes. These never appear in the gate or in any
  prompt, so they measure defects that escaped both the gate and the review
  phase, not just gate coverage.
- `phases` — optional phase list override (defaults to `['implement', 'gate',
  'review']`).

### Config fields

Each `EvalConfig` describes one point in the matrix:

- `name` — the config's identifier in results and tables.
- `engine`, `phases`, `configExtra` — used to build a minimal generated
  `loop.config.mjs` (`configExtra` is shallow-merged in last, so it can add or
  override keys like `publish` or `adapters`).
- `configSource` — full control over the generated config: either a
  `(task) => string` function or a literal config-file string. Use this for
  configs a minimal generated file can't express, such as a fake adapter in
  tests.
- `runArgs` — extra arguments merged into the `runLoop` call (e.g. `maxRounds`).

## What a cell reports

`runEvalCell` runs one task under one config in a fresh temporary git
repository (`git init`, an initial commit of `files`, then the generated
config and task file), drives it through `runLoop` with `--yes`, and returns:

- `completed` — whether the run finished without stalling.
- `escapedDefect` — `null` when the task has no `heldOutCheck` or the run
  didn't complete; otherwise `true` when the held-out check fails against the
  approved worktree despite the run completing, and `false` when it passes.
- `roundsToConverge`, `cost`, `durationMs` — read from the run's own
  `manifest.json` via the same [`computeRunMetrics`](metrics.md) used by
  `aloop metrics`, so these numbers match what a single real run would report.
- `approvedSha`, `runDir`, `snapshotPath` — where to find the run's worktree
  HEAD and persisted artifacts for follow-up inspection.
- `error` — the caught error message, if the run itself threw.

A repo's `.loop/` run-state directory would otherwise show up as untracked
changes and trip the implement/review clean-tree check; the harness adds a
`.gitignore` entry for it automatically unless the task's own `files` already
provide a `.gitignore`.

`runEval({ corpus, matrix })` runs every task against every config and returns
the flat list of cells. `summarizeEval(results)` aggregates per config:
`completionRate`, `escapedDefectRate` (over cells that had a `heldOutCheck`),
`avgRoundsToConverge`, `totalCost` (`null` unless every cell in the config
reported a cost), and `totalDurationMs`.

## Library API

`runEval`, `runEvalCell`, `summarizeEval`, `formatEvalTable`, and
`formatEvalSummaryTable` are also exported from the package root for
programmatic use:

```js
import { runEval, summarizeEval } from '@syntax-syllogism/aloop';
```

---
title: Evaluation harness
description: Run a task corpus across a model/config matrix and compare completion, escaped defects, convergence, and cost.
---

# Evaluation harness

The harness runs a set of tasks through the loop under a matrix of engine and model configurations. Each run gets its own throwaway git repository, and each task-and-config pair gets a result. It answers questions a single run can't: which model converges faster on this kind of task, which config lets defects slip past its own gate and review, and what each costs.

## Usage

```sh
aloop-eval ./eval/spec.mjs
aloop-eval ./eval/spec.mjs --json
```

The spec is a module that exports a task `corpus` array and a config `matrix` array. Use either a default export (`export default { corpus, matrix }`) or named exports (`export const corpus = [...]; export const matrix = [...];`).

By default the command prints a table with one row per cell, then a summary table with one row per config. With `--json` it prints `{ results, summaries }` instead.

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

Each task is one self-contained fixture:

- `id`: the task's name in results and tables.
- `files`: the starting repo contents, written relative to the fixture root before the first commit.
- `task`: the task text, written to the run's task file.
- `gate`: the visible gate commands the loop enforces during the run. Same shape as `gate` in `loop.config.mjs`.
- `heldOutCheck`: hidden checks run against the approved worktree *after* the run finishes. They never appear in the gate or in any prompt, so they measure defects that got past both the gate and the review, not just gate coverage.
- `phases`: optional phase list. Defaults to `['implement', 'gate', 'review']`.

### Config fields

Each config is one point in the matrix:

- `name`: the config's name in results and tables.
- `engine`, `phases`, `configExtra`: used to build a minimal generated `loop.config.mjs`. `configExtra` is shallow-merged last, so it can add or override keys such as `publish` or `adapters`.
- `configSource`: full control over the generated config. Either a `(task) => string` function or a literal config-file string. Use it for configs the minimal file can't express, such as a fake adapter in tests.
- `runArgs`: extra arguments merged into the `runLoop` call, for example `maxRounds`.

## What each cell reports

`runEvalCell` runs one task under one config in a fresh temporary git repository. It runs `git init`, commits `files`, adds the generated config and task file, then calls `runLoop` with `--yes`. It returns:

- `completed`: whether the run finished without stalling.
- `escapedDefect`: `null` if the task has no `heldOutCheck` or the run didn't complete. Otherwise `true` if the held-out check fails against the approved worktree even though the run completed, and `false` if it passes.
- `roundsToConverge`, `cost`, `durationMs`: read from the run's `manifest.json` by the same [`computeRunMetrics`](metrics.md) that `aloop metrics` uses, so the numbers match what a real run reports.
- `approvedSha`, `runDir`, `snapshotPath`: where to find the run's worktree HEAD and saved artifacts.
- `error`: the error message, if the run itself threw.

A repo's `.loop/` run-state directory would show up as untracked changes and trip the clean-tree check in implement and review. The harness adds a `.gitignore` entry for it, unless the task's own `files` already provide a `.gitignore`.

`runEval({ corpus, matrix })` runs every task against every config and returns the flat list of cells. `summarizeEval(results)` aggregates per config:

- `completionRate`
- `escapedDefectRate`, over cells that had a `heldOutCheck`
- `avgRoundsToConverge`
- `totalCost`, which is `null` unless every cell in the config reported a cost
- `totalDurationMs`

## Library API

`runEval`, `runEvalCell`, `summarizeEval`, `formatEvalTable`, and `formatEvalSummaryTable` are also exported from the package root:

```js
import { runEval, summarizeEval } from '@syntax-syllogism/aloop';
```

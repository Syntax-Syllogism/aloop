---
title: Cost and quality metrics
description: Inspect saved-run usage, convergence, and reviewer measurements.
---

# Cost and quality metrics

aloop computes measurements on demand from the phase entries in each saved `manifest.json`. There's no separate aggregate database or rollup file. That means you can inspect a run after it stalls, and the read-only commands still work if your current pipeline configuration is no longer valid.

## CLI commands

These commands are read-only. They use the configured `runsDir` (default `.loop/runs`) and never modify a run:

```sh
aloop status <name>
aloop inspect <name> [--json]
aloop list [--metrics] [--json]
aloop metrics [--json]
```

- `status` shows one run's status, phase, duration, token and cost totals, and reviewer catch rate.
- `inspect` adds the saved manifest phase entries.
- `list` shows saved runs. Add `--metrics` for duration, token, and cost columns, or per-run metrics in JSON.
- `metrics` aggregates every saved manifest.

Without `--json`, each command prints a compact summary. Add `--json` when a script needs the full result.

Pass `--config` to point at a non-default `runsDir`. These commands read only that setting, so they still work when the same config has an invalid or incomplete pipeline definition.

## What the metrics mean

Per-run JSON contains `total`, `phases`, `convergence`, `reviewer`, and `stalled`. `phaseMetrics` is an alias of `phases`. Each phase summary has entry and attempt counts, completed and stalled counts, `stallRate`, `durationMs`, `tokens`, and `cost`.

- `total.durationMs`: the sum of all non-skipped phase actions, gates included.
- `total.tokens` and `total.cost`: the sum of reported model usage from non-gate phase actions. Gates report no model usage, so they're excluded.
- `total.usageCoverage`: how many entries could report usage, and how many reported tokens and cost, as counts and fractions.
- `convergence.roundsToApproval` (also `roundsToConverge`): the first review round with an `APPROVED` verdict. The object also says whether the run converged, how many review rounds were observed, and the distribution of approval rounds.
- `reviewer.catchRate`: the fraction of review rounds with `CHANGES_REQUESTED`. `findingsCleared` is the drop in blocking findings between adjacent review rounds. `findingsClearedPerRound` divides that by the number of repair rounds.
- `stalled`: the phases with at least one stalled entry.

The cross-run `metrics` output adds `runs`, aggregate phase summaries, `convergenceRate`, average rounds to convergence, distributions, reviewer totals, and `runMetrics` (each run's metrics).

Budget-stall bookkeeping entries don't count as usage-applicable. Otherwise a recorded budget stop would turn an otherwise complete token or cost total into `null`.

## Unknown usage

Usage is best-effort and works with any engine. An entry contributes to a token or cost sum only if it has a finite numeric value. If no applicable entry reports a value, or any applicable entry is missing one, that total is `null` instead of an estimate. A cross-run total is `null` if any run lacks a complete total. `durationMs` is reported regardless of usage, and `usageCoverage` shows how much was reported.

The human-readable commands print `?` for `null` or missing values.

## How usage is captured

An adapter can return numeric `tokens` and `cost` from its renderer's `usage()` method, or from an adapter-level `usage()` if it has no renderer. The runner copies them onto the agent phase's manifest entry. A custom adapter should leave out any value it can't report, not estimate it.

The built-in JSONL renderer reads tokens from any of these:

- `tokens`, `total_tokens`, or `totalTokens`
- `input_tokens` plus `output_tokens`
- `prompt_tokens` plus `completion_tokens`

It reads cost from `cost`, `total_cost`, `totalCost`, or `total_cost_usd` on the event, on its `usage`, or on its nested `result.usage`. The last recognized value wins, so an engine's final cumulative event should be the authoritative one.

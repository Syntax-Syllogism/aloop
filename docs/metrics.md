---
title: Cost and quality metrics
description: Inspect saved-run usage, convergence, and reviewer measurements.
---

# Cost and quality metrics

aloop derives measurements on demand from the phase entries in each saved
`manifest.json`. It does not maintain a separate aggregate database or rollup
file. A run can therefore be inspected after it stalls, and read-only
operations remain useful even if the current executable pipeline configuration
is no longer valid.

## CLI operations

The read-only commands use the configured `runsDir` (default:
`.loop/runs`) and do not modify a run:

```sh
aloop status <name>
aloop inspect <name> [--json]
aloop list [--metrics] [--json]
aloop metrics [--json]
```

`status` shows one run's status, phase, duration, token and cost totals, and
reviewer catch rate. `inspect` adds the saved manifest phase entries. `list`
shows saved runs; add `--metrics` for duration, token, and cost columns (or
per-run metrics in JSON). `metrics` aggregates every saved manifest. Add
`--json` whenever a script needs the complete machine-readable result; without
it, the commands print a compact human-readable summary.

Read-only commands accept `--config` to locate a non-default `runsDir`. They
read only that setting, so `status`, `inspect`, `list`, and `metrics` can still
inspect saved runs when the same config contains an invalid or incomplete
pipeline definition.

## Metric meanings

Per-run JSON contains `total`, `phases`, `convergence`, `reviewer`, and
`stalled` fields. `phaseMetrics` is an alias of `phases` for consumers that use
the longer name. Phase summaries include entry and attempt counts, completed
and stalled counts, `stallRate`, `durationMs`, `tokens`, and `cost`.

The run-level measurements are:

- `total.durationMs` sums all non-skipped phase actions, including gates.
- `total.tokens` and `total.cost` sum reported model usage from non-gate phase
  actions. Gate entries do not report model usage and are excluded from these
  totals.
- `total.usageCoverage` reports the number of usage-applicable entries and the
  token/cost reporting counts and fractions.
- `convergence.roundsToApproval` (also exposed as `roundsToConverge`) is the
  first review round with an `APPROVED` verdict. The object also reports
  whether the run converged, observed review rounds, and the approval-round
  distribution.
- `reviewer.catchRate` is the fraction of review rounds with
  `CHANGES_REQUESTED`. `findingsCleared` counts the decrease in blocking
  findings between adjacent review rounds, and `findingsClearedPerRound`
  divides that count by repair rounds.
- `stalled` lists phases with at least one stalled entry.

Cross-run `metrics` output adds `runs`, aggregate phase summaries, a
`convergenceRate`, average rounds to convergence, distributions, reviewer
totals, and `runMetrics` containing each run's metrics.

Budget-stall bookkeeping entries are excluded from usage-applicable entries.
This keeps a recorded budget stop from turning an otherwise complete token or
cost total into `null`.

## Unknown usage

Usage is best-effort and engine-neutral. A finite numeric value is required for
an entry to contribute to a token or cost sum. If no applicable entries report
a value, or any applicable entry is missing that value, the corresponding
total is `null` rather than an estimate. Cross-run totals are also `null` when
any run lacks the corresponding complete total. `durationMs` remains available
independently, and `usageCoverage` shows how much data was reported.

The human-readable commands print `?` for `null` or missing values.

## Usage capture

An adapter can return normalized numeric `tokens` and/or `cost` from its
renderer’s `usage()` method, or from an adapter-level `usage()` method when no
renderer is used. The runner copies those values to the agent phase's manifest
entry. A custom adapter should omit a value it cannot report instead of
estimating it.

The built-in JSONL renderer recognizes a finite numeric token value from
`tokens`, `total_tokens`, `totalTokens`, `input_tokens` plus
`output_tokens`, or `prompt_tokens` plus `completion_tokens`. It recognizes
cost from `cost`, `total_cost`, `totalCost`, or `total_cost_usd` on the event,
its `usage`, or its nested `result.usage`. The final recognized value wins, so
an engine's final cumulative event should be the authoritative one.

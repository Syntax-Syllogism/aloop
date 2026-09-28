---
title: Operational run commands
description: Inspect, replay, cancel, clean up, diagnose aloop runs, and run local quality checks.
---

# Operational run commands

The operational subcommands read the persisted run state in the repository's
configured `runsDir` (default: `.loop/runs`). Run them from the repository or
one of its subdirectories. Use `--config path/to/loop.config.mjs` when the run
uses a configuration file outside the repository; the path is resolved from
the current directory.

All operational commands support `--json` for machine-readable output. When no
explicit configuration file is supplied, an absent `loop.config.mjs` uses the
package defaults. A configuration file that exists but cannot be imported is
reported as an error instead of silently falling back to the defaults.

## Inspecting runs

```sh
aloop list
aloop status my-spec
aloop inspect my-spec
```

`list` shows persisted runs newest first with their name, derived status,
current phase, branch, update time, and pull-request URL when one was recorded.
`status` prints the same summary for one run, including when that phase started.
`inspect` adds the run directory,
full saved state and manifest in JSON mode, or per-phase evidence in human
mode, including input/output SHAs, prompt and configuration hashes, engine,
verdicts, gate receipts, and artifact paths.

The derived status can be `running`, `interrupted`, `completed`, `stalled`,
`cancelled`, or `unknown`. A live lock or active command is reported as
`running`, which helps avoid treating a process that is still shutting down as
a stale run. A persisted `running` state with no live runner or command is
reported as `interrupted`; resume it with `aloop --name <name> --resume`, or
use `aloop cancel <name>` to mark it cancelled.

## Watching runs

`watch` polls one or more repositories and writes one compact NDJSON object per
observed change. It writes no run output or manifest contents. Polling defaults
to every 15 seconds; set `--interval` to at least 1 second. Changes that begin
and end between polls are coalesced, so only the net state is reported.

```sh
# Stream changes from multiple repositories
aloop watch --repo ../warden-core --repo ../warden-app

# Wake a caller after the next status-related change, with an idle limit
aloop watch --once --timeout 30m --only status --repo ../warden-app

# Include a snapshot so changes between starting aloop and watch are visible
aloop watch --initial --repo .
```

Positional run names restrict events to matching run slugs. `--repo` is
repeatable and defaults to the current directory. `--config` applies to each
repository. `--only status` suppresses phase-only events. `--initial` writes a
`snapshot` event for every run found on the first poll; snapshots do not end
`--once` or reset its idle timeout.

Every line has a `type` and UTC `at` timestamp. Event types are:

| Type | Meaning | `from` / `to` |
| --- | --- | --- |
| `snapshot` | Existing run included by `--initial` | `null` |
| `appeared` | Run first observed after startup | `null` |
| `removed` | Previously observed run disappeared | `null` |
| `status` | Derived status changed; carries the latest phase | Previous / current status |
| `phase` | A new phase or sub-phase started without a status change | Previous / current phase |
| `timeout` | Idle timeout elapsed | Not applicable |

Run events include `repo`, `name`, `status`, `currentPhase`, `phaseStartedAt`, `verdict`,
`gateStatus`, `branch`, `prUrl`, and `runDir`. A stalled run includes only its
phase and a reason truncated to 300 characters. Status and phase changing in
the same poll produces one `status` event. Reviewers and repair phases appear
under their own names, including transitions back to review or gate on later
attempts. A phase that starts and finishes between polls may be missed; changing
only `phaseStartedAt` does not emit a new event. Runs created before phase entry
was recorded report the last non-skipped manifest phase (completed or stalled)
with a null `phaseStartedAt`. A timeout line includes `idleMs`.

Exit codes are `0` for a `--once` event or a clean signal exit, `1` for startup
errors, and `2` when `--timeout` elapses. Without `--once` or `--timeout`, the
command streams until stopped. For example, a background caller can invoke
`aloop watch --once --timeout 20m --only status --repo <repo>` and start it
again after each event; this keeps the monitor asleep between changes.

`aloop watch --initial` provides a race-free starting snapshot: start the
watcher before launching runs, then consume both the initial state and later
events from the same process.

## Replaying recorded evidence

```sh
aloop replay my-spec
aloop replay my-spec --json
```

`replay` is a dry, read-only reconstruction: it never invokes an agent or
changes the recorded run. Its JSON timeline retains each phase's status, input
and output SHAs, verdicts, gate receipts, and prompt-verification result. The
human-readable view prints a one-line phase summary; use `--json` when an
audit or automation needs the full evidence fields.

For each new-format agent entry, replay re-renders the saved template body with
the exact saved variables and applicable operator note, then compares the
resulting SHA-256 with `promptHash`. A result is `verified`, `mismatch`, or
`unverifiable`; older entries that did not retain prompt inputs are
`unverifiable`, rather than treated as verified from their hash alone.

Replay also reports divergences without failing solely because the evidence has
aged or been tampered with. These include a missing snapshot, unavailable
recorded base commit or worktree, a configuration-hash inconsistency, and a
prompt-hash mismatch. The command reports availability; it does not recreate a
worktree, restore a commit, or make a live re-run.

## Cancelling an active run

```sh
aloop cancel my-spec
aloop cancel my-spec --json
```

`cancel` applies only to an active run. It stops the currently recorded command
and its process group where the platform supports process groups, then stops
the runner, records `status: "cancelled"` and `cancelReason: "cancelled by
operator"`, and releases the run lock. If termination does not complete, the
command fails and retains the lock so a still-running process cannot be
mistaken for a cancelled run. Cancellation preserves the run directory,
manifest, logs, and worktree for inspection.

## Cleaning completed runs

```sh
aloop clean
aloop clean --older-than 14
aloop clean --older-than 14 --yes
aloop clean --older-than 14 --dry-run --json
```

`clean` considers only runs whose derived status is `completed` and whose
`updatedAt` (falling back to `startedAt`) is at least the requested number of
days old. The default threshold is 30 days. Without `--yes`, it previews the
candidates and makes no changes; `--dry-run` explicitly requests the same
preview behavior. `--yes` removes each candidate's run directory and, when it
is an external worktree, removes that worktree through Git first. Running
`clean` never removes active, stalled, cancelled, or unknown runs.

## Diagnosing local prerequisites

```sh
aloop doctor
aloop doctor --config ./loop.config.mjs --json
```

`doctor` validates the configuration, checks that Git and Git worktree support
are available, checks the executable for every agent engine used by the
configured phases, and checks GitHub CLI authentication with `gh auth status`.
It exits unsuccessfully when any check fails. The command reports all checks so
a missing engine or GitHub CLI is visible before a run reaches the affected
phase. The current doctor command does not select a backend-specific CLI; for a
GitLab publish, verify `glab auth status` manually. The publish phase performs
its own GitLab host-aware authentication precheck before pushing.

Operational commands resolve runs from the repository root and the configured
`runsDir`, so using a different current subdirectory does not create a second
run inventory.

## Checking static contracts

```sh
npm run typecheck
```

This performs TypeScript's strict, no-emit JSDoc check over the configured
source, CLI, and test files. It is the focused validation for changes to
`src/types.d.ts`, JSDoc type imports, or JavaScript covered by the checker, and
it runs in CI before the test suite. See [Architecture and module
boundaries](architecture.md#static-contracts) for the ownership and opt-out
rules for those contracts.

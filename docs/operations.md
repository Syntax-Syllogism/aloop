---
title: Operational run commands
description: Inspect, replay, cancel, clean up, diagnose aloop runs, and run local quality checks.
---

# Operational run commands

These subcommands read the saved run state in the repository's `runsDir` (default `.loop/runs`). Run them from the repository or any subdirectory. If the run uses a config file outside the repository, pass `--config path/to/loop.config.mjs`. The path is resolved from the current directory.

Every operational command supports `--json`. If you don't pass a config file and there's no `loop.config.mjs`, the package defaults apply. A config file that exists but can't be imported is an error, not a silent fallback to defaults.

Commands find runs from the repository root and the configured `runsDir`, so running from a different subdirectory doesn't create a second run inventory.

## Inspecting runs

```sh
aloop list
aloop status my-spec
aloop inspect my-spec
```

- `list` shows saved runs, newest first: name, derived status, current phase, branch, update time, and the pull-request URL if one was recorded.
- `status` prints the same summary for one run, including when the current phase started.
- `inspect` adds the run directory. In JSON mode it includes the full saved state and manifest. In human mode it prints per-phase evidence: input and output SHAs, prompt and configuration hashes, engine, verdicts, gate receipts, and artifact paths.

The derived status is one of `running`, `interrupted`, `completed`, `stalled`, `cancelled`, or `unknown`.

- A live lock or active command counts as `running`, so a process that's still shutting down isn't mistaken for a stale run.
- A saved `running` state with no live runner or command is `interrupted`. Resume it with `aloop --name <name> --resume`, or mark it cancelled with `aloop cancel <name>`.

## Watching runs

`watch` polls one or more repositories and writes one compact NDJSON object for each change it sees. It never writes run output or manifest contents. It polls every 15 seconds by default. Use `--interval` to change that, with a minimum of 1 second. A change that starts and ends between polls is coalesced, so only the net state is reported.

```sh
# Stream changes from multiple repositories
aloop watch --repo ../warden-core --repo ../warden-app

# Wake a caller after the next status-related change, with an idle limit
aloop watch --once --timeout 30m --only status --repo ../warden-app

# Include a snapshot so changes between starting aloop and watch are visible
aloop watch --initial --repo .
```

- Positional run names limit events to matching run slugs.
- `--repo` can be repeated and defaults to the current directory. `--config` applies to each repository.
- `--only status` hides phase-only events.
- `--initial` writes a `snapshot` event for every run found on the first poll. Snapshots don't end `--once` or reset its idle timeout.

Every line has a `type` and a UTC `at` timestamp:

| Type | Meaning | `from` / `to` |
| --- | --- | --- |
| `snapshot` | An existing run, included by `--initial` | `null` |
| `appeared` | A run first seen after startup | `null` |
| `removed` | A previously seen run disappeared | `null` |
| `status` | Derived status changed. Carries the latest phase. | Previous / current status |
| `phase` | A new phase or sub-phase started with no status change | Previous / current phase |
| `timeout` | The idle timeout elapsed | Not applicable |

Run events include `repo`, `name`, `status`, `currentPhase`, `phaseStartedAt`, `verdict`, `gateStatus`, `branch`, `prUrl`, and `runDir`. A stalled run includes only its phase and a reason cut to 300 characters. A timeout line includes `idleMs`.

Details worth knowing:

- If status and phase both change in one poll, you get a single `status` event.
- Reviewers and repair phases appear under their own names, including moves back to review or gate on later attempts.
- A phase that starts and finishes between polls may be missed. A change to `phaseStartedAt` alone emits nothing.
- Runs created before phase entries were recorded report the last non-skipped manifest phase (completed or stalled), with a null `phaseStartedAt`.

Exit codes: `0` for a `--once` event or a clean signal exit, `1` for startup errors, and `2` when `--timeout` elapses. Without `--once` or `--timeout`, the command streams until you stop it. A background caller can run `aloop watch --once --timeout 20m --only status --repo <repo>` and restart it after each event. That keeps the monitor idle between changes.

To avoid missing early changes, start `aloop watch --initial` before launching runs. You then get the initial state and all later events from one process.

## Replaying recorded evidence

```sh
aloop replay my-spec
aloop replay my-spec --json
```

`replay` rebuilds a run's history from what was recorded. It's read-only: it never calls an agent and never changes the run. The JSON timeline keeps each phase's status, input and output SHAs, verdicts, gate receipts, and prompt-verification result. The human view prints a one-line summary per phase. Use `--json` when you need the full evidence.

For each new-format agent entry, replay re-renders the saved template body with the exact saved variables and any operator note, then compares the SHA-256 of the result with `promptHash`. The outcome is `verified`, `mismatch`, or `unverifiable`. Older entries that didn't save their prompt inputs are `unverifiable`. Their hash alone is never treated as proof.

Replay also reports divergences, without failing just because evidence is old or was tampered with. These include a missing snapshot, an unavailable base commit or worktree, a configuration-hash mismatch, and a prompt-hash mismatch. It only reports what's available. It doesn't recreate a worktree, restore a commit, or re-run anything.

## Cancelling an active run

```sh
aloop cancel my-spec
aloop cancel my-spec --json
```

`cancel` works only on an active run. It stops the recorded command, and its process group where the platform supports one. Then it stops the runner, records `status: "cancelled"` and `cancelReason: "cancelled by operator"`, and releases the run lock. If termination doesn't finish, the command fails and keeps the lock, so a process that's still running can't be mistaken for a cancelled one. The run directory, manifest, logs, and worktree are kept for inspection.

## Cleaning completed runs

```sh
aloop clean
aloop clean --older-than 14
aloop clean --older-than 14 --yes
aloop clean --older-than 14 --dry-run --json
```

`clean` considers only runs with derived status `completed` whose `updatedAt` (or `startedAt` if that's missing) is at least the given number of days old. The default is 30 days.

Without `--yes`, it previews the candidates and changes nothing. `--dry-run` asks for the same preview explicitly. With `--yes`, it removes each candidate's run directory. If the run has an external worktree, that's removed through Git first. `clean` never touches active, interrupted, stalled, cancelled, or unknown runs.

## Diagnosing local prerequisites

```sh
aloop doctor
aloop doctor --config ./loop.config.mjs --json
```

`doctor` checks that:

- the configuration is valid;
- Git and Git worktree support are available;
- the executable exists for every agent engine your phases use;
- the GitHub CLI is signed in (`gh auth status`).

It reports every check, so a missing engine or CLI shows up before a run reaches the affected phase. It exits with a failure if any check fails. It doesn't yet pick a backend-specific CLI. For GitLab publishing, check `glab auth status` yourself. The publish phase also does its own host-aware GitLab authentication check before pushing.

## Checking static contracts

```sh
npm run typecheck
```

This runs TypeScript's strict, no-emit JSDoc check over the source, CLI, and test files. Use it after changing `src/types.d.ts`, JSDoc type imports, or any JavaScript the checker covers. CI runs it before the tests. See [Architecture and module boundaries](architecture.md#static-contracts) for who owns those contracts and how to opt out.

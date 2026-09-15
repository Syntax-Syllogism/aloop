---
title: Run state and recovery
description: How aloop persists, protects, and resumes a run.
---

# Run state and recovery

For every real run, aloop stores durable artefacts in
`.loop/runs/<slug>/` in the source repository, rather than in the isolated
worktree. This makes a stalled run inspectable and resumable even when its
worktree is later moved or removed. The directory should be ignored by Git.

## Artefacts

`state.json` is the runner's checkpoint. It records the run identity, completed
phases, review-loop progress, resolved branch and worktree, and other values
needed to resume the same run. `manifest.json` records the resolved task,
branch, repository, and worktree context once planning has completed, followed
by one entry for each phase invocation. Logs, verdicts, and repair responses
are stored alongside them. The `pr-description` phase writes `pr.md` in the
run directory; a successful `publish` phase records the verified PR URL and
metadata in the manifest and state. The manifest metadata points to
`snapshot.json`.

`snapshot.json` is the immutable start-of-run reproducibility record. It stores
the base revision, resolved configuration, gate definitions, environment, and
engine versions captured at startup. Its `promptHashes` field points to
`manifest.json` with the selector `phases[*].promptHash`; this keeps the
snapshot tied to the hashes rendered for each actual invocation, including
repairs and later review rounds.

While setup, a gate, or an agent command is running, `active-command.json`
records the child PID and, on platforms with process groups, its process-group
ID. It is removed when the command exits or fails. This transient record lets
`aloop cancel` terminate the command tree and lets resume protection detect a
command that is still alive even if the runner's lock owner has already
stopped.

`state.json` and `manifest.json` contain `schemaVersion` (currently `1`) and
are written by replacing a completed temporary file. A crash during a write
therefore leaves the previous complete file available; an abandoned `.tmp`
file is not treated as the current checkpoint. `snapshot.json` uses
`snapshotVersion` (currently `1`) and is written with the same atomic
replacement. The snapshot is written once and is not replaced when a run
resumes.

Runs created before schema versioning, whose state or manifest JSON has no
`schemaVersion`, are read as version 1. Other older versions, future versions,
and non-integer versions are rejected rather than being interpreted
incorrectly.

## Starting and resuming

The slug derived from `--name` or `--task-file` identifies the run directory.
A normal run refuses to reuse a directory that already contains a state or
manifest; use a new name for a new run. Use `--resume` only to continue the
existing run:

```sh
aloop --name my-spec --resume
```

Each run also has a generated `runId`, which links its state and manifest. The
guard against non-resumed slug reuse prevents one run's logs and checkpoint
from being silently mixed with another's.

Budget stalls are recorded in `manifest.json` and leave the run stalled. A
stall at a phase or repair boundary resumes before that work is invoked again;
an unchanged limit therefore stalls again without spending more usage. When
the final configured phase completes and its post-phase check finds an
exhausted budget, `state.json` records that phase as complete with
`budgetExhausted: true`. Resuming with the unchanged limit still stops, while
raising the limit lets aloop clear the marker and finalize the run without
rerunning the completed final action. See [Run budgets](loop.md#run-budgets)
for configuration and enforcement details.

## Concurrent-run protection

Real runs acquire a single-host lock in their run directory before loading or
changing state. A second process targeting the same slug fails fast and reports
the owner PID. Wait for that process to finish; if it has crashed, rerun the
command and aloop will recover the stale lock after confirming that PID is no
longer alive.

Lock publication and stale-lock takeover are race-safe. An interrupted initial
lock publication can be recovered, but a malformed or unreadable lock fails
closed so two runners cannot proceed on uncertain ownership. Locks are released
when the run completes and on the normal process-exit path. This is advisory
protection for processes on one host, not a distributed lock.

`--dry-run` is read-only: it creates neither run metadata nor a lock.

## Operational recovery

Use [`Operational run commands`](operations.md) to inspect persisted evidence
without starting a phase:

```sh
aloop list
aloop status my-spec
aloop inspect my-spec
```

An active run can be stopped with `aloop cancel <name>`. Cancellation waits for
the recorded command and runner to stop before recording `status: "cancelled"`
and releasing the lock, while retaining the run directory and worktree for
inspection. Completed run directories can be previewed and removed with
`aloop clean`; cleanup also removes an external worktree associated with a
selected completed run. It never selects active, stalled, cancelled, or
unknown runs.

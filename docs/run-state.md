---
title: Run state and recovery
description: How aloop persists, protects, and resumes a run.
---

# Run state and recovery

Every real run saves durable artefacts in `.loop/runs/<slug>/` in the source repository, not in the isolated worktree. A stalled run stays inspectable and resumable even if its worktree is later moved or removed. Keep this directory out of Git.

## Artefacts

**`state.json`** is the runner's checkpoint. It records:

- the run identity and completed phases;
- review-loop progress;
- the resolved branch and worktree;
- the chosen prompt preset and the directory its paths were resolved from;
- anything else needed to resume the same run.

A saved preset is reused on `--resume`, and a conflicting `--preset` is rejected. See the [loop guide](loop.md#configuration) for selection and precedence.

`currentPhase` and `phaseStartedAt` record the phase or sub-phase most recently entered and its UTC start time. The runner updates them before each top-level phase, review agent, repair agent, or gate attempt starts. They stay in state after completion, a stall, or a crash, so the last active phase remains visible. Older runs without these fields fall back to the last non-skipped manifest entry. That entry is the last phase completed or stalled, which may not be the one running now, and its `phaseStartedAt` is `null`.

**`manifest.json`** records the resolved task, branch, repository, and worktree once planning is done, then one entry per phase invocation. Logs, verdicts, and repair responses are stored beside it. The `pr-description` phase writes `pr.md` in the run directory. A successful `publish` phase records the verified PR URL and metadata in the manifest and state. The manifest points to `snapshot.json`.

**`snapshot.json`** is the immutable record of how the run started. It stores the base revision, resolved configuration, gate definitions, environment, and engine versions. Its `promptHashes` field points to `manifest.json` with the selector `phases[*].promptHash`. That ties the snapshot to the hash of every prompt actually rendered, including repairs and later review rounds. New agent entries also keep the prompt template body, interpolation variables, and any operator note next to their hash. This lets `aloop replay` re-render and verify a recorded prompt without calling an engine. Older entries stay inspectable, but their prompts are unverifiable.

**`active-command.json`** exists while setup, a gate, or an agent command is running. It holds the child PID and, where process groups exist, the process-group ID. It's removed when the command exits or fails. `aloop cancel` uses it to terminate the command tree. Resume protection uses it to detect a command that's still alive even if the runner's lock owner has already stopped.

### Writes and versions

`state.json` and `manifest.json` carry a `schemaVersion` (currently `1`). Each is written by replacing a completed temporary file, so a crash mid-write leaves the previous complete file in place. An abandoned `.tmp` file is never treated as the checkpoint. `snapshot.json` uses `snapshotVersion` (currently `1`) with the same atomic replacement. It's written once and not replaced on resume.

State or manifest files from before schema versioning, with no `schemaVersion`, are read as version 1. Other older versions, future versions, and non-integer versions are rejected instead of being misread.

## Starting and resuming

The slug from `--name` or `--task-file` identifies the run directory. A normal run refuses to reuse a directory that already has a state or manifest, so use a new name for a new run. Use `--resume` only to continue an existing one:

```sh
aloop --name my-spec --resume
```

Each run also gets a generated `runId` that links its state and manifest. The guard against reusing a slug without `--resume` keeps one run's logs and checkpoint from being mixed with another's.

### Budget stalls

Budget stalls are recorded in `manifest.json` and leave the run stalled. A stall at a phase or repair boundary resumes before that work is invoked again, so an unchanged limit stalls again without spending more.

If the final configured phase completes and the post-phase check finds the budget exhausted, `state.json` records that phase as complete with `budgetExhausted: true`. Resuming with the same limit still stops. Raising the limit lets aloop clear the marker and finish the run without repeating the completed final action. See [Run budgets](loop.md#run-budgets).

### Repair rounds

When a repair-enabled standalone gate fails, its pending repair round is checkpointed in `state.json`. The manifest keeps the failed and re-run gate receipts, repair entries, and their input and output SHAs separately. A later successful attempt is therefore evidence of the repaired tree, not a replacement for the original failure.

### Commit-required phases

Agent phases that must commit save their first-attempt `HEAD` in `state.json` under `phaseBaselines`. The baseline is reused across resumes. Say a phase stalled because it made no commit, and you later create a clean commit yourself. `--resume` sees that `HEAD` has moved past the baseline, records the phase as completed, and skips another agent call. The completion entry records the saved baseline as `inputSha` and the current `HEAD` as `outputSha`.

`--resume --from <phase>` reruns that phase even without a note. It invalidates that phase and all later ones, then captures a new baseline.

## Concurrent-run protection

Real runs take a single-host lock in their run directory before loading or changing state. A second process aimed at the same slug fails immediately and reports the owner's PID. Wait for that process to finish. If it crashed, rerun the command. aloop takes over the stale lock once it confirms the PID is gone.

Lock creation and stale-lock takeover are race-safe. An interrupted initial lock write can be recovered. A malformed or unreadable lock fails closed, so two runners never proceed with uncertain ownership. Locks are released when the run completes and on normal process exit. This protects processes on one host. It's not a distributed lock.

`--dry-run` is read-only. It creates no run metadata and no lock.

## Recovery

Use the [operational run commands](operations.md) to inspect saved evidence without starting a phase:

```sh
aloop list
aloop status my-spec
aloop inspect my-spec
aloop watch --initial
```

A saved `status: "running"` with no live runner or active command is derived as `interrupted`. That means the runner was lost to a kill, crash, or reboot. Continue it with `aloop --name my-spec --resume`, or record a cancellation with `aloop cancel my-spec` if you don't want to resume. `aloop watch` reports this derived status so an external monitor can react.

To stop an active run, use `aloop cancel <name>`. It waits for the recorded command and runner to stop, then records `status: "cancelled"` and releases the lock. The run directory and worktree stay for inspection.

To clear out finished runs, preview and remove them with `aloop clean`. It also removes the external worktree of each selected completed run. It never selects active, interrupted, stalled, cancelled, or unknown runs.

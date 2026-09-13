# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.5.0] - 2026-09-12

### Added

- Config-registered engine adapters for customizing loop execution environments
- Worktree setup with automatic no-op detection
- Lean prompts and work-item preset templates
- Optional task input parameter to decouple from work-item operations
- Complete configuration overrides for flexible behavior customization
- Audited resume engine overrides for workflow control
- Configurable base branch support for multi-branch operations
- Per-phase commits with configurable AI model and effort levels

### Fixed

- Standalone public package history export
- Task context inclusion in AI review prompts
- Piped input safety with explicit confirmation requirements
- Worktree stability on dirty git states
- Wiki commit preservation with cron scheduling
- Output streaming for long-running phases to prevent false hang detection

## [Unreleased]

---

## Pre-extraction history

History from before the standalone extraction (changesets format), preserved for reference.


## 0.4.6

### Patch Changes

- 1eac189: Fix the `agy` engine adapter so it works in the loop's headless runs. Pass
  `--dangerously-skip-permissions` — agy has no non-interactive `auto` permission
  mode, so without it agy auto-denies the first command tool and exits 0 having
  done nothing, and the phase is wrongly marked complete. Also switch agy to
  `--output-format stream-json` with a renderer for its `init`/`step_update`/
  `result` events, so a multi-minute phase streams readable progress instead of
  buffering every byte until exit and looking like a hang.

## 0.4.5

### Patch Changes

- 35b961b: Stall the git phase deterministically when the worktree is dirty.

  The `git` phase pushes and opens a PR and is forbidden from committing, yet it ran as an unbounded agent. When an earlier phase left the tree dirty, the agent — told the tree was already clean — improvised an uncommittable "fix" and spun until its per-command timeout. The runner now asserts a clean worktree before any phase flagged `requiresCleanTree` (the built-in `git` phase) and stalls with the offending paths instead, and the git prompt tells the agent to stop and report rather than reconcile a dirty tree. The check is worktree cleanliness only: unresolved review findings deliberately do not block, so a clean tree with open findings can still be resumed through `docs` and `git`.

## 0.4.4

### Patch Changes

- c522a34: Allow `aloop --config <path>` to load an external loop configuration,
  including as a complete configuration override when resuming a run.
- c88fce3: Stop asking agents to commit wiki work items, move new work items to `IN PROGRESS`
  at the start of implementation, and constrain loop status instructions to the
  supported `TODO`, `IN PROGRESS`, `UNDER REVIEW`, and `DONE` values.

## 0.4.3

### Patch Changes

- a5540e2: Allow `aloop --config <path>` to load an external loop configuration,
  including as a complete configuration override when resuming a run.
- 0b74814: Checkpoint the owed repair when a review hits the round cap.

  Previously, a `CHANGES_REQUESTED` verdict on the final allowed round was not recorded as a pending repair, so the last review's findings were left unaddressed with no checkpoint. Resuming with a raised `--max-rounds` then started with a fresh review of the identical tree instead of running the `address` phase, burning a review round re-discovering the same findings. The repair is now checkpointed at the cap, so a resume runs the owed `address` phase before re-reviewing. Resuming without raising the cap stays a clean no-op.

- 4800fb5: Add an explicit `--override-engine` option to move a resumed run to a different
  agent executable while recording the change in run state and phase logs.

## 0.4.2

### Patch Changes

- 97de439: Checkpoint the owed repair when a review hits the round cap.

  Previously, a `CHANGES_REQUESTED` verdict on the final allowed round was not recorded as a pending repair, so the last review's findings were left unaddressed with no checkpoint. Resuming with a raised `--max-rounds` then started with a fresh review of the identical tree instead of running the `address` phase, burning a review round re-discovering the same findings. The repair is now checkpointed at the cap, so a resume runs the owed `address` phase before re-reviewing. Resuming without raising the cap stays a clean no-op.

## 0.4.1

### Patch Changes

- a091002: Stop Claude phases from stalling silently.

  - Run the Claude engine in `auto` permission mode instead of `acceptEdits`. A non-interactive `claude -p` run has nobody to answer a permission prompt, so under `acceptEdits` every Bash call was denied and the implement, gate-repair, docs, and git phases could not build, test, or commit.
  - Ask Claude for `stream-json` output and render it to readable progress lines. `--output-format text` withheld every byte until the process exited, so a phase that ran for half an hour was indistinguishable from one that had hung.
  - Raise the default per-command timeout from 30 to 60 minutes; a real implement phase routinely runs past the old cap and was killed mid-edit.

## 0.4.0

### Minor Changes

- 8f2421f: Add `--base-branch` to build and PR a run on top of another branch, for stacked PRs.

## 0.3.0

### Minor Changes

- 903d17c: Allow loop engine configuration to select an optional model and reasoning effort
  per phase, preserve those effective settings when a run resumes, and display
  them in dry-run output and phase logs. Existing string-based engine settings
  remain supported.
- 903d17c: Commit implementation, repair, and documentation phases independently and use
  review commit SHAs to resume incremental verdict rounds.

## 0.2.0

### Minor Changes

- 3eb19c2: Add `@syntax-syllogism/aloop`, an engine-agnostic agentic loop runner.

  `aloop` drives a work item through implementation, a deterministic gate, a
  capped review/repair loop, a documentation pass, and the git workflow, stopping
  at an open pull request. Control flow, iteration caps, and exit conditions live
  in the driver; agents only supply judgment.

  - Engine adapters for `claude`, `codex`, and `agy`, selectable per phase, so the
    reviewer can run on a different model family than the implementer.
  - Phases are declared as a flat list and folded into a loop: a verdict phase
    absorbs the repair phases after it and the gate before it.
  - The review phase emits a machine-readable verdict. Parsing fails closed, and
    the loop will not exit on approval while the gate re-check is red.
  - Runs are isolated in a `git worktree`, with logs, verdicts, and resumable
    state under `.loop/runs/<slug>/`.
  - Only the `git` phase commits; earlier phases leave work uncommitted in the
    worktree, so the reviewer reads the working tree rather than a branch range.
  - `remote` selects the push target and is validated before the run starts,
    rather than assuming `origin` in repos with several remotes.
  - Prompts ship with the package and are overridable per phase from
    `.loop/prompts/` in the consuming project.

---
title: Architecture and module boundaries
description: How aloop separates CLI composition, phase execution, policy, reporting, and worktree lifecycle concerns.
---

# Architecture and module boundaries

aloop keeps deterministic workflow control in the driver and delegates judgment
to configured agent CLIs. The public CLI behavior, configuration, phase
contracts, and persisted run artefacts are documented in the other guides; this
page describes the source-level boundaries that maintain that behavior.

## Pipeline orchestration

`src/pipeline.mjs` is the composition root. It parses and validates a run,
loads configuration and saved state, creates the shared run context, and wires
the concrete operations used to execute phases. It also retains the
implementation-specific agent, gate, review-repair, manifest, and budget
operations that the runner invokes.

`src/runner.mjs` owns the phase workflow. Given normalized phase descriptors
and injected operations, it handles phase selection and resume skipping,
interactive confirmation, clean-tree and publishing guards, retries, verdict
and repair rounds, checkpoints, and completion or stall reporting. Keeping this
control flow independent of the concrete operations makes descriptor-driven
workflow changes easier to reason about without moving CLI setup or persistence
details.

## Deterministic policy

`src/policy.mjs` contains decisions that must remain deterministic rather than
being left to an agent prompt:

- whether a configured phase may be skipped interactively;
- agent-phase postconditions such as a clean tree, an advanced or unchanged
  `HEAD`, and a repair rebuttal when required; and
- the publication attestation that binds the current `HEAD` to a preceding
  passing gate and an approved review.

The user-facing rules and failure behavior are in [Agentic loop
runner](loop.md#phases) and [Publishing](publishing.md), which are the sources
of truth when changing a workflow contract.

## Commands, terminal interaction, and worktrees

`src/command.mjs` owns child-process invocation, output capture, timeout
termination, active-process bookkeeping, and platform-specific executable
resolution. The supported host behavior is documented in [Platform
support](platform.md).

`src/reporter.mjs` owns terminal-facing concerns: progress banners, phase and
summary formatting, terminal confirmation input, and final reporting. It does
not decide which phases execute.

`src/worktree.mjs` owns worktree planning, creation, and resume validation. It
checks a saved worktree through Git before resuming rather than silently
substituting another checkout. The persisted-worktree and recovery contract is
documented in [Run state and recovery](run-state.md).

## Related components

The surrounding modules provide the boundaries used by the orchestration layer:
configuration normalization (`src/config.mjs`), hermetic runtime policy
(`src/hermetic.mjs`), agent adapters (`src/adapters.mjs`), Git operations
(`src/git.mjs`), prompts (`src/prompts.mjs`), durable state (`src/state.mjs`),
and review verdicts (`src/verdict.mjs`). Consult the focused operational guides
before changing their externally visible contracts:

- [Agentic loop runner](loop.md) for configuration, phase descriptors, prompts,
  and the manifest.
- [Hermetic phase execution](hermetic.md) for runtime wrapping, mounts, network
  policy, environment forwarding, and the snapshot contract.
- [Run state and recovery](run-state.md) for state, locking, and resumption.
- [Publishing](publishing.md) for PR-description and publish guarantees.
- [Operational run commands](operations.md) and [Cost and quality
  metrics](metrics.md) for persisted-run consumers.

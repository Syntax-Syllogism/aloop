---
title: Architecture and module boundaries
description: How aloop separates CLI composition, phase execution, policy, reporting, and worktree lifecycle concerns.
---

# Architecture and module boundaries

The driver controls the workflow deterministically. Configured agent CLIs supply the judgment. Other guides cover the public CLI, configuration, phase contracts, and saved run artefacts. This page covers the source-level boundaries behind them.

## Pipeline orchestration

`src/pipeline.mjs` is the composition root. It parses and validates a run, loads configuration and saved state, builds the shared run context, and wires up the operations that execute phases. It also holds the implementation-specific agent, gate, review-repair, manifest, and budget operations.

`src/runner.mjs` owns the phase workflow. Given normalized phase descriptors and injected operations, it handles:

- phase selection and skipping on resume;
- interactive confirmation;
- clean-tree and publishing guards;
- retries, and verdict and standalone-gate repair rounds;
- checkpoints, and completion or stall reporting.

Because this control flow doesn't depend on the concrete operations, you can change the workflow through descriptors without touching CLI setup or persistence.

## Deterministic policy

`src/policy.mjs` holds decisions that must not be left to an agent prompt:

- whether a configured phase can be skipped interactively;
- agent-phase postconditions: a clean tree, `HEAD` advanced or unchanged as required, and a repair rebuttal when one is required;
- the publication attestation, which ties the current `HEAD` to a passing gate and an approved review.

The user-facing rules and failure behavior live in the [loop guide](loop.md#phases) and [Publishing](publishing.md). Treat those as the source of truth when you change a workflow contract.

## Commands, terminal, and worktrees

`src/command.mjs` runs child processes. It captures output, terminates on timeout, tracks active processes, and resolves executables per platform. See [Platform support](platform.md).

`src/reporter.mjs` handles everything the terminal sees: progress banners, phase and summary formatting, confirmation input, and the final report. It doesn't decide which phases run. Its `banner` and `log` calls go to whichever renderer is active, so other renderers plug in without `runner.mjs` or `pipeline.mjs` knowing which one is live:

- `src/tui.mjs` is the live dashboard described in the [loop guide](loop.md).
- `src/quiet.mjs` is the [quiet mode](loop.md#quiet-mode) renderer. It drops raw engine, gate, and setup output and prints phase transitions, `log` lines, and a periodic heartbeat.

`pipeline.mjs` picks at most one alternate renderer per run (quiet wins over the TUI) and stops it before the final `report`, which is always plain text.

`src/worktree.mjs` plans and creates worktrees and validates them on resume. It checks a saved worktree through Git instead of quietly substituting another checkout. See [Run state and recovery](run-state.md).

## Static contracts

The runtime is ESM JavaScript. `tsconfig.json` runs TypeScript in strict, no-emit mode, checking JSDoc across the production modules, CLI, and tests. Shared contracts live in `src/types.d.ts`. Import them in JSDoc with `import('./types.js')`. This adds no runtime dependency and no output.

Use the shared contracts for values that cross a module boundary: a phase descriptor, adapter, resolved configuration, run state, manifest entry, or review verdict. Keep local shapes local, and don't grow the shared file ahead of need. Files marked `// @ts-nocheck` are deliberately outside the checker while they're typed step by step. Don't remove the marker unless the file passes the strict check. `test/type-contracts.test.mjs` checks the contracts with valid examples and expected invalid assignments.

Run `npm run typecheck` after changing the shared declarations, JSDoc imports, or a checked file. CI runs it before the tests.

## Related modules

These modules support the orchestration layer:

- `src/config.mjs`: configuration normalization
- `src/hermetic.mjs`: hermetic runtime policy
- `src/adapters.mjs`: agent adapters
- `src/git.mjs`: Git operations
- `src/prompts.mjs`: prompts
- `src/state.mjs`: durable state
- `src/verdict.mjs`: review verdicts

Before you change a contract that users can see, read the matching guide:

- [Agentic loop runner](loop.md): configuration, phase descriptors, prompts, manifest.
- [Hermetic phase execution](hermetic.md): runtime wrapping, mounts, network policy, environment forwarding, snapshots.
- [Run state and recovery](run-state.md): state, locking, resuming.
- [Publishing](publishing.md): PR description and publish guarantees.
- [Operational run commands](operations.md) and [Cost and quality metrics](metrics.md): tools that read saved runs.

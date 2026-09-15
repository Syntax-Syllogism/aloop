---
title: aloop documentation
description: Guides for running implementation and review work through aloop's deterministic agent pipeline.
---

`@syntax-syllogism/aloop` runs a task through implementation, review,
documentation, and publishing phases without requiring a person to relay prompts
between agents. Its deterministic CLI owns the control flow while the agents
perform the work.

## Guides

- [Agentic loop runner](loop.md) — install and configure aloop, run a task,
  resume a stalled run, and understand the pipeline's phases and safeguards.
- [Platform support](platform.md) — supported host environments plus Windows
  Git Bash command execution, timeout cleanup, and terminal confirmation.
- [Hermetic phase execution](hermetic.md) — opt phases into container runtime
  isolation, network allow-lists, environment forwarding, and publish secrets.
- [Architecture and module boundaries](architecture.md) — navigate the
  deterministic driver's composition, phase execution, policy, reporting, and
  worktree responsibilities.
- [Publishing](publishing.md) — author the PR description and understand the
  driver's push, PR backend, and verification contract.
- [Cost and quality metrics](metrics.md) — inspect saved-run usage, duration,
  convergence, stall, and reviewer measurements from the CLI or JSON output.
- [Operational run commands](operations.md) — list, inspect, cancel, clean up,
  and diagnose persisted runs.
- [Run state and recovery](run-state.md) — understand durable run artefacts,
  resume protection, locking, and crash recovery.

---
title: aloop documentation
description: Guides for running implementation and review work through aloop's deterministic agent pipeline.
---

`@syntax-syllogism/aloop` runs a task through implementation, review, documentation, and publishing phases, so nobody has to copy prompts between agents. A deterministic CLI controls the flow, and the agents do the work.

## Guides

- [Agentic loop runner](loop.md): install and configure aloop, run a task, resume a stalled run, and learn the phases and safeguards.
- [Named agents](agents.md): select CLI personas, check requirements, and diagnose agent setup.
- [Platform support](platform.md): supported hosts, Windows modes, timeout cleanup, and terminal confirmation.
- [Hermetic phase execution](hermetic.md): run phases in containers, with network allow-lists, environment forwarding, and publish secrets.
- [Architecture and module boundaries](architecture.md): how the driver is put together, for contributors.
- [Publishing](publishing.md): write the PR description, and what the driver guarantees when it pushes and creates the PR.
- [Cost and quality metrics](metrics.md): usage, duration, convergence, stalls, and reviewer measurements for saved runs.
- [Operational run commands](operations.md): list, inspect, watch, replay, cancel, clean up, and diagnose runs, and run local quality checks.
- [Repeated-blocker judge](judge.md): the optional decision model that stops a review loop when blockers repeat, with its protocols, defaults, recipes, and overrides.
- [Run state and recovery](run-state.md): what a run saves, resume protection, locking, and crash recovery.
- [Evaluation harness](eval.md): run a task set across a model and config matrix and compare results.

---
title: Hermetic phase execution
description: Configure optional runtime isolation, network policy, environment forwarding, and publish credentials for aloop phases.
---

# Hermetic phase execution

Hermetic execution is an opt-in runtime boundary around individual phases. Host
execution remains the default. When enabled, aloop wraps an agent or gate
command in the configured container runtime, mounts only the paths required by
that phase, and records the resolved execution policy in the run evidence.

## Configuration

Set run-level defaults in `loop.config.mjs`, then opt phases in with
`hermetic: true` or a phase-specific object:

```js
export default {
  hermetic: {
    runtime: 'docker',
    image: 'ghcr.io/example/aloop-node:latest',
    network: [],
    env: ['CI'],
    secrets: [],
  },
  phases: [
    { name: 'implement', kind: 'agent', hermetic: true },
    { name: 'gate', kind: 'gate', commands: ['npm test'], hermetic: {
      network: ['registry-net'],
    } },
    { name: 'publish', kind: 'publish', hermetic: {
      secrets: ['GH_TOKEN'],
    } },
  ],
};
```

The run-level `hermetic` object only defines defaults; it does not enable
container execution. A phase set to `false`, or with no `hermetic` field, runs
on the host. An enabled phase must resolve an image. `network` and `networks`
are accepted as aliases; normalized configuration stores `networks`.

- `runtime` is the executable used to launch the container, such as `docker`
  or `podman`.
- `image` is required for an enabled phase.
- An empty `network`/`networks` list becomes runtime network `none`. Named
  networks are an explicit allow-list; `none` cannot be combined with another
  network.
- `env` contains host environment variable names that may be forwarded when
  present. Values are not copied into saved configuration or snapshots.
- `secrets` contains required host environment variable names. Missing secrets
  fail closed, and secrets may only be declared on the `publish` phase.

The runtime executable must be available to the host, and the image must be
available locally or pullable by that runtime. The image must contain the
executable and dependencies required by the selected agent adapter or gate
command. Custom adapters do not need a container-specific command format:
aloop wraps their returned command and arguments.

## Phase boundaries

For agent and gate phases, the runtime receives the command with its absolute
working directory unchanged, so the host paths are bind-mounted at the same
paths inside the container.

- A `write-worktree` agent receives the worktree read-write, plus its required
  run and task-file artifact directories read-write.
- A `read-only` agent receives the worktree read-only for inspection, a
  disposable read-only source snapshot, and writable run artifacts. This
  preserves the artifact-only behavior described in [Agentic loop
  runner](loop.md#phase-permissions).
- A gate receives the worktree read-only and the run directory read-write.
  Each configured gate command is wrapped separately.
- `setup` commands, operational subcommands, and the runtime launcher itself
  remain host processes.

The `publish` phase is driver-owned and is not run inside the configured
runtime. Its hermetic settings apply an environment allow-list to Git push,
remote-SHA verification, and the built-in GitHub `gh` or GitLab `glab` backend.
This is where declared publish credentials can be used without exposing them
to agent phases. In-process custom backend objects are rejected when hermetic
publish filtering is enabled because arbitrary backend code cannot be given a
reliable process-level credential boundary.

## Network and credential behavior

No network is available to an enabled agent or gate unless its phase declares a
runtime network. This is independent of the phase permission level: permissions
control mounted paths and worktree writes, while hermetic settings control the
runtime boundary and environment.

Only `PATH` and declared environment names are passed to a hermetic command.
Secret names are required to exist in the host environment before publish
starts, and only their values plus other declared environment values are
forwarded. Secret values are not written to logs, manifests, or snapshots.

## Run evidence

The immutable `snapshot.json` records the configured runtime, default image,
and each phase's enabled state and resolved runtime, image, network, environment,
and secret-name policies. Agent and gate manifest entries also include their
effective execution policy (`host` or the resolved hermetic settings). These
records describe the boundary without persisting environment values.

Hermetic settings are resolved when configuration loads and are retained by
the run snapshot for resume and audit. Changing the configuration does not
rewrite an existing snapshot; use the documented resume configuration override
when intentionally changing a saved run's configuration.

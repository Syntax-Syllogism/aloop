---
title: Hermetic phase execution
description: Configure optional runtime isolation, network policy, environment forwarding, and publish credentials for aloop phases.
---

# Hermetic phase execution

Hermetic execution is an opt-in container boundary around individual phases. By default, phases run on the host. When you enable it, aloop wraps an agent or gate command in your container runtime, mounts only the paths that phase needs, and records the resolved policy in the run evidence.

## Configuration

Set run-level defaults in `loop.config.mjs`, then opt phases in with `hermetic: true` or a phase-specific object:

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

The run-level `hermetic` object only sets defaults. It doesn't turn on container execution. A phase with `hermetic: false`, or no `hermetic` field, runs on the host. An enabled phase must resolve an image.

- `runtime`: the executable that launches the container, such as `docker` or `podman`.
- `image`: required for an enabled phase.
- `network` (alias `networks`; stored as `networks`): an empty list becomes runtime network `none`. Named networks form an explicit allow-list. `none` can't be combined with another network.
- `env`: names of host environment variables to forward when they're set. Values are never copied into saved configuration or snapshots.
- `secrets`: names of host environment variables that must exist. A missing secret fails the run. Secrets can only be declared on the `publish` phase.

The runtime must be installed on the host, and the image must be available locally or pullable. It must contain everything the selected agent adapter or gate command needs. Custom adapters need no container-specific command format, because aloop wraps whatever command and arguments they return.

## Phase boundaries

For agent and gate phases, the command keeps its absolute working directory. Host paths are bind-mounted at the same paths inside the container.

- A `write-worktree` agent gets the worktree read-write, plus its run and task-file artifact directories read-write.
- A `read-only` agent gets the worktree read-only, a disposable read-only source snapshot, and writable run artifacts. This keeps the artifact-only behavior described in the [loop guide](loop.md#phase-permissions).
- A gate gets the worktree read-only and the run directory read-write. Each gate command is wrapped separately.
- `setup` commands, operational subcommands, and the runtime launcher stay on the host.

The `publish` phase is owned by the driver and doesn't run inside the container. Its hermetic settings apply an environment allow-list to Git push, remote-SHA verification, and the built-in GitHub (`gh`) or GitLab (`glab`) backend. That's where declared publish credentials get used, without being exposed to agent phases. In-process custom backend objects are rejected when hermetic publish filtering is on, because arbitrary backend code can't be given a reliable credential boundary.

## Network and credentials

An enabled agent or gate has no network unless its phase declares one. This is separate from the phase permission level. Permissions control mounted paths and worktree writes. Hermetic settings control the runtime boundary and environment.

A hermetic command receives only `PATH` and the environment names you declared. Secrets must exist in the host environment before publish starts. Their values, along with other declared values, are forwarded, and never written to logs, manifests, or snapshots.

## Run evidence

The immutable `snapshot.json` records the runtime, the default image, and each phase's enabled state and resolved runtime, image, network, environment, and secret-name policies. Agent and gate manifest entries also record their effective execution policy: `host`, or the resolved hermetic settings. None of these records contain environment values.

Hermetic settings are resolved when configuration loads, and the run snapshot keeps them for resume and audit. Changing the configuration doesn't rewrite an existing snapshot. To change a saved run's configuration on purpose, use the documented resume configuration override.

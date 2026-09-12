# aloop

`@syntax-syllogism/aloop` is an engine-agnostic agentic loop runner. It drives
a task through file-based implementation, deterministic checks, review, repair,
documentation, and git phases. The driver owns control flow; configured agent
CLIs provide judgment in fresh processes.

## Install

```sh
npm install --global @syntax-syllogism/aloop
# or run without a global install
npx @syntax-syllogism/aloop --help
```

The package is published to the public npm registry and needs no private
registry configuration.

## Quick start

From a git repository with a `loop.config.mjs` (or with the defaults):

```sh
aloop --task "Add request tracing" --name request-tracing
aloop --task-file plan.md
```

Inspect the rendered plan first with `aloop --task "..." --name example
--dry-run`. A terminal run asks for confirmation before each phase. Use `-y`
only after the configured engines and workflow have been proven for the task
shapes you intend to automate.

## How the loop works

The default pipeline is:

1. `implement` — make the requested change in an isolated git worktree.
2. `gate` — run deterministic commands such as `npm test`.
3. `review` — write a machine-readable verdict JSON file.
4. `address` — repair blocking findings, then repeat the gate and review up to
   the configured round limit.
5. `docs` — update documentation when the implementation requires it.
6. `git` — verify the tree and prepare the branch for an open pull request.

Phases communicate through files rather than shared agent sessions. A review
verdict has the shape `{ verdict, summary, blocking, nits }`; malformed verdicts
fail closed. The runner never merges a branch and never treats an agent's prose
as a deterministic test result. See [`docs/loop.md`](docs/loop.md) for the
complete guide and verdict contract.

## Configuration

Create `loop.config.mjs` in the repository being operated on:

```js
export default {
  remote: 'origin',
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'gate', 'review', 'address', 'docs', 'git'],
  gate: ['npm test'],
  setup: ['npm ci'],
  maxRounds: 3,
};
```

Supported built-in engines are `claude`, `codex`, and `agy`. The corresponding
CLI must already be installed and authenticated. Engine descriptors may include
an engine-specific `model` and `effort`. `--config` selects a configuration
file outside the current repository; command-line phase and round options take
precedence.

### Bring your own engine

Register an adapter under `adapters` when another CLI should run a phase. Its
`command({ prompt, cwd, addDirs, agent })` function returns `{ command, args }`.
It may also provide `efforts` validation and `createRenderer()` for streaming
output. Because adapters run commands with write access, non-interactive or
auto-approve flags can allow an agent to change files without asking. Review
the adapter and its permissions before enabling unattended runs.

## Prompt overrides and the work-item preset

Copy a phase prompt to `.loop/prompts/<phase>.md` to override only that phase.
Templates use the variables documented in `docs/loop.md` and fail if a
placeholder is unresolved.

For repositories using Markdown work items, install the bundled preset:

```sh
mkdir -p .loop/prompts
cp -r node_modules/@syntax-syllogism/aloop/presets/work-item/prompts/. .loop/prompts/
```

The preset includes prompts and a sample configuration. Adapt it to the
repository's branches and gates before use.

## Building up to unattended runs

Use this progression:

1. Render prompts with `--dry-run`.
2. Watch one representative task through every phase.
3. Exercise the review loop with `--max-rounds 2`.
4. Add `-y` only for task shapes whose behavior is already understood.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

## Contributing

Issues and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © Jacob Richter

# aloop

`@syntax-syllogism/aloop` is an engine-agnostic agentic loop runner. It drives
a task through file-based implementation, deterministic checks, review, repair,
documentation, and publishing phases. The driver owns control flow; configured agent
CLIs provide judgment in fresh processes.

## Install

```sh
npm install --global @syntax-syllogism/aloop
# or run without a global install
npx @syntax-syllogism/aloop --help
```

The package is published to the public npm registry and needs no private
registry configuration.

## Platform support

Linux and macOS are supported. Windows is supported when aloop is launched
from Git Bash (Git for Windows), which provides the POSIX `sh` used for setup
and gate commands. Install Git for Windows, ensure `sh.exe` is on `PATH`, and
run aloop from a Git Bash terminal. WSL works as Linux.

Interactive confirmations use the Git Bash/Windows console when available. Use
`--yes` for unattended or piped runs when no console input is available.

## Quick start

From a git repository, create the editable configuration and prompt overrides:

```sh
aloop init
```

Review the generated `loop.config.mjs`, then start a task:

```sh
aloop --task "Add request tracing" --name request-tracing
aloop --task-file plan.md
```

Inspect the rendered plan first with `aloop --task "..." --name example
--dry-run`. A terminal run asks for confirmation before each phase. Use `-y`
only after the configured engines and workflow have been proven for the task
shapes you intend to automate. Required phases cannot be skipped interactively:
declining one asks you to run it or quit. `docs` is optional by default; see
[`docs/loop.md`](docs/loop.md#phases) for custom-phase rules and the full phase
reference.

## How the loop works

The default pipeline is:

1. `implement` — make the requested change in an isolated git worktree.
2. `docs` — update documentation when the implementation requires it.
3. `gate` — run deterministic commands such as `npm test`.
4. `review` — write a machine-readable verdict JSON file.
5. `address` — repair blocking findings, then repeat the gate and review up to
   the configured round limit.
6. `pr-description` — author the title and body in the run directory.
7. `publish` — push and verify the attested branch, then create or update a
   draft pull request.

Phases communicate through files rather than shared agent sessions. A review
verdict has the shape `{ verdict, summary, blocking, nits }`; malformed verdicts
fail closed. The runner never merges a branch and never treats an agent's prose
as a deterministic test result. Each real run also records the repository SHAs,
rendered prompt and configuration hashes, gate receipts, verdict binding, and
phase artifacts in its run manifest. See [`docs/loop.md`](docs/loop.md) for the
complete guide, manifest schema, and verdict contract.

## Configuration

`aloop init` creates a commented `loop.config.mjs` in the repository being
operated on. Adjust it as needed; for example, a configuration can be:

```js
export default {
  remote: 'origin',
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  gate: ['npm test'],
  shell: 'sh',
  publish: { backend: 'github', draft: true },
  setup: ['npm ci'],
  maxRounds: 3,
};
```

Supported built-in engines are `claude`, `codex`, `agy`, and `gemini`. The
corresponding CLI must already be installed and authenticated. Engine
descriptors may include an engine-specific `model` and `effort` (Gemini has no
effort tier, so a configured `effort` is ignored for it). `--config` selects a configuration
file outside the current repository; command-line phase and round options take
precedence.

GitLab publishing is also bundled: set `publish: { backend: 'gitlab', draft:
true }` to use the authenticated `glab` CLI. For a REST or MCP integration,
import `gitlabBackend` and inject the small GitLab-native transport port:

```js
import { gitlabBackend } from '@syntax-syllogism/aloop';

const myMcpTransport = { checkAuth, getMergeRequest, createMergeRequest, updateMergeRequest };
export default { publish: { backend: gitlabBackend({ transport: myMcpTransport }), draft: true } };
```

### Bring your own engine

Register an adapter under `adapters` when another CLI should run a phase. Its
`command({ prompt, cwd, addDirs, permissions, artifactOnly, agent })` function
returns `{ command, args }`. For a read-only phase, `cwd` is a disposable
read-only source snapshot of the saved worktree and `addDirs` contains only
writable artifact roots. The runner supplies a permission level and restricts
`addDirs` accordingly; the adapter must translate `permissions` into its own
read-only or write-capable invocation flags. It may also provide `efforts`
validation and `createRenderer()` for streaming output. Custom adapter flags
are vendor-specific and are not verified by aloop. See the [phase permission
contract](docs/loop.md#phase-permissions) before enabling unattended runs.

## Prompt overrides and the work-item preset

Copy a phase prompt to `.loop/prompts/<phase>.md` to override only that phase.
Templates use the variables documented in `docs/loop.md` and fail if a
placeholder is unresolved.

For repositories using Markdown work items, install the bundled preset:

```sh
aloop init --preset work-item
```

This creates the preset's sample configuration and prompt overrides. Adapt its
branches and gates before use. `aloop init` also copies the default prompts, so
you can edit any `.loop/prompts/<phase>.md` immediately; see
[`docs/loop.md`](docs/loop.md#getting-started) for overwrite and preset details.

## Building up to unattended runs

Use this progression:

1. Render prompts with `--dry-run`.
2. Watch one representative task through every phase.
3. Exercise the review loop with `--max-rounds 2`.
4. Add `-y` only for task shapes whose behavior is already understood.

## Evaluation harness

`aloop-eval <spec.mjs>` runs a task corpus across a model/config matrix, each
cell in its own throwaway repository, and reports completion, escaped
defects, convergence, and cost per cell and per config. See
[`docs/eval.md`](docs/eval.md) for the spec file shape and reported fields.

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

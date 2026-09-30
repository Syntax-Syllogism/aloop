# aloop

`@syntax-syllogism/aloop` runs an AI coding task through a repeatable loop: implement, check, review, repair, document, and publish. The runner controls the flow. The agent CLIs you configure (Claude, Codex, and others) do the thinking, each in a fresh process.

## Install

```sh
npm install --global @syntax-syllogism/aloop
# or run it without installing
npx @syntax-syllogism/aloop --help
```

The package is on the public npm registry. You don't need any registry setup.

## Platform support

Linux, macOS, and Windows are supported. On Windows you can use either of two modes:

- **Git Bash.** Start aloop from a Git for Windows terminal. `sh.exe` on `PATH` runs setup and gate command strings exactly as on POSIX.
- **Native PowerShell.** No POSIX shell needed. Commands run under PowerShell 7+ (`pwsh`), or Windows PowerShell (`powershell.exe`) if that's missing. Set `shell:` in the config to override. Command strings that use POSIX-only syntax (`&&` with `$VAR`, `[[ ]]`, `2>&1`, single-quote rules) won't run unchanged in PowerShell. For anything beyond one simple command, use the `argv` or per-platform forms described below.

WSL works as Linux. Confirmations use a TTY when there is one, or the Windows console (`CONIN$`) under Git Bash. If neither is available, for example in a piped run, pass `--yes`. See [`docs/platform.md`](docs/platform.md) for details.

## Quick start

In a git repository, create an editable config and prompt overrides:

```sh
aloop init
```

Review the generated `loop.config.mjs`, then start a task:

```sh
aloop --task "Add request tracing" --name request-tracing
aloop --task-file plan.md
```

To see the rendered plan first, add `--dry-run`:

```sh
aloop --task "..." --name example --dry-run
```

In a terminal, aloop asks for confirmation before each phase. Pass `-y` only after you've seen the engines and workflow work well for the kinds of tasks you want to automate. You can't skip a required phase interactively. If you decline one, aloop asks whether to run it or quit. `docs` is optional by default. See [`docs/loop.md`](docs/loop.md#phases) for the phase reference and the rules for custom phases.

## How the loop works

The default pipeline:

1. `implement`: make the change in an isolated git worktree.
2. `docs`: update documentation if the change needs it.
3. `gate`: run deterministic checks such as `npm test`.
4. `review`: write a machine-readable verdict file.
5. `address`: fix blocking findings, then repeat the gate and review, up to the round limit.
6. `pr-description`: write the pull request title and body in the run directory.
7. `publish`: push and verify the branch, then create or update a draft pull request.

Phases pass work to each other through files, not shared agent sessions. A review verdict looks like `{ verdict, summary, blocking, nits }`, and a malformed one fails closed. The runner never merges a branch, and it never mistakes an agent's prose for a test result.

Every real run also records what it needs to be audited: repository SHAs, hashes of the rendered prompts and configuration, gate receipts, verdict binding, and phase artifacts, all in the run manifest. See [`docs/loop.md`](docs/loop.md) for the full guide, the manifest schema, and the verdict contract.

## Configuration

`aloop init` creates a commented `loop.config.mjs` in the repository you're working on. Edit it as needed. For example:

```js
export default {
  remote: 'origin',
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  gate: ['npm test'],
  publish: { backend: 'github', draft: true },
  setup: ['npm ci'],
  maxRounds: 3,
};
```

A plain string like `'npm test'` runs through the shell (`sh` on POSIX, the native shell on Windows), so it isn't portable to a machine without that shell. To write one `gate`, `setup`, or `phase.commands` entry that runs unchanged on POSIX and native Windows, use the structured forms:

```js
export default {
  // No shell at all. The portable choice for a single command with no
  // pipes, `&&`, or shell expansion.
  setup: [{ argv: ['npm', 'ci'] }],
  // Per-platform variants, for anything that needs shell syntax.
  gate: [{ posix: 'npm test 2>&1', windows: 'npm test *>&1' }],
  shell: 'pwsh', // optional; overrides the detected native shell
};
```

If a per-platform entry lacks the variant for the current host (say, only `posix` on native Windows), config loading fails with an error that names the phase and command index.

The built-in engines are `claude`, `codex`, `agy`, and `gemini`. The matching CLI must already be installed and signed in. An engine can set its own `model` and `effort`. Gemini has no effort setting, so aloop ignores `effort` for it. Use `--config` to load a config file from outside the repository. Command-line phase and round options override the config.

GitLab publishing is built in too. Set `publish: { backend: 'gitlab', draft: true }` to use the signed-in `glab` CLI. For a REST or MCP integration, import `gitlabBackend` and pass in a small GitLab transport:

```js
import { gitlabBackend } from '@syntax-syllogism/aloop';

const myMcpTransport = { checkAuth, getMergeRequest, createMergeRequest, updateMergeRequest };
export default { publish: { backend: gitlabBackend({ transport: myMcpTransport }), draft: true } };
```

### Bring your own engine

To run a phase with another CLI, register an adapter under `adapters`. Its `command({ prompt, cwd, addDirs, permissions, artifactOnly, agent })` function returns `{ command, args }`.

For a read-only phase, `cwd` is a disposable read-only snapshot of the saved worktree, and `addDirs` holds only the writable artifact folders. The runner sets the permission level. Your adapter has to turn `permissions` into the right read-only or write-capable flags for its CLI. It can also provide `efforts` validation and `createRenderer()` for streaming output. aloop doesn't verify a custom adapter's vendor-specific flags. Read the [phase permission contract](docs/loop.md#phase-permissions) before you enable unattended runs.

## Prompt overrides and the work-item preset

To change one phase's prompt, copy it to `.loop/prompts/<phase>.md`. Templates use the variables listed in `docs/loop.md`, and a run fails if any placeholder is left unresolved.

If your repository uses Markdown work items, use the bundled preset:

```sh
aloop --preset work-item --task-file ./work-items/example.md
```

Set `preset: 'work-item'` in `loop.config.mjs` to use it on every run. The preset activates its prompts at run time without copying them into `.loop/prompts/`, and your own prompt files still win, file by file. For an editable copy of the sample config and prompts, run `aloop init --preset work-item`. See [`docs/loop.md`](docs/loop.md#configuration) for precedence, external preset paths, and resuming.

## Working up to unattended runs

1. Render the prompts with `--dry-run`.
2. Watch one typical task go through every phase.
3. Try the review loop with `--max-rounds 2`.
4. Add `-y` only for task shapes whose behavior you already understand.

## Evaluation harness

`aloop-eval <spec.mjs>` runs a set of tasks across a matrix of models and configs. Each cell gets its own throwaway repository. It reports completion, escaped defects, convergence, and cost for each cell and each config. See [`docs/eval.md`](docs/eval.md) for the spec file and the reported fields.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

## Contributing

Issues and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE) © Jacob Richter

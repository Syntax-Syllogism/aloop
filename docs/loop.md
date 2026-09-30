---
title: Agentic loop runner
---

# Agentic loop runner

`@syntax-syllogism/aloop` runs a task through implementation, review, documentation, and publishing without a person relaying prompts between steps. The `aloop` CLI is the driver, and the agents are the steps.

## The split

The runner is deliberately not an agent. A simple, deterministic driver owns control flow: iteration caps, retries, state, and exit conditions. It calls stateless agent invocations, which own judgment. Everything else follows from that split:

- **Steps communicate through files, never through a session.** No step depends on another step's context window, so any phase can run on any engine.
- **Exit conditions are machine-readable.** The review phase writes a verdict JSON that the driver parses. Prose is for humans. The driver never reads stdout.
- **Deterministic checks run in the driver.** Anything a compiler or test suite can decide is decided by exit code, not by asking an agent how it went.
- **Every phase starts with a fresh context.** The reviewer hasn't absorbed the implementer's rationalizations, and round three is as sharp as round one.

## Usage

```bash
aloop --task-file ./work-items/afmt-clippy-cleanup.md
```

Run `aloop --version` to print the installed version.

By default, the runner asks before each phase. At the prompt, Enter or `y` runs the phase and `q` stops the run. Any other answer is a request to skip. Only optional phases can be skipped. If you decline a required phase, aloop explains that it must run and asks again whether to run it or quit. Add `-y` once a pipeline has earned it.

```
  -t, --task <text>       Inline task description
  -f, --task-file <path>  Path to a task/plan/spec file
  -n, --name <slug>       Explicit run identity/slug
  -b, --branch <name>     Branch to build on (default: <branchPrefix><name>)
      --base-branch <branch>  Base to branch from and PR against (default: baseBranch config)
  -e, --engine <name>     Default engine: claude | codex | agy | gemini
  -m, --model <name>      Model for the default engine (overrides config; switching engines without it uses the new engine default)
      --effort <level>    Reasoning effort for the default engine (overrides config; ignored by engines without effort)
      --override-engine   With --resume and --engine, replace saved agent executables
      --config <path>     Load loop configuration from this file
      --phases a,b,c      Override the configured phase list
      --max-rounds <n>    Cap on review/repair rounds
      --from <phase>      Start at this phase (with --resume, re-run it even if complete)
      --preset <name|path> Activate a bundled preset or external preset directory
      --resume            Skip phases already recorded complete
      --note <text>       Give the target agent an authoritative instruction
      --note-file <path>  Read that instruction from a file (--note wins)
  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)
      --no-worktree       Work in the current checkout instead of a worktree
      --no-tui            Force plain streaming output (TUI is on by default on a TTY)
      --quiet             Print only phase transitions, status lines, and a periodic heartbeat (disables the TUI)
      --no-quiet          Override quiet: true from the config
      --heartbeat <min>   Heartbeat interval in minutes for quiet mode (default 10; 0 = transitions only; implies --quiet)
      --dry-run           Print the plan and rendered prompts, run nothing
```

On a TTY, `aloop` shows a live dashboard instead of raw streaming output. It lists phases with their status, the current diff, review findings, running cost, and produced artifacts. It's purely a view. It reads the manifest and state the run already saves after each phase, and never changes how the run behaves. It steps aside automatically for piped output and CI. Pass `--no-tui` to force plain streaming on a TTY. `--yes` only skips the per-phase confirmation, so an unattended run on a real terminal still shows the dashboard.

### Quiet mode

`--quiet` is for callers that read a run's stdout and only need to know whether it's still moving, such as an orchestrating agent running several loops in the background. Raw agent, gate, and setup output isn't printed, but it's still written byte-for-byte to the per-phase logs in the run directory.

Quiet mode still prints:

- the run header;
- phase banners, prefixed with `[HH:MM]`;
- status lines such as skips, verdicts, and refusal reasons;
- confirmation prompts;
- the final summary or stall report, including its output tail.

Every `heartbeatMinutes` (default 10) it adds a heartbeat line. The timer restarts at each phase transition:

```text
[14:12] implement · 10m in phase · 10m total · last: Running npm test -- drift
```

`last:` is the most recent non-empty output line, with ANSI escapes removed and cut to 120 characters. `--heartbeat 0` (or `heartbeatMinutes: 0`) prints transitions only. Quiet mode disables the TUI on a terminal and is ignored by `--dry-run`.

Precedence, highest first: `--no-quiet`; `--quiet` or `--heartbeat <min>` (which implies quiet); then the config's `quiet` and `heartbeatMinutes`. Both keys affect display only. They're left out of the run's configuration hash, so toggling them between a run and its `--resume` isn't a configuration change.

### Dry runs

`--dry-run` renders every prompt with real values and executes nothing. It reports the run directory, worktree, and branch it would use, without creating any of them. Use it whenever you change a prompt or a phase list.

### Task input

The task is optional. You can supply it in four ways:

- `--task <text>` gives inline requirements.
- `--task-file <path>` gives a plan, spec, ticket, or work item.
- Both flags together give inline requirements plus the full task file.
- With neither, `--name <slug>` is required, and the run has no task content.

Run identity comes from `--name` if supplied, and otherwise from the task-file name. The identity determines the default branch and run directory, and is saved in `state.json` for `--resume`.

`--task-file -` reads the task from standard input. A real run saves it as `task.md` in the run directory. A dry run uses it only to validate and render the planned prompts, and writes nothing. On POSIX, a piped run reads its per-phase confirmations from `/dev/tty`, so this works interactively:

```sh
some-task-source fetch 123 | aloop --task-file - --name my-spec
```

Add `--yes` to run unattended. If there's no controlling terminal, the runner reports an error and asks for `--yes`. `--dry-run` doesn't need `--yes`.

## Getting started

Set up a repository with an editable configuration and a full local copy of the prompt templates:

```sh
aloop init
```

This creates `loop.config.mjs` and `.loop/prompts/*.md` in the current directory. Before the first run, read the comments at the top of the generated config, especially `baseBranch`, `remote`, and `engines`. You can change phases and gates at any time, and edit any local prompt to tailor its phase.

To start from a bundled preset, give its name:

```sh
aloop init --preset work-item
```

Preset prompts overlay the packaged defaults, so even a partial preset produces a complete `.loop/prompts/` directory. `init` won't replace scaffold files that already exist. Re-run with `--force` to replace the config and managed prompt files. Extra prompt files you added are left alone. Add `--json` to get an object listing the created files and the selected preset.

Windows is fully supported in two modes: Git Bash, where setup and gate strings run through `sh -c` as on POSIX, and native PowerShell with no POSIX shell, where they run through `pwsh` (or `powershell.exe`). See the [command model](#command-model) for how to write config that runs unchanged on both, and [Platform support](platform.md) for the details. WSL works as Linux.

## Run metrics

Completed and stalled runs keep per-phase duration in `manifest.json`, plus token and cost usage when an adapter reports it. Unavailable values show as unknown, never estimated. Inspect them with the read-only commands:

```sh
aloop status <name>
aloop inspect <name> --json
aloop list --metrics
aloop metrics --json
```

Metrics include per-phase and per-run totals, stall rates, rounds to approval, reviewer catch rate, and findings cleared during repair rounds. Aggregates are computed on demand from saved manifests, so there's no rollup file to repair. See [Cost and quality metrics](metrics.md) for the output shape and usage rules.

## Resuming

Resume with the saved run identity:

```sh
aloop --name my-spec --resume
```

The hint printed when a run stalls always includes the saved `--name`, and includes a task-file path when a real one was supplied. For a task that came from stdin, resume with the name alone.

Before reading stdin or recording new task state, the runner rejects conflicting explicit `--name` or `--task` values. For a saved task-backed run, it also rejects conflicting task-file values. A matching stdin resume reuses the existing `RUN_DIR/task.md` and doesn't read stdin again.

### Operator-guided resume

Use `--note` or `--note-file` to give one agent invocation an authoritative instruction when you resume a stalled run. The note is prepended to the rendered prompt before its hash is recorded, so the manifest keeps evidence of the exact guided invocation. `--note` wins if you give both. The file path is resolved from the current directory, and the note must contain non-whitespace text.

`--resume --from <phase>` runs the named phase even if it was already recorded complete. aloop clears the saved state for that phase and every later one, including repair state, before running them again. Without `--from`, a note targets the first phase that will run: the first phase of a fresh run, or the first incomplete phase on resume. With `--from`, it targets the named phase, which is useful for telling a phase to finish work that was preserved:

```sh
aloop --name my-spec --resume --from implement \
  --note "The implementation is present; commit it and complete the phase."
```

Notes apply to one invocation and aren't saved in `state.json`, so a later ordinary `--resume` doesn't receive an earlier note. The target must be an agent phase. A repair-enabled gate is the one exception: its note goes to each agent repair invoked after a gate failure. A gate with no agent repair, and a publish phase, reject `--note` because they have no agent prompt to guide.

## Configuration

`loop.config.mjs` at the repository root:

```js
export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  adapters: {},
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  reviewRoles: [], // optional: security, api-compat, test-quality
  gate: ['npm test'],
  publish: { backend: 'github', draft: true },
  setup: ['npm ci'],
  maxRounds: 3,
  timeoutMs: 30 * 60 * 1000,
  preset: null,
  quiet: false,
  heartbeatMinutes: 10,
  budget: {
    tokens: 100000,
    usd: 5,
    wallClockMs: 45 * 60 * 1000,
  },
};
```

`--config path/to/loop.config.mjs` loads a config from outside the repository. Relative paths resolve from your current directory. The file replaces the repository's `loop.config.mjs`, and command-line overrides such as `--phases` and `--max-rounds` still win.

### Presets

`preset` selects a prompt-only preset for every run in the repository. A bundled name such as `work-item` resolves to the package's `presets/<name>/prompts/`. A path resolves to an external preset directory containing `prompts/`. Prompts are looked up in this order: your project's `.loop/prompts` overrides, then the selected preset, then the packaged defaults. `--preset <name|path>` overrides the config key for one run. A preset never brings engines, phases, gates, or branches from its sample configuration.

The chosen preset is saved in `state.json` and reused by `--resume`. For an external preset, aloop also saves the directory its path was resolved from, so a relative path stays pinned when you resume from another directory. A conflicting `--resume --preset` is rejected, including when `--config` is supplied. Start a new run to choose a different preset.

### Terminal output

`quiet` and `heartbeatMinutes` set the default output mode. See [Quiet mode](#quiet-mode). `heartbeatMinutes` must be a nonnegative number.

### Phase order checks

Config loading rejects a phase order that would break publishing, before any worktree or agent work starts. Once phase descriptors and repair transitions are normalized, each publishing phase is checked against the latest verdict before it. A commit-producing phase (one whose `outputs` include `commit`) can't sit between that verdict and the publishing phase.

The rule applies at every publishing boundary. So `review → docs → publish → final-review` is rejected: `docs` advances `HEAD` after `review` approved it, even though another verdict comes later. A publishing boundary is a `publish` phase, or a phase declared with `requiresCleanTree: true` or a pull-request output. The rule ensures each published `HEAD` is the tree approved by its latest gate-backed review.

Move documentation and other commit-producing phases before the gate and review loop. The loader names the offending phases and never reorders your config silently. Pipelines with no verdict before a publishing phase, or with no publishing boundary, aren't subject to this check.

Optional runtime isolation is configured separately from phase permissions. See [Hermetic phase execution](hermetic.md).

### Engines

An `engines` entry can be an engine-name string, or a descriptor with `name` plus optional `model` and `effort`. A phase with no entry inherits the entire `default` descriptor. A phase descriptor replaces it. Model names go to the CLI as-is. Effort is validated before a phase starts:

| Engine | Model option | Effort option | Supported effort |
| --- | --- | --- | --- |
| `claude` | `--model` | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `--model` | `-c model_reasoning_effort=…` | `low`, `medium`, `high`, `xhigh`, `max` |
| `agy` | `--model` | `--effort` | `low`, `medium`, `high` |
| `gemini` | `--model` | none | none (the Gemini CLI has no effort flag, so a configured `effort` is ignored) |
| configured adapter name | adapter-defined | adapter-defined | the adapter's `efforts`, or any value if omitted |

Running `review` on a different engine than `implement` is the main reason to use several CLIs. Different model families fail differently, so the reviewer's blind spots don't overlap with the implementer's.

The `adapters` map registers more engines without changing the package. Its keys work as `engines.*.name` values. An adapter with the same name as a built-in takes precedence, so you can also customize a built-in invocation. An adapter can declare an `efforts` array. Without one, the configured effort is passed through unvalidated. Without `createRenderer`, the runner uses its plain-text passthrough renderer.

An adapter renderer can expose `usage()`, returning numeric `tokens` and `cost`. An adapter with no renderer can expose the same hook itself. The runner copies reported values into the phase manifest. Adapters that can't report usage leave them out. See [Cost and quality metrics](metrics.md#how-usage-is-captured) for the built-in JSONL rules.

### Bring your own engine

An adapter is a small ES module object whose `command` function returns one process invocation. For example, an opencode-style setup:

```js
export default {
  adapters: {
    opencode: {
      command({ prompt, cwd, addDirs, permissions, artifactOnly, agent = {} }) {
        const writeAccess = permissions.includes('write-worktree')
          && !permissions.includes('read-only')
          && !artifactOnly;
        // `--mode` is illustrative; use opencode's equivalent flags.
        const args = ['run', prompt, '--dir', cwd, '--mode', writeAccess ? 'write' : 'plan'];
        if (agent.model) args.push('--model', agent.model);
        if (agent.effort) args.push('--effort', agent.effort);
        for (const dir of addDirs) args.push('--add-dir', dir);
        return { command: 'opencode', args };
      },
    },
    pi: {
      command({ prompt, cwd, addDirs, permissions, artifactOnly, agent = {} }) {
        const writeAccess = permissions.includes('write-worktree')
          && !permissions.includes('read-only')
          && !artifactOnly;
        // `--mode` is illustrative; use pi's equivalent flags.
        const args = ['--print', prompt, '--cwd', cwd, '--mode', writeAccess ? 'write' : 'plan'];
        if (agent.model) args.push('--model', agent.model);
        return { command: 'pi', args };
      },
    },
  },
  engines: {
    default: { name: 'opencode', model: 'provider/model' },
    review: 'pi',
  },
};
```

**A custom engine must run fully non-interactively, and must be allowed to edit files and run shell commands. Put its auto-approve and writable-directory flags in `command`. Otherwise a phase can sit waiting for input until it times out.** The runner can't verify those vendor-specific flags. The built-ins use equivalent headless permissions: Claude `--permission-mode auto`, Codex `--sandbox workspace-write`, agy `--dangerously-skip-permissions`, and Gemini `--approval-mode yolo` with `--skip-trust`.

The verdict contract is still file-based. The engine only has to run the prompt and write the files it asks for. A resumed run re-reads adapters from `loop.config.mjs`, so that config must still define any custom adapter the saved engine settings use.

### Changing engines

`--engine` changes the default executable. It keeps the configured model and effort only if the engine is unchanged. When you switch engines, they're dropped, because model and effort strings are vendor-specific (`gpt-5.6-terra` means nothing to Gemini) and the new engine would reject them. Set the new engine's model with `--model` and effort with `--effort`, or configure them in `loop.config.mjs`. `--model` and `--effort` also work alone, to override just the default engine's model or effort.

Dry runs and phase logs print the effective engine settings. The first real run saves them in run state. `--resume` uses the saved settings even if `loop.config.mjs` has changed, so a resumed run stays auditable and reproducible.

`--resume --config path/to/loop.config.mjs` deliberately replaces those saved settings and every other configurable pipeline value: engines, phase definitions, gates, prompts, timeouts, round caps, and budgets. It can't change the branch, worktree, or base branch already created, because they identify the run being resumed. Keep `runsDir` unchanged so the runner can find the saved run. Don't combine it with `--override-engine`. Set the engines you want in the config instead. Every resume override, including its source path and resolved values, is snapshotted in `state.json`.

To move an interrupted run to another executable, use `--resume --engine <name> --override-engine`. It replaces the saved engine for every agent phase and drops each phase's saved model and effort, which wouldn't apply to the new engine. Add `--model` and `--effort` to set them. Otherwise each phase uses the new engine's default. The new combination is validated before a phase starts. The runner records the before and after settings in `state.json`, prints the change at resume time, and adds it to each affected phase log header.

### Remote, publishing, and setup

`remote` is where the `publish` phase pushes. If unset, aloop detects one and prefers `origin`. Set it explicitly in any repo with several remotes, since pushing a feature branch to the wrong one can't be undone by the run. A configured remote that doesn't exist fails before any phase runs.

`publish` defaults to `{ backend: 'github', draft: true }`. The bundled GitHub and GitLab backends need signed-in `gh` and `glab` CLIs. Both push without force, then verify the remote branch SHA and the PR or MR URL, number, base, head SHA, and draft state. To use your own, set `publish.backend` to an object with `precheck`, `view`, `create`, and `update`. See [Publishing](publishing.md) for backend setup, the description format, the operation contract, and failure behavior.

Use `--base-branch feat/a` to build and open a stacked PR on top of another local branch. That branch must exist locally. The flag doesn't fetch remote-only refs.

`setup` is an optional list of commands run once when the runner adds a new worktree, before phase 1. That includes a fresh worktree for a branch that already exists, since branch creation and worktree creation are tracked separately. It defaults to an empty list, so the runner doesn't assume a package manager. Setup runs in the worktree with the same timeout as other commands. A non-zero exit or a timeout aborts the run before any phase starts. It's skipped for resumed or reused worktrees and during `--dry-run`.

`gate` and `setup` commands, and a phase's own `commands` override, are judged by exit code on unfiltered output. Call the compiler directly instead of a cached wrapper script. A cached build can report success without compiling anything, and a wrapper that summarizes output can invent a failure the tool never produced.

### Command model

Each entry in `gate`, `setup`, or a `gate`-kind phase's `commands` takes one of three forms:

- **A shell string**, such as `'npm test'`. This is the original form. It runs through a shell, so quoting, pipes, `&&`, `2>&1`, and environment variables all work. On POSIX the shell is `shell -c`, where `shell` defaults to `sh`. On native Windows (no `sh` on `PATH`) it's PowerShell 7+ (`pwsh`), falling back to `powershell.exe`. Set `shell` in `loop.config.mjs` to override detection on either platform. A string written for one shell may not parse in another. `&&` with `$VAR`, `[[ ]]`, `2>&1`, and single-quote rules all differ between POSIX shells and PowerShell.
- **`{ argv: [...] }`** runs the argv directly, with no shell. This is the portable form, with identical behavior everywhere. It can't express pipes, `&&`, or redirection. Split those into several entries, or use the next form.
- **A per-platform object**, `{ posix: '...', windows: '...' }`, optionally with `pwsh` and `cmd` keys for a specific Windows shell. aloop picks the entry for the host: `posix` on Linux and macOS, and on Windows `windows`, then `pwsh`, then `cmd`. A config that defines only `posix` fails to load on Windows, and the reverse, with an error naming the phase and command index. A load-time failure is much cheaper to diagnose than a stall mid-run.

```js
export default {
  setup: [{ argv: ['npm', 'ci'] }],
  gate: [
    { posix: 'npm test 2>&1', windows: 'npm test *>&1' },
    { argv: ['node', 'scripts/check-schema.mjs'] },
  ],
};
```

The `command` recorded in gate receipts and logs is always the entry's display string: the argv joined with spaces, or the selected shell string. `GATE_COMMANDS` in agent prompts uses the same display strings, one per line.

### Run budgets

`budget` sets optional run-level ceilings. `tokens` must be a nonnegative integer. `usd` and `wallClockMs` must be nonnegative finite numbers. An empty object, the default, turns budget enforcement off. Limits are cumulative across the run, including review rounds and repairs:

```js
budget: {
  tokens: 100000,
  usd: 5,
  wallClockMs: 45 * 60 * 1000,
},
```

The runner checks measured totals before starting each phase and each repair or review action. It doesn't interrupt an engine request in flight. Usage is checked again at the next boundary. A completed final phase is also checked after it runs. When a limit is reached, the run stalls with a reason such as `budget exhausted: tokens`, and the usage and limit are recorded in the manifest.

Token and dollar limits need the matching usage measurement from the adapter. When a configured measurement isn't available, the runner warns and doesn't treat the unknown as zero, and doesn't enforce that limit. Other measurable limits still apply. Wall-clock usage is measured from the saved run start time.

Budget stalls can be resumed. An unchanged limit stalls again before any more work runs. If the final phase had already completed when the limit was hit, its checkpoint is marked `budgetExhausted`. Raising the limit and resuming clears the marker without rerunning the completed action. See [Run state and recovery](run-state.md#starting-and-resuming).

### Phase permissions

Every normalized phase has a `permissions` array with values from `read-only`, `write-worktree`, and `publish`. Unknown values are rejected. A custom phase that omits the field or gives an empty array defaults to `read-only`. A custom phase with `kind: 'publish'` defaults to `publish`.

| Permission | Built-in phases | Agent access and behavior |
| --- | --- | --- |
| `read-only` | `gate`, `review`, `pr-description` | Agent phases run from a disposable read-only source snapshot of the saved worktree. They can write only the run artifacts, plus the task-file artifact directory for the verdict/review phase. Shell gates don't invoke an agent adapter. |
| `write-worktree` | `implement`, `docs`, `address` | Agent phases may modify and commit the worktree. The adapter receives the run directory and any task-file directory the phase needs. |
| `publish` | `publish` | Publishing is owned by the driver and doesn't invoke an agent. |

If an array holds more than one value, the most restrictive wins: `read-only`, then `write-worktree`, then `publish`. An absent or unrecognized request resolves to `read-only` for the adapter. That way an incomplete custom descriptor can't gain write access.

The runner gives an agent adapter `permissions`, `artifactOnly`, and a permission-filtered `addDirs` list. For artifact-only invocations, the working directory is the disposable source snapshot, and the only writable added directories are the run directory and any task-file directory the phase requires.

The built-in adapters use their write-capable headless mode in every case, so the verdict, review, and PR-description files can be written. That's Claude `--permission-mode auto`, Codex `--sandbox workspace-write`, agy `--mode accept-edits` with `--dangerously-skip-permissions`, and Gemini `--approval-mode yolo` with `--skip-trust`. The read-only guarantee comes from the snapshot and the artifact-only directories, not from these flags.

A custom adapter gets the same `cwd` and `addDirs` contract. It must map `permissions` to its own sandbox and approval flags, and aloop can't verify them. Its process is still subject to the driver's post-review tree check.

Hermetic execution is a separate opt-in boundary around agent and gate commands. It doesn't change how permissions resolve. See [Hermetic phase execution](hermetic.md#phase-boundaries) for the resulting mounts.

## Phases

| Phase | Kind | Role | Permission | Interactive policy |
| --- | --- | --- | --- | --- |
| `implement` | agent | Writes code to spec and commits it | `write-worktree` | Required |
| `docs` | agent | Documentation-as-built pass. Commits docs changes. | `write-worktree` | Optional; may be skipped |
| `gate` | shell | Runs the `gate` commands. Exit code decides. | `read-only` | Required |
| `review` | agent | Emits a verdict and writes prose to `RUN_DIR`. The work-item preset may append it to the task file. | `read-only` | Required |
| `address` | agent | Fixes and commits verdict findings, or records a written rebuttal | `write-worktree` | Runs within the required review loop |
| `pr-description` | agent | Writes the title and body to `{{RUN_DIR}}/pr.md` without changing the worktree | `read-only` | Required |
| `publish` | driver | Pushes the attested branch, then creates or updates and verifies the PR through the configured backend | `publish` | Required |

### How the phases fit together

`implement` and `docs` commit their changes before the gate and review loop, so documentation is part of the reviewed cumulative diff. `address` commits fixes, or records a written rebuttal when it disputes a blocking finding.

The generic `review` phase writes prose to `{{RUN_DIR}}/review-round-{{ROUND}}.md` and its machine-readable verdict to `{{VERDICT_FILE}}`. It doesn't modify a task file. `pr-description` makes no code or task-file commits and writes only `{{RUN_DIR}}/pr.md`.

Review uses the configured base branch for the cumulative change. From round two on, it also uses the SHA recorded after the previous review, so it can focus first on the response. The worktree stays isolated from your checkout, and a stalled run leaves the phase commits intact for inspection or resume.

**Clean-tree check.** Before the description and publish phases run, the runner stalls the pipeline if `git status` isn't empty, and reports the offending paths.

**Publish requirements.** Before publishing, the runner requires a clean `HEAD` that matches the SHA of the latest approved review. That approval must be backed by a passing gate that ran over the same SHA before the review. A mismatch or an ungated approval stalls the run. This closes a hole in partial runs that start at `review` (for example `--from review`): review alone can record an approval, but with no gate over the tree, publishing refuses it. Unresolved review findings also block a standalone resume through `publish`, because publishing always needs a completed, gate-backed approval for the current SHA.

**Review is observational.** It must not change the worktree or advance `HEAD`. If a review invocation changes a file, the runner stalls that review. If it also creates a commit, the runner invalidates the completed gate over the review's input SHA. Resuming reruns the gate before another review can approve the changed tree.

**Committed-output postconditions.** For code-producing phases, the runner requires committed output. It doesn't take agent output as evidence of progress.

- `implement` must leave a clean worktree and advance `HEAD` with a new commit.
- When a review has blocking findings, `address` must do the same, unless it records a written rebuttal in `{{RUN_DIR}}/response-round-{{ROUND}}.md`. A clean no-commit `address` is also valid when there were no blocking findings.
- A dirty worktree always stalls. Stdout alone never satisfies a postcondition.

The phase is left incomplete so `--resume` retries it, and the stall points to the phase log. For a commit-required phase, aloop saves the phase's initial `HEAD` as its baseline. If you or another process creates the required clean commit after a stall, `--resume` compares the current `HEAD` with that baseline, records the phase as completed, and skips the agent invocation. `--resume --from <phase>` forces the phase to run and sets a fresh baseline. This guard doesn't apply to `docs` or `review`, which can legitimately produce no code diff.

### Phase descriptors and transitions

Phase descriptors declare control flow. A string name is shorthand for the built-in descriptor. Being adjacent in the list doesn't create a transition: putting `address` after `review` doesn't attach it to the review loop unless the verdict phase declares that repair transition. The built-in shorthand does give the familiar behavior for `['gate', 'review', 'address']`: gate, review, and, while the verdict asks for changes, address, a gate re-check, and another review.

A standalone gate can also declare a `repair` transition. By default the built-in `gate` has none, and stops at its first failed command. When a gate has repairs, aloop records the failed attempt, runs the declared repair phases, then re-runs the original gate. It repeats until the gate passes or the gate's `maxRounds` is exhausted. The final stall reports the last gate output. Repair agents receive the failed gate status in `GATE_STATUS` and should follow the usual code-phase postconditions, leaving a clean, committed repair. Every gate attempt and repair invocation is kept as its own manifest entry.

This opt-in configuration repairs an initially failing gate with the shipped `fix-gate` prompt:

```js
phases: [
  {
    name: 'gate',
    repair: ['fix-gate'],
  },
  {
    name: 'fix-gate',
    kind: 'agent',
    role: 'repair',
    prompt: 'fix-gate',
    permissions: ['write-worktree'],
    postconditions: ['clean-tree', 'head-advanced'],
  },
],
```

As with a verdict repair, a gate repair phase must be named in its owning gate's `repair` list. Putting a repair-role phase next to a gate doesn't create a transition.

If a standalone gate fails and has no repair transition, fix the worktree and resume with `--from gate`. If review already approved that same SHA before the successful gate run, also force a fresh review afterward, so the approval is recorded after the passing receipt:

```sh
aloop --name my-spec --resume --from gate --yes
aloop --name my-spec --resume --from review \
  --note "Re-review the current HEAD after the gate passed." --yes
```

Running only the gate isn't enough here, because publishing requires the passing gate receipt to come before the approved review.

A descriptor can declare its `kind`, `role`, `inputs`, `outputs`, `postconditions`, retry policy, and repair transition. It can also set an agent `prompt`, `optional`, `verdict`, per-verdict `maxRounds`, gate `commands`, or the `requiresCleanTree` precondition. `inputs` and `outputs` are declarative metadata in the normalized plan. The runner doesn't currently enforce data dependencies from them. `permissions` sets the adapter's permission level and the directories it receives, as described under [Phase permissions](#phase-permissions).

A `repair` list, on a verdict phase or repair-enabled gate, holds phase names or inline descriptors. An inline descriptor can add transition-only settings such as `recheck`:

```js
phases: [
  'implement',
  'gate',
  {
    name: 'review',
    kind: 'agent',
    prompt: 'review',
    verdict: true,
    inputs: ['commit', 'gate-result'],
    outputs: ['verdict'],
    postconditions: ['verdict-recorded'],
    retry: { maxAttempts: 2 },
    repair: [
      { name: 'address', role: 'repair' },
      { name: 'gate', recheck: true },
    ],
  },
  { name: 'address', kind: 'agent', prompt: 'address', role: 'repair' },
],
```

The runner verifies `clean-tree`, `head-advanced`, and `head-advanced-or-rebuttal` after an agent phase. For example, the built-in implementation phase requires a clean tree and an advanced `HEAD`. An address phase requires a clean committed tree or a written rebuttal. `gate-passes` and `verdict-recorded` document conditions already enforced by a gate's `kind` and a verdict phase's `verdict: true`. `requiresCleanTree: true` adds the precondition the publishing phase uses.

`retry.maxAttempts` retries a failed invocation, or a failed gate or verdict operation. It's separate from a verdict phase's `maxRounds`, which counts review-and-repair rounds. Every verdict retry must write a fresh artifact for that attempt. A missing or malformed artifact fails closed and never reuses an earlier attempt's approval.

### Custom phases

Add a custom phase by using an object instead of a name. Custom phases are required by default. Set `optional: true` to let an ordinary agent phase be skipped at its interactive prompt. Only the literal boolean `true` works. Gates and verdict phases stay required even with `optional: true`:

```js
phases: [
  'implement',
  'gate',
  { name: 'announce', kind: 'agent', prompt: 'announce', optional: true },
  'review',
  'address',
],
```

## The verdict contract

The review phase writes JSON to the path given in its prompt:

```json
{
  "verdict": "CHANGES_REQUESTED",
  "summary": "Unhandled rejection in the retry path.",
  "blocking": [{ "file": "src/retry.ts", "line": 42, "issue": "..." }],
  "nits": []
}
```

Before each real review invocation, the runner removes any existing verdict file for that round. The reviewer must write a fresh `verdict-round-{{ROUND}}.json`. If it writes nothing, the missing verdict stalls the run, so an earlier approval or rejection is never reused. Dry runs neither remove nor create verdict artifacts.

Parsing fails closed. A missing, malformed, or unrecognized verdict stalls the run and never defaults either way. Defaulting to approval ships unreviewed code, and defaulting to changes burns rounds on a reviewer that isn't reporting.

- `blocking` and `nits` can be omitted and default to empty lists. If supplied, they must be arrays.
- Each finding must be an object with a non-empty `issue` or `summary` string. An included `file` must be a string, and an included `line` must be a number.
- `CHANGES_REQUESTED` needs at least one `blocking` finding. `APPROVED` needs `blocking` to be empty.
- The loop won't exit on approval while the last gate re-check was red. If a reviewer approves anyway with a red repair gate, the run stalls and reports the gate failure, instead of starting a repair with no findings.

### Specialized reviewers

Set `reviewRoles` in `loop.config.mjs` to any subset of `security`, `api-compat`, and `test-quality`, for example `reviewRoles: ['security', 'test-quality']`. The default empty list runs only the generalist reviewer. Duplicate or unknown roles are rejected. A non-empty selection needs a verdict phase named `review` in the resolved phase list.

- Roles run after the generalist, in configuration order.
- Each role has its own prompt, a fresh agent invocation, a verdict file, and a manifest entry. All reviewers examine the same commit in each round.
- Clearing a round requires every reviewer to approve. The loop combines their blockers into one `address` repair, reruns the gate, and invokes every reviewer again.
- The generalist's artifact names are unchanged. Specialized roles write `verdict-review-<role>-round-<n>.json` and `review-review-<role>-round-<n>.md`.
- A final aggregate verdict entry records the reviewer set, and stops publishing from an incomplete review group.
- The role prompts are `review-security.md`, `review-api.md`, and `review-tests.md`. Project prompt overrides use those filenames.
- Specialized reviewers inherit the `review` engine unless an engine is configured for their phase name, such as `review-security`.

## Stopping conditions

The run stops and reports when any of these happens:

- the round cap is reached;
- a standalone gate fails;
- a setup command fails;
- a code phase breaks its committed-output postcondition;
- a verdict can't be parsed;
- publishing can't verify its remote and PR results.

It never merges. An open PR waiting for a human is the correct end state.

## Prompts

Defaults ship in the package. They assume only a git worktree, the task context, the configured gate commands, and the file-based verdict contract. They carry portable workflow rules: judge gates by exit code on unfiltered output, use conventional commits, and leave a clean tree before publishing.

Override one phase by adding a file to `.loop/prompts/` in your project:

```
.loop/prompts/review.md      # overrides only the reviewer
```

Templates use `{{VARIABLE}}` placeholders. An unresolved placeholder throws instead of reaching an agent, which would read it as literal text and improvise around it. The variables:

- Task: `TASK`, `TASK_FILE`, `TASK_NAME`, `TASK_DIR`, `TASK_CONTEXT`.
- Repository: `BRANCH`, `BASE_BRANCH`, `REPO`, `REMOTE`.
- Run: `RUN_DIR`, `GATE_COMMANDS`.
- Verdict loop: `ROUND`, `MAX_ROUNDS`, `VERDICT_FILE`, `REVIEW_FILE`, `FINDINGS`, `GATE_STATUS`, `SINCE_SHA`.

`TASK`, `TASK_FILE`, and `TASK_CONTEXT` are empty when the matching input isn't supplied. `TASK_CONTEXT` is the prompt-ready form of the task: inline text, a reference to the task file, or both. The shipped prompts therefore need no conditional interpolation. Human-readable run artefacts belong in `RUN_DIR`, which always exists for a real run. A dry run only reports its intended path.

### Work-item preset

Repositories that use Markdown task files with status frontmatter and named review and changelog sections can opt into the opinionated work-item flow. The package ships it under `presets/work-item/`, with five prompt overrides, a sample `loop.config.mjs`, and installation guidance.

```sh
aloop --preset work-item --task-file ./work-items/example.md
# or set preset: 'work-item' in loop.config.mjs
```

At run time the preset activates the packaged prompt overrides without copying them into `.loop/prompts/`. Project prompt files still win, file by file. `aloop init --preset work-item` is still useful for an editable copy of the sample config and prompts. The preset assumes task files live in a separate repository and that another workflow commits their updates. Use its configuration only if its branch, engine, phase, and gate settings fit your project.

## Isolation and state

Each run gets a `git worktree` off `baseBranch`. Concurrent runs can't stomp on each other, and a failed run is discarded without touching your checkout. `--base-branch <branch>` overrides `baseBranch` for one run. The resolved base is saved in `state.json`, so `--resume` stays on the branch the run started from. Passing a different base while resuming fails.

Logs, verdicts, `state.json`, `manifest.json`, and `snapshot.json` live in `.loop/runs/<slug>/` in the main repository. That's outside the worktree, so they survive its removal. Add `.loop/runs/` to `.gitignore`. See [Run state and recovery](run-state.md) for the on-disk artefacts, locking, schema compatibility, and crash recovery.

`--resume` reads the state cursor, skips phases already recorded complete, and reloads the manifest so evidence from earlier phases stays with the run. If a verdict loop was left incomplete after a saved review round, resume first replays its unfinished repair phases, including any failed or unrun recheck gate. Then it starts the next review with that review's SHA as `SINCE_SHA`. The pending repair's verdict comes from `state.json`, not from the round's verdict file. When resume reaches a new review invocation, the runner invalidates that round's old verdict file before calling the reviewer. If the saved round has already reached the cap, it stops without another agent invocation.

Before resuming, the runner checks that the saved worktree still exists and is registered for the saved branch. A worktree moved with `git worktree move` is adopted at its registered location. If it was removed or is no longer registered, the runner fails before planning or running a phase. Restore or re-register it with `git worktree`. It won't carry on in a different checkout.

### Run manifest

Every phase action in a real run records an ordered entry in `.loop/runs/<slug>/manifest.json`. The file is independent of `state.json`. `state.json` is the resume cursor, and the manifest is the evidence record of what each phase saw and produced. The top-level shape:

```json
{
  "manifestVersion": 1,
  "phases": [
    {
      "phase": "gate",
      "kind": "gate",
      "role": "gate",
      "inputSha": "<40-character git SHA>",
      "outputSha": "<40-character git SHA>",
      "promptHash": null,
      "configHash": "<64-character SHA-256>",
      "artifacts": ["gate.log"],
      "gateReceipts": [
        { "command": "npm test", "exitCode": 0, "durationMs": 842 }
      ],
      "engine": null,
      "status": "completed",
      "startedAt": "<ISO timestamp>",
      "completedAt": "<ISO timestamp>",
      "durationMs": 843
    }
  ]
}
```

Entry conventions:

- `phase`, `kind`, and `role` identify the configured phase. Roles are `agent`, `repair`, `verdict`, `gate`, and `publish`.
- `inputSha` and `outputSha` are the worktree `HEAD` before and after the phase. A resume completion recognized from a saved commit baseline uses that baseline as `inputSha` and the current `HEAD` as `outputSha`. Skipped entries use `null` for both. Dry runs create no manifest entries. A stalled precondition can record the same SHA on both sides.
- `promptHash` is the SHA-256 of the fully rendered prompt. `configHash` is the SHA-256 of the resolved configuration, after stable key ordering and removal of function-valued fields. Both are deterministic.
- Agent entries with a `promptHash` also include `promptInput`: the template name and body, the exact interpolation variables, and the operator note used. `aloop replay <name>` uses these to recompute `promptHash`. Older entries may lack `promptInput` and are reported as unverifiable.
- `artifacts` are paths relative to the run directory: phase logs, review and response markdown, and verdict JSON files.
- `gateReceipts` records each gate command that ran, with exit code and duration. A failing gate includes the earlier successful commands and the failed one, and stops there.
- Agent entries include the effective `engine` descriptor (`name`, plus any configured `model` or `effort`). Gate entries use `null` and report no model usage.
- Agent entries may include numeric `tokens` and `cost` when the adapter reports them. `durationMs` is recorded for every phase action that runs. Skipped entries have no usage values.
- Review and repair entries include their `round` when they belong to a review loop, so the metrics view can match verdicts and repairs to their round.
- `verdict` appears on verdict entries. It holds the parsed verdict fields plus `sha`, binding the verdict to the reviewed `HEAD`.
- A configured reviewer group records each role's verdict separately, followed by an aggregate verdict with `aggregate: true` and `reviewerSet`.
- Publish entries may include `approvedSha`, `remoteSha`, `prUrl`, and the verified `pullRequest` object. After a successful publish, the top-level manifest and state also keep the final PR URL and metadata.
- `status` is `completed`, `stalled`, or `skipped`. An agent command failure also includes a `failure` object with the command, exit code when known, and a timeout flag. A budget stop adds `budgetStall: true` and a `failure` object with the reason, measured usage, and limit. Timestamps are ISO strings, and `durationMs` is present for phases that ran. Budget-stall bookkeeping entries aren't engine invocations and have no usage values.

The runner writes the manifest alongside state after each recorded phase, so a stalled run keeps the evidence needed to inspect or resume it. `--dry-run` stays free of side effects. It renders and prints the plan, but creates no run directory, `state.json`, or `manifest.json`.

## Two repositories

A task file is optional, and can live in the code repository or a separate one. When you pass `--task-file <path>`, the runner finds the file's Git repository and gives agent adapters the run directory as an extra directory.

- **Artifact-only phases** also get the task-file repository as an artifact directory, so review can append its required `## Code Review` section.
- **`write-worktree` phases** get an external task-file repository, or the containing source directory for a same-repository task file, as an extra `--add-dir`. This lets them read or update the task file when their prompt says to.
- `TASK_FILE` stays the source-checkout path.
- A run with no task file adds no task-file directory.

`implement` and `docs` commit their changes in the code repository. `address` commits fixes, or records a rebuttal in the run directory. Task-file edits aren't code commits. A separate workflow can commit them in the task-file repository. With no `--task-file`, there's no external task repository to add and no task-file changelog or `## Code Review` workflow. Review verdicts still live in the run directory.

## Building up to unattended

Don't start at `-y`. Each step should feel boring before you take the next.

1. `--dry-run`: read the rendered prompts.
2. Default confirmation mode, one representative task, watching every phase.
3. `--max-rounds 2`, watching the review loop closely. This is where you learn whether your reviewer's verdicts are consistent enough to automate. If they aren't, no amount of driver work will fix it.
4. `-y` on task shapes whose behavior you've already seen succeed.

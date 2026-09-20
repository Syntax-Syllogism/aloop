---
title: Agentic loop runner
---

# Agentic loop runner

`@syntax-syllogism/aloop` runs a task through implementation, review,
documentation, and publishing without a human relaying prompts between steps. The
`aloop` CLI is the driver; the agents are the steps.

## The split

The runner is deliberately not an agent. A dumb, deterministic driver owns
control flow — iteration caps, retries, state, exit conditions — and calls
stateless agent invocations that own judgment. Everything else follows from
that split:

- **Steps communicate through files, never through a session.** No step depends
  on another step's context window, so any phase can run on any engine.
- **Exit conditions are machine-readable.** The review phase writes a verdict
  JSON the driver parses. Prose is for humans; the driver never reads stdout.
- **Deterministic checks run in the driver.** Anything a compiler or test suite
  can decide is decided by exit code, not by asking an agent how it went.
- **Every phase is a fresh context.** The reviewer has not absorbed the
  implementer's rationalizations, and round three is as sharp as round one.

## Usage

```bash
aloop --task-file ./work-items/afmt-clippy-cleanup.md
```

The runner confirms before each phase by default. At a prompt, Enter or `y`
runs the phase and `q` stops the run. Any other answer is a skip request, but
only optional phases may be skipped: declining a required phase explains that
it must run and prompts again to run or quit. Add `-y` once a pipeline has
earned it.

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
      --from <phase>      Start at this phase
      --resume            Skip phases already recorded complete
      --note <text>       Give the target agent an authoritative instruction
      --note-file <path>  Read that instruction from a file (--note wins)
  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)
      --no-worktree       Work in the current checkout instead of a worktree
      --no-tui            Force plain streaming output (TUI is on by default on a TTY)
      --dry-run           Print the plan and rendered prompts, run nothing
```

On a TTY, `aloop` shows a live dashboard — phases with their status, the
current diff, review findings, running cost, and produced artifacts — instead
of raw streaming output. It is purely a view: it reads the same manifest/state
the run already persists after each phase and never changes run behavior.
It automatically steps aside for piped output or CI; pass `--no-tui` to force
plain streaming on a TTY. `--yes` only skips per-phase confirmation, so an
unattended run on a real terminal still shows the live dashboard.

`--dry-run` renders every prompt with real values and executes nothing. It
reports the run directory, worktree, and branch it would use without creating
any of them. Use it whenever you change a prompt or a phase list.

The task input is optional and can be supplied in four ways:

- `--task <text>` provides inline requirements.
- `--task-file <path>` provides a plan, specification, ticket, or work item.
- Both flags provide inline requirements plus the full task file.
- With neither flag, `--name <slug>` is required and the run has no task
  content.

Run identity comes from `--name` when it is supplied; otherwise it is derived
from the task-file name. The identity determines the default branch and run
directory, and is persisted in `state.json` for `--resume`. A task file read
from standard input is materialized as `task.md` in the run directory for a
real run.

`--task-file -` reads the task from standard input. A real run materializes it
as `task.md` in the run directory; a dry run consumes it only to validate and
render the planned prompts, without writing it. On POSIX systems, a piped run
reads its per-phase confirmations from `/dev/tty`, so this works interactively:

```sh
some-task-source fetch 123 | aloop --task-file - --name my-spec
```

Add `--yes` to run unattended. If no controlling terminal is available, the
runner reports an error and asks for `--yes`; `--dry-run` does not need `--yes`.

## Getting started

Set up a repository with an editable configuration and a full local copy of the
prompt templates:

```sh
aloop init
```

This creates `loop.config.mjs` and `.loop/prompts/*.md` in the current
directory. Review the comments at the top of the generated config before the
first run, especially `baseBranch`, `remote`, and `engines`. You can change
phases and gates at any time, and edit any local prompt to tailor its phase.

To start with one of the bundled presets instead, use its name:

```sh
aloop init --preset work-item
```

Preset prompts overlay the packaged defaults, so even a partial preset produces
a complete `.loop/prompts/` directory. `init` refuses to replace scaffold files
that already exist. Re-run with `--force` to replace the config and managed
prompt files; extra prompt files you added are left untouched. Add `--json` for
an object listing the created files and selected preset.

Windows is supported through Git Bash (Git for Windows), not native
`cmd.exe`/PowerShell. Ensure Git's `sh.exe` is on `PATH` before starting
aloop; setup and gate commands continue to run through the configured
`shell -c` seam (default: `sh`). Git Bash's Windows console input is used for
interactive confirmation when available. WSL works as Linux. See
[Platform support](platform.md) for the command, timeout, and terminal
behavior behind this support.

## Run metrics

Completed and stalled runs retain per-phase duration and, when an adapter
reports them, token and cost usage in `manifest.json`. Usage is optional and
engine-neutral; unavailable values are shown as unknown rather than estimated.

Use the read-only operations to inspect those measurements:

```sh
aloop status <name>
aloop inspect <name> --json
aloop list --metrics
aloop metrics --json
```

Metrics include per-phase and per-run totals, stall rates, rounds to approval,
reviewer catch rate, and findings cleared during repair rounds. Aggregates are
computed on demand from saved manifests, so there is no rollup file to repair
or invalidate. See [Cost and quality metrics](metrics.md) for the output shape,
unknown-value semantics, and usage adapter contract.

Resume with the saved run identity. The stalled-run hint always includes the
persisted `--name` and includes a real task-file path when one was supplied;
for a materialized stdin task, resume with that name alone:

```sh
aloop --name my-spec --resume
```

Before reading stdin or recording new task state, the runner rejects conflicting
explicit `--name` or `--task` values, and conflicting task-file values for a
saved task-backed run. A matching stdin resume reuses the existing
`RUN_DIR/task.md` instead of reading stdin again.

### Operator-guided resume

Use `--note` or `--note-file` to give one agent invocation an authoritative
instruction when resuming a stalled run. The note is prepended to the rendered
prompt before its hash is recorded, so the manifest retains evidence of the
exact guided invocation. `--note` takes precedence when both forms are given;
the file path is resolved from the current directory, and either form must
contain non-whitespace text.

Without `--from`, the note targets the first phase that will run: the first
phase in a fresh run, or the first incomplete phase on resume. `--from` targets
that named phase instead. A noted `--from` phase is run even if it was already
recorded complete, which is useful for directing a phase to finish preserved
work:

```sh
aloop --name my-spec --resume --from implement \
  --note "The implementation is present; commit it and complete the phase."
```

Notes are invocation-local and are not saved in `state.json`; a later ordinary
`--resume` does not receive an earlier note. The target must be an agent phase.
A repair-enabled gate is the one exception: its note is delivered to each
agent repair it invokes after a gate failure. A gate without an agent repair and
a publish phase reject `--note`, because they have no agent prompt to guide.

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
  gate: ['npm test'],
  publish: { backend: 'github', draft: true },
  setup: ['npm ci'],
  maxRounds: 3,
  timeoutMs: 30 * 60 * 1000,
  budget: {
    tokens: 100000,
    usd: 5,
    wallClockMs: 45 * 60 * 1000,
  },
};
```

Pass `--config path/to/loop.config.mjs` to use a configuration file outside the
repository (relative paths resolve from your current directory). The supplied
file replaces the repository's `loop.config.mjs`; command-line overrides such
as `--phases` and `--max-rounds` still take precedence.

Configuration loading rejects a publish-breaking phase order before any
worktree or agent work starts. After phase descriptors and repair transitions
are normalized, each publishing phase is checked against its latest preceding
verdict. A commit-producing phase (one whose `outputs` includes `commit`) may
not appear between that verdict and the publishing phase. The loader applies
this rule independently at every publishing boundary, so
`review → docs → publish → final-review` is rejected: `docs` advances `HEAD`
after `review` has approved it, even though another verdict is configured
later. The publishing boundary is a `publish` phase or a phase declared with
`requiresCleanTree: true` or a pull-request output. This keeps each published
`HEAD` equal to the tree approved by its latest gate-backed review. Move
documentation or other commit-producing phases before the relevant
gate/review loop; the loader reports the offending phase names instead of
silently reordering the configuration. Pipelines without a preceding verdict
for a publishing phase or without a publishing boundary are not subject to
this specific check.

Optional runtime isolation is configured independently from phase permissions;
see [Hermetic phase execution](hermetic.md) for container wrapping, network
defaults, environment forwarding, publish credentials, and snapshot evidence.

An `engines` entry can be the original engine-name string or a descriptor with
`name` plus optional `model` and `effort` fields. An omitted phase inherits the
entire `default` descriptor; a phase descriptor replaces it. Model names are
passed through to the selected CLI, while effort is validated before a phase
starts:

| Engine | Model option | Effort option | Supported effort |
| --- | --- | --- | --- |
| `claude` | `--model` | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `--model` | `-c model_reasoning_effort=…` | `low`, `medium`, `high`, `xhigh`, `max` |
| `agy` | `--model` | `--effort` | `low`, `medium`, `high` |
| `gemini` | `--model` | — | none (Gemini CLI has no effort flag; a configured `effort` is ignored) |
| configured adapter name | adapter-defined | adapter-defined | adapter's `efforts`, or any value when omitted |

The `adapters` map registers additional engines without changing the package.
Its keys are usable as `engines.*.name` values. A configured adapter with the
same name as a built-in takes precedence, so it can also customize a built-in
invocation. An adapter may declare an `efforts` array; when it does not, the
configured effort is passed through without validation. If `createRenderer`
is omitted, the runner uses its plain-text passthrough renderer.

An adapter renderer may expose `usage()`, returning normalized numeric `tokens`
and/or `cost` values. An adapter may also expose the same `usage()` hook when it
does not provide a renderer. The runner copies reported values into the phase
manifest; adapters that cannot report usage simply omit them. See
[Cost and quality metrics](metrics.md#usage-capture) for the built-in JSONL
normalization rules.

### Bring your own engine

An adapter is a small ES module object whose `command` function returns one
process invocation. For example, an opencode-style adapter can be configured
like this:

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

**A custom engine must run fully non-interactively and be allowed to edit files
and run shell commands. Include its auto-approve and writable-directory flags
in `command`; otherwise a phase can wait for input until the timeout.** The
runner cannot verify those vendor-specific flags. The built-ins use equivalent
headless permissions: Claude `--permission-mode auto`, Codex
`--sandbox workspace-write`, agy `--dangerously-skip-permissions`, and Gemini
`--approval-mode yolo` with `--skip-trust`.

The verdict contract remains file-based: the engine only needs to execute the
prompt and write the files requested by it. A resumed run re-reads adapters from
`loop.config.mjs`; the same config must still define any custom adapter used by
the saved engine settings.

`--engine` changes the default executable. It keeps the configured model and
effort only when the engine is unchanged; switching to a different engine drops
them, because a model or effort string is vendor-specific (`gpt-5.6-terra` means
nothing to Gemini) and carrying it over would hand the new engine a name it
rejects. Set the new engine's model with `--model` (and effort with `--effort`),
or configure it in `loop.config.mjs`. `--model` and `--effort` also work on their
own to override just the default engine's model or effort. Dry runs and phase
logs print the effective engine settings. They are saved in run state on the
first real run; `--resume` uses those saved settings even if `loop.config.mjs`
has changed, so a resumed run remains auditable and reproducible.

`--resume --config path/to/loop.config.mjs` deliberately replaces those saved
settings and every other configurable pipeline value, including engines, phase
definitions, gates, prompts, timeouts, round caps, and budgets. It cannot change
the already-created branch, worktree, or persisted base branch; those identify the
run being resumed. Keep `runsDir` unchanged so the runner can find that saved
run. Do not combine it with `--override-engine`: set the desired engines in the
supplied config instead. The runner snapshots every resume override in
`state.json`, including its source path and resolved values.

To deliberately move an interrupted run to another executable, use
`--resume --engine <name> --override-engine`. It replaces the saved engine for
every agent phase, dropping each phase's saved model and effort (they are
vendor-specific and would not apply to the new engine). Add `--model` and
`--effort` to set them for the new engine; without them each phase uses the new
engine's default. The new combination is validated before a phase starts. The
runner records the before and after settings in `state.json`, prints the change
at resume time, and adds it to each affected phase log header.

`remote` is the push target for the `publish` phase. Left unset it detects one,
preferring `origin` — set it explicitly in any repo with several remotes, since
pushing a feature branch to the wrong one is not something the run can undo.
A configured remote that does not exist fails before any phase runs.

`publish` defaults to `{ backend: 'github', draft: true }`. The bundled GitHub
and GitLab backends require authenticated `gh` and `glab` CLIs respectively;
both push without force, then verify the remote branch SHA and PR/MR URL,
number, base, head SHA, and draft state. A custom backend object can be
supplied as `publish.backend` with `precheck`, `view`, `create`, and `update`
operations. See [Publishing](publishing.md) for the backend-specific setup,
description format, operation contract, and failure behavior.

Use `--base-branch feat/a` to build and open a stacked PR on top of another
local branch. The branch must exist locally; the flag does not fetch remote-only
refs.

`gate` commands run through `shell -c`, where `shell` defaults to `sh` and can
be configured in `loop.config.mjs`. Quoting, pipes, `&&`, and environment
variables all work. They are judged by process exit code on unfiltered output. Prefer
invoking the compiler directly over a cached wrapper script: a cached build can
report success without compiling anything, and a wrapper that summarizes output
can invent a failure the tool never produced.

`setup` is an optional list of shell commands run once when the runner adds a
new worktree, before phase 1. This also covers a fresh worktree for a branch
that already exists; branch creation and worktree creation are tracked
separately. It uses the same configured `shell` as gate commands. It defaults
to an empty list, so the generic runner does not assume a package manager. Setup
runs in the worktree and uses the same timeout as other
commands; a non-zero exit or timeout aborts the run before any phase starts. It
is skipped for resumed or reused worktrees and during `--dry-run`.

### Run budgets

`budget` declares optional run-level ceilings. `tokens` must be a nonnegative
integer; `usd` and `wallClockMs` must be nonnegative finite numbers. An empty
object (the default) disables budget enforcement. The limits are cumulative
across the run, including review rounds and repairs:

```js
budget: {
  tokens: 100000,
  usd: 5,
  wallClockMs: 45 * 60 * 1000,
},
```

The runner checks the measured totals before starting each phase and each
repair or review action. It does not interrupt an in-flight engine request;
usage is checked again at the next boundary. A completed final phase is also
checked after it runs. If a limit is reached, the run stalls with a reason such
as `budget exhausted: tokens` and records the usage and limit in the manifest.

Token and dollar limits require the corresponding usage measurement from the
adapter. When a configured measurement is unavailable, the runner warns and
does not treat the unknown value as zero or enforce that particular limit;
other measurable limits can still be enforced. Wall-clock usage is measured
from the saved run start time.

Budget stalls are resumable. An unchanged limit stalls again before more work
runs. If the final phase already completed when the limit was reached, its
checkpoint is marked `budgetExhausted`; raising the limit and resuming clears
that checkpoint without rerunning the completed final action. See [Run state
and recovery](run-state.md#starting-and-resuming) for the persisted checkpoint.

Running `review` on a different engine than `implement` is the main reason to be
multi-CLI. Different model families fail differently, so the reviewer's blind
spots do not overlap with the implementer's.

### Phase permissions

Every normalized phase has a `permissions` array. The supported values are
`read-only`, `write-worktree`, and `publish`. Configuration rejects unknown
values. If a custom phase omits the field or supplies an empty array, it
defaults to `read-only`; a custom phase with `kind: 'publish'` defaults to
`publish`.

The built-in phases use these levels:

| Permission | Built-in phases | Agent access and behavior |
| --- | --- | --- |
| `read-only` | `gate`, `review`, `pr-description` | Agent phases run from a disposable read-only source snapshot of the saved worktree. They can write only the run artifacts, plus the task-file artifact directory for the verdict/review phase. Shell gates do not invoke an agent adapter. |
| `write-worktree` | `implement`, `docs`, `address` | Agent phases may modify and commit the worktree. The adapter receives the run directory and any task-file directory needed by the phase. |
| `publish` | `publish` | Publishing is driver-owned and does not invoke an agent. |

The permission level is resolved conservatively when an array contains more
than one value: `read-only` takes precedence, then `write-worktree`, then
`publish`; an absent or unrecognized request resolves to `read-only` for the
adapter. This keeps an incomplete custom descriptor from gaining write
access.

The runner passes `permissions`, `artifactOnly`, and a permission-filtered
`addDirs` list to an agent adapter. For artifact-only invocations, the
working directory is the disposable source snapshot, while the run directory
and any phase-required task-file directory are the only writable added
directories. Built-in adapters use their write-capable headless mode so the
required verdict, review, and PR-description files can be written: Claude
`--permission-mode auto`, Codex `--sandbox workspace-write`, agy
`--mode accept-edits` with `--dangerously-skip-permissions`, and Gemini
`--approval-mode yolo` with `--skip-trust`. A custom adapter receives the same
`cwd` and `addDirs` contract and must map `permissions` to its own sandbox and
approval flags; its process remains subject to the driver's post-review tree
check. `write-worktree` maps to Claude
`--permission-mode auto`, Codex `--sandbox workspace-write`, agy's
`--mode accept-edits` with `--dangerously-skip-permissions`, and Gemini's
`--approval-mode yolo` with `--skip-trust`. Vendor-specific
custom adapters must map the permission request to their own sandbox and
approval flags; aloop cannot verify those flags.

Hermetic execution is a separate opt-in boundary around agent and gate
commands. It does not change the permission resolution above; see
[Hermetic phase execution](hermetic.md#phase-boundaries) for the resulting
mounts and runtime behavior.

## Phases

| Phase | Kind | Role | Permission | Interactive policy |
| --- | --- | --- | --- | --- |
| `implement` | agent | Writes code to spec; commits its implementation | `write-worktree` | Required |
| `docs` | agent | Documentation-as-built pass; commits docs changes | `write-worktree` | Optional; may be skipped |
| `gate` | shell | Runs `gate` commands; exit code decides | `read-only` | Required |
| `review` | agent | Emits a verdict and writes prose to `RUN_DIR`; the work-item preset may append it to the task file | `read-only` | Required |
| `address` | agent | Repairs and commits verdict findings, or records a written rebuttal | `write-worktree` | Runs within the required review loop |
| `pr-description` | agent | Writes the title and body to `{{RUN_DIR}}/pr.md` without changing the worktree | `read-only` | Required |
| `publish` | driver | Pushes the attested branch and creates or updates and verifies the PR through the configured backend | `publish` | Required |

The implementation and docs phases commit their respective changes before the gate and
review loop, so documentation is included in the reviewed cumulative diff. The
`address` phase commits fixes or records a written rebuttal when it disputes a
blocking finding.
The generic `review` phase writes human-readable prose to
`{{RUN_DIR}}/review-round-{{ROUND}}.md`, while its machine-readable verdict is
written to `{{VERDICT_FILE}}`; it does not modify a task file. The
`pr-description` phase creates no code or task-file commits and writes only
`{{RUN_DIR}}/pr.md`. The clean-tree check is deterministic: before the
description and publish phases run, the runner stalls the pipeline if
`git status` is not empty, reporting the offending paths. Before publishing,
the runner also requires a clean `HEAD` to match the SHA from the
latest approved review, and that approval must be backed by a passing gate that
ran over the same SHA before the review; a mismatch or an ungated approval
stalls the run. This closes a partial run that starts at `review` (for example
`--from review`): review alone can record an approval, but with no gate over the
tree publishing refuses it. Unresolved review findings also block a standalone
resume through `publish`: publishing always requires a completed, gate-backed
approval for the current SHA. Review uses the configured base branch
for the cumulative change and, from round two
onward, the SHA recorded after the previous review to focus first on its
response. The worktree remains isolated from your checkout, and a stalled run
leaves the phase commits intact for inspection or resume.

Review is observational and must not change the worktree or advance `HEAD`.
If a review invocation changes a file, the runner stalls that review. If it
also creates a commit, the runner invalidates the completed gate over the
review's input SHA; resuming reruns the gate before another review can approve
the changed tree.

For the code-producing phases, the runner enforces a committed-output
postcondition rather than treating agent output as evidence of progress.
`implement` must leave a clean worktree and advance `HEAD` with a new commit.
When a review has blocking findings, `address` must do the same unless it
records a written rebuttal in
`{{RUN_DIR}}/response-round-{{ROUND}}.md`; a clean no-commit `address` phase is
also valid when there were no blocking findings. A dirty worktree always
stalls, and stdout alone never satisfies the postcondition. The phase is left
incomplete so `--resume` retries it; the stall points to the phase log. For a
commit-required phase, aloop persists the phase's initial `HEAD` as its
baseline. If an operator or another process creates the required clean commit
after a stall, `--resume` compares the current `HEAD` with that original
baseline, records the phase as completed, and skips the agent invocation. A
resume with `--from <phase> --note ...` deliberately forces that phase to run
and establishes a fresh baseline. This guard does not apply to `docs` or
`review`, which may legitimately produce no code diff.

Phase control flow is declared by phase descriptors. String names remain a
shorthand for the built-in descriptors, but list adjacency does not create
transitions: placing `address` after `review` does not attach it to the review
loop unless the verdict phase declares that repair transition. The built-in
shorthand still provides the familiar behavior for
`['gate', 'review', 'address']`: gate, review, and, while the verdict requests
changes, address, gate re-check, and another review.

A standalone gate can also declare a `repair` transition. By default, the
built-in `gate` has no transition and stops on its first failed command. When a
gate has repairs, aloop records the failed gate attempt, runs the declared
repair phases, then re-runs the original gate. It repeats that sequence until
the gate passes or the gate's `maxRounds` limit is exhausted; the final stall
reports the last gate output. Repair agents receive the failed gate status in
`GATE_STATUS` and should use normal code-phase postconditions to leave a clean,
committed repair. Each gate attempt and repair invocation is retained as a
separate manifest entry.

For example, this opt-in configuration repairs an initially failing gate with
the shipped `fix-gate` prompt:

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

Like a verdict repair, a gate repair phase must be named by its owning gate's
`repair` list; merely placing a repair-role phase next to a gate does not create
a transition.

A descriptor can declare its `kind`, `role`, `inputs`, `outputs`,
`postconditions`, retry policy, and repair transition. It can also set an agent
`prompt`, `optional`, `verdict`, per-verdict `maxRounds`, gate `commands`, or
the `requiresCleanTree` precondition. `inputs` and `outputs` are declarative
metadata in the normalized plan; the runner does not currently enforce data
dependencies from those fields. `permissions` controls the adapter's
permission level and the directories it receives, as described in [Phase
permissions](#phase-permissions). A verdict phase or repair-enabled gate's
`repair` list contains phase names or inline descriptors; an inline descriptor can add
transition-only settings such as `recheck`:

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

`clean-tree`, `head-advanced`, and `head-advanced-or-rebuttal` are the
postconditions the runner verifies after an agent phase. For example, the
built-in implementation phase requires a clean tree and an advanced `HEAD`,
while an address phase requires a clean committed tree or a written rebuttal.
`gate-passes` and `verdict-recorded` document the conditions enforced by a
gate's `kind` and a verdict phase's `verdict: true`, respectively.
`requiresCleanTree: true` adds the precondition used by the publishing phase.
`retry.maxAttempts` retries a failed invocation or a failed gate/verdict
operation; it is separate from a verdict phase's `maxRounds`, which counts
review-and-repair rounds. Every verdict retry must write a fresh artifact for
that attempt. A missing or malformed artifact fails closed rather than reusing
an earlier attempt's approval.

Add a custom phase by using an object instead of a name. Custom phases are
required by default. Set `optional: true` to make an ordinary agent phase
skippable at its interactive prompt; only the literal boolean `true` enables
this. Gates and verdict phases remain required even when configured with
`optional: true`:

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

Before each real review invocation, the runner removes any existing verdict
file for that round. The reviewer must therefore write a fresh
`verdict-round-{{ROUND}}.json`; if it writes nothing, the missing verdict stalls
the run instead of allowing an earlier approval or rejection to be reused.
Dry runs do not remove or create verdict artifacts.

Parsing fails closed. A missing, malformed, or unrecognized verdict stalls the
run rather than defaulting either way: defaulting to approval ships unreviewed
code, and defaulting to changes burns rounds against a reviewer that is not
reporting. `blocking` and `nits` may be omitted (they default to empty lists),
but when supplied they must be arrays. Each finding must be an object with a
non-empty `issue` or `summary` string; an included `file` must be a string and
an included `line` must be a number.

`CHANGES_REQUESTED` requires at least one `blocking` finding, while `APPROVED`
requires `blocking` to be empty. The loop also will not exit on approval while
the last gate re-check was red. If a reviewer nevertheless approves with a red
repair gate, the run stalls and reports that gate failure instead of attempting
a repair phase without findings.

## Stopping conditions

The run stops and reports when the round cap is reached, a standalone gate
fails, a setup command fails, a code phase violates its committed-output
postcondition, a verdict cannot be parsed, or publishing cannot verify its
remote and PR results. It never merges — an open PR awaiting a human is the
correct end state.

## Prompts

Defaults ship in the package and assume only a git worktree, the task context,
the configured gate commands, and the file-based verdict contract. They keep
portable workflow rules such as judging gates by exit code on unfiltered output,
using conventional commits, and leaving a clean tree before publishing.

Override one phase by dropping a file in `.loop/prompts/` in the project:

```
.loop/prompts/review.md      # overrides only the reviewer
```

Templates use `{{VARIABLE}}` placeholders. An unresolved placeholder throws
rather than reaching an agent, which would otherwise read it as literal text and
improvise around it. Available variables are:

- Task: `TASK`, `TASK_FILE`, `TASK_NAME`, `TASK_DIR`, `TASK_CONTEXT`.
- Repository: `BRANCH`, `BASE_BRANCH`, `REPO`, `REMOTE`.
- Run: `RUN_DIR`, `GATE_COMMANDS`.
- Verdict loop: `ROUND`, `MAX_ROUNDS`, `VERDICT_FILE`, `FINDINGS`,
  `GATE_STATUS`, and `SINCE_SHA`.

`TASK`, `TASK_FILE`, and `TASK_CONTEXT` are empty when no corresponding input
is supplied. `TASK_CONTEXT` is the prompt-ready form of the task: it includes
inline text, a reference to the task file, or both, so the shipped prompts do
not need conditional interpolation. Human-readable run artefacts belong in
`RUN_DIR`, which always exists for a real run; a dry run reports only its
intended path.

### Work-item preset

Repositories that use Markdown task files with status frontmatter and named
review/changelog sections can opt into the opinionated work-item flow. The
package ships it under `presets/work-item/`, including the five prompt
overrides, a sample `loop.config.mjs`, and installation guidance.

```sh
aloop init --preset work-item
```

The command copies the sample configuration and prompt overrides into the
project, with packaged defaults filling any prompts the preset does not provide.
The preset assumes task files live in a separate repository and that another
workflow commits those task-file updates. Use its configuration only when its
branch, engine, phase, and gate settings match the project.

## Isolation and state

Each run gets a `git worktree` off `baseBranch`, so concurrent runs cannot stomp
each other and a failed run is discarded without touching your checkout.
`--base-branch <branch>` overrides `baseBranch` for one run. The resolved base
is persisted in `state.json`, so `--resume` stays pinned to the branch the run
started from; passing a different base while resuming fails.

Logs, verdicts, `state.json`, `manifest.json`, and `snapshot.json` live in
`.loop/runs/<slug>/` in the main repository — outside the worktree, so they
survive its removal. Add `.loop/runs/` to `.gitignore`. See [Run state and recovery](run-state.md)
for the on-disk artefacts, locking, schema compatibility, and crash-recovery guarantees.
`--resume` reads the
state cursor and skips phases already recorded complete; it also reloads the
manifest so evidence from earlier phases remains with the run. If an
incomplete verdict loop has a persisted review round, resume first replays its
unfinished repair phases (including any failed or unrun recheck gate), then
starts the next review with that review's SHA as `SINCE_SHA`. The pending
repair's verdict is read from `state.json`; it does not depend on the round's
verdict file. When resume reaches a new review invocation, the runner
invalidates that round's old verdict file before calling the reviewer. It stops
without another agent invocation when the persisted round has reached the cap.

### Run manifest

Every phase action in a real run records an ordered entry in
`.loop/runs/<slug>/manifest.json`. The file is independent of `state.json`:
`state.json` is the resumability cursor, while the manifest is the evidence
record for what each phase saw and produced. A manifest has this top-level
shape:

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

Entries use these conventions:

- `phase`, `kind`, and `role` identify the configured phase. Roles are
  `agent`, `repair`, `verdict`, `gate`, and `publish`.
- `inputSha` and `outputSha` are the worktree `HEAD` before and after the phase.
  A resume completion recognized from a persisted commit baseline uses that
  baseline as `inputSha` and the current `HEAD` as `outputSha`. Skipped entries
  use `null` for both values; dry runs create no manifest entries. A stalled
  precondition can record the same SHA on both sides.
- `promptHash` is the SHA-256 of the fully rendered prompt text. `configHash`
  is the SHA-256 of the resolved configuration after stable key ordering and
  removal of function-valued fields. Both hashes are deterministic.
- `artifacts` contains paths relative to the run directory, such as phase logs,
  review and response markdown, and verdict JSON files.
- `gateReceipts` records each gate command that ran with its exit code and
  duration. A failing gate includes successful earlier commands and the failed
  command, then stops at that command.
- Agent entries include the effective `engine` descriptor (`name`, and any
  configured `model` or `effort`). Gate entries use `null` for `engine` and do
  not report model usage.
- Agent entries may include numeric `tokens` and `cost` values when the adapter
  reports them. `durationMs` is recorded for every phase action that runs;
  skipped entries use `null` for the SHA fields and do not have usage values.
- Review and repair entries include their `round` when they belong to a review
  loop. This lets the metrics view associate verdicts and repairs with the
  round that produced them.
- `verdict` appears on verdict entries and includes the parsed verdict fields
  plus `sha`, binding that verdict to the reviewed `HEAD`.
- Publish entries may include `approvedSha`, `remoteSha`, `prUrl`, and the
  verified `pullRequest` object. The top-level manifest and state also retain
  the final PR URL and metadata after a successful publish.
- `status` is `completed`, `stalled`, or `skipped`. Agent command failures also
  include a `failure` object with the command, exit code when available, and
  timeout flag. A budget stop adds `budgetStall: true` and a `failure` object
  with the exhausted budget's reason, measured usage, and limit. Timestamps
  are ISO strings; `durationMs` is present for phases that actually ran.
  Budget-stall bookkeeping entries do not represent an engine invocation and
  do not contain usage values.

The runner writes the manifest alongside state after each recorded phase, so a
stalled run retains the evidence needed to inspect or resume it. `--dry-run`
remains observationally pure: it renders and prints the plan but creates no
run directory, `state.json`, or `manifest.json`.

Before resuming, the runner verifies that the saved worktree still exists and
is registered for the saved branch. A worktree moved with `git worktree move`
is adopted at its registered location. If it was removed or is no longer
registered, the runner fails before planning or running a phase; restore it or
re-register it with `git worktree` before resuming rather than continuing in a
different checkout.

## Two repositories

A task file is optional and may live in the code repository or in a separate
repository. When `--task-file <path>` is supplied, the runner resolves the
file's Git repository and gives agent adapters the run directory as an extra
directory. For artifact-only phases, the task-file repository is also supplied
as an artifact directory so review can append its required `## Code Review`
section. For `write-worktree` phases, an external task-file repository or
the containing source directory for a same-repository task file is also passed
as an additional `--add-dir`; this lets those phases read or update the task
file when their prompt calls for it. `TASK_FILE` remains the source-checkout
path. A run without a task file adds no task-file directory.

The implementation and docs phases commit their changes in the code repository;
the address phase commits fixes or records a rebuttal in the run directory.
Task-file edits are not code commits; a separate workflow can commit them in
the task-file repository. When no `--task-file` is supplied, there is no
external task repository to add and no task-file changelog or `## Code Review`
update workflow. Review verdicts still live in the run directory.

## Building up to unattended

Do not start at `-y`. Each rung should be boring before you climb the next.

1. `--dry-run` — read the rendered prompts.
2. Default confirmation mode, one representative task, watching every phase.
3. `--max-rounds 2` and watch the review loop specifically. This is where you
   learn whether your reviewer's verdicts are consistent enough to automate. If
   they are not, no amount of driver work fixes it.
4. `-y` on task shapes whose behavior you have already seen succeed.

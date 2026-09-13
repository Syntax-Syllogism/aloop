---
title: Agentic loop runner
---

# Agentic loop runner

`@syntax-syllogism/aloop` runs a task through implementation, review,
documentation, and git without a human relaying prompts between steps. The
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

The runner confirms before each phase by default. Add `-y` once a pipeline has
earned it.

```
  -t, --task <text>       Inline task description
  -f, --task-file <path>  Path to a task/plan/spec file
  -n, --name <slug>       Explicit run identity/slug
  -b, --branch <name>     Branch to build on (default: <branchPrefix><name>)
      --base-branch <branch>  Base to branch from and PR against (default: baseBranch config)
  -e, --engine <name>     Default engine: claude | codex | agy
      --override-engine   With --resume and --engine, replace saved agent executables
      --config <path>     Load loop configuration from this file
      --phases a,b,c      Override the configured phase list
      --max-rounds <n>    Cap on review/repair rounds
      --from <phase>      Start at this phase
      --resume            Skip phases already recorded complete
  -y, --yes               Run unattended (no per-phase confirmation; required without a terminal)
      --no-worktree       Work in the current checkout instead of a worktree
      --dry-run           Print the plan and rendered prompts, run nothing
```

`--dry-run` renders every prompt with real values and executes nothing. Use it
whenever you change a prompt or a phase list.

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

`--task-file -` reads the task from standard input and materializes it as
`task.md` in the run directory. On POSIX systems, a piped run reads its
per-phase confirmations from `/dev/tty`, so this works interactively:

```sh
some-task-source fetch 123 | aloop --task-file - --name my-spec
```

Add `--yes` to run unattended. If no controlling terminal is available, the
runner reports an error and asks for `--yes`; `--dry-run` does not need `--yes`.

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
  phases: ['implement', 'gate', 'review', 'address', 'docs', 'git'],
  gate: ['npm test'],
  setup: ['npm ci'],
  maxRounds: 3,
  timeoutMs: 30 * 60 * 1000,
};
```

Pass `--config path/to/loop.config.mjs` to use a configuration file outside the
repository (relative paths resolve from your current directory). The supplied
file replaces the repository's `loop.config.mjs`; command-line overrides such
as `--phases` and `--max-rounds` still take precedence.

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
| configured adapter name | adapter-defined | adapter-defined | adapter's `efforts`, or any value when omitted |

The `adapters` map registers additional engines without changing the package.
Its keys are usable as `engines.*.name` values. A configured adapter with the
same name as a built-in takes precedence, so it can also customize a built-in
invocation. An adapter may declare an `efforts` array; when it does not, the
configured effort is passed through without validation. If `createRenderer`
is omitted, the runner uses its plain-text passthrough renderer.

### Bring your own engine

An adapter is a small ES module object whose `command` function returns one
process invocation. For example, an opencode-style adapter can be configured
like this:

```js
export default {
  adapters: {
    opencode: {
      command({ prompt, cwd, addDirs, agent = {} }) {
        const args = ['run', prompt, '--dir', cwd];
        if (agent.model) args.push('--model', agent.model);
        if (agent.effort) args.push('--effort', agent.effort);
        for (const dir of addDirs) args.push('--add-dir', dir);
        return { command: 'opencode', args };
      },
    },
    pi: {
      command({ prompt, cwd, agent = {} }) {
        const args = ['--print', prompt, '--cwd', cwd];
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
`--sandbox workspace-write`, and agy `--dangerously-skip-permissions`.

The verdict contract remains file-based: the engine only needs to execute the
prompt and write the files requested by it. A resumed run re-reads adapters from
`loop.config.mjs`; the same config must still define any custom adapter used by
the saved engine settings.

`--engine` still changes the default executable, but keeps its configured model
and effort. Dry runs and phase logs print the effective engine settings. They
are saved in run state on the first real run; `--resume` uses those saved
settings even if `loop.config.mjs` has changed, so a resumed run remains
auditable and reproducible.

`--resume --config path/to/loop.config.mjs` deliberately replaces those saved
settings and every other configurable pipeline value, including engines, phase
definitions, gates, prompts, timeouts, and round caps. It cannot change the
already-created branch, worktree, or persisted base branch; those identify the
run being resumed. Keep `runsDir` unchanged so the runner can find that saved
run. Do not combine it with `--override-engine`: set the desired engines in the
supplied config instead. The runner snapshots every resume override in
`state.json`, including its source path and resolved values.

To deliberately move an interrupted run to another executable, use
`--resume --engine <name> --override-engine`. It replaces the saved engine for
every agent phase while retaining each phase's saved model and effort; the new
combination is validated before a phase starts. The runner records the before
and after settings in `state.json`, prints the change at resume time, and adds
it to each affected phase log header.

`remote` is the push target for the `git` phase. Left unset it detects one,
preferring `origin` — set it explicitly in any repo with several remotes, since
pushing a feature branch to the wrong one is not something the run can undo.
A configured remote that does not exist fails before any phase runs.

Use `--base-branch feat/a` to build and open a stacked PR on top of another
local branch. The branch must exist locally; the flag does not fetch remote-only
refs.

`gate` commands run through `sh -c`, so quoting, pipes, `&&`, and environment
variables all work. They are judged by process exit code on unfiltered output. Prefer
invoking the compiler directly over a cached wrapper script: a cached build can
report success without compiling anything, and a wrapper that summarizes output
can invent a failure the tool never produced.

`setup` is an optional list of shell commands run once when the runner adds a
new worktree, before phase 1. This also covers a fresh worktree for a branch
that already exists; branch creation and worktree creation are tracked
separately. It defaults to an empty list, so the generic runner does not assume
a package manager. Setup runs in the worktree and uses the same timeout as other
commands; a non-zero exit or timeout aborts the run before any phase starts. It
is skipped for resumed or reused worktrees and during `--dry-run`.

Running `review` on a different engine than `implement` is the main reason to be
multi-CLI. Different model families fail differently, so the reviewer's blind
spots do not overlap with the implementer's.

## Phases

| Phase | Kind | Role |
| --- | --- | --- |
| `implement` | agent | Writes code to spec; commits its implementation |
| `gate` | shell | Runs `gate` commands; exit code decides |
| `review` | agent | Emits a verdict and writes prose to `RUN_DIR`; the work-item preset may append it to the task file |
| `address` | agent | Repairs and commits the findings a verdict raised |
| `docs` | agent | Documentation-as-built pass; commits docs changes |
| `git` | agent | Verifies the branch, pushes, and opens the PR; the work-item preset may also update the task file |

The implementation, address, and docs phases each commit their own work. The
generic `review` phase writes human-readable prose to
`{{RUN_DIR}}/review-round-{{ROUND}}.md`, while its machine-readable verdict is
written to `{{VERDICT_FILE}}`; it does not modify a task file. The generic `git`
phase creates no code or task-file commits, verifies the code worktree is clean,
and pushes. The opt-in work-item preset can restore task-file review notes and
updates for workflows that use those conventions. The clean-tree check is
deterministic: before the `git` phase runs, the runner stalls the pipeline if
`git status` is not empty, reporting the offending paths rather than letting the
agent try to reconcile uncommitted work it is forbidden to commit. Unresolved
review findings do not block it — a clean tree with open findings is a valid
state to resume through `docs` and `git`. Review uses the configured base branch
for the cumulative change and, from round two onward, the SHA recorded after the
previous review to focus first on its response. The worktree remains isolated
from your checkout, and a stalled run leaves the phase commits intact for
inspection or resume.

For the code-producing `implement` and `address` phases, the runner also
stalls if the agent exits successfully without leaving pending work, creating a
new commit, or producing any output. The `address` guard applies only when the
review has blocking findings to repair. The phase is left incomplete so
`--resume` retries it; the stall points to the phase log. This guard does not
apply to `docs`, `review`, or `git`, which may legitimately produce no code
diff.

A phase list is flat, but the runner folds it into a loop. A verdict phase
absorbs the repair phases that follow it plus the gate that preceded it, so
`[gate, review, address]` executes as "gate, then review, and while the verdict
asks for changes: address, gate, review again".

Add a custom phase by using an object instead of a name:

```js
phases: ['implement', 'gate', { name: 'bench', kind: 'gate', commands: ['yarn bench'] }, 'review', 'address'],
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

Parsing fails closed. A missing, malformed, or unrecognized verdict stalls the
run rather than defaulting either way: defaulting to approval ships unreviewed
code, and defaulting to changes burns rounds against a reviewer that is not
reporting. `CHANGES_REQUESTED` with an empty `blocking` list is rejected, and
the loop will not exit on approval while the last gate re-check was red. If a
reviewer nevertheless approves with a red repair gate, the run stalls and
reports that gate failure instead of attempting a repair phase without findings.

## Stopping conditions

The run stops and reports when the round cap is reached, a standalone gate
fails, a setup command fails, a code phase is a no-op, or a verdict cannot be
parsed. It never merges — an open PR awaiting a human is the correct end state.

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
`RUN_DIR`, which always exists for a run.

### Work-item preset

Repositories that use Markdown task files with status frontmatter and named
review/changelog sections can opt into the opinionated work-item flow. The
package ships it under `presets/work-item/`, including the five prompt
overrides, a sample `loop.config.mjs`, and installation guidance.

```
mkdir -p .loop/prompts
cp -r node_modules/@syntax-syllogism/aloop/presets/work-item/prompts/. .loop/prompts/
```

The preset assumes task files live in a separate repository and that another
workflow commits those task-file updates. Copy its sample configuration as a
starting point only when its branch, engine, phase, and gate settings match the
project.

## Isolation and state

Each run gets a `git worktree` off `baseBranch`, so concurrent runs cannot stomp
each other and a failed run is discarded without touching your checkout.
`--base-branch <branch>` overrides `baseBranch` for one run. The resolved base
is persisted in `state.json`, so `--resume` stays pinned to the branch the run
started from; passing a different base while resuming fails.

Logs, verdicts, and `state.json` live in `.loop/runs/<slug>/` in the main
repository — outside the worktree, so they survive its removal. Add
`.loop/runs/` to `.gitignore`. `--resume` reads that state and skips phases
already recorded complete. If an incomplete verdict loop has a persisted review
round, resume first replays its unfinished repair phases (including any failed
or unrun recheck gate), then starts the next review with that review's SHA as
`SINCE_SHA`. It stops without another agent invocation when the persisted round
has reached the cap.

Before resuming, the runner verifies that the saved worktree still exists and
is registered for the saved branch. A worktree moved with `git worktree move`
is adopted at its registered location. If it was removed or is no longer
registered, the runner fails before planning or running a phase; restore it or
re-register it with `git worktree` before resuming rather than continuing in a
different checkout.

## Two repositories

A task file is optional and may live in the code repository or in a separate
repository. When `--task-file <path>` is supplied, the runner resolves the
file's Git repository and gives the agents the run directory as a writable
directory. If the task-file repository is outside the code repository, it is
also passed to the adapter as an additional `--add-dir` writable directory so
agents can read or update the task file when the phase instructions call for
it. For a task file in the code repository, its containing source directory is
passed as an additional `--add-dir` because agents normally run in a separate
worktree; `TASK_FILE` remains the source-checkout path. A run without a task
file adds no task-file directory.

The implementation, address, and docs phases commit code changes in the code
repository. Task-file edits are not code commits; a separate workflow can
commit them in the task-file repository. When no `--task-file` is supplied,
there is no external task repository to add and no task-file changelog or
`## Code Review` update workflow. Review verdicts still live in the run
directory.

## Building up to unattended

Do not start at `-y`. Each rung should be boring before you climb the next.

1. `--dry-run` — read the rendered prompts.
2. Default confirmation mode, one representative task, watching every phase.
3. `--max-rounds 2` and watch the review loop specifically. This is where you
   learn whether your reviewer's verdicts are consistent enough to automate. If
   they are not, no amount of driver work fixes it.
4. `-y` on task shapes whose behavior you have already seen succeed.

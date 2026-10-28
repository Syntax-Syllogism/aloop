---
title: Named agents
description: Run aloop phases with existing CLI agent definitions and diagnose their requirements.
---

# Named agents

Select an existing CLI persona on an engine entry:

```js
engines: {
  default: { name: 'claude' },
  review: { name: 'gemini', agent: 'code-reviewer' },
}
```

<a id="requirements"></a>

## Requirements

- The engine supports named agents; see the table below.
- The definition exists where the CLI can find it and its name matches.
- Repo definitions are committed to the configured base branch before creating a worktree.
- Native agents can write the phase's required artifact files.
- The CLI is authenticated and the agent can run without interactive approval.
- User definitions are available inside any container used for the phase.
- Gemini subagents are enabled when using delegation.

Run `aloop doctor` before starting. Agent warnings are advisory and do not fail doctor.

<a id="engine-support"></a>

## Engine support

| Engine | Mechanism                   | Instructions                  | Model                               | Tool limits     | Confirmation                   |
| ------ | --------------------------- | ----------------------------- | ----------------------------------- | --------------- | ------------------------------ |
| claude | `--agent <name>`            | Native                        | Agent, unless explicitly overridden | Native          | Native selection               |
| agy    | `--agent <name>`            | Native                        | Agent, unless explicitly overridden | Native          | Native selection               |
| gemini | `@name` delegation preamble | Subagent                      | Subagent definition                 | Subagent        | Best effort stream observation |
| codex  | Inline Markdown body        | Always included when resolved | aloop config                        | Ignored         | Body included                  |
| Custom | Declared by adapter         | Depends on mode               | Depends on mode                     | Depends on mode | Depends on mode                |

An unsupported adapter runs without the agent and records `unsupported`.

<a id="where-agents-live"></a>

## Where agents live

Claude uses `.claude/agents/*.md` and `~/.claude/agents/*.md`.
[Gemini](https://geminicli.com/docs/core/subagents/) uses `.gemini/agents/*.md`
and `~/.gemini/agents/*.md`. Both use Markdown with YAML frontmatter.
[agy](https://www.agy.dev/docs/cli/commands/agents/) uses
`.agents/agents/<name>/agent.md` or `~/.gemini/config/agents/<name>/agent.md`.
Plugin definitions can live elsewhere: a successful CLI definition listing can establish
existence even when aloop cannot inspect its location or tools. Listing failure or timeout
falls back to file lookup. Some Claude versions list background sessions instead of definitions;
aloop ignores these session records.

The lightweight parser reads only `name`, `model` and `tools` (comma-separated, inline list,
or a block list). It does not validate arbitrary YAML. Matching prioritizes frontmatter
`name`, then the filename stem. No definitions ship with aloop.

<a id="worktrees"></a>

## Worktrees

New worktrees start from `baseBranch`. Untracked definitions and definitions committed only
on another branch are absent there; dirty definitions use the base branch's committed version.
Commit the file on the base branch or use a user definition. With `worktrees: false`, the
current checkout is used and these checks are skipped. Inline lookup reads the active worktree.

<a id="file-writes"></a>

## File writes

Review, address, docs and PR-description phases must write artifacts. A native Claude or agy
agent restricted to read tools cannot write its verdict; the existing missing-verdict check
can stall the run. Include Write, Edit or a shell tool as appropriate. Gemini's main session
writes artifacts after the subagent returns, so its subagent can be read-only.

<a id="non-interactive"></a>

## Non-interactive execution

Built-in adapters pass headless permission flags. Authenticate the CLI beforehand and ensure
agent tools do not require interactive input; otherwise the phase may wait until its timeout.

<a id="hermetic"></a>

## Hermetic execution

Hermetic phase mounts include the worktree and artifacts, not arbitrary home directories.
A user-level native or delegated definition may therefore be invisible. Commit a repo definition
or provide it in the container image. Inline definitions are read on the host and passed as prompt
text, so their source files need no container mount. See [Hermetic execution](hermetic.md).

<a id="model-precedence"></a>

## Model and effort precedence

For native and delegated agents, inherited `model` and `effort` are omitted so they do not
silently override the agent. Explicit per-phase values are passed. Native CLI model selection
overrides the definition model. Gemini's model flag selects the main session model; the
subagent uses its own definition (or its vendor inheritance setting).

Inline mode preserves the aloop model and effort, including inherited values, and ignores
frontmatter model names because they may belong to another vendor. Frontmatter tool limits
are also ignored and produce a warning.

<a id="inheritance"></a>

## Inheritance

Same-engine phase entries inherit `agent` from `engines.default`. An engine switch starts
clean. `default.agent` therefore applies to every same-engine phase that does not override it.
Specialized reviewers inherit the review engine but **never its agent**; configure
`engines['review-security'].agent` explicitly. Resume saves and restores resolved agents.
An engine override drops the saved agent when changing vendors, and retains it on the same engine.

<a id="gemini"></a>

## Gemini delegation

The prompt begins with `@name` and asks Gemini to call that subagent first, then write every
required artifact preserving its findings. The original phase task follows verbatim.
The renderer observes complete `tool_use` events with the agent's tool name, or an
`invoke_agent` call whose `parameters.agent_name` matches. Mentioning the name in prose
is insufficient. Observed calls record `confirmed`; absent or unavailable evidence records
`unconfirmed` and prints a warning. This proves an invocation, not the quality of its result.

[Gemini subagents](https://geminicli.com/docs/core/subagents/) are on by default. Setting
`experimental.enableAgents: false` in user or project settings disables them, and aloop warns
about that explicit `false`. Delegation remains best effort and cannot fail a phase by itself.

<a id="inline"></a>

## Codex inlining

Inline engines search an explicit path (a value containing `/` or ending in `.md` or `.toml`) relative
to the active worktree. Otherwise they search `.codex/agents`, `.claude/agents`,
`.gemini/agents` in the worktree, then the same locations under the user home directory.
Name matches take priority over filename fallback. [Native Codex TOML definitions](https://learn.chatgpt.com/docs/agent-configuration/subagents)
in `.codex/agents/*.toml` are also supported: aloop inlines their `developer_instructions`
string. Their model and capability settings are ignored, just like Markdown frontmatter.
One Markdown definition can serve several engines.

The frontmatter is removed, and the body is placed before the rendered task:

```text
# Role: specialist

<definition body>

# Task

The task below defines the files you must write and their formats. If anything in the role above conflicts with it, follow the task.

<rendered phase task>
```

The manifest records `inline`, `agentSource: { path, hash }`, and a prompt hash covering the
wrapped text. The source hash covers the entire definition. The definition is re-read each
invocation; changes since a prior recorded invocation produce an informational message.
Missing files leave the task unwrapped and record `unresolved`. Skills are not used because
loading them is discretionary and would require maintaining a second definition.

<a id="doctor"></a>

## Checking your setup

```text
✓ agent review: claude / strict-reviewer: claude --agent strict-reviewer found …/.claude/agents/strict-reviewer.md; model from agent (inherited aloop model omitted)
⚠ agent docs: codex / docs-writer: Agent "docs-writer" tool limits Read, Grep cannot be applied on codex; only instructions will be used.
  → Use claude or agy if tool limits matter. (docs/agents.md#inline)
Doctor: OK (1 warnings)
```

Agent lines are prefixed with the engine and agent name; the messages are abbreviated here. With only warnings, the summary is `Doctor: OK (N warnings)` and the exit code stays zero. Any failing engine check still makes the summary `Doctor: problems found`.
JSON checks include `ok`, `warn`, `detail`, `code`, `hint`, and `docs`.

| Diagnostic code               | Meaning and fix                                        |
| ----------------------------- | ------------------------------------------------------ |
| `agent-ok`                    | Native definition found; keep it accessible.           |
| `agent-ok-best-effort`        | Delegate definition found; check invocation evidence.  |
| `agent-ok-inline`             | Instructions can be inlined; limits are not enforced.  |
| `agent-inline-tools-ignored`  | Use a native engine to enforce tool limits.            |
| `agent-inline-model-ignored`  | Set the model in aloop config.                         |
| `agent-unsupported-engine`    | Declare adapter support or remove the agent.           |
| `agent-not-found`             | Create the definition or correct its name/path.        |
| `agent-not-on-base`           | Commit on the configured base branch or move to home.  |
| `agent-dirty-on-base`         | Commit changes to the base branch.                     |
| `agent-cannot-write`          | Add tools that can write the required artifacts.       |
| `agent-model-override`        | Explicit native phase model overrides the definition.  |
| `agent-model-ignored`         | Configure the Gemini subagent model in its definition. |
| `agent-inherited`             | Persona inherited from the default engine.             |
| `agent-dropped-engine-switch` | Set a persona explicitly on the new engine.            |
| `agent-feature-disabled`      | Enable Gemini subagents in settings.                   |
| `agent-not-in-sandbox`        | Make the definition available in the container.        |
| `agent-unconfirmed`           | Inspect delegation setup and the phase log.            |

<a id="warnings"></a>

## Warnings

Setup warnings appear once at run start and are saved to `agents.log`; applicable warnings
also appear in phase logs. Runtime delegation warnings appear in the console and phase log.
The manifest records `native`, `confirmed`, `unconfirmed`, `inline`, `unresolved`, or
`unsupported` in `agentStatus`, and the configured name in `engine.agent`.
Warnings never change the phase status. Ordinary failures, including a missing verdict or
CLI error, still use the existing failure behavior. Watch does not emit a separate agent-warning
event; inspect the logs and manifest for details.

<a id="custom-adapters"></a>

## Custom adapters

```js
adapters: {
  local: {
    agentSupport: 'inline',
    command({ prompt, agent }) {
      // agent is the engine descriptor; agent.agent is the optional persona name.
      // Inline and unsupported modes remove that field before command().
      return { command: 'local-cli', args: [prompt] };
    },
  },
}
```

`agentSupport` accepts `native`, `delegate`, or `inline`. An absent declaration means
unsupported. `delegatePrompt(prompt, agentName)` must be a function when supplied; it
returns the complete wrapped prompt. The pipeline applies it before hashing and invocation.
Replay saves the complete wrapped prompt when it cannot be represented as a prefix of the task.
Custom native adapters own agent lookup in their CLI; aloop does not check built-in definition
locations or warn that these agents are missing.
A delegated renderer can expose `agentInvoked(agentName)` returning true, false, or undefined.
Only true confirms invocation.

What `command()` receives depends on the mode:

- **Native:** the persona stays in the descriptor. A custom native adapter always gets it, even when
  file lookup cannot establish existence, because its CLI owns resolution. A built-in native adapter
  drops it when neither file lookup nor a CLI listing finds the definition, and the status is `unresolved`.
- **Delegate:** the prompt arrives already wrapped by `delegatePrompt`, with the persona field removed
  so the preamble is not applied twice.
- **Inline and unsupported:** the persona field is removed. The remaining engine fields are passed through.

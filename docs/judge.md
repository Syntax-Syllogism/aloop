---
title: Repeated-blocker judge
description: Optional decision model that stops a review and address loop when reviewers keep raising the same blockers, with its protocols, defaults, recipes, and overrides.
---

# Repeated-blocker judge

After a reviewer requests changes, the repair agent addresses the blockers and the reviewer looks again. Sometimes the reviewer keeps raising the same problem in new words, and the loop spends rounds without progress. The optional judge compares each round's blocking findings with the previous round's and decides whether they're the same issues. It's disabled unless you configure it.

The judge classifies the findings. The driver acts on that result: it stalls the run, or, with `onRepeat: 'continue'`, records an override and carries on.

## When it runs

The judge runs only when all of these hold:

- the verdict is `CHANGES_REQUESTED`; approvals never invoke it;
- the round is two or later;
- the verdict phase has a repair step;
- the previous round recorded blocking findings.

It's skipped, with a log line, when the previous round has no blocking findings or when either round has more than 40 blockers. A skip isn't a failure.

The verdict counts as repeated only when every current blocker matches a previous blocker at or above `minProbability`. One new problem keeps the loop going.

## Configuration

```js
export default {
  judge: { name: 'decider', onRepeat: 'stall', minProbability: 0.9, timeoutMs: 180_000 },
  judges: {
    decider: {
      kind: 'systemone',
      command: [
        'python3',
        '-I',
        'examples/judges/decider-systemone.py',
        '--repo',
        'Mapika/decider-4b-GGUF',
        '--gguf-file',
        'decider-4b-v3-Q4_K_M.gguf',
      ],
    },
  },
};
```

- `judge` selects the active judge. `null` (the default) disables it. An object can set `name`, which refers to an entry in `judges`. Fields on `judge` override the named entry. Without `name`, the object must carry its own `kind`.
- `judges` holds reusable definitions, keyed by name.
- Each judge entry accepts `name`, `kind`, `baseUrl`, `command`, `apiKeyEnv`, `judge`, `onRepeat`, `minProbability`, and `timeoutMs`. Unknown keys are rejected at load.
- `kind` is `systemone` or `command`. A function judge needs no `kind` and is treated as `command`.
- A `systemone` judge takes exactly one of `baseUrl` (an `http:` or `https:` URL) or `command` (a non-empty argv array). `apiKeyEnv` only applies to `baseUrl`.
- A `command` judge takes exactly one of `command` or a `judge` function. It doesn't accept `baseUrl` or `apiKeyEnv`.
- `minProbability` must be in `(0, 1]`, and `timeoutMs` must be a positive integer.

Judge commands run in the directory where `aloop` was started. Use an absolute path for a shim you don't keep in the repository.

## Defaults

| Setting          | Default                | Notes                                                                                                                |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `judge`          | `null`                 | Disabled. The feature is opt-in.                                                                                     |
| `onRepeat`       | `'stall'`              | `continue` records an override instead. See [Stall and override](#stall-and-override).                               |
| `minProbability` | `0.9`                  | Biased toward "not a repeat". A false "new" only keeps today's behavior. See [Threshold](#threshold).                |
| `timeoutMs`      | `180000` (3 minutes)   | Covers a cold model load plus CPU inference.                                                                         |
| Retries          | none                   | One attempt. Errors fail closed.                                                                                     |
| Blockers sent    | up to 40 per round     | More than 40 on either side skips judging.                                                                           |
| Issue text       | 1,000 characters       | Applied to System One questions only. The generic protocol sends findings unchanged.                                 |
| Repair response  | not sent               | System One doesn't receive it. The generic protocol receives the previous round's response, cut to 4,000 characters. |
| Sampling         | the model's own config | aloop doesn't set temperatures.                                                                                      |
| `--no-judge`     | off                    | Disables a configured judge for one invocation.                                                                      |

## Threshold

The default `minProbability` of `0.9` is deliberately strict. Calling a new finding a repeat stalls the loop on a problem that hasn't been fixed, and can hide a real bug. Missing a repeat only costs another review round. On a labelled sample of 42 aloop findings from 29 pairs of consecutive review rounds, Decider 4B gave these results:

| `minProbability` | Accuracy | Repeats caught | New findings called repeats |
| ---------------- | -------- | -------------- | --------------------------- |
| `0.7`            | 86%      | 75%            | 8%                          |
| `0.9`            | 83%      | 63%            | 4%                          |

At `0.9`, no round with a new finding was judged a full repeat. Lower the threshold only if you've checked it against your own labelled examples.

## Transports

### System One (`kind: 'systemone'`)

Use `baseUrl` to POST to `${baseUrl}/v1/systemone`. Send `apiKeyEnv` to name an environment variable whose value is sent as a `Bearer` token. Or use `command` to run a local process: aloop writes the request to stdin, and the process must write only the JSON answer to stdout.

Each current blocker becomes one `choice` question. Its options are `p0…pN`, one per previous blocker, plus `new`. Findings render as `file:line — issue`, with any leading `[tag]` removed and each entry cut to 1,000 characters.

```json
{
  "state": {
    "context": "An automated code reviewer reviewed a change, …",
    "previous_findings": { "p0": "src/retry.ts:42 — Unhandled rejection in the retry path" },
    "current_findings": { "c0": "src/retry.ts:44 — Retry path still rejects unhandled" }
  },
  "questions": {
    "c0": {
      "type": "choice",
      "instructions": "Which previous finding does `current_findings.c0` repeat? …",
      "criteria": { "p0": "src/retry.ts:42 — …", "new": "Not the same issue as any previous finding" }
    }
  }
}
```

The answer has one entry per current question:

```json
{ "answers": { "c0": { "choice": "p0", "x_p_max": 0.91 } } }
```

The probability can come from `x_p_max` (the chosen option's probability) or from a `probabilities` object keyed by option. A choice of `new`, or a probability below `minProbability`, leaves that blocker unmatched. The answer is validated strictly. A missing or extra answer key, a choice outside the criteria, or a probability that isn't a number in `[0, 1]` stalls the run.

### Generic command (`kind: 'command'`)

The command receives one JSON request on stdin and must print only JSON on stdout:

```json
{
  "version": 1,
  "phase": "review",
  "round": 2,
  "previous": [{ "id": 0, "file": "src/retry.ts", "line": 42, "issue": "…" }],
  "current": [{ "id": 0, "file": "src/retry.ts", "line": 44, "issue": "…" }],
  "response": "…the repair agent's response for the previous round, or null…"
}
```

Each finding keeps every field the reviewer wrote, and ids are array indexes. The answer lists the matches:

```json
{ "matches": [{ "current": 0, "previous": 0 }] }
```

Every `current` id not in `matches` counts as new. The generic protocol has no probability, so `minProbability` doesn't apply: the judge alone decides. A non-array `matches`, an out-of-range id, or a duplicate `current` id stalls the run.

### Function judge

Set `judge` to an async function that takes the same request object as the generic protocol and returns the same `{ matches }` answer. The function runs in the aloop process, so it's the simplest route for a custom judge written in JavaScript.

## Stall and override

**Judge failure fails closed.** A timeout, an HTTP error, a command that exits non-zero, invalid JSON, or a failed validation records a `judge` manifest entry with status `stalled`, and the run stops with `judge failed: <reason>`. Fix the judge and resume, or resume with `--no-judge` to continue without it for that invocation.

**Repeated blockers stall by default.** With `onRepeat: 'stall'`, the run stops with `repeated blockers`. The stall record includes the matched pairs, with probabilities for System One.

**`continue` records an override.** With `onRepeat: 'continue'`, the review phase completes as an override instead of stalling:

- a `review-override` manifest entry records the reason `repeated-blockers`, the round, the reviewed SHA, and the unresolved findings;
- the findings are saved in run state as `unresolvedFindings`, and the `pr-description` phase receives them as `UNRESOLVED_FINDINGS`;
- the shipped `pr-description` prompt asks the agent to list them in an **Unresolved review findings** section of the PR body. The driver doesn't check that text.

Publishing accepts the override only when a passing gate for the same SHA was recorded before it. Without that gate, the publish phase refuses, as it would for any unapproved change. See [Publishing](publishing.md#publish-safeguards).

Use `--no-judge` to disable a configured judge for one invocation, and `--on-repeat stall|continue` to override `onRepeat` for one invocation. `--on-repeat` requires a configured judge.

Resuming a repeated-blocker stall with `continue` in effect (`onRepeat: 'continue'` or `--on-repeat continue`) uses the cached judgement for the pending round and reviewed SHA, records the override, and clears the pending repair without spending another address or review round. This also works at the round cap. Other stalls resume normally.

## Recipes

### Decider 4B on CPU (recommended)

Run the shipped shim, `examples/judges/decider-systemone.py`, as a `command` judge. It loads `Mapika/decider-4b-GGUF` with the file `decider-4b-v3-Q4_K_M.gguf` (about 2.7 GB) on the CPU with an 8,192-token context. Install it with `pip install "decider-ai[gguf]"` in the interpreter named in `command`. The import name is `decider`; the unrelated PyPI package named `decider` won't work. Pass `--threads <n>` to set the thread count.

```js
judges: {
  decider: {
    kind: 'systemone',
    command: ['python3', '-I', '/abs/path/examples/judges/decider-systemone.py', '--repo', 'Mapika/decider-4b-GGUF', '--gguf-file', 'decider-4b-v3-Q4_K_M.gguf'],
  },
},
```

### Smaller fallback

For slower machines, run the same shim with `--repo Mapika/decider-2b-GGUF` and the 2B file's Q4_K_M name (about 1.3 GB). Confirm the file name on the model page.

### Persistent HTTP server (`decider.serve`)

To avoid loading the model on every review round, run `decider.serve` with `Mapika/decider-2b` as a persistent server, and point a `systemone` judge at it with `baseUrl`. `decider.serve` doesn't load GGUF files, so the GGUF shim is the route for the 4B model. Confirm that your server exposes `/v1/systemone`.

```js
judges: {
  decider: { kind: 'systemone', baseUrl: 'http://127.0.0.1:<port>', timeoutMs: 180_000 },
},
```

### Hosted Jev

Point a `systemone` judge at the hosted endpoint with `baseUrl`, and read the bearer token from an environment variable named by `apiKeyEnv`. The variable name is your choice, for example `JEV_API_KEY`.

### Laya

`examples/judges/laya-systemone.py` is a command adapter for Laya's direct Python SDK. Install it with `pip install laya`, then use the typed-decisions checkpoint (the shim default) or pass another checkpoint with `--repo`:

```js
judges: {
  laya: {
    kind: 'systemone',
    command: ['python3', '-I', '/abs/path/examples/judges/laya-systemone.py'],
  },
},
```

Laya hasn't been evaluated against aloop findings. Its short context and calibration may call for a threshold above the default. Check it against your own labelled examples first.

### Custom judge

Write a `command` judge that follows the generic protocol, or pass a `judge` function. Either one must return `{ matches }` with valid ids.

## Observability

Each judge decision is a manifest entry with role `judge`, including skipped decisions (`decision.skipped` holds the reason, such as `too many blockers`). For an invoked judge, the entry records the transport, the matches and unmatched ids, the action taken (`stall`, `continue`, or `keep going`), the duration, and any failure. Judgements are cached in run state by phase, round, and reviewed SHA, so a resume on the same SHA doesn't invoke the judge again. See [Run state and recovery](run-state.md).

Each decision, and each `review-override` that continues with unresolved findings, prints one line in the run log and in quiet mode:

```text
  judge (round 3): repeated (3/3 blockers matched, min p 0.82) → stall
  judge (round 3): not repeated (1/3 blockers matched) → keep going
  judge (round 3): skipped (too many blockers)
  judge (round 3): failed closed (Judge function timed out after 180000ms.) → stall
  review-override (round 3): continuing with 3 unresolved findings (repeated-blockers)
```

`min p` appears only when the judge reports probabilities.

- `aloop watch` emits each new decision as a `decision` event carrying the same line. See [Operations](operations.md#watching-runs).
- `aloop status <name>` reports the latest decision and its matched-pair summary. `aloop inspect <name>` includes that summary plus the structured decision or failure in the judge manifest entry.
- `aloop metrics` and `aloop status` count repeated-blocker stalls, failed-closed stalls, and review overrides. See [Cost and quality metrics](metrics.md).

Dry runs never call the judge. They print a `judge :` header line naming the configured judge, its kind, transport, and `on-repeat` action, or `judge : disabled` when no judge is configured.

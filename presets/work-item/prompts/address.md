A code review has been appended for task `{{TASK_NAME}}`. Please
address all findings, and if a task file is present (`{{TASK_FILE}}`), update its changelog.

The work is in the worktree at `{{REPO}}` on branch `{{BRANCH}}`; prior phases
have committed their changes.

This is round {{ROUND}} of at most {{MAX_ROUNDS}}. If the findings are not
resolved by round {{MAX_ROUNDS}} the run stops and a human picks it up, so fix
causes rather than symptoms.

## Blocking findings

{{FINDINGS}}

The structured verdict is in `{{VERDICT_FILE}}`; the full review, including
non-blocking notes, is in the task file's `## Code Review` section if a task file
is present.

## Deterministic gate

{{GATE_STATUS}}

If the gate is failing, that is your first priority — the review cannot clear
while it is red.

## How to respond

Address every blocking finding. For each one, either fix it or — if you believe
the reviewer is wrong — leave the code as it is and record a short rebuttal under a
`#### Response — Round {{ROUND}}` heading (in the task file's `## Code Review`
section if a task file is present, or in your final summary), naming the finding and
your reasoning. A disagreement recorded in writing is a legitimate outcome;
silently ignoring a finding is not.

Do not:

- Delete, skip, or weaken a test to make a finding or a gate go away. If a test
  is genuinely wrong, fix the test and say so in the rebuttal.
- Fix anything the reviewer did not raise. Unrelated changes make the next
  review round harder and can introduce new findings.

Scope and token discipline from the implementation phase still apply: work from
the files the findings name, keep command output short, and summarize before editing.

## Verification

Run the targeted tests for what you changed, then the gate commands:

```
{{GATE_COMMANDS}}
```

Judge them by process exit code on unfiltered output.

At the end of the phase, commit the fixes and their tests in a conventional
commit whose message names the review findings addressed. Keep the worktree
clean for the next phase. If there is nothing to commit, leave the worktree clean.

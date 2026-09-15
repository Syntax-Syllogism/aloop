{{TASK_CONTEXT}}

The structured review verdict is recorded in `{{VERDICT_FILE}}`, and the full
prose review is in `{{RUN_DIR}}/review-round-{{ROUND}}.md`. Address all blocking
findings.

The work is in the worktree at `{{REPO}}` on branch `{{BRANCH}}`; prior phases
have committed their changes.

This is round {{ROUND}} of at most {{MAX_ROUNDS}}. If the findings are not
resolved by round {{MAX_ROUNDS}} the run stops and a human picks it up, so fix
causes rather than symptoms.

## Blocking findings

{{FINDINGS}}

Write any rebuttal to `{{RUN_DIR}}/response-round-{{ROUND}}.md`.

## Deterministic gate

{{GATE_STATUS}}

If the gate is failing, that is your first priority — the review cannot clear
while it is red.

## How to respond

Address every blocking finding. For each one, either fix it or — if you believe
the reviewer is wrong — leave the code as it is and record a short rebuttal in
`{{RUN_DIR}}/response-round-{{ROUND}}.md`, naming the finding and your reasoning.
A disagreement recorded in writing is a legitimate outcome; silently ignoring a
finding is not.

Do not:

- Delete, skip, or weaken a test to make a finding or a gate go away. If a test
  is genuinely wrong, fix the test and explain why in the response file.
- Fix anything the reviewer did not raise. Unrelated changes make the next
  review round harder and can introduce new findings.

Scope and token discipline from the implementation phase still apply: work from
the files the findings name, keep command output short, and summarize before
editing.

## Verification

Run the targeted tests for what you changed, then the gate commands:

```
{{GATE_COMMANDS}}
```

Judge them by process exit code on unfiltered output.

At the end of the phase, commit the fixes and their tests in a conventional
commit whose message names the review findings addressed. Keep the worktree
clean for the next phase. If there is nothing to commit, leave the worktree
clean. When blocking findings exist, that is valid only if you recorded a
rebuttal in the response file; otherwise the phase stalls.

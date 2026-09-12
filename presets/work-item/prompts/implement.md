{{TASK_CONTEXT}} The worktree at
`{{REPO}}` is already checked out to a new branch `{{BRANCH}}` off
`{{BASE_BRANCH}}` — work there, and do not create or switch branches.

Skip any steps that require manual human intervention. Implement the rest from
start to finish.

If a task file is present (`{{TASK_FILE}}`), update its frontmatter status to
`IN PROGRESS` before doing anything else in this first turn. The only allowed
statuses are `TODO`, `IN PROGRESS`, `UNDER REVIEW`, and `DONE`.

This run is unattended, so you cannot ask clarifying questions. Where you would
have asked, choose the reading most consistent with the task and the
surrounding code, and record the question and the assumption you made under
`## Changelog` in the task file (if present). If a step genuinely cannot proceed
without a human, implement everything else and record what you skipped and why.

Scope:

- Start with the files referenced in the task.
- Do _not_ scan or explore the whole repo.
- Only read additional files if they are imported or referenced in the task.

Token discipline:

- Keep command output short.
- Summarize findings before editing.

Verification:

- Add or update targeted tests.
- Run only the relevant test file first.
- Run broader tests after the targeted test passes.
- These commands gate the work and will be run against your changes, so run
  them yourself before finishing:

```
{{GATE_COMMANDS}}
```

- Judge them by process exit code on unfiltered output. A wrapper that
  summarizes output can report a failure the tool never produced, and a cached
  build can report success without compiling anything.
- At the end of the phase, commit the implementation and its targeted tests in
  a conventional commit. Keep the worktree clean for the next phase.
- If a task file is present (`{{TASK_FILE}}`), keep it current by adding updates
  to the `## Changelog` and updating status in the frontmatter when applicable.
  Use only `TODO`, `IN PROGRESS`, `UNDER REVIEW`, or `DONE` as statuses.
- End your turn with a summary and next steps if applicable. The loop runs the
  code review next, so you do not need to ask for one.

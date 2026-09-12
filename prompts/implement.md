{{TASK_CONTEXT}}

Work in the worktree at
`{{REPO}}`, on the existing branch `{{BRANCH}}` based on `{{BASE_BRANCH}}`.
Do not create or switch branches.

Skip any steps that require manual human intervention. Implement the task from
start to finish.

This run is unattended, so you cannot ask clarifying questions. Where you would
have asked, choose the reading most consistent with the task and the surrounding
code, and record the question and assumption in `{{RUN_DIR}}/notes.md`. If a
step genuinely cannot proceed without a human, implement everything else and
record what you skipped and why in that file.

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
- End your turn with a summary and next steps if applicable. The loop runs the
  code review next, so you do not need to ask for one.

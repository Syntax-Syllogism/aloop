{{TASK_CONTEXT}}

The code-producing phases have already committed their work in `{{REPO}}`, on
branch `{{BRANCH}}`.

Verify the worktree is clean and do not create any code commits in this phase.

- Inspect the full worktree and recent branch history before writing the
  description.
- Do _NOT_ include notes about co-author / author.
- Report the existing code commit hashes and messages, validation performed,
  and whether the worktree is clean.
- Write `{{RUN_DIR}}/pr.md` with this exact format. The first line is a
  one-line title, followed by a blank line and a body of fewer than 250 words:

  Title: <pull request title>

  <pull request body>

The PR body should cover what changed and why, a summary of the task, the review
outcome (how many rounds, plus any recorded disagreements), and anything
deliberately left out of scope.

## Boundaries

- If the worktree is **not** clean — `git status --porcelain` reports anything —
  do **not** edit files, tests, or configuration to make it clean, and do not
  create commits. A dirty tree at this phase is a pipeline error: stop
  immediately and report the offending paths. Reconciling it is out of scope.
- Do not push, create, edit, merge, or enable auto-merge on a pull request. The
  driver performs and verifies those operations after this phase.
- Do not modify the worktree or create commits.

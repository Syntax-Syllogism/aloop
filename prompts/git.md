{{TASK_CONTEXT}}

The code-producing phases have already committed their work in `{{REPO}}`, on
branch `{{BRANCH}}`.

Verify the worktree is clean and do not create any code commits in this phase.

- Inspect the full worktree and recent branch history before pushing.
- Do _NOT_ include notes about co-author / author.
- Report the existing code commit hashes and messages, validation performed,
  and whether the worktree is clean.
- Push to `{{REMOTE}}` and create a PR to `{{BASE_BRANCH}}` on the same repo. PR
  body should be < 250 words.

The PR body should cover what changed and why, a summary of the task, the review
outcome (how many rounds, plus any recorded disagreements), and anything
deliberately left out of scope.

## Boundaries

- If the worktree is **not** clean — `git status --porcelain` reports anything —
  do **not** edit files, tests, or configuration to make it clean, and do not
  create commits. A dirty tree at this phase is a pipeline error: stop
  immediately and report the offending paths. Reconciling it is out of scope.
- **Do not merge the pull request**, and do not enable auto-merge. A human
  decides; an open PR is the correct end state for this run.
- Never force-push, and never rewrite commits that already exist on `{{REMOTE}}`.
- If the push is rejected because the branch moved, stop and report it rather
  than forcing anything.

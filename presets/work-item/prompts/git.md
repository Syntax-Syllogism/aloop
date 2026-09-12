The code-producing phases have already committed their work in `{{REPO}}`, on
branch `{{BRANCH}}`. Verify the worktree is clean and do not create any code
commits in this phase.

- Inspect the full worktree and recent branch history before pushing.
- Do _NOT_ include notes about co-author / author.
- Report the existing code commit hashes and messages, validation performed,
  and whether the worktree is clean.
- Push to `{{REMOTE}}` and create a PR to `{{BASE_BRANCH}}` on the same repo. PR
  body should be < 250 words.

The PR body should cover what changed and why, a summary of the task, the
review outcome (how many rounds, plus any recorded disagreements from the task file's
`## Code Review` section if present), and anything deliberately left out of scope.

## The task file

If a task file is present (`{{TASK_FILE}}`), update it without committing it:

- Set the frontmatter `status` to `UNDER REVIEW`.
- Append a `## Changelog` entry listing the code commits (short SHA + subject)
  and the PR URL once you have it.
- Use only `TODO`, `IN PROGRESS`, `UNDER REVIEW`, or `DONE` as statuses.

A separate job or workflow commits task file changes if needed. Do not commit the
task file or make any other commits in its repository.

## Boundaries

- If the worktree is **not** clean — `git status --porcelain` reports anything —
  do **not** edit files, tests, or configuration to make it clean, and do not
  create commits. A dirty tree at this phase is a pipeline error: stop
  immediately and report the offending paths. Reconciling it is out of scope
  here, and the earlier phase that left the work uncommitted must be resumed
  instead.
- **Do not merge the pull request**, and do not enable auto-merge. A human
  decides; an open PR is the correct end state for this run.
- Never force-push, and never rewrite commits that already exist on
  `{{REMOTE}}`.
- If the push is rejected because the branch moved, stop and report it rather
  than forcing anything.

The separate task-file workflow and cron process own updates to that repository;
keep code and task-file commits separate.

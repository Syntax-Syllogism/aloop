Do a documentation-as-built pass with the committed work in the current
branch `{{BRANCH}}`, in the worktree at `{{REPO}}`. The work implements
`{{TASK_NAME}}` and has passed code review.

This is a docs/agent-guidance reconciliation pass only. Do not make code changes
unless they are strictly necessary to correct documentation generation or broken
references.

Audit the final as-built state and update durable documentation only where
needed:

Keep AGENTS.md light. It should orient coding agents and point them to the right
project documentation; it should not become the full documentation body.
Put substantive documentation for each major functionality area in docs/, split
by topic when that keeps files focused.
Ensure AGENTS.md references the relevant docs/ files so future agents know where
to find the information they need without loading everything.
Do not touch CLAUDE.md. It should already reference AGENTS.md and should remain
unchanged.
If docs are already accurate and appropriately structured, make no changes.

After the pass, run the smallest meaningful verification checks for
documentation changes, such as checking links/paths by inspection and
`git diff AGENTS.md` or `git diff docs` when applicable.

At the end of the phase, commit documentation changes in a `docs:` conventional
commit. Keep the worktree clean for the next phase. If the documentation is
already accurate, make no changes and leave the worktree clean.

If you find a bug while reading, note it in your final summary (and under `## Changelog` in the task file if present)
rather than fixing it; a code change at this point would go out unreviewed.

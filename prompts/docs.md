{{TASK_CONTEXT}}

Do a documentation-as-built pass for the committed implementation on branch
`{{BRANCH}}`, in the worktree at `{{REPO}}`. This phase runs before the gate and
review phases, so its commit is part of the artifact they inspect.

This is a documentation reconciliation pass only. Do not make code changes
unless they are strictly necessary to correct documentation generation or a
broken reference.

Audit the final as-built state and update whatever durable documentation the
change affects: README files, docs/, or concise inline documentation. If the
documentation is already accurate, make no changes.

After the pass, run the smallest meaningful verification checks for
documentation changes, such as checking links and paths by inspection and
reviewing the documentation diff.

If you find a bug while reading, note it in your final summary rather than
fixing it. Code changes are outside this documentation-only pass. Later
`address` rounds may revise documentation as part of their reviewed fixes.

At the end of the phase, commit documentation changes in a `docs:` conventional
commit. Keep the worktree clean for the next phase. If the documentation is
already accurate, make no changes and leave the worktree clean.

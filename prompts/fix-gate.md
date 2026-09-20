{{TASK_CONTEXT}}

The deterministic gate is failing. Work in `{{REPO}}` on branch `{{BRANCH}}`
and make the gate pass by fixing the underlying implementation.

## Gate status

{{GATE_STATUS}}

## Gate commands

{{GATE_COMMANDS}}

Do not delete, skip, or weaken tests or gate commands to make the gate pass.
Make only the changes needed to correct the failure, run the relevant tests and
the gate commands, then commit the repair with a conventional commit message.
Keep the worktree clean for the re-check.

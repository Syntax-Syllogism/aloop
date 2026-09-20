# Work-item preset

The default loop prompts are task-oriented and do not require a particular
document layout. This preset is for repositories that use the Syntax &
Syllogism work-item workflow.

## Assumptions

The preset expects:

- a Markdown task file with status frontmatter and `## Changelog` and
  `## Code Review` sections;
- a separate repository for those task files; and
- a separate job or cron workflow that commits task-file changes.

The preset also includes an example `loop.config.mjs` with the owner's standard
branches, engines, phases, and `npm test` gate. Adjust it for your repository.

## Installation

Install the package, then initialize the project with the preset:

```sh
aloop init --preset work-item
```

This writes the sample config and preset prompts into your project, with the
packaged defaults filling any prompts the preset does not provide. The runner
loads project prompt overrides before its packaged defaults.

If you prefer to wire it up by hand, create `.loop/prompts/` and copy the
contents of `node_modules/@syntax-syllogism/aloop/presets/work-item/prompts/`
there; copy `loop.config.mjs` separately if its settings match your repository.

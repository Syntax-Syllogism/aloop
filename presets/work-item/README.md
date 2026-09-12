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

Install the package, create `.loop/prompts/`, and copy the preset prompts into
the project override directory:

```sh
mkdir -p .loop/prompts
cp -r node_modules/@syntax-syllogism/aloop/presets/work-item/prompts/. .loop/prompts/
```

The runner loads project prompt overrides before its packaged defaults. Keep the
sample config as a starting point for `loop.config.mjs` if its settings match
your repository.

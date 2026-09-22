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

Install the package, then activate the preset for a run:

```sh
aloop --preset work-item --task-file ./work-items/example.md
```

You can opt in for every run by adding `preset: 'work-item'` to
`loop.config.mjs`. Project prompt overrides are loaded before the preset, and
the packaged defaults fill any prompts the preset does not provide.

If you want an editable copy of the sample config and prompt files, initialize
the project instead:

```sh
aloop init --preset work-item
```

If you want to customize the prompts, create `.loop/prompts/` and copy the
contents of `node_modules/@syntax-syllogism/aloop/presets/work-item/prompts/`
there; copy `loop.config.mjs` separately if its settings match your repository.

---
title: Publishing
description: How aloop hands off a pull-request description and verifies driver-owned publishing.
---

# Publishing

The default pipeline separates PR writing from remote mutation:

1. `pr-description` is an agent phase. It inspects the committed work and
   writes only `{{RUN_DIR}}/pr.md`.
2. `publish` is a driver phase. It verifies the clean, approved tree, pushes
   the configured branch, and creates or updates the pull request through the
   configured backend.

The description file must begin with a one-line title, a blank line, and a
non-empty body. The shipped prompt asks for a body of fewer than 250 words:

```text
Title: Add request tracing

Summarizes the implementation, validation, review outcome, and deliberate
out-of-scope work.
```

The description phase must not commit, push, or call a pull-request service.
Its clean-tree and unchanged-`HEAD` postconditions make the handoff
deterministic.

## Publish safeguards

Before the driver mutates a remote, it requires:

- a clean worktree;
- a current `HEAD` matching the latest approved review SHA; and
- a passing gate receipt for that same SHA before the approval.

Publishing then runs the backend precheck, pushes with upstream tracking and
without force, and reads the remote branch SHA. A mismatch with the approved
SHA stalls the run before PR creation or update. The driver then looks up the
branch's existing PR, updates it when present or creates one when absent, and
performs a final lookup.

The final PR must report the configured base branch, approved head SHA, draft
state, URL, and numeric PR number. Any missing or mismatched value stalls the
run. A stalled publish phase remains incomplete, so `--resume` retries it with
the existing run artifacts and commits intact.

## GitHub backend

The default backend is GitHub through the authenticated `gh` CLI. Its precheck
resolves the configured Git remote to a GitHub repository and runs `gh auth
status`. Every PR inspection, creation, and update command is bound to that
repository with `--repo`, so a repository with multiple remotes still uses the
configured `remote`. `publish.draft` defaults to `true`; set it to `false` when
the PR should be created as ready for review.

```js
export default {
  remote: 'origin',
  phases: ['implement', 'docs', 'gate', 'review', 'pr-description', 'publish'],
  publish: { backend: 'github', draft: true },
};
```

GitHub publishing needs network access and an authenticated `gh` installation.
Use `aloop doctor` to check the local CLI prerequisites before a real run.

## GitLab backend

Set `publish.backend` to `'gitlab'` to use the bundled transport backed by the
authenticated `glab` CLI:

```js
publish: { backend: 'gitlab', draft: true }
```

The backend resolves the GitLab host and full project path from the configured
Git remote. HTTPS, SSH, scp-style remotes, nested groups, and self-hosted
instances with ports are supported. Its precheck runs `glab auth status` for
the resolved host, and publishing uses `--repo https://<host>/<project>` so the
configured `remote` selects the repository. The final merge request is
verified against the configured target branch, approved head SHA, URL, IID,
and draft state.

GitLab drafts use both the native draft flag and the `Draft:` title convention;
an existing `Draft:` or `WIP:` prefix is not duplicated. Setting
`publish.draft` to `false` removes either prefix from the title and uses
GitLab's `--ready` update option. `glab` must be installed and authenticated;
the publish precheck fails before pushing when it is unavailable or
unauthenticated.

For REST, MCP, or another GitLab client, import `gitlabBackend` and inject a
transport. The transport receives GitLab-native values and the backend maps
merge requests to aloop's verified pull-request shape:

| Method | Required context/result |
| --- | --- |
| `checkAuth` | `{ host }` → resolves or throws |
| `getMergeRequest` | `{ host, project, branch }` → `{ iid, web_url, target_branch, sha, draft }` (or legacy `work_in_progress`) or `null` |
| `createMergeRequest` | `{ host, project, sourceBranch, targetBranch, title, description, descriptionFilePath, draft }` |
| `updateMergeRequest` | `{ host, project, iid, branch, title, description, descriptionFilePath, draft }` |

```js
import { gitlabBackend } from '@syntax-syllogism/aloop';

const myMcpTransport = {
  checkAuth,
  getMergeRequest,
  createMergeRequest,
  updateMergeRequest,
};

export default {
  publish: { backend: gitlabBackend({ transport: myMcpTransport }), draft: true },
};
```

## Custom backends

Set `publish.backend` to an object to use another service. The object must
provide all four operations; the driver passes these context objects:

```js
{
  async precheck({ remote, branch, base }) {},
  async view({ remote, branch, base }) {},
  async create({ remote, branch, base, title, body, bodyFilePath, draft }) {},
  async update({ remote, branch, base, title, body, bodyFilePath, draft }) {},
}
```

`view` returns the existing PR or `null` when none exists. After `create` or
`update`, the final `view` result must contain `url`, integer `number`,
`baseRefName`, `headRefOid`, and boolean `isDraft` values that match the
configured base, approved SHA, and draft setting. `bodyFilePath` points to a
temporary body-only file in the run directory; the driver removes it after the
operation. Backends may use either `body` or that file path.

Publishing results are retained in `manifest.json` on the `publish` phase,
including `approvedSha`, `remoteSha`, `prUrl`, and the verified `pullRequest`
object. The successful URL is also shown by the run report and read-only
operations such as `aloop status` and `aloop inspect --json`.

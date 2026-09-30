---
title: Publishing
description: How aloop hands off a pull-request description and verifies driver-owned publishing.
---

# Publishing

The default pipeline keeps writing the PR separate from changing the remote:

1. `pr-description` is an agent phase. It inspects the committed work and writes only `{{RUN_DIR}}/pr.md`.
2. `publish` is a driver phase. It verifies the clean, approved tree, pushes the configured branch, and creates or updates the pull request through the configured backend.

The description file starts with a one-line title, then a blank line, then a non-empty body. The shipped prompt asks for a body under 250 words:

```text
Title: Add request tracing

Summarizes the implementation, validation, review outcome, and deliberate
out-of-scope work.
```

The description phase must not commit, push, or call a pull-request service. Its postconditions, a clean tree and an unchanged `HEAD`, keep the handoff deterministic.

## Publish safeguards

Before the driver changes a remote, it requires:

- a clean worktree;
- a current `HEAD` that matches the latest approved review SHA;
- a passing gate receipt for that same SHA, dated before the approval.

Then it runs the backend precheck, pushes with upstream tracking and no force, and reads the remote branch SHA. If that SHA differs from the approved one, the run stalls before any PR is created or updated. Otherwise the driver looks up the branch's existing PR, updates it or creates one, and looks it up once more.

The final PR must report the configured base branch, the approved head SHA, the draft state, a URL, and a numeric PR number. A missing or mismatched value stalls the run. A stalled publish phase stays incomplete, so `--resume` retries it with the existing run artifacts and commits intact.

## GitHub backend

GitHub is the default, through the signed-in `gh` CLI. The precheck resolves the configured Git remote to a GitHub repository and runs `gh auth status`. Every PR lookup, creation, and update is bound to that repository with `--repo`, so a repository with several remotes still uses the configured `remote`. `publish.draft` defaults to `true`. Set it to `false` to create PRs that are ready for review.

```js
export default {
  remote: 'origin',
  phases: ['implement', 'docs', 'gate', 'review', 'pr-description', 'publish'],
  publish: { backend: 'github', draft: true },
};
```

You need network access and a signed-in `gh`. Run `aloop doctor` before a real run to check the local CLI prerequisites.

## GitLab backend

Set `publish.backend` to `'gitlab'` to use the bundled transport, which relies on the signed-in `glab` CLI:

```js
publish: { backend: 'gitlab', draft: true }
```

The backend finds the GitLab host and full project path from the configured Git remote. It handles HTTPS, SSH, scp-style remotes, nested groups, and self-hosted instances with ports. The precheck runs `glab auth status` for that host. Publishing uses `--repo https://<host>/<project>`, so the configured `remote` picks the repository. The final merge request is checked against the target branch, approved head SHA, URL, IID, and draft state.

GitLab drafts use both the native draft flag and the `Draft:` title prefix. An existing `Draft:` or `WIP:` prefix isn't duplicated. With `publish.draft: false`, either prefix is removed from the title and the update uses GitLab's `--ready` option. `glab` must be installed and signed in. If it isn't, the precheck fails before anything is pushed.

For a REST, MCP, or other GitLab client, import `gitlabBackend` and inject a transport. The transport works in GitLab's own terms, and the backend maps merge requests to aloop's verified pull-request shape:

| Method | Context in, result out |
| --- | --- |
| `checkAuth` | `{ host }`. Resolves or throws. |
| `getMergeRequest` | `{ host, project, branch }`. Returns `{ iid, web_url, target_branch, sha, draft }` (or legacy `work_in_progress`), or `null`. |
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

To use another service, set `publish.backend` to an object with all four operations. The driver passes these contexts:

```js
{
  async precheck({ remote, branch, base }) {},
  async view({ remote, branch, base }) {},
  async create({ remote, branch, base, title, body, bodyFilePath, draft }) {},
  async update({ remote, branch, base, title, body, bodyFilePath, draft }) {},
}
```

`view` returns the existing PR, or `null` if there isn't one. After `create` or `update`, the final `view` result must contain `url`, an integer `number`, `baseRefName`, `headRefOid`, and a boolean `isDraft`. They must match the configured base, the approved SHA, and the draft setting. `bodyFilePath` points to a temporary body-only file in the run directory, which the driver removes afterward. A backend can use either `body` or that path.

The publish result is kept in `manifest.json` on the `publish` phase: `approvedSha`, `remoteSha`, `prUrl`, and the verified `pullRequest` object. The URL also appears in the run report and in `aloop status` and `aloop inspect --json`.

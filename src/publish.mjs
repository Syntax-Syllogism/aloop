import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCommand } from './command.mjs';
import { GitFacade } from './git.mjs';
import { gitlabBackend } from './backends/gitlab.mjs';

const PR_FIELDS = 'url,baseRefName,headRefOid,isDraft,number';

export class PublishError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PublishError';
  }
}

export function parsePullRequestDescription(contents) {
  const match = /^Title:\s*(.+?)\r?\n\r?\n([\s\S]*?)\s*$/i.exec(contents);
  if (!match) {
    throw new PublishError('PR description must start with "Title: <one-line title>", followed by a blank line and body.');
  }
  const title = match[1].trim();
  const body = match[2].trim();
  if (!title) throw new PublishError('PR description title must not be empty.');
  if (!body) throw new PublishError('PR description body must not be empty.');
  return { title, body };
}

export function githubBackend(options = {}) {
  const { cwd, git = new GitFacade(cwd), runner = runCommand, env } = /** @type {any} */ (options);
  const repositories = new Map();

  async function resolveRepository(remote) {
    if (!repositories.has(remote)) {
      const remoteUrl = await git.remoteUrl(remote);
      const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
      if (!match) {
        throw new PublishError(`Configured remote ${remote} does not point to a GitHub repository.`);
      }
      repositories.set(remote, match[1]);
    }
    return repositories.get(remote);
  }

  async function run(args) {
    try {
      return await runner('gh', args, { cwd, ...(env ? { env } : {}) });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new PublishError('GitHub publishing requires the `gh` CLI, but it is not installed.', { cause: error });
      }
      throw new PublishError(error.output?.trim() || error.message, { cause: error });
    }
  }

  async function runPullRequest(remote, args) {
    return run([...args, '--repo', await resolveRepository(remote)]);
  }

  return {
    async precheck({ remote }) {
      try {
        await resolveRepository(remote);
        await run(['auth', 'status']);
      } catch (error) {
        throw new PublishError(`GitHub publishing precheck failed: ${error.message}`, { cause: error });
      }
    },
    async view({ remote, branch }) {
      try {
        const result = await runPullRequest(remote, ['pr', 'view', branch, '--json', PR_FIELDS]);
        return JSON.parse(result.stdout);
      } catch (error) {
        // `gh pr view` uses exit 1 when a branch has no PR. Authentication and
        // executable failures were already checked by precheck and remain
        // errors at this point.
        if (error.cause?.output?.toLowerCase().includes('no pull requests found')) return null;
        if (error.message.toLowerCase().includes('no pull requests found')) return null;
        throw new PublishError(`Unable to inspect pull request for ${branch}: ${error.message}`, { cause: error });
      }
    },
    async create({ remote, base, branch, title, bodyFilePath, draft }) {
      const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFilePath];
      if (draft) args.push('--draft');
      await runPullRequest(remote, args);
    },
    async update({ remote, branch, title, bodyFilePath }) {
      await runPullRequest(remote, ['pr', 'edit', branch, '--title', title, '--body-file', bodyFilePath]);
    },
  };
}

function resolveBackend(backend, cwd, git, env) {
  if (backend === undefined || backend === null || backend === 'github') return githubBackend({ cwd, git, env });
  if (backend === 'gitlab') return gitlabBackend({ cwd, git, env });
  if (typeof backend === 'object' && backend !== null) {
    if (env !== undefined) {
      throw new PublishError('Hermetic publishing does not support in-process custom backends; use the built-in GitHub backend or disable hermetic publishing.');
    }
    return backend;
  }
  throw new PublishError(`Unsupported publish backend "${backend}".`);
}

function assertVerifiedPullRequest(pullRequest, { base, branch, localSha, draft }) {
  if (!pullRequest || typeof pullRequest !== 'object') {
    throw new PublishError(`No pull request exists for branch ${branch} after publishing.`);
  }
  if (pullRequest.baseRefName !== base) {
    throw new PublishError(`Pull request base ${pullRequest.baseRefName ?? '(none)'} does not match configured base ${base}.`);
  }
  if (pullRequest.headRefOid?.toLowerCase() !== localSha.toLowerCase()) {
    throw new PublishError(`Pull request head SHA ${pullRequest.headRefOid ?? '(none)'} does not match approved SHA ${localSha}.`);
  }
  if (pullRequest.isDraft !== draft) {
    throw new PublishError(`Pull request draft state ${String(pullRequest.isDraft)} does not match configured draft state ${String(draft)}.`);
  }
  if (typeof pullRequest.url !== 'string' || !pullRequest.url) {
    throw new PublishError('Pull request verification returned no URL.');
  }
  if (!Number.isInteger(pullRequest.number)) {
    throw new PublishError('Pull request verification returned no number.');
  }
}

/**
 * Push an attested branch and create or update exactly one verified PR.
 *
 * Git is passed in as a facade and the backend is a small port. The default
 * backend is GitHub's `gh` CLI; other remotes can supply the same precheck,
 * view, create, and update operations without changing this use case.
 */
export async function publish(options = {}) {
  const { git, remote, branch, base, prBodyPath, draft = true, backend = 'github', approvedSha = null, env } = /** @type {any} */ (options);
  if (!git || typeof git.push !== 'function' || typeof git.lsRemote !== 'function') {
    throw new PublishError('Publish requires a GitFacade with push and lsRemote operations.');
  }
  if (!prBodyPath) throw new PublishError('Publish requires a PR description path.');

  const selectedBackend = resolveBackend(backend, git.cwd, git, env);
  for (const operation of ['precheck', 'view', 'create', 'update']) {
    if (typeof selectedBackend[operation] !== 'function') {
      throw new PublishError(`Publish backend is missing its ${operation} operation.`);
    }
  }
  await selectedBackend.precheck({ remote, branch, base });

  const localSha = approvedSha ?? await git.revParse();
  const description = parsePullRequestDescription(await readFile(prBodyPath, 'utf8'));
  const bodyFilePath = join(dirname(prBodyPath), '.pr-body.md');
  await writeFile(bodyFilePath, `${description.body}\n`, 'utf8');
  try {
    await git.push(remote, branch, { setUpstream: true, ...(env ? { env } : {}) });
    const remoteSha = await git.lsRemote(remote, branch, env ? { env } : {});
    if (remoteSha.toLowerCase() !== localSha.toLowerCase()) {
      throw new PublishError(`Remote branch ${remote}/${branch} SHA ${remoteSha} does not match approved SHA ${localSha}.`);
    }

    const existing = await selectedBackend.view({ remote, branch, base });
    if (existing) {
      await selectedBackend.update({ remote, branch, base, title: description.title, body: description.body, bodyFilePath, draft });
    } else {
      await selectedBackend.create({ remote, branch, base, title: description.title, body: description.body, bodyFilePath, draft });
    }
    const pullRequest = await selectedBackend.view({ remote, branch, base });
    assertVerifiedPullRequest(pullRequest, { base, branch, localSha, draft });
    return {
      localSha,
      remoteSha,
      created: !existing,
      pullRequest,
    };
  } finally {
    await unlink(bodyFilePath).catch(() => {});
  }
}

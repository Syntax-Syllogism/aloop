import { runCommand } from '../command.mjs';
import { GitFacade } from '../git.mjs';
import { PublishError } from '../publish.mjs';

const DRAFT_RE = /^(draft:\s*|wip:\s*)/i;
const NO_MERGE_REQUEST_RE = /\b(?:no merge requests? found|merge requests? not found|merge requests? (?:do|does) not exist)\b/i;

/**
 * @typedef {object} GitLabMr
 * @property {number} iid
 * @property {string} web_url
 * @property {string} target_branch
 * @property {string} sha - The merge request head commit SHA.
 * @property {boolean} [draft]
 * @property {boolean} [work_in_progress] - Legacy GitLab draft field.
 */

/**
 * @typedef {object} GitLabTransport
 * @property {(ctx: { host: string }) => Promise<void>} checkAuth
 * @property {(ctx: { host: string, project: string, branch: string }) => Promise<GitLabMr|null>} getMergeRequest
 * @property {(ctx: { host: string, project: string, sourceBranch: string, targetBranch: string, title: string, description: string, descriptionFilePath?: string, draft: boolean }) => Promise<void>} createMergeRequest
 * @property {(ctx: { host: string, project: string, iid: number, branch: string, title: string, description: string, descriptionFilePath?: string, draft: boolean }) => Promise<void>} updateMergeRequest
 */

/**
 * Parse the URL forms emitted by Git, retaining a self-hosted port in `host`.
 * GitLab project paths may contain any number of namespace segments.
 */
export function parseGitLabRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) {
    throw new PublishError('Configured GitLab remote is not a valid Git remote URL.');
  }

  const value = remoteUrl.trim();
  let host;
  let project;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new PublishError(`Configured GitLab remote is not a valid Git remote URL: ${value}`, { cause: error });
    }
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol) || !parsed.host) {
      throw new PublishError(`Configured GitLab remote is not a valid Git remote URL: ${value}`);
    }
    host = parsed.host;
    project = parsed.pathname;
  } else {
    const match = /^git@(?:(\[[^\]]+\])|([^:/]+)):(.+)$/i.exec(value);
    if (!match) {
      throw new PublishError(`Configured GitLab remote is not a valid Git remote URL: ${value}`);
    }
    host = match[1] ?? match[2];
    project = match[3];
    // Git's scp-like syntax has no standard port notation. Accept the common
    // git@host:2222/group/project form while keeping normal namespace paths.
    const portMatch = /^(\d+)\/(.+)$/.exec(project);
    if (portMatch) {
      host = `${host}:${portMatch[1]}`;
      project = portMatch[2];
    }
  }

  project = project.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !project || project.split('/').some((segment) => !segment)) {
    throw new PublishError(`Configured GitLab remote is not a valid Git remote URL: ${value}`);
  }
  return { host, project };
}

export const withDraftPrefix = (title) => DRAFT_RE.test(title) ? title : `Draft: ${title}`;
export const withoutDraftPrefix = (title) => title.replace(DRAFT_RE, '');

function errorText(error) {
  return [error?.output, error?.stderr, error?.cause?.output, error?.message]
    .filter(Boolean)
    .join('\n');
}

/**
 * The default GitLab transport. `glab` is intentionally an external runtime
 * requirement, so consumers can replace this transport with REST or MCP code.
 */
export function glabTransport(options = {}) {
  const { cwd, runner = runCommand, env } = /** @type {any} */ (options);
  async function run(args) {
    try {
      return await runner('glab', args, { cwd, ...(env ? { env } : {}) });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new PublishError('GitLab publishing requires the `glab` CLI, but it is not installed.', { cause: error });
      }
      throw new PublishError(errorText(error).trim() || 'GitLab CLI command failed.', { cause: error });
    }
  }

  const repository = (host, project) => `https://${host}/${project}`;
  const descriptionArgs = (description, descriptionFilePath) => descriptionFilePath
    ? ['--description-file', descriptionFilePath]
    : ['--description', description];

  return {
    async checkAuth({ host }) {
      await run(['auth', 'status', '--hostname', host]);
    },

    async getMergeRequest({ host, project, branch }) {
      try {
        const result = await run(['mr', 'view', branch, '--output', 'json', '--repo', repository(host, project)]);
        return JSON.parse(result.stdout);
      } catch (error) {
        const output = errorText(error);
        if (error.cause?.code === 'ENOENT') throw error;
        // Only the CLI's explicit no-MR messages mean it is safe to create one.
        // Other exit-code-1 failures, such as permissions or connectivity, must
        // reach publish() instead of being mistaken for an absent MR.
        if (NO_MERGE_REQUEST_RE.test(output)) {
          return null;
        }
        throw new PublishError(`Unable to inspect GitLab merge request for ${branch}: ${error.message}`, { cause: error });
      }
    },

    async createMergeRequest({ host, project, sourceBranch, targetBranch, title, description, descriptionFilePath, draft }) {
      const args = [
        'mr', 'create',
        '--repo', repository(host, project),
        '--source-branch', sourceBranch,
        '--target-branch', targetBranch,
        '--title', title,
        ...descriptionArgs(description, descriptionFilePath),
        ...(draft ? ['--draft'] : []),
        '--yes',
      ];
      await run(args);
    },

    async updateMergeRequest({ host, project, iid, title, description, descriptionFilePath, draft }) {
      const args = [
        'mr', 'update', String(iid),
        '--repo', repository(host, project),
        '--title', title,
        ...descriptionArgs(description, descriptionFilePath),
        draft ? '--draft' : '--ready',
        '--yes',
      ];
      await run(args);
    },
  };
}

/**
 * Adapt GitLab-native merge request data to aloop's verified pull-request port.
 *
 * @param {any} options
 */
export function gitlabBackend(options = {}) {
  let { cwd, git = new GitFacade(cwd), transport, env } = options;
  transport ??= glabTransport({ cwd, env });
  const repositories = new Map();

  async function resolveRepository(remote) {
    if (!repositories.has(remote)) {
      const remoteUrl = await git.remoteUrl(remote);
      repositories.set(remote, parseGitLabRemoteUrl(remoteUrl));
    }
    return repositories.get(remote);
  }

  async function mergeRequest(remote, branch) {
    const { host, project } = await resolveRepository(remote);
    return { host, project, mr: await transport.getMergeRequest({ host, project, branch }) };
  }

  function mapMergeRequest(mr) {
    if (!mr) return null;
    return {
      url: mr.web_url,
      baseRefName: mr.target_branch,
      headRefOid: mr.sha,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      number: Number(mr.iid),
    };
  }

  return {
    async precheck({ remote }) {
      try {
        const { host } = await resolveRepository(remote);
        await transport.checkAuth({ host });
      } catch (error) {
        throw new PublishError(`GitLab publishing precheck failed: ${error.message}`, { cause: error });
      }
    },

    async view({ remote, branch }) {
      return mapMergeRequest((await mergeRequest(remote, branch)).mr);
    },

    async create({ remote, base, branch, title, body, bodyFilePath, draft }) {
      const { host, project } = await resolveRepository(remote);
      await transport.createMergeRequest({
        host,
        project,
        sourceBranch: branch,
        targetBranch: base,
        title: draft ? withDraftPrefix(title) : withoutDraftPrefix(title),
        description: body,
        descriptionFilePath: bodyFilePath,
        draft,
      });
    },

    async update({ remote, branch, title, body, bodyFilePath, draft }) {
      const { host, project, mr } = await mergeRequest(remote, branch);
      if (!mr) throw new PublishError(`No GitLab merge request exists for branch ${branch}.`);
      const iid = Number(mr.iid);
      if (!Number.isInteger(iid)) throw new PublishError(`GitLab merge request for branch ${branch} has no valid IID.`);
      await transport.updateMergeRequest({
        host,
        project,
        iid,
        branch,
        title: draft ? withDraftPrefix(title) : withoutDraftPrefix(title),
        description: body,
        descriptionFilePath: bodyFilePath,
        draft,
      });
    },
  };
}

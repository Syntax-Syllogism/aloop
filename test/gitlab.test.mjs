import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitlabBackend, glabTransport, parseGitLabRemoteUrl } from '../src/index.mjs';
import { githubBackend, publish } from '../src/publish.mjs';
import * as packageApi from '@syntax-syllogism/aloop';

const sha = 'a'.repeat(40);

test('GitLab remote URLs support HTTPS, SSH, scp syntax, ports, and nested groups', () => {
  const cases = [
    ['https://gitlab.com/group/sub/project.git', { host: 'gitlab.com', project: 'group/sub/project' }],
    ['git@gitlab.com:group/sub/project.git', { host: 'gitlab.com', project: 'group/sub/project' }],
    ['ssh://git@gitlab.example.com:2222/group/sub/project.git', { host: 'gitlab.example.com:2222', project: 'group/sub/project' }],
    ['git@gitlab.example.com:2222/group/sub/project.git', { host: 'gitlab.example.com:2222', project: 'group/sub/project' }],
  ];
  for (const [remote, expected] of cases) assert.deepEqual(parseGitLabRemoteUrl(remote), expected);
  assert.throws(() => parseGitLabRemoteUrl('/local/repository'), /not a valid Git remote URL/);
});

test('GitLab backend maps native MR fields and supports the legacy draft field', async () => {
  const calls = [];
  const backend = gitlabBackend({
    cwd: '/tmp',
    git: { async remoteUrl() { return 'git@gitlab.example.com:group/sub/project.git'; } },
    transport: {
      async checkAuth(context) { calls.push(['auth', context]); },
      async getMergeRequest(context) {
        calls.push(['view', context]);
        return { iid: 8, web_url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/8', target_branch: 'master', sha, work_in_progress: true };
      },
      async createMergeRequest() {},
      async updateMergeRequest() {},
    },
  });

  await backend.precheck({ remote: 'origin' });
  assert.deepEqual(await backend.view({ remote: 'origin', branch: 'feat/example' }), {
    url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/8',
    baseRefName: 'master',
    headRefOid: sha,
    isDraft: true,
    number: 8,
  });
  assert.deepEqual(calls, [
    ['auth', { host: 'gitlab.example.com' }],
    ['view', { host: 'gitlab.example.com', project: 'group/sub/project', branch: 'feat/example' }],
  ]);
});

test('GitLab publish creates and then updates a verified draft MR', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-gitlab-publish-'));
  const bodyPath = join(runDir, 'pr.md');
  await writeFile(bodyPath, 'Title: Ship it\n\nThe GitLab body.\n');
  let mergeRequest = null;
  const calls = [];
  const git = {
    cwd: runDir,
    async remoteUrl() { return 'https://gitlab.com/group/project.git'; },
    async push() { calls.push('push'); },
    async lsRemote() { return sha; },
  };
  const transport = {
    async checkAuth() { calls.push('auth'); },
    async getMergeRequest() { calls.push('view'); return mergeRequest; },
    async createMergeRequest(options) {
      calls.push(['create', options]);
      mergeRequest = { iid: 11, web_url: 'https://gitlab.com/group/project/-/merge_requests/11', target_branch: options.targetBranch, sha, draft: options.draft };
    },
    async updateMergeRequest(options) {
      calls.push(['update', options]);
      mergeRequest = { ...mergeRequest, target_branch: 'master', draft: options.draft };
    },
  };
  const options = { git, remote: 'origin', branch: 'feat/example', base: 'master', prBodyPath: bodyPath, approvedSha: sha, transport };

  const created = await publish({ ...options, backend: gitlabBackend({ cwd: runDir, git, transport }) });
  assert.equal(created.created, true);
  assert.equal(created.pullRequest.isDraft, true);
  assert.equal(calls.find(([name]) => name === 'create')[1].title, 'Draft: Ship it');

  const updated = await publish({ ...options, draft: false, backend: gitlabBackend({ cwd: runDir, git, transport }) });
  assert.equal(updated.created, false);
  assert.equal(updated.pullRequest.isDraft, false);
  assert.equal(calls.find(([name]) => name === 'update')[1].title, 'Ship it');
  assert.equal(calls.find(([name]) => name === 'update')[1].draft, false);
});

test('GitLab publish resolves the bundled backend through a fake glab CLI', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'loop-gitlab-glab-'));
  const binDir = await mkdtemp(join(tmpdir(), 'loop-gitlab-glab-bin-'));
  const bodyPath = join(runDir, 'pr.md');
  const statePath = join(runDir, 'mr.json');
  const logPath = join(runDir, 'glab.log');
  await writeFile(bodyPath, 'Title: Ship it\n\nThe GitLab body.\n');
  await writeFile(join(binDir, 'glab'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GLAB_LOG"
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
if [ "$1" = mr ] && [ "$2" = view ]; then
  if [ -f "$FAKE_GLAB_STATE" ]; then cat "$FAKE_GLAB_STATE"; exit 0; fi
  printf '%s\\n' 'no merge requests found' >&2
  exit 1
fi
if [ "$1" = mr ] && [ "$2" = create ]; then
  printf '%s\\n' '{"iid":17,"web_url":"https://gitlab.com/group/project/-/merge_requests/17","target_branch":"master","sha":"'"$FAKE_GLAB_SHA"'","draft":true}' > "$FAKE_GLAB_STATE"
  exit 0
fi
if [ "$1" = mr ] && [ "$2" = update ]; then
  printf '%s\\n' '{"iid":17,"web_url":"https://gitlab.com/group/project/-/merge_requests/17","target_branch":"master","sha":"'"$FAKE_GLAB_SHA"'","draft":false}' > "$FAKE_GLAB_STATE"
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const environment = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_GLAB_LOG: logPath,
    FAKE_GLAB_STATE: statePath,
    FAKE_GLAB_SHA: sha,
  };
  const git = {
    cwd: runDir,
    async remoteUrl() { return 'https://gitlab.com/group/project.git'; },
    async push() {},
    async lsRemote() { return sha; },
  };
  const options = {
    git,
    remote: 'origin',
    branch: 'feat/example',
    base: 'master',
    prBodyPath: bodyPath,
    approvedSha: sha,
    env: environment,
    backend: 'gitlab',
  };

  const created = await publish(options);
  assert.deepEqual(created.pullRequest, {
    url: 'https://gitlab.com/group/project/-/merge_requests/17',
    baseRefName: 'master',
    headRefOid: sha,
    isDraft: true,
    number: 17,
  });
  assert.equal(created.created, true);

  const updated = await publish({ ...options, draft: false });
  assert.deepEqual(updated.pullRequest, {
    url: 'https://gitlab.com/group/project/-/merge_requests/17',
    baseRefName: 'master',
    headRefOid: sha,
    isDraft: false,
    number: 17,
  });
  assert.equal(updated.created, false);

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(calls[0], 'auth status --hostname gitlab.com');
  assert.match(calls[1], /^mr view feat\/example --output json --repo https:\/\/gitlab\.com\/group\/project$/);
  assert.match(calls[2], /^mr create --repo https:\/\/gitlab\.com\/group\/project --source-branch feat\/example --target-branch master --title Draft: Ship it --description-file .+ --draft --yes$/);
  assert.match(calls[3], /^mr view feat\/example --output json --repo https:\/\/gitlab\.com\/group\/project$/);
  assert.equal(calls[4], 'auth status --hostname gitlab.com');
  assert.match(calls[5], /^mr view feat\/example --output json --repo https:\/\/gitlab\.com\/group\/project$/);
  assert.match(calls[6], /^mr view feat\/example --output json --repo https:\/\/gitlab\.com\/group\/project$/);
  assert.match(calls[7], /^mr update 17 --repo https:\/\/gitlab\.com\/group\/project --title Ship it --description-file .+ --ready --yes$/);
  assert.match(calls[8], /^mr view feat\/example --output json --repo https:\/\/gitlab\.com\/group\/project$/);
});

test('GitLab backend surfaces auth failures and publish rejects a mismatched head SHA', async () => {
  const git = {
    cwd: '/tmp',
    async remoteUrl() { return 'git@gitlab.com:group/project.git'; },
    async push() {},
    async lsRemote() { return sha; },
  };
  const failing = gitlabBackend({
    cwd: '/tmp',
    git,
    transport: {
      async checkAuth() { throw new Error('token expired'); },
      async getMergeRequest() { return null; },
      async createMergeRequest() {},
      async updateMergeRequest() {},
    },
  });
  await assert.rejects(failing.precheck({ remote: 'origin' }), /GitLab publishing precheck failed: token expired/);

  const runDir = await mkdtemp(join(tmpdir(), 'loop-gitlab-publish-'));
  const bodyPath = join(runDir, 'pr.md');
  await writeFile(bodyPath, 'Title: Mismatch\n\nBody.\n');
  await assert.rejects(
    publish({
      git,
      remote: 'origin',
      branch: 'feat/example',
      base: 'master',
      prBodyPath: bodyPath,
      approvedSha: sha,
      backend: gitlabBackend({
        cwd: '/tmp',
        git,
        transport: {
          async checkAuth() {},
          async getMergeRequest() { return { iid: 1, web_url: 'https://gitlab.com/mr/1', target_branch: 'master', sha: 'b'.repeat(40), draft: true }; },
          async createMergeRequest() {},
          async updateMergeRequest() {},
        },
      }),
    }),
    /does not match approved SHA/,
  );
});

test('glab transport uses host-aware JSON, description-file, draft, and ready flags', async () => {
  const calls = [];
  const transport = glabTransport({
    cwd: '/tmp',
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'mr' && args[1] === 'view') return { stdout: '{"iid":3}', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });
  await transport.checkAuth({ host: 'gitlab.example.com' });
  assert.deepEqual(await transport.getMergeRequest({ host: 'gitlab.example.com', project: 'group/project', branch: 'feat/x' }), { iid: 3 });
  await transport.createMergeRequest({ host: 'gitlab.example.com', project: 'group/project', sourceBranch: 'feat/x', targetBranch: 'master', title: 'Draft: x', description: 'body', descriptionFilePath: '/tmp/body.md', draft: true });
  await transport.updateMergeRequest({ host: 'gitlab.example.com', project: 'group/project', iid: 3, title: 'x', description: 'body', descriptionFilePath: '/tmp/body.md', draft: false });

  assert.deepEqual(calls[0], ['glab', ['auth', 'status', '--hostname', 'gitlab.example.com']]);
  assert.deepEqual(calls[1], ['glab', ['mr', 'view', 'feat/x', '--output', 'json', '--repo', 'https://gitlab.example.com/group/project']]);
  assert.ok(calls[2][1].includes('--description-file'));
  assert.ok(calls[2][1].includes('--draft'));
  assert.ok(calls[3][1].includes('--description-file'));
  assert.ok(calls[3][1].includes('--ready'));
});

test('glab transport maps missing MRs and missing CLI errors', async () => {
  const missing = glabTransport({
    runner: async () => {
      const error = new Error('no merge requests found');
      error.output = error.message;
      throw error;
    },
  });
  assert.equal(await missing.getMergeRequest({ host: 'gitlab.com', project: 'group/project', branch: 'feat/x' }), null);

  const permissionDenied = glabTransport({
    runner: async () => {
      const error = new Error('permission denied');
      error.code = 1;
      error.stderr = 'permission denied';
      throw error;
    },
  });
  await assert.rejects(
    permissionDenied.getMergeRequest({ host: 'gitlab.com', project: 'group/project', branch: 'feat/x' }),
    /Unable to inspect GitLab merge request for feat\/x/,
  );

  const absent = glabTransport({ runner: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } });
  await assert.rejects(absent.checkAuth({ host: 'gitlab.com' }), /requires the `glab` CLI/);
});

test('public package exports expose both bundled backends', () => {
  assert.equal(packageApi.gitlabBackend, gitlabBackend);
  assert.equal(packageApi.githubBackend, githubBackend);
});

import { runCommand } from './command.mjs';

export class GitFacade {
  constructor(cwd, runner = runCommand) {
    this.cwd = cwd;
    this.runner = runner;
  }

  async run(args, options = {}) {
    return this.runner('git', args, { cwd: this.cwd, ...options });
  }

  async output(args, options = {}) {
    return (await this.run(args, options)).stdout.trim();
  }

  async toplevel() {
    return this.output(['rev-parse', '--show-toplevel']);
  }

  async commonDir() {
    return this.output(['rev-parse', '--git-common-dir']);
  }

  async currentBranch() {
    return this.output(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  async revParse(ref = 'HEAD') {
    return this.output(['rev-parse', ref]);
  }

  async diffNumstat(baseSha, headSha) {
    const { stdout } = await this.run([
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      `${baseSha}...${headSha}`,
      '--',
    ]);
    return stdout;
  }

  async status(options = []) {
    return this.output(['status', '--porcelain', ...options]);
  }

  async isDirty(options = []) {
    return Boolean(await this.status(options));
  }

  async push(remote, branch, { setUpstream = true, ...options } = {}) {
    return this.run(['push', ...(setUpstream ? ['--set-upstream'] : []), remote, branch], options);
  }

  async lsRemote(remote, branch, options = {}) {
    const output = await this.output(['ls-remote', remote, `refs/heads/${branch}`], options);
    const sha = output.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`Remote branch ${remote}/${branch} has no resolvable SHA.`);
    }
    return sha;
  }

  async localBranchExists(branch) {
    try {
      await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async remotes() {
    return (await this.output(['remote'])).split('\n').filter(Boolean);
  }

  async remoteExists(remote) {
    return (await this.remotes()).includes(remote);
  }

  async remoteUrl(remote) {
    return this.output(['remote', 'get-url', remote]);
  }

  async defaultRemote() {
    const remotes = await this.remotes();
    if (remotes.includes('origin')) return 'origin';
    return remotes[0] ?? null;
  }

  /**
   * Create (or reuse) a worktree checked out to `branch`.
   *
   * Reuse matters for `--resume`: a run that died after phase two must land in
   * the same tree it was building, not a fresh one branched off the base again.
   */
  async addWorktree(path, branch, base) {
    if (await this.localBranchExists(branch)) {
      await this.run(['worktree', 'add', path, branch]);
      return { path, branch, created: false };
    }
    await this.run(['worktree', 'add', '-b', branch, path, base]);
    return { path, branch, created: true };
  }

  async worktreeList() {
    const { stdout } = await this.run(['worktree', 'list', '--porcelain', '-z']);
    return stdout.split('\0\0').flatMap((block) => {
      const fields = block.split('\0');
      const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
      const ref = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length);
      return path ? [{ path, ref }] : [];
    });
  }

  async worktreePath(branch) {
    return (await this.worktreeList()).find(({ ref }) => ref === `refs/heads/${branch}`)?.path ?? null;
  }

  async removeWorktree(path, { force = false } = {}) {
    await this.run(['worktree', 'remove', ...(force ? ['--force'] : []), '--', path]);
  }

  async pruneWorktrees() {
    await this.run(['worktree', 'prune', '--expire', 'now']);
  }

  async isAncestor(commit, ref) {
    try {
      await this.run(['merge-base', '--is-ancestor', commit, ref]);
      return true;
    } catch (error) {
      if (error.code === 1 || error.code === 128) return false;
      throw error;
    }
  }

  async deleteBranch(branch) {
    await this.run(['branch', '-D', '--', branch]);
  }
}

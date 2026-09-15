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

  async status() {
    return this.output(['status', '--porcelain']);
  }

  async isDirty() {
    return Boolean(await this.status());
  }

  async push(remote, branch, { setUpstream = true, ...options } = {}) {
    return this.run([
      'push',
      ...(setUpstream ? ['--set-upstream'] : []),
      remote,
      branch,
    ], options);
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

  async worktreePath(branch) {
    const output = await this.output(['worktree', 'list', '--porcelain']);
    const blocks = output.split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n');
      const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      if (worktree && ref === `refs/heads/${branch}`) return worktree;
    }
    return null;
  }

  async removeWorktree(path) {
    await this.run(['worktree', 'remove', '--force', path]);
  }

}

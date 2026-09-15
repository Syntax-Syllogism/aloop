import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

async function directoryExists(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export async function resumedWorktree(git, repoRoot, branch, savedPath) {
  if (!savedPath) return null;
  if (resolve(savedPath) === resolve(repoRoot)) {
    if (await directoryExists(savedPath)) return savedPath;
  } else {
    const registeredPath = await git.worktreePath(branch);
    if (registeredPath && await directoryExists(registeredPath)) return registeredPath;
  }
  throw new Error(`Saved worktree "${savedPath}" for branch "${branch}" is unavailable. Restore it or re-register it with git worktree before resuming.`);
}

export async function planWorktree(git, config, slug, branch, repoRoot) {
  if (!config.worktrees) return { worktree: repoRoot, willCreate: false };
  const root = config.worktreeRoot ? resolve(repoRoot, config.worktreeRoot) : join(dirname(repoRoot), '.loop-worktrees');
  const existing = await git.worktreePath(branch);
  if (existing) return { worktree: existing, willCreate: false };
  return { worktree: join(root, slug), willCreate: true };
}

export async function setupWorktree(git, config, slug, branch, repoRoot, baseBranch) {
  const plan = await planWorktree(git, config, slug, branch, repoRoot);
  if (!plan.willCreate) return { worktree: plan.worktree, created: false, worktreeCreated: false };
  await mkdir(dirname(plan.worktree), { recursive: true });
  const result = await git.addWorktree(plan.worktree, branch, baseBranch);
  return { worktree: plan.worktree, created: result.created, worktreeCreated: true };
}

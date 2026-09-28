// aloop loop config — implement: sol, review: luna
export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  engines: {
    default: { name: 'codex', model: 'gpt-6-sol', effort: 'medium' },
    review: { name: 'codex', model: 'gpt-6-luna', effort: 'high' },
  },
  gate: ['npm test'],
  maxRounds: 3,
  timeoutMs: 60 * 60 * 1000,
  worktrees: true,
};

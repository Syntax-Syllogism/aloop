// aloop loop config — implement: luna, review: terra
export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  engines: {
    default: { name: 'codex', model: 'gpt-6-luna', effort: 'high' },
    review: { name: 'codex', model: 'gpt-6-sol', effort: 'medium' },
  },
  gate: ['npm test'],
  maxRounds: 3,
  timeoutMs: 60 * 60 * 1000,
  worktrees: true,
};

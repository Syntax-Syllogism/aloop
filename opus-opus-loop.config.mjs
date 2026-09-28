// aloop loop config — implement: opus, review: sonnet
export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  engines: {
    default: { name: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
    review: { name: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  },
  gate: ['npm test'],
  maxRounds: 3,
  timeoutMs: 60 * 60 * 1000,
  worktrees: true,
};

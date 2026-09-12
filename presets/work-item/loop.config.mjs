export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'gate', 'review', 'address', 'docs', 'git'],
  gate: ['npm test'],
  maxRounds: 3,
  timeoutMs: 30 * 60 * 1000,
};

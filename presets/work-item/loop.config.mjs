export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'origin',
  engines: {
    default: { name: 'claude', effort: 'high' },
    review: { name: 'codex', effort: 'high' },
  },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  gate: ['npm test'],
  maxRounds: 3,
  timeoutMs: 30 * 60 * 1000,
};

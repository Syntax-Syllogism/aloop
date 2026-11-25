/** @typedef {import('./types.js').ReviewRouting} ReviewRouting */

const defaults = {
  maxFiles: 10,
  maxChangedLines: 200,
  sensitivePaths: ['**/auth/**', '**/migrations/**', '.github/workflows/**'],
  lowReviewers: 1,
  highReviewers: 2,
  aggregation: 'unanimous',
};

/** @returns {ReviewRouting | null} */
export function normalizeReviewRouting(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`reviewRouting` must be an object or null.');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown reviewRouting setting "${key}".`);
  }
  const routing = { ...defaults, ...value };
  for (const [key, minimum] of Object.entries({ maxFiles: 0, maxChangedLines: 0, lowReviewers: 1, highReviewers: 2 })) {
    if (!Number.isSafeInteger(routing[key]) || routing[key] < minimum) {
      throw new Error(`reviewRouting.${key} must be an integer of at least ${minimum}.`);
    }
  }
  if (routing.highReviewers <= routing.lowReviewers) {
    throw new Error('reviewRouting.highReviewers must exceed lowReviewers.');
  }
  if (
    !Array.isArray(routing.sensitivePaths) ||
    routing.sensitivePaths.some((glob) => typeof glob !== 'string' || !glob.trim())
  ) {
    throw new Error('reviewRouting.sensitivePaths must be an array of non-empty glob strings.');
  }
  if (routing.aggregation !== 'unanimous') {
    throw new Error('reviewRouting.aggregation must be "unanimous".');
  }
  return routing;
}

// Double-star as a path segment matches zero or more directories.
function pathPattern(glob) {
  const parts = glob.split('/').map((segment, index, segments) => {
    if (segment === '**') return index === segments.length - 1 ? '[\\s\\S]*' : '(?:[^/]+/)*';
    const pattern = segment.replace(/[|\\{}()[\]^$+?.*]/g, (char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return `\\${char}`;
    });
    return index === segments.length - 1 ? pattern : `${pattern}/`;
  });
  return new RegExp(`^${parts.join('')}(?![\\s\\S])`, 'u');
}

/** @param {ReviewRouting} routing */
export function assessReviewRisk(numstat, routing) {
  const patterns = routing.sensitivePaths.map(pathPattern);
  let files = 0;
  let changedLines = 0;
  let binaryFiles = 0;
  const sensitivePaths = [];
  for (const record of numstat.split('\0')) {
    if (!record) continue;
    const [, added, deleted, path] = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record) ?? [];
    if (path === undefined) throw new Error('Unable to parse Git diff statistics for review routing.');
    files += 1;
    if (added === '-' || deleted === '-') binaryFiles += 1;
    else changedLines += Number(added) + Number(deleted);
    if (patterns.some((pattern) => pattern.test(path))) sensitivePaths.push(path);
  }
  const tier =
    files > routing.maxFiles || changedLines > routing.maxChangedLines || binaryFiles || sensitivePaths.length
      ? 'high'
      : 'low';
  return { tier, files, changedLines, binaryFiles, sensitivePaths };
}

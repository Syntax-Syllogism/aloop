import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Whether the module identified by `moduleUrl` is the script Node was asked to
 * run.
 *
 * `process.argv[1]` is the path as typed, which for a globally installed
 * package is npm's bin symlink (`.../bin/aloop`), while `import.meta.url`
 * is always the fully resolved module path. Comparing the two without resolving
 * symlinks makes every global install a silent no-op, so resolve both sides.
 */
export function isMainEntrypoint(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(resolve(entry))).href === moduleUrl;
  } catch {
    return false;
  }
}

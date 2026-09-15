import { createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST_VERSION = 1;

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function' || value === undefined || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value.map(canonicalize).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
        .filter(([, item]) => item !== undefined),
    );
  }
  return String(value);
}

export function canonicalizeConfig(config) {
  return canonicalize(config);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashText(text) {
  return sha256(String(text));
}

export function hashConfig(config) {
  return sha256(JSON.stringify(canonicalize(config)));
}

export class Manifest {
  constructor(entries = []) {
    this.entries = [...entries];
  }

  append(entry) {
    const now = new Date().toISOString();
    const recorded = {
      ...entry,
      startedAt: entry.startedAt ?? now,
      completedAt: entry.completedAt ?? now,
    };
    this.entries.push(recorded);
    return recorded;
  }

  async save(dir) {
    const path = join(dir, 'manifest.json');
    await writeFile(
      `${path}.tmp`,
      `${JSON.stringify({ manifestVersion: MANIFEST_VERSION, phases: this.entries }, null, 2)}\n`,
      'utf8',
    );
    await rename(`${path}.tmp`, path);
  }
}

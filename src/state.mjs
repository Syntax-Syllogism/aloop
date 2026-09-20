/** @typedef {import('./types.js').RunData} RunData */
/** @typedef {import('./types.js').ManifestEntry} ManifestEntry */

import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_VERSION, Manifest } from './manifest.mjs';

export const STATE_SCHEMA_VERSION = 1;

function newRunId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isProcessGroupAlive(groupId) {
  if (process.platform === 'win32' || !Number.isInteger(groupId) || groupId <= 0 || groupId === process.pid) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isActiveProcessAlive(activeProcess) {
  return isProcessGroupAlive(activeProcess?.processGroupId) || isProcessAlive(activeProcess?.pid);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readActiveProcess(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'active-command.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function lockOwnerName(lockToken) {
  return `owner-${lockToken.pid}-${lockToken.token}`;
}

function lockOwnerPath(lockPath, lockToken) {
  return join(lockPath, lockOwnerName(lockToken));
}

function parseLockOwner(name) {
  const match = /^owner-(\d+)-([0-9a-f-]+)$/.exec(name);
  if (!match) return null;
  return { pid: Number(match[1]), token: match[2] };
}

function unreadableLockError(path) {
  return new Error(`Run already active; lock directory "${path}" is unreadable or stale.`);
}

async function readLockOwner(lockPath) {
  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw unreadableLockError(lockPath);
  }

  const owners = entries.filter((entry) => parseLockOwner(entry));
  const temporaryEntries = entries.filter((entry) => entry.endsWith('.tmp'));
  if (entries.length === 0) return null;
  if (owners.length !== 1 || owners.length + temporaryEntries.length !== entries.length) {
    throw unreadableLockError(lockPath);
  }

  const owner = parseLockOwner(owners[0]);
  try {
    JSON.parse(await readFile(join(lockPath, owners[0]), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw unreadableLockError(lockPath);
  }
  return { ...owner, path: join(lockPath, owners[0]) };
}

function validateSchema(data, source) {
  const version = Object.hasOwn(data, 'schemaVersion') ? data.schemaVersion : 0;
  if (!Number.isInteger(version)) {
    throw new Error(
      `Unsupported ${source} schemaVersion ${version}; expected an integer version.`,
    );
  }
  if (version > STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${source} schemaVersion ${version}; this aloop version supports ${STATE_SCHEMA_VERSION}.`,
    );
  }
  if (version < STATE_SCHEMA_VERSION && version !== 0) {
    throw new Error(
      `Unsupported ${source} schemaVersion ${version}; no migration is available to ${STATE_SCHEMA_VERSION}.`,
    );
  }
  return version === 0 ? { ...data, schemaVersion: STATE_SCHEMA_VERSION } : data;
}

async function atomicWrite(path, contents) {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, contents, 'utf8');
  await rename(tempPath, path);
}

async function publishLock(lockPath, lockToken, contents) {
  const temporaryPath = `${lockPath}.tmp-${lockToken.token}`;
  try {
    await mkdir(temporaryPath);
    await writeFile(lockOwnerPath(temporaryPath, lockToken), contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, lockPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Run state, persisted after every phase.
 *
 * The point is resumability: a run that dies in the docs phase should restart
 * at the docs phase, not re-implement the work item. State lives next to the
 * run's logs rather than in a session, so `--resume` works even if the run is
 * resumed with a different engine than started it.
 */
export function slugFor(input) {
  if (!input) return '';
  return input
    .split('/')
    .at(-1)
    .replace(/\.(md|txt|markdown)$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export class RunState {
  /** @param {string} dir @param {RunData} data @param {boolean} [readOnly] */
  constructor(dir, data, readOnly = false, manifest = new Manifest(), lockToken = null, manifestMetadata = {}) {
    this.dir = dir;
    this.data = data;
    this.readOnly = readOnly;
    this.manifest = manifest;
    this.manifestMetadata = manifestMetadata;
    this.lockToken = lockToken;
    this.exitHandler = null;
  }

  static async open(
    runsDir,
    slug,
    seed,
    { readOnly = false, create = !readOnly, resume = false, lock = !readOnly } = {},
  ) {
    const dir = join(runsDir, slug);
    const freshData = {
      runId: seed.runId ?? newRunId(),
      startedAt: new Date().toISOString(),
      completed: [],
      rounds: {},
      reviewedShas: {},
      ...seed,
      schemaVersion: STATE_SCHEMA_VERSION,
    };
    let lockToken = null;
    try {
      if (create) await mkdir(dir, { recursive: true });
      if (lock && create) lockToken = await RunState.acquireLock(dir, freshData.runId);

      let data = freshData;
      if (create) {
        const path = join(dir, 'state.json');
        let hasExistingRun = false;
        try {
          const persisted = validateSchema(JSON.parse(await readFile(path, 'utf8')), 'state');
          data = {
            ...persisted,
            runId: persisted.runId ?? freshData.runId,
            schemaVersion: STATE_SCHEMA_VERSION,
          };
          hasExistingRun = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }

        const manifestPath = join(dir, 'manifest.json');
        try {
          validateSchema(JSON.parse(await readFile(manifestPath, 'utf8')), 'manifest');
          hasExistingRun = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (hasExistingRun && !resume) {
          throw new Error(
            `Run directory "${dir}" already contains a run; use --resume to continue it or choose a new --name.`,
          );
        }
      }
      let manifest = new Manifest();
      let manifestMetadata = {};
      if (create) {
        try {
          const saved = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
          manifest = new Manifest(/** @type {ManifestEntry[]} */ (saved.phases ?? []));
          manifestMetadata = saved;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const state = new RunState(dir, data, readOnly, manifest, lockToken, manifestMetadata);
      if (lockToken) state.installExitHandler();
      return state;
    } catch (error) {
      if (lockToken) await RunState.releaseLock(dir, lockToken);
      throw error;
    }
  }

  static async acquireLock(dir, runId) {
    const path = join(dir, 'lock');
    const lockToken = { pid: process.pid, startedAt: new Date().toISOString(), runId, token: randomUUID() };
    const contents = `${JSON.stringify(lockToken, null, 2)}\n`;
    while (true) {
      try {
        await publishLock(path, lockToken, contents);
        return lockToken;
      } catch (error) {
        // POSIX rejects a rename onto the existing (non-empty) lock directory
        // with EEXIST/ENOTEMPTY — the signal that the lock is already held.
        // Windows rejects the same rename with EPERM (sometimes EACCES)
        // instead, so without this a `--resume` that finds any prior lock dir
        // crashes with "EPERM: operation not permitted, rename". Treat those as
        // contention too, but only when the lock path is actually present, so a
        // genuine permission failure still surfaces instead of spinning here.
        const contended = ['EEXIST', 'ENOTEMPTY'].includes(error.code)
          || (['EPERM', 'EACCES'].includes(error.code) && await pathExists(path));
        if (!contended) throw error;
      }

      let existing;
      try {
        existing = await readLockOwner(path);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      if (!existing) {
        const abandonedPath = `${path}.abandoned-${lockToken.token}`;
        try {
          await rename(path, abandonedPath);
        } catch (renameError) {
          if (renameError.code === 'ENOENT') continue;
          throw renameError;
        }
        await rm(abandonedPath, { recursive: true, force: true });
        continue;
      }
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Run already active for "${dir}" (pid ${existing.pid}); wait for it to finish or remove a stale lock after confirming the process is gone.`,
        );
      }

      const activeProcess = await readActiveProcess(dir);
      if (isActiveProcessAlive(activeProcess)) {
        throw new Error(
          `Run still has an active command for "${dir}" (pid ${activeProcess.pid}); wait for it to finish before resuming.`,
        );
      }

      try {
        await rename(existing.path, lockOwnerPath(path, lockToken));
      } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      try {
        await atomicWrite(lockOwnerPath(path, lockToken), contents);
        return lockToken;
      } catch (writeError) {
        await RunState.releaseLock(dir, lockToken);
        throw writeError;
      }
    }
  }

  static async releaseLock(dir, lockToken) {
    const path = join(dir, 'lock');
    const ownerPath = lockOwnerPath(path, lockToken);
    const releasedPath = `${path}.released-${lockToken.token}`;
    try {
      const current = await readLockOwner(path);
      if (!current || current.path !== ownerPath) return;
      await rename(path, releasedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    await rm(releasedPath, { recursive: true, force: true });
  }

  installExitHandler() {
    this.exitHandler = () => {
      try {
        if (!readdirSync(this.lockPath).includes(lockOwnerName(this.lockToken))) return;
        const releasedPath = `${this.lockPath}.released-${this.lockToken.token}`;
        renameSync(this.lockPath, releasedPath);
        rmSync(releasedPath, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // The process is exiting; there is no useful recovery path here.
        }
      }
    };
    process.once('exit', this.exitHandler);
  }

  get path() {
    return join(this.dir, 'state.json');
  }

  get lockPath() {
    return join(this.dir, 'lock');
  }

  get manifestPath() {
    return join(this.dir, 'manifest.json');
  }

  get snapshotPath() {
    return join(this.dir, 'snapshot.json');
  }

  async hasSnapshot() {
    try {
      await access(this.snapshotPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async saveSnapshot(snapshot) {
    if (this.readOnly || await this.hasSnapshot()) return;
    await atomicWrite(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  logPath(name) {
    return join(this.dir, `${name}.log`);
  }

  verdictPath(round) {
    return join(this.dir, `verdict-round-${round}.json`);
  }

  isComplete(name) {
    return this.data.completed.includes(name);
  }

  async markComplete(name, details = {}) {
    if (!this.data.completed.includes(name)) this.data.completed.push(name);
    this.data.phases = { ...this.data.phases, [name]: { finishedAt: new Date().toISOString(), ...details } };
    await this.save();
  }

  async record(patch) {
    Object.assign(this.data, patch);
    await this.save();
  }

  async saveManifest(manifest) {
    if (this.readOnly) return;
    this.manifestMetadata = { ...this.manifestMetadata, ...manifest };
    await this.persistManifest();
  }

  async persistManifest() {
    const data = {
      ...this.manifestMetadata,
      manifestVersion: MANIFEST_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      phases: this.manifest.entries,
    };
    await atomicWrite(this.manifestPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  /**
   * Persist, unless this is a dry run.
   *
   * A dry run that recorded phases as complete would poison the next
   * `--resume`, which would then skip work that never actually happened.
   */
  async save() {
    if (this.readOnly) return;
    this.data.schemaVersion = STATE_SCHEMA_VERSION;
    if (!this.data.runId) this.data.runId = newRunId();
    this.data.updatedAt = new Date().toISOString();
    await atomicWrite(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
    await this.persistManifest();
  }

  async release() {
    if (!this.lockToken) return;
    if (this.exitHandler) process.removeListener('exit', this.exitHandler);
    const lockToken = this.lockToken;
    this.lockToken = null;
    await RunState.releaseLock(this.dir, lockToken);
  }
}

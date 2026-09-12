import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  constructor(dir, data, readOnly = false) {
    this.dir = dir;
    this.data = data;
    this.readOnly = readOnly;
  }

  static async open(runsDir, slug, seed, { readOnly = false } = {}) {
    const dir = join(runsDir, slug);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'state.json');
    let data;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data = {
        startedAt: new Date().toISOString(),
        completed: [],
        rounds: {},
        reviewedShas: {},
        ...seed,
      };
    }
    return new RunState(dir, data, readOnly);
  }

  get path() {
    return join(this.dir, 'state.json');
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

  /**
   * Persist, unless this is a dry run.
   *
   * A dry run that recorded phases as complete would poison the next
   * `--resume`, which would then skip work that never actually happened.
   */
  async save() {
    if (this.readOnly) return;
    this.data.updatedAt = new Date().toISOString();
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

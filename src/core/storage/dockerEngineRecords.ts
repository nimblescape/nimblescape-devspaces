// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about each Docker engine, in `docker-engines.json` of the global storage folder: that the
// user answered the question about the Monitor of the engine (src/vscode/monitorQuestion.ts), and that the user removed
// Devspaces from the engine ("Remove Devspaces from This Docker Engine…"). Before that answer, the Monitor of the engine
// stops when no devspace runs (src/vscode/monitorSettings.ts). While the removal mark is set, this computer does no
// Docker work on the engine by itself (extension.ts); a Start, a Rebuild or "Update All Images Now" of the user there
// clears it. An engine is named by its Docker host (DockerTarget.host): empty for the local Docker, the SSH host
// otherwise. A file that is missing or not valid knows no engine. A file that cannot be read is an error, after the
// retries of a transient error of Windows (a virus scanner holds the file for a moment), so that a change never writes
// over the records of other engines that it could not read. Several windows change the file: every change runs under
// the lock folder next to it (`docker-engines.lock`, as registry.json does), so no change of another window is lost,
// such as the removal mark. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { silentLogger, type Logger } from '../ports';
import { writeJsonAtomic } from './atomicJson';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, withLockFolder, type LockTimings } from './lockFolder';
import { parseJson, readTextFile, retryTransient } from './paths';

export interface DockerEngineRecord {
  /** The Docker host of the engine: '' for the local Docker. */
  host: string;
  /** When the user answered the question about the Monitor of the engine (milliseconds since the epoch). */
  monitorAnsweredAt?: number;
  /** When the user removed Devspaces from the engine (milliseconds since the epoch); the removal mark. */
  removedAt?: number;
}

export interface DockerEnginesFile {
  engines?: DockerEngineRecord[];
}

export interface DockerEngineRecordsOptions {
  /** For the warning about a file that is not valid. Default: no log. */
  logger?: Logger;
  /** A lock folder older than this counts as stale (its holder crashed). Default: 10 seconds. */
  lockStaleMs?: number;
  /** Maximum wait for the lock. Default: 15 seconds. */
  lockTimeoutMs?: number;
}

export class DockerEngineRecords {
  /** The lock folder of the changes: `<name>.lock` next to the file (`docker-engines.lock`). */
  readonly lockDir: string;
  private readonly lockTimings: LockTimings;
  private readonly logger: Logger;

  constructor(readonly file: string, options: DockerEngineRecordsOptions = {}) {
    this.lockDir = path.join(path.dirname(file), `${path.basename(file, '.json')}.lock`);
    this.logger = options.logger ?? silentLogger;
    this.lockTimings = {
      staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    };
  }

  /**
   * The records of the file; an entry that is not valid, one that records nothing, and a second entry of a host are
   * left out. A missing file, and one that is not valid, know no engine. Throws when the file cannot be read; a
   * transient error of Windows (isTransientFsError) is tried again first.
   */
  async read(): Promise<DockerEngineRecord[]> {
    return (await this.readFile()).records;
  }

  /** True when the user answered the question about the Monitor of the engine `host`. */
  async monitorAnswered(host: string): Promise<boolean> {
    return (await this.read()).some((record) => record.host === host && record.monitorAnsweredAt !== undefined);
  }

  /** Records that the user answered the question about the Monitor of the engine `host` at `now`. */
  async recordMonitorAnswer(host: string, now: number): Promise<void> {
    await this.change(host, (record) => ({ ...record, monitorAnsweredAt: now }));
  }

  /** True while the engine `host` has the removal mark. */
  async removed(host: string): Promise<boolean> {
    return (await this.read()).some((record) => record.host === host && record.removedAt !== undefined);
  }

  /**
   * Sets the removal mark of the engine `host` (`removedAt`), or clears it (undefined). Setting it also forgets the
   * answer about the Monitor of the engine: the next user-started flow there asks again.
   */
  async setRemoved(host: string, removedAt: number | undefined): Promise<void> {
    await this.change(host, (record) => {
      if (removedAt !== undefined) return { host, removedAt };
      const rest = { ...record };
      delete rest.removedAt;
      return rest;
    });
  }

  /**
   * Writes the record of `host` that `update` makes of the current one (an empty record when there is none); a record
   * with nothing but its host is left out. The read and the write run under the lock folder `lockDir`, so a change of
   * another window between them is not lost. Throws, and writes nothing, when the lock is not free within the wait or
   * the file cannot be read (read). A file that is not valid knows no engine: a copy of it is kept first, as
   * registry.json does, so that a repair by hand can bring back what it held.
   */
  private async change(host: string, update: (record: DockerEngineRecord) => DockerEngineRecord): Promise<void> {
    await withLockFolder(
      this.lockDir,
      async () => {
        const { records, invalid } = await this.readFile();
        if (invalid) await this.keepCopy();
        const others = records.filter((record) => record.host !== host);
        const next = update(records.find((record) => record.host === host) ?? { host });
        const engines = Object.keys(next).length > 1 ? [...others, next] : others;
        await retryTransient(() => writeJsonAtomic(this.file, { engines } satisfies DockerEnginesFile));
      },
      this.lockTimings,
    );
  }

  /** The records of the file (see read), and whether a file is there that is not valid. */
  private async readFile(): Promise<{ records: DockerEngineRecord[]; invalid: boolean }> {
    const text = await readTextFile(this.file);
    if (text === undefined) return { records: [], invalid: false };
    const value = parseJson(text);
    return { records: normalize(value), invalid: !isEnginesFile(value) };
  }

  /** Keeps a copy of a file that is not valid before a change writes over it: `<file>.backup-<time>`. */
  private async keepCopy(): Promise<void> {
    const copy = `${this.file}.backup-${Date.now()}`;
    await retryTransient(() => fs.promises.copyFile(this.file, copy));
    this.logger.warn(`The records of the Docker engines were not valid, so they count as none. A copy was saved as ${copy}.`);
  }
}

/** True for the content of a valid file: an object with the list `engines`. */
function isEnginesFile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Array.isArray((value as DockerEnginesFile).engines);
}

/** A time of the file: a whole number of milliseconds, not negative. */
function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalize(value: unknown): DockerEngineRecord[] {
  if (!isEnginesFile(value)) return [];
  const records: DockerEngineRecord[] = [];
  for (const entry of (value as DockerEnginesFile).engines as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { host, monitorAnsweredAt, removedAt } = entry as Record<string, unknown>;
    if (typeof host !== 'string' || records.some((record) => record.host === host)) continue;
    const answeredAt = timeOf(monitorAnsweredAt);
    const removed = timeOf(removedAt);
    if (answeredAt === undefined && removed === undefined) continue;
    records.push({ host, ...(answeredAt !== undefined ? { monitorAnsweredAt: answeredAt } : {}), ...(removed !== undefined ? { removedAt: removed } : {}) });
  }
  return records;
}

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about each Docker engine, in `docker-engines.json` of the global storage folder: that the
// user answered the question about the Monitor of the engine (src/vscode/monitorQuestion.ts), and that the user removed
// Devspaces from the engine ("Remove Devspaces from This Docker Engine…"). Before that answer, the Monitor of the engine
// stops when no devspace runs (src/vscode/monitorSettings.ts). While the removal mark is set, this computer does no
// Docker work on the engine by itself (extension.ts); a Start, a Rebuild or "Update All Images Now" of the user there
// clears it. An engine is named by its Docker host (DockerTarget.host): empty for the local Docker, the SSH host
// otherwise. A file that is missing, cannot be read, or is not valid knows no engine. Several windows change the file:
// every change runs under the lock folder next to it (`docker-engines.lock`, as registry.json does), so no change of
// another window is lost, such as the removal mark. No `vscode`.
import * as path from 'path';
import { readJson, writeJsonAtomic } from './atomicJson';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, withLockFolder, type LockTimings } from './lockFolder';

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
  /** A lock folder older than this counts as stale (its holder crashed). Default: 10 seconds. */
  lockStaleMs?: number;
  /** Maximum wait for the lock. Default: 15 seconds. */
  lockTimeoutMs?: number;
}

export class DockerEngineRecords {
  /** The lock folder of the changes: `<name>.lock` next to the file (`docker-engines.lock`). */
  readonly lockDir: string;
  private readonly lockTimings: LockTimings;

  constructor(readonly file: string, options: DockerEngineRecordsOptions = {}) {
    this.lockDir = path.join(path.dirname(file), `${path.basename(file, '.json')}.lock`);
    this.lockTimings = {
      staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    };
  }

  /**
   * The records of the file; an entry that is not valid, one that records nothing, and a second entry of a host are
   * left out.
   */
  async read(): Promise<DockerEngineRecord[]> {
    return normalize(await readJson<unknown>(this.file));
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
   * another window between them is not lost. Throws when the lock is not free within the wait.
   */
  private async change(host: string, update: (record: DockerEngineRecord) => DockerEngineRecord): Promise<void> {
    await withLockFolder(
      this.lockDir,
      async () => {
        const records = await this.read();
        const others = records.filter((record) => record.host !== host);
        const next = update(records.find((record) => record.host === host) ?? { host });
        const engines = Object.keys(next).length > 1 ? [...others, next] : others;
        await writeJsonAtomic(this.file, { engines } satisfies DockerEnginesFile);
      },
      this.lockTimings,
    );
  }
}

/** A time of the file: a whole number of milliseconds, not negative. */
function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalize(value: unknown): DockerEngineRecord[] {
  if (typeof value !== 'object' || value === null) return [];
  const engines = (value as DockerEnginesFile).engines;
  if (!Array.isArray(engines)) return [];
  const records: DockerEngineRecord[] = [];
  for (const entry of engines as unknown[]) {
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

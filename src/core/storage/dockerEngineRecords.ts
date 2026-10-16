// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Devspaces remembers about each Docker engine, in `docker-engines.json` of the global storage folder: that the
// user answered the question about the Monitor of the engine (src/vscode/monitorQuestion.ts), and that the user removed
// Devspaces from the engine ("Remove Devspaces from This Docker Engine…"). Before that answer, the Monitor of the engine
// stops when no devspace runs (src/vscode/monitorSettings.ts). While the removal mark is set, this computer does no
// Docker work on the engine by itself (extension.ts); a Start, a Rebuild or "Update All Images Now" of the user there
// clears it. An engine is named by its Docker host (DockerTarget.host): empty for the local Docker, the SSH host
// otherwise. A file that is missing, cannot be read, or is not valid knows no engine. No `vscode`.
import { readJson, writeJsonAtomic } from './atomicJson';

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

export class DockerEngineRecords {
  constructor(readonly file: string) {}

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
   * with nothing but its host is left out.
   */
  private async change(host: string, update: (record: DockerEngineRecord) => DockerEngineRecord): Promise<void> {
    const records = await this.read();
    const others = records.filter((record) => record.host !== host);
    const next = update(records.find((record) => record.host === host) ?? { host });
    const engines = Object.keys(next).length > 1 ? [...others, next] : others;
    await writeJsonAtomic(this.file, { engines } satisfies DockerEnginesFile);
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

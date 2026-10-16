// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngineRecords } from './dockerEngineRecords';

const NOW = Date.parse('2026-10-16T08:00:00.000Z');

let dir: string;
let records: DockerEngineRecords;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-engines-'));
  records = new DockerEngineRecords(path.join(dir, 'docker-engines.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DockerEngineRecords: the answer to the question about the Monitor', () => {
  it('knows no answer without a file, and records one per engine (the local Docker is the host "")', async () => {
    expect(await records.monitorAnswered('')).toBe(false);
    await records.recordMonitorAnswer('', NOW);
    expect(await records.monitorAnswered('')).toBe(true);
    expect(await records.monitorAnswered('build-box')).toBe(false);
    await records.recordMonitorAnswer('build-box', NOW + 1);
    // A second answer keeps one entry per host.
    await records.recordMonitorAnswer('', NOW + 2);
    expect(await records.read()).toEqual([
      { host: 'build-box', monitorAnsweredAt: NOW + 1 },
      { host: '', monitorAnsweredAt: NOW + 2 },
    ]);
    expect(JSON.parse(fs.readFileSync(records.file, 'utf8'))).toEqual({ engines: await records.read() });
  });

  it('a file that is not valid, or entries that are not, count as no answer', async () => {
    fs.writeFileSync(records.file, '{ not json');
    expect(await records.monitorAnswered('')).toBe(false);
    fs.writeFileSync(
      records.file,
      JSON.stringify({
        engines: [
          { host: 'a', monitorAnsweredAt: -1 },
          { host: 'b', monitorAnsweredAt: '2026' },
          { host: 3, monitorAnsweredAt: NOW },
          { host: 'c' },
          'd',
          { host: 'e', monitorAnsweredAt: NOW },
          { host: 'e', monitorAnsweredAt: NOW + 5 },
        ],
      }),
    );
    expect(await records.read()).toEqual([{ host: 'e', monitorAnsweredAt: NOW }]);
    for (const host of ['a', 'b', 'c', 'd', '3']) expect(await records.monitorAnswered(host), host).toBe(false);
    // A write keeps the valid entries only.
    await records.recordMonitorAnswer('a', NOW);
    expect(await records.read()).toEqual([
      { host: 'e', monitorAnsweredAt: NOW },
      { host: 'a', monitorAnsweredAt: NOW },
    ]);
  });

  it('a folder in place of the file counts as no answer, and a write there fails', async () => {
    fs.mkdirSync(records.file);
    expect(await records.monitorAnswered('')).toBe(false);
    await expect(records.recordMonitorAnswer('', NOW)).rejects.toThrow();
  });
});

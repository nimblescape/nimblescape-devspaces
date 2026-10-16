// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The first use of Devspaces: registry.json or the marker `used` in the global storage folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { devspacesUsed } from './firstUse';
import { StoragePaths } from './paths';

let root: string;
let paths: StoragePaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-first-use-'));
  paths = new StoragePaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function recording(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { ...silentLogger, warn: (text: string) => void warnings.push(text) }, warnings };
}

describe('the first use of Devspaces', () => {
  it('has its marker next to registry.json in the global storage folder', () => {
    expect(paths.usedMarker).toBe(path.join(root, 'used'));
    expect(path.dirname(paths.usedMarker)).toBe(path.dirname(paths.registry));
  });

  it('a fresh storage folder: not used, and nothing is written', async () => {
    const { logger, warnings } = recording();
    expect(await devspacesUsed(paths, logger)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('registry.json exists, also without a devspace or with content that is not valid: used, and the marker is written', async () => {
    for (const content of ['{"version":1,"devspaces":[]}', 'not JSON', '']) {
      fs.rmSync(paths.usedMarker, { force: true });
      fs.writeFileSync(paths.registry, content);
      expect(await devspacesUsed(paths), JSON.stringify(content)).toBe(true);
      expect(fs.readFileSync(paths.usedMarker, 'utf8')).toBe('');
      // registry.json itself is not changed.
      expect(fs.readFileSync(paths.registry, 'utf8')).toBe(content);
    }
  });

  it('the marker alone counts as used, so a lost registry.json is still restored', async () => {
    fs.writeFileSync(paths.registry, '{"version":1,"devspaces":[]}');
    expect(await devspacesUsed(paths)).toBe(true);
    fs.rmSync(paths.registry);
    expect(await devspacesUsed(paths)).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['used']);
  });

  it('keeps a marker that exists, also when windows start together', async () => {
    fs.writeFileSync(paths.registry, '{"version":1,"devspaces":[]}');
    const { logger, warnings } = recording();
    expect(await Promise.all([devspacesUsed(paths, logger), devspacesUsed(paths, logger), devspacesUsed(paths, logger)])).toEqual([true, true, true]);
    expect(await devspacesUsed(paths, logger)).toBe(true);
    expect(fs.readFileSync(paths.usedMarker, 'utf8')).toBe('');
    expect(warnings).toEqual([]);
  });

  it('a file that cannot be checked counts as used (logged), and no marker is written for it', async () => {
    // A file where the storage folder should be: every check fails with ENOTDIR, not with ENOENT.
    const file = path.join(root, 'not-a-folder');
    fs.writeFileSync(file, '');
    const { logger, warnings } = recording();
    expect(await devspacesUsed(new StoragePaths(file), logger)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Whether Devspaces was used before could not be read (${path.join(file, 'registry.json')}): `);
    expect(warnings[0]).toContain('ENOTDIR');
    // registry.json is missing, but the marker cannot be checked.
    const marker = recording();
    expect(await devspacesUsed({ registry: paths.registry, usedMarker: path.join(file, 'used') }, marker.logger)).toBe(true);
    expect(marker.warnings).toHaveLength(1);
    expect(fs.readdirSync(root)).toEqual(['not-a-folder']);
  });

  it('a marker that cannot be written is logged, and the use counts all the same', async () => {
    fs.writeFileSync(paths.registry, '{"version":1,"devspaces":[]}');
    const { logger, warnings } = recording();
    const missingFolder = path.join(root, 'missing', 'used');
    expect(await devspacesUsed({ registry: paths.registry, usedMarker: missingFolder }, logger)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`The marker of the first use of Devspaces could not be written (${missingFolder}): `);
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// extension.ts gives the Monitor of an engine the schedule of its background run (cacheUpdateSchedule), its mode
// (permanent on every engine, local or remote, unless stopMonitorWhenIdle is on) and the ID of this computer. The settings come from monitorSettings.ts and are tested by their
// result; only that extension.ts calls them with the Docker host of the open and the target of the repair is read from
// its source (extension.ts cannot be loaded without VS Code).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { monitorSettingsOf, type MonitorSettingsDeps } from './monitorSettings';

const COMPUTER = 'c'.repeat(32);

const deps = (settings: ReturnType<MonitorSettingsDeps['settings']>): MonitorSettingsDeps => ({
  settings: () => settings,
  timeZone: () => 'Europe/Vienna',
  computerId: () => COMPUTER,
});

describe('the monitor settings of extension.ts', () => {
  // The default is daily at 06:07; the settings carry no prefixes.
  it('the schedule of cacheUpdateSchedule (default daily at 06:07) and the time zone', () => {
    const settings = monitorSettingsOf(deps({ cacheUpdateSchedule: '60' }));
    expect(settings.forOpen('')).toEqual({ schedule: '60', timeZone: 'Europe/Vienna', permanent: true, computer: COMPUTER });
    expect(monitorSettingsOf(deps({})).forOpen('').schedule).toBe('7 6 * * *');
  });

  it('the mode: the same on every engine, permanent unless stopMonitorWhenIdle is on, always with this computer', () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopMonitorWhenIdle: stop }));
      // A target of an unsupported kind too.
      for (const each of [settings.forOpen('user@host'), settings.forTarget({ kind: 'remote' }), settings.forOpen(''), settings.forTarget({ kind: 'local' }), settings.forTarget({ kind: 'unsupported' })]) {
        expect(each, String(stop)).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: stop !== true, computer: COMPUTER });
      }
    }
  });

  it('extension.ts gives an open the settings of its Docker host and a repair those of its target', () => {
    const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
    // No image list of imageLists.
    expect(source).toContain('openMonitor: (dockerHost) => ({ images: monitorSettings.forOpen(dockerHost) }),');
    expect(source).not.toContain('imageLists');
    expect(source).not.toContain('read:packages');
    expect(source).toContain('monitorCalls.monitorEnsure(target, monitorSettings.forTarget(target), signal)');
    expect(source).not.toContain('imageUpdateSchedule ??');
  });
});

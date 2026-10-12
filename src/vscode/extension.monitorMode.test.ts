// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// extension.ts gives the Session Monitor of an engine the schedule of its background run (cacheUpdateSchedule) and its
// mode: permanent on a remote engine (an open whose Docker host is not the local one, a repair of a remote target), on
// a local one only with stopLocalMonitorWhenIdle off. The settings come from monitorSettings.ts and are tested by their
// result; only that extension.ts calls them with the Docker host of the open and the target of the repair is read from
// its source (extension.ts cannot be loaded without VS Code).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { monitorSettingsOf, type MonitorSettingsDeps } from './monitorSettings';

const deps = (settings: ReturnType<MonitorSettingsDeps['settings']>): MonitorSettingsDeps => ({
  settings: () => settings,
  timeZone: () => 'Europe/Vienna',
});

describe('the monitor settings of extension.ts', () => {
  // The default is daily at 06:07; the settings carry no prefixes.
  it('the schedule of cacheUpdateSchedule (default daily at 06:07) and the time zone', () => {
    const settings = monitorSettingsOf(deps({ cacheUpdateSchedule: '60' }));
    expect(settings.forOpen('')).toEqual({ schedule: '60', timeZone: 'Europe/Vienna', permanent: false });
    expect(monitorSettingsOf(deps({})).forOpen('').schedule).toBe('7 6 * * *');
  });

  it('the mode: a remote engine always permanent (`remote`), a local one only with stopLocalMonitorWhenIdle off', () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopLocalMonitorWhenIdle: stop }));
      for (const remote of [settings.forOpen('user@host'), settings.forTarget({ kind: 'remote' })]) {
        expect(remote, String(stop)).toMatchObject({ permanent: true, remote: true });
      }
      // A target of an unsupported kind is no remote engine.
      for (const local of [settings.forOpen(''), settings.forTarget({ kind: 'local' }), settings.forTarget({ kind: 'unsupported' })]) {
        expect(local.permanent, String(stop)).toBe(stop === false);
        expect(local, String(stop)).not.toHaveProperty('remote');
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

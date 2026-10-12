// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The settings of the Session Monitor that an open and `monitorEnsure` carry (MonitorSettings: the image settings with
// the schedule of the whole background run, a cron schedule or an interval in minutes, and whether the monitor runs
// permanently), checked strictly on both sides; `settings -` gets them without the mode. They carry no prefixes.
import { describe, expect, it } from 'vitest';
import { imageSettingsOf, parseImageSettingsInput, parseMonitorSettings } from '../remoteMonitor/protocol';
import { parseMonitorEnsureParams, parseOpenParams } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { schedule: '17', timeZone: 'Europe/Vienna' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'on', stopOnClose: true, respectShutdownActionNone: false };
const EXISTING = { dockerHost: '', owner: { windowId: 'window-1', pid: 7 }, monitorSource: SOURCE, settings: SETTINGS, images: IMAGES, repository: 'acme/app', devspaceId: ID };

describe('the monitor settings of an open and of monitorEnsure', () => {
  it('takes the schedule as whole minutes from 5 on, or five cron fields', () => {
    expect(parseImageSettingsInput(JSON.stringify(IMAGES))).toEqual(IMAGES);
    expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, schedule: '7 6 * * *' }))).toEqual({ ...IMAGES, schedule: '7 6 * * *' });
    for (const schedule of ['4', '5.5', '17 minutes', '7 6 * *']) {
      expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, schedule })), schedule).toBeUndefined();
    }
  });

  it('takes the mode as a boolean, or none; anything else is refused', () => {
    expect(parseMonitorSettings({ ...IMAGES, permanent: true })).toEqual({ ...IMAGES, permanent: true });
    expect(parseMonitorSettings({ ...IMAGES, permanent: false })).toEqual({ ...IMAGES, permanent: false });
    expect(parseMonitorSettings(IMAGES)).toEqual(IMAGES);
    expect(parseMonitorSettings(IMAGES)).not.toHaveProperty('permanent');
    for (const permanent of ['true', 1, null, {}]) expect(parseMonitorSettings({ ...IMAGES, permanent }), JSON.stringify(permanent)).toBeUndefined();
    expect(parseMonitorSettings({ ...IMAGES, permanent: true, extra: 1 })).toBeUndefined();
    expect(parseMonitorSettings({ ...IMAGES, schedule: '3', permanent: true })).toBeUndefined();
    expect(parseMonitorSettings('{}')).toBeUndefined();
  });

  // Why the monitor is permanent: `remote`, a boolean, only with `permanent: true`.
  it('takes `remote` as a boolean only for a permanent monitor', () => {
    expect(parseMonitorSettings({ ...IMAGES, permanent: true, remote: true })).toEqual({ ...IMAGES, permanent: true, remote: true });
    expect(parseMonitorSettings({ ...IMAGES, permanent: true, remote: false })).toEqual({ ...IMAGES, permanent: true, remote: false });
    expect(parseMonitorSettings({ ...IMAGES, remote: false })).toEqual({ ...IMAGES, remote: false });
    for (const images of [{ ...IMAGES, remote: true }, { ...IMAGES, permanent: false, remote: true }, { ...IMAGES, permanent: true, remote: 'yes' }, { ...IMAGES, permanent: true, remote: null }]) {
      expect(parseMonitorSettings(images), JSON.stringify(images)).toBeUndefined();
    }
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, permanent: true, remote: true } })).toEqual({ images: { ...IMAGES, permanent: true, remote: true } });
    expect(imageSettingsOf({ ...IMAGES, permanent: true, remote: true } as typeof IMAGES)).toEqual(IMAGES);
  });

  it('carries the mode in monitorEnsure and in the open', () => {
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, permanent: true } })).toEqual({ images: { ...IMAGES, permanent: true } });
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, permanent: 'yes' } })).toBeUndefined();
    const open = { ...EXISTING, images: { ...IMAGES, permanent: true } };
    expect(parseOpenParams(open)).toEqual(open);
    expect(parseOpenParams({ ...EXISTING, images: { ...IMAGES, permanent: 0 } })).toBeUndefined();
  });

  it('gives `settings -` the image settings without the mode', () => {
    expect(imageSettingsOf({ ...IMAGES, permanent: true } as typeof IMAGES)).toEqual(IMAGES);
    expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, permanent: true }))).toBeUndefined();
  });

  // `settings -` (and image-settings.json) take the prefixes that an older extension or monitor may still carry, and
  // ignore them; the open and monitorEnsure (one version on both sides) refuse them, as any other key.
  it('ignores the prefixes of an older extension or monitor in `settings -`; the open and monitorEnsure carry none', () => {
    expect(parseImageSettingsInput(JSON.stringify({ prefixes: ['ghcr.io/acme/base'], ...IMAGES }))).toEqual(IMAGES);
    expect(parseImageSettingsInput(JSON.stringify({ prefixes: [], ...IMAGES }))).toEqual(IMAGES);
    for (const prefixes of ['ghcr.io/acme/', null, {}]) expect(parseImageSettingsInput(JSON.stringify({ prefixes, ...IMAGES })), JSON.stringify(prefixes)).toBeUndefined();
    expect(parseImageSettingsInput(JSON.stringify({ prefixes: [] }))).toBeUndefined();
    expect(parseMonitorSettings({ prefixes: [], ...IMAGES })).toBeUndefined();
    expect(parseMonitorEnsureParams({ images: { prefixes: [], ...IMAGES } })).toBeUndefined();
    expect(parseOpenParams({ ...EXISTING, images: { prefixes: [], ...IMAGES } })).toBeUndefined();
    expect(parseOpenParams({ ...EXISTING, repositories: ['ghcr.io/acme/base'] })).toBeUndefined();
  });
});

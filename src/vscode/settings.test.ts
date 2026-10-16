// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ExtensionSettings } from '../core/types';
import { Actions, Messages } from '../core/messages';
import { parseCacheSchedule } from '../core/remoteMonitor/cacheSettings';
import {
  DEFAULT_SETTINGS,
  devContainersDefaultExtensionsValue,
  MAX_REFRESH_INTERVAL_MINUTES,
  normalizeSettings,
  readListOpenMode,
  normalizeDefaultImage,
  readSettings,
  SETTINGS_SECTION,
  settingTarget,
  showSettingWarning,
  warnInvalidDefaultImage,
  warnInvalidHostAccessChecksOff,
} from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('settings', () => {
  beforeEach(() => resetFakeVscode());

  it('has the defaults of the settings', () => {
    expect(normalizeSettings(() => undefined)).toEqual({
      reopenLastOnStartup: true,
      stopOnClose: true,
      updateImagesOnConnect: true,
      respectShutdownActionNone: false,
      owners: [],
      includeArchived: false,
      includeForks: true,
      // The view lists every repository.
      showOnlyDevspaces: false,
      refreshIntervalMinutes: 60,
      // No repository has its host access checks off by default.
      hostAccessChecksOff: [],
      repositoryGroups: [],
      // Start uses this window.
      openInNewWindow: false,
      // On every engine.
      stopAfterMinutes: 10,
      // The update of an existing container is announced (notify) by default.
      updateContainer: 'notify',
      // The schedule of the whole background run of the Monitor, a cron expression: daily at 06:07.
      cacheUpdateSchedule: '7 6 * * *',
      // True by default: the local monitor ends when idle.
      stopMonitorWhenIdle: false,
      // No default image: every start uses the configuration of the repository.
      defaultImage: '',
      startWithDefaultImage: true,
    });
  });

  it('reads defaultImage as a trimmed image reference, and ignores an invalid one', () => {
    const of = (value: unknown) => normalizeSettings((key) => (key === 'defaultImage' ? value : undefined)).defaultImage;
    expect(of(' ghcr.io/majikmate/devcontainer-base:latest ')).toBe('ghcr.io/majikmate/devcontainer-base:latest');
    expect(of('node:22')).toBe('node:22');
    expect(of(`ghcr.io/acme/base@sha256:${'a'.repeat(64)}`)).toBe(`ghcr.io/acme/base@sha256:${'a'.repeat(64)}`);
    for (const odd of ['', '   ', 'Not An Image', 'ghcr.io/acme/base:', '${localEnv:IMAGE}', 3, null, ['node:22']]) {
      expect(of(odd), JSON.stringify(odd)).toBe('');
    }
    expect(normalizeDefaultImage('node:22 ')).toBe('node:22');
    expect(normalizeDefaultImage('a b')).toBeUndefined();
  });

  it('reads startWithDefaultImage as a boolean, true by default', () => {
    const of = (value: unknown) => normalizeSettings((key) => (key === 'startWithDefaultImage' ? value : undefined)).startWithDefaultImage;
    expect(of(false)).toBe(false);
    expect(of(true)).toBe(true);
    expect(of('false')).toBe(true);
    expect(of(undefined)).toBe(true);
  });

  it('writes a setting of the view where its value applies: the workspace settings when they hold it, else the user settings', () => {
    const configuration = (workspaceValue: unknown) =>
      ({ inspect: () => ({ key: 'devspaces.owners', globalValue: ['acme'], workspaceValue }) }) as unknown as Parameters<typeof settingTarget>[0];
    expect(settingTarget(configuration(undefined), 'owners')).toBe(fakeVscode.ConfigurationTarget.Global);
    expect(settingTarget(configuration(['octo']), 'owners')).toBe(fakeVscode.ConfigurationTarget.Workspace);
    // Also an empty list or false: a value that VS Code uses.
    expect(settingTarget(configuration([]), 'owners')).toBe(fakeVscode.ConfigurationTarget.Workspace);
    expect(settingTarget(configuration(false), 'showOnlyDevspaces')).toBe(fakeVscode.ConfigurationTarget.Workspace);
    // A setting that VS Code does not know.
    expect(settingTarget({ inspect: () => undefined }, 'unknown')).toBe(fakeVscode.ConfigurationTarget.Global);
  });

  it('warns once per window session about each invalid defaultImage, with Open Settings', async () => {
    let value: unknown = ' not an image ';
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: string) => (key === 'defaultImage' ? value : undefined), inspect: () => undefined });
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.openSettings);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    const warned = new Set<string>();
    warnInvalidDefaultImage(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.defaultImageInvalid('not an image'), Actions.openSettings);
    expect(logger.warn).toHaveBeenCalledWith(Messages.defaultImageInvalid('not an image'));
    // The button opens the Settings editor at the setting.
    await vi.waitFor(() =>
      expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', '@id:devspaces.defaultImage'),
    );
    warnInvalidDefaultImage(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    // A valid value, and an empty one: nothing to warn about. The same invalid value again: no second warning.
    value = 'ghcr.io/acme/base:latest';
    warnInvalidDefaultImage(logger, warned);
    value = '';
    warnInvalidDefaultImage(logger, warned);
    value = 'not an image';
    warnInvalidDefaultImage(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    // Another invalid value is a new warning.
    value = 'Not An Image';
    warnInvalidDefaultImage(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  // There is no setting imageUpdates: a value that settings.json holds is not read (VS Code shows it as an unknown
  // setting).
  it('reads no imageUpdates, and cacheUpdateSchedule as a cron schedule or an interval', () => {
    const settings = normalizeSettings((key) => (String(key) === 'imageUpdates' ? ['ghcr.io/acme/base*'] : undefined));
    expect(settings).not.toHaveProperty('imageUpdates');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('imageUpdates');
    // A cron schedule; an invalid one (also a time HH:MM) gives the default. A whole number of at least 5 minutes is an
    // interval.
    const schedule = (value: unknown) => normalizeSettings((key) => (key === 'cacheUpdateSchedule' ? value : undefined)).cacheUpdateSchedule;
    expect(schedule('30 5 * * 1-5')).toBe('30 5 * * 1-5');
    expect(schedule('  30  5 * *   mon-fri ')).toBe('30 5 * * mon-fri');
    // The default is daily at 06:07.
    expect(schedule('05:30')).toBe('7 6 * * *');
    expect(schedule('61 5 * * *')).toBe('7 6 * * *');
    expect(schedule(530)).toBe('530');
  });

  // cacheUpdateSchedule is a cron schedule of five fields or an interval of whole minutes, at least 5; anything else is
  // the default (daily at 06:07).
  it('reads cacheUpdateSchedule: five cron fields or whole minutes from 5 on; junk, fewer minutes and fractions give the default', () => {
    const schedule = (value: unknown) => normalizeSettings((key) => (key === 'cacheUpdateSchedule' ? value : undefined)).cacheUpdateSchedule;
    expect(schedule(undefined)).toBe('7 6 * * *');
    expect(schedule('17')).toBe('17');
    expect(schedule(' 5 ')).toBe('5');
    expect(schedule(5)).toBe('5');
    expect(schedule('60')).toBe('60');
    expect(schedule('0060')).toBe('60');
    expect(schedule('7 6 * * *')).toBe('7 6 * * *');
    for (const junk of ['4', 4, '0', '-5', '5.5', 5.5, '1e3', '17 minutes', '', '   ', '7 6 * *', '7 6 * * * *', null, true, ['17'], { minutes: 17 }, '525601']) {
      expect(schedule(junk), JSON.stringify(junk)).toBe('7 6 * * *');
    }
  });

  // The manifest has the two settings with the defaults of the code (scope application, as the other settings of the
  // monitor), no imageUpdateSchedule, and the pattern of cacheUpdateSchedule takes whole minutes and five fields, and
  // refuses other text.
  it('declares cacheUpdateSchedule and stopMonitorWhenIdle in package.json with the defaults of the code', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; pattern?: string; scope?: string; type?: string }> } };
    };
    const properties = manifest.contributes.configuration.properties;
    expect(properties[`${SETTINGS_SECTION}.imageUpdateSchedule`]).toBeUndefined();
    // There is no setting imageUpdates, and the description of the schedule does not name it.
    expect(properties[`${SETTINGS_SECTION}.imageUpdates`]).toBeUndefined();
    expect(JSON.stringify(properties[`${SETTINGS_SECTION}.cacheUpdateSchedule`])).not.toContain('Image Updates');
    const schedule = properties[`${SETTINGS_SECTION}.cacheUpdateSchedule`];
    expect(schedule).toMatchObject({ type: 'string', default: DEFAULT_SETTINGS.cacheUpdateSchedule, scope: 'application' });
    expect(properties[`${SETTINGS_SECTION}.stopMonitorWhenIdle`]).toMatchObject({ type: 'boolean', default: DEFAULT_SETTINGS.stopMonitorWhenIdle, scope: 'application' });
    expect(DEFAULT_SETTINGS.stopMonitorWhenIdle).toBe(false);
    expect(properties).not.toHaveProperty(`${SETTINGS_SECTION}.stopLocalMonitorWhenIdle`);
    const pattern = new RegExp(schedule.pattern ?? '');
    for (const text of ['17', ' 60 ', '7 6 * * *', '7 */6 * * 1-5']) expect(pattern.test(text), text).toBe(true);
    for (const text of ['17 minutes', '7 6 * *', 'soon', '']) expect(pattern.test(text), text).toBe(false);
    // The pattern takes exactly the minutes that the parse takes (5 to 1440, leading zeros allowed), so the settings
    // editor shows its error for `4`, `0` or `1441` instead of a silent default.
    for (const text of ['4', '0', '1441', '525601', '12345678', '00004']) expect(pattern.test(text), text).toBe(false);
    for (let minutes = 0; minutes <= 2000; minutes++) {
      for (const text of [String(minutes), `00${minutes}`]) expect(pattern.test(text), text).toBe(parseCacheSchedule(text)?.kind === 'interval');
    }
  });

  // updateContainer, `ask` or else `notify`; one value per user and computer.
  it('reads updateContainer: `ask`, anything else is `notify`, and declares it in package.json', () => {
    const read = (value: unknown) => normalizeSettings((key) => (key === 'updateContainer' ? value : undefined)).updateContainer;
    expect(read('ask')).toBe('ask');
    for (const value of ['notify', undefined, 'Ask', true, 'never']) expect(read(value), String(value)).toBe('notify');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: unknown; scope?: string; type?: string }> } };
    };
    const properties = manifest.contributes.configuration.properties;
    expect(properties[`${SETTINGS_SECTION}.updateContainer`]).toMatchObject({ type: 'string', enum: ['notify', 'ask'], default: 'notify', scope: 'application' });
    expect(properties[`${SETTINGS_SECTION}.updateRunningContainer`]).toBeUndefined();
  });

  // The Settings editor shows each description in full: a short text, and for more a link to the section of the user
  // guide. Each value of an enum has its own description.
  it('keeps the descriptions of the settings short, with links to sections of the user guide that exist (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { markdownDescription?: string; description?: string; enum?: unknown[]; enumDescriptions?: string[] }> } };
    };
    const properties = manifest.contributes.configuration.properties;
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'guide.md'), 'utf8');
    // The anchors of the headings, as GitHub makes them.
    const anchors = guide
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => line.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));
    const GUIDE = 'https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md#';
    for (const [key, property] of Object.entries(properties)) {
      const text = property.markdownDescription ?? property.description ?? '';
      expect(text.length, key).toBeLessThan(450);
      for (const [, anchor] of text.matchAll(/\(https:\/\/github\.com\/nimblescape\/nimblescape-devspaces\/blob\/main\/docs\/guide\.md#([\w-]+)\)/g)) {
        expect(anchors, `${key}: #${anchor}`).toContain(anchor);
      }
      if (property.enum) expect(property.enumDescriptions, key).toHaveLength(property.enum.length);
    }
    // stopMonitorWhenIdle: the question about the Monitor of each engine is in the section of the background run.
    const sections = {
      defaultImage: 'default-image',
      cacheUpdateSchedule: 'the-background-run',
      stopMonitorWhenIdle: 'the-background-run',
      updateContainer: 'the-update-at-a-start',
      repositoryGroups: 'settings',
    };
    for (const [key, anchor] of Object.entries(sections)) {
      expect(properties[`${SETTINGS_SECTION}.${key}`].markdownDescription, key).toContain(`(${GUIDE}${anchor})`);
    }
    // The editor of the repository groups stays one click away.
    expect(properties[`${SETTINGS_SECTION}.repositoryGroups`].markdownDescription).toContain('(command:devspaces.editRepositoryGroups)');
  });

  // stopMonitorWhenIdle, a boolean, false by default.
  it('reads stopMonitorWhenIdle: a boolean; anything else is false', () => {
    const read = (value: unknown) => normalizeSettings((key) => (key === 'stopMonitorWhenIdle' ? value : undefined)).stopMonitorWhenIdle;
    expect(read(false)).toBe(false);
    expect(read(true)).toBe(true);
    expect(read(undefined)).toBe(false);
    expect(read('true')).toBe(false);
  });

  it('reads the section devspaces', () => {
    const values: Partial<Record<keyof ExtensionSettings, unknown>> = { stopOnClose: false, owners: ['acme'] };
    // `inspect`: devspaces.hostAccessChecksOff is read from the user settings only; it has no user value here.
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: keyof ExtensionSettings) => values[key], inspect: () => undefined });
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, stopOnClose: false, owners: ['acme'] });
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
    expect(SETTINGS_SECTION).toBe('devspaces');
  });

  it('reads the VS Code setting workbench.list.openMode (double-click on a row)', () => {
    let value: unknown = 'doubleClick';
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: string) => (key === 'openMode' ? value : undefined) });
    expect(readListOpenMode()).toBe('doubleClick');
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith('workbench.list');
    value = undefined;
    expect(readListOpenMode()).toBe('singleClick');
  });

  it('replaces values of a wrong type with the default, and cleans the owners', () => {
    const raw: Record<string, unknown> = {
      reopenLastOnStartup: 'no',
      refreshIntervalMinutes: Number.NaN,
      owners: [' acme ', '', 3, 'me'],
      includeForks: null,
    };
    const settings = normalizeSettings((key) => raw[key]);
    expect(settings.reopenLastOnStartup).toBe(true);
    expect(settings.refreshIntervalMinutes).toBe(60);
    expect(settings.owners).toEqual(['acme', 'me']);
    expect(settings.includeForks).toBe(true);
    expect(normalizeSettings((key) => (key === 'owners' ? 'acme' : undefined)).owners).toEqual([]);
  });

  it('reads the entries of repositoryGroups as they are, and replaces a value that is not a list with []', () => {
    const entries = ['^a', { name: 'B', pattern: '^b', flags: 'i' }, 3];
    expect(normalizeSettings((key) => (key === 'repositoryGroups' ? entries : undefined)).repositoryGroups).toEqual(entries);
    for (const value of ['^a', null, 3, { pattern: '^a' }]) {
      expect(normalizeSettings((key) => (key === 'repositoryGroups' ? value : undefined)).repositoryGroups).toEqual([]);
    }
  });

  it('declares repositoryGroups with the scope application, so a workspace cannot set regular expressions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown }> } };
    };
    const setting = manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.repositoryGroups`];
    expect(setting).toMatchObject({ scope: 'application', default: [] });
  });

  // Workspace Trust: in Restricted Mode, VS Code runs the extension and ignores the values of a workspace or folder for
  // the settings in restrictedConfigurations. A setting of the scope application or machine takes no such value
  // anyway; every other setting must be in the list (test/vscode/untrusted/untrusted.test.ts checks in VS Code that it
  // ignores the folder values of the listed settings).
  it('declares limited support of untrusted workspaces, with every setting that a folder can set as restricted', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      capabilities?: { untrustedWorkspaces?: { supported?: unknown; description?: unknown; restrictedConfigurations?: string[] } };
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const folderSettings = Object.entries(manifest.contributes.configuration.properties)
      .filter(([, { scope }]) => scope !== 'application' && scope !== 'machine')
      .map(([key]) => key)
      .sort();
    expect(folderSettings).toContain(`${SETTINGS_SECTION}.owners`);
    const untrustedWorkspaces = manifest.capabilities?.untrustedWorkspaces;
    expect(untrustedWorkspaces).toMatchObject({ supported: 'limited', description: expect.stringContaining('Restricted Mode') });
    expect([...(untrustedWorkspaces?.restrictedConfigurations ?? [])].sort()).toEqual(folderSettings);
  });

  it('reads dev.containers.defaultExtensions from the user settings only', () => {
    let user: unknown = ['acme.tool'];
    const inspect = vi.fn((key: string) =>
      key === 'defaultExtensions' ? { key, globalValue: user, workspaceValue: ['other.tool'], workspaceFolderValue: ['other.folder'] } : undefined,
    );
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: () => ['other.tool'], inspect });
    expect(devContainersDefaultExtensionsValue()).toEqual(['acme.tool']);
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith('dev.containers');
    user = undefined;
    expect(devContainersDefaultExtensionsValue()).toBeUndefined();
  });

  it('clamps the refresh interval', () => {
    const settings = (raw: Record<string, unknown>) => normalizeSettings((key) => raw[key]);
    expect(settings({ refreshIntervalMinutes: 0 }).refreshIntervalMinutes).toBe(1);
    expect(settings({ refreshIntervalMinutes: 15 }).refreshIntervalMinutes).toBe(15);
    // A timer with a longer delay would fire every millisecond.
    expect(settings({ refreshIntervalMinutes: 1_000_000 }).refreshIntervalMinutes).toBe(MAX_REFRESH_INTERVAL_MINUTES);
    expect(MAX_REFRESH_INTERVAL_MINUTES * 60_000).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  // The time limit of a container without contact, on every engine: five minutes to one day.
  it('clamps stopAfterMinutes to 5..1440 and gives 10 for a value that is no number', () => {
    const settings = (raw: Record<string, unknown>) => normalizeSettings((key) => raw[key]);
    expect(settings({ stopAfterMinutes: 0 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 1 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 4.9 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 5 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 30 }).stopAfterMinutes).toBe(30);
    expect(settings({ stopAfterMinutes: 100_000 }).stopAfterMinutes).toBe(1440);
    expect(settings({ stopAfterMinutes: '5' }).stopAfterMinutes).toBe(10);
    expect(settings({ stopAfterMinutes: Number.NaN }).stopAfterMinutes).toBe(10);
    // The same bounds in package.json.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { minimum?: number; maximum?: number; scope?: string }> } };
    };
    // One value per user and computer (scope application), so a workspace cannot give one window another limit; all
    // windows write the same monitor.json and heartbeats.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.stopAfterMinutes`]).toMatchObject({
      minimum: 5,
      maximum: 1440,
      scope: 'application',
    });
    // The other settings of the one monitor.json and of the heartbeats too, so that a repository's workspace settings
    // cannot keep every devspace of the computer running.
    for (const key of ['stopOnClose', 'respectShutdownActionNone']) {
      expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.${key}`], key).toMatchObject({ scope: 'application' });
    }
  });

  it('reads hostAccessChecksOff from the user settings only, trimmed, without invalid entries', () => {
    const get = vi.fn((key: string) => (key === 'hostAccessChecksOff' ? ['from/workspace'] : undefined));
    const inspect = vi.fn((): { globalValue?: string[]; workspaceValue: string[] } => ({
      globalValue: [' acme/api ', 'not a name', 'me/web'],
      workspaceValue: ['evil/repo'],
    }));
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get, inspect });
    expect(readSettings().hostAccessChecksOff).toEqual(['acme/api', 'me/web']);
    expect(inspect).toHaveBeenCalledWith('hostAccessChecksOff');
    expect(get).not.toHaveBeenCalledWith('hostAccessChecksOff');
    // Without a user value, every check is on.
    inspect.mockReturnValue({ globalValue: undefined, workspaceValue: ['evil/repo'] });
    expect(readSettings().hostAccessChecksOff).toEqual([]);
    expect(normalizeSettings((key) => (key === 'hostAccessChecksOff' ? 'acme/api' : undefined)).hostAccessChecksOff).toEqual([]);
  });

  it('logs a warning about a setting that could not be shown, and a setting that could not be opened', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    fakeVscode.window.showWarningMessage.mockRejectedValueOnce(new Error('no window'));
    showSettingWarning(logger, 'owners', 'A warning.');
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith('The warning about the setting owners could not be shown: no window'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.openSettings);
    fakeVscode.commands.executeCommand.mockRejectedValueOnce(new Error('no editor'));
    showSettingWarning(logger, 'owners', 'A warning.');
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith('The setting owners could not be opened: no editor'));
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', '@id:devspaces.owners');
  });

  it('warns once per window session about the invalid entries of hostAccessChecksOff, with Open Settings', async () => {
    const inspect = vi.fn((): { globalValue: unknown[] } => ({ globalValue: ['acme/api', 'acme', 3] }));
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: () => undefined, inspect });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    const warned = new Set<string>();
    warnInvalidHostAccessChecksOff(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.hostAccessChecksOffInvalid('acme, 3'), Actions.openSettings);
    expect(logger.warn).toHaveBeenCalledWith(Messages.hostAccessChecksOffInvalid('acme, 3'));
    warnInvalidHostAccessChecksOff(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    inspect.mockReturnValue({ globalValue: ['acme/api'] });
    warnInvalidHostAccessChecksOff(logger, warned);
    inspect.mockReturnValue({ globalValue: ['acme/api', 'acme', 3] });
    warnInvalidHostAccessChecksOff(logger, warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    // The warning was closed without its button: the Settings editor stays closed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { HAS_DEFAULT_IMAGE_CONTEXT_KEY, defaultImageOf, sourceDiffers, startSource, updateHasDefaultImageContextKey } from './defaultImage';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';

describe('the default image of the settings', () => {
  beforeEach(() => resetFakeVscode());

  it('is the setting defaultImage when it is set', () => {
    expect(defaultImageOf({ defaultImage: IMAGE })).toBe(IMAGE);
    expect(defaultImageOf({ defaultImage: '' })).toBeUndefined();
    expect(defaultImageOf({})).toBeUndefined();
  });

  it('Start uses the default image while startWithDefaultImage is on (the default), else the configuration', () => {
    expect(startSource({ defaultImage: IMAGE })).toEqual({ kind: 'defaultImage', image: IMAGE });
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: true })).toEqual({ kind: 'defaultImage', image: IMAGE });
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: false })).toEqual({ kind: 'configuration' });
    // Without a default image, the flag changes nothing.
    expect(startSource({ defaultImage: '', startWithDefaultImage: true })).toEqual({ kind: 'configuration' });
    expect(startSource({})).toEqual({ kind: 'configuration' });
  });

  it('tells a source that differs from the one of the last open of a devspace', () => {
    expect(sourceDiffers({}, { kind: 'configuration' })).toBe(false);
    expect(sourceDiffers({}, { kind: 'defaultImage', image: IMAGE })).toBe(true);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'configuration' })).toBe(true);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'defaultImage', image: IMAGE })).toBe(false);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'defaultImage', image: 'node:22' })).toBe(true);
  });

  it('sets the context key of the menus from the setting', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    updateHasDefaultImageContextKey({ defaultImage: IMAGE }, logger);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, true);
    updateHasDefaultImageContextKey({ defaultImage: '' }, logger);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';

import { defaultImageOf, hasConfiguration, sourceDiffers, startSource } from './defaultImage';

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';
const WITH_CONFIGURATION = { configPaths: ['.devcontainer/devcontainer.json'] };
const WITHOUT_CONFIGURATION = { configPaths: [] };

describe('the default image of the settings', () => {
  it('is the setting defaultImage when it is set', () => {
    expect(defaultImageOf({ defaultImage: IMAGE })).toBe(IMAGE);
    expect(defaultImageOf({ defaultImage: '' })).toBeUndefined();
    expect(defaultImageOf({})).toBeUndefined();
  });

  it('Start uses the default image while startWithDefaultImage is on (the default), else the configuration', () => {
    expect(startSource({ defaultImage: IMAGE })).toEqual({ kind: 'defaultImage', image: IMAGE });
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: true })).toEqual({ kind: 'defaultImage', image: IMAGE });
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: false })).toEqual({ kind: 'configuration' });
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: false }, WITH_CONFIGURATION)).toEqual({ kind: 'configuration' });
    // Without a default image, the flag changes nothing.
    expect(startSource({ defaultImage: '', startWithDefaultImage: true })).toEqual({ kind: 'configuration' });
    expect(startSource({})).toEqual({ kind: 'configuration' });
  });

  it('a repository without a configuration starts from the default image whatever the setting says', () => {
    expect(hasConfiguration(undefined)).toBe(true);
    expect(hasConfiguration(WITH_CONFIGURATION)).toBe(true);
    expect(hasConfiguration(WITHOUT_CONFIGURATION)).toBe(false);
    expect(startSource({ defaultImage: IMAGE, startWithDefaultImage: false }, WITHOUT_CONFIGURATION)).toEqual({ kind: 'defaultImage', image: IMAGE });
    // Without a default image it has no source; the open reports the missing configuration.
    expect(startSource({ defaultImage: '', startWithDefaultImage: false }, WITHOUT_CONFIGURATION)).toEqual({ kind: 'configuration' });
  });

  it('tells a source that differs from the one of the last open of a devspace', () => {
    expect(sourceDiffers({}, { kind: 'configuration' })).toBe(false);
    expect(sourceDiffers({}, { kind: 'defaultImage', image: IMAGE })).toBe(true);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'configuration' })).toBe(true);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'defaultImage', image: IMAGE })).toBe(false);
    expect(sourceDiffers({ defaultImage: IMAGE }, { kind: 'defaultImage', image: 'node:22' })).toBe(true);
  });
});

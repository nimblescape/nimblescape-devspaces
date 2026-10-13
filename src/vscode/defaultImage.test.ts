// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { HAS_DEFAULT_IMAGE_CONTEXT_KEY, updateHasDefaultImageContextKey } from './defaultImage';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';

describe('the context key of the default image', () => {
  beforeEach(() => resetFakeVscode());

  it('sets the context key of the menus from the setting', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    updateHasDefaultImageContextKey({ defaultImage: IMAGE }, logger);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, true);
    updateHasDefaultImageContextKey({ defaultImage: '' }, logger);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The context key of the menus that offer the other source of a devspace (src/core/defaultImage.ts has the rules of
// the default image of the settings).
import * as vscode from 'vscode';
import { defaultImageOf } from '../core/defaultImage';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import type { ExtensionSettings } from '../core/types';

/**
 * Context key of the menus (package.json): the setting `defaultImage` names a valid image. The entries "Start with
 * Default Image" and "Start with Configuration" show only with it; the setting `startWithDefaultImage` decides which.
 */
export const HAS_DEFAULT_IMAGE_CONTEXT_KEY = 'devspaces.hasDefaultImage';

/** Sets the context key of the menus from the settings. */
export function updateHasDefaultImageContextKey(settings: Pick<ExtensionSettings, 'defaultImage'>, logger: Logger): void {
  const on = defaultImageOf(settings) !== undefined;
  vscode.commands.executeCommand('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, on).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${HAS_DEFAULT_IMAGE_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}

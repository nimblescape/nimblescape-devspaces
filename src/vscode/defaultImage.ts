// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The default image of the settings (`defaultImage`, `startWithDefaultImage`): what Start opens a devspace from
// (DevspaceSource), and the context key of the menus that offer the other source. No pipeline logic here: the worker
// reads and builds the source that the open names (docs/architecture.md, "Open").
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import type { Devspace, DevspaceSource, ExtensionSettings } from '../core/types';

/**
 * Context key of the menus (package.json): the setting `defaultImage` names a valid image. The entries "Start with
 * Default Image" and "Start with Configuration" show only with it; the setting `startWithDefaultImage` decides which.
 */
export const HAS_DEFAULT_IMAGE_CONTEXT_KEY = 'devspaces.hasDefaultImage';

/** The default image of the settings, or `undefined` without one (readSettings drops an invalid reference). */
export function defaultImageOf(settings: Pick<ExtensionSettings, 'defaultImage'>): string | undefined {
  return settings.defaultImage !== undefined && settings.defaultImage !== '' ? settings.defaultImage : undefined;
}

/**
 * What Start (and every other open that the user asks for: the row, the switcher, Search, a double-click) opens a
 * devspace from: the default image while the setting `startWithDefaultImage` is on and a default image is set, else
 * the configuration of the repository. The context menu offers the other one (startWithSource of the controller).
 */
export function startSource(settings: Pick<ExtensionSettings, 'defaultImage' | 'startWithDefaultImage'>): DevspaceSource {
  const image = defaultImageOf(settings);
  return image !== undefined && settings.startWithDefaultImage !== false ? { kind: 'defaultImage', image } : { kind: 'configuration' };
}

/**
 * Whether `source` is another source than the one of the last open of `devspace` (Devspace.defaultImage): the other
 * kind, or another default image. Start with Default Image and Start with Configuration rebuild a connected devspace
 * only then.
 */
export function sourceDiffers(devspace: Pick<Devspace, 'defaultImage'>, source: DevspaceSource): boolean {
  return source.kind === 'defaultImage' ? devspace.defaultImage !== source.image : devspace.defaultImage !== undefined;
}

/** Sets the context key of the menus from the settings. */
export function updateHasDefaultImageContextKey(settings: Pick<ExtensionSettings, 'defaultImage'>, logger: Logger): void {
  const on = defaultImageOf(settings) !== undefined;
  vscode.commands.executeCommand('setContext', HAS_DEFAULT_IMAGE_CONTEXT_KEY, on).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${HAS_DEFAULT_IMAGE_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}

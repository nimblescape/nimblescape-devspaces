// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The default image of the settings (`defaultImage`, `startWithDefaultImage`): what Start opens a devspace from
// (DevspaceSource). No pipeline logic here: the worker reads and builds the source that the open names
// (docs/architecture.md, "Open").
import type { Devspace, DevspaceSource, ExtensionSettings, RepositoryInfo } from './types';

/** The default image of the settings, or `undefined` without one (readSettings drops an invalid reference). */
export function defaultImageOf(settings: Pick<ExtensionSettings, 'defaultImage'>): string | undefined {
  return settings.defaultImage !== undefined && settings.defaultImage !== '' ? settings.defaultImage : undefined;
}

/**
 * Whether the repository has a Dev Container configuration on its default branch, as far as the extension knows: a
 * repository that GitHub lists without one (`configPaths` empty) has none; one that the discovery does not know may
 * have one (the open finds out after the clone). The sidebar lists a repository without one only with a default
 * image, which is then the only source of its devspace.
 */
export function hasConfiguration(info: Pick<RepositoryInfo, 'configPaths'> | undefined): boolean {
  return info === undefined || info.configPaths.length > 0;
}

/**
 * What Start (and every other open that the user asks for: the row, the switcher, Search, a double-click) opens a
 * devspace from: the default image while the setting `startWithDefaultImage` is on and a default image is set, else
 * the configuration of the repository. The context menu offers the other one (startWithSource of the controller).
 * A repository without a configuration (`info`) starts from the default image whatever the setting says: it has no
 * other source. Without a default image it has nothing to name: `undefined`, its devspace keeps the source of its
 * last open (a first open then reports the missing configuration).
 */
export function startSource(
  settings: Pick<ExtensionSettings, 'defaultImage' | 'startWithDefaultImage'>,
  info?: Pick<RepositoryInfo, 'configPaths'>,
): DevspaceSource | undefined {
  const image = defaultImageOf(settings);
  if (image === undefined) return hasConfiguration(info) ? { kind: 'configuration' } : undefined;
  return settings.startWithDefaultImage !== false || !hasConfiguration(info) ? { kind: 'defaultImage', image } : { kind: 'configuration' };
}

/**
 * Whether `source` is another source than the one of the last open of `devspace` (Devspace.defaultImage): the other
 * kind, or another default image. Start with Default Image and Start with Configuration rebuild a connected devspace
 * only then.
 */
export function sourceDiffers(devspace: Pick<Devspace, 'defaultImage'>, source: DevspaceSource): boolean {
  return source.kind === 'defaultImage' ? devspace.defaultImage !== source.image : devspace.defaultImage !== undefined;
}

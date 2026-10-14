// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sources of a repository (DevspaceSource): each of its Dev Container configurations, and the default image of
// the setting `defaultImage`. A devspace is created for one source and keeps it (docs/architecture.md, "Open"). No
// pipeline logic here: the worker reads and builds the source of the devspace.
import { configurationName } from './names';
import type { Devspace, DevspaceSource, ExtensionSettings, RepositoryInfo } from './types';

/** The default image of the settings, or `undefined` without one (readSettings drops an invalid reference). */
export function defaultImageOf(settings: Pick<ExtensionSettings, 'defaultImage'>): string | undefined {
  return settings.defaultImage !== undefined && settings.defaultImage !== '' ? settings.defaultImage : undefined;
}

/**
 * Whether the repository has a Dev Container configuration on its default branch, as far as the extension knows: a
 * repository that GitHub lists without one (`configPaths` empty) has none; one that the discovery does not know may
 * have one (the open finds out after the clone). The sidebar lists a repository without one only with a default
 * image, which is then its only source.
 */
export function hasConfiguration(info: Pick<RepositoryInfo, 'configPaths'> | undefined): boolean {
  return info === undefined || info.configPaths.length > 0;
}

/** The name of the configuration of a source (configurationName): `default` for the configuration at the root. */
function configurationNameOf(source: DevspaceSource): string | undefined {
  return source.kind === 'configuration' ? configurationName(source.configPath) : undefined;
}

/**
 * The word of a source, the same in the sidebar (the label of a child row), in the Docker names of a devspace
 * (resourceName) and in the texts that name a devspace next to its repository: `default` for the default image,
 * `config` for the configuration at the root of the repository (`.devcontainer/devcontainer.json` or
 * `.devcontainer.json`), and the folder name of an alternative configuration (`.devcontainer/<name>/devcontainer.json`).
 */
export function sourceLabel(source: DevspaceSource): string {
  if (source.kind === 'defaultImage') return 'default';
  const name = configurationName(source.configPath);
  return name === 'default' ? 'config' : name;
}

/**
 * The segment of the Docker names of a devspace of `source` (resourceName): its word (sourceLabel) in lower case,
 * every run of other characters than `[a-z0-9]` as one `-`.
 */
export function sourceSegment(source: DevspaceSource): string {
  const segment = sourceLabel(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return segment === '' ? 'x' : segment;
}

/**
 * The source of an existing devspace, fixed at its creation: the default image when its entry records one
 * (Devspace.defaultImage), else the configuration of its entry. The image of a default-image devspace is the one of
 * the settings now, so that a changed setting is noticed at the next open (the question Rebuild now / Later); without
 * one, the recorded image (the setting was cleared, the devspace keeps starting from the image it was built from).
 */
export function sourceOf(devspace: Pick<Devspace, 'configPath' | 'defaultImage'>, settings?: Pick<ExtensionSettings, 'defaultImage'>): DevspaceSource {
  if (devspace.defaultImage !== undefined) return { kind: 'defaultImage', image: (settings && defaultImageOf(settings)) ?? devspace.defaultImage };
  return { kind: 'configuration', configPath: devspace.configPath };
}

/**
 * Whether `devspace` is the devspace of `source`: the default-image devspace of its repository, or the devspace of
 * the configuration with the same name (configurationName: `.devcontainer/devcontainer.json` and `.devcontainer.json`
 * are the same configuration, the one at the root). The image of the source does not count: a repository has one
 * default-image devspace, whatever the setting names now.
 */
export function isSourceOf(devspace: Pick<Devspace, 'configPath' | 'defaultImage'>, source: DevspaceSource): boolean {
  if (source.kind === 'defaultImage') return devspace.defaultImage !== undefined;
  return devspace.defaultImage === undefined && configurationName(devspace.configPath) === configurationName(source.configPath);
}

/**
 * The key of a source in maps and in the operation gates: `default` for the default image, `config:<name>` for a
 * configuration (its name, configurationName). The same for the same source (sameSource).
 */
export function sourceKey(source: DevspaceSource): string {
  return source.kind === 'defaultImage' ? 'default' : `config:${configurationName(source.configPath)}`;
}

/**
 * The key of the operations of the devspace of `source` of a repository (lower-case `owner/name`, as GitHub names
 * ignore case, and the key of the source): the operations of one devspace run one after the other; those of two
 * devspaces of one repository run next to each other.
 */
export function sourceOperationKey(repository: string, source: DevspaceSource): string {
  return `${repository.toLowerCase()}#${sourceKey(source)}`;
}

/** Whether two sources are the same source (isSourceOf for sources). */
export function sameSource(a: DevspaceSource, b: DevspaceSource): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'defaultImage' || configurationNameOf(a) === configurationNameOf(b);
}

/**
 * The possible sources of a repository, in the order of the rows of the sidebar: its configurations (those that the
 * discovery lists, `info`, and those of its existing devspaces, each configuration once by its name: the one at the
 * root first, then the others by name), and the default image while the setting names one or a devspace was built
 * from one (sourceOf). The default image comes first while the setting `startWithDefaultImage` is on (the default),
 * last while it is off. A repository with two or more possible sources shows them as child rows.
 */
export function possibleSources(input: {
  info: Pick<RepositoryInfo, 'configPaths'> | undefined;
  devspaces: ReadonlyArray<Pick<Devspace, 'configPath' | 'defaultImage'>>;
  settings: Pick<ExtensionSettings, 'defaultImage' | 'startWithDefaultImage'>;
}): DevspaceSource[] {
  const configurations = new Map<string, Extract<DevspaceSource, { kind: 'configuration' }>>();
  const addConfiguration = (configPath: string): void => {
    const name = configurationName(configPath);
    if (!configurations.has(name)) configurations.set(name, { kind: 'configuration', configPath });
  };
  for (const configPath of input.info?.configPaths ?? []) addConfiguration(configPath);
  let image = defaultImageOf(input.settings);
  for (const devspace of input.devspaces) {
    if (devspace.defaultImage !== undefined) image ??= devspace.defaultImage;
    else addConfiguration(devspace.configPath);
  }
  const ordered = [...configurations.values()].sort((a, b) => {
    const nameA = configurationName(a.configPath);
    const nameB = configurationName(b.configPath);
    if (nameA === nameB) return 0;
    if (nameA === 'default') return -1;
    if (nameB === 'default') return 1;
    return nameA.localeCompare(nameB, 'en');
  });
  if (image === undefined) return ordered;
  const defaultImage: DevspaceSource = { kind: 'defaultImage', image };
  return input.settings.startWithDefaultImage !== false ? [defaultImage, ...ordered] : [...ordered, defaultImage];
}

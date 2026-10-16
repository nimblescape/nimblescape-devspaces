// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The devspace of the window at its activation, and the restore of a lost registry around it. No `vscode` import
// here, so it is unit-tested.
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { HelperPrebuildOutcome } from '../core/helper/helperPrebuild';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import type { Logger } from '../core/ports';
import { isOnDockerHost } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import { RESOURCE_NAME_PREFIX } from '../core/names';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { Devspace } from '../core/types';

/** The longest wait of the activation for the restore of a lost registry. */
export const WINDOW_RESTORE_TIMEOUT_MS = 30_000;

/**
 * The name of the devspace of this window (resourceName, the name of its workspace volume: with the word of its source
 * from version 0.6.0 on, without it before) for the name of its worker on the Docker host `host` (the host of the
 * worker's engine, '' for the local Docker; workerNameStart): of the registry entry of the container that the window
 * is attached to (`containerName`, ConnectionAdapter.currentContainerName), when the devspace is on that host.
 * Undefined for a window of no container, for a container that the registry does not know (also of a lost registry
 * before its restore), and for the workers of the window on other engines: these are named after the window.
 */
export async function windowDevspaceName(
  containerName: string | undefined,
  host: string,
  registry: Pick<DevspaceRegistry, 'findByContainerName'>,
): Promise<string | undefined> {
  if (!containerName) return undefined;
  const devspace = await registry.findByContainerName(containerName);
  return devspace && isOnDockerHost(devspace, host) ? devspace.volumeName : undefined;
}

/**
 * Whether the activation does its Docker work in the background (the restore of a lost registry, the prebuild of the
 * helper image): after the first use of Devspaces (`used`, devspacesUsed), and in the window of a container whose name
 * starts with `devspaces-` (the dev container of a devspace, also one that Docker Compose named after the project of
 * the devspace), which needs its devspace also when the storage folder was lost. Before the first use, other windows
 * ask Docker nothing in the background.
 */
export function backgroundWorkAtStart(used: boolean, containerName: string | undefined): boolean {
  return used || (containerName !== undefined && containerName.toLowerCase().startsWith(RESOURCE_NAME_PREFIX));
}

/**
 * The registry entry of the container that this window is attached to. When the registry lost its content (the file is
 * missing, not valid, or has invalid entries), it is restored from the volume labels first, so that the open pipeline
 * of role A can run for a restored window; this needs a running Docker, which is not started for it. With `mayRestore`
 * false (backgroundWorkAtStart), nothing is restored. Never throws.
 */
export async function findWindowDevspace(
  containerName: string,
  deps: {
    registry: Pick<DevspaceRegistry, 'findByContainerName'>;
    needsRestore: () => Promise<boolean>;
    docker: Pick<BootstrapDocker, 'isInstalled'>;
    service: Pick<DevspaceOperations, 'reconcileInWorker'>;
    logger: Logger;
    /** Whether a lost registry may be restored here; true when not given. */
    mayRestore?: boolean;
  },
): Promise<Devspace | undefined> {
  const { registry, needsRestore, docker, service, logger } = deps;
  try {
    const devspace = await registry.findByContainerName(containerName);
    if (devspace || deps.mayRestore === false || !(await needsRestore())) return devspace;
    // reconcileInWorker checks the Docker target first (never an endpoint that is neither local nor SSH), then whether
    // Docker runs; the worker of the Docker host restores, in the background (passive).
    if (!docker.isInstalled()) return undefined;
    // The activation waits at most WINDOW_RESTORE_TIMEOUT_MS for it; the restore in the background of the activation,
    // and the one after the build of the helper image, adopt the window later (reconcileIfRegistryLost with `adopt`).
    try {
      await service.reconcileInWorker({ passive: true, signal: AbortSignal.timeout(WINDOW_RESTORE_TIMEOUT_MS) });
    } catch (error) {
      logger.warn(`The devspaces could not be restored from the volumes while this window started: ${errorMessage(error)}`);
    }
    // The registry is read again whatever the restore answered: it may have added the entry before its time limit
    // ended, or another window restored it first (nothing added here).
    return await registry.findByContainerName(containerName);
  } catch (error) {
    logger.error('The devspace of this window could not be found.', error);
    return undefined;
  }
}

/**
 * The restore at activation is passive (it never builds the helper image), so a lost registry is restored again once
 * the background preparation of the helper image ended with an image (`restore` adopts a restored window), also when
 * the image was there already or is not due (a passive restore may have found no image, or no worker ready in time);
 * `restore` makes the worker ready in full.
 */
export async function restoreAfterPrebuild(outcome: HelperPrebuildOutcome, restore: () => Promise<void>): Promise<void> {
  if (outcome === 'built' || outcome === 'present' || outcome === 'notDue') await restore();
}

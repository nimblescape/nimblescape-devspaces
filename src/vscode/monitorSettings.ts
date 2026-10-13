// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The settings of the Monitor of an engine that extension.ts gives to an open (by the Docker host of the open)
// and to the repair of the heartbeats (by the Docker target): the schedule of its background run (cacheUpdateSchedule),
// the time zone of this computer, and its mode: permanent on every engine, local or remote, unless stopMonitorWhenIdle
// is on; a permanent one names this computer as its owner (its computer ID). No image patterns. Pure apart from the
// getters it is given; no `vscode`.
import type { DockerTarget } from '../core/docker/dockerHost';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, monitorRunsPermanently } from '../core/remoteMonitor/cacheSettings';
import type { MonitorSettings } from '../core/remoteMonitor/protocol';
import type { ExtensionSettings } from '../core/types';

export interface MonitorSettingsDeps {
  settings: () => Pick<ExtensionSettings, 'cacheUpdateSchedule' | 'stopMonitorWhenIdle'>;
  /** The time zone of this computer (usableTimeZone). */
  timeZone: () => string;
  /**
   * The ID of this computer (computer.id, 32 hex digits): the owner of a permanent monitor that it asks for. A failure to
   * read it leaves it out (an ensure without it keeps any running permanent monitor), so it never fails an open.
   */
  computerId: () => string;
}

/** The settings of the monitor of any engine of this computer (local and remote alike). */
export function monitorSettingsFor(deps: MonitorSettingsDeps): MonitorSettings {
  const settings = deps.settings();
  const permanent = monitorRunsPermanently(settings.stopMonitorWhenIdle);
  return {
    schedule: settings.cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,
    timeZone: deps.timeZone(),
    permanent,
    // This computer: the owner of a permanent monitor that it creates (LABEL_MONITOR_OWNER), and how an ensure tells
    // its own permanent monitor from one that another computer keeps.
    ...computerOf(deps),
  };
}

/** `{ computer }` with the ID of this computer, or nothing when it cannot be read. */
function computerOf(deps: MonitorSettingsDeps): { computer?: string } {
  try {
    return { computer: deps.computerId() };
  } catch {
    return {};
  }
}

/**
 * The monitor settings of an open (its Docker host: empty for the local Docker, the SSH host otherwise) and of the
 * repair of a Docker target; the same for every engine.
 */
export function monitorSettingsOf(deps: MonitorSettingsDeps): { forOpen(dockerHost: string): MonitorSettings; forTarget(target: Pick<DockerTarget, 'kind'>): MonitorSettings } {
  return {
    forOpen: () => monitorSettingsFor(deps),
    forTarget: () => monitorSettingsFor(deps),
  };
}

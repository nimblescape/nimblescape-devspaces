// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the ensure of the Session Monitor container (RemoteSessionMonitor) asks of its Docker engine, as a port of its
// own. The worker implements it over the Engine API (src/core/worker/engineMonitor.ts); every remote action is a worker
// operation. Pure types and the shared readings of the engine's answers; no I/O, no `vscode`. The spec and the outcome
// of the attached create are types of the port DockerEngine (dockerEngine.ts), which this port uses; the generic port
// does not import the monitor's types.
import type { MonitorCreated, MonitorRunSpec } from '../worker/dockerEngine';

/**
 * The state of the monitor container: missing, or its status (`created`, `running`, `paused`, `restarting`, `removing`,
 * `exited`, `dead`), the exit code of its last run, its label (LABEL_SESSION_MONITOR), how often Docker restarted it by
 * its restart policy since its last start by a client (`RestartCount`; 0 when it cannot be read), its ID (64 hex digits;
 * undefined when it cannot be read), and when the daemon created it (milliseconds since the epoch on the clock of the
 * daemon; undefined when it cannot be read).
 */
export type MonitorInspected =
  | { exists: false }
  | { exists: true; status: string; exitCode: number | undefined; label: string; restartCount: number; id: string | undefined; createdAt: number | undefined };

/**
 * What the check of the stored script of the running container found (`sha256sum` of REMOTE_MONITOR_SCRIPT_PATH in it):
 * its hash (as printed; the caller checks it), `none` (definite evidence that no script is stored or that the container
 * does not run), or `unknown` (the check itself failed: no answer in time, a transport error, an unexpected answer).
 */
export type MonitorStoredScript = { hash: string } | 'none' | 'unknown';

/** The engine of the monitor container (see the module comment). Each call is bounded by the implementation. */
export interface MonitorEngine {
  /** The container `name`; rejects with the cause when it cannot be read (a missing one is `exists: false`). */
  inspect(name: string, signal?: AbortSignal): Promise<MonitorInspected>;
  /** The clock of the daemon in milliseconds since the epoch, or the reason it cannot be read. A cancel passes. */
  daemonTime(signal?: AbortSignal): Promise<number | { reason: string }>;
  /**
   * Removes the container `id` (by its ID, never its name). A container that is gone, or whose removal another window
   * runs already, is no failure; anything else rejects with the cause.
   */
  remove(id: string, signal?: AbortSignal): Promise<void>;
  /** Starts the container `id`; rejects with the cause. */
  start(id: string, signal?: AbortSignal): Promise<void>;
  /** The check of the stored script of the container `name` (MonitorStoredScript). A cancel passes. */
  storedScript(name: string, signal?: AbortSignal): Promise<MonitorStoredScript>;
  /** The IDs of the containers with the label `label` (`key=value`), stopped ones included; undefined when the list fails. */
  idsWithLabel(label: string, signal?: AbortSignal): Promise<string[] | undefined>;
  /**
   * The attached create of the monitor (pipe loading): creates the container of `spec`, writes `scriptLine` (the first
   * line of the loader) to its input, and waits for `readyText` on its output, its end, the time limit, or the
   * cancellation; then its input is closed (the container goes on alone). Never rejects, except for a failure before
   * the container exists (then nothing is left behind).
   */
  create(spec: MonitorRunSpec, scriptLine: string, readyText: string, signal?: AbortSignal): Promise<MonitorCreated>;
}

/**
 * A failed `sha256sum` that shows that no script is stored, or that the container does not run (in its output or the
 * engine's message). Each alternative is tied to the start of a line of its source (`sha256sum`, the OCI runtime), so
 * an unrelated line of a transport failure that also says "No such file or directory" is no evidence. A stored script
 * that cannot be read (`Permission denied`) is no evidence either. The runtime's refusal of an exec in a container that
 * stopped between two restarts is evidence that it does not run (the wording of newer runc and the older one), which
 * the daemon writes to the output of the exec. The engine's refusal of the exec itself comes as its status
 * (engineMonitor). Over the Engine API the exec's output carries only what the process and the daemon write to it,
 * never the prefixes of the Docker CLI (`Error response from daemon: `, `Error: `), so the pattern has none of them.
 */
export const NO_STORED_SCRIPT =
  /^sha256sum: .*No such file or directory|^OCI runtime exec failed: exec failed: cannot exec (?:in a stopped container|a container that has stopped)\b/im;

/** Another window removes the same container right now; its removal goes on. */
export const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;

/**
 * A time of Docker as JSON gives it (Go's RFC 3339 with nanoseconds, `Z` or an offset), in milliseconds since the
 * epoch; undefined for anything else (never a guess).
 */
export function parseDockerTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const fraction = Number(`0.${match[7] ?? '0'}`);
  const zone = match[8];
  const offsetMinutes = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) + Math.floor(fraction * 1000) - offsetMinutes * 60_000;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day ? ms : undefined;
}

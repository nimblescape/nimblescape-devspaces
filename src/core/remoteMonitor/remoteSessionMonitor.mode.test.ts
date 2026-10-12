// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The container of the Monitor by its mode: a permanent monitor (a remote engine, or a local one with
// stopLocalMonitorWhenIdle off) has the restart policy `unless-stopped` and its part of the label, one that ends when
// idle `on-failure`; both have the default network and the shared VS Code server store of the worker. A change of the
// mode replaces the container, except that an ensure of a monitor that ends when idle takes a running permanent one of
// the same version as current.
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports';
import type { MonitorCreated, MonitorRunSpec } from '../worker/dockerEngine';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import { PERMANENT_LOCAL_LABEL_PART, PERMANENT_REMOTE_LABEL_PART, remoteMonitorLabelValue, vscodeStoreLabelPart } from './protocol';
import { RemoteSessionMonitor, monitorLabel } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devspace-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const ID = 'feed'.padEnd(64, '1');
const IMAGES = { schedule: '17', timeZone: 'UTC' };
const IDLE = monitorLabel(SCRIPT, TAG, 'idle');
// A permanent monitor of an ensure without `remote` (the setting off on a local engine).
const PERMANENT = monitorLabel(SCRIPT, TAG, 'permanent-local');
const REMOTE = monitorLabel(SCRIPT, TAG, 'permanent-remote');

const logger = (): Logger => ({ info: () => {}, warn: () => {}, error: () => {}, output: () => {} });

/** A MonitorEngine in memory: the container of the name (`found`, one per inspect, the last one repeats), and its calls. */
function fakeEngine(found: MonitorInspected[], created: MonitorCreated[] = [{ kind: 'ready' }]) {
  const calls: string[] = [];
  const specs: MonitorRunSpec[] = [];
  let looks = 0;
  let creates = 0;
  const engine: MonitorEngine = {
    inspect: async () => {
      calls.push('inspect');
      return found[Math.min(looks++, found.length - 1)];
    },
    daemonTime: async () => Date.now(),
    remove: async (id) => void calls.push(`remove ${id}`),
    start: async (id) => void calls.push(`start ${id}`),
    storedScript: async () => 'unknown',
    idsWithLabel: async () => [],
    create: async (spec) => {
      calls.push('create');
      specs.push(spec);
      return created[Math.min(creates++, created.length - 1)];
    },
  };
  return { engine, calls, specs };
}

const running = (label: string): MonitorInspected => ({ exists: true, status: 'running', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined });
const exited = (label: string): MonitorInspected => ({ exists: true, status: 'exited', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined });

function monitorOf(engine: MonitorEngine, permanent: boolean | undefined, store?: string, remote?: boolean): RemoteSessionMonitor {
  return new RemoteSessionMonitor({
    engine,
    logger: logger(),
    script: async () => SCRIPT,
    imageMaintenance: () => ({ ...IMAGES, ...(permanent !== undefined ? { permanent } : {}), ...(remote !== undefined ? { remote } : {}) }),
    ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
  });
}

describe('the container of the Monitor by its mode', () => {
  it('a permanent monitor: unless-stopped, its variable, its label part; one that ends when idle: on-failure, neither', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const permanent = monitorOf(engine, true).runSpec(TAG, SOCKET, PERMANENT, SCRIPT, { ...IMAGES, permanent: true });
    expect(permanent.restartPolicy).toBe('unless-stopped');
    expect(permanent.env.DEVSPACE_MONITOR_PERMANENT).toBe('1');
    // The part says why it is permanent.
    expect(PERMANENT).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_LOCAL_LABEL_PART]));
    expect(REMOTE).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_REMOTE_LABEL_PART]));
    expect(IDLE).toBe(remoteMonitorLabelValue(SCRIPT, TAG, []));
    expect(new Set([IDLE, PERMANENT, REMOTE]).size).toBe(3);
    for (const images of [{ ...IMAGES, permanent: false }, IMAGES, undefined]) {
      const idle = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, images);
      expect(idle.restartPolicy).toBe('on-failure');
      expect(idle.env).not.toHaveProperty('DEVSPACE_MONITOR_PERMANENT');
    }
  });

  it('always has the default network, with or without prefixes, in either mode', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    for (const images of [undefined, IMAGES, { ...IMAGES, prefixes: ['ghcr.io/acme/base'] }, { ...IMAGES, permanent: true }]) {
      expect(monitorOf(engine, undefined).runSpec(TAG, SOCKET, IDLE, SCRIPT, images).network).toBe('default');
    }
  });

  it('mounts the store of the worker read-write at /vscode and names it; without one, no store', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const spec = monitorOf(engine, false, 'devspace-test-vscode').runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(spec.mounts).toEqual({ socket: SOCKET, volume: 'devspace-monitor', volumeTarget: '/state', store: { volume: 'devspace-test-vscode', target: '/vscode' } });
    expect(spec.env.DEVSPACE_VSCODE_STORE).toBe('devspace-test-vscode');
    const without = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(without.mounts).toEqual({ socket: SOCKET, volume: 'devspace-monitor', volumeTarget: '/state' });
    expect(without.env).not.toHaveProperty('DEVSPACE_VSCODE_STORE');
  });

  it('creates a missing monitor with the label of its mode', async () => {
    for (const [permanent, label] of [
      [true, PERMANENT],
      [false, IDLE],
    ] as const) {
      const { engine, specs } = fakeEngine([{ exists: false }]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(specs[0].labels['nimblescape.devspace.monitor']).toBe(label);
      expect(specs[0].restartPolicy).toBe(permanent ? 'unless-stopped' : 'on-failure');
    }
  });
});

describe('the change of the mode at the next ensure', () => {
  it('keeps a running monitor of the same mode', async () => {
    for (const [permanent, label] of [
      [true, PERMANENT],
      [false, IDLE],
    ] as const) {
      const { engine, calls } = fakeEngine([running(label)]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
  });

  it('replaces a running monitor that ends when idle by a permanent one (a remote engine, or the setting turned off)', async () => {
    const { engine, calls, specs } = fakeEngine([running(IDLE)]);
    expect(await monitorOf(engine, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
    expect(specs[0].restartPolicy).toBe('unless-stopped');
  });

  // The permanent monitor that such a window keeps is one that another computer runs as remote (`permanent-remote`);
  // its own `permanent-local` one is replaced (see below).
  it('a window that sees the engine as local keeps a running permanent monitor of the same version that a remote computer runs', async () => {
    const { engine, calls } = fakeEngine([running(REMOTE)]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect']);
    // Without the mode (an older wiring): the same.
    const unset = fakeEngine([running(REMOTE)]);
    expect(await monitorOf(unset.engine, undefined).ensureOrThrow(TAG, SOCKET)).toBe('running');
  });

  it('a permanent monitor of another version, or one that does not run, is replaced by one that ends when idle', async () => {
    const other = fakeEngine([running(monitorLabel('console.log("older")', TAG, 'permanent-remote'))]);
    expect(await monitorOf(other.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(other.specs[0].restartPolicy).toBe('on-failure');
    const stopped = fakeEngine([exited(REMOTE)]);
    expect(await monitorOf(stopped.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(stopped.calls).toEqual(['inspect', `remove ${ID}`, 'create']);
  });

  it('a name conflict of the create: a running permanent monitor of another window counts as current for one that ends when idle', async () => {
    const conflict: MonitorCreated = { kind: 'exited', detail: 'Conflict. The container name "/devspace-monitor" is already in use', conflict: true };
    const { engine, calls } = fakeEngine([{ exists: false }, running(REMOTE)], [conflict]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect', 'create', 'inspect']);
    // A permanent ensure does not take one that ends when idle there.
    const other = fakeEngine([{ exists: false }, running(IDLE)], [conflict]);
    await expect(monitorOf(other.engine, true).ensureOrThrow(TAG, SOCKET)).rejects.toThrow(/docker run failed/);
  });
});

// The label says why a monitor is permanent, so turning stopLocalMonitorWhenIdle on again takes effect at the next
// ensure of this computer, while a monitor that another computer runs because it reaches the engine as a remote one is
// kept (no ping-pong between two computers).
describe('why a monitor is permanent', () => {
  it('a remote ensure creates `permanent-remote`, a local one with the setting off `permanent-local`', async () => {
    for (const [remote, label] of [
      [true, REMOTE],
      [false, PERMANENT],
    ] as const) {
      const { engine, specs } = fakeEngine([{ exists: false }]);
      expect(await monitorOf(engine, true, undefined, remote).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(specs[0].labels['nimblescape.devspace.monitor']).toBe(label);
      expect(specs[0].restartPolicy).toBe('unless-stopped');
    }
  });

  it('a local ensure with the setting on replaces a running `permanent-local` monitor (the setting turned on again)', async () => {
    const { engine, calls, specs } = fakeEngine([running(PERMANENT)]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
    expect(specs[0].restartPolicy).toBe('on-failure');
    expect(specs[0].labels['nimblescape.devspace.monitor']).toBe(IDLE);
  });

  it('a remote ensure keeps a running `permanent-local` monitor; a local one with the setting off keeps a running `permanent-remote` one', async () => {
    const remote = fakeEngine([running(PERMANENT)]);
    expect(await monitorOf(remote.engine, true, undefined, true).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(remote.calls).toEqual(['inspect']);
    const local = fakeEngine([running(REMOTE)]);
    expect(await monitorOf(local.engine, true, undefined, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(local.calls).toEqual(['inspect']);
  });

  it('a remote ensure replaces a running monitor that ends when idle, and an exited `permanent-local` one', async () => {
    for (const found of [running(IDLE), exited(PERMANENT)]) {
      const { engine, calls, specs } = fakeEngine([found]);
      expect(await monitorOf(engine, true, undefined, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
      expect(specs[0].labels['nimblescape.devspace.monitor']).toBe(REMOTE);
    }
  });
});

// The store that the monitor mounts is part of its label.
describe('the store in the label of the monitor', () => {
  const WITH_STORE = monitorLabel(SCRIPT, TAG, 'permanent-remote', 'devspace-vscode');

  it('the label names the store; without one, none', () => {
    expect(WITH_STORE).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_REMOTE_LABEL_PART, vscodeStoreLabelPart('devspace-vscode')]));
    expect(monitorLabel(SCRIPT, TAG, 'idle', 'devspace-vscode')).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [vscodeStoreLabelPart('devspace-vscode')]));
    expect(new Set([WITH_STORE, REMOTE, monitorLabel(SCRIPT, TAG, 'permanent-remote', 'devspace-other')]).size).toBe(3);
  });

  it('an ensure with the store replaces a running monitor created without it (and the other way round); the same one stays', async () => {
    const without = fakeEngine([running(REMOTE)]);
    expect(await monitorOf(without.engine, true, 'devspace-vscode', true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(without.specs[0].labels['nimblescape.devspace.monitor']).toBe(WITH_STORE);
    expect(without.specs[0].mounts.store).toEqual({ volume: 'devspace-vscode', target: '/vscode' });
    const withStore = fakeEngine([running(WITH_STORE)]);
    expect(await monitorOf(withStore.engine, true, undefined, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    const same = fakeEngine([running(WITH_STORE)]);
    expect(await monitorOf(same.engine, true, 'devspace-vscode', true).ensureOrThrow(TAG, SOCKET)).toBe('running');
    // A local ensure with the store keeps the running remote one of the same store.
    const local = fakeEngine([running(WITH_STORE)]);
    expect(await monitorOf(local.engine, false, 'devspace-vscode').ensureOrThrow(TAG, SOCKET)).toBe('running');
  });
});

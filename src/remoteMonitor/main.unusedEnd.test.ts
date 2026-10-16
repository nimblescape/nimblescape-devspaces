// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A permanent monitor ends itself after 30 days in which no window used the engine: the subcommands of the windows
// record the use (last-use.json, at most once an hour), a new container is a use and a restart is none, and the loop
// looks again after an hour before it sets the restart policy of its own container to `no` and exits with 0. The volume
// is a temporary folder; the engine is a fake.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_USE_FILE, UNUSED_END_MS, parseLastUse, type LastUse } from '../core/remoteMonitor/protocol';
import { EngineError, type EngineContainerSummary, type EngineFilters } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { MonitorEngineParts } from './engine';
import { EXIT_INVALID, STATE_TEMPORARY_FILE, UNUSED_END_RECHECK_MS, main, recordStart, recordUse, spanText, unusedEndFromEnv, vscodeBackgroundDeps } from './main';
import { REMOTE_TICK_MS } from './rules';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SOURCE = '0123456789abcdef0123456789abcdef';
const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
/** The nonce of the create of this monitor container, and of another (newer) one. */
const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';
const NEWER = '0f0f0f0f-0000-4000-8000-000000000002';
const OWN_ID = 'feed'.padEnd(64, '1');
/** The container of a permanent monitor whose first background run is a day away (none runs in these tests). */
const PERMANENT_ENV = { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_MONITOR_CREATE_ID: CREATE, DEVSPACE_IMAGE_FIRST_MS: '86400000' };

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-unused-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function lastUse(): LastUse | undefined {
  const file = path.join(stateDir, LAST_USE_FILE);
  return fs.existsSync(file) ? parseLastUse(fs.readFileSync(file, 'utf8')) : undefined;
}

function writeLastUse(use: LastUse): void {
  fs.writeFileSync(path.join(stateDir, LAST_USE_FILE), JSON.stringify(use));
}

const heartbeat = JSON.stringify({ source: SOURCE, limitSeconds: 600, devspaces: [{ id: A, keepRunning: false, seq: 1 }] });

describe('the use of the engine', () => {
  it('is 30 days by default; the Docker tests can set a shorter time', () => {
    expect(UNUSED_END_MS).toBe(30 * DAY);
    expect(unusedEndFromEnv({})).toBe(UNUSED_END_MS);
    expect(unusedEndFromEnv({ DEVSPACE_MONITOR_UNUSED_MS: '3000' })).toBe(3000);
    for (const value of ['99', '-1', 'x', String(UNUSED_END_MS + 1)]) expect(unusedEndFromEnv({ DEVSPACE_MONITOR_UNUSED_MS: value })).toBe(UNUSED_END_MS);
    expect([spanText(30 * DAY), spanText(HOUR), spanText(2 * MINUTE), spanText(3000)]).toEqual(['30 days', '1 hour', '2 minutes', '3 s']);
  });

  it('a subcommand of a window records it at most once an hour; a clock that went back records it again', async () => {
    const env = { DEVSPACE_MONITOR_CREATE_ID: CREATE };
    const run = (argv: string[], now: number, input = '') => main(argv, { env, stateDir, now: () => now, readStdin: async () => input, err: () => {} });
    expect(await run(['heartbeat', heartbeat], T0)).toBe(0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // Within the hour, nothing is written (the heartbeats come every 30 s).
    expect(await run(['heartbeat', heartbeat], T0 + 59 * MINUTE)).toBe(0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    expect(await run(['run-now'], T0 + HOUR)).toBe(0);
    expect(lastUse()).toEqual({ at: T0 + HOUR, createId: CREATE });
    expect(await run(['settings', '-'], T0 + 2 * HOUR, JSON.stringify({ schedule: '17', timeZone: 'UTC' }))).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 2 * HOUR);
    expect(await run(['images', '-'], T0 + 3 * HOUR, JSON.stringify({ source: SOURCE, references: ['node:20'] }))).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 3 * HOUR);
    // A time before the stored one: the clock went back, so it is a use now.
    expect(await run(['heartbeat', heartbeat], T0)).toBe(0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // The forget of a Delete comes from a window.
    expect(await run(['forget', SOURCE, A], T0 + 4 * HOUR)).toBe(0);
    expect(lastUse()?.at).toBe(T0 + 4 * HOUR);
  });

  it('the forget of the loop and a call that is refused record no use', async () => {
    const env = { DEVSPACE_MONITOR_CREATE_ID: CREATE };
    const run = (argv: string[]) => main(argv, { env, stateDir, now: () => T0, out: () => {}, err: () => {} });
    expect(await run(['forget', SOURCE, A, String(T0 - DAY)])).toBe(0);
    expect(await run(['heartbeat', '{'])).toBe(EXIT_INVALID);
    expect(await run(['run-now', 'x'])).toBe(EXIT_INVALID);
    expect(lastUse()).toBeUndefined();
  });

  it('is written atomically, and a leftover temporary file of it is removed at the start of run', async () => {
    expect(STATE_TEMPORARY_FILE.test('last-use.json.12.1.tmp')).toBe(true);
    await recordUse(stateDir, {}, T0);
    expect(fs.readdirSync(stateDir)).toEqual([LAST_USE_FILE]);
    // Without the nonce of a create (an older container), the stored one stays.
    writeLastUse({ at: T0 - 2 * HOUR, createId: CREATE });
    await recordUse(stateDir, {}, T0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
  });

  it('a new monitor container is a use; a restart of the same container is none', async () => {
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: CREATE }, T0);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // Docker started the same container again (a restart of the engine).
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: CREATE }, T0 + 10 * DAY);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    // An open created a new container.
    await recordStart(stateDir, { DEVSPACE_MONITOR_CREATE_ID: NEWER }, T0 + 11 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 11 * DAY, createId: NEWER });
    // A container without a nonce keeps a valid time; a file that is not valid counts as a use now.
    await recordStart(stateDir, {}, T0 + 12 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 11 * DAY, createId: NEWER });
    fs.writeFileSync(path.join(stateDir, LAST_USE_FILE), '{"at":"yesterday"}');
    await recordStart(stateDir, {}, T0 + 13 * DAY);
    expect(lastUse()).toEqual({ at: T0 + 13 * DAY });
  });
});

describe('the end of a permanent monitor after 30 days without use', () => {
  interface Started {
    result: Promise<number>;
    out: () => string;
    events: string[];
    mono: () => number;
    ticks: () => number;
  }

  /**
   * `run` with a fake engine that knows its own container (OWN_ID). `now` gives the clock of the host by the monotonic
   * time; `onTick` runs at each wait between two ticks; at `maxTicks` the loop waits forever.
   */
  function startRun(options: {
    env?: NodeJS.ProcessEnv;
    now?: (mono: number) => number;
    updateRestartPolicy?: () => Promise<void>;
    onTick?: (mono: number) => Promise<void> | void;
    maxTicks?: number;
    engine?: Partial<MonitorEngineParts>;
    vscodeBackground?: () => ReturnType<typeof vscodeBackgroundDeps>;
  }): Started {
    let mono = 0;
    let ticks = 0;
    let out = '';
    const events: string[] = [];
    const now = options.now ?? ((time: number) => T0 + time);
    const result = main(['run'], {
      env: options.env ?? PERMANENT_ENV,
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        containerIds: async (filters: EngineFilters) => {
          events.push(`list ${JSON.stringify(filters)}`);
          return [OWN_ID];
        },
        updateRestartPolicy: async (id, policy) => {
          events.push(`policy ${id === OWN_ID ? 'own' : id} ${policy}`);
          await options.updateRestartPolicy?.();
        },
        ...options.engine,
      },
      vscodeBackground: options.vscodeBackground ?? (() => undefined),
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => now(mono),
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        await options.onTick?.(mono);
        if (ticks >= (options.maxTicks ?? 10_000)) await new Promise(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => {
        out += text;
        if (text.includes('the Monitor ends itself')) events.push('exit');
      },
    });
    return { result, out: () => out, events, mono: () => mono, ticks: () => ticks };
  }

  const pending = async (promise: Promise<unknown>) =>
    (await Promise.race([promise.then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('pending'), 200))])) as string;

  it('looks again after an hour, sets the restart policy of its own container to "no", then exits with 0', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const monitor = startRun({});
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([`list ${JSON.stringify({ label: [`nimblescape.devspaces.monitor-create=${CREATE}`] })}`, 'policy own no', 'exit']);
    // The second look comes an hour after the first.
    expect(monitor.mono()).toBeGreaterThanOrEqual(UNUSED_END_RECHECK_MS);
    expect(monitor.mono()).toBeLessThan(UNUSED_END_RECHECK_MS + 2 * REMOTE_TICK_MS);
    expect(monitor.out()).toContain('runs permanently. It ends itself when no window used Devspaces on this engine for 30 days.');
    expect(monitor.out()).toContain('No window used Devspaces on this Docker engine for 30 days. The Monitor looks again in 1 hour; then it ends itself.');
    expect(monitor.out()).toContain('No window used Devspaces on this Docker engine for 30 days; the Monitor ends itself. Its restart policy is now "no". The next open starts a new one.');
    // The restart of the same container was no use.
    expect(lastUse()).toEqual({ at: T0 - UNUSED_END_MS, createId: CREATE });
  });

  it('a new container counts as a use: it runs on', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: NEWER });
    const monitor = startRun({ maxTicks: Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS) });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((2 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)));
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
  });

  it('a use of a window during the hour keeps it running', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let used = false;
    const monitor = startRun({
      onTick: async (mono) => {
        // A heartbeat of a window half an hour after the first look.
        if (!used && mono >= 30 * MINUTE) {
          used = true;
          await recordUse(stateDir, PERMANENT_ENV, T0 + mono);
        }
      },
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)));
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(monitor.out()).toContain('The Monitor looks again in 1 hour');
  });

  it('a clock that jumped ahead and is set right again within the hour ends nothing', async () => {
    writeLastUse({ at: T0, createId: CREATE });
    // 40 days ahead for the first ten minutes.
    const monitor = startRun({
      now: (mono) => T0 + mono + (mono < 10 * MINUTE ? 40 * DAY : 0),
      maxTicks: Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS),
    });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS)));
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.events).toEqual([]);
    expect(lastUse()?.at).toBe(T0);
  });

  it('a stored time later than the clock (the clock went back) counts as a use now', async () => {
    writeLastUse({ at: T0 + 400 * DAY, createId: CREATE });
    const monitor = startRun({ maxTicks: 5 });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(5));
    expect(lastUse()).toEqual({ at: T0, createId: CREATE });
    expect(monitor.events).toEqual([]);
  });

  it('a failure is logged once and does not end it; it tries again an hour later', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let failures = 2;
    const monitor = startRun({
      updateRestartPolicy: async () => {
        if (failures-- > 0) throw new EngineError('the daemon is busy', 500);
      },
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.events.filter((event) => event === 'policy own no')).toHaveLength(3);
    expect(monitor.events.at(-1)).toBe('exit');
    // The first look, the second look an hour later, and two tries again, an hour apart.
    expect(monitor.mono()).toBeGreaterThanOrEqual(3 * UNUSED_END_RECHECK_MS);
    expect(monitor.mono()).toBeLessThan(3 * UNUSED_END_RECHECK_MS + 4 * REMOTE_TICK_MS);
    const failed = 'The Monitor could not end itself (its restart policy could not be changed: the daemon is busy). It tries again in 1 hour.';
    expect(monitor.out().split(failed)).toHaveLength(2);
  });

  it('does not end without the nonce of its create, or when the list does not name one container', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS });
    const ticks = Math.ceil((3 * UNUSED_END_RECHECK_MS) / REMOTE_TICK_MS);
    const without = startRun({ env: { DEVSPACE_MONITOR_PERMANENT: '1', DEVSPACE_IMAGE_FIRST_MS: '86400000' }, maxTicks: ticks });
    await vi.waitFor(() => expect(without.ticks()).toBe(ticks));
    expect(await pending(without.result)).toBe('pending');
    expect(without.out()).toContain('The Monitor could not end itself (it does not know its container: the nonce of its create is missing). It tries again in 1 hour.');
    expect(without.events).toEqual([]);

    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const none = startRun({ engine: { containerIds: async () => [] }, maxTicks: ticks });
    await vi.waitFor(() => expect(none.ticks()).toBe(ticks));
    expect(await pending(none.result)).toBe('pending');
    expect(none.out()).toContain('The Monitor could not end itself (0 containers have the nonce of its create). It tries again in 1 hour.');
    expect(none.events).toEqual([]);
  });

  it('a monitor that ends when idle never ends itself by the time without use', async () => {
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    const idle = startRun({ env: { DEVSPACE_MONITOR_CREATE_ID: CREATE, DEVSPACE_IMAGE_FIRST_MS: '86400000' } });
    expect(await idle.result).toBe(0);
    expect(idle.out()).toContain('it does not run permanently; the Monitor exits.');
    expect(idle.out()).not.toContain('No window used Devspaces');
    expect(idle.events).toEqual([]);
  });

  it('waits for a background run that runs, and ends after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    writeLastUse({ at: T0 - UNUSED_END_MS, createId: CREATE });
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<string>((_resolve, reject) => (finish = () => reject(new Error('ended by the test'))));
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store);
    const vscode = {
      store: { root: store },
      storeVolume: 'devspaces-vscode',
      extensionStateDir: stateDir,
      engine: {
        ...unusedEngine(),
        architecture: async () => {
          started();
          return gate;
        },
      },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
    let first = true;
    const monitor = startRun({
      env: { ...PERMANENT_ENV, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      vscodeBackground: () => vscode,
      onTick: async () => {
        if (!first) return;
        first = false;
        await runStarted;
      },
    });
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    // Well past the second look: the run holds the end back.
    await vi.waitFor(() => expect(monitor.mono()).toBeGreaterThan(2 * UNUSED_END_RECHECK_MS), { timeout: 10_000 });
    expect(monitor.events).toEqual([]);
    finish();
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([expect.stringMatching(/^list /), 'policy own no', 'exit']);
    expect(monitor.out().indexOf('the Monitor ends itself')).toBeGreaterThan(monitor.out().indexOf('The background run ended.'));
  });
});

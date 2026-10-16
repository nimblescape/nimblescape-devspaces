// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The command "Update All Images Now": the controller asks the Monitor of the Docker engine of the operation
// (the sidebar's) through the worker (`monitorRunNow`), with a progress until the monitor took the request, then the
// message; the window's call to the worker (workerMonitor.monitorRunNow) with the monitor settings of this computer,
// its time limit, and a strict answer; and the command and its menu in package.json.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { dockerTargetOf, type DockerTarget } from '../core/docker/dockerHost';
import { UNREADABLE_DOCKER_TARGET, podmanDockerTarget } from '../core/docker/dockerTargets';
import { OP_MONITOR_RUN_NOW } from '../core/helperChannel/protocol';
import { Messages } from '../core/messages';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS, MONITOR_RUN_NOW_FLOW_TIMEOUT_MS } from '../core/pipeline/operationBase';
import { silentLogger } from '../core/ports';
import { Commands } from './commands';
import { Controller, type ControllerDeps } from './controller';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { workerMonitor, type TargetFlow } from './workerMonitor';

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'build-box' } as DockerTarget;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as DockerTarget;
const IMAGES = { schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: true, computer: 'c'.repeat(32) };

beforeEach(() => {
  resetFakeVscode();
  // The progress runs its task at once (runWithProgress).
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
    task({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

function controllerWith(target: DockerTarget, update?: ControllerDeps['updateImagesNow'], monitorQuestion?: ControllerDeps['monitorQuestion']) {
  const infos: string[] = [];
  const logger = { info: vi.fn((text: string) => void infos.push(text)), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), show: vi.fn() };
  const deps = {
    logger,
    dockerTargets: { current: async () => target, resolve: async () => target, withOperation: <T>(fn: () => Promise<T>) => fn() },
    ...(update !== undefined ? { updateImagesNow: update } : {}),
    ...(monitorQuestion !== undefined ? { monitorQuestion } : {}),
  } as unknown as ControllerDeps;
  return { controller: new Controller(deps), infos };
}

describe('the command Update All Images Now', () => {
  it('asks the Monitor of the engine of the operation, with a progress, then says that it updates now', async () => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const { controller, infos } = controllerWith(REMOTE, update);
    await controller.updateImagesNow();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(REMOTE);
    expect(update.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(fakeVscode.window.withProgress).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on build-box updates the images now.');
    expect(infos).toContain('The Monitor on build-box took the request of "Update All Images Now".');
  });

  it('asks about the Monitor of the engine first (monitorQuestion.ts); a closed question goes on with the request', async () => {
    const order: string[] = [];
    const update = vi.fn(async () => void order.push('update'));
    const askIfNeeded = vi.fn(async (host: string) => {
      order.push(`ask ${host}`);
      return 'closed' as const;
    });
    await controllerWith(REMOTE, update, { askIfNeeded }).controller.updateImagesNow();
    expect(order).toEqual(['ask build-box', 'update']);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on build-box updates the images now.');
  });

  it('names the local Docker for a local engine', async () => {
    const { controller } = controllerWith(LOCAL, async () => {});
    await controller.updateImagesNow();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('The Monitor on the local Docker updates the images now.');
  });

  it('a failure rejects (the command shows it) and says nothing of an update', async () => {
    const { controller } = controllerWith(REMOTE, async () => Promise.reject(new Error('The Monitor did not take the request: Usage')));
    await expect(controller.updateImagesNow()).rejects.toThrow('did not take the request');
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['Podman', podmanDockerTarget('docker --version: podman version 5.2.2'), Messages.podmanNotSupported],
    ['a Docker context that cannot be read', UNREADABLE_DOCKER_TARGET, Messages.dockerContextUnreadable],
    ['an endpoint that is neither local nor SSH', dockerTargetOf('tcp://10.0.0.5:2375', 'tcp-box'), Messages.dockerEndpointUnsupported('tcp://10.0.0.5:2375')],
  ])('refuses %s with its message, without a progress and without the Monitor', async (_name, target, message) => {
    const update = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => {});
    const { controller } = controllerWith(target, update);
    await expect(controller.updateImagesNow()).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message });
    expect(update).not.toHaveBeenCalled();
    expect(fakeVscode.window.withProgress).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing without the call to the worker', async () => {
    const { controller } = controllerWith(REMOTE);
    await controller.updateImagesNow();
    expect(fakeVscode.window.withProgress).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('is a command of package.json, in the Command Palette and in the "…" menu of the view', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string; category: string }>; menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
    };
    expect(Commands.updateImagesNow).toBe('devspaces.updateImagesNow');
    expect(manifest.contributes.commands.find((entry) => entry.command === Commands.updateImagesNow)).toEqual({
      command: Commands.updateImagesNow,
      title: 'Update All Images Now',
      category: 'Devspaces',
    });
    // Not hidden in the Command Palette.
    expect(manifest.contributes.menus.commandPalette.some((entry) => entry.command === Commands.updateImagesNow)).toBe(false);
    expect(manifest.contributes.menus['view/title'].find((entry) => entry.command === Commands.updateImagesNow)).toEqual({
      command: Commands.updateImagesNow,
      when: 'view == devspaces.repositories',
      group: '2_maintenance@1',
    });
  });
});

describe('the call of the window to the worker (workerMonitor.monitorRunNow)', () => {
  function monitorWith(answer: () => unknown) {
    const calls: Parameters<TargetFlow>[] = [];
    const flow: TargetFlow = async (...args) => {
      calls.push(args);
      const value = answer();
      if (value instanceof Error) throw value;
      return value;
    };
    return { monitor: workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger: silentLogger }), calls };
  }

  it('sends the monitor settings of this computer to the worker of the engine, within its time limit, with the signal', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ requested: true }));
    await expect(monitor.monitorRunNow(REMOTE, IMAGES, signal)).resolves.toBeUndefined();
    expect(calls).toEqual([[OP_MONITOR_RUN_NOW, { images: IMAGES }, { target: REMOTE, timeoutMs: MONITOR_RUN_NOW_FLOW_TIMEOUT_MS, signal }]]);
    // The ensure of the monitor and one command in it.
    expect(MONITOR_RUN_NOW_FLOW_TIMEOUT_MS).toBeGreaterThan(MONITOR_ENSURE_FLOW_TIMEOUT_MS);
  });

  it('rejects a failure, an answer that is not exactly { requested: true }, and settings beyond the checks', async () => {
    await expect(monitorWith(() => new Error('docker exec failed')).monitor.monitorRunNow(REMOTE, IMAGES)).rejects.toThrow('docker exec failed');
    for (const answer of [{ requested: false }, { requested: true, extra: 1 }, {}, null, 'yes']) {
      await expect(monitorWith(() => answer).monitor.monitorRunNow(REMOTE, IMAGES), JSON.stringify(answer)).rejects.toThrow('invalid value');
    }
    const invalid = monitorWith(() => ({ requested: true }));
    await expect(invalid.monitor.monitorRunNow(REMOTE, { ...IMAGES, schedule: 'daily' })).rejects.toThrow('cannot be sent');
    expect(invalid.calls).toEqual([]);
  });
});

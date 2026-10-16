// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The devspace of the window at its activation, with the restore of a lost registry by the worker within
// WINDOW_RESTORE_TIMEOUT_MS, and the restore again after the build of the helper image.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { resourceName } from '../core/names';
import { WINDOW_RESTORE_TIMEOUT_MS, backgroundWorkAtStart, findWindowDevspace, restoreAfterPrebuild, windowDevspaceName } from './windowDevspace';

const ENTRY = { id: 'e1', containerName: 'devspaces-acme-api-x' } as Devspace;

function deps(options: { found?: Devspace[]; needsRestore?: boolean; installed?: boolean; added?: number | Error } = {}) {
  const found = [...(options.found ?? [])];
  const errors: string[] = [];
  const warnings: string[] = [];
  const all = {
    registry: { findByContainerName: vi.fn(async () => found.shift()) },
    needsRestore: vi.fn(async () => options.needsRestore ?? true),
    docker: { isInstalled: () => options.installed ?? true },
    service: {
      reconcileInWorker: vi.fn(async (_options: { passive: boolean; signal?: AbortSignal }) => {
        if (options.added instanceof Error) throw options.added;
        return options.added ?? 0;
      }),
    },
    logger: { ...silentLogger, error: (text: string) => errors.push(text), warn: (text: string) => warnings.push(text) },
  };
  return { all, errors, warnings };
}

describe('the devspace of the window at its activation', () => {
  it('the registry knows it: no restore', async () => {
    const { all } = deps({ found: [ENTRY] });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    expect(all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('a lost registry is restored by the worker, passively and within the time limit of the activation', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
    const [options] = all.service.reconcileInWorker.mock.calls[0];
    expect(options.passive).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(WINDOW_RESTORE_TIMEOUT_MS).toBe(30_000);
  });

  it('nothing restored, a valid registry, or no Docker: no devspace', async () => {
    const none = deps({ added: 0 });
    expect(await findWindowDevspace('c', none.all)).toBeUndefined();
    // Read again also when nothing was added.
    expect(none.all.registry.findByContainerName).toHaveBeenCalledTimes(2);
    const valid = deps({ needsRestore: false });
    expect(await findWindowDevspace('c', valid.all)).toBeUndefined();
    expect(valid.all.service.reconcileInWorker).not.toHaveBeenCalled();
    const noDocker = deps({ installed: false });
    expect(await findWindowDevspace('c', noDocker.all)).toBeUndefined();
    expect(noDocker.all.service.reconcileInWorker).not.toHaveBeenCalled();
  });

  it('restores nothing when the activation may not (before the first use of Devspaces)', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('other-container', { ...all, mayRestore: false })).toBeUndefined();
    expect(all.needsRestore).not.toHaveBeenCalled();
    expect(all.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(1);
    // The registry is still read: a known container is found.
    const known = deps({ found: [ENTRY] });
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...known.all, mayRestore: false })).toBe(ENTRY);
    // `mayRestore` true restores, as when it is not given.
    const allowed = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 1 });
    expect(await findWindowDevspace('devspaces-acme-api-x', { ...allowed.all, mayRestore: true })).toBe(ENTRY);
    expect(allowed.all.service.reconcileInWorker).toHaveBeenCalledTimes(1);
  });

  it('does the Docker work at the start after the first use, and in the window of a devspace container', () => {
    expect(backgroundWorkAtStart(true, undefined)).toBe(true);
    expect(backgroundWorkAtStart(true, 'my-dev-container')).toBe(true);
    // Before the first use: only a container of a devspace, also one of a Docker Compose service, in any case.
    expect(backgroundWorkAtStart(false, undefined)).toBe(false);
    expect(backgroundWorkAtStart(false, 'my-dev-container')).toBe(false);
    expect(backgroundWorkAtStart(false, 'vsc-api-0123456789abcdef')).toBe(false);
    expect(backgroundWorkAtStart(false, resourceName('acme/api', '11111111-2222-4333-8444-555555555555', 'default'))).toBe(true);
    expect(backgroundWorkAtStart(false, 'devspaces-majikmate-module-html-css-2-x-app-1')).toBe(true);
    expect(backgroundWorkAtStart(false, 'Devspaces-Acme-Api-x')).toBe(true);
    expect(backgroundWorkAtStart(false, 'my-devspaces-x')).toBe(false);
  });

  it('a restore that fails or times out never fails the activation (logged)', async () => {
    const { all, errors, warnings } = deps({ added: new Error('The operation was aborted due to timeout') });
    expect(await findWindowDevspace('c', all)).toBeUndefined();
    // A failed restore is a warning, and the registry is read again.
    expect(errors).toEqual([]);
    expect(warnings).toEqual(['The devspaces could not be restored from the volumes while this window started: The operation was aborted due to timeout']);
    expect(all.registry.findByContainerName).toHaveBeenCalledTimes(2);
  });

  it('finds the entry that the restore added before its time limit ended', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: new Error('The operation was aborted due to timeout') });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
  });

  it('finds the entry that another window restored first, when this restore added none', async () => {
    const { all } = deps({ found: [undefined as unknown as Devspace, ENTRY], added: 0 });
    expect(await findWindowDevspace('devspaces-acme-api-x', all)).toBe(ENTRY);
  });

  it('an unreadable registry never fails the activation (logged)', async () => {
    const { all, errors } = deps();
    all.registry.findByContainerName.mockRejectedValue(new Error('EACCES'));
    expect(await findWindowDevspace('c', all)).toBeUndefined();
    expect(errors).toEqual(['The devspace of this window could not be found.']);
  });

  it('the restore runs again once the background preparation ended with a helper image', async () => {
    for (const outcome of ['unsupported', 'dockerNotRunning', 'failed', 'cancelled'] as const) {
      const restore = vi.fn(async () => {});
      await restoreAfterPrebuild(outcome, restore);
      expect(restore, outcome).not.toHaveBeenCalled();
    }
    // Also `present` and `notDue`, not only `built`.
    for (const outcome of ['built', 'present', 'notDue'] as const) {
      const restore = vi.fn(async () => {});
      await restoreAfterPrebuild(outcome, restore);
      expect(restore, outcome).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the name of the devspace of the window, for the names of its workers', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  // A Docker Compose devspace of the configuration `python`: its container is named by Compose, its volume is its
  // resource name.
  const devspace = {
    id: ID,
    repository: 'majikmate/module-html-css-2',
    volumeName: resourceName('majikmate/module-html-css-2', ID, 'python'),
    containerName: 'devspaces-majikmate-module-html-css-2-x-app-1',
  } as Devspace;
  const remote = { ...devspace, dockerHost: 'build-box' } as Devspace;
  const old = { ...devspace, volumeName: resourceName('majikmate/module-html-css-2', ID), containerName: resourceName('majikmate/module-html-css-2', ID) } as Devspace;

  it('is the resource name of the devspace of the attached container on its engine (with the word of its source), also of Docker Compose', async () => {
    const registry = { findByContainerName: vi.fn(async () => devspace) };
    expect(await windowDevspaceName(devspace.containerName, '', registry)).toBe(resourceName(devspace.repository, ID, 'python'));
    expect(registry.findByContainerName).toHaveBeenCalledWith(devspace.containerName);
    expect(await windowDevspaceName(remote.containerName, 'build-box', { findByContainerName: async () => remote })).toBe(resourceName(devspace.repository, ID, 'python'));
    // A devspace of version 0.5.0 or older: its name has no word of its source.
    expect(await windowDevspaceName(old.containerName, '', { findByContainerName: async () => old })).toBe(resourceName(devspace.repository, ID));
  });

  it('is undefined on another engine, for a window of no container, and for a container that the registry does not know', async () => {
    expect(await windowDevspaceName(devspace.containerName, 'build-box', { findByContainerName: async () => devspace })).toBeUndefined();
    expect(await windowDevspaceName(remote.containerName, '', { findByContainerName: async () => remote })).toBeUndefined();
    const registry = { findByContainerName: vi.fn(async () => undefined) };
    expect(await windowDevspaceName(undefined, '', registry)).toBeUndefined();
    expect(registry.findByContainerName).not.toHaveBeenCalled();
    expect(await windowDevspaceName('other', '', registry)).toBeUndefined();
  });
});

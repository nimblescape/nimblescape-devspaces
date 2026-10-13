// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { dockerTargetOf, LOCAL_DOCKER_TARGET } from '../core/docker/dockerHost';
import { silentLogger } from '../core/ports';
import { DockerHostIndicator, DockerHostTexts } from './dockerHostIndicator';
import type { ShownDockerHost } from './treeView';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

// The sidebar indicates the Docker host, a remote host as well as the local Docker.
describe('DockerHostIndicator', () => {
  beforeEach(() => resetFakeVscode());

  it('shows the remote host next to the view name and in the title', () => {
    const view: { description?: string; title?: string } = {};
    new DockerHostIndicator(view, silentLogger).update(dockerTargetOf('ssh://machines', 'devspace-remote-5709ff28'));
    expect(view.description).toBe(DockerHostTexts.remote('machines'));
    expect(view.description).toBe('Remote: machines');
    // The merged header of the single view shows the title, not the description.
    expect(view.title).toBe('machines (remote)');
  });

  // The title names the local Docker too, and an endpoint that is not supported.
  it('names the local Docker and an endpoint that is not supported in the title', () => {
    const view: { description?: string; title?: string } = { description: 'Remote: machines', title: 'machines (remote)' };
    const indicator = new DockerHostIndicator(view, silentLogger);
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(view.description).toBeUndefined();
    expect(view.title).toBe('Local Docker');
    indicator.update(dockerTargetOf('tcp://192.0.2.10:2376', 'other'));
    expect(view.description).toBeUndefined();
    expect(view.title).toBe('tcp://192.0.2.10:2376 (not supported)');
  });

  // Without a Docker CLI the target reads as the local Docker; the header then names no Docker host (not "Local Docker"
  // above the Docker setup), and the list has no host row.
  it('names no Docker host while no Docker CLI is found, and names it again once one is', () => {
    const view: { description?: string; title?: string } = {};
    const rows: Array<ShownDockerHost | undefined> = [];
    const indicator = new DockerHostIndicator(view, silentLogger, (host) => rows.push(host));
    indicator.update(LOCAL_DOCKER_TARGET, false);
    expect(view.title).toBe('Devspaces');
    expect(view.description).toBeUndefined();
    indicator.update(LOCAL_DOCKER_TARGET, false);
    indicator.update(LOCAL_DOCKER_TARGET, true);
    expect(view.title).toBe('Local Docker');
    expect(rows).toEqual([undefined, { kind: 'local', host: '' }]);
  });

  // The title bar has no icon for the Docker host, so no context key is set for one.
  it('sets no context key', () => {
    new DockerHostIndicator({}, silentLogger).update(dockerTargetOf('ssh://machines', 'a'));
    expect(fakeVscode.commands.executeCommand.mock.calls.filter((call: unknown[]) => call[0] === 'setContext')).toEqual([]);
  });

  // The first row of the list names the Docker host, the local Docker too (the merged header does not show it in every
  // window).
  it('gives the list the Docker host for its first row, and only when it changed', () => {
    const rows: Array<ShownDockerHost | undefined> = [];
    const indicator = new DockerHostIndicator({}, silentLogger, (host) => rows.push(host));
    indicator.update(dockerTargetOf('ssh://htldvmhn', 'devspace-remote-2e9f507b'));
    indicator.update(dockerTargetOf('ssh://htldvmhn', 'devspace-remote-2e9f507b'));
    indicator.update(dockerTargetOf('ssh://machines', 'devspace-remote-5709ff28'));
    indicator.update(LOCAL_DOCKER_TARGET);
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(rows).toEqual([
      { kind: 'remote', host: 'htldvmhn' },
      { kind: 'remote', host: 'machines' },
      { kind: 'local', host: '' },
    ]);
  });

  it('the view name of package.json is "Devspaces" (the title names the Docker host)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { views: { devspaces: Array<{ id: string; name: string }> } };
    };
    expect(manifest.contributes.views.devspaces[0].name).toBe('Devspaces');
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests in the window of a container that is no devspace (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=plain), as after "Attach to Running Container" of Dev Containers. The extension activates for
// every attached container and blocks the connection while it activates; with an empty registry it first restores the
// devspaces from the volumes (up to WINDOW_RESTORE_TIMEOUT_MS). The container has the dev image of the devspace, so the
// checks of the credentials see here what Dev Containers sets up without the settings of the override.
import * as assert from 'assert';
import { LABEL_PREFIX } from '../../../src/core/names';
import { WINDOW_RESTORE_TIMEOUT_MS } from '../../../src/vscode/windowDevspace';
import { channelLog, connectedFolder, credentialPaths, docker, printLogs, seed } from './support';

describe('the window of a container that is no devspace', () => {
  const { containerName, user } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('connects without waiting for the restore of the registry', async () => {
    await connectedFolder();
    // The tests start once the window has connected, so the age of the extension host is the time of the connection.
    const seconds = process.uptime();
    console.log(`    connected ${seconds.toFixed(1)} s after the start of the extension host`);
    assert.ok(seconds * 1000 < WINDOW_RESTORE_TIMEOUT_MS, `${seconds} s`);
  });

  it('leaves the container as it is', () => {
    const labels = JSON.parse(docker(['inspect', '-f', '{{json .Config.Labels}}', containerName])) as Record<string, string> | null;
    assert.deepStrictEqual(Object.keys(labels ?? {}).filter((key) => key.startsWith(LABEL_PREFIX)), []);
    assert.doesNotMatch(channelLog('Devspaces'), new RegExp(containerName));
  });

  it('shows the ways that Dev Containers opens to the runner without the override', () => {
    // The control of the devspace test: the same checks find the features of Dev Containers here.
    const paths = credentialPaths(user);
    console.log(`    ways from the plain container to the runner: ${JSON.stringify(paths)}`);
    assert.strictEqual(paths.gitConfigOfRunner, true, 'Dev Containers copied no Git configuration of the runner');
    assert.strictEqual(paths.gitCredentialHelper, true, 'Dev Containers configured no Git credential helper');
  });
});

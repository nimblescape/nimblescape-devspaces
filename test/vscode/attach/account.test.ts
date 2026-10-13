// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a devspace window under another GitHub account (.vscode-test.mjs, label attach,
// DEVSPACE_TEST_ATTACH=account): VS Code starts again in the window of the devspace with the user data folder of the
// devspace run, but the fake sign-in provider (test/vscode/github) answers with another account than the owner of the
// devspace, as after a sign-out and a sign-in with another account. The extension then runs no open pipeline and
// closes the remote connection of the window (src/vscode/controller.ts, ownWindowDevspace), which reloads the window
// as a local window without a folder, and the tests run in that window. Assumption of ownWindowDevspace: a container
// that still runs is closed right after the connection. The token of the owner leaves the container.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GH_HOSTS_FILE, GITHUB_TOKEN_FILE } from '../../../src/core/names';
import { channelLog, docker, execIn, printLogs, seed, waitFor } from './support';

describe('the window of a devspace under another GitHub account', () => {
  const { containerName, user } = seed();
  let failed = false;

  before(async function () {
    // The tests started in the attached window, before the extension closed its remote connection: the reload ends
    // this extension host, and the tests run again in the local window. Only that run counts.
    if (vscode.env.remoteName !== 'attached-container') return;
    this.timeout(90_000);
    console.log('    the tests started in the attached window; waiting for the window to close its remote connection');
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    assert.fail('The window kept its remote connection to the devspace of another account');
  });

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('closed its remote connection without running the open pipeline', () => {
    assert.strictEqual(vscode.env.remoteName, undefined, 'The window is still a remote window');
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'The window still has a folder');
    const log = channelLog('Devspaces');
    assert.match(log, /This window is attached to a devspace of another GitHub account\. It closes its remote connection\./);
    assert.match(log, /Closing the remote connection of this window\./);
    assert.doesNotMatch(log, /The open pipeline of devspaces-test\/attach runs before it connects\./);
    assert.doesNotMatch(log, /devspaces-test\/attach is ready in the container /);
  });

  it('leaves the container running for its owner', () => {
    // Only the Monitor stops it, after the waiting time of the release.
    assert.strictEqual(docker(['inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
  });

  it('removed the token of the owner from the container', async () => {
    // The removal runs in the worker of the engine (tokenRemove), started before the window closes its connection.
    await waitFor('the removal of the token', () => (execIn(user, `test -e ${GITHUB_TOKEN_FILE}`).code === 0 ? undefined : true), 60_000);
    assert.notStrictEqual(execIn(user, `test -e ${GH_HOSTS_FILE}`).code, 0, 'The sign-in of the GitHub CLI is still in the container');
    const log = channelLog('Devspaces');
    assert.doesNotMatch(log, /The GitHub token could not be removed/);
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a devspace window whose container stops while the window is attached (.vscode-test.mjs, label
// attach, DEVSPACE_TEST_ATTACH=stopped): VS Code starts again in the window of the devspace, and the test stops the
// container from outside, as the Monitor or a user with `docker stop` does. The window checks its container with each
// heartbeat (src/vscode/controller.ts, checkConnection) and shows "Reconnect" when it does not run.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { channelLog, connectedFolder, docker, printLogs, seed } from './support';

/** The longest time from the stop to the log line of the window: three heartbeats of 15 seconds. */
const NOTICE_WAIT_MS = 45_000;
/** How long the test watches the container and the window after the stop. */
const WATCH_MS = 90_000;

describe('the window of a devspace whose container stops', () => {
  const { containerName } = seed();
  let failed = false;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  it('notices that its container stopped', async function () {
    this.timeout(WATCH_MS + 60_000);
    const folder = await connectedFolder();
    const devspacesBefore = channelLog('Devspaces').length;
    const devContainersBefore = channelLog('Dev Containers').length;
    const stoppedAt = Date.now();
    docker(['stop', containerName]);
    const seconds = (): string => ((Date.now() - stoppedAt) / 1000).toFixed(0);
    const states: string[] = [];
    let last = '';
    let noticedAt: string | undefined;
    while (Date.now() - stoppedAt < WATCH_MS) {
      const state = docker(['inspect', '-f', '{{.State.Status}} started {{.State.StartedAt}}', containerName]).trim();
      if (state !== last) states.push(`${seconds()} s: ${state}`);
      last = state;
      if (noticedAt === undefined && /The container of devspaces-test\/attach does not run\./.test(channelLog('Devspaces').slice(devspacesBefore))) noticedAt = seconds();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // What the remote file system of the window answers now.
    const stat = await Promise.race([
      vscode.workspace.fs.stat(folder).then(
        () => 'answers',
        (error: unknown) => `fails: ${String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('no answer in 10 s'), 10_000)),
    ]);
    console.log(`    container after the stop: ${states.join('; ')}`);
    console.log(`    the window noticed the stop after ${noticedAt ?? '(never)'} s; its folder ${stat}; remoteName ${vscode.env.remoteName}`);
    console.log(`    Devspaces log after the stop:\n${channelLog('Devspaces').slice(devspacesBefore)}`);
    console.log(`    Dev Containers log after the stop:\n${channelLog('Dev Containers').slice(devContainersBefore)}`);
    assert.ok(noticedAt !== undefined && Number(noticedAt) * 1000 <= NOTICE_WAIT_MS, `The window did not log within ${NOTICE_WAIT_MS / 1000} s that its container does not run`);
  });
});

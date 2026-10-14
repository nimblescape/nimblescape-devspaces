// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a devspace window whose container stops while the window is attached (.vscode-test.mjs, label
// attach, DEVSPACE_TEST_ATTACH=stopped). The tests cannot run in that window: when its remote connection drops, VS Code
// cancels the test run of the window (PR #18). So VS Code starts with a local folder (the user data folder of the
// earlier runs), and the tests open the devspace in a second window, stop its container from outside (as the Monitor
// or a user with `docker stop` does), and read the log of the second window. The second window checks its container
// with each heartbeat (src/vscode/controller.ts, checkConnection) and shows "Reconnect" when it does not run. A Start
// of the devspace in the first window then starts the container, and the second window connects again (startTarget:
// "The connection of the other window is lost; the devspace starts").
import * as assert from 'assert';
import * as vscode from 'vscode';
import { channelLog, channelLogByWindow, docker, execIn, printLogs, seed, waitFor } from './support';

/** Three heartbeats of 15 seconds: the longest time from a change of the container to the log of the window. */
const NOTICE_WAIT_MS = 45_000;
/** How long the tests watch the container after the stop: whether something else starts it again. */
const WATCH_MS = 60_000;

describe('a devspace window whose container stops', () => {
  const { containerName, user, folderUri, devspaceId } = seed();
  let failed = false;
  /** The log folder of the second window (for example `window2`). */
  let second = '';

  // VS Code may run the tests in the second window too. That run only keeps VS Code open until the first one ends.
  if (vscode.env.remoteName !== undefined) {
    it('(the second window runs the tests too, and waits)', async function () {
      this.timeout(330_000);
      console.log('    the tests started in the second window too; this run waits');
      await new Promise((resolve) => setTimeout(resolve, 300_000));
    });
    return;
  }

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(() => {
    if (failed) printLogs();
  });

  /** The lines that postAttachCommand wrote: one per attach of a window. */
  function attaches(): number {
    return Number(execIn(user, 'if [ -f /tmp/attach-count ]; then wc -l < /tmp/attach-count; else echo 0; fi').out);
  }

  /** The Devspaces log of the second window from position `from` on. */
  function secondLog(from = 0): string {
    return (channelLogByWindow('Devspaces').get(second) ?? '').slice(from);
  }

  it('opens the devspace in a second window, which attaches', async function () {
    this.timeout(240_000);
    assert.ok(devspaceId, 'The seed has no devspace ID');
    const windowsBefore = new Set(channelLogByWindow('Devspaces').keys());
    const before = attaches();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(folderUri), { forceNewWindow: true });
    await waitFor('the attach of the second window', () => (attaches() > before ? true : undefined), 180_000);
    second = await waitFor('the log of the second window', () => [...channelLogByWindow('Devspaces').keys()].find((window) => !windowsBefore.has(window)), 30_000);
    console.log(`    the second window logs to ${second}; attaches ${before} -> ${attaches()}`);
    assert.strictEqual(vscode.env.remoteName, undefined, 'The first window became a remote window');
  });

  it('the second window notices that its container stopped', async function () {
    this.timeout(WATCH_MS + NOTICE_WAIT_MS + 30_000);
    assert.ok(second, 'No second window');
    const from = secondLog().length;
    const stoppedAt = Date.now();
    docker(['stop', containerName]);
    const seconds = (): number => Math.round((Date.now() - stoppedAt) / 1000);
    const states: string[] = [];
    let last = '';
    let noticedAt: number | undefined;
    while (Date.now() - stoppedAt < WATCH_MS || (noticedAt === undefined && Date.now() - stoppedAt < NOTICE_WAIT_MS + 15_000)) {
      const state = docker(['inspect', '-f', '{{.State.Status}} since {{.State.StartedAt}}', containerName]).trim();
      if (state !== last) states.push(`${seconds()} s: ${state}`);
      last = state;
      if (noticedAt === undefined && /The container of devspaces-test\/attach does not run\./.test(secondLog(from))) noticedAt = seconds();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.log(`    the container after the stop: ${states.join('; ')}`);
    console.log(`    the second window logged after ${noticedAt ?? '(never)'} s that its container does not run`);
    console.log(`    the log of the second window after the stop:\n${secondLog(from)}`);
    assert.ok(noticedAt !== undefined, 'The second window did not log that its container does not run');
    assert.ok(noticedAt * 1000 <= NOTICE_WAIT_MS + 5_000, `The second window logged it only after ${noticedAt} s`);
    assert.strictEqual(docker(['inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'exited', 'Something started the container again');
  });

  it('a Start in the first window starts the container, and the second window connects again', async function () {
    this.timeout(240_000);
    assert.ok(second, 'No second window');
    const from = secondLog().length;
    const firstFrom = channelLog('Devspaces').length;
    const before = attaches();
    await vscode.commands.executeCommand('devspaces.start', { devspaceId });
    const firstLog = channelLog('Devspaces').slice(firstFrom);
    console.log(`    the log of the first window after the Start:\n${firstLog}`);
    assert.match(firstLog, /The container of devspaces-test\/attach does not run\. The connection of the other window is lost; the devspace starts\./);
    assert.strictEqual(docker(['inspect', '-f', '{{.State.Status}}', containerName]).trim(), 'running');
    await waitFor('the log of the second window that its container runs again', () => (/The container of devspaces-test\/attach runs again\./.test(secondLog(from)) ? true : undefined), NOTICE_WAIT_MS + 15_000);
    console.log(`    the log of the second window after the Start:\n${secondLog(from)}`);
    console.log(`    attaches ${before} -> ${attaches()}`);
    assert.strictEqual(vscode.env.remoteName, undefined, 'The first window became a remote window');
  });
});

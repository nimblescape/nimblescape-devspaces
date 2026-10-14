// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Attach tests of a devspace window whose container stops or is removed while the window is attached (.vscode-test.mjs,
// label attach, DEVSPACE_TEST_ATTACH=stopped). The tests cannot run in that window: when its remote connection drops,
// VS Code cancels the test run (PR #18), and a window that the test VS Code opens runs the tests too. So the test VS Code
// has a local folder, and the tests start a second VS Code (DEVSPACE_TEST_SECOND_VSCODE: its own user data folder, the
// extensions of the test VS Code, no tests) in the window of the devspace, as a user starts VS Code. They stop or remove
// the container from outside (as the Monitor, or a user with `docker stop` or `docker rm -f`), read the log of the
// second VS Code, and start it again as the next reload of the window. The window checks its container with each
// heartbeat (src/vscode/controller.ts, checkConnection) and then shows Reconnect in the status bar.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { channelLog, docker, execIn, printLogs, seed, sessionLogs, waitFor } from './support';

/** The second VS Code (.vscode-test.mjs): its user data folder, the extensions folder of the test VS Code, its arguments. */
interface SecondVscode {
  userDataDir: string;
  extensionsDir: string;
  args: string[];
}

function secondVscode(): SecondVscode {
  const value = process.env.DEVSPACE_TEST_SECOND_VSCODE;
  assert.ok(value, 'DEVSPACE_TEST_SECOND_VSCODE is not set (.vscode-test.mjs)');
  return JSON.parse(value) as SecondVscode;
}

/** Three heartbeats of 15 seconds: the longest time from a change of the container to the log of the window. */
const NOTICE_WAIT_MS = 45_000;
/** How long the tests watch the container after the stop: whether something starts it again. */
const WATCH_MS = 60_000;
/** The longest time from the start of the second VS Code to the attach of its window (with the open pipeline). */
const ATTACH_WAIT_MS = 300_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a devspace window whose container stops or is removed', () => {
  const { containerName, user } = seed();
  const second = secondVscode();
  const repository = 'devspaces-test/attach';
  let running: childProcess.ChildProcess | undefined;
  let starts = 0;
  let failed = false;
  /** The lines of postAttachCommand when the container stopped. */
  let attachesAtStop = 0;

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true;
  });

  after(async function () {
    this.timeout(60_000);
    await quitSecond();
    if (!failed) return;
    printLogs();
    console.log('\n===== the second VS Code =====');
    printLogs(second.userDataDir);
    for (const [name, text] of sessionLogs(second.userDataDir)) if (!/output_logging_/.test(name)) console.log(`\n===== ${name} =====\n${text}`);
    for (let start = 1; start <= starts; start++) console.log(`\n===== output of start ${start} =====\n${readOutput(start)}`);
  });

  /** The state of the container: `running`, `exited`, … or `missing`. */
  function containerState(): string {
    const result = childProcess.spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', containerName], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : 'missing';
  }

  /** The lines that postAttachCommand wrote: one per attach of a window; -1 while the container does not run. */
  function attaches(): number {
    const result = execIn(user, 'if [ -f /tmp/attach-count ]; then wc -l < /tmp/attach-count; else echo 0; fi');
    return result.code === 0 ? Number(result.out) : -1;
  }

  /** The Devspaces log of the last start of the second VS Code from position `from` on. */
  function secondLog(from = 0): string {
    return channelLog('Devspaces', second.userDataDir).slice(from);
  }

  /** The lines of the renderer log of the second VS Code about its remote connection. */
  function connectionLines(): string {
    const renderer = [...sessionLogs(second.userDataDir)].find(([name]) => /^window\d+[\\/]renderer\.log$/.test(name))?.[1] ?? '';
    return renderer
      .split('\n')
      .filter((line) => /remote|reconnect|connection|resolv/i.test(line))
      .join('\n');
  }

  function readOutput(start: number): string {
    const file = path.join(second.userDataDir, `output-${start}.txt`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  /**
   * Starts the second VS Code in the window of the devspace, in a process group of its own. Without the variables of the
   * test VS Code (VSCODE_*, ELECTRON_*), so that it starts as a VS Code of its own and not as a Node.js process.
   */
  function startSecond(): void {
    starts += 1;
    fs.mkdirSync(second.userDataDir, { recursive: true });
    const output = fs.openSync(path.join(second.userDataDir, `output-${starts}.txt`), 'w');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|VSCODE_|DEVSPACE_TEST_)/.test(key)));
    running = childProcess.spawn(process.execPath, second.args, { env, detached: true, stdio: ['ignore', output, output] });
    fs.closeSync(output);
    running.unref();
  }

  /** Quits the second VS Code (SIGTERM to its process group, SIGKILL after 20 seconds), as a user quits VS Code. */
  async function quitSecond(): Promise<void> {
    const child = running;
    running = undefined;
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
    const signal = (name: NodeJS.Signals): void => {
      try {
        process.kill(-pid, name);
      } catch {
        // The process group has ended.
      }
    };
    signal('SIGTERM');
    if (!(await Promise.race([exited, sleep(20_000).then(() => false)]))) {
      signal('SIGKILL');
      await Promise.race([exited, sleep(10_000)]);
    }
    // The other processes of the group (the extension host, the shared process) end after the main process.
    signal('SIGKILL');
  }

  /** Starts the second VS Code and waits until its window attached: postAttachCommand wrote one more line. */
  async function startAndAttach(before: number): Promise<void> {
    const startedAt = Date.now();
    startSecond();
    try {
      await waitFor('the attach of the window of the second VS Code', () => (attaches() > before ? true : undefined), ATTACH_WAIT_MS);
    } finally {
      console.log(`    start ${starts} of the second VS Code: attaches ${before} -> ${attaches()} after ${Math.round((Date.now() - startedAt) / 1000)} s`);
    }
  }

  /**
   * Watches the container and the log of the window after a stop or a removal: the states of the container, and when the
   * window logged that its container does not run.
   */
  async function watchAfter(change: string, from: number): Promise<number | undefined> {
    const changedAt = Date.now();
    const seconds = (): number => Math.round((Date.now() - changedAt) / 1000);
    const states: string[] = [];
    let last = '';
    let noticedAt: number | undefined;
    while (Date.now() - changedAt < WATCH_MS || (noticedAt === undefined && Date.now() - changedAt < NOTICE_WAIT_MS + 15_000)) {
      const state = containerState();
      if (state !== last) states.push(`${seconds()} s: ${state}`);
      last = state;
      if (noticedAt === undefined && secondLog(from).includes(`The container of ${repository} does not run.`)) noticedAt = seconds();
      await sleep(1_000);
    }
    console.log(`    the container after the ${change}: ${states.join('; ')}`);
    console.log(`    the window logged after ${noticedAt ?? '(never)'} s that its container does not run`);
    console.log(`    the log of the window after the ${change}:\n${secondLog(from)}`);
    console.log(`    the remote connection of the window:\n${connectionLines()}`);
    return noticedAt;
  }

  it('a second VS Code opens the window of the devspace, which attaches', async function () {
    this.timeout(ATTACH_WAIT_MS + 60_000);
    console.log(`    the second VS Code: ${process.execPath} ${second.args.join(' ')}`);
    assert.ok(
      fs.existsSync(second.extensionsDir) && fs.readdirSync(second.extensionsDir).some((name) => name.startsWith('ms-vscode-remote.remote-containers-')),
      `${second.extensionsDir} has no Dev Containers extension`,
    );
    assert.strictEqual(containerState(), 'running', 'The devspace does not run after the earlier runs');
    await startAndAttach(attaches());
    // One heartbeat after the attach, so that the window knows its container as running.
    await sleep(20_000);
    console.log(`    the log of the window:\n${secondLog()}`);
    assert.match(secondLog(), new RegExp(`This window is connected to ${repository}\\.|The open pipeline of ${repository} runs before it connects\\.`));
  });

  it('the window notices that its container stopped, and nothing starts it again', async function () {
    this.timeout(WATCH_MS + NOTICE_WAIT_MS + 60_000);
    assert.ok(running, 'The second VS Code does not run');
    const from = secondLog().length;
    attachesAtStop = attaches();
    docker(['stop', containerName]);
    const noticedAt = await watchAfter('stop', from);
    assert.ok(noticedAt !== undefined, 'The window did not log that its container does not run');
    assert.ok(noticedAt * 1000 <= NOTICE_WAIT_MS + 5_000, `The window logged it only after ${noticedAt} s`);
    assert.strictEqual(containerState(), 'exited', 'Something started the container again');
  });

  it('at the next start of the window, the container runs again and the window attaches', async function () {
    this.timeout(ATTACH_WAIT_MS + 90_000);
    await quitSecond();
    assert.strictEqual(containerState(), 'exited');
    const id = docker(['inspect', '-f', '{{.Id}}', containerName]).trim();
    // The container does not run, so its lines are the ones at the stop.
    await startAndAttach(attachesAtStop);
    await sleep(20_000);
    console.log(`    the log of the window:\n${secondLog()}`);
    console.log(`    the remote connection of the window:\n${connectionLines()}`);
    assert.strictEqual(containerState(), 'running');
    assert.strictEqual(docker(['inspect', '-f', '{{.Id}}', containerName]).trim(), id, 'The start made a new container');
  });

  it('the window notices that its container was removed, and its next start makes the container again', async function () {
    this.timeout(WATCH_MS + NOTICE_WAIT_MS + ATTACH_WAIT_MS + 120_000);
    assert.ok(running, 'The second VS Code does not run');
    const id = docker(['inspect', '-f', '{{.Id}}', containerName]).trim();
    const from = secondLog().length;
    docker(['rm', '-f', containerName]);
    const noticedAt = await watchAfter('removal', from);
    await quitSecond();
    // A new container starts without the lines of the old one.
    await startAndAttach(0);
    await sleep(20_000);
    console.log(`    the log of the window:\n${secondLog()}`);
    console.log(`    the remote connection of the window:\n${connectionLines()}`);
    assert.ok(noticedAt !== undefined, 'The window did not log that its container does not run');
    assert.strictEqual(containerState(), 'running');
    assert.notStrictEqual(docker(['inspect', '-f', '{{.Id}}', containerName]).trim(), id, 'The container is the removed one');
  });
});

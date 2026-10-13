// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Spike of the attach tests (plan step 2a; .vscode-test.mjs, label attach): VS Code starts in the window of a container
// (--folder-uri, as a restored window), and mocha runs these tests in the local extension host of that window, beside
// the Devspaces extension (extensionKind ui). DEVSPACE_TEST_ATTACH names the container of prepare.ts: `devspace` (a
// devspace that the window restores from its volume labels) or `plain` (a container that is no devspace). The tests
// print the logs, because the spike reports what happened.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';
/** The longest wait for the connection: the open pipeline of a restored devspace creates its container first. */
const CONNECT_WAIT_MS = 300_000;

interface Seed {
  containerName: string;
  folder: string;
  folderUri: string;
}

const kind = process.env.DEVSPACE_TEST_ATTACH;
const seed = JSON.parse(process.env.DEVSPACE_TEST_ATTACH_SEED ?? '{}') as Seed;
const startedAt = Date.now();

describe(`a window of a container (${kind})`, () => {
  after(() => {
    // The evidence of the spike: every output channel of this start, and the containers of the engine.
    const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
    if (userDataDir) {
      for (const file of outputLogs(path.join(userDataDir, 'logs'))) {
        console.log(`\n===== ${path.relative(userDataDir, file)} =====\n${fs.readFileSync(file, 'utf8')}`);
      }
    }
    console.log(`\n===== docker ps -a =====\n${docker(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'])}`);
  });

  it('connects to the container', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folder, 'The window has no folder');
    console.log(`    folder ${folder.toString()}, remote name ${vscode.env.remoteName}`);
    assert.strictEqual(folder.toString(), vscode.Uri.parse(seed.folderUri).toString());
    let lastError = '';
    for (;;) {
      try {
        await vscode.workspace.fs.stat(folder);
        break;
      } catch (error) {
        lastError = String(error);
      }
      if (Date.now() - startedAt > CONNECT_WAIT_MS) assert.fail(`The folder was not readable after ${CONNECT_WAIT_MS / 1000} s: ${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.log(`    connected ${((Date.now() - startedAt) / 1000).toFixed(0)} s after the start of the tests`);
    assert.strictEqual(vscode.env.remoteName, 'attached-container');
    const entries = await vscode.workspace.fs.readDirectory(folder);
    console.log(`    entries of the folder: ${entries.map(([name]) => name).join(', ')}`);
  });

  it('runs the Devspaces extension in the local extension host', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded`);
    await extension.activate();
    assert.strictEqual(extension.extensionKind, vscode.ExtensionKind.UI);
  });

  it('gets the session of the fake GitHub sign-in provider', async () => {
    // The tests run without the identity of an extension of their own; this only shows that the provider answers.
    const session = await vscode.authentication.getSession('github', ['read:org', 'repo'], { silent: true }).then(
      (value) => value,
      (error: unknown) => `error: ${String(error)}`,
    );
    console.log(`    session: ${typeof session === 'string' ? session : JSON.stringify(session?.account)}`);
  });

  it('shows the container of the devspace running', function () {
    if (kind !== 'devspace') this.skip();
    const state = docker(['inspect', '-f', '{{.State.Status}}', seed.containerName]).trim();
    assert.strictEqual(state, 'running');
  });
});

function docker(args: string[]): string {
  const result = childProcess.spawnSync('docker', args, { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}

/**
 * The files of all output channels of the last start of VS Code below `logs` (output_logging_* of each window), and the
 * logs of its remote connection.
 */
function outputLogs(logs: string): string[] {
  if (!fs.existsSync(logs)) return [];
  const sessions = fs.readdirSync(logs).filter((name) => /^\d{8}T\d{6}$/.test(name)).sort();
  const folder = path.join(logs, sessions.at(-1) ?? '');
  return fs
    .readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => (/output_logging_/.test(name) && name.endsWith('.log')) || /remote(agent|exthost)\.log$/.test(name))
    .map((name) => path.join(folder, name));
}

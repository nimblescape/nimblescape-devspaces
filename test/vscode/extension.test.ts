// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Tests in a real VS Code (npm run test:vscode and test:vscode:vsix, .vscode-test.mjs): VS Code loads the extension
// from dist/ or from the installed VSIX beside the Dev Containers extension, and mocha runs these tests in its
// extension host (in the configuration `untrusted` in a folder that VS Code does not trust). The tests need no Docker
// engine, and .vscode-test.mjs keeps the extension away from the Docker engine of this computer.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';
const DEV_CONTAINERS_ID = 'ms-vscode-remote.remote-containers';
/** The name of the output channel of the extension (src/vscode/logger.ts, OUTPUT_CHANNEL_NAME). */
const OUTPUT_CHANNEL_NAME = 'Devspaces';
/** VS Code writes the output channels to files in the logs folder after a short delay. */
const LOG_WAIT_MS = 30_000;
/** The log counts as complete when it did not change for this time after the expected line. */
const LOG_QUIET_MS = 3_000;

interface Manifest {
  contributes: { commands: { command: string }[] };
}

describe('the extension in VS Code', () => {
  it('activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    // A failure of the weekly run on other VS Code versions (.github/workflows/vscode-versions.yml) can come from a
    // release of VS Code or of Dev Containers.
    const devContainers = vscode.extensions.getExtension(DEV_CONTAINERS_ID)?.packageJSON as { version: string } | undefined;
    console.log(`    VS Code ${vscode.version}, Dev Containers ${devContainers?.version ?? 'not installed'}`);
  });

  it('runs from the build of the test configuration', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const { version } = extension.packageJSON as { version: string };
    const expected = process.env.DEVSPACE_TEST_VERSION;
    assert.strictEqual(version, expected, 'The extension is not of the version of this checkout');
    const configuration = process.env.DEVSPACE_TEST_CONFIGURATION;
    if (configuration === 'vsix' || configuration === 'untrusted') {
      // VS Code installs a VSIX into the folder <publisher>.<name>-<version> of its extensions folder.
      assert.strictEqual(path.basename(extension.extensionPath), `${EXTENSION_ID}-${version}`, extension.extensionPath);
    } else {
      assert.strictEqual(configuration, 'vscode', 'DEVSPACE_TEST_CONFIGURATION is not set (.vscode-test.mjs)');
      // The development build runs from the checkout, which has the sources.
      const source = path.join(extension.extensionPath, 'src', 'vscode', 'extension.ts');
      assert.ok(fs.existsSync(source), extension.extensionPath);
    }
  });

  it('registers every command of the manifest', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    const manifest = extension.packageJSON as Manifest;
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = manifest.contributes.commands.map(({ command }) => command).filter((command) => !registered.has(command));
    assert.deepStrictEqual(missing, []);
  });

  it('logs the Docker CLI it found, and no error', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    const log = await waitForLog(/\] info (Docker CLI: |The Docker CLI was not found\.)/);
    console.log(`    ${log.split('\n').find((line) => line.includes('Docker CLI')) ?? ''}`);
    const errors = log.split('\n').filter((line) => /^\[\d\d:\d\d:\d\d\] error /.test(line));
    assert.deepStrictEqual(errors, [], `The log of the extension has errors:\n${log}`);
  });
});

/**
 * The log of the extension once it has a line that matches `expected` and then did not change for LOG_QUIET_MS (the
 * activation goes on in the background and can log an error after that line); fails with the log after LOG_WAIT_MS.
 */
async function waitForLog(expected: RegExp): Promise<string> {
  const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  const deadline = Date.now() + LOG_WAIT_MS;
  let log = '';
  let changedAt = Date.now();
  for (;;) {
    const current = logFiles(currentSessionLogs(path.join(userDataDir, 'logs')))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    if (current !== log) {
      log = current;
      changedAt = Date.now();
    }
    if (expected.test(log) && Date.now() - changedAt >= LOG_QUIET_MS) return log;
    if (Date.now() > deadline) {
      if (expected.test(log)) return log;
      assert.fail(`No line matches ${expected} in the log of the extension:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The logs folder of this start of VS Code: VS Code names the folder of each start by its time (YYYYMMDDTHHMMSS), so
 * the last one in order is this one. A user data folder left by an earlier run keeps the older ones.
 */
function currentSessionLogs(logs: string): string {
  const sessions = fs.existsSync(logs) ? fs.readdirSync(logs).filter((name) => /^\d{8}T\d{6}$/.test(name)) : [];
  sessions.sort();
  return path.join(logs, sessions.at(-1) ?? '');
}

/** The files of the output channel of the extension below `folder` (<n>-Devspaces.log in output_logging_*). */
function logFiles(folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => path.basename(name).endsWith(`-${OUTPUT_CHANNEL_NAME}.log`))
    .map((name) => path.join(folder, name));
}

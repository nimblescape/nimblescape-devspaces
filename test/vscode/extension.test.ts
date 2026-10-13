// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Tests in a real VS Code (npm run test:vscode and test:vscode:vsix, .vscode-test.mjs): VS Code loads the extension
// from dist/ or from the installed VSIX beside the Dev Containers extension, and mocha runs these tests in its
// extension host. The tests need no Docker engine, and .vscode-test.mjs keeps the extension away from the Docker
// engine of this computer.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';
/** The name of the output channel of the extension (src/vscode/logger.ts, OUTPUT_CHANNEL_NAME). */
const OUTPUT_CHANNEL_NAME = 'Devspaces';
/** VS Code writes the output channels to files in the logs folder after a short delay. */
const LOG_WAIT_MS = 30_000;

interface Manifest {
  contributes: { commands: { command: string }[] };
}

describe('the extension in VS Code', () => {
  it('activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
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

/** The log of the extension once it has a line that matches `expected`; fails with the log after LOG_WAIT_MS. */
async function waitForLog(expected: RegExp): Promise<string> {
  const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  const deadline = Date.now() + LOG_WAIT_MS;
  let log = '';
  for (;;) {
    log = logFiles(path.join(userDataDir, 'logs'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    if (expected.test(log)) return log;
    if (Date.now() > deadline) assert.fail(`No line matches ${expected} in the log of the extension:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The files of the output channel of the extension below `folder` (<n>-Devspaces.log in output_logging_*). */
function logFiles(folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => path.basename(name).endsWith(`-${OUTPUT_CHANNEL_NAME}.log`))
    .map((name) => path.join(folder, name));
}

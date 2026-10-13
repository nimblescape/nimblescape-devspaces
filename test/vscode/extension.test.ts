// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/// <reference types="mocha" />
// Tests in a real VS Code (npm run test:vscode, .vscode-test.mjs): VS Code loads the extension from dist/ beside the
// Dev Containers extension, and mocha runs these tests in its extension host. The tests need no Docker engine, and
// .vscode-test.mjs keeps the extension away from the Docker engine of this computer.
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';

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
});

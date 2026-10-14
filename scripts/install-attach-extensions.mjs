// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// CI only, before the attach run `stopped` (.github/workflows/ci.yml): packages the extension (npm run package) and the
// test sign-in provider (test/vscode/github) and installs both from their VSIX files into the extensions folder of the
// test VS Code, as users install an extension. The second VS Code of that run (test/vscode/attach/stopped.test.ts) loads
// them from there. It cannot load them as development extensions (--extensionDevelopmentPath): VS Code closes a window
// of development extensions when one of its extension hosts ends, and the extension host of the container ends when
// the container stops (seen in PR #18; VS Code, AbstractExtensionService, _onExtensionHostExit). The test VS Code loads
// its development extensions in place of the installed ones with the same IDs.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

const root = fileURLToPath(new URL('..', import.meta.url));
const folder = path.join(root, 'out', 'test', 'vscode', 'attach', 'vsix');
const extension = path.join(folder, 'nimblescape-devspaces.vsix');
const github = path.join(folder, 'devspaces-vscode-test-github.vsix');

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ended with exit code ${result.status}.`);
}

fs.rmSync(folder, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
run('npm', ['run', '-s', 'package', '--', '--out', extension]);
// The folder has no repository field and no license file of its own.
await createVSIX({ cwd: path.join(root, 'test', 'vscode', 'github'), packagePath: github, dependencies: false, allowMissingRepository: true, skipLicense: true });

// The extensions folder of @vscode/test-electron (.vscode-test/extensions), where prepare.ts installed Dev Containers.
const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
run(cli, [...cliArgs, '--install-extension', extension, '--install-extension', github, '--force']);

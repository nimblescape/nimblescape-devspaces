// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Bundles each test of test/vscode/ to out/test/vscode/<name>.test.js for the tests in a real VS Code
// (.vscode-test.mjs), and the tests of test/vscode/attach/ to out/test/vscode/attach/. The module `vscode` comes from
// the extension host, and mocha from @vscode/test-cli. test/vscode/attach/prepare.ts becomes a Node program for CI.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { devcontainerCliVersion } from './cliVersion.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'test', 'vscode');
const outdir = path.join(root, 'out', 'test', 'vscode');

const attach = path.join(source, 'attach');
// The compile-time constants of esbuild.mjs: the attach tests bundle modules of src/core.
const define = { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) };
const tests = (folder) => fs.readdirSync(folder).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(folder, name));

fs.rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [...tests(source), ...tests(attach)],
  outdir,
  outbase: source,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  define,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(attach, 'prepare.ts')],
  outdir: path.join(outdir, 'attach'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['@vscode/test-electron'],
  define,
  logLevel: 'info',
});

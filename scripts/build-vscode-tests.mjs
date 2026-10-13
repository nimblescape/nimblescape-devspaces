// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Bundles each test of test/vscode/ to out/test/vscode/<name>.test.js for the tests in a real VS Code
// (.vscode-test.mjs). The module `vscode` comes from the extension host, and mocha from @vscode/test-cli.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'test', 'vscode');
const outdir = path.join(root, 'out', 'test', 'vscode');

fs.rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: fs.readdirSync(source).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(source, name)),
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  logLevel: 'info',
});

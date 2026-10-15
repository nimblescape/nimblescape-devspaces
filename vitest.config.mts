// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
  // The scripts in the bundle of the worker; the tests that import the worker's code get stubs (a worker that a test
  // bundles gets the real scripts, scripts/workerScripts.mjs).
  resolve: {
    alias: [
      { find: /^devspace:monitor-script$/, replacement: fileURLToPath(new URL('src/helperChannel/monitorScript.stub.ts', import.meta.url)) },
      { find: /^devspace:analysis-script$/, replacement: fileURLToPath(new URL('src/helperChannel/analysisScript.stub.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});

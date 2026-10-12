// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as path from 'path';
import { defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

// Integration tests against the real Docker engine (npm run test:docker). `npm test` does not run them.
export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
  // The scripts in the bundle of the worker; the tests that import the worker's code get stubs (a worker that a test
  // bundles gets the real scripts, scripts/workerScripts.mjs).
  resolve: {
    alias: [
      { find: /^devspace:monitor-script$/, replacement: path.resolve(__dirname, 'src/helperChannel/monitorScript.stub.ts') },
      { find: /^devspace:analysis-script$/, replacement: path.resolve(__dirname, 'src/helperChannel/analysisScript.stub.ts') },
    ],
  },
  test: {
    include: ['test/docker/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/docker/globalSetup.ts'],
    // One file at a time: the files share the Docker engine, and the check for leftovers needs a quiet engine.
    fileParallelism: false,
    // A first run builds the workspace helper image, which can take some minutes.
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    teardownTimeout: 60_000,
    reporters: ['verbose'],
  },
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { fileURLToPath } from 'url';
import { configDefaults, defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

const TEST_FILES = 'test/docker/**/*.test.ts';

/**
 * The groups of test files that CI runs side by side, each on a runner and engine of its own (DEVSPACE_TEST_GROUP, the
 * matrix of the job "docker" in .github/workflows/ci.yml); each takes about the same time by the times of the files in
 * CI. The group `other` runs every file that no group here names, so a new test file always runs in CI. Without
 * DEVSPACE_TEST_GROUP, every file runs.
 */
const TEST_GROUPS = new Map<string, string[]>([
  ['monitor', ['test/docker/remoteMonitor.test.ts', 'test/docker/workerBatch.test.ts']],
  ['pipeline', ['test/docker/pipeline.test.ts', 'test/docker/compose.test.ts', 'test/docker/helperImage.test.ts']],
]);

/** The test files of DEVSPACE_TEST_GROUP: `include`, and what to leave out of it. */
function testGroup(group: string | undefined): { include: string[]; exclude: string[] } {
  if (group === undefined || group === '') return { include: [TEST_FILES], exclude: [] };
  if (group === 'other') return { include: [TEST_FILES], exclude: [...TEST_GROUPS.values()].flat() };
  const files = TEST_GROUPS.get(group);
  if (files === undefined) throw new Error(`DEVSPACE_TEST_GROUP=${group} names no group (${[...TEST_GROUPS.keys(), 'other'].join(', ')}).`);
  return { include: files, exclude: [] };
}

const group = testGroup(process.env.DEVSPACE_TEST_GROUP);

// Integration tests against the real Docker engine (npm run test:docker). `npm test` does not run them.
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
    include: group.include,
    exclude: [...configDefaults.exclude, ...group.exclude],
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

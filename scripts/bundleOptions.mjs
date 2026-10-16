// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The options of the bundles of esbuild.mjs. The tests that bundle the worker build it with the same options, so that
// they test the real bundle.
//
// The worker's bundle, dist/helperChannel.js, is the program of four uses, each with its own entry
// (src/helperChannel/main.ts): the worker (startChannel), the batch helpers (startBatchHelper), the Monitor
// (startMonitor, and `node /opt/devspace/monitor.js <subcommand>`) and the threads of the host access analysis. It
// carries no code as text.
import { fileURLToPath } from 'url';
import { buildDefines } from './buildDefines.mjs';

/** The entry of the worker's bundle. */
export const WORKER_ENTRY = fileURLToPath(new URL('../src/helperChannel/main.ts', import.meta.url));

/**
 * The options that every bundle shares: CommonJS for Node.js 24; minified and without source maps in a production
 * build, with source maps in a development build; and the compile-time constants (src/types/globals.d.ts), so that code
 * of src/core that a bundle imports never contains an undefined global.
 * @param {{ production: boolean }} options
 * @returns {import('esbuild').BuildOptions & { define: Record<string, string> }}
 */
export function sharedBundleOptions({ production }) {
  return {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: !production,
    minify: production,
    define: buildDefines(),
  };
}

/**
 * The options of the worker's bundle on top of the shared options (sharedBundleOptions, with the plugins of the
 * build): its entry, always minified and without a source map (the extension sends it over SSH as the first input line
 * of the pipe loader).
 * @param {import('esbuild').BuildOptions} shared
 * @returns {import('esbuild').BuildOptions}
 */
export function workerBundleOptions(shared) {
  return { ...shared, entryPoints: [WORKER_ENTRY], minify: true, sourcemap: false };
}

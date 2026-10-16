// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The compile-time constants of the code (src/types/globals.d.ts), as the option `define` of esbuild and vitest.
// esbuild.mjs gives them to every bundle; vitest.config.mts, vitest.docker.config.mts, scripts/build-vscode-tests.mjs
// and the tests that bundle the worker give them to the tests. Both values come from package.json: the version of
// Devspaces (`version`, which the release workflow sets before the build) and the version of the Dev Container CLI
// (scripts/cliVersion.mjs).
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { devcontainerCliVersion } from './cliVersion.mjs';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The version of Devspaces: `version` in package.json. Throws if it is not a version `x.y.z`, the form that the release
 * workflow sets. The version is part of the header User-Agent of every HTTPS request (src/core/http.ts).
 * @param {string} [packageJsonPath] Default: package.json of this repository.
 * @returns {string}
 */
export function devspacesVersion(packageJsonPath = PACKAGE_JSON) {
  const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))?.version;
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    const found = version === undefined ? 'it is missing' : `found ${JSON.stringify(version)}`;
    throw new Error(`${packageJsonPath}: "version" must be a version x.y.z, for example "0.6.0" (${found}).`);
  }
  return version;
}

/**
 * The constants with their values as JSON, for the option `define` of esbuild and vitest.
 * @param {string} [packageJsonPath] Default: package.json of this repository.
 * @returns {{ __DEVCONTAINER_CLI_VERSION__: string, __DEVSPACES_VERSION__: string }}
 */
export function buildDefines(packageJsonPath = PACKAGE_JSON) {
  return {
    __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion(packageJsonPath)),
    __DEVSPACES_VERSION__: JSON.stringify(devspacesVersion(packageJsonPath)),
  };
}

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/** The version of Devspaces: `version` in package.json. Throws if it is not `x.y.z`. Default path: package.json of this repository. */
export function devspacesVersion(packageJsonPath?: string): string;
/** The compile-time constants with their values as JSON, for the option `define` of esbuild and vitest. */
export function buildDefines(packageJsonPath?: string): { __DEVCONTAINER_CLI_VERSION__: string; __DEVSPACES_VERSION__: string };

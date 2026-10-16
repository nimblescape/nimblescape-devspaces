// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Compile-time constants. esbuild.mjs and the configurations of vitest replace them with their values (esbuild option
// `define`, scripts/buildDefines.mjs).

/** Version of `@devcontainers/cli` in the helper image: the exact devDependency in package.json (scripts/cliVersion.mjs). */
declare const __DEVCONTAINER_CLI_VERSION__: string;
/** Version of Devspaces: `version` in package.json (scripts/buildDefines.mjs). It is part of the header User-Agent (src/core/http.ts). */
declare const __DEVSPACES_VERSION__: string;

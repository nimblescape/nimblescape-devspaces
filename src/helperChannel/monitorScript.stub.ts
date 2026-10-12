// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The module `devspace:monitor-script` in the unit tests (vitest.config.mts), which never start a real Monitor;
// the bundle of the worker holds the real script (scripts/workerScripts.mjs).
export default 'console.log("the Monitor of the unit tests");';

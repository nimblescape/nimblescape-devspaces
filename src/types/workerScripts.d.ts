// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scripts in the bundle of the worker (scripts/workerScripts.mjs); the unit tests get stubs of their own
// (vitest.config.mts). The script of the Monitor.
declare module 'devspace:monitor-script' {
  const script: string;
  export default script;
}

// The thread of the host access analysis.
declare module 'devspace:analysis-script' {
  const script: string;
  export default script;
}

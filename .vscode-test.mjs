// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The tests in a real VS Code (npm run test:vscode): @vscode/test-cli downloads VS Code to .vscode-test/, installs the
// Dev Containers extension (extensionDependencies) there, starts VS Code with the extension from dist/ and an empty
// user data folder, and runs the bundled tests of out/test/vscode/ with mocha in its extension host. VSCODE_TEST_VERSION
// selects the VS Code version: "stable" (the default), "insiders" or a version such as 1.125.0. On Linux without a
// display, run it under xvfb-run.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  label: 'vscode',
  files: 'out/test/vscode/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  // No workspace trust prompt, no first-run pages, and on Linux secrets in a file instead of a keyring, which a CI
  // runner or a container does not have.
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--password-store=basic'],
  // The extension of the test window must never reach the Docker engine of this computer: with a fresh user data
  // folder it would build the helper image in the background and restore devspaces from the volumes there. DOCKER_HOST
  // decides over the Docker context (src/core/docker/dockerTargets.ts), and nothing listens on this socket, so the
  // extension finds Docker not running.
  env: { DOCKER_HOST: 'unix:///nonexistent/nimblescape-devspaces-vscode-test.sock' },
  mocha: {
    ui: 'bdd',
    // The first activation of the extension in a fresh VS Code can be slow on CI runners.
    timeout: 60_000,
  },
});

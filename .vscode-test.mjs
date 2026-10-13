// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The tests in a real VS Code: @vscode/test-cli downloads VS Code to .vscode-test/, installs the Dev Containers
// extension (extensionDependencies) there, starts VS Code with an empty user data folder, and runs the bundled tests of
// out/test/vscode/ with mocha in its extension host. Two configurations:
// - "vscode" (npm run test:vscode): the extension of the development build in dist/.
// - "vsix" (npm run test:vscode:vsix, after npm run package): the packaged VSIX of the version in package.json, as
//   users install it. VS Code loads only the small folder test/vscode/host as development extension, because a
//   development extension with the ID of the installed VSIX would be loaded in its place.
// - "attach" (spike of plan step 2a, CI only): VS Code starts in the window of a container that
//   test/vscode/attach/prepare.ts made on the real Docker engine. It exists only when DEVSPACE_TEST_ATTACH names the
//   container (devspace or plain), so that no local run reaches the Docker engine of this computer.
// VSCODE_TEST_VERSION selects the VS Code version: "stable" (the default), "insiders" or a version such as 1.125.0. On
// Linux without a display, run it under xvfb-run.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@vscode/test-cli';

const manifest = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const vsix = fileURLToPath(new URL(`${manifest.name}-${manifest.version}.vsix`, import.meta.url));

// The extension of the test window must never reach the Docker engine of this computer: with a fresh user data
// folder it would build the helper image in the background and restore devspaces from the volumes there. DOCKER_HOST
// decides over the Docker context (src/core/docker/dockerTargets.ts), and nothing listens at this address, so the
// extension finds Docker not running. Windows has named pipes where other systems have Unix sockets.
const dockerHost =
  process.platform === 'win32'
    ? 'npipe:////./pipe/nimblescape-devspaces-vscode-test'
    : 'unix:///nonexistent/nimblescape-devspaces-vscode-test.sock';

/**
 * The labels that `vscode-test --label <label>` runs: every value after `--label` or `-l` up to the next option, and of
 * `--label=`; a number is the index of a configuration (the Extension Test Runner of VS Code passes the index). Empty
 * without a label: then every configuration runs. `--list-configuration` (the Extension Test Runner calls it) runs
 * nothing, so it removes no folder.
 */
const args = process.argv.slice(2);
const listsOnly = args.includes('--list-configuration');
const selectedLabels = [];
for (let index = 0; index < args.length; index++) {
  if (args[index].startsWith('--label=')) selectedLabels.push(args[index].slice('--label='.length));
  if (args[index] !== '--label' && args[index] !== '-l') continue;
  while (index + 1 < args.length && !args[index + 1].startsWith('-')) selectedLabels.push(args[++index]);
}
/** Tells the user data folders of two checkouts on one computer apart. */
const checkout = fileURLToPath(new URL('.', import.meta.url));
const checkoutId = crypto.createHash('sha256').update(checkout).digest('hex').slice(0, 6);

/**
 * A configuration with its own empty user data folder: the folder is removed before each run of the configuration
 * (the default of @vscode/test-electron keeps it between runs), so the extension starts as after a fresh installation
 * on every computer, as on CI. Its path has a space and a letter outside ASCII, as the user folder of many users has.
 * It is in the temporary folder of the system, because VS Code puts its socket into the user data folder, and macOS
 * allows at most 103 bytes in a socket path, which a folder below a checkout often exceeds. The downloaded VS Code and
 * the installed extensions in .vscode-test/ stay.
 */
function configuration(label, index, options) {
  const userDataDir = path.join(os.tmpdir(), `devspaces ${label} ü ${checkoutId}`);
  const selected = selectedLabels.length === 0 || selectedLabels.includes(label) || selectedLabels.includes(`${index}`);
  if (!listsOnly && selected) fs.rmSync(userDataDir, { recursive: true, force: true });
  return {
    label,
    files: 'out/test/vscode/*.test.js',
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    // The empty user data folder, no workspace trust prompt, no first-run pages, and on Linux secrets in a file
    // instead of a keyring, which a CI runner or a container does not have.
    launchArgs: [
      `--user-data-dir=${userDataDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--password-store=basic',
    ],
    // DEVSPACE_TEST_USER_DATA_DIR: the tests read the log of the extension from the logs folder of VS Code there.
    // DEVSPACE_TEST_CONFIGURATION and DEVSPACE_TEST_VERSION: the tests check that VS Code runs the extension from the
    // build of this label, of the version of this checkout.
    env: {
      DOCKER_HOST: dockerHost,
      DEVSPACE_TEST_USER_DATA_DIR: userDataDir,
      DEVSPACE_TEST_CONFIGURATION: label,
      DEVSPACE_TEST_VERSION: manifest.version,
    },
    mocha: {
      ui: 'bdd',
      // The first activation of the extension in a fresh VS Code can be slow on CI runners.
      timeout: 60_000,
    },
    ...options,
  };
}

/**
 * The configuration `attach`: the window of the container DEVSPACE_TEST_ATTACH of out/test/vscode/attach/seed.json, on
 * the Docker engine of this computer. The fake sign-in provider `github` (test/vscode/github) replaces the built-in one.
 */
function attachConfiguration(kind, index) {
  const seed = JSON.parse(fs.readFileSync(new URL('out/test/vscode/attach/seed.json', import.meta.url), 'utf8'))[kind];
  if (!seed) throw new Error(`out/test/vscode/attach/seed.json has no container "${kind}".`);
  const base = configuration('attach', index, {});
  if (!listsOnly) confirmAttach(base.env.DEVSPACE_TEST_USER_DATA_DIR);
  return {
    ...base,
    files: 'out/test/vscode/attach/*.test.js',
    extensionDevelopmentPath: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('test/vscode/github', import.meta.url))],
    launchArgs: [...base.launchArgs, `--folder-uri=${seed.folderUri}`, '--disable-extension=vscode.github-authentication'],
    env: {
      DEVSPACE_TEST_USER_DATA_DIR: base.env.DEVSPACE_TEST_USER_DATA_DIR,
      DEVSPACE_TEST_ATTACH: kind,
      DEVSPACE_TEST_ATTACH_SEED: JSON.stringify(seed),
    },
    mocha: { ...base.mocha, timeout: 900_000 },
  };
}

/**
 * Dev Containers asks once per user, in a modal dialog, before its first attach ("Attaching to a container may execute
 * arbitrary code.", Got It), and VS Code refuses dialogs in tests. Got It stores
 * userConfirmedAttachToContainerRequiresTrust in the global state of Dev Containers (0.469.0), which VS Code keeps in
 * the SQLite table ItemTable of User/globalStorage/state.vscdb, under the extension ID, as JSON. The empty user data
 * folder gets that state, as after Got It.
 */
function confirmAttach(userDataDir) {
  const folder = path.join(userDataDir, 'User', 'globalStorage');
  fs.mkdirSync(folder, { recursive: true });
  const database = new DatabaseSync(path.join(folder, 'state.vscdb'));
  database.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  database
    .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run('ms-vscode-remote.remote-containers', JSON.stringify({ userConfirmedAttachToContainerRequiresTrust: true }));
  database.close();
}

const attachKind = process.env.DEVSPACE_TEST_ATTACH;
// node:sqlite only for the configuration attach: it prints a warning that it is experimental.
const { DatabaseSync } = attachKind ? await import('node:sqlite') : {};

export default defineConfig([
  configuration('vscode', 0, {}),
  configuration('vsix', 1, {
    extensionDevelopmentPath: fileURLToPath(new URL('test/vscode/host', import.meta.url)),
    // The test host folder has no extensionDependencies, so the Dev Containers extension is named here.
    installExtensions: ['ms-vscode-remote.remote-containers', vsix],
  }),
  ...(attachKind ? [attachConfiguration(attachKind, 2)] : []),
]);

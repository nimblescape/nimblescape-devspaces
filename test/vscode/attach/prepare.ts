// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Spike of the attach tests (plan step 2a): prepares the Docker engine of this computer and the test VS Code for the
// configuration `attach` of .vscode-test.mjs, and writes what it made to out/test/vscode/attach/seed.json. It uses the
// real Docker engine, so it runs only on CI (npm run test:vscode:attach:prepare).
// - The test VS Code (downloaded to .vscode-test/ as @vscode/test-cli does) trusts the Devspaces extension with the
//   sessions of the sign-in provider `github` (trustedExtensionAuthAccess in its product.json), so that the
//   extension gets the session of the fake provider (test/vscode/github) without the dialog that asks for access.
// - The workspace helper image, built as the extension builds it, so that the restore of the registry at activation
//   (passive: it builds no image) finds the devspace.
// - A devspace without container: its workspace volume with the labels of the extension (the test account owns it)
//   and a repository with a devcontainer.json. VS Code starts with a fresh user data folder, so the registry of the
//   extension is empty, and the window restores the devspace from the volume labels, as on a new computer.
// - A plain container that is no devspace.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { BootstrapDocker } from '../../../src/core/docker/bootstrapDocker';
import { findDockerCli } from '../../../src/core/docker/dockerCli';
import { HelperImages } from '../../../src/core/helper/helperImages';
import { LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, WORKSPACES_ROOT, newDevspaceId, repositoryFolder, resourceName } from '../../../src/core/names';
import type { Logger } from '../../../src/core/ports';
import { NodeProcessRunner } from '../../../src/core/process';
import { folderUriParts } from '../../../src/vscode/connection/authority';

/** The checkout: the bundle runs from out/test/vscode/attach/. */
const ROOT = path.resolve(__dirname, '../../../..');
const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';
/** The account of the fake sign-in provider (test/vscode/github/extension.js). */
const TEST_ACCOUNT_ID = '4242';
const REPOSITORY = 'devspaces-test/attach';
/** A glibc image with a user `node`: the Dev Containers extension installs its server there. */
const DEV_IMAGE = 'mirror.gcr.io/library/node:24-trixie-slim';

const log: Logger = {
  info: (message) => console.log(`INFO  ${message}`),
  warn: (message) => console.log(`WARN  ${message}`),
  error: (message, error) => console.log(`ERROR ${message}${error === undefined ? '' : `: ${String(error)}`}`),
  output: (text) => process.stdout.write(text),
};

const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '# Attach test\\n' > "$1/README.md"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/** trustedExtensionAuthAccess of the product.json of the test VS Code names the extension for `github`. */
async function trustExtension(): Promise<void> {
  const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
  const productJson = path.join(path.dirname(executable), 'resources', 'app', 'product.json');
  const product = JSON.parse(fs.readFileSync(productJson, 'utf8')) as { trustedExtensionAuthAccess?: string[] | Record<string, string[]> };
  const trusted = product.trustedExtensionAuthAccess;
  if (Array.isArray(trusted)) trusted.push(EXTENSION_ID);
  else product.trustedExtensionAuthAccess = { ...trusted, github: [...(trusted?.github ?? []), EXTENSION_ID] };
  fs.writeFileSync(productJson, JSON.stringify(product, null, '\t'));
  log.info(`${productJson}: trustedExtensionAuthAccess ${JSON.stringify(product.trustedExtensionAuthAccess)}`);
}

function folderUri(containerName: string, folder: string): string {
  const parts = folderUriParts(containerName, folder);
  return `${parts.scheme}://${parts.authority}${parts.path}`;
}

async function main(): Promise<void> {
  const started = Date.now();
  await trustExtension();
  const dockerPath = findDockerCli(process.env, process.platform);
  if (!dockerPath) throw new Error('The Docker CLI was not found.');
  const docker = new BootstrapDocker(new NodeProcessRunner(), dockerPath, process.env, log);
  const helper = await new HelperImages({ docker, logger: log, dockerfilePath: path.join(ROOT, 'resources', 'helper', 'Dockerfile') }).ensureImageUse();
  log.info(`Helper image ${helper.tag} (${((Date.now() - started) / 1000).toFixed(0)} s since the start).`);

  const devspaceId = newDevspaceId();
  const name = resourceName(REPOSITORY, devspaceId);
  const folder = repositoryFolder(REPOSITORY);
  await docker.runChecked(['volume', 'create', '--label', `${LABEL_DEVSPACE_ID}=${devspaceId}`, '--label', `${LABEL_REPOSITORY}=${REPOSITORY}`, '--label', `${LABEL_OWNER_ID}=${TEST_ACCOUNT_ID}`, name]);
  const devcontainerJson = JSON.stringify({ name: 'Attach test', image: DEV_IMAGE, remoteUser: 'node' }, null, 2);
  await docker.runChecked(['run', '--rm', '--pull', 'never', '--network', 'none', '--mount', `type=volume,source=${name},target=${WORKSPACES_ROOT}`, '--entrypoint', 'sh', helper.tag, '-c', SEED_SCRIPT, 'sh', folder, devcontainerJson]);
  // The dev image is pulled here, so that its pull is not part of the time of the first window.
  await docker.runChecked(['pull', DEV_IMAGE], { timeoutMs: 300_000 });

  const plain = `attach-test-plain-${crypto.randomBytes(3).toString('hex')}`;
  await docker.runChecked(['run', '-d', '--name', plain, DEV_IMAGE, 'sleep', 'infinity']);

  const seed = {
    devspace: { containerName: name, folder, folderUri: folderUri(name, folder), devspaceId },
    plain: { containerName: plain, folder: '/tmp', folderUri: folderUri(plain, '/tmp') },
  };
  const file = path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'seed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  log.info(`${file}: ${JSON.stringify(seed)}`);
  log.info(`Prepared in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared parts of the attach tests (.vscode-test.mjs, label attach): the container of this start of VS Code
// (DEVSPACE_TEST_ATTACH_SEED, written by prepare.ts), `docker` on the engine of the runner, the logs of VS Code, and
// what the container can reach of the credentials of the runner.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'nimblescape.nimblescape-devspaces';

/** The container of this start of VS Code (prepare.ts). */
export interface Seed {
  containerName: string;
  /** The folder of the window in the container. */
  folder: string;
  folderUri: string;
  /** The user of the window in the container. */
  user: string;
}

export function seed(): Seed {
  const value = process.env.DEVSPACE_TEST_ATTACH_SEED;
  assert.ok(value, 'DEVSPACE_TEST_ATTACH_SEED is not set (.vscode-test.mjs)');
  return JSON.parse(value) as Seed;
}

/** The folder of the window once VS Code has connected it (the tests start after the connection). */
export async function connectedFolder(): Promise<vscode.Uri> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, 'The window has no folder');
  assert.strictEqual(folder.toString(), vscode.Uri.parse(seed().folderUri).toString());
  assert.strictEqual(vscode.env.remoteName, 'attached-container');
  await vscode.workspace.fs.stat(folder);
  return folder;
}

/** `docker` on the engine of the runner; fails when it fails. */
export function docker(args: string[]): string {
  const result = childProcess.spawnSync('docker', args, { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `docker ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A shell script in the container as `user`, with the environment of the container; `code` and output. */
export function execIn(user: string, script: string): { code: number | null; out: string } {
  const result = childProcess.spawnSync('docker', ['exec', '-u', user, seed().containerName, 'sh', '-c', script], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

/** Waits until `check` returns a value other than undefined; fails with `what` after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`${what}: not after ${timeoutMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The commit of the test VS Code: its server in the container has this commit. */
export function vscodeCommit(): string {
  const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')) as { commit: string };
  return product.commit;
}

/**
 * The ways from the container to the credentials of the runner after the attach, as the user of the window sees them:
 * the Git configuration of the runner (its marker, set by CI), a Git credential helper of Dev Containers, the Docker
 * credential helper of Dev Containers, a GitHub CLI sign-in in the default folder of gh, and the forwarded SSH agent
 * (with the number of keys it offers). The test of the plain container checks that the checks see what Dev Containers
 * sets up.
 */
export interface CredentialPaths {
  gitConfigOfRunner: boolean;
  gitCredentialHelper: boolean;
  dockerCredentialHelper: boolean;
  githubCli: boolean;
  /** The number of keys that the forwarded SSH agent offers, or undefined when no agent answers in the container. */
  sshAgentKeys: number | undefined;
}

/** Marker in the Git configuration of the runner (CI: `git config --global devspaces.marker …`). */
export const RUNNER_GIT_MARKER = 'devspaces-runner-git-configuration';

/**
 * Asks the SSH agent at the socket $SOCKET for its keys (SSH_AGENTC_REQUEST_IDENTITIES, answer
 * SSH_AGENT_IDENTITIES_ANSWER) and prints their number, or -1.
 */
const SSH_AGENT_KEYS = `const end = (keys) => { console.log(keys); process.exit(0); };
const s = require('net').connect(process.env.SOCKET);
let b = Buffer.alloc(0);
s.on('connect', () => s.write(Buffer.from([0, 0, 0, 1, 11])));
s.on('data', (d) => {
  b = Buffer.concat([b, d]);
  if (b.length >= 9 && b.length >= 4 + b.readUInt32BE(0)) end(b[4] === 12 ? b.readUInt32BE(5) : -1);
});
s.on('error', () => end(-1));
setTimeout(() => end(-1), 5000);
`;

/**
 * Node.js in the container as `user` with `script` on its standard input and the variables `env`. Asynchronous: Dev
 * Containers relays the forwarded SSH agent through this extension host, which a synchronous call would block.
 */
function nodeIn(user: string, script: string, env: Record<string, string>): Promise<string> {
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return new Promise((resolve) => {
    const child = childProcess.spawn('docker', ['exec', '-i', '-u', user, ...variables, seed().containerName, 'node', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (data: Buffer) => (out += data.toString()));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
    child.stdin.end(script);
  });
}

export async function credentialPaths(user: string): Promise<CredentialPaths> {
  const home = execIn(user, 'printf %s "$HOME"').out;
  const files = `/etc/gitconfig "${home}/.gitconfig" "\${GIT_CONFIG_GLOBAL:-/nonexistent}"`;
  const gitConfigOfRunner = execIn(user, `cat ${files} 2>/dev/null | grep -q ${RUNNER_GIT_MARKER}`).code === 0;
  // Dev Containers configures `credential.helper` with a script of its own server folder.
  const gitCredentialHelper = execIn(user, `cat ${files} 2>/dev/null | grep -i 'helper' | grep -qi 'vscode\\|remote-containers'`).code === 0;
  const dockerCredentialHelper =
    execIn(user, `ls /usr/local/bin/docker-credential-dev-containers-* >/dev/null 2>&1 || grep -qs 'dev-containers' "${home}/.docker/config.json" "\${DOCKER_CONFIG:-/nonexistent}/config.json"`).code === 0;
  // The default folder of gh; the folder of a devspace (GH_CONFIG_DIR) holds the sign-in of the devspace itself.
  const githubCli = execIn(user, `test -s "${home}/.config/gh/hosts.yml"`).code === 0;
  // The forwarded SSH agent: the sockets that the processes of Dev Containers in the container name in SSH_AUTH_SOCK.
  const sockets = new Set(
    execIn('root', `cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | sed -n 's/^SSH_AUTH_SOCK=//p'; ls /tmp/vscode-ssh-auth-*.sock 2>/dev/null`)
      .out.split('\n')
      .filter((line) => line.startsWith('/')),
  );
  let sshAgentKeys: number | undefined;
  for (const socket of sockets) {
    const exists = execIn('root', `test -S '${socket}'`).code === 0;
    const answer = exists ? Number.parseInt(await nodeIn('root', SSH_AGENT_KEYS, { SOCKET: socket }), 10) : -1;
    const keys = Number.isNaN(answer) ? -1 : answer;
    console.log(`    SSH_AUTH_SOCK ${socket}: ${exists ? `a socket, ${keys < 0 ? 'no answer' : `${keys} keys`}` : 'no socket'}`);
    if (keys >= 0) sshAgentKeys = Math.max(sshAgentKeys ?? 0, keys);
  }
  return { gitConfigOfRunner, gitCredentialHelper, dockerCredentialHelper, githubCli, sshAgentKeys };
}

/** The files of the output channels of the last start of VS Code (output_logging_* of each window) by name. */
export function outputLogs(): Map<string, string> {
  const userDataDir = process.env.DEVSPACE_TEST_USER_DATA_DIR;
  assert.ok(userDataDir, 'DEVSPACE_TEST_USER_DATA_DIR is not set (.vscode-test.mjs)');
  const logs = path.join(userDataDir, 'logs');
  const sessions = fs.existsSync(logs) ? fs.readdirSync(logs).filter((name) => /^\d{8}T\d{6}$/.test(name)).sort() : [];
  const folder = path.join(logs, sessions.at(-1) ?? '');
  const files = new Map<string, string>();
  if (!fs.existsSync(folder)) return files;
  for (const name of fs.readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
    if (/output_logging_/.test(name) && name.endsWith('.log')) files.set(name, fs.readFileSync(path.join(folder, name), 'utf8'));
  }
  return files;
}

/** The log of one output channel (`Devspaces`, `Dev Containers`), empty when it has none. */
export function channelLog(channel: string): string {
  return [...outputLogs()].filter(([name]) => path.basename(name).endsWith(`-${channel}.log`)).map(([, text]) => text).join('\n');
}

/** Prints every output channel of this start; the evidence of a failed test on CI. */
export function printLogs(): void {
  for (const [name, text] of outputLogs()) console.log(`\n===== ${name} =====\n${text}`);
}

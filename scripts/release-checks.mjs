// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The checks of the release rules of the nimblescape extensions (CONTRIBUTING.md, section "Release rules"). The
// workflows ci.yml, release.yml and release-dry-run.yml run them. A check only reads: it prints what it found, as
// GitHub annotations, and exits with 1 when a rule is broken.
//
//   node scripts/release-checks.mjs rules
//     Rules 1, 2 and 5 in the source. The extension ID and the names follow the naming scheme, and the ID is the ID
//     of the newest release tag. No workflow and no npm script deletes an extension, only release.yml publishes, and
//     it publishes with the sign-in to Microsoft Entra ID, never with a personal access token.
//   node scripts/release-checks.mjs package <vsix> [--dry-run]
//     Rules 1 and 3 in the package. The VSIX holds the ID and the version of package.json, and its extension differs
//     from the package of the newest release before that version in more than the version and the change log. The
//     GitHub CLI downloads the package of that release (environment GH_TOKEN and GH_REPO). In a dry run, a package
//     without such a change is a warning; in a release, it is an error.
//   node scripts/release-checks.mjs dry-run
//     Rule 4 (environment GITHUB_REPOSITORY, GH_TOKEN and HEAD_SHA). A successful dry run of the workflow "Release"
//     tested the files of the release process as they are at the commit HEAD_SHA. On a pull request (also PR_NUMBER
//     and HEAD_REF), the check applies only when the pull request changes one of these files.
//
// The script is the same in every extension repository of nimblescape.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** The publisher of every extension of nimblescape. */
export const PUBLISHER = 'nimblescape';
/** The workflow that runs the release; the only file that may publish (rule 5). */
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';
/** The files of the release process: a change to one of them needs a dry run (rule 4). */
export const RELEASE_FILES = [RELEASE_WORKFLOW, 'scripts/release-checks.mjs'];
/** The end of the run name of a dry run of the workflow "Release" (its `run-name`). */
export const DRY_RUN_SUFFIX = '(dry run)';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The numbers of a version `<major>.<minor>.<patch>`.
 * @param {string} version
 * @returns {number[] | undefined} undefined when the text has another form.
 */
export function parseVersion(version) {
  return VERSION.exec(version)?.slice(1).map(Number);
}

/**
 * Compares two versions of the form `<major>.<minor>.<patch>`.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is lower than b, 0 when they are equal, positive when a is higher.
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x.map((n, i) => n - y[i]).find((d) => d !== 0) ?? 0;
}

/**
 * The newest release tag `v<version>` of a list of tag names. Names of another form do not count.
 * @param {string[]} tags
 * @param {string} [below] Only tags of a version lower than this version count.
 * @returns {string | undefined} undefined when no tag counts.
 */
export function newestTag(tags, below) {
  let newest;
  for (const tag of tags) {
    const version = tag.slice(1);
    if (!tag.startsWith('v') || !parseVersion(version)) continue;
    if (below !== undefined && compareVersions(version, below) >= 0) continue;
    if (newest === undefined || compareVersions(version, newest.slice(1)) > 0) newest = tag;
  }
  return newest;
}

/**
 * The extension ID `<publisher>.<name>` of a manifest.
 * @param {{ publisher?: string, name?: string }} manifest
 */
export function extensionId(manifest) {
  return `${manifest.publisher}.${manifest.name}`;
}

/**
 * The breaches of the naming scheme (rule 1) by the manifest of a repository.
 * @param {{ publisher?: string, name?: string, displayName?: string }} manifest The content of package.json.
 * @param {string} repository The name of the repository, without its owner.
 * @returns {string[]}
 */
export function namingProblems(manifest, repository) {
  const problems = [];
  if (manifest.publisher !== PUBLISHER) {
    problems.push(`The publisher in package.json is "${manifest.publisher}", not "${PUBLISHER}".`);
  }
  if (!/^nimblescape-[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? '')) {
    problems.push(`The name "${manifest.name}" in package.json does not have the form nimblescape-<name>.`);
  }
  if (manifest.name !== repository) {
    problems.push(`The name "${manifest.name}" in package.json is not the name of the repository, "${repository}".`);
  }
  if (!/^nimblescape \S/.test(manifest.displayName ?? '')) {
    problems.push(`The display name "${manifest.displayName}" in package.json does not have the form "nimblescape <Title>".`);
  }
  return problems;
}

/** A command of vsce, also of a pinned version such as `vsce@4 publish`; group 1 is the command. */
const VSCE_COMMAND = /\bvsce(?:@\S*)?\s+([a-z-]+)/;

/**
 * The breaches of rules 2 and 5 by the workflows, the actions of the repository and the npm scripts. A line that ends
 * with a backslash continues on the next line, as in a shell; a `#` at the start of a line or after a space starts a
 * comment of YAML; and `&&`, `||`, `;` and `|` separate the commands of a line.
 * @param {{ file: string, text: string }[]} workflows The files of the workflows and of the actions, with their paths
 *   relative to the repository.
 * @param {Record<string, string>} [scripts] The npm scripts of package.json.
 * @returns {string[]}
 */
export function publishingProblems(workflows, scripts = {}) {
  const problems = [];
  const check = (at, command, file) => {
    const vsce = VSCE_COMMAND.exec(command)?.[1];
    if (vsce === 'unpublish') problems.push(`${at}: vsce unpublish deletes the extension on the Marketplace.`);
    if (vsce === 'login' || /\bVSCE_PAT\b/.test(command) || (vsce && /\s(-p|--pat)(\s|=|$)/.test(command))) {
      problems.push(`${at}: a personal access token signs in to the Marketplace.`);
    }
    if (vsce === 'publish') {
      if (file !== RELEASE_WORKFLOW) problems.push(`${at}: only ${RELEASE_WORKFLOW} may publish.`);
      if (!/\s--azure-credential\b/.test(command)) {
        problems.push(`${at}: vsce publish needs the sign-in to Microsoft Entra ID, --azure-credential.`);
      }
    }
  };
  for (const { file, text } of workflows) {
    const lines = text.split(/\r?\n/);
    for (let start = 0; start < lines.length; ) {
      let joined = '';
      let end = start;
      for (;;) {
        const line = lines[end].replace(/(^|\s)#.*$/, '');
        end++;
        if (!line.endsWith('\\') || end >= lines.length) {
          joined += line;
          break;
        }
        joined += `${line.slice(0, -1)} `;
      }
      const at = `${file}:${start + 1}`;
      start = end;
      // The input `pat` of the publishing actions of other authors, for example HaaLeo/publish-vscode-extension.
      if (/^\s*pat\s*:/.test(joined)) problems.push(`${at}: a personal access token signs in to the Marketplace.`);
      for (const command of joined.split(/&&|\|\||;|\|/)) check(at, command, file);
    }
  }
  for (const [name, line] of Object.entries(scripts)) {
    for (const command of line.split(/&&|\|\||;|\|/)) {
      const vsce = VSCE_COMMAND.exec(command)?.[1];
      if (vsce === 'publish' || vsce === 'unpublish' || vsce === 'login') {
        problems.push(`The npm script "${name}" runs vsce ${vsce}: only the workflow "Release" publishes.`);
      }
    }
  }
  return problems;
}

/**
 * The breaches of rule 1 by a package: it must hold the extension ID and the version of the manifest.
 * @param {string} vsixManifest The content of extension.vsixmanifest in the VSIX.
 * @param {{ publisher?: string, name?: string, version?: string }} packed The content of extension/package.json in the
 *   VSIX.
 * @param {{ publisher?: string, name?: string, version?: string }} manifest The content of package.json.
 * @returns {string[]}
 */
export function packageProblems(vsixManifest, packed, manifest) {
  const identity = /<Identity\s([^>]*)>/.exec(vsixManifest)?.[1] ?? '';
  const attribute = (name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(identity)?.[1];
  const expected = `${extensionId(manifest)} ${manifest.version}`;
  const problems = [];
  const identified = `${attribute('Publisher')}.${attribute('Id')} ${attribute('Version')}`;
  if (identified !== expected) {
    problems.push(`The package names the extension ${identified} in extension.vsixmanifest, not ${expected} of package.json.`);
  }
  const contained = `${extensionId(packed)} ${packed.version}`;
  if (contained !== expected) {
    problems.push(`The package holds the extension ${contained} in its package.json, not ${expected} of package.json.`);
  }
  return problems;
}

/**
 * The files of the extension that differ between two packages, without the change log, and without the version and
 * the development tools in package.json (rule 3): vsce packs package.json with its `scripts`, `devDependencies` and
 * `overrides`, which change for users only through the files that the build makes.
 * @param {Map<string, Buffer>} previous The files below extension/ of the earlier package, by their path below it.
 * @param {Map<string, Buffer>} next The files below extension/ of the new package.
 * @returns {string[]} The paths below extension/ of the files that were added, removed or changed.
 */
export function changedFiles(previous, next) {
  const withoutVersion = (content) => {
    const { version, scripts, devDependencies, overrides, ...manifest } = JSON.parse(content.toString('utf8'));
    return JSON.stringify(manifest);
  };
  const changed = [];
  for (const name of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    if (name.toLowerCase() === 'changelog.md') continue;
    const [a, b] = [previous.get(name), next.get(name)];
    if (a === undefined || b === undefined) changed.push(name);
    else if (name === 'package.json' ? withoutVersion(a) !== withoutVersion(b) : !a.equals(b)) changed.push(name);
  }
  return changed;
}

let failed = false;

function error(text) {
  console.log(`::error::${text}`);
  failed = true;
}

function warning(text) {
  console.log(`::warning::${text}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/** The name of the repository: from GITHUB_REPOSITORY in a workflow, else from the URL of the remote origin. */
function repositoryName() {
  const fromWorkflow = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (fromWorkflow) return fromWorkflow;
  const url = run('git', ['remote', 'get-url', 'origin']).trim();
  return url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
}

/** The names of the tags `v*` of the remote origin. */
function releaseTags() {
  return run('git', ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\trefs/tags/')[1]);
}

/** The package.json of a tag of the remote origin. A shallow clone fetches only the commit of the tag. */
function manifestAtTag(tag) {
  const shallow = run('git', ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  run('git', ['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', `refs/tags/${tag}`]);
  return JSON.parse(run('git', ['show', 'FETCH_HEAD:package.json']));
}

/** The files of the workflows and of the actions of the repository, with their paths relative to the repository. */
function workflowFiles() {
  const files = [];
  for (const folder of ['workflows', 'actions']) {
    const root = path.join(ROOT, '.github', folder);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
      if (!/\.ya?ml$/.test(name)) continue;
      files.push({ file: `.github/${folder}/${name.split(path.sep).join('/')}`, text: fs.readFileSync(path.join(root, name), 'utf8') });
    }
  }
  return files;
}

function checkRules() {
  const manifest = readManifest();
  const id = extensionId(manifest);
  for (const problem of namingProblems(manifest, repositoryName())) error(`${problem} (rule 1)`);
  const tag = newestTag(releaseTags());
  if (tag === undefined) {
    console.log(`The repository has no release tag yet: ${id} becomes the ID of the extension with its first release.`);
  } else {
    const released = extensionId(manifestAtTag(tag));
    if (released !== id) error(`The extension ID ${id} differs from ${released} of the release ${tag}: an extension keeps its ID. (rule 1)`);
    else console.log(`The extension ID ${id} is the ID of the release ${tag}.`);
  }
  const problems = publishingProblems(workflowFiles(), manifest.scripts);
  for (const problem of problems) error(`${problem} (rules 2 and 5)`);
  if (problems.length === 0) {
    console.log('Only the workflow "Release" publishes, with the sign-in to Microsoft Entra ID, and nothing deletes an extension.');
  }
}

/** Unpacks a VSIX into a new folder and returns its files below extension/, by their path below it. */
function unpack(vsix, folder) {
  fs.mkdirSync(folder, { recursive: true });
  run('unzip', ['-q', path.resolve(vsix), '-d', folder]);
  const extension = path.join(folder, 'extension');
  const files = new Map();
  for (const name of fs.readdirSync(extension, { recursive: true })) {
    const file = path.join(extension, name);
    if (fs.statSync(file).isFile()) files.set(name.split(path.sep).join('/'), fs.readFileSync(file));
  }
  return files;
}

function checkPackage(vsix, dryRun) {
  const manifest = readManifest();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-checks-'));
  try {
    const next = unpack(vsix, path.join(work, 'next'));
    const vsixManifest = fs.readFileSync(path.join(work, 'next', 'extension.vsixmanifest'), 'utf8');
    const problems = packageProblems(vsixManifest, JSON.parse(next.get('package.json').toString('utf8')), manifest);
    for (const problem of problems) error(`${problem} (rule 1)`);
    if (problems.length === 0) console.log(`The package holds ${extensionId(manifest)} ${manifest.version}.`);

    const tag = newestTag(releaseTags(), manifest.version);
    if (tag === undefined) {
      console.log(`No release before ${manifest.version}: the package is the first release.`);
      return;
    }
    const download = path.join(work, 'download');
    run('gh', ['release', 'download', tag, '--pattern', '*.vsix', '--dir', download], { stdio: ['ignore', 'inherit', 'inherit'] });
    const downloaded = fs.readdirSync(download);
    if (downloaded.length !== 1) {
      error(`The release ${tag} holds ${downloaded.length} VSIX files, not one.`);
      return;
    }
    const changed = changedFiles(unpack(path.join(download, downloaded[0]), path.join(work, 'previous')), next);
    if (changed.length > 0) {
      console.log(`Changed since the release ${tag}: ${changed.join(', ')}.`);
    } else {
      const text = `The package changes nothing for users since the release ${tag}: only the version and the change log differ. (rule 3)`;
      if (dryRun) warning(`${text} A release of this package would stop here.`);
      else error(text);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function checkDryRun() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, HEAD_SHA: head, PR_NUMBER: number, HEAD_REF: branch } = process.env;
  if (!repository || !token || !head || (number && !branch)) {
    error('The check of the dry run needs GITHUB_REPOSITORY, GH_TOKEN and HEAD_SHA, and on a pull request PR_NUMBER and HEAD_REF.');
    return;
  }
  /** The answer of the GitHub API as JSON; undefined for a missing file of a commit (`missing`), else an error. */
  const api = async (request, missing = false) => {
    const response = await fetch(`https://api.github.com/${request}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (missing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`The GitHub API answered ${request} with HTTP ${response.status}.`);
    return response.json();
  };

  let touched = RELEASE_FILES;
  if (number) {
    const changed = new Set();
    for (let page = 1; ; page++) {
      const files = await api(`repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      for (const file of files) {
        changed.add(file.filename);
        if (file.previous_filename) changed.add(file.previous_filename);
      }
      if (files.length < 100) break;
    }
    touched = RELEASE_FILES.filter((file) => changed.has(file));
    if (touched.length === 0) {
      console.log('The pull request changes no file of the release process.');
      return;
    }
  }

  // The Git blob of each file of the release process at a commit (null for a missing file): equal blobs, equal files.
  const blobs = async (ref) =>
    JSON.stringify(
      await Promise.all(RELEASE_FILES.map(async (file) => (await api(`repos/${repository}/contents/${file}?ref=${ref}`, true))?.sha ?? null)),
    );
  const wanted = await blobs(head);
  // The release of the newest tag ran this check with its files, so the same files need no new dry run. A tag from
  // before the rules lacks a file of the release process and does not count.
  const tag = newestTag(releaseTags());
  const tagged = tag === undefined ? undefined : await blobs(tag);
  if (tagged !== undefined && !JSON.parse(tagged).includes(null) && tagged === wanted) {
    console.log(`The files of the release process at ${head} are the files of the release ${tag}, which passed this check.`);
    return;
  }
  const query = 'event=workflow_dispatch&status=success&per_page=100';
  const runs = (await api(`repos/${repository}/actions/workflows/release.yml/runs?${query}`)).workflow_runs;
  const tested = new Set();
  for (const dryRun of runs.filter((candidate) => candidate.display_title.endsWith(DRY_RUN_SUFFIX))) {
    if (tested.has(dryRun.head_sha)) continue;
    tested.add(dryRun.head_sha);
    if ((await blobs(dryRun.head_sha)) === wanted) {
      console.log(`The dry run ${dryRun.html_url} tested ${touched.join(' and ')} as they are at ${head}.`);
      return;
    }
  }
  const files = touched.join(' and ');
  if (number) {
    error(
      `The pull request changes ${files}, and no successful dry run tested them as they are at ${head}. Start the ` +
        `workflow "Release" on the branch ${branch} with "Dry run", then re-run this job. (rule 4)`,
    );
  } else {
    error(
      `No successful dry run tested ${files} as they are at ${head}. Start the workflow "Release" on this branch with ` +
        '"Dry run" first. (rule 4)',
    );
  }
}

// The tests import the functions above; only a start as a program runs a check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'rules' && args.length === 0) checkRules();
    else if (command === 'package' && (args.length === 1 || (args.length === 2 && args[1] === '--dry-run'))) {
      checkPackage(args[0], args.length === 2);
    } else if (command === 'dry-run' && args.length === 0) await checkDryRun();
    else {
      console.error('Usage: node scripts/release-checks.mjs rules | package <vsix> [--dry-run] | dry-run');
      process.exit(2);
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exit(failed ? 1 : 0);
}

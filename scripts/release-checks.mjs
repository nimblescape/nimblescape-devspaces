// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The checks of the release rules of the nimblescape extensions (CONTRIBUTING.md, section "Release rules"). The
// workflows ci.yml, release.yml and release-dry-run.yml run them. A check only reads: it prints what it found, as
// GitHub annotations, and exits with 1 when a rule is broken.
//
//   node scripts/release-checks.mjs rules
//     Rules 1, 2 and 5 in the source. The extension ID and the names follow the naming scheme, and the ID is the ID
//     of the newest release tag. No workflow, no action, no npm script and no file of scripts/ but the checks deletes
//     an extension or the publisher, only release.yml publishes, and it publishes with the sign-in to Microsoft Entra
//     ID, never with a personal access token.
//   node scripts/release-checks.mjs package <vsix> [--dry-run]
//     Rules 1 and 3 in the package, and the tag limit of the Marketplace. The VSIX holds the ID and the version of
//     package.json, and at most 30 tags. Since the package of the newest release before that version, it changes a
//     file that is not a document, not the Marketplace icon and not in dist/, a field of package.json that changes how
//     the extension works, or a bundle of dist/ together with a file of src/ that is not a test. The section of the
//     version in its change log has text, and no phrase such as "maintenance release". The GitHub CLI downloads the
//     package of that release (environment GH_TOKEN and GH_REPO). In a dry run, a breach of rule 3 is a warning; in a
//     release, it is an error.
//   node scripts/release-checks.mjs interval <version> [--dry-run]
//     Rule 3 in time. The GitHub release of the newest tag before the version is at least 7 days old, or the reason of
//     an urgent fix (environment URGENT) is one line of at least 20 characters. A reason is checked also after the 7
//     days and before the first release. The GitHub CLI reads the release (environment GH_TOKEN and GH_REPO). In a dry
//     run, a problem is a warning.
//   node scripts/release-checks.mjs dry-run
//     Rule 4 (environment GITHUB_REPOSITORY, GH_TOKEN and HEAD_SHA). A successful dry run of the workflow "Release"
//     tested the files of the release process, release.yml, ci.yml and this script, as they are at the commit
//     HEAD_SHA. On a pull request (also PR_NUMBER and HEAD_REF), the check applies only when the pull request changes
//     one of these files.
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
/**
 * The files of the release process: a change to one of them needs a dry run (rule 4). The release publishes the VSIX
 * that ci.yml tests and builds.
 */
export const RELEASE_FILES = [RELEASE_WORKFLOW, '.github/workflows/ci.yml', 'scripts/release-checks.mjs'];
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
 * An argument list of JavaScript that runs vsce, such as `['vsce', 'publish', '--azure-credential']`: the string
 * `vsce` or `@vscode/vsce`, also of a pinned version, and the strings after it.
 */
const VSCE_ARGUMENTS = /['"`](?:@vscode\/)?vsce(?:@[^'"`\s]*)?['"`](?:\s*,\s*['"`][^'"`]*['"`])+/g;
/** An import of the API of vsce, whose functions publish and delete without the command line. */
const VSCE_API = /\bfrom\s*['"]@vscode\/vsce['"]|\b(?:require|import)\s*\(\s*['"]@vscode\/vsce['"]/;
/** A call of a function of the vsce API that publishes or deletes; group 1 is the function. */
const VSCE_API_CALL = /\b(publish|publishVSIX|unpublishVSIX)\s*\(/g;

/**
 * The breaches of rules 2 and 5 by the workflows, the actions of the repository, the files of scripts/ and the npm
 * scripts. A line that ends with a backslash continues on the next line, as in a shell; a `#` at the start of a line or
 * after a space starts a comment of YAML or of a shell; and `&&`, `||`, `;` and `|` separate the commands of a line.
 * A file of JavaScript or TypeScript also may not run vsce through an argument list, and may not call the vsce API to
 * publish or to delete.
 * @param {{ file: string, text: string }[]} files The files of the workflows, of the actions and of scripts/, with
 *   their paths relative to the repository.
 * @param {Record<string, string>} [scripts] The npm scripts of package.json.
 * @returns {string[]}
 */
export function publishingProblems(files, scripts = {}) {
  const problems = [];
  const check = (at, command, file) => {
    const vsce = VSCE_COMMAND.exec(command)?.[1];
    if (vsce === 'unpublish') problems.push(`${at}: vsce unpublish deletes the extension on the Marketplace.`);
    if (vsce === 'delete-publisher') {
      problems.push(`${at}: vsce delete-publisher deletes the publisher with all its extensions.`);
    }
    if (vsce === 'login' || /\bVSCE_PAT\b/.test(command) || (vsce && /\s(-p|--pat)(\s|=|$)/.test(command))) {
      problems.push(`${at}: a personal access token signs in to the Marketplace.`);
    }
    if (vsce === 'verify-pat' && !/\s--azure-credential\b/.test(command)) {
      problems.push(`${at}: vsce verify-pat without --azure-credential checks a personal access token.`);
    }
    if (vsce === 'publish') {
      if (file !== RELEASE_WORKFLOW) problems.push(`${at}: only ${RELEASE_WORKFLOW} may publish.`);
      if (!/\s--azure-credential\b/.test(command)) {
        problems.push(`${at}: vsce publish needs the sign-in to Microsoft Entra ID, --azure-credential.`);
      }
    }
  };
  for (const { file, text } of files) {
    const lineOf = (index) => text.slice(0, index).split('\n').length;
    if (/\.[cm]?[jt]s$/.test(file)) {
      for (const match of text.matchAll(VSCE_ARGUMENTS)) {
        const command = [...match[0].matchAll(/['"`]([^'"`]*)['"`]/g)].map((string) => string[1]).join(' ');
        check(`${file}:${lineOf(match.index)}`, command, file);
      }
      if (VSCE_API.test(text)) {
        for (const match of text.matchAll(VSCE_API_CALL)) {
          const at = `${file}:${lineOf(match.index)}`;
          if (match[1] === 'unpublishVSIX') problems.push(`${at}: unpublishVSIX of the vsce API deletes the extension.`);
          else problems.push(`${at}: ${match[1]} of the vsce API publishes; only ${RELEASE_WORKFLOW} may publish.`);
        }
      }
    }
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
      if (/\.ya?ml$/.test(file) && /^\s*pat\s*:/.test(joined)) {
        problems.push(`${at}: a personal access token signs in to the Marketplace.`);
      }
      for (const command of joined.split(/&&|\|\||;|\|/)) check(at, command, file);
    }
  }
  for (const [name, line] of Object.entries(scripts)) {
    for (const command of line.split(/&&|\|\||;|\|/)) {
      const vsce = VSCE_COMMAND.exec(command)?.[1];
      if (vsce === 'publish' || vsce === 'login') {
        problems.push(`The npm script "${name}" runs vsce ${vsce}: only the workflow "Release" publishes.`);
      } else if (vsce === 'unpublish' || vsce === 'delete-publisher') {
        problems.push(`The npm script "${name}" runs vsce ${vsce}: nothing deletes an extension or the publisher.`);
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

/** The most tags that the Marketplace takes in a package. */
const MAX_TAGS = 30;

/**
 * The tags of a package. vsce writes them into the element <Tags> of extension.vsixmanifest, separated by commas: the
 * keywords of package.json and tags of its own, such as the language of each onLanguage event of activationEvents.
 * @param {string} vsixManifest The content of extension.vsixmanifest in the VSIX.
 * @returns {string[]}
 */
function packageTags(vsixManifest) {
  return (/<Tags>([^<]*)<\/Tags>/.exec(vsixManifest)?.[1] ?? '').split(',').filter((tag) => tag !== '');
}

/**
 * The breach of the tag limit by a package: the Marketplace refuses a package with more than 30 tags, so such a
 * package can never be published.
 * @param {string} vsixManifest The content of extension.vsixmanifest in the VSIX.
 * @returns {string[]}
 */
export function tagProblems(vsixManifest) {
  const count = packageTags(vsixManifest).length;
  if (count <= MAX_TAGS) return [];
  return [
    `The package has ${count} tags: the keywords and the tags that vsce adds, one per language of activationEvents. ` +
      `The Marketplace takes at most ${MAX_TAGS}.`,
  ];
}

/**
 * The fields of package.json that change how the extension works (rule 3), for example `contributes` or `type`, which
 * Node reads to load the bundle. The other fields do not, for example `displayName`, `description` and `icon`, which
 * only describe the extension. A script and a development package are fields of their own, such as
 * `scripts.vscode:uninstall`, which VS Code runs after the uninstall of the extension.
 */
const RUNTIME_FIELDS = [
  'main', 'browser', 'type', 'engines', 'activationEvents', 'contributes', 'extensionDependencies', 'extensionPack',
  'extensionKind', 'capabilities', 'enabledApiProposals', 'api', 'dependencies', 'l10n', 'scripts.vscode:uninstall',
];
/**
 * The development packages whose version the build puts into the code: Devspaces builds its helper image with the
 * Dev Container CLI of this version (scripts/cliVersion.mjs).
 */
const RUNTIME_DEV_DEPENDENCIES = ['@devcontainers/cli'];
/** The tests and type declarations of src/, which the bundles do not hold. */
const TEST_SOURCE = /(^|\/)(test|testing|__tests__|__fixtures__)\/|\.(test|testkit|stub)\.[^/]+$|\.d\.[cm]?ts$/;
/** The documents of a package: the files .md in any folder, the files .txt at its top, and the license. */
const DOCUMENT = /\.md$|^[^/]+\.txt$|^license[^/]*$/i;

/** The fields of a manifest in their order, with each script and each development package as a field of its own. */
function manifestFields(manifest) {
  const fields = {};
  for (const [field, value] of Object.entries(manifest)) {
    if ((field === 'scripts' || field === 'devDependencies') && typeof value === 'object' && value !== null) {
      for (const [name, entry] of Object.entries(value)) fields[`${field}.${name}`] = entry;
    } else fields[field] = value;
  }
  return fields;
}

/** The texts in a value of a manifest, also in its arrays and objects. */
function manifestTexts(value) {
  if (typeof value === 'string') return [value];
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(manifestTexts) : [];
}

/** A value as JSON with the keys of each object in sorted order; arrays keep their order. */
function sortedJson(value) {
  const sorted = (entry) => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (entry === null || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sorted(entry[key])]));
  };
  return JSON.stringify(sorted(value));
}

/**
 * The changes of a package for the users since an earlier package (rule 3). A file of the package counts when it is
 * not a document, not the Marketplace icon and not in dist/, package.json in the fields that change how the extension
 * works, and a bundle of dist/ only when a file of src/ that is not a test changed too: a newer build tool changes the
 * bundles without a change of src/, and a comment in src/ changes src/ without a change of the bundles. A file .md and
 * the Marketplace icon count when `contributes` names them, because VS Code then shows them at run time. A field of
 * package.json counts only when its value changed: the order of the keys of an object does not count.
 * @param {Map<string, Buffer>} previous The files below extension/ of the earlier package, by their path below it.
 * @param {Map<string, Buffer>} next The files below extension/ of the new package.
 * @param {string[]} sourceFiles The files of the repository that differ between the commits of the two packages.
 * @returns {{ counted: string[], ignored: string[] }} The changes that count, and those that do not count with the
 *   reason, for example `dist/extension.js (no change of src/ outside the tests)`.
 */
export function userChanges(previous, next, sourceFiles) {
  const isRuntimeField = (field) =>
    RUNTIME_FIELDS.includes(field) || RUNTIME_DEV_DEPENDENCIES.some((name) => field === `devDependencies.${name}`);
  const sourceChanged = sourceFiles.some((file) => file.startsWith('src/') && !TEST_SOURCE.test(file));
  const manifests = [previous, next].map((files) =>
    files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {},
  );
  // The paths below extension/ that the manifests name, for example `./resources/icon.png` and `/resources/icon.png`
  // as `resources/icon.png`, as vsce reads them.
  const paths = (values) =>
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => path.posix.normalize(value).replace(/^\/+/, '')),
    );
  const icons = paths(manifests.map((manifest) => manifest.icon));
  const contributed = paths(manifests.flatMap((manifest) => manifestTexts(manifest.contributes)));
  // The Marketplace icon, unless contributes names it too, for example as the icon of a view.
  const isIcon = (name) => icons.has(name) && !contributed.has(name);
  // A document, unless it is a file .md that contributes names, for example the page of a walkthrough.
  const isDocument = (name) => DOCUMENT.test(name) && !(/\.md$/i.test(name) && contributed.has(name));
  const counted = [];
  const ignored = [];
  for (const name of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const [a, b] = [previous.get(name), next.get(name)];
    if (a !== undefined && b !== undefined && a.equals(b)) continue;
    if (name === 'package.json') {
      const [before, after] = manifests.map(manifestFields);
      const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (field) => sortedJson(before[field]) !== sortedJson(after[field]),
      );
      const runtime = fields.filter(isRuntimeField);
      const other = fields.filter((field) => !isRuntimeField(field));
      if (runtime.length > 0) counted.push(`package.json: ${runtime.join(', ')}`);
      if (other.length > 0) {
        ignored.push(`package.json: ${other.join(', ')} (does not change how the extension works)`);
      }
    } else if (isIcon(name)) ignored.push(`${name} (the Marketplace icon)`);
    else if (isDocument(name)) ignored.push(`${name} (a document)`);
    else if (!name.startsWith('dist/') || sourceChanged) counted.push(name);
    else ignored.push(`${name} (no change of src/ outside the tests)`);
  }
  return { counted, ignored };
}

/**
 * The phrases that say that a version changes nothing for the users (rule 3), for a text in lower case. "behaves as
 * in" counts only before a version, as in "the extension behaves as in 0.1.7" or "behaves as in version 0.1.7", and
 * "behaves as before" only after "extension", so that a description such as "Enter now behaves as in the Explorer
 * view." or "The link behaves as in 2 other editors." passes.
 */
const NO_CHANGE_PHRASES = [
  /maintenance release/, /maintenance version/, /behaves as in (?:version )?v?\d+(?:\.\d+)+/,
  /extension behaves as before/, /no change for users/, /no changes for users/, /no change for the users/,
  /no changes for the users/, /no user-facing change/,
];

/**
 * The section of a version in a change log, which the workflow "Release" uses as the notes of the GitHub release:
 * the lines after the heading `## <version>` up to the next heading `## ` or the closing rule `---`.
 * @param {string} text The change log.
 * @param {string} version
 * @returns {string | undefined} undefined when the change log has no section for the version.
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && (line.startsWith('## ') || line === '---'));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

/**
 * The breaches of rule 3 by the section of a version in the change log: the section describes the change for the
 * users, so it has text besides its headings and does not say that the version changes nothing for them. The check
 * ignores the HTML comments, which the notes do not show (a comment without its end `-->` hides the rest of the
 * section), the case, the marks `*`, `_` and `` ` `` of Markdown, and the line breaks.
 * @param {string | undefined} section The section, as changelogSection returns it.
 * @param {string} version
 * @returns {string[]}
 */
export function wordingProblems(section, version) {
  const shown = (section ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const flat = (part) => part.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const body = shown.split(/\r?\n/).filter((line) => !/^ {0,3}#{1,6}(\s|$)/.test(line)).join('\n');
  if (flat(body) === '') return [`CHANGELOG.md has no text for the version ${version}.`];
  const text = flat(shown);
  const said = NO_CHANGE_PHRASES.map((phrase) => phrase.exec(text)?.[0]).filter((phrase) => phrase !== undefined);
  return said.map(
    (phrase) => `The section ${version} of CHANGELOG.md says "${phrase}": it must describe the change for the users.`,
  );
}

const DAY = 24 * 60 * 60 * 1000;
/** The days from a release to the next one at least, unless an urgent fix gives its reason (rule 3). */
const RELEASE_INTERVAL_DAYS = 7;
/** The shortest reason of an urgent fix, in characters. */
const URGENT_REASON_LENGTH = 20;

/**
 * Rule 3 in time: a release starts 7 days after the newest release at the earliest. An urgent fix may start earlier
 * when its reason is one line of at least 20 characters: a line break counts as a space, and the spaces at the ends do
 * not count. The run name shows "(urgent)" and the version commit keeps the reason for every input that is not empty,
 * so the reason is checked also after the 7 days and before the first release.
 * @param {string | undefined} tag The newest release tag before the version; undefined before the first release.
 * @param {Date | undefined} published When the GitHub release of the tag was published; undefined without a tag.
 * @param {Date} now
 * @param {string} [urgent] The reason of an urgent fix, the input "urgent" of the workflow; empty for none.
 * @returns {{ problem?: string, notice?: string }} A problem when the release is too early or the reason is too short,
 *   a notice when the reason is valid, and neither after 7 days or before the first release without a reason.
 */
export function intervalProblem(tag, published, now, urgent = '') {
  // Before the first release, the 7 days do not apply.
  const age = tag === undefined ? Infinity : now.getTime() - published.getTime();
  const days =
    tag === undefined
      ? 'There is no release before this version'
      : `The newest release ${tag} is ${(Math.floor(Math.max(age, 0) / DAY * 10) / 10).toFixed(1)} days old`;
  const reason = urgent.replace(/\r\n|[\r\n]/g, ' ').trim();
  const short = urgent === '' ? '' : ` The reason in the input urgent must be one line of at least ${URGENT_REASON_LENGTH} characters.`;
  if (age >= RELEASE_INTERVAL_DAYS * DAY) {
    if (urgent === '') return {};
    const needless = `${days}, so the release does not need the input urgent.`;
    if (reason.length >= URGENT_REASON_LENGTH) {
      return { notice: `${needless} The input gives the reason of an urgent fix: ${reason}` };
    }
    return { problem: `${needless}${short} (rule 3)` };
  }
  if (reason.length >= URGENT_REASON_LENGTH) {
    return { notice: `${days}. The input urgent gives the reason of an urgent fix: ${reason}` };
  }
  // The earliest start, rounded up to the minute that the text shows.
  const earliest = new Date(Math.ceil((published.getTime() + RELEASE_INTERVAL_DAYS * DAY) / 60000) * 60000);
  const start = `${earliest.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return { problem: `${days}. The next release can start on ${start}, or now with the input urgent.${short} (rule 3)` };
}

let failed = false;

function error(text) {
  console.log(`::error::${text}`);
  failed = true;
}

function warning(text) {
  console.log(`::warning::${text}`);
}

function notice(text) {
  console.log(`::notice::${text}`);
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

/** Fetches the commit of a tag of the remote origin as FETCH_HEAD. A shallow clone fetches only this commit. */
function fetchTag(tag) {
  const shallow = run('git', ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  run('git', ['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', `refs/tags/${tag}`]);
}

/** The package.json of a tag of the remote origin. */
function manifestAtTag(tag) {
  fetchTag(tag);
  return JSON.parse(run('git', ['show', 'FETCH_HEAD:package.json']));
}

/** The files of the repository that differ between a tag of the remote origin and HEAD; a renamed file twice. */
function sourceChanges(tag) {
  fetchTag(tag);
  return run('git', ['diff', '--name-only', '--no-renames', '-z', 'FETCH_HEAD', 'HEAD']).split('\0').filter(Boolean);
}

/**
 * The answer of the GitHub CLI to a request of the GitHub API, as JSON; undefined for HTTP 404, else an error. The
 * CLI fills `{owner}/{repo}` from GH_REPO or from the remote of the clone.
 */
function ghApi(request) {
  try {
    return JSON.parse(run('gh', ['api', request], { stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (cause) {
    if (/\(HTTP 404\)/.test(String(cause.stderr))) return undefined;
    throw cause;
  }
}

/**
 * When the GitHub release of a tag was published (rule 3). GitHub sets this date when the workflow "Release" publishes
 * the release, minutes before the Marketplace receives the version. A tag without a release counts from its commit.
 * @param {string} tag
 * @returns {Date}
 */
export function releaseDate(tag) {
  const release = ghApi(`repos/{owner}/{repo}/releases/tags/${tag}`);
  if (release?.published_at) return new Date(release.published_at);
  console.log(`The tag ${tag} has no GitHub release: the date of its commit counts.`);
  const commit = ghApi(`repos/{owner}/{repo}/commits/${tag}`);
  if (commit === undefined) throw new Error(`The GitHub API knows no commit of the tag ${tag}.`);
  return new Date(commit.commit.committer.date);
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

/**
 * The files of scripts/, with their paths relative to the repository, but the checks of the release rules and their
 * test, which hold the forbidden commands as data. A file with a NUL byte is no text and does not count.
 */
function scriptFiles() {
  const root = path.join(ROOT, 'scripts');
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
    const file = `scripts/${name.split(path.sep).join('/')}`;
    if (file === 'scripts/release-checks.mjs' || file === 'scripts/release-checks.test.mjs') continue;
    if (!fs.statSync(path.join(root, name)).isFile()) continue;
    const content = fs.readFileSync(path.join(root, name));
    if (!content.includes(0)) files.push({ file, text: content.toString('utf8') });
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
  const scripts = scriptFiles();
  const problems = publishingProblems([...workflowFiles(), ...scripts], manifest.scripts);
  for (const problem of problems) error(`${problem} (rules 2 and 5)`);
  if (problems.length === 0) {
    const files = scripts.length === 1 ? 'the file' : `the ${scripts.length} files`;
    console.log(
      `In the workflows, the actions, the npm scripts and ${files} of scripts/, only the workflow "Release" publishes, ` +
        'with the sign-in to Microsoft Entra ID, and nothing deletes an extension or the publisher.',
    );
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
  // A breach of rule 3 stops a release. A dry run only warns, so that it can test the release process also when there
  // is no change for the users to release.
  const breach = (text) => (dryRun ? warning(`${text} A release of this package would stop here.`) : error(text));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-checks-'));
  try {
    const next = unpack(vsix, path.join(work, 'next'));
    const vsixManifest = fs.readFileSync(path.join(work, 'next', 'extension.vsixmanifest'), 'utf8');
    const problems = packageProblems(vsixManifest, JSON.parse(next.get('package.json').toString('utf8')), manifest);
    for (const problem of problems) error(`${problem} (rule 1)`);
    if (problems.length === 0) console.log(`The package holds ${extensionId(manifest)} ${manifest.version}.`);
    // Too many tags are an error also in a dry run, as in rule 1: the Marketplace never takes such a package.
    const tagLimit = tagProblems(vsixManifest);
    for (const problem of tagLimit) error(problem);
    if (tagLimit.length === 0) {
      console.log(`The package has ${packageTags(vsixManifest).length} tags; the Marketplace takes at most ${MAX_TAGS}.`);
    }

    const changelog = [...next].find(([name]) => name.toLowerCase() === 'changelog.md')?.[1].toString('utf8') ?? '';
    const wording = wordingProblems(changelogSection(changelog, manifest.version), manifest.version);
    for (const problem of wording) breach(`${problem} (rule 3)`);
    if (wording.length === 0) {
      console.log(`The section ${manifest.version} of CHANGELOG.md has text, and no phrase such as "maintenance release".`);
    }

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
    const previous = unpack(path.join(download, downloaded[0]), path.join(work, 'previous'));
    const { counted, ignored } = userChanges(previous, next, sourceChanges(tag));
    const notCounted = ignored.length > 0 ? ` Not counted: ${ignored.join('; ')}.` : '';
    if (counted.length > 0) {
      console.log(`Changed for the users since the release ${tag}: ${counted.join('; ')}.${notCounted}`);
    } else {
      breach(`The package changes nothing for the users since the release ${tag}.${notCounted} (rule 3)`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function checkInterval(version, dryRun) {
  const tag = newestTag(releaseTags(), version);
  if (tag === undefined) console.log(`No release before ${version}: the 7 days of rule 3 do not apply.`);
  const published = tag === undefined ? undefined : releaseDate(tag);
  const { problem, notice: urgent } = intervalProblem(tag, published, new Date(), process.env.URGENT ?? '');
  if (problem !== undefined) {
    if (dryRun) warning(`${problem} A release would stop here.`);
    else error(problem);
  } else if (urgent !== undefined) {
    notice(urgent);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${urgent}\n`);
  } else if (tag !== undefined) {
    console.log(`The newest release ${tag} is at least 7 days old.`);
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
  // The touched files as a text, such as `a, b and c`.
  const files = touched.length > 1 ? `${touched.slice(0, -1).join(', ')} and ${touched.at(-1)}` : touched.join('');
  const query = 'event=workflow_dispatch&status=success&per_page=100';
  const runs = (await api(`repos/${repository}/actions/workflows/release.yml/runs?${query}`)).workflow_runs;
  const tested = new Set();
  for (const dryRun of runs.filter((candidate) => candidate.display_title.endsWith(DRY_RUN_SUFFIX))) {
    if (tested.has(dryRun.head_sha)) continue;
    tested.add(dryRun.head_sha);
    if ((await blobs(dryRun.head_sha)) === wanted) {
      console.log(`The dry run ${dryRun.html_url} tested ${files} as they are at ${head}.`);
      return;
    }
  }
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
  // The option --dry-run comes last; the other arguments are the operands.
  const dryRun = args.at(-1) === '--dry-run';
  const operands = dryRun ? args.slice(0, -1) : args;
  try {
    if (command === 'rules' && args.length === 0) checkRules();
    else if (command === 'package' && operands.length === 1) checkPackage(operands[0], dryRun);
    else if (command === 'interval' && operands.length === 1 && parseVersion(operands[0])) checkInterval(operands[0], dryRun);
    else if (command === 'dry-run' && args.length === 0) await checkDryRun();
    else {
      console.error(
        'Usage: node scripts/release-checks.mjs rules | package <vsix> [--dry-run] | interval <version> [--dry-run] | dry-run',
      );
      process.exit(2);
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exit(failed ? 1 : 0);
}

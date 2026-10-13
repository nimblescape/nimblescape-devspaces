// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { namePair } from './namePairs';
import {
  EXTENSION_LABEL_KEYS,
  LABEL_PREFIX,
  composeProjectName,
  devspaceImageName,
  devspaceImageRepository,
  isDevspaceResourceName,
  resourceName,
} from './names';

const ROOT = path.resolve(__dirname, '..', '..');

/** The TypeScript files of src and test (the Docker tests), with or without the unit tests. */
function codeFiles(tests: boolean): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && (tests || !entry.name.endsWith('.test.ts'))) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  if (tests && fs.existsSync(path.join(ROOT, 'test'))) walk(path.join(ROOT, 'test'));
  return files.sort();
}

/** The characters after which a `/` of the code starts a regular expression, not a division. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * The text of the string and template literals of `source` with their quotes (and the `${` and `}` of a template),
 * everything else (the code, the comments, the regular expressions) blanked with spaces, so that each index stays that
 * of `source`. A label key is always the text of a literal; the code names a devspace by identifiers such as
 * `devspace.id`, which are no label keys. TypeScript 7 has no compiler API in its npm package, so this small lexer reads
 * the file; literals that do not close fail the scan (never a label that is silently skipped).
 */
function literalText(source: string, file: string): string {
  const out = source.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Template nesting: '`' while in the text of a template, '{' while in the code of a `${…}` or a block within it.
  const stack: Array<'`' | '{'> = [];
  let last = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (stack[stack.length - 1] === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i++;
        last = '`';
      } else if (ch === '$' && source[i + 1] === '{') {
        stack.push('{');
        i += 2;
        last = '{';
      } else i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`${file}: a block comment does not close`);
      while (i < end + 2) blank(i++);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\n') throw new Error(`${file}: a string literal does not close`);
        i += source[i] === '\\' ? 2 : 1;
      }
      if (i >= source.length) throw new Error(`${file}: a string literal does not close`);
      i++;
      last = ch;
      continue;
    }
    if (ch === '`') {
      stack.push('`');
      i++;
      continue;
    }
    if (ch === '/' && (BEFORE_REGEX.has(last) || /(^|[^\w$])(return|typeof|case|in|of)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let inClass = false;
      blank(i++);
      while (i < source.length && (source[i] !== '/' || inClass)) {
        if (source[i] === '\n') throw new Error(`${file}: a regular expression does not close`);
        if (source[i] === '\\') blank(i++);
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        blank(i++);
      }
      blank(i++);
      last = ')';
      continue;
    }
    if (ch === '{' && stack.length > 0) stack.push('{');
    if (ch === '}' && stack[stack.length - 1] === '{') {
      stack.pop();
      // The `}` of a `${…}` stays, as its `${`: the text of the template goes on after it.
      if (stack[stack.length - 1] === '`') {
        i++;
        continue;
      }
    }
    if (!/\s/.test(ch)) last = ch;
    blank(i++);
  }
  if (stack.length > 0) throw new Error(`${file}: a template literal does not close`);
  return out.join('');
}

/**
 * The label keys with the prefix `prefix` in the code of `files` (not in comments), with the file. A key that the code
 * builds (`'devspace.' + name`, `devspace.${name}`) is the prefix alone.
 */
function labelKeysInCode(files: readonly string[], prefix: string): Array<{ key: string; file: string }> {
  const pattern = new RegExp(`(?<![\\w.-])${prefix.replace(/[.-]/g, '\\$&')}([a-z0-9._-]*)`, 'gi');
  const found: Array<{ key: string; file: string }> = [];
  for (const file of files) {
    const code = literalText(fs.readFileSync(file, 'utf8'), file);
    for (const match of code.matchAll(pattern)) {
      // The word "devspace" at the end of a sentence of a text ("… the devspace."), not a key.
      if (match[1] === '' && /\s/.test(code[(match.index ?? 0) - 1] ?? '')) continue;
      found.push({ key: `${prefix}${match[1].replace(/\.+$/, '')}`, file: path.relative(ROOT, file) });
    }
  }
  return found;
}

/** The labels with the prefix devspace. (of other tools, or former ones of the extension) that tests allow. */
const FOREIGN_TEST_LABELS = new Set(['devspace.', 'devspace.fingerprint', 'devspace.inputs', 'devspace.environment-id', 'devspace.compose-service']);

/**
 * The IDs of the extension in VS Code (commands, settings, views, context keys) start with `devspace.` too. They are no
 * labels: every `devspace.…` text of package.json, and the few IDs that the code gives VS Code without declaring them
 * there (the status bar item, the webview type, the focus command of the view, the context keys of the Docker setup, a
 * command name that must not exist).
 */
const VSCODE_IDS: ReadonlySet<string> = new Set([
  ...(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').match(/devspace\.[A-Za-z0-9._-]*[A-Za-z0-9]/g) ?? []),
  'devspace.status',
  'devspace.repositoryGroupsEditor',
  'devspace.repositories.focus',
  'devspace.dockerInstalled',
  'devspace.dockerMissing',
  'devspace.dockerReady',
  // A command name that dockerSetupSidebar.test.ts checks is absent.
  'devspace.installDocker',
]);

describe('EXTENSION_LABEL_KEYS', () => {
  it('holds every label with LABEL_PREFIX of the code of src, and each of its keys is used there', () => {
    const found = labelKeysInCode(codeFiles(false), LABEL_PREFIX);
    // A new label of the extension belongs in the set (the policy refuses it by its prefix anyway).
    expect(found.filter(({ key, file }) => !EXTENSION_LABEL_KEYS.has(key) && !(key === LABEL_PREFIX && file === 'src/core/names.ts'))).toEqual([]);
    expect([...EXTENSION_LABEL_KEYS].filter((key) => !found.some((entry) => entry.key === key))).toEqual([]);
  });

  it('holds the keys in lower case, each with LABEL_PREFIX', () => {
    expect(LABEL_PREFIX).toBe('nimblescape.devspace.');
    for (const key of EXTENSION_LABEL_KEYS) expect(key).toMatch(/^nimblescape\.devspace\.[a-z0-9][a-z0-9-]*$/);
  });

  it('holds exactly the labels of the extension', () => {
    expect([...EXTENSION_LABEL_KEYS].map((key) => key.slice(LABEL_PREFIX.length)).sort()).toEqual([
      // The build label of BootstrapDocker.buildImage.
      'build-id',
      // The build record on the devspace image (EngineDocker.labelImage).
      'build-record',
      // The label of the containers that a cancel of an operation removes.
      'channel-step',
      'compose-service',
      'config-path',
      'container-config',
      'container-version',
      'helper',
      // The label of the container of a helper channel.
      'helper-channel',
      'helper-run',
      'host-access',
      // The ID label of a devspace.
      'id',
      // The label of the Monitor container: the hash of its script, image, and mode.
      'monitor',
      // The nonce label of each create of the remote Monitor, by which a failed create removes only its own
      // container.
      'monitor-create',
      // The owner of a permanent Monitor: the ID of the computer that created it.
      'monitor-owner',
      'owner-id',
      // The prepare key and helper image of the prepared devspace image.
      'prepared',
      'repository',
      'service-data',
      'volume',
    ]);
  });

  it('leaves no label with the prefix devspace. in the code, only in the tests of labels of other tools', () => {
    // Another tool named devspace labels its images devspace.…; the extension uses none of these.
    const found = labelKeysInCode(codeFiles(true), 'devspace.').filter(({ key }) => !VSCODE_IDS.has(key));
    expect(found.filter(({ file }) => !file.endsWith('.test.ts'))).toEqual([]);
    expect(found.filter(({ key }) => !FOREIGN_TEST_LABELS.has(key))).toEqual([]);
    expect(found.some(({ key }) => key === 'devspace.fingerprint')).toBe(true);
  });
});

// One name for every resource of a devspace, devspace-<owner>-<repo>-<adjective>-<scientist>.
describe('resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('is devspace-<owner>-<repository>-<pair of the devspace ID>', () => {
    expect(resourceName('acme/api', ID)).toBe(`devspace-acme-api-${namePair(ID)}`);
    expect(resourceName('acme/api', ID)).toMatch(/^devspace-acme-api-[a-z]+-[a-z]+$/);
  });

  it('is the same for the same ID and differs by the ID and the repository', () => {
    expect(resourceName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/web', ID)).not.toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/api', '22222222-2222-4222-8222-222222222222')).toBe('devspace-acme-api-noble-berners');
  });

  it('is in lower case, each run of other characters than [a-z0-9] one -', () => {
    expect(resourceName('Acme/My.Repo_Name', ID)).toBe(`devspace-acme-my-repo-name-${namePair(ID)}`);
    expect(resourceName('o/name-with--dashes---', ID)).toBe(`devspace-o-name-with-dashes-${namePair(ID)}`);
    expect(resourceName('-x/._y', ID)).toBe(`devspace-x-y-${namePair(ID)}`);
  });

  it('has at most 63 characters: a long owner and repository are shortened, the pair is kept', () => {
    const name = resourceName(`${'a'.repeat(40)}/${'b'.repeat(40)}`, ID);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(`devspace-${'a'.repeat(20)}`)).toBe(true);
    expect(name.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isDevspaceResourceName(name)).toBe(true);
    // A cut that ends in a separator drops it.
    const dashed = resourceName(`${'a'.repeat(30)}/${'-b'.repeat(30)}`, ID);
    expect(dashed.length).toBeLessThanOrEqual(63);
    expect(dashed).not.toMatch(/--/);
    expect(dashed.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isDevspaceResourceName(dashed)).toBe(true);
  });

  it('names an owner and repository of only separators `x`', () => {
    expect(resourceName('-/_', ID)).toBe(`devspace-x-${namePair(ID)}`);
    expect(isDevspaceResourceName(resourceName('-/_', ID))).toBe(true);
  });

  it('refuses a repository without owner or name', () => {
    expect(() => resourceName('api', ID)).toThrow();
    expect(() => resourceName('acme/', ID)).toThrow();
  });
});

describe('isDevspaceResourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('refuses `_` and `.` in the name (resourceName never writes them)', () => {
    const name = resourceName('acme/api', ID);
    expect(isDevspaceResourceName(name.replace('devspace-acme-', 'devspace-acme_'))).toBe(false);
    expect(isDevspaceResourceName(name.replace('devspace-acme-', 'devspace-acme.'))).toBe(false);
  });

  it.each(['acme/api', 'Acme/My.Repo_Name', 'a/b', 'devspace/x', `${'a'.repeat(40)}/${'b'.repeat(40)}`])('takes the name of a devspace of %s', (repository) => {
    expect(isDevspaceResourceName(resourceName(repository, ID))).toBe(true);
  });

  it.each([
    'devspace-tools-node_modules',
    'devspace-tools',
    'devspace-cache',
    'devspace-helper-cache',
    'devspace-acme-api',
    'devspace-acme-api-3f2a9c1e',
    'devspace-acme-api-tidy',
    'devspace-acme-api-tidy-nobody',
    'devspace-acme-api-nobody-berners',
    'devspace-acme-api-tidy-berners_data',
    'acme-api-tidy-berners',
    'x-devspace-acme-api-tidy-berners',
    '',
  ])('does not take %j for one', (name) => {
    expect(isDevspaceResourceName(name)).toBe(false);
  });

  it('ignores the case', () => {
    expect(isDevspaceResourceName('DEVSPACE-ACME-API-TIDY-BERNERS')).toBe(true);
    expect(isDevspaceResourceName(resourceName('acme/api', ID).toUpperCase())).toBe(true);
  });
});

describe('the names derived from resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('the Compose project and the repository of the devspace image are resourceName', () => {
    expect(composeProjectName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(devspaceImageRepository('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(composeProjectName('Acme/My.Repo', ID)).toBe(resourceName('Acme/My.Repo', ID));
  });

  it('the devspace image is <resourceName>:<build number>', () => {
    expect(devspaceImageName('acme/api', ID, 3)).toBe(`${resourceName('acme/api', ID)}:3`);
    expect(devspaceImageName('acme/api', ID, 1)).toBe('devspace-acme-api-tidy-berners:1');
  });
});

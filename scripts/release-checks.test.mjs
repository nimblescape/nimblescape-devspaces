// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules of scripts/release-checks.mjs, without Git, the network or a VSIX. The test is the same in every extension
// repository of nimblescape.
import { describe, expect, it } from 'vitest';
import {
  RELEASE_WORKFLOW,
  changedFiles,
  compareVersions,
  newestTag,
  namingProblems,
  packageProblems,
  parseVersion,
  publishingProblems,
} from './release-checks.mjs';

const MANIFEST = { publisher: 'nimblescape', name: 'nimblescape-sample', displayName: 'nimblescape Sample', version: '1.2.3' };

describe('versions and tags', () => {
  it('reads only versions <major>.<minor>.<patch>', () => {
    expect(parseVersion('0.10.2')).toEqual([0, 10, 2]);
    expect(parseVersion('v0.10.2')).toBeUndefined();
    expect(parseVersion('1.02.0')).toBeUndefined();
    expect(parseVersion('1.2')).toBeUndefined();
  });

  it('compares versions by their numbers', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.8', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('finds the newest release tag, also below a version', () => {
    const tags = ['v0.1.9', 'v0.10.0', 'v0.2.0', 'latest', 'v1.0.0-beta', 'x0.20.0'];
    expect(newestTag(tags)).toBe('v0.10.0');
    expect(newestTag(tags, '0.10.0')).toBe('v0.2.0');
    expect(newestTag(tags, '0.1.9')).toBeUndefined();
    expect(newestTag([])).toBeUndefined();
  });
});

describe('rule 1: one ID for good', () => {
  it('accepts the naming scheme', () => {
    expect(namingProblems(MANIFEST, 'nimblescape-sample')).toEqual([]);
  });

  it('refuses another publisher, name or display name', () => {
    expect(namingProblems({ ...MANIFEST, publisher: 'someone' }, 'nimblescape-sample')).toHaveLength(1);
    expect(namingProblems({ ...MANIFEST, name: 'sample' }, 'sample')).toHaveLength(1);
    expect(namingProblems(MANIFEST, 'nimblescape-other')).toHaveLength(1);
    expect(namingProblems({ ...MANIFEST, displayName: 'Sample' }, 'nimblescape-sample')).toHaveLength(1);
    expect(namingProblems({}, 'nimblescape-sample')).toHaveLength(4);
  });

  const vsixManifest = (id, version, publisher = 'nimblescape') =>
    `<Metadata>\n  <Identity Language="en-US" Id="${id}" Version="${version}" Publisher="${publisher}" />\n</Metadata>`;

  it('accepts a package with the ID and the version of package.json', () => {
    expect(packageProblems(vsixManifest('nimblescape-sample', '1.2.3'), MANIFEST, MANIFEST)).toEqual([]);
  });

  it('refuses a package with another ID or version', () => {
    expect(packageProblems(vsixManifest('nimblescape-other', '1.2.3'), MANIFEST, MANIFEST)).toHaveLength(1);
    expect(packageProblems(vsixManifest('nimblescape-sample', '1.2.3', 'other'), MANIFEST, MANIFEST)).toHaveLength(1);
    expect(packageProblems(vsixManifest('nimblescape-sample', '1.2.4'), MANIFEST, MANIFEST)).toHaveLength(1);
    expect(packageProblems(vsixManifest('nimblescape-sample', '1.2.3'), { ...MANIFEST, name: 'x' }, MANIFEST)).toHaveLength(1);
    expect(packageProblems('<Metadata />', MANIFEST, MANIFEST)).toHaveLength(1);
  });
});

describe('rules 2 and 5: no deletion, only GitHub Actions with Microsoft Entra ID', () => {
  const release = (text) => [{ file: RELEASE_WORKFLOW, text }];

  it('accepts the publish step of the workflow "Release"', () => {
    const text = '      - run: npx vsce publish --azure-credential --packagePath "$VSIX" --skip-duplicate\n';
    expect(publishingProblems(release(text), { package: 'vsce package --no-dependencies' })).toEqual([]);
  });

  it('reads a command that continues on the next line, and skips comments', () => {
    const text = '  run: |\n    npx vsce publish \\\n      --azure-credential\n    # vsce unpublish, VSCE_PAT\n';
    expect(publishingProblems(release(text))).toEqual([]);
  });

  it('reads each command of a line on its own', () => {
    expect(publishingProblems(release('run: npx vsce package && mkdir -p out; ls | head -p 1'))).toEqual([]);
    expect(publishingProblems(release('run: mkdir -p out && npx vsce publish --azure-credential'))).toEqual([]);
    expect(publishingProblems(release('run: npx vsce package --azure-credential && npx vsce publish'))).toHaveLength(1);
  });

  it('refuses vsce unpublish, which deletes the extension', () => {
    expect(publishingProblems(release('run: npx vsce unpublish nimblescape.nimblescape-sample'))).toEqual([
      `${RELEASE_WORKFLOW}:1: vsce unpublish deletes the extension on the Marketplace.`,
    ]);
  });

  it('refuses a personal access token', () => {
    for (const text of [
      'run: npx vsce publish --azure-credential -p "$TOKEN"',
      'run: npx vsce publish --azure-credential --pat=x',
      'run: npx vsce login nimblescape',
      'VSCE_PAT: ${{ secrets.VSCE_PAT }}',
      '          pat: ${{ secrets.TOKEN }}',
    ]) {
      expect(publishingProblems(release(text)), text).toHaveLength(1);
    }
  });

  it('refuses a publish without Microsoft Entra ID or outside the workflow "Release"', () => {
    expect(publishingProblems(release('run: npx vsce publish'))).toHaveLength(1);
    expect(publishingProblems(release('run: npx @vscode/vsce@4.0.0 publish'))).toHaveLength(1);
    expect(publishingProblems([{ file: '.github/workflows/ci.yml', text: 'run: npx vsce publish --azure-credential' }])).toHaveLength(1);
    expect(publishingProblems([{ file: '.github/actions/publish/action.yml', text: 'run: vsce publish --azure-credential' }])).toHaveLength(1);
  });

  it('refuses an npm script that publishes, deletes or signs in', () => {
    for (const command of ['vsce publish', 'npm run build && npx vsce unpublish nimblescape.x', 'vsce@4 login nimblescape']) {
      expect(publishingProblems([], { release: command }), command).toHaveLength(1);
    }
  });
});

describe('rule 3: only changes for users', () => {
  const files = (entries) => new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));
  const manifest = (version, extra = {}) => JSON.stringify({ name: 'nimblescape-sample', version, ...extra }, null, 2);

  it('sees no change when only the version and the change log differ', () => {
    const previous = files({ 'package.json': manifest('1.2.3'), 'changelog.md': 'a', 'dist/extension.js': 'code' });
    const next = files({ 'package.json': manifest('1.2.4'), 'changelog.md': 'b', 'dist/extension.js': 'code' });
    expect(changedFiles(previous, next)).toEqual([]);
  });

  it('sees no change when only the development tools in package.json differ', () => {
    const previous = files({ 'package.json': manifest('1.2.3', { scripts: { test: 'a' }, devDependencies: { x: '^1.0.0' } }) });
    const next = files({ 'package.json': manifest('1.2.4', { scripts: { test: 'b' }, devDependencies: { x: '^1.0.1' }, overrides: {} }) });
    expect(changedFiles(previous, next)).toEqual([]);
  });

  it('names the files that were changed, added or removed', () => {
    const previous = files({ 'package.json': manifest('1.2.3'), 'readme.md': 'a', 'dist/old.js': 'x', 'dist/extension.js': 'code' });
    const next = files({ 'package.json': manifest('1.2.4', { main: 'y' }), 'readme.md': 'b', 'dist/new.js': 'x', 'dist/extension.js': 'code' });
    expect(changedFiles(previous, next)).toEqual(['dist/new.js', 'dist/old.js', 'package.json', 'readme.md']);
  });
});

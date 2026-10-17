// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules of scripts/release-checks.mjs, without Git, the network or a VSIX. The test is the same in every extension
// repository of nimblescape.
import { describe, expect, it } from 'vitest';
import {
  RELEASE_WORKFLOW,
  changelogSection,
  compareVersions,
  newestTag,
  namingProblems,
  packageProblems,
  parseVersion,
  publishingProblems,
  userChanges,
  wordingProblems,
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

describe('rule 3: only changes for the users', () => {
  const files = (entries) => new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));
  const manifest = (version, extra = {}) => JSON.stringify({ name: 'nimblescape-sample', version, ...extra }, null, 2);
  const released = { 'package.json': manifest('1.2.3'), 'changelog.md': 'a', 'dist/extension.js': 'code' };

  it('counts no version bump, document or build tool', () => {
    const previous = files({ ...released, 'readme.md': 'a', 'LICENSE.txt': 'a', 'ThirdPartyNotices.txt': 'a' });
    const next = files({
      'package.json': manifest('1.2.4', { scripts: { test: 'b' }, devDependencies: { esbuild: '^1.0.1' }, overrides: {} }),
      'changelog.md': 'b',
      'dist/extension.js': 'code',
      'readme.md': 'b',
      'LICENSE.txt': 'b',
      'ThirdPartyNotices.txt': 'b',
      'SUPPORT.md': 'new',
    });
    expect(userChanges(previous, next, ['esbuild.mjs', 'scripts/build.mjs', 'package-lock.json'])).toEqual({
      counted: [],
      ignored: [
        'LICENSE.txt (a document)',
        'SUPPORT.md (a document)',
        'ThirdPartyNotices.txt (a document)',
        'changelog.md (a document)',
        'package.json: version, scripts.test, devDependencies.esbuild, overrides (does not change how the extension works)',
        'readme.md (a document)',
      ],
    });
  });

  it('counts a bundle only with a change of src/ outside the tests', () => {
    const bumped = { ...released, 'package.json': manifest('1.2.4') };
    const rebuilt = files({ ...bumped, 'dist/extension.js': 'new code' });
    const tests = ['src/a.test.ts', 'src/core/b.testkit.ts', 'src/c.stub.ts', 'src/vscode/testing/fake.ts', 'src/types/globals.d.ts'];
    const withTests = userChanges(files(released), rebuilt, ['esbuild.mjs', ...tests]);
    expect(withTests.counted).toEqual([]);
    expect(withTests.ignored).toContain('dist/extension.js (no change of src/ outside the tests)');
    expect(userChanges(files(released), rebuilt, ['src/core/a.ts']).counted).toEqual(['dist/extension.js']);
    // A change of src/ that leaves the bundles as they are, for example a comment, does not count either.
    expect(userChanges(files(released), files(bumped), ['src/core/a.ts']).counted).toEqual([]);
  });

  it('counts the other files of the package that were changed, added or removed', () => {
    const previous = files({ ...released, 'resources/helper/Dockerfile': 'FROM a', 'resources/old.svg': 'x' });
    const next = files({ ...released, 'resources/helper/Dockerfile': 'FROM b', 'resources/new.svg': 'x' });
    expect(userChanges(previous, next, []).counted).toEqual(['resources/helper/Dockerfile', 'resources/new.svg', 'resources/old.svg']);
  });

  it('counts the Marketplace icon only when contributes names it too', () => {
    const withIcon = (icon, contributes = {}) => manifest('1.2.3', { icon, contributes });
    // The field icon of each of the two manifests names a Marketplace icon, also with ./ before the path.
    const previous = files({ 'package.json': withIcon('./resources/icon.png'), 'resources/icon.png': 'a', 'resources/new.png': 'a' });
    const next = files({ 'package.json': withIcon('resources/new.png'), 'resources/icon.png': 'b', 'resources/new.png': 'b' });
    expect(userChanges(previous, next, [])).toEqual({
      counted: [],
      ignored: [
        'package.json: icon (does not change how the extension works)',
        'resources/icon.png (the Marketplace icon)',
        'resources/new.png (the Marketplace icon)',
      ],
    });
    // The same file as the icon of a view, which VS Code shows at run time.
    const view = { viewsContainers: { activitybar: [{ id: 'sample', title: 'Sample', icon: 'resources/icon.png' }] } };
    const shown = (icon) => files({ 'package.json': withIcon('resources/icon.png', view), 'resources/icon.png': icon });
    expect(userChanges(shown('a'), shown('b'), [])).toEqual({ counted: ['resources/icon.png'], ignored: [] });
  });

  it('reads a path of the manifest with / before it as vsce does, below extension/', () => {
    const walkthrough = { walkthroughs: [{ id: 'start', steps: [{ id: 'one', media: { markdown: '/media/one.md' } }] }] };
    const pack = (text) =>
      files({
        'package.json': manifest('1.2.3', { icon: '/resources/icon.png', contributes: walkthrough }),
        'resources/icon.png': text,
        'media/one.md': text,
      });
    expect(userChanges(pack('a'), pack('b'), [])).toEqual({
      counted: ['media/one.md'],
      ignored: ['resources/icon.png (the Marketplace icon)'],
    });
  });

  it('counts no file .md in any folder unless contributes names it, and no file .txt at the top', () => {
    const walkthrough = { walkthroughs: [{ id: 'start', steps: [{ id: 'one', media: { markdown: './media/one.md' } }] }] };
    const pack = (text) =>
      files({
        'package.json': manifest('1.2.3', { contributes: walkthrough }),
        'docs/guide.md': text,
        'media/one.md': text,
        'NOTES.txt': text,
        'media/words.txt': text,
      });
    expect(userChanges(pack('a'), pack('b'), [])).toEqual({
      counted: ['media/one.md', 'media/words.txt'],
      ignored: ['NOTES.txt (a document)', 'docs/guide.md (a document)'],
    });
  });

  it('counts a field of package.json only when its value changed, not the order of the keys', () => {
    const commands = (...list) => files({ 'package.json': manifest('1.2.3', { contributes: { commands: list } }) });
    const [a, b] = [{ command: 'sample.a', title: 'A' }, { command: 'sample.b', title: 'B' }];
    const reordered = (command) => Object.fromEntries(Object.entries(command).reverse());
    expect(userChanges(commands(a, b), commands(reordered(a), reordered(b)), [])).toEqual({ counted: [], ignored: [] });
    // An array keeps its order, so the order of the commands counts.
    expect(userChanges(commands(a, b), commands(b, a), []).counted).toEqual(['package.json: contributes']);
  });

  // `scripts.<name>` and `devDependencies.<name>` stand for one script and one development package.
  const withField = (field, value) => {
    const [name, entry] = field.split('.', 2);
    return files({ 'package.json': manifest('1.2.3', { [name]: entry === undefined ? value : { [entry]: value } }) });
  };

  it.each([
    'main', 'browser', 'type', 'engines', 'activationEvents', 'contributes', 'extensionDependencies', 'extensionPack',
    'extensionKind', 'capabilities', 'enabledApiProposals', 'api', 'dependencies', 'l10n', 'scripts.vscode:uninstall',
    'devDependencies.@devcontainers/cli',
  ])('counts the field %s of package.json, which changes how the extension works', (field) => {
    expect(userChanges(withField(field, 'a'), withField(field, 'b'), [])).toEqual({ counted: [`package.json: ${field}`], ignored: [] });
  });

  it.each([
    'displayName', 'description', 'keywords', 'icon', 'galleryBanner', 'repository', 'scripts.test',
    'devDependencies.esbuild', 'overrides',
  ])('does not count the field %s of package.json, which does not change how the extension works', (field) => {
    expect(userChanges(withField(field, 'a'), withField(field, 'b'), [])).toEqual({
      counted: [],
      ignored: [`package.json: ${field} (does not change how the extension works)`],
    });
  });

  it('reads the section of a version up to the next section or the closing rule', () => {
    const changelog = '# Change log\n\nA maintenance release.\n\n## 1.2.4\n\nNew: a.\n\n### Details\n\nb\n\n## 1.2.3\n\nOld.\n\n---\n\n© 2026\n';
    expect(changelogSection(changelog, '1.2.4')).toBe('\nNew: a.\n\n### Details\n\nb\n');
    expect(changelogSection(changelog, '1.2.3')).toBe('\nOld.\n');
    expect(changelogSection(changelog, '1.2.5')).toBeUndefined();
    expect(changelogSection('## 1.2.4\r\n\r\nNew.\r\n', '1.2.4')).toBe('\nNew.\n');
  });

  it('refuses a section that is missing or empty, or says that nothing changed for the users', () => {
    expect(wordingProblems(undefined, '1.2.4')).toEqual(['CHANGELOG.md has no text for the version 1.2.4.']);
    expect(wordingProblems('\n  \n', '1.2.4')).toEqual(['CHANGELOG.md has no text for the version 1.2.4.']);
    expect(wordingProblems('Maintenance release: CI runs the tests as root.', '1.2.4')).toEqual([
      'The section 1.2.4 of CHANGELOG.md says "maintenance release": it must describe the change for the users.',
    ]);
    expect(wordingProblems('The extension behaves as\nin 0.1.7.', '1.2.4')).toEqual([
      'The section 1.2.4 of CHANGELOG.md says "behaves as in 0.1.7": it must describe the change for the users.',
    ]);
    expect(wordingProblems('The extension behaves as in version 0.1.7.', '1.2.4')).toEqual([
      'The section 1.2.4 of CHANGELOG.md says "behaves as in version 0.1.7": it must describe the change for the users.',
    ]);
    const texts = [
      'The extension behaves as in v0.1.7.',
      'The extension behaves as in 0.1.x.',
      'The extension behaves as before.',
      '**Maintenance** release.',
      'No user-facing changes.',
      '`no change for users`',
    ];
    for (const text of texts) expect(wordingProblems(text, '1.2.4'), text).toHaveLength(1);
  });

  it('refuses a section that has only headings and HTML comments, and ignores the comments', () => {
    const texts = [
      '\n### Changes\n',
      '<!-- The changes for the users. -->',
      '### Changes\n\n<!--\nThe changes\nfor the users.\n-->\n',
      // A comment without its end hides the rest of the section.
      '### Changes\n\n<!-- The changes\nfor the users.\n',
    ];
    for (const text of texts) {
      expect(wordingProblems(text, '1.2.4'), text).toEqual(['CHANGELOG.md has no text for the version 1.2.4.']);
    }
    // A heading is no text, but its phrases count. The phrases of a comment do not count.
    expect(wordingProblems('### Maintenance release\n\nCI runs the tests as root.', '1.2.4')).toHaveLength(1);
    expect(wordingProblems('<!-- not a maintenance release -->\n**Links:** a link now opens only a file.', '1.2.4')).toEqual([]);
    // The text between two comments stays.
    expect(wordingProblems('<!-- a -->\n**Links:** a link now opens only a file.\n<!-- b -->', '1.2.4')).toEqual([]);
    expect(wordingProblems('<!-- a -->\nA maintenance release.\n<!-- b -->', '1.2.4')).toHaveLength(1);
  });

  it('accepts a section that describes a change', () => {
    expect(wordingProblems('\n**Links:** a link now opens only a file of the workspace.\n', '1.2.4')).toEqual([]);
    // "behaves as in" without a version and "behaves as before" without "extension" describe a change.
    expect(wordingProblems('Enter now behaves as in the Explorer view.', '1.2.4')).toEqual([]);
    expect(wordingProblems('The link behaves as in 2 other editors.', '1.2.4')).toEqual([]);
    expect(wordingProblems('Undo behaves as before the save.', '1.2.4')).toEqual([]);
  });
});

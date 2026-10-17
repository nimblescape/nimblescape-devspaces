// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules of scripts/release-checks.mjs, without Git, the network or a VSIX: mocks answer in place of the GitHub
// CLI and of fetch. The test is the same in every extension repository of nimblescape.
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASE_FILES,
  RELEASE_WORKFLOW,
  changelogSection,
  compareVersions,
  intervalProblem,
  listingProblems,
  listingQuery,
  newestTag,
  namingProblems,
  packageProblems,
  parseVersion,
  publishingProblems,
  queryMarketplace,
  releaseDate,
  tagProblems,
  userChanges,
  wordingProblems,
} from './release-checks.mjs';

vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal()), execFileSync: vi.fn() }));

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

describe('rule 1: the ID never changes', () => {
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

  it('accepts the check of the role on the publisher before the tag', () => {
    expect(publishingProblems(release('          if ! npx vsce verify-pat --azure-credential; then\n'))).toEqual([]);
  });

  it('reads a command that continues on the next line, and skips comments', () => {
    const text = '  run: |\n    npx vsce publish \\\n      --azure-credential\n    # vsce unpublish, VSCE_PAT\n';
    expect(publishingProblems(release(text))).toEqual([]);
  });

  it('reads each command of a line separately', () => {
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
    for (const command of [
      'vsce publish',
      'npm run build && npx vsce unpublish nimblescape.x',
      'vsce@4 login nimblescape',
      'vsce delete-publisher nimblescape',
    ]) {
      expect(publishingProblems([], { release: command }), command).toHaveLength(1);
    }
  });

  it('refuses vsce delete-publisher, which deletes the publisher with all its extensions', () => {
    expect(publishingProblems(release('run: npx vsce delete-publisher nimblescape'))).toEqual([
      `${RELEASE_WORKFLOW}:1: vsce delete-publisher deletes the publisher with all its extensions.`,
    ]);
  });

  it('refuses vsce verify-pat without Microsoft Entra ID', () => {
    expect(publishingProblems(release('run: npx vsce verify-pat nimblescape'))).toEqual([
      `${RELEASE_WORKFLOW}:1: vsce verify-pat without --azure-credential checks a personal access token.`,
    ]);
  });

  it('reads the files of scripts/ as the workflows', () => {
    const script = (file, text) => publishingProblems([{ file, text }]);
    expect(script('scripts/release.sh', '#!/bin/sh\nnpx vsce publish --azure-credential\n')).toEqual([
      `scripts/release.sh:2: only ${RELEASE_WORKFLOW} may publish.`,
    ]);
    expect(script('scripts/reset.sh', 'npx vsce delete-publisher nimblescape\n')).toHaveLength(1);
    expect(script('scripts/install-local.mjs', "run('npx', ['vsce', 'package', '--no-dependencies']);\n")).toEqual([]);
  });

  it('reads the argument lists of vsce and the calls of the vsce API in JavaScript and TypeScript', () => {
    const script = (text, file = 'scripts/x.mjs') => publishingProblems([{ file, text }]);
    expect(script("spawnSync('npx', ['vsce', 'publish', '--azure-credential']);\n")).toEqual([
      `scripts/x.mjs:1: only ${RELEASE_WORKFLOW} may publish.`,
    ]);
    expect(script("execFileSync('npx', [\n  '@vscode/vsce@4.0.0',\n  'unpublish',\n]);\n", 'scripts/x.cjs')).toEqual([
      'scripts/x.cjs:2: vsce unpublish deletes the extension on the Marketplace.',
    ]);
    expect(script("import { publishVSIX } from '@vscode/vsce';\n\nawait publishVSIX('x.vsix', {});\n")).toEqual([
      `scripts/x.mjs:3: publishVSIX of the vsce API publishes; only ${RELEASE_WORKFLOW} may publish.`,
    ]);
    expect(script("const vsce = require('@vscode/vsce');\nvsce.unpublishVSIX({});\n", 'scripts/x.ts')).toHaveLength(1);
    expect(script("import { createVSIX } from '@vscode/vsce';\n\nawait createVSIX({ packagePath: 'x.vsix' });\n")).toEqual([]);
    // A function publish of another module is no call of the vsce API.
    expect(script("import { publish } from './site.mjs';\n\npublish();\n")).toEqual([]);
  });

  it('reads the input pat only in YAML', () => {
    expect(publishingProblems([{ file: 'scripts/x.mjs', text: '  pat: pattern,\n' }])).toEqual([]);
    expect(publishingProblems([{ file: '.github/actions/publish/action.yaml', text: '  pat: ${{ inputs.token }}\n' }])).toHaveLength(1);
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

describe('rule 3: at most one version in 7 days', () => {
  const published = new Date('2026-10-13T17:52:03Z');
  const later = (days, hours = 0) => new Date(published.getTime() + (days * 24 + hours) * 60 * 60 * 1000);
  const reason = 'Fix the start on Mac';

  it('passes 7 days after the newest release', () => {
    expect(intervalProblem('v0.5.0', published, later(7))).toEqual({});
  });

  it('refuses a release within 7 days and names its earliest start', () => {
    expect(intervalProblem('v0.5.0', published, later(6, 23))).toEqual({
      problem:
        'The newest release v0.5.0 is 6.9 days old. The next release can start on 2026-10-20 17:53 UTC, or now with the ' +
        'input urgent. (rule 3)',
    });
  });

  it('lets an urgent fix start with a reason of one line and at least 20 characters', () => {
    expect(reason).toHaveLength(20);
    expect(intervalProblem('v0.5.0', published, later(3), reason)).toEqual({
      notice: `The newest release v0.5.0 is 3.0 days old. The input urgent gives the reason of an urgent fix: ${reason}`,
    });
    // A line break counts as a space, and the spaces at the ends do not count.
    expect(intervalProblem('v0.5.0', published, later(3), ' Fix the start\non Mac ').notice).toMatch(/: Fix the start on Mac$/);
    expect(intervalProblem('v0.5.0', published, later(3), 'Fix the start\r\non Mac').notice).toMatch(/: Fix the start on Mac$/);
    for (const urgent of [reason.slice(0, 19), '   ', ` ${reason.slice(0, 18)}\n`, 'Fix the start\r\non Ma']) {
      expect(intervalProblem('v0.5.0', published, later(3), urgent).problem, urgent).toMatch(
        /The reason in the input urgent must be one line of at least 20 characters\. \(rule 3\)$/,
      );
    }
  });

  it('checks the reason also after 7 days, when the release does not need it', () => {
    expect(intervalProblem('v0.5.0', published, later(8), reason)).toEqual({
      notice:
        'The newest release v0.5.0 is 8.0 days old, so the release does not need the input urgent. The input gives the ' +
        `reason of an urgent fix: ${reason}`,
    });
    for (const urgent of ['x', '   ', reason.slice(0, 19)]) {
      expect(intervalProblem('v0.5.0', published, later(30), urgent), urgent).toEqual({
        problem:
          'The newest release v0.5.0 is 30.0 days old, so the release does not need the input urgent. The reason in the ' +
          'input urgent must be one line of at least 20 characters. (rule 3)',
      });
    }
  });

  it('checks the reason also before the first release, when the release does not need it', () => {
    expect(intervalProblem(undefined, undefined, later(0))).toEqual({});
    expect(intervalProblem(undefined, undefined, later(0), reason)).toEqual({
      notice:
        'There is no release before this version, so the release does not need the input urgent. The input gives the ' +
        `reason of an urgent fix: ${reason}`,
    });
    for (const urgent of ['x', '   ', 'Fix the start\r\non Ma']) {
      expect(intervalProblem(undefined, undefined, later(0), urgent), urgent).toEqual({
        problem:
          'There is no release before this version, so the release does not need the input urgent. The reason in the ' +
          'input urgent must be one line of at least 20 characters. (rule 3)',
      });
    }
  });

  describe('the date of the newest release', () => {
    let log;
    beforeEach(() => {
      execFileSync.mockReset();
      log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => log.mockRestore());
    // The answers of `gh api`, by request; an Error is a failed request with the text of the CLI.
    const gh = (answers) =>
      execFileSync.mockImplementation((command, [, request]) => {
        const answer = answers[request];
        if (command !== 'gh' || answer === undefined) throw new Error(`Unexpected: ${command} ${request}`);
        if (answer instanceof Error) throw Object.assign(answer, { stderr: answer.message });
        return JSON.stringify(answer);
      });

    it('reads the date of the GitHub release, and the commit date of a tag without a release', () => {
      gh({
        'repos/{owner}/{repo}/releases/tags/v0.5.0': { published_at: '2026-10-13T17:52:03Z' },
        'repos/{owner}/{repo}/releases/tags/v0.1.4': new Error('gh: Not Found (HTTP 404)'),
        'repos/{owner}/{repo}/commits/v0.1.4': { commit: { committer: { date: '2026-10-12T15:47:01Z' } } },
      });
      expect(releaseDate('v0.5.0')).toEqual(new Date('2026-10-13T17:52:03Z'));
      expect(releaseDate('v0.1.4')).toEqual(new Date('2026-10-12T15:47:01Z'));
      expect(log).toHaveBeenCalledWith('The tag v0.1.4 has no GitHub release: the date of its commit counts.');
    });

    it('stops at another error of the GitHub CLI', () => {
      gh({ 'repos/{owner}/{repo}/releases/tags/v0.5.0': new Error('gh: Bad credentials (HTTP 401)') });
      expect(() => releaseDate('v0.5.0')).toThrow('Bad credentials');
    });
  });
});

describe('rule 4: dry run first', () => {
  it('counts ci.yml among the files of the release process, because the release publishes its VSIX', () => {
    expect(RELEASE_FILES).toEqual([RELEASE_WORKFLOW, '.github/workflows/ci.yml', 'scripts/release-checks.mjs']);
  });
});

describe('before the tag: the Marketplace lists the extension', () => {
  const ID = 'nimblescape.nimblescape-sample';
  const TAGS = ['v1.2.2', 'v1.2.3'];
  const extension = (id, version) => {
    const [publisherName, extensionName] = id.split('.');
    return { publisher: { publisherName }, extensionName, versions: [{ version }] };
  };
  const answer = (...extensions) => ({ results: [{ extensions, resultMetadata: [] }] });

  it('asks for the newest version of the extension as VS Code asks', () => {
    expect(JSON.stringify(listingQuery('nimblescape.nimblescape-devspaces'))).toBe(
      '{"filters":[{"pageNumber":1,"pageSize":1,"criteria":[{"filterType":7,"value":"nimblescape.nimblescape-devspaces"},' +
        '{"filterType":8,"value":"Microsoft.VisualStudio.Code"},{"filterType":12,"value":"4096"}]}],"assetTypes":[],"flags":513}',
    );
  });

  it('accepts a lower version that has a release tag', () => {
    expect(listingProblems(answer(extension(ID, '1.2.3')), ID, '1.2.4', TAGS)).toEqual([]);
    expect(listingProblems(answer(extension('Nimblescape.Nimblescape-Sample', '1.2.3')), ID, '1.2.4', TAGS)).toEqual([]);
  });

  it('refuses an extension that the Marketplace does not list, but not before the first release', () => {
    const missing =
      `The Marketplace does not list ${ID}. The release stops here, before the tag v1.2.4: without this check, it would ` +
      'create the tag and the GitHub release and then fail at the publish.';
    expect(listingProblems(answer(), ID, '1.2.4', TAGS)).toEqual([missing]);
    expect(listingProblems(answer(extension('nimblescape.nimblescape-other', '1.2.3')), ID, '1.2.4', TAGS)).toEqual([missing]);
    // JSON also allows null in the lists of the answer.
    expect(listingProblems({ results: [null, { extensions: [null] }] }, ID, '1.2.4', TAGS)).toEqual([missing]);
    expect(listingProblems(answer(), ID, '0.1.0', [])).toEqual([]);
  });

  it('says in a dry run that a release would stop there', () => {
    expect(listingProblems(answer(), ID, '1.2.4', TAGS, true)).toEqual([
      `The Marketplace does not list ${ID}. A release would stop here, before the tag v1.2.4: without this check, it ` +
        'would create the tag and the GitHub release and then fail at the publish.',
    ]);
    expect(listingProblems(undefined, ID, '1.2.4', TAGS, true)).toEqual([
      'The Marketplace did not answer the query. A release would stop here, before the tag v1.2.4.',
    ]);
    const stop = 'A release would stop here, before the tag v1.2.4';
    expect(listingProblems({ results: [null, { extensions: [null] }] }, ID, '1.2.4', TAGS, true)).toEqual([
      `The Marketplace does not list ${ID}. ${stop}: without this check, it would create the tag and the GitHub ` +
        'release and then fail at the publish.',
    ]);
    expect(listingProblems({ errorCode: 0, message: 'The query is not valid.' }, ID, '1.2.4', TAGS, true)).toEqual([
      `The Marketplace answered the query with an error: The query is not valid. ${stop}.`,
    ]);
    expect(listingProblems({}, ID, '1.2.4', TAGS, true)).toEqual([
      `The Marketplace answered the query in an unknown form. ${stop}.`,
    ]);
    expect(listingProblems(answer(extension(ID, '1.2.4')), ID, '1.2.4', [...TAGS, 'v1.2.4'], true)).toEqual([
      `The Marketplace lists ${ID} 1.2.4, which is not lower than 1.2.4. ${stop}: without this check, it would ` +
        'create the tag and the GitHub release without a new version on the Marketplace.',
    ]);
    expect(listingProblems(answer(extension(ID, '1.2.3')), ID, '1.2.4', ['v1.2.2'], true)).toEqual([
      `The Marketplace lists ${ID} 1.2.3, but the repository has no tag v1.2.3: that version did not come from the ` +
        `workflow "Release". ${stop}. (rule 5)`,
    ]);
  });

  it('refuses a version that is not lower, and a version without a release tag', () => {
    expect(listingProblems(answer(extension(ID, '1.2.4')), ID, '1.2.4', [...TAGS, 'v1.2.4'])).toEqual([
      `The Marketplace lists ${ID} 1.2.4, which is not lower than 1.2.4. The release stops here, before the tag ` +
        'v1.2.4: without this check, it would create the tag and the GitHub release without a new version on the ' +
        'Marketplace.',
    ]);
    expect(listingProblems(answer(extension(ID, '1.3.0')), ID, '1.2.4', [...TAGS, 'v1.3.0'])).toHaveLength(1);
    expect(listingProblems(answer(extension(ID, '1.2.3')), ID, '1.2.4', ['v1.2.2'])).toEqual([
      `The Marketplace lists ${ID} 1.2.3, but the repository has no tag v1.2.3: that version did not come from the ` +
        'workflow "Release". The release stops here, before the tag v1.2.4. (rule 5)',
    ]);
  });

  it('refuses an error, an answer of an unknown form and no answer', () => {
    const stop = 'The release stops here, before the tag v1.2.4.';
    expect(listingProblems({ errorCode: 0, message: 'The query is not valid.' }, ID, '1.2.4', TAGS)).toEqual([
      `The Marketplace answered the query with an error: The query is not valid. ${stop}`,
    ]);
    // A period ends the text of the Marketplace.
    expect(listingProblems({ errorCode: 0 }, ID, '1.2.4', TAGS)).toEqual([
      `The Marketplace answered the query with an error: 0. ${stop}`,
    ]);
    expect(listingProblems({ errorCode: 0, message: 'The query is not valid' }, ID, '1.2.4', TAGS)).toEqual([
      `The Marketplace answered the query with an error: The query is not valid. ${stop}`,
    ]);
    // JSON also allows null, a text, a number and an array as the answer.
    for (const unknown of [{}, null, 'text', 42, []]) {
      expect(listingProblems(unknown, ID, '1.2.4', TAGS), JSON.stringify(unknown)).toEqual([
        `The Marketplace answered the query in an unknown form. ${stop}`,
      ]);
    }
    expect(listingProblems(undefined, ID, '1.2.4', TAGS)).toEqual([`The Marketplace did not answer the query. ${stop}`]);
  });

  describe('the query', () => {
    const answered = (status, body) => ({ ok: status < 300, status, json: async () => body });
    afterEach(() => vi.unstubAllGlobals());
    // The problem that the check "listed" names for the end of a query.
    const problem = async (query) => listingProblems(await query.catch((cause) => cause), ID, '1.2.4', TAGS);
    const failed = ['The query of the Marketplace failed. The release stops here, before the tag v1.2.4.'];
    const noAnswer = ['The Marketplace did not answer the query. The release stops here, before the tag v1.2.4.'];

    it('sends the query once more after a network error, an answer HTTP 429 or an answer HTTP 5xx', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(answered(200, answer())));
      expect(await queryMarketplace(ID, { retryDelay: 0 })).toEqual(answer());
      expect(fetch).toHaveBeenCalledTimes(2);
      const url = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
      const request = expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'user-agent': 'nimblescape-release-checks' }),
        body: JSON.stringify(listingQuery(ID)),
      });
      expect(fetch).toHaveBeenNthCalledWith(1, url, request);
      expect(fetch).toHaveBeenNthCalledWith(2, url, request);
      for (const status of [429, 503]) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answered(status)).mockResolvedValueOnce(answered(200, answer())));
        expect(await queryMarketplace(ID, { retryDelay: 0 }), String(status)).toEqual(answer());
        expect(fetch).toHaveBeenCalledTimes(2);
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answered(503)));
      const query = queryMarketplace(ID, { retryDelay: 0 });
      await expect(query).rejects.toThrow('The Marketplace answered the query with HTTP 503.');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await problem(query)).toEqual(failed);
    });

    it('says that the Marketplace did not answer when both tries fail with a network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reset')));
      const query = queryMarketplace(ID, { retryDelay: 0 });
      await expect(query).rejects.toThrow('The Marketplace did not answer the query: reset');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await problem(query)).toEqual(noAnswer);
    });

    it('says that the Marketplace did not answer when its answer does not arrive in full', async () => {
      const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(timeout) }));
      const cut = queryMarketplace(ID, { retryDelay: 0 });
      await expect(cut).rejects.toThrow('The Marketplace did not answer the query: The operation was aborted due to timeout');
      expect(await problem(cut)).toEqual(noAnswer);
    });

    it('waits 5 seconds before the second try', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answered(503)).mockResolvedValueOnce(answered(200, answer())));
        const query = queryMarketplace(ID);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await query).toEqual(answer());
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops immediately at another answer that is not a success', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answered(400)));
      const query = queryMarketplace(ID);
      await expect(query).rejects.toThrow('HTTP 400');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await problem(query)).toEqual(failed);
    });

    it('stops immediately at an answer that is not JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => JSON.parse('<html>') }));
      const query = queryMarketplace(ID);
      await expect(query).rejects.toThrow('The answer of the Marketplace is not JSON: ');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await problem(query)).toEqual(failed);
    });
  });
});

describe('before the tag: at most 30 tags in the package', () => {
  const withTags = (count) =>
    `<Metadata>\n  <Tags>${Array.from({ length: count }, (_, index) => `tag${index}`).join(',')}</Tags>\n</Metadata>`;

  it('accepts 30 tags, no tag and a package without the element Tags', () => {
    expect(tagProblems(withTags(30))).toEqual([]);
    expect(tagProblems(withTags(0))).toEqual([]);
    expect(tagProblems('<Metadata />')).toEqual([]);
  });

  it('refuses 31 tags, which the Marketplace does not take', () => {
    expect(tagProblems(withTags(31))).toEqual([
      'The package has 31 tags: the keywords and the tags that vsce adds, one per language of activationEvents. ' +
        'The Marketplace takes at most 30.',
    ]);
  });
});

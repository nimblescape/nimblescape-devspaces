// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// The release packages the extension with `vsce package --no-rewrite-relative-links`. That option also turns off the
// checks of vsce for the images of README.md and CHANGELOG.md (an HTTPS source, no SVG), and a relative link stays
// relative, so it is broken on the Marketplace page. These tests make those checks. They also refuse a raw tag such
// as <owner> outside code: the Marketplace and GitHub take it as HTML and show nothing in its place.
const ROOT = path.join(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The Markdown with the code blocks and code spans blanked out; the line numbers stay. */
function withoutCode(markdown: string): string {
  let fence: string | undefined;
  const lines = markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      fence = marker;
      return marker ? '' : line;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = undefined;
    return '';
  });
  // A code span ends at the next run of as many backticks in the same paragraph.
  return lines
    .join('\n')
    .split(/(\n[ \t]*\n)/)
    .map((part) => part.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => span.replace(/[^\n]/g, '')))
    .join('');
}

/** The problems of a Markdown page for the Marketplace, as `line: problem`. */
function problems(markdown: string, checks: { links: boolean } = { links: true }): string[] {
  const found: string[] = [];
  withoutCode(markdown)
    .split('\n')
    .forEach((line, index) => {
      const at = `${index + 1}: `;
      for (const tag of line.matchAll(/(?<!\\)<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^>]*>?/g)) found.push(`${at}raw tag ${tag[0]}`);
      if (!checks.links) return;
      const targets = [...line.matchAll(/\]\(\s*<?([^\s>)]*)/g), ...line.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]*)/g)];
      for (const [, target] of targets) {
        if (!/^(\w+:\/\/|mailto:|#)/i.test(target)) found.push(`${at}relative link ${target}`);
      }
      for (const [, source] of line.matchAll(/!\[[^\]]*\]\(\s*<?([^\s>)]*)/g)) {
        if (!/^https:\/\//i.test(source)) found.push(`${at}image not from an HTTPS source ${source}`);
        else if (/\.svg$/i.test(new URL(source).pathname)) found.push(`${at}SVG image ${source}`);
      }
    });
  return found;
}

describe('the checks of a Markdown page', () => {
  it('finds relative links, images that are not HTTPS or are SVG, and raw tags', () => {
    const page = [
      'See [the guide](docs/guide.md) and [the logo](./resources/icon.png).',
      '![Logo](http://example.com/logo.png) ![Badge](https://example.com/badge.svg?style=flat)',
      'The name devspaces-<owner>-<repo> and <img src="x.png"> and </b>.',
      '[guide]: docs/guide.md',
    ].join('\n');
    expect(problems(page)).toEqual([
      '1: relative link docs/guide.md',
      '1: relative link ./resources/icon.png',
      '2: image not from an HTTPS source http://example.com/logo.png',
      '2: SVG image https://example.com/badge.svg?style=flat',
      '3: raw tag <owner>',
      '3: raw tag <repo>',
      '3: raw tag <img src="x.png">',
      '3: raw tag </b>',
      '4: relative link docs/guide.md',
    ]);
  });

  it('accepts absolute links, anchors, autolinks, code and text that is no tag', () => {
    const page = [
      'See [Security](https://github.com/acme/repo/blob/main/docs/security.md#top), [Usage](#usage), <https://example.com>,',
      '[mail](mailto:team@example.com), ![Shot](https://example.com/shot.png) and the name `devspaces-<owner>-<repo>`.',
      'A worker is devspace-worker-<12 characters>; 1 < 2 and \\<owner> stay text; `` a ` <b> `` is code.',
      '```',
      'docker run --name <worker name> [x](relative.md)',
      '```',
      'Back in text.',
    ].join('\n');
    expect(problems(page)).toEqual([]);
  });

  it('can check only the raw tags, for a page on GitHub whose relative links work', () => {
    expect(problems('[Guide](guide.md) of <host>', { links: false })).toEqual(['1: raw tag <host>']);
  });
});

describe('the Markdown pages', () => {
  it.each(['README.md', 'CHANGELOG.md'])('%s has no relative link, no image without HTTPS, no SVG image and no raw tag', (file) => {
    expect(problems(read(file))).toEqual([]);
  });
});

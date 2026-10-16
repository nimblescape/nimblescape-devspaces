// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The bundles of the package are readable JavaScript: not minified, with the names of the source (`keepNames`), and
// with source maps only in a development build (scripts/bundleOptions.mjs, from which esbuild.mjs builds them). The
// worker's bundle holds the Monitor as readable code. No bundle holds the path of the folder that it was built in.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { packageBundleOptions, sharedBundleOptions } from '../scripts/bundleOptions.mjs';

const ROOT = path.resolve(__dirname, '..');
const OUTFILES = ['dist/extension.js', 'dist/groupsPreviewWorker.js', 'dist/helperChannel.js'];

/** The text of each bundle of a production build, by its output file. */
const bundles = new Map<string, string>();

beforeAll(async () => {
  for (const options of packageBundleOptions(sharedBundleOptions({ production: true }))) {
    const result = await esbuild.build({ ...options, absWorkingDir: ROOT, write: false, logLevel: 'silent' });
    expect(result.outputFiles.map((file) => path.relative(ROOT, file.path))).toEqual([options.outfile]);
    bundles.set(options.outfile, result.outputFiles[0].text);
  }
}, 120_000);

describe('the bundles of the package', () => {
  it('are the files of dist/ that the package holds', () => {
    expect([...bundles.keys()]).toEqual(OUTFILES);
    const packaged = fs
      .readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('!dist/'));
    expect(packaged).toEqual(OUTFILES.map((file) => `!${file}`));
  });

  it('are readable in a production build, without source maps', () => {
    expect(sharedBundleOptions({ production: true })).toMatchObject({ minify: false, keepNames: true, sourcemap: false });
    for (const options of packageBundleOptions(sharedBundleOptions({ production: true }))) {
      expect(options, options.outfile).toMatchObject({ minify: false, keepNames: true, sourcemap: false });
    }
  });

  it('have source maps in a development build, except the bundle of the worker', () => {
    expect(sharedBundleOptions({ production: false })).toMatchObject({ minify: false, keepNames: true, sourcemap: true });
    const development = packageBundleOptions(sharedBundleOptions({ production: false }));
    expect(development.map((options) => [options.outfile, options.sourcemap])).toEqual([
      ['dist/extension.js', true],
      ['dist/groupsPreviewWorker.js', true],
      ['dist/helperChannel.js', false],
    ]);
    for (const options of development) expect(options, options.outfile).toMatchObject({ minify: false, keepNames: true });
  });

  it('hold the code with its names and a comment that names each source file', () => {
    const worker = bundles.get('dist/helperChannel.js')!;
    expect(worker).toContain('function startMonitor(');
    expect(worker).toContain('\n// src/remoteMonitor/main.ts\n');
    expect(worker.split('\n').length).toBeGreaterThan(20_000);
    for (const [file, text] of bundles) {
      expect(text, file).toContain('var __name = ');
      expect(text, file).toMatch(/\n\/\/ src\/[\w/.-]+\.ts\n/);
    }
  });

  it('hold no path of the folder that they were built in', () => {
    for (const [file, text] of bundles) {
      expect(text.includes(ROOT), file).toBe(false);
      expect(text.includes(ROOT.split(path.sep).join('/')), file).toBe(false);
    }
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { GITHUB_SCOPES, PACKAGES_SCOPES } from './auth';

// nimblescape promised the Visual Studio Marketplace team that the top of the description and of the README (the
// Marketplace page) says what Devspaces does on the computer, with a link to docs/security.md (CONTRIBUTING.md,
// "Release rules"). The scopes come from the code, so a change of the scopes also changes these texts.
const ROOT = path.join(__dirname, '..', '..');
const HEADING = 'What Devspaces does on your computer';
const SECURITY_LINK = 'https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/security.md#what-devspaces-does-on-your-computer';
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The text of the section `## <heading>` up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(0);
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

describe('the behaviors of Devspaces at the top of the Marketplace page', () => {
  it('opens the README with the section, which names every scope and links docs/security.md', () => {
    const readme = read('README.md');
    expect(readme.match(/^## .*$/m)?.[0]).toBe(`## ${HEADING}`);
    const text = section(readme, HEADING);
    for (const scope of PACKAGES_SCOPES) expect(text).toContain(`\`${scope}\``);
    const behaviors = ['Docker CLI', 'Dev Containers CLI', '`ssh`', 'docker-credential-', 'install', 'devspaces-monitor', 'VS Code Server', 'extensions'];
    for (const words of behaviors) {
      expect(text).toContain(words);
    }
    expect(text).toContain(`(${SECURITY_LINK})`);
  });

  it('has the section in docs/security.md, as the target of the link', () => {
    const text = section(read('docs/security.md'), HEADING);
    for (const scope of PACKAGES_SCOPES) expect(text).toContain(`\`${scope}\``);
    for (const words of ['`ssh`', 'docker-credential-', '#registry-access']) expect(text).toContain(words);
    expect(text).toContain('guide.md#installing-docker');
  });

  it('names the scopes, Docker, the Dev Containers CLI and the background container in the description', () => {
    const { description } = JSON.parse(read('package.json')) as { description: string };
    for (const scope of GITHUB_SCOPES) expect(description).toContain(scope);
    for (const words of ['Docker', 'Dev Containers CLI', 'install Docker', 'background container']) {
      expect(description).toContain(words);
    }
  });
});

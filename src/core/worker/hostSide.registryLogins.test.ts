// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `secret registry` on the side of the extension: only the login of the registry of the image or Feature that the
// request names, with a valid host name, one request at a time, at most MAX_LOGIN_REGISTRIES registries and
// MAX_LOGIN_REQUESTS requests of an operation, and a line in the log for each request.
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import type { Logger } from '../ports';
import type { HostRegistryLogin, HostSide } from './hostSide';
import { MAX_LOGIN_REGISTRIES, MAX_LOGIN_REQUESTS, hostSideHandler } from './hostSideHandler';

/** A handler of an open of acme/api whose computer has the logins of `stored`; `asked`: the requests that reached it. */
function wired(stored: Record<string, HostRegistryLogin | (() => Promise<HostRegistryLogin | undefined>)> = {}) {
  const asked: string[] = [];
  const lines: string[] = [];
  const logger: Logger = {
    info: (text) => void lines.push(`info ${text}`),
    warn: (text) => void lines.push(`warn ${text}`),
    error: (text) => void lines.push(`error ${text}`),
    output: () => undefined,
  };
  const host = {
    secrets: {
      token: async () => undefined,
      registry: async (registry: string, repository: string) => {
        asked.push(`${registry}/${repository}`);
        const login = stored[registry];
        return typeof login === 'function' ? login() : login;
      },
    },
  } as unknown as HostSide;
  const handler = hostSideHandler(host, logger, ['secret registry'], { repository: 'acme/api', dockerHost: '' });
  const signal = new AbortController().signal;
  const ask = (...args: unknown[]) => handler('secret', { call: 'registry', args }, signal);
  return { ask, asked, lines };
}

const login = (password: string, from: 'docker' | 'github' = 'docker'): HostRegistryLogin => ({ username: 'octo', serveraddress: 'ghcr.io', password, from });

describe('the registry logins of an operation', () => {
  it('gives the login of the registry of the image in the secrets only, and logs where it came from, never the password', async () => {
    const { ask, asked, lines } = wired({ 'ghcr.io': login('gho_secret', 'github'), 'registry-1.docker.io': login('hub_secret') });
    expect(await ask('ghcr.io', 'acme/app')).toEqual({ value: { given: true, username: 'octo', serveraddress: 'ghcr.io' }, secrets: { [SECRET_REGISTRY]: 'gho_secret' } });
    expect(await ask('registry-1.docker.io', 'library/node')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'hub_secret' } });
    expect(await ask('quay.io', 'team/tool')).toStrictEqual({ value: { given: false } });
    expect(asked).toEqual(['ghcr.io/acme/app', 'registry-1.docker.io/library/node', 'quay.io/team/tool']);
    expect(lines).toEqual([
      'info The registry login for ghcr.io/acme/app (open of acme/api): the worker got the GitHub sign-in as the login for ghcr.io.',
      'info The registry login for docker.io/library/node (open of acme/api): the worker got the login that Docker stored for docker.io.',
      'info The registry login for quay.io/team/tool (open of acme/api): this computer has no login for quay.io.',
    ]);
    expect(lines.join('\n')).not.toMatch(/secret/);
  });

  it('refuses a request that names no registry and repository of an image as the worker normalizes them, and logs it', async () => {
    const { ask, asked, lines } = wired({ 'ghcr.io': login('p') });
    for (const args of [
      ['ghcr.io'],
      ['ghcr.io', 'acme/app', 'more'],
      [42, 'acme/app'],
      ['GHCR.io', 'acme/app'],
      ['ghcr.io', 'acme/app:1'],
      ['ghcr.io', `acme/app@sha256:${'a'.repeat(64)}`],
      ['ghcr.io', 'Acme/app'],
      ['ghcr.io', ''],
      ['docker.io', 'library/node'],
      ['registry-1.docker.io', 'node'],
      ['ghcr.io/acme', 'app'],
      ['a b', 'app'],
      ['[::1]:5000', 'app'],
      ['ghcr.io', 'acme/app\n'],
    ]) {
      await expect(ask(...args), JSON.stringify(args)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(asked).toEqual([]);
    // Each refusal of a request whose arguments are strings is in the log.
    expect(lines.filter((line) => line.startsWith('warn The worker asked for a registry login that is refused'))).toHaveLength(11);
  });

  it(`gives the logins of at most ${MAX_LOGIN_REGISTRIES} registries; a registry without a login counts not, a given one again is fine`, async () => {
    const registries = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'];
    const { ask, asked, lines } = wired(Object.fromEntries(registries.map((registry) => [registry, login(`pw-${registry}`)])));
    expect(await ask('none.example', 'team/app')).toStrictEqual({ value: { given: false } });
    for (const registry of registries.slice(0, MAX_LOGIN_REGISTRIES)) expect(await ask(registry, 'team/app')).toMatchObject({ value: { given: true } });
    // The fifth registry is not asked for at all.
    expect(await ask('e.example', 'team/app')).toStrictEqual({ value: { given: false } });
    expect(asked).not.toContain('e.example/team/app');
    expect(lines.at(-1)).toBe('warn The registry login for e.example/team/app (open of acme/api) is not given: the operation got the logins of 4 registries already (a.example, b.example, c.example, d.example).');
    // A registry whose login the operation got already: its next pull gets it again.
    expect(await ask('a.example', 'team/other')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'pw-a.example' } });
  });

  it('answers one request at a time: a second request while the first is answered is refused', async () => {
    let answer: (value: HostRegistryLogin) => void = () => undefined;
    let calls = 0;
    // The first lookup waits (a credential helper that asks for a password); the next ones answer at once.
    const { ask, asked } = wired({ 'ghcr.io': () => (calls++ === 0 ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(login('p2'))) });
    const first = ask('ghcr.io', 'acme/app');
    await Promise.resolve();
    await expect(ask('ghcr.io', 'acme/other')).rejects.toMatchObject({ code: 'invalid' });
    answer(login('p1'));
    expect(await first).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'p1' } });
    // Afterwards, the next request is answered.
    expect(await ask('ghcr.io', 'acme/other')).toMatchObject({ value: { given: true }, secrets: { [SECRET_REGISTRY]: 'p2' } });
    expect(asked).toEqual(['ghcr.io/acme/app', 'ghcr.io/acme/other']);
  });

  it('ends the request that is answered also when the lookup fails, so the next one is answered', async () => {
    let calls = 0;
    const { ask } = wired({ 'ghcr.io': () => (calls++ === 0 ? Promise.reject(new Error('helper crashed')) : Promise.resolve(login('p'))) });
    await expect(ask('ghcr.io', 'acme/app')).rejects.toMatchObject({ code: 'failed' });
    expect(await ask('ghcr.io', 'acme/app')).toMatchObject({ value: { given: true } });
  });

  it(`refuses the requests after ${MAX_LOGIN_REQUESTS} of an operation`, async () => {
    const { ask, asked } = wired({ 'ghcr.io': login('p') });
    for (let i = 0; i < MAX_LOGIN_REQUESTS; i++) await ask('ghcr.io', 'acme/app');
    await expect(ask('ghcr.io', 'acme/app')).rejects.toMatchObject({ code: 'invalid' });
    expect(asked).toHaveLength(MAX_LOGIN_REQUESTS);
  });
});

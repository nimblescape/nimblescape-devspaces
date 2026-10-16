// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes of RegistryClient.listTags: the limits (20 pages, 4 MiB), each page asks for JSON with the client's
// User-Agent, and a page that the registry redirects keeps its body limit.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { MAX_TAG_LIST_BYTES, MAX_TAG_PAGES, RegistryClient } from './registryClient';

function recording(answer: (request: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (request) => {
      requests.push({ ...request, headers: { ...request.headers } });
      return answer(request);
    },
  };
  return { transport, requests };
}

describe('RegistryClient.listTags, probes', () => {
  it('has the limits of 20 pages of at most 4 MiB', () => {
    expect(MAX_TAG_PAGES).toBe(20);
    expect(MAX_TAG_LIST_BYTES).toBe(4 * 1024 * 1024);
  });

  it('asks for JSON with the User-Agent of the client', async () => {
    const { transport, requests } = recording(() => ({ status: 200, headers: {}, body: '{"tags":["1"]}' }));
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests[0].headers?.Accept).toBe('application/json');
    // The name and the version of package.json.
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string };
    expect(requests[0].headers?.['User-Agent']).toBe(`nimblescape-devspaces/${version}`);
  });

  it('a redirected page keeps the body limit of a tag list', async () => {
    const { transport, requests } = recording((request): HttpResponse =>
      new URL(request.url).host === 'ghcr.io'
        ? { status: 307, headers: { location: 'https://cdn.example/v2/team/app/tags/list' }, body: '' }
        : { status: 200, headers: {}, body: '{"tags":["1"]}' },
    );
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests.map((request) => [new URL(request.url).host, request.maxBodyBytes])).toEqual([
      ['ghcr.io', MAX_TAG_LIST_BYTES],
      ['cdn.example', MAX_TAG_LIST_BYTES],
    ]);
  });
});

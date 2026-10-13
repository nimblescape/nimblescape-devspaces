// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pure rules of the Monitor's background run.
import { describe, expect, it } from 'vitest';
import {
  CLOCK_RESET_MS,
  KEPT_SERVER_VERSIONS,
  RUN_RETRY_DELAYS_MS,
  SERVER_UNUSED_MS,
  STORE_CLEANUP_INTERVAL_MS,
  cleanupDue,
  isNetworkFailure,
  parseCacheRunState,
  qualitiesToFetch,
  runRetryDelay,
  runRetryDue,
  serversToRemove,
} from './backgroundRules';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const commit = (n: number) => n.toString(16).padStart(40, '0');

describe('the state of the background run', () => {
  it('reads the end of the last run and the last cleanup; anything invalid is left out', () => {
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 5, lastCleanupAt: 7 }))).toEqual({ lastEndAt: 5, lastCleanupAt: 7 });
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: -1, lastCleanupAt: '7' }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 1.5 }))).toEqual({});
    expect(parseCacheRunState('not json')).toEqual({});
    expect(parseCacheRunState('[1]')).toEqual({});
    expect(parseCacheRunState('null')).toEqual({});
  });

  it('reads a retry only with its count of at least 1', () => {
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 5, retryAt: 9, retries: 2 }))).toEqual({ lastEndAt: 5, retryAt: 9, retries: 2 });
    expect(parseCacheRunState(JSON.stringify({ retryAt: 9 }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ retryAt: 9, retries: 0 }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ retryAt: 9, retries: 1.5 }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ retryAt: 9, retries: '1' }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ retryAt: -9, retries: 1 }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ retries: 1 }))).toEqual({});
  });
});

describe('the retry of a run that did not reach the network', () => {
  const MINUTE = 60_000;

  it('waits 2, 5, 10, 20 and 30 minutes, then an hour for each further retry', () => {
    expect(RUN_RETRY_DELAYS_MS).toEqual([2, 5, 10, 20, 30, 60].map((minutes) => minutes * MINUTE));
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(runRetryDelay)).toEqual([2, 5, 10, 20, 30, 60, 60, 60].map((minutes) => minutes * MINUTE));
    // A count below 1 (never stored) waits as the first retry.
    expect(runRetryDelay(0)).toBe(2 * MINUTE);
  });

  it('is due at its time, not before, and at once when its time lies far ahead (a corrected clock)', () => {
    expect(runRetryDue(NOW, NOW)).toBe(true);
    expect(runRetryDue(NOW - 1, NOW)).toBe(true);
    expect(runRetryDue(NOW + 1, NOW)).toBe(false);
    expect(runRetryDue(NOW + 60 * MINUTE + CLOCK_RESET_MS, NOW)).toBe(false);
    expect(runRetryDue(NOW + 60 * MINUTE + CLOCK_RESET_MS + 1, NOW)).toBe(true);
  });
});

describe('the failures of the network', () => {
  const coded = (code: string) => Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });

  it.each([
    ['no name resolution', coded('ENOTFOUND')],
    ['a name resolution that failed for now', coded('EAI_AGAIN')],
    ['a refused connection', coded('ECONNREFUSED')],
    ['a connection that broke off', coded('ECONNRESET')],
    ['an aborted connection', coded('ECONNABORTED')],
    ['a connection without an answer', coded('ETIMEDOUT')],
    ['an unreachable network', coded('ENETUNREACH')],
    ['a network that is down', coded('ENETDOWN')],
    ['an unreachable host', coded('EHOSTUNREACH')],
    ['a host that is down', coded('EHOSTDOWN')],
    ['a closed connection', coded('EPIPE')],
    ['an abort', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['a time limit', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['a pull without name resolution', new Error('Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host')],
    ['a pull without an answer', new Error('Get "https://ghcr.io/v2/": dial tcp 140.82.1.1:443: i/o timeout')],
    ['a pull with a refused connection', new Error('dial tcp 127.0.0.1:5000: connect: connection refused')],
    ['a pull with a connection that broke off', new Error('read tcp 10.0.0.2:5000: read: connection reset by peer')],
    ['a pull without network', new Error('dial tcp: connect: network is unreachable')],
    ['a pull without a route', new Error('dial tcp 10.1.1.1:443: connect: no route to host')],
    ['a pull with a slow TLS handshake', new Error('net/http: TLS handshake timeout')],
    ['a pull with a slow registry', new Error('net/http: request canceled (Client.Timeout exceeded while awaiting headers)')],
    ['a pull past its deadline', new Error('context deadline exceeded')],
    ['a name resolution that failed for now (resolver)', new Error('lookup ghcr.io: Temporary failure in name resolution')],
    ['a proxy without an answer', new Error('The proxy proxy.example of the Docker engine did not answer within 10 seconds.')],
    ['a time limit of the monitor', new Error('no answer in time')],
    ['a server error', new Error('the update service answered HTTP 503')],
    ['a rate limit', new Error('the download answered HTTP 429')],
    ['a message alone', 'dial tcp: lookup example: no such host'],
    ['a cause', new Error('fetch failed', { cause: coded('ENOTFOUND') })],
  ])('counts %s', (_label, error) => {
    expect(isNetworkFailure(error)).toBe(true);
  });

  it.each([
    ['an image that the registry does not have', new Error('manifest for example/app:1 not found: manifest unknown')],
    ['a private image', new Error('pull access denied for example/private, repository does not exist or may require docker login')],
    ['a version that is gone', new Error('the update service answered HTTP 404')],
    ['a refused download', new Error('the download answered HTTP 403')],
    ['a wrong checksum', new Error('the SHA-256 of the archive differs')],
    ['a full disk', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })],
    ['a missing file', Object.assign(new Error('no such file'), { code: 'ENOENT' })],
    ['no error', undefined],
    ['null', null],
    ['a number', 503],
    ['a word in another word', new Error('the field host_name_resolution_disabled')],
  ])('does not count %s', (_label, error) => {
    expect(isNetworkFailure(error)).toBe(false);
  });

  it('follows the causes at most 4 deep', () => {
    let error: unknown = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    for (let depth = 0; depth < 4; depth++) error = new Error('wrapped', { cause: error });
    expect(isNetworkFailure(error)).toBe(true);
    expect(isNetworkFailure(new Error('wrapped', { cause: error }))).toBe(false);
  });
});

describe('the cleanup of the store, at most once a day', () => {
  it('is due when it never ran or ran a day ago, not before', () => {
    expect(STORE_CLEANUP_INTERVAL_MS).toBe(DAY);
    expect(cleanupDue(undefined, NOW)).toBe(true);
    expect(cleanupDue(NOW - DAY, NOW)).toBe(true);
    expect(cleanupDue(NOW - DAY + 1, NOW)).toBe(false);
    expect(cleanupDue(NOW, NOW)).toBe(false);
  });

  it('is due when its time lies more than an hour ahead (a corrected clock), not for a small step', () => {
    expect(cleanupDue(NOW + CLOCK_RESET_MS + 1, NOW)).toBe(true);
    expect(cleanupDue(NOW + CLOCK_RESET_MS, NOW)).toBe(false);
  });
});

describe('the qualities of the newest server', () => {
  // Insider only while an open used an insider version within 14 days (a ready insider server in the store does not
  // count: the monitor's own fetches would keep it true for ever).
  it('stable always, insider only while an open used an insider version within 14 days', () => {
    expect(qualitiesToFetch([], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'stable', at: NOW }], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY + 1 }], NOW)).toEqual(['stable', 'insider']);
    expect(qualitiesToFetch([{ quality: 'stable', at: NOW }, { quality: 'insider', at: NOW + DAY }], NOW)).toEqual(['stable', 'insider']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY }], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 100 * DAY }, { quality: 'stable', at: NOW }], NOW)).toEqual(['stable']);
  });
});

describe('the server versions that the cleanup removes', () => {
  const released = [commit(5), commit(4), commit(3), commit(2), commit(1)];
  const old = NOW - SERVER_UNUSED_MS;

  it('keeps the two newest releases, also unused ones, and removes older ones unused for 14 days', () => {
    expect(KEPT_SERVER_VERSIONS).toBe(2);
    const stored = [1, 2, 3, 4, 5].map((n) => ({ commit: commit(n), usedAt: old }));
    expect(serversToRemove(stored, released, NOW).sort()).toEqual([commit(1), commit(2), commit(3)]);
  });

  it('keeps a version used within 14 days, whatever its age, and one used in the future', () => {
    const stored = [
      { commit: commit(5), usedAt: old },
      { commit: commit(4), usedAt: old },
      { commit: commit(3), usedAt: old + 1 },
      { commit: commit(2), usedAt: NOW + DAY },
      { commit: commit(1), usedAt: old },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(1)]);
  });

  it('orders by the releases, not by the use: the newest release stays although another was used later', () => {
    const stored = [
      { commit: commit(5), usedAt: old - DAY },
      { commit: commit(4), usedAt: old - DAY },
      { commit: commit(1), usedAt: old },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(1)]);
  });

  it('a version that the releases do not name is older than all that they name; among those, the last used stays first', () => {
    const unknownA = 'a'.repeat(40);
    const unknownB = 'b'.repeat(40);
    expect(serversToRemove([{ commit: unknownA, usedAt: old }, { commit: commit(1), usedAt: old }, { commit: commit(2), usedAt: old }], released, NOW)).toEqual([unknownA]);
    // No release known of either: the one used last is newer.
    expect(serversToRemove([{ commit: unknownA, usedAt: old - 2 }, { commit: unknownB, usedAt: old - 1 }, { commit: commit(1), usedAt: old }], [], NOW)).toEqual([unknownA]);
  });

  it('removes nothing with two versions or fewer', () => {
    expect(serversToRemove([{ commit: commit(1), usedAt: 0 }, { commit: commit(2), usedAt: 0 }], released, NOW)).toEqual([]);
    expect(serversToRemove([], released, NOW)).toEqual([]);
  });
});

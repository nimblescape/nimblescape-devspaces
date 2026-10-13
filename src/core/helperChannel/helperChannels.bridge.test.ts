// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The probes of the mutation testing of the bridge fallback of openHelperChannel (a daemon without its default bridge
// network), and of the number of a worker name in use. No Docker: the processes of the channel are stand-ins.
import { describe, expect, it } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { silentLogger, type StartedProcess } from '../ports';
import { openHelperChannel } from './helperChannels';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
/** The same engine as the worker answers it (ProbeValue.engine: the values of `GET /info`). */
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/** A channel process that answers hello and the probe. */
function good(): StartedProcess {
  let stdout: ((text: string) => void) | undefined;
  return {
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) {
        const message = parseClientMessage(line);
        if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
        if (message?.t === 'op' && message.op === 'probe') {
          // The engine as its values.
          queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
        }
      }
      return true;
    },
    end: () => {},
    kill: () => {},
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
}

/** A `docker run` that the daemon refuses with `stderr` (exit code 125). */
function refused(stderr: string): StartedProcess {
  let exit: (value: { exitCode: number | null }) => void = () => {};
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (exit = resolve));
  return {
    write: () => true,
    end: () => {},
    kill: () => {},
    onStdout: () => {},
    onStderr: (listener) => {
      queueMicrotask(() => {
        listener(stderr);
        exit({ exitCode: 125 });
      });
    },
    exited,
  };
}

/**
 * Opens with the processes `first`, then a good one, for the window `api`; records the network and the name of each
 * start, the warnings, the information lines, and the lists of containers (`ps`). `engine`: the containers that the
 * list of the engine shows, or a list that fails.
 */
async function openWith(engine: { containers?: readonly string[]; listFails?: boolean }, ...first: Array<() => StartedProcess>) {
  const networks: string[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const lists: string[][] = [];
  const processes = [...first, good];
  const channel = await openHelperChannel(
    {
      start: (args) => {
        networks.push(args[args.indexOf('--network') + 1]);
        names.push(args[args.indexOf('--name') + 1]);
        return processes.shift()!();
      },
      runDirect: async (args) => {
        if (args[0] !== 'ps') return { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false };
        lists.push([...args]);
        if (engine.listFails) return { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', timedOut: false };
        return { exitCode: 0, stdout: (engine.containers ?? []).map((name) => `${name}\n`).join(''), stderr: '', timedOut: false };
      },
      logger: { ...silentLogger, warn: (text) => warnings.push(text), info: (text) => infos.push(text) },
      script: async () => 'SCRIPT',
      helperTag: async () => 'devspace-helper:abc',
      socketPath: async () => '/var/run/docker.sock',
      stateVolume: 'devspace-monitor',
      vscodeVolume: 'devspace-vscode',
      windowName: () => 'api',
    },
    REMOTE,
  ).catch((error: unknown) => {
    throw Object.assign(error as Error, { networks, names });
  });
  channel.close();
  return { networks, names, warnings, infos, lists };
}

/** openWith an engine whose list shows no container. */
async function open(...first: Array<() => StartedProcess>) {
  return openWith({}, ...first);
}

describe('the bridge fallback of openHelperChannel', () => {
  it('the refusal with the name in quotes or in other case starts again without network', async () => {
    for (const stderr of ['docker: Error response from daemon: network "bridge" not found.\n', 'docker: Error response from daemon: Network bridge not found.\n']) {
      const { networks } = await open(() => refused(stderr));
      expect(networks, stderr).toEqual(['bridge', 'none']);
    }
  });

  it('another failure that names the bridge is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: failed to create endpoint on network bridge: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });

  it('only a failure of the channel is retried: an error of the start itself with that text is not', async () => {
    await expect(
      open(() => {
        throw new Error('network bridge not found');
      }),
    ).rejects.toMatchObject({ message: 'network bridge not found', networks: ['bridge'] });
  });

  it('the start without network takes the number 1 again (the refused start created no container), and the warning names the engine', async () => {
    const { networks, names, warnings, lists } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'));
    expect(networks).toEqual(['bridge', 'none']);
    expect(names).toEqual(['devspace-worker-api-1', 'devspace-worker-api-1']);
    expect(lists).toEqual([]);
    expect(warnings.join('\n')).toContain('The Docker engine build-box has no default bridge network');
  });
});

describe('the number of a worker name in use', () => {
  const IN_USE =
    'docker: Error response from daemon: Conflict. The container name "/devspace-worker-api-1" is already in use by container "0123456789ab". You have to remove (or rename) that container to be able to reuse that name.\n';

  it('starts with 1 and lists no container when the name is free', async () => {
    const { names, lists } = await openWith({ containers: ['devspace-worker-api-1'] });
    expect(names).toEqual(['devspace-worker-api-1']);
    expect(lists).toEqual([]);
  });

  it('takes the lowest number that no container has, with the same network, and the log says why', async () => {
    const { networks, names, infos, lists } = await openWith({ containers: ['devspace-worker-api-1', 'devspace-worker-api-2', 'devspace-worker-web-3'] }, () => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'bridge']);
    expect(names).toEqual(['devspace-worker-api-1', 'devspace-worker-api-3']);
    // One list without the worker, of the containers whose name contains the start of a worker name.
    expect(lists).toEqual([['ps', '--all', '--filter', 'name=devspace-worker-', '--format', '{{.Names}}']]);
    expect(infos.join('\n')).toContain('The worker name devspace-worker-api-1 is in use on build-box, so the worker starts as devspace-worker-api-3.');
  });

  it('takes the next number when the list fails, and never a number that Docker refused', async () => {
    expect((await openWith({ listFails: true }, () => refused(IN_USE))).names).toEqual(['devspace-worker-api-1', 'devspace-worker-api-2']);
    // Another window took the free number between the list and the start.
    expect((await openWith({ containers: ['devspace-worker-api-1'] }, () => refused(IN_USE), () => refused(IN_USE))).names).toEqual([
      'devspace-worker-api-1',
      'devspace-worker-api-2',
      'devspace-worker-api-3',
    ]);
  });

  it('starts at most 10 times', async () => {
    const refusals = Array.from({ length: 10 }, () => () => refused(IN_USE));
    await expect(open(...refusals)).rejects.toMatchObject({ names: Array.from({ length: 10 }, (_, index) => `devspace-worker-api-${index + 1}`) });
  });

  it('numbers again from 1 for the start without network', async () => {
    const { networks, names } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'), () => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'none', 'none']);
    expect(names).toEqual(['devspace-worker-api-1', 'devspace-worker-api-1', 'devspace-worker-api-2']);
  });

  it('another failure that is already in use is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: driver failed programming external connectivity: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });
});

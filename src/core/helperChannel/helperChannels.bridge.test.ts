// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The probes of the mutation testing of the bridge fallback of openHelperChannel (a daemon without its default bridge
// network), and of its second name for a worker name in use. No Docker: the processes of the channel are stand-ins.
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
 * Opens with the processes `first`, then a good one; records the network and the name of each start, the warnings, and
 * the information lines.
 */
async function open(...first: Array<() => StartedProcess>) {
  const networks: string[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const processes = [...first, good];
  const channel = await openHelperChannel(
    {
      start: (args) => {
        networks.push(args[args.indexOf('--network') + 1]);
        names.push(args[args.indexOf('--name') + 1]);
        return processes.shift()!();
      },
      runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
      logger: { ...silentLogger, warn: (text) => warnings.push(text), info: (text) => infos.push(text) },
      script: async () => 'SCRIPT',
      helperTag: async () => 'devspace-helper:abc',
      socketPath: async () => '/var/run/docker.sock',
      stateVolume: 'devspace-monitor',
      vscodeVolume: 'devspace-vscode',
    },
    REMOTE,
  ).catch((error: unknown) => {
    throw Object.assign(error as Error, { networks, names });
  });
  channel.close();
  return { networks, names, warnings, infos };
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

  it('the second start has a container name of its own, and the warning names the engine', async () => {
    const { networks, names, warnings } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'));
    expect(networks).toEqual(['bridge', 'none']);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(warnings.join('\n')).toContain('The Docker engine build-box has no default bridge network');
  });
});

describe('the second name of openHelperChannel for a worker name in use', () => {
  const IN_USE =
    'docker: Error response from daemon: Conflict. The container name "/devspace-worker-api-3f9a" is already in use by container "0123456789ab". You have to remove (or rename) that container to be able to reuse that name.\n';

  it('starts again with the same network and new random characters, and the log says why', async () => {
    const { networks, names, infos } = await open(() => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'bridge']);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^devspace-worker-window-[0-9a-f]{4}$/);
    expect(infos.join('\n')).toContain('The name of the worker on build-box was in use');
  });

  it('draws only once more: a second name in use fails the open', async () => {
    await expect(open(() => refused(IN_USE), () => refused(IN_USE))).rejects.toMatchObject({ networks: ['bridge', 'bridge'] });
  });

  it('draws once more also for the start without network', async () => {
    const { networks } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'), () => refused(IN_USE));
    expect(networks).toEqual(['bridge', 'none', 'none']);
  });

  it('another failure that is already in use is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: driver failed programming external connectivity: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host of an operation. The current Docker context is read at the start of each operation (`docker context
// inspect`), never cached beyond it: a context switch while VS Code runs takes effect for the next operation. An
// operation keeps the host it started with: its Docker calls get DOCKER_CONTEXT with the name of the context that it
// read (BootstrapDocker.run), so a switch in the middle does not move half of it to another engine.
import { AsyncLocalStorage } from 'async_hooks';
import { errorMessage } from '../errors';
import { Messages } from '../messages';
import type { Logger, RunOptions, RunResult } from '../ports';
import { envValue } from './dockerCli';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, parseContextInspect, type DockerTarget } from './dockerHost';

/**
 * The target when the current Docker context cannot be read and DOCKER_HOST is not set (isUnreadableDockerTarget).
 * Without the name of a context, the Docker calls would go to the context that the Docker CLI finds, perhaps on
 * another computer, while the operation would record the local Docker. So it counts as not supported: every
 * operation refuses it with a message, and its host matches no devspace.
 */
export const UNREADABLE_DOCKER_TARGET: DockerTarget = { kind: 'unsupported', host: Messages.unreadableDockerContextHost, endpoint: '' };

/**
 * The target of an operation while it runs. Timers and listeners that an operation creates keep its store after it
 * ended (AsyncLocalStorage); `active` is false then, so they read the current context again.
 */
interface OperationScope {
  target: DockerTarget;
  active: boolean;
}

const operationTargets = new AsyncLocalStorage<OperationScope>();

/** The Docker target of the operation that runs now, if any. */
export function operationDockerTarget(): DockerTarget | undefined {
  const scope = operationTargets.getStore();
  return scope?.active ? scope.target : undefined;
}

/** Runs `fn` outside of any operation: its Docker calls read the current context themselves (attachDiagnostics.ts). */
export function outsideOperation<T>(fn: () => Promise<T>): Promise<T> {
  return operationTargets.exit(fn);
}

/** Runs `fn` as an operation on `target` (see the module comment). */
export async function runWithDockerTarget<T>(target: DockerTarget, fn: () => Promise<T>): Promise<T> {
  const scope: OperationScope = { target, active: true };
  try {
    return await operationTargets.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** Time limit of `docker context inspect` (it reads only local files; the daemon is not asked). */
export const CONTEXT_INSPECT_TIMEOUT_MS = 15_000;

/** A name of a Docker context as the Docker CLI accepts it (never an option). */
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/** The part of BootstrapDocker that the resolver uses. */
export interface ContextReader {
  isInstalled(): boolean;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Reads the current Docker target, and runs operations with it. */
export class DockerTargets {
  private lastTarget: DockerTarget | undefined;
  private readonly listeners = new Set<(target: DockerTarget) => void>();
  /**
   * The number of the newest read that started, and of the newest one applied (of overlapping reads, the one that
   * started last wins).
   */
  private readsStarted = 0;
  private readApplied = 0;

  constructor(
    private readonly docker: ContextReader,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The target of the last read, for synchronous callers (the Docker setup). Undefined before the first read. */
  get last(): DockerTarget | undefined {
    return this.lastTarget;
  }

  /**
   * Reads the current target now: DOCKER_HOST of VS Code's environment if set, else the current Docker context (which
   * DOCKER_CONTEXT may name). Without a Docker CLI, the local Docker. When the context cannot be read,
   * UNREADABLE_DOCKER_TARGET (logged), or DOCKER_HOST when it is set. Never throws.
   */
  async resolve(): Promise<DockerTarget> {
    const read = ++this.readsStarted;
    const target = await this.read();
    // A read that started before a newer one finished (overlapping reads) does not overwrite what that one found.
    if (read < this.readApplied) return target;
    this.readApplied = read;
    this.lastTarget = target;
    for (const listener of [...this.listeners]) {
      try {
        listener(target);
      } catch (error) {
        this.logger.warn(`A listener of the Docker host failed: ${errorMessage(error)}`);
      }
    }
    return target;
  }

  /**
   * The Docker host in the sidebar: `listener` gets every target that `resolve` reads, except one of a read that a
   * newer read overtook. Returns the function that removes it.
   */
  onDidResolve(listener: (target: DockerTarget) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The target of the running operation, or a fresh read outside of one. */
  async current(): Promise<DockerTarget> {
    return operationDockerTarget() ?? this.resolve();
  }

  /** The Docker host of `current()` ('' for the local Docker). */
  async host(): Promise<string> {
    return (await this.current()).host;
  }

  /**
   * Runs `fn` as one operation: the target is read once at its start (unless an operation runs already, whose target
   * `fn` keeps).
   */
  async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (operationDockerTarget()) return fn();
    const target = await this.resolve();
    return runWithDockerTarget(target, fn);
  }

  /**The target of the Docker context `name` (for example the one in a window's authority, or `default`), whatever
   *context is current. With DOCKER_HOST set in VS Code's environment, DOCKER_HOST decides, as for `resolve`. Undefined
   *without a Docker CLI, for a name that is not a context name, or when the
   * context cannot be read (logged). Does not change `last` and tells no listener. Never throws.
   */
  async ofContext(name: string): Promise<DockerTarget | undefined> {
    // Never throws, also not from the check of the CLI or of DOCKER_HOST.
    try {
      if (!CONTEXT_NAME.test(name) || !this.docker.isInstalled()) return undefined;
      const dockerHost = envValue(this.env, 'DOCKER_HOST', this.platform)?.trim();
      if (dockerHost) return dockerTargetOf(dockerHost, undefined);
      const result = await this.docker.run(['context', 'inspect', '--format', '{{json .}}', name], { timeoutMs: CONTEXT_INSPECT_TIMEOUT_MS });
      const parsed = result.exitCode === 0 ? parseContextInspect(result.stdout) : undefined;
      if (parsed) return dockerTargetOf(parsed.endpoint, parsed.name);
      this.logger.warn(`The Docker context ${name} could not be read: ${(result.stderr || result.stdout).trim()}`);
    } catch (error) {
      this.logger.warn(`The Docker context ${name} could not be read: ${errorMessage(error)}`);
    }
    return undefined;
  }

  private async read(): Promise<DockerTarget> {
    if (!this.docker.isInstalled()) return LOCAL_DOCKER_TARGET;
    const dockerHost = envValue(this.env, 'DOCKER_HOST', this.platform)?.trim();
    try {
      // With DOCKER_HOST set, the CLI inspects the context `default`, whose endpoint is DOCKER_HOST.
      const result = await this.docker.run(['context', 'inspect', '--format', '{{json .}}'], { timeoutMs: CONTEXT_INSPECT_TIMEOUT_MS });
      const parsed = result.exitCode === 0 ? parseContextInspect(result.stdout) : undefined;
      if (!parsed) return this.unreadable(dockerHost, (result.stderr || result.stdout).trim());
      return dockerTargetOf(dockerHost ? dockerHost : parsed.endpoint, dockerHost ? undefined : parsed.name);
    } catch (error) {
      return this.unreadable(dockerHost, errorMessage(error));
    }
  }

  /** The target when the current context cannot be read: DOCKER_HOST decides when it is set, else nothing (logged). */
  private unreadable(dockerHost: string | undefined, detail: string): DockerTarget {
    if (dockerHost) {
      this.logger.warn(`The current Docker context could not be read. DOCKER_HOST is used: ${detail}`);
      return dockerTargetOf(dockerHost, undefined);
    }
    this.logger.warn(`The current Docker context could not be read. Devspaces does nothing with Docker until it can be read: ${detail}`);
    return UNREADABLE_DOCKER_TARGET;
  }
}

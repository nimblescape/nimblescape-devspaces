// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Extension entry (esbuild entry of dist/extension.js): the composition root. activate() builds the components,
// registers the commands and listeners, and runs the tasks of the window role. Only the open pipeline of a restored
// window (role A) is awaited; everything else runs in the background.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { describeDockerHost, dockerHostOf, isOnDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, findRemoteContext, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers } from '../core/helper/helperPrebuild';
import { MissingHelperBuild } from '../core/helper/missingHelperBuild';
import { HelperImages, helperDockerSocket } from '../core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { systemClock } from '../core/ports';
import { usableTimeZone } from '../core/remoteMonitor/cron';
import { monitorSettingsOf } from './monitorSettings';
import { REMOTE_MONITOR_VOLUME } from '../core/remoteMonitor/protocol';
import { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { ClosingWork } from '../core/session/closingWork';
import { heartbeatWiring } from '../core/session/heartbeatWiring';
import { WindowHeartbeats, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
import { isHandedOffStop, releaseDevspace } from '../core/session/windowRelease';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { StoragePaths } from '../core/storage/paths';
import { ConfigCheckStore } from '../core/storage/configChecks';
import { bundleHash } from '../core/loader/pipeLoader';
import { DevspaceRegistry } from '../core/storage/registry';
import { findWindowDevspace, restoreAfterPrebuild } from './windowDevspace';
import { workerMonitor } from './workerMonitor';
import { defaultExtensionEntries, windowVscodeServer } from './vscodeServer';
import { HELPER_DOCKER_SOCKET, VSCODE_STORE_VOLUME } from '../core/names';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings } from '../core/types';
import { VsCodeGitHubAuth, ghcrRejectionReporter } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { dockerAdapterOptions } from './dockerAdapterOptions';
import { DockerHostIndicator } from './dockerHostIndicator';
import { DockerSetup } from './dockerSetup';
import { OutputChannelLogger } from './logger';
import { updateOwnersContextKey } from './ownerSelector';
import { updateDevspacesOnlyContextKey } from './devspacesOnly';
import { isProcessAlive } from '../core/session/sessionRules';
import { extensionFlow, extensionHostSide } from './hostSide';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { PreviewWorkerRunner } from './groupsPreviewRunner';
import { RemoteDockerCommands } from './remoteDockerCommands';
import { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import { SessionCoordinator } from './sessionCoordinator';
import { affectsSettings, readSettings, warnInvalidHostAccessChecksOff } from './settings';
import { Sidebar } from './sidebar';
import { DevspaceStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, expandAll, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

/** Kept for deactivate(). */
let coordinator: SessionCoordinator | undefined;
/**
 * The work of deactivate() (the release of the window's devspace, bounded). VS Code disposes the subscriptions right
 * after it calls deactivate(); the worker channels, the preparation of the heartbeats, and the logger are disposed only
 * after it settled (ClosingWork.deferred), so the release still has its worker, can open it again, and logs to a live
 * channel.
 */
const closingWork = new ClosingWork();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The reopen rule measures the age of the reopen record at this time, before any await.
  const activatedAt = systemClock.now();
  const logger = new OutputChannelLogger();
  // The release of deactivate() still logs.
  context.subscriptions.push(closingWork.deferred(logger));
  try {
    await activateExtension(context, logger, activatedAt);
  } catch (error) {
    logger.error('Devspaces could not be started.', error);
    throw error;
  }
}

/**
 * The synchronous `closing` write and the reopen record first. Then, best effort and within about 2 seconds
 * (CLOSE_RELEASE_BOUNDS), the recorded state of the repository and the short release of the window's devspace; VS
 * Code gives deactivate() little time, and a lost release leaves the long limit of the heartbeats.
 */
export function deactivate(): Promise<void> | undefined {
  // Never throws; the disposals of ClosingWork.deferred wait for this promise.
  return closingWork.begin(() => coordinator?.deactivate());
}

async function activateExtension(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger,
  activatedAt: number,
): Promise<void> {
  const platform = process.platform;
  const env = process.env;
  const paths = new StoragePaths(context.globalStorageUri.fsPath);
  try {
    paths.ensureDirectoriesSync();
  } catch (error) {
    logger.warn(`The storage folder ${paths.root} could not be created: ${errorMessage(error)}`);
  }
  let settings: ExtensionSettings = readSettings();
  const getSettings = (): ExtensionSettings => settings;
  // Invalid entries of devspace.hostAccessChecksOff are ignored, with one warning (again only when they change).
  let invalidHostAccessEntries = warnInvalidHostAccessChecksOff(logger, '');

  const runner = new NodeProcessRunner();
  const dockerPath = findDockerCli(env, platform);
  logger.info(dockerPath ? `Docker CLI: ${dockerPath}` : 'The Docker CLI was not found.');
  // Set below; the adapter reports each `docker info` to it (context key devspace.dockerReady).
  let dockerSetup: DockerSetup | undefined;
  // The worker (the helper channels), set below; its failed opens are tried again at once when the Docker engine begins
  // to answer.
  let helperChannels: HelperChannels | undefined;
  // The background build of a helper image that the refresh found missing, and the sidebar that it refreshes
  // afterwards; both set below.
  let missingHelperBuild: MissingHelperBuild | undefined;
  let sidebarOfBuild: Sidebar | undefined;
  let daemonRunning = false;
  const adapterOptions = dockerAdapterOptions(() => dockerSetup);
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload. The
  // Docker CLI of the extension is only the bootstrap's (BootstrapDocker).
  const docker = new BootstrapDocker(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
  });
  // The Docker host is the current Docker context, read at the start of each operation.
  const targets = new DockerTargets(docker, env, logger, platform);
  const remoteState = new RemoteDockerState(paths.remoteDocker);
  const sshPath = (): string | undefined => findExecutable('ssh', env, platform);
  // The SSH check before the Docker calls to a remote host; a success counts for a minute per host.
  const sshLogins = new SshLoginCache();
  const remoteDeps = (): RemoteReachabilityDeps => ({ docker, runner, state: remoteState, logger, sshPath: sshPath(), env, sshLogins });
  const registry = new DevspaceRegistry(paths, systemClock, { logger });
  const needsRestore = (): Promise<boolean> => registry.needsRestore();
  const sessionFiles = new SessionFiles(paths);
  const disconnectRequests = new DisconnectRequests(paths.root);
  const auth = new VsCodeGitHubAuth(logger);
  context.subscriptions.push(auth);
  // Credential helpers (docker-credential-*) are found like the Docker CLI, also with the short PATH of the extension host.
  const credentialEnv = dockerProcessEnv(env, platform, dockerPath);
  const credentials = new DockerCredentialStore(runner, {
    env: credentialEnv,
    platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, credentialEnv, platform),
    logger,
  });
  // The sign-in fix: a 401 of GitHub (here the token service of ghcr.io for the GitHub session) reaches auth.ts, which
  // ignores tokens that belong to no current session (for example a token of the Docker credentials).
  const registryClient = new RegistryClient(nodeHttpsTransport, withGitHubPackagesFallback(credentials.provider(), auth), logger, {
    onCredentialsRejected: ghcrRejectionReporter(auth),
  });
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  // The helper image of the bootstrap, apart from the steps of the workspace helper (the worker's).
  const helper = new HelperImages({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
    // The digest of the base image is read with this registry client and the credentials of this computer (for ghcr.io
    // also the GitHub sign-in), with its own time limit of 5 seconds: at the build of a missing tag, and by the weekly
    // check of the maintaining ensure (the preparation of the worker for an operation `open`, and the background
    // prebuild).
    statePath: paths.helperState,
    baseDigest: registryBaseDigest(registryClient),
    // The engine of the operation (its key: '' for the local Docker, else the host), without its socket, which only the
    // steps of the workspace helper read (the worker's own; the socket mount of the worker is engineSocket below).
    engine: async () => ({ key: (await targets.current()).host }),
    // A worker that could not be opened for want of the helper image is tried again at once. A build that succeeded
    // also ends the wait of the heartbeats' builds on its engine (the target of the operation that built it; every wait
    // when it is not known), in heartbeatWiring.
    onImageBuilt: () => {
      helperChannels?.clearFailures();
      heartbeats.imageBuilt();
      // A build (a Start, for example) also ends the wait after a failed background build.
      missingHelperBuild?.clearFailures();
    },
  });
  // The preparation that a heartbeat starts (the helper image for the worker, and for a repair) runs with its own long
  // signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when the window closes); the deadline of the heartbeat's attempt ends
  // only its wait, so the next attempt joins the build instead of starting it again. After a failed build for a
  // heartbeat, the next one on that engine waits 1, 2, then 5 minutes (REPAIR_BACKOFF_MS); a heartbeat within the wait
  // fails at once and counts towards the warning after failed heartbeats (HEARTBEAT_WARN_AFTER_FAILURES). Only a build
  // that started and failed starts the wait; within it a heartbeat goes on when the helper tag is present
  // (presentImage, never a build), and any successful preparation there ends it. The helper image of the worker and of
  // a repair of a heartbeat is built on its engine. This wiring (the preparation disposed with the window,
  // onImageBuilt, the worker's preparation and the repair through heartbeatHelperImage) is heartbeatWiring, tested in
  // core.
  const heartbeats = heartbeatWiring({
    helper,
    inTarget: runWithDockerTarget,
    onOutput: (text) => logger.output(text),
    operationTarget: operationDockerTarget,
    // The preparation is disposed only after the release of deactivate(), which may need to open the worker again.
    subscriptions: closingWork.deferredSubscriptions(context.subscriptions),
  });
  const heartbeatPreparation = heartbeats.preparation;
  // The worker per window and Docker engine (the helper channel, dist/helperChannel.js), local and remote. Every
  // operation runs in it; the extension sends no Docker call of its own through it. An operation makes it ready first
  // (the helper image, then the open), and is refused when that fails. Its socket mount is the one of the workspace
  // helper on that engine.
  const channelScriptPath = context.asAbsolutePath(path.join('dist', 'helperChannel.js'));
  // The source of the socket mount on the host of an engine, for the worker and the Monitor container: the
  // recorded socket of a rootless remote engine, else /var/run/docker.sock there; on the local Docker the socket of its
  // endpoint.
  const engineSocket = async (target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>): Promise<string> =>
    target.kind === 'remote' ? ((await remoteState.rootlessSocket(target.host)) ?? HELPER_DOCKER_SOCKET) : helperDockerSocket(env, platform, target.endpoint);
  let channelScript: Promise<string> | undefined;
  const workerScript = (): Promise<string> => {
    channelScript ??= fs.promises.readFile(channelScriptPath, 'utf8');
    // A failed read is tried again at the next open.
    channelScript.catch(() => (channelScript = undefined));
    return channelScript;
  };
  // The remembered check results of the configurations, each stamped with the hash of the worker's code (the script
  // that this extension pipes into its workers), so an update forgets them.
  let workerCode: Promise<string> | undefined;
  const configChecks = new ConfigCheckStore(paths.configChecksDir, () => {
    workerCode ??= workerScript().then(bundleHash);
    workerCode.catch(() => (workerCode = undefined));
    return workerCode;
  });
  // When the refresh of the sidebar finds the helper image of an engine missing (for example after a purge of its
  // images), this window builds it in the background, once at a time per engine, and after a failure not again there
  // within 10 minutes (a Start, Stop or Delete builds it at once, as before). The build is the one of Start, Stop and
  // Delete (the preparation of their worker, `prepare` below, without the maintenance of an open: the same Dockerfile,
  // tag and privileges, and the window's shared build, which a Start at the same time joins); only when the engine
  // answers (as the background prebuild: Docker is never started, a remote host gets the SSH check without questions
  // first). Shown in the status bar; then the sidebar refreshes.
  const helperBuilds = new MissingHelperBuild({
    engineAnswers: (target, signal) =>
      runWithDockerTarget(target, () =>
        dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
      ),
    build: (target, signal) => heartbeats.prepareWorker(target, signal),
    progress: (target, work) =>
      Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Devspaces: preparing ${describeDockerHost(target.host)}…` }, work),
      ),
    onBuilt: () => {
      sidebarOfBuild?.refreshStates().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    onChange: () => {
      sidebarOfBuild?.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    logger,
  });
  missingHelperBuild = helperBuilds;
  // Cancelled when the window closes, after the release of deactivate() (which may join its build), as the preparations
  // of the heartbeats.
  context.subscriptions.push(closingWork.deferred({ dispose: () => helperBuilds.dispose() }));
  const channels = new HelperChannels({
    logger,
    // The refresh found no helper image (see helperBuilds above).
    onRefreshWithoutHelper: (target) => {
      void helperBuilds.request(target);
    },
    // The helper image on the engine of the operation, as withDevspaceLock ensures it before the lock (only a
    // missing tag is built). For a heartbeat, with the long signal. For an operation `open`, the maintaining ensure
    // with its `maintenance` (heartbeatWiring).
    prepare: async (target, signal, maintenance) => {
      // For a heartbeat, no new build on this engine within the wait after a failed one; within it, the heartbeat goes
      // on when the tag is present (heartbeatWiring).
      await heartbeats.prepareWorker(target, signal, maintenance);
    },
    // The refresh of the sidebar only checks that the helper image is present.
    checkPresent: async (target, signal) => {
      await runWithDockerTarget(target, () => helper.checkImagePresent({ signal }));
    },
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => docker.start(args),
          runDirect: (args, options) => docker.run(args, options),
          logger,
          script: workerScript,
          helperTag: async () => helperImageTag(await fs.promises.readFile(helperDockerfile, 'utf8')),
          socketPath: engineSocket,
          // The lock files of the devspaces, in the volume of the Monitor of the engine.
          stateVolume: REMOTE_MONITOR_VOLUME,
          // The shared VS Code server store of the engine, which the worker mounts read-write.
          vscodeVolume: VSCODE_STORE_VOLUME,
        },
        target,
      ),
  });
  helperChannels = channels;
  // The extension relays no Docker call through the worker (its pipeline runs there). Disposed after the release of
  // deactivate() (bounded; it never rejects), which needs the worker.
  context.subscriptions.push(
    closingWork.deferred({
      dispose: () => {
        channels.dispose();
      },
    }),
  );
  // The heartbeats, the check of a container and the Git state of a release, as operations of the worker of the engine
  // (workerFlow is set below, before the first call). Also the ensure of the Monitor container (on every
  // engine), with the settings of this computer for its background run (cacheUpdateSchedule, in its time zone); the
  // worker holds the script of the monitor and runs from the helper image.
  const monitorCalls = workerMonitor({
    flow: (op, params, options) => workerFlow(op, params, options),
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    logger,
  });
  // The source of the heartbeats and the owner of a permanent Monitor (computer.id); created by the first reader.
  const computerId = (): string => readOrCreateComputerId(paths.computerId);
  // The open carries the settings of this computer for the Monitor of its engine (no image prefixes and no
  // image list): the schedule of the monitor's whole background run (cacheUpdateSchedule), and its mode, the same on
  // every engine (monitorRunsPermanently with stopMonitorWhenIdle). In monitorSettings.ts, tested by its behaviour.
  const monitorSettings = monitorSettingsOf({
    settings: getSettings,
    // An unknown zone of Node.js (`Etc/Unknown`) is UTC.
    timeZone: () => usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    computerId,
  });
  const connection = new ConnectionAdapter(logger);
  // The heartbeats of this window to the Monitor container of the engine of each devspace it uses, through
  // this window's worker of that engine (its operation `heartbeat`; the worker is made ready first); a missing monitor
  // is started again as the open starts it. `signal` aborts at the deadline of the heartbeat's attempt; it ends only
  // the wait for the helper image, whose build runs with the long signal of the preparation. The same wait after a
  // failed build on this engine as for the worker of a heartbeat; within it, the repair goes on with the tag when it is
  // present (heartbeatWiring.repair). The repair is the operation `monitorEnsure` of the worker of that engine.
  const repairSessionMonitor = heartbeats.repair((target, signal) => monitorCalls.monitorEnsure(target, monitorSettings.forTarget(target), signal));
  // Set below (the coordinator makes the ID of this window).
  let windowCoordinator: SessionCoordinator | undefined;
  const windowHeartbeats = new WindowHeartbeats({
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    connected: () => windowCoordinator?.devspaceId ?? null,
    registry,
    settings: getSettings,
    sourceId: computerId,
    // The engine of the connected devspace is the one of this window's own Docker context (its authority, which its
    // status file records as dockerContext), also for a local devspace; never the global current context when the
    // window has its own (resolveHeartbeatEngine).
    engineFor: (devspace, use) =>
      resolveHeartbeatEngine(devspace, use, {
        windowContext: (shown) => (connection.currentContainerName() === shown.containerName ? connection.currentDockerContext() : undefined),
        current: () => outsideOperation(() => targets.resolve()),
        ofContext: (name) => outsideOperation(() => targets.ofContext(name)),
        // Only an existing context; a heartbeat never creates one (a context that the user removed is not made again by
        // a tick).
        remoteContext: (host) =>
          outsideOperation(() => findRemoteContext(docker, host)).catch((error: unknown) => {
            logger.warn(`The Docker context of ${host} could not be had: ${errorMessage(error)}`);
            return undefined;
          }),
      }),
    // In the scope of a heartbeat, the worker's preparation runs with the long signal (heartbeatPreparation). The
    // operation `heartbeat` of the worker of that engine.
    send: (target, input, signal) => heartbeatPreparation.scope(() => monitorCalls.heartbeat(target, input, signal)),
    repair: repairSessionMonitor,
    // The container of the devspace (its name in the registry) on that engine; any failure counts as not there. The
    // operation `windowState` of the worker of that engine.
    containerExists: (target, devspace, signal) => heartbeatPreparation.scope(() => monitorCalls.containerExists(target, devspace, signal)),
    warn: (message) => {
      void vscode.window.showWarningMessage(message).then(undefined, (error: unknown) => logger.error('Could not show the message.', error));
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => windowHeartbeats.dispose() });
  // One stored list per GitHub account.
  const discovery = new DiscoveryService(
    new GitHubApi(nodeHttpsTransport, logger, {
      onUnauthorized: (token) => auth.reportRejectedToken(token),
      onAuthorized: (token) => auth.reportAcceptedToken(token),
    }),
    (accountId) => paths.repositoriesFile(accountId),
    logger,
    systemClock,
    // The setting `owners` is the scan scope; GitHub is asked only about these owners.
    { scope: () => getSettings().owners },
  );
  const ui = new VsCodePipelineUi(auth, logger, () => logger.show(), systemClock, () => getSettings().updateContainer ?? 'notify');
  const sessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    settings: getSettings,
    windowDockerContext: () => connection.currentDockerContext(),
    windowHeartbeats,
    // The release of a devspace this window leaves.
    release: (devspaceId, bounds) =>
      releaseDevspace(
        {
          registry,
          settings: getSettings,
          // Status files, pending connection files, and busy marks of other windows.
          otherWindowUses: (devspace) => sessionCoordinator.otherWindowUses(devspace),
          // The Git state, read in the running dev container as its user, on the engine this window uses it on, through
          // its worker.
          recordGitState: async (devspace, signal) => {
            const target = await windowHeartbeats.connectedEngine(devspace);
            if (target === undefined) return;
            // The operation `recordGitState` of the worker of that engine.
            await heartbeatPreparation.scope(() => monitorCalls.recordGitState(target, devspace, signal));
          },
          send: (id, limitSeconds, signal) => windowHeartbeats.release(id, limitSeconds, signal),
          // A Stop that this window handed off (its pending operation `stop`) goes to the Monitor instead of
          // the release.
          stop: {
            handedOff: async (devspace) => isHandedOffStop(await sessionFiles.readOperation(devspace.id), sessionCoordinator.windowId),
            send: (id, signal) => windowHeartbeats.sendStop(id, signal),
          },
          // The last use, for Delete's note, at the start of every release.
          markSeenInUse: (devspace, at) => registry.markSeenInUse(devspace.id, at),
          logger,
        },
        devspaceId,
        bounds,
      ),
    // A window that starts connected (a reload) was seen using its devspace.
    markSeenInUse: (devspaceId, at) => registry.markSeenInUse(devspaceId, at),
  });
  windowCoordinator = sessionCoordinator;
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  // The flows that run in the worker of the current engine (the worker is the deputy of this computer), with the
  // HostSide of this computer answering their requests; one for the service (also the token removal of the controller)
  // and the calls to the Monitor. The containers that this window remembers, for its pipeline and its worker.
  const lifecycleMemory = windowLifecycleMemory();
  const workerFlow = extensionFlow(
    channels,
    () => targets.current(),
    extensionHostSide({
      registry,
      sessionFiles,
      ui,
      auth,
      credentials,
      windowId: sessionCoordinator.windowId,
      // The busy marks that a flow sets for this window, as its own pipeline sets them.
      pid: process.pid,
      clock: systemClock,
      isProcessAlive: (pid: number) => isProcessAlive(pid),
      // The profile of the account and the window's memory, for the open in the worker.
      viewer: (token, signal) => discovery.viewer(token, signal),
      lifecycleMemory,
      // The remembered check results of the configurations (this extension's storage).
      configChecks,
      logger,
    }),
    logger,
  );
  // The operations of this window, each a flow in the worker of the Docker target; the pipeline runs there
  // (DevspaceService), never here.
  const service = new DevspaceOperations({
    flow: workerFlow,
    registry,
    sessionFiles,
    auth,
    lifecycleMemory,
    // The refresh of the sidebar in one operation of the worker of the Docker target of the operation (outside of an
    // operation, of the current one; never read directly). Within an operation, the worker is made ready first; when it
    // cannot be, the refresh fails (never read directly).
    workerRefresh: async (devspaces) => {
      // Always through the worker, of the target of the operation or else the current one.
      const target = operationDockerTarget() ?? (await targets.current());
      try {
        return await channels.refresh(target, devspaces);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || error.code !== 'unavailable') throw error;
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
    },
    // Whether the Docker engine of the current target answers (Stop and the refresh do nothing without it).
    dockerRunning: () => docker.isRunning(),
    ui,
    logger,
    clock: systemClock,
    owner: { windowId: sessionCoordinator.windowId, pid: process.pid },
    // The id of this computer in the Monitor, for the `forget` of Delete in the worker.
    monitorSource: computerId,
    settings: getSettings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    // New devspaces record the Docker host; only its devspaces are used. An endpoint that is neither local nor
    // SSH is refused by every operation and never read.
    dockerTarget: () => targets.current(),
    // The settings that an open carries for the Monitor of its engine (the worker makes sure that the monitor
    // runs, and sends its first heartbeat). The Docker host of the open is empty for the local Docker and names the SSH
    // host otherwise. The image references in use come with it from the registry
    // (DevspaceOperations.referencesInUse); there is no image list.
    openMonitor: (dockerHost) => ({ images: monitorSettings.forOpen(dockerHost) }),
    // The commit and quality of this VS Code (product.json under vscode.env.appRoot, read once), which an open sends
    // when the build qualifies.
    vscodeServerOfWindow: windowVscodeServer(vscode.env.appRoot, (file) => fs.promises.readFile(file, 'utf8'), (message) => logger.info(message)),
    // The user's default extensions of the Dev Containers extension, which an open with a VS Code server carries for
    // the shared extension cache (read at each open).
    defaultExtensionsOfWindow: () => defaultExtensionEntries(vscode.workspace.getConfiguration('dev.containers').get<unknown>('defaultExtensions'), (message) => logger.info(message)),
    // The local Docker is started when needed; a remote host is only checked (never a Docker Desktop start).
    startDocker: async ({ onStarting, signal }) =>
      startDockerFor(
        await targets.current(),
        () => ensureDockerRunning(docker, runner, logger, { platform, env, onStarting, signal }),
        remoteDeps(),
        signal,
      ),
  });

  const tree = new RepositoriesTreeProvider(logger);
  const view = vscode.window.createTreeView<TreeNode>(REPOSITORIES_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new DevspaceStatusBar();
  context.subscriptions.push(tree, view, statusBar);
  // The view's title and its first row name the Docker host (also the local Docker).
  const dockerHostIndicator = new DockerHostIndicator(view, logger, (host) => tree.setDockerHost(host));
  context.subscriptions.push({ dispose: targets.onDidResolve((target) => dockerHostIndicator.update(target, docker.isInstalled())) });
  // While no Docker CLI is found, the sidebar shows the Docker setup (welcome view) instead of the repositories: when
  // no remote Docker host is configured and the local Docker is not available, the repositories are not shown.
  const setup = new DockerSetup({
    docker,
    runner,
    logger,
    showLog: () => logger.show(),
    platform,
    env,
    // The CLI was found or lost: the sidebar renders again and shows the repositories or the setup.
    onDidChangeInstalled: () => {
      sidebar.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    // The current Docker context points to another computer (as last read). Without a Docker CLI no context can be
    // read, so the setup shows.
    remoteDockerHostConfigured: () => targets.last?.kind === 'remote',
    // Start Docker never starts Docker Desktop for a remote host; it only checks that host.
    startDocker: async (signal, onStarting) =>
      startDockerFor(
        await targets.current(),
        () => ensureDockerRunning(docker, runner, logger, { platform, env, signal, onStarting }),
        remoteDeps(),
        signal,
      ),
  });
  dockerSetup = setup;
  context.subscriptions.push(setup);
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator: sessionCoordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: getSettings,
    dockerSetupRequired: () => setup.setupRequired,
    dockerHost: () => targets.host(),
    dockerTargets: targets,
    view,
    // The reason of a state that could not be read (the background build of the helper image).
    helperBuilds,
  });
  sidebarOfBuild = sidebar;
  setup.initialize();
  const repositoryGroupsEditor = new RepositoryGroupsEditor({
    extensionUri: context.extensionUri,
    logger,
    groupingInput: () => sidebar.groupingInput(),
    onDidRender: sidebar.onDidRender,
    previewRunner: new PreviewWorkerRunner(context.asAbsolutePath(path.join('dist', 'groupsPreviewWorker.js'))),
  });
  context.subscriptions.push(repositoryGroupsEditor);
  const controller = new Controller({
    logger,
    registry,
    registryNeedsRestore: needsRestore,
    sessionFiles,
    disconnectRequests,
    docker,
    // The flows of the window, also the token removal, run in the worker of the current engine through `service` (the
    // worker is the deputy of this computer).
    service,
    discovery,
    auth,
    connection,
    coordinator: sessionCoordinator,
    sidebar,
    statusBar,
    settings: getSettings,
    dockerSetup: setup,
    repositoryGroupsEditor,
    viewVisible: () => view.visible,
    expandAll: () => expandAll(view, tree.getModel()),
    development: context.extensionMode === vscode.ExtensionMode.Development,
    dockerTargets: targets,
    remoteDocker: new RemoteDockerCommands({
      docker,
      runner,
      targets,
      state: remoteState,
      logger,
      showLog: () => logger.show(),
      sshHosts: () => parseSshConfig(nodeSshConfigFiles, { home: os.homedir() }),
      sshPath,
      env,
      platform,
      sshLogins,
      onDidSwitch: async () => {
        await sidebar.render();
        if (view.visible) await sidebar.refreshStates();
      },
    }),
    // Close and Keep Running tells the Monitor at once, on every engine, and Keep Running When Closed and Stop
    // When Closed too, through this window's worker of the engine.
    sessionMonitor: {
      sendHeartbeat: (devspaceId) => windowHeartbeats.sendFor(devspaceId),
      // The stopNow heartbeat of a manual Stop.
      sendStop: (devspaceId) => windowHeartbeats.sendStop(devspaceId),
    },
    // "Update All Images Now", through this window's worker of the engine, with the monitor settings of this computer
    // for that engine (as the repair of a heartbeat).
    updateImagesNow: (target, signal) => monitorCalls.monitorRunNow(target, monitorSettings.forTarget(target), signal),
  });
  context.subscriptions.push(
    sidebar,
    controller,
    ...controller.registerCommands(),
    controller.watchDisconnectRequests(),
    // The first load shows the repositories as they arrive.
    discovery.onPartialResult((result) => sidebar.onPartialResult(result)),
  );

  const background = (promise: Promise<unknown>, what: string): void => {
    promise.catch((error: unknown) => logger.error(`Could not ${what}.`, error));
  };

  // The devspace of this window: the container of its folder URI, if the registry knows it.
  const containerName = connection.currentContainerName();
  const currentDevspace = containerName
    ? await findWindowDevspace(containerName, { registry, needsRestore, docker, service, logger })
    : undefined;
  // Writes the window status file and cleans up the storage folder. Its result is the pending connection file of this
  // window's devspace, which the first status write removes (role A).
  const started = sessionCoordinator.start(currentDevspace?.id ?? null);
  controller.setReady(started);

  const focusThrottle = new Throttle(FOCUS_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    onDidChangeBusy((change) => controller.onBusyChanged(change)),
    sessionCoordinator.onDidHeartbeat(() => {
      controller.onHeartbeat();
      // Only the coordination files; Docker is not asked in the background (Resource Saver of Docker Desktop).
      if (view.visible) background(sidebar.render(), 'update the sidebar');
    }),
    sidebar.onDidRefreshStates(() => controller.onStatesRefreshed()),
    view.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      background(sidebar.refreshStates(), 'update the sidebar');
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !focusThrottle.tryAcquire()) return;
      background(view.visible ? sidebar.refreshStates() : sidebar.render(), 'update the sidebar');
    }),
    auth.onDidChangeSession(() => {
      // A window of a devspace of another account closes; the view shows the list of the new account.
      background(controller.onSessionChanged(), 'check the devspace of this window after the account change');
      background(sidebar.onSessionChanged(), 'update the sign-in state');
    }),
    // GitHub rejected the token of the session, or accepted it again: the same account, so only the view changes.
    auth.onDidChangeSignInState(() => background(sidebar.onSessionChanged({ again: false }), 'update the sign-in state')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      invalidHostAccessEntries = warnInvalidHostAccessChecksOff(logger, invalidHostAccessEntries);
      updateOwnersContextKey(settings.owners, logger);
      updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
      // Another scan scope loads the list again at once.
      if (!sameScope(previous.owners, settings.owners)) {
        background(sidebar.onScopeChanged(), 'load the repository list of the selected organizations');
      }
      background(sidebar.render(), 'update the sidebar');
      sidebar.restartTimer();
    }),
  );

  // The icons of Select Organizations… and Show Only Devspaces in the view title bar.
  updateOwnersContextKey(settings.owners, logger);
  updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
  // The Docker host of the view title (every later read of the context updates it too).
  background(targets.resolve(), 'read the Docker host');
  // The stored list at once, then the background refresh.
  background(sidebar.initialize(), 'show the repository list');
  if (view.visible) background(sidebar.refreshStates(), 'update the sidebar');
  // A lost registry is rebuilt from the volume labels (only when Docker runs). A window whose container the registry
  // did not know takes its restored devspace.
  const adopt = Boolean(containerName) && currentDevspace === undefined;
  background(controller.reconcileIfRegistryLost({ passive: true, adopt }), 'restore the devspaces from the volumes');
  // When helper.json does not know the current helper tag (after the installation, or an update that changed it; there
  // is no previous helper image to fall back to), the helper image is built in the background, when Docker runs (no
  // cross-window lock; windows that start together may each build once, later ones find the record). The build
  // (HelperImages.prebuildImage) is shared with the preparation of a worker in this window
  // (HelperImages.ensureImagePresent, ensureImageUse before an open) and cancelled when the extension is deactivated.
  // With updateImagesOnConnect on, it also runs when helper.json says that the refresh of the helper image is due (the
  // rebuild that a check asked for, the weekly check), never for the daily cleanup alone; its maintaining ensure then
  // also runs the cleanup when that is due. On the Docker engine of the current Docker context, local or remote alike,
  // as an operation on it (the state file and engine key of an open there); a remote host gets our own SSH check
  // without questions before its `docker info` (dockerEngineAnswers). A host switch starts no new prebuild: the next
  // activation, or the first open on that host, builds its tag.
  const helperPrebuild = new HelperPrebuild({
    helper,
    dockerRunning: (target, signal) =>
      dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    statePath: paths.helperState,
    // The setting decides the check of the base image and the rebuild, not the cleanup.
    checkBaseImage: () => getSettings().updateImagesOnConnect,
    logger,
  });
  context.subscriptions.push(helperPrebuild);
  background(
    targets
      .current()
      .then((target) => helperPrebuild.start(target))
      // A lost registry is restored again once the helper image was built.
      .then((outcome) =>
        // A failed restore is logged as such, not as a failed preparation.
        restoreAfterPrebuild(outcome, () => controller.reconcileIfRegistryLost({ passive: false, adopt })).catch((error: unknown) =>
          logger.error('Could not restore the devspaces from the volumes after the helper image was prepared.', error),
        ),
      ),
    'prepare the workspace helper image in the background',
  );

  if (currentDevspace && containerName && docker.isInstalled()) {
    // Which Docker the Dev Containers extension asks when it resolves this window. Only for a devspace of this
    // extension. Its context: the one in the authority of this window, through which the Dev Containers extension
    // attaches; for a window without one, the current context when that is on the host of the devspace, else none
    // for the local Docker.
    const devspace = currentDevspace;
    const logDocker = async (): Promise<void> => {
      const host = dockerHostOf(devspace);
      const own = connection.currentDockerContext();
      const current = own === undefined ? await targets.resolve() : undefined;
      const context = own ?? (current && isOnDockerHost(devspace, current.host) ? current.context : host === '' ? undefined : await findRemoteContext(docker, host));
      const lines = await attachDiagnostics(docker, docker.processEnv(), containerName, context);
      for (const line of lines) logger.info(`While this window connects: ${line}`);
    };
    background(logDocker(), 'log the Docker of this window');
  }

  if (currentDevspace && containerName) {
    // Role A: the open pipeline runs before VS Code connects this window (awaited). Assumption
    // (ATTACHED_CONTAINER_ACTIVATION_EVENT): VS Code waits for activate() before it resolves the authority.
    const pending = await started;
    await controller.openAttachedWindow(currentDevspace, containerName, pending);
    return;
  }
  background(started, 'start the window session');
  // Role B: pending operations, then the reopen rule. Role C (a local folder or another remote): nothing else.
  if (connection.isEmptyWindow()) background(controller.runEmptyWindowTasks(activatedAt), 'run the tasks of the empty window');
}

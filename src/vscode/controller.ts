// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Controller: the commands of package.json and the flows of the window roles at activation. It connects the UI
// components (sidebar, status bar, switcher, progress, messages) with the devspace service, the Session Coordinator,
// and the Connection Adapter.
import * as path from 'path';
import * as vscode from 'vscode';
import { isBlockingBusyMark } from '../core/busy';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { LOCAL_DOCKER_TARGET, describeDockerHost, dockerHostOf, devspacesOfHost, isOnDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { ensureRemoteContext } from '../core/docker/remoteDocker';
import { operationDockerTarget, outsideOperation, type DockerTargets } from '../core/docker/dockerTargets';
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { UserFacingError, errorMessage } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import type { WindowStateValue } from '../core/helperChannel/protocol';
import { HOST_ACCESS_CHECKS_OFF_SETTING, hostAccessChecks, withHostAccessChecks, type HostAccessChecks } from '../core/policy/hostAccessChecks';
import { repositoryFolder, splitRepository } from '../core/names';
import { availableDevspaces, isAvailableTo } from '../core/ownership';
import { isoTime, systemClock, type Clock, type ProgressReporter } from '../core/ports';
import type { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import { PipelineTexts, WINDOW_STATE_FLOW_TIMEOUT_MS, type OpenResult } from '../core/pipeline/operationBase';
import type { DevspaceRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type {
  BusyMark,
  BusyOperation,
  Devspace,
  DevspaceSource,
  ExtensionSettings,
  GitHubAccount,
  PendingConnection,
  PendingOperation,
  PendingOperationKind,
  RepositoryInfo,
  WindowStatus,
} from '../core/types';
import { possibleSources, sourceOf, sourceOperationKey } from '../core/devspaceSource';
import { isProcessAlive, stopAfterSeconds } from '../core/session/sessionRules';
import { decideReopen, pipelineJustRan, sortPendingOperations } from './activationRules';
import type { VsCodeGitHubAuth } from './auth';
import { Commands, type CommandName } from './commands';
import type { ConnectionAdapter } from './connectionAdapter';
import { ControllerTexts } from './controllerTexts';
import {
  DISCONNECT_REQUEST_MAX_AGE_MS,
  isFreshDisconnectRequest,
  type DisconnectRequest,
  type DisconnectRequests,
} from './disconnectRequests';
import type { DockerSetup } from './dockerSetup';
import type { MonitorQuestion } from './monitorQuestion';
import { showError as presentError } from './errors';
import type { OutputChannelLogger } from './logger';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { selectOwners } from './ownerSelector';
import { setShowOnlyDevspaces } from './devspacesOnly';
import { hideProgressNotification, runWithProgress, type BusyChange } from './progress';
import type { RemoteDockerCommands } from './remoteDockerCommands';
import type { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import type { SessionCoordinator } from './sessionCoordinator';
import { RowActivationTracker, activatedRow, type ListOpenMode } from './rowActivation';
import { SETTINGS_SECTION, hostAccessChecksOffValue, readListOpenMode } from './settings';
import type { Sidebar } from './sidebar';
import type { DevspaceStatusBar } from './statusBar';
import { pickRepository, showSwitcher } from './switcher';
import { CoalescingTask, OperationGate } from './tasks';
import { parseCommandArgument, repositoryTarget, sourceChoices, type CommandArgument } from './targets';
import { TreeTexts, devspaceName, recentDevspaces, repositoryRows, stateIcon } from './treeModel';
import { opensNewWindow, type WindowRequest } from './windowChoice';

/**
 * After "Close Remote Connection", the window reloads and this extension host ends. If it still runs after this time,
 * the user kept the connection (for example Cancel in the dialog about unsaved files): the pending operation is
 * removed. Assumption: the extension host of the old window ends within this time when the window reloads.
 */
const HANDOFF_CHECK_MS = 30_000;
/**
 * A window that left a devspace it must not use checks this long after "Close Remote Connection" that its
 * connection closed; a running extension host means that the user kept the connection.
 */
const LEAVE_CHECK_MS = 10_000;
/**
 * A window that leaves a devspace because of the GitHub account waits at most this long for the removal of the token
 * from the container before "Close Remote Connection": the close reloads the window and ends this extension host, and
 * with it a removal that has not ended. The removal usually takes a few seconds (the worker of the engine runs, or
 * starts). When it takes longer (for example the image of the worker must be built first), the window closes its
 * connection anyway, and the token stays in the memory of the container until the Monitor container stops it.
 */
const TOKEN_REMOVE_WAIT_MS = 30_000;
/**
 * The reopen rule looks at the other windows. Windows that VS Code restores at the same start write their status files
 * during their own activation; this pause lets them do so first.
 */
const REOPEN_CHECK_DELAY_MS = 3_000;
/** A Delete that waits for the operation of another window reads the registry this often. */
const BUSY_POLL_MS = 1_000;
/**
 * Set while this window is connected to a devspace (Close and Keep Running in the Command Palette).
 */
export const CONNECTED_CONTEXT_KEY = 'devspaces.connected';

/** The busy mark that a hand-off sets: a stop needs none, it does not change the container. */
const HAND_OFF_BUSY: Record<PendingOperationKind, BusyOperation | undefined> = {
  stop: undefined,
  rebuild: 'rebuild',
  delete: 'delete',
};

export interface ControllerDeps {
  logger: OutputChannelLogger;
  registry: DevspaceRegistry;
  /** True when registry.json is missing or lost content (DevspaceRegistry.needsRestore). */
  registryNeedsRestore: () => Promise<boolean>;
  sessionFiles: SessionFiles;
  /** Requests of other windows to close this window's connection first. */
  disconnectRequests: DisconnectRequests;
  docker: BootstrapDocker;
  /**
   * The operations of this window, each a flow in the worker of the Docker target, also the token removal
   * (removeTokenInWorker).
   */
  service: DevspaceOperations;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  connection: ConnectionAdapter;
  coordinator: SessionCoordinator;
  sidebar: Sidebar;
  statusBar: DevspaceStatusBar;
  settings: () => ExtensionSettings;
  /** The Docker setup: the commands of the setup in the sidebar. */
  dockerSetup: Pick<DockerSetup, 'install' | 'start' | 'installWsl' | 'show'>;
  /** The editor of the setting repositoryGroups. */
  repositoryGroupsEditor: Pick<RepositoryGroupsEditor, 'open'>;
  /** True while the sidebar view is visible: only then Docker is asked outside of operations. */
  viewVisible: () => boolean;
  /** Expand All of the view (treeView.ts expandAll). Default: nothing. */
  expandAll?: () => Promise<void>;
  /**
   * The current Docker host, read at the start of each operation (the current Docker context). Default: the local
   * Docker.
   */
  dockerTargets?: Pick<DockerTargets, 'resolve' | 'current' | 'withOperation'>;
  /** "Use a Remote Docker Host…", "Use the Local Docker", and the switch back of a restored window. */
  remoteDocker?: Pick<RemoteDockerCommands, 'useRemoteHost' | 'useLocalDocker' | 'chooseDockerHost' | 'askAgain' | 'offerSwitchBack'>;
  /**
   * One heartbeat with the current keep-running flag of a devspace to the Monitor container of its engine
   * (Close and Keep Running, Keep Running When Closed, Stop When Closed), on every engine, through this window's worker
   * (WindowHeartbeats.sendFor; its `seq` is the time before it reads the flags, so it is later than the change in the
   * registry). Without it, Close and Keep Running refuses.
   */
  sessionMonitor?: {
    sendHeartbeat(devspaceId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
    /**
     * The stopNow heartbeat of a manual Stop to the Monitor of the devspace's engine
     * (WindowHeartbeats.sendStop, within its short bound), so the engine stops the devspace itself whatever happens
     * to VS Code. Never throws.
     */
    sendStop(devspaceId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  };
  /**
   * "Update All Images Now": the Monitor of the engine `target` made sure and asked for its background run at
   * once (workerMonitor's monitorRunNow, with the monitor settings of this computer). Resolves when the monitor took
   * the request. Without it, the command does nothing.
   */
  updateImagesNow?: (target: DockerTarget, signal: AbortSignal) => Promise<void>;
  /**
   * The question about the Monitor of an engine (MonitorQuestion; once per engine, never rejects), which a Start, a
   * Rebuild and "Update All Images Now" of the user ask before they run there (beforeUserFlow). The flows that run by
   * themselves never ask. Without it, nothing is asked.
   */
  monitorQuestion?: Pick<MonitorQuestion, 'askIfNeeded'>;
  /** The VS Code setting `workbench.list.openMode` (double-click on a row, rowActivation.ts). Default: `readListOpenMode`. */
  listOpenMode?: () => ListOpenMode;
  /** True in an Extension Development Host (a debug run of this extension): the reopen rule is relaxed. */
  development?: boolean;
  clock?: Clock;
  /** For tests. Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /**
   * For tests: HANDOFF_CHECK_MS, LEAVE_CHECK_MS, TOKEN_REMOVE_WAIT_MS, REOPEN_CHECK_DELAY_MS,
   * DISCONNECT_REQUEST_MAX_AGE_MS, and BUSY_POLL_MS.
   */
  timing?: {
    handOffCheckMs?: number;
    leaveCheckMs?: number;
    tokenRemoveWaitMs?: number;
    reopenCheckDelayMs?: number;
    disconnectAnswerMs?: number;
    busyPollMs?: number;
    /** The pause between the checks of the container before the window connects. */
    readyPollMs?: number;
  };
}

/** The checks of the container before the window connects (readyForWindow). */
const READY_CHECKS = 5;
const READY_POLL_MS = 1_000;
/** The longest wait for the log lines of the attach before the window connects. */
const ATTACH_DIAGNOSTICS_WAIT_MS = 3_000;

/** What a command works on. */
interface Target {
  /** `owner/name` as the command received it. */
  repository: string;
  /** GitHub data, if known. */
  info?: RepositoryInfo;
  /**
   * The devspace, read from the registry when the command started: the one that the command names (a row, the status
   * bar item, the switcher), or else the devspace of the repository of the signed-in account.
   */
  devspace?: Devspace;
  /**
   * The command names `devspace` (a row, the status bar item, the switcher, a restored window). Otherwise the
   * devspace belongs to the repository for the account that was signed in, and Try again looks it up again for the
   * account that is signed in then.
   */
  named?: boolean;
  /**
   * The source of the target (DevspaceSource): the one of its devspace (sourceOf), or, without a devspace, the one of
   * the row or of the pick of the source, which the first Start creates the devspace from. Missing: a target of a
   * repository with one source that the discovery does not know yet (the open takes its first configuration).
   */
  source?: DevspaceSource;
}

interface StartOptions {
  /**
   * The window that connects: plain Start follows the setting openInNewWindow (default); Start in New Window and Start
   * in Current Window name it. Default: `default`.
   */
  window?: WindowRequest;
  /**
   * First open only: what the open builds the devspace from (DevspaceSource), when the target names none. An existing
   * devspace keeps the source it was created with (sourceOf), whatever the options name.
   */
  source?: DevspaceSource;
  /**
   * The reopen at startup: a Start that the user did not start, so it asks nothing about the Monitor of the engine
   * (beforeUserFlow). Its Try again is a Start of the user.
   */
  automatic?: boolean;
}

/** The devspace that this window is attached to. A window changes its devspace only by reloading. */
interface WindowDevspace {
  devspace: Devspace;
  /** Container name from the folder URI of the window. */
  containerName: string;
  /** The container does not run: the status bar shows Reconnect. */
  lost: boolean;
  /** Branch read from the container. */
  branch?: string;
  /** The last check of the connection could not read the state (unknown). */
  unknown?: boolean;
}

/**
 * A devspace that this window left because it must not use it, while the window may still be attached to its
 * container: the devspace of another account (or of nobody, after a sign-out), or a container of an older version.
 */
interface LeftDevspace {
  devspaceId: string;
  containerName: string;
  repository: string;
  reason: 'account' | 'outdated';
}

/** A flow that connects this window (numbered, see `connectingFlow`), or a new window. */
type ConnectRequest = { newWindow: false; number: number } | { newWindow: true };

type HandOffRequest = Pick<PendingOperation, 'operation' | 'reason' | 'additionalVolumesToRemove'>;

/** What a command without argument asks for: `open` is a repository that the command opens (Start). */
type PickKind = 'open' | 'repository' | 'devspace' | 'gitHub';

export class Controller implements vscode.Disposable {
  private readonly gate = new OperationGate();
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private readonly timers = new Set<NodeJS.Timeout>();
  private current: WindowDevspace | undefined;
  /**
   * This window runs the open pipeline of role A (openAttachedWindow), so a restore of the registry never adopts a
   * devspace for it; `adoption`: the adoption that runs; `adopted`: an adoption found the devspace of this window
   * (it took it or left it), so no later restore adopts it again.
   */
  private attaching = false;
  private adoption: Promise<void> | undefined;
  private adopted = false;
  /** See `LeftDevspace`; checked until the window has closed its connection (`checkLeftConnection`). */
  private left: LeftDevspace | undefined;
  private checkingLeft = false;
  private ready: Promise<void> = Promise.resolve();
  private checkingConnection = false;
  /**
   * The devspace of this window whose container could not be read for whether it is outdated when the window
   * attached (containerOutdated); checkConnection reads it again. With the host access checks of its repository then;
   * turning them on later applies from the next open.
   */
  private outdatedUncheckedFor: { devspaceId: string; checks: HostAccessChecks } | undefined;
  /** Numbers the flows that connect this window (see `connect`). */
  private connectRequests = 0;
  /** The connecting flows that still run. */
  private readonly activeConnectRequests = new Set<number>();
  /** One check of the disconnect requests at a time; a change during a check runs one more check. */
  private readonly disconnectTask = new CoalescingTask(() => this.checkDisconnectRequest());
  private disconnectWatcher: { dispose(): void } | undefined;
  private disposed = false;
  /** The last value of CONNECTED_CONTEXT_KEY. */
  private connectedContext: boolean | undefined;
  /** Tells a double-click on a repository row from a single click (rowActivated). */
  private readonly rowActivations: RowActivationTracker;

  constructor(private readonly deps: ControllerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.rowActivations = new RowActivationTracker(this.clock);
  }

  private get logger(): OutputChannelLogger {
    return this.deps.logger;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Setup

  /**
   * Operations wait for this promise: the window status file must exist first, so that other windows and the Session
   * Monitor count this window's busy marks as live.
   */
  setReady(ready: Promise<unknown>): void {
    this.ready = ready.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Registers the commands of package.json (controller.test.ts counts them). A command never rejects: errors are shown. */
  registerCommands(): vscode.Disposable[] {
    const handlers: Record<CommandName, (argument: unknown) => Promise<void>> = {
      start: (argument) => this.start(parseCommandArgument(argument)),
      startInNewWindow: (argument) => this.start(parseCommandArgument(argument), 'newWindow'),
      startInCurrentWindow: (argument) => this.start(parseCommandArgument(argument), 'currentWindow'),
      stop: (argument) => this.stop(parseCommandArgument(argument)),
      delete: (argument) => this.delete(parseCommandArgument(argument)),
      rebuild: (argument) => this.rebuild(parseCommandArgument(argument)),
      showOnGitHub: (argument) => this.showOnGitHub(parseCommandArgument(argument)),
      switchDevspace: () => this.switchDevspace(),
      switchDevspaceInNewWindow: () => this.switchDevspace('newWindow'),
      switchDevspaceInCurrentWindow: () => this.switchDevspace('currentWindow'),
      refresh: () => this.refresh(),
      updateImagesNow: () => this.updateImagesNow(),
      search: () => this.search(),
      showLog: async () => this.logger.show(),
      signIn: () => this.signIn(),
      selectOwners: () => this.selectOwners(),
      selectOwnersFiltered: () => this.selectOwners(),
      showOnlyDevspaces: () => setShowOnlyDevspaces(true),
      showAllRepositories: () => setShowOnlyDevspaces(false),
      expandAll: async () => this.deps.expandAll?.(),
      editRepositoryGroups: () => this.deps.repositoryGroupsEditor.open(),
      turnOffHostAccessChecks: (argument) => this.turnOffHostAccessChecks(parseCommandArgument(argument)),
      turnOnHostAccessChecks: (argument) => this.turnOnHostAccessChecks(parseCommandArgument(argument)),
      keepRunning: (argument) => this.setKeepRunning(parseCommandArgument(argument), true),
      stopWhenClosed: (argument) => this.setKeepRunning(parseCommandArgument(argument), false),
      closeAndKeepRunning: () => this.closeAndKeepRunning(),
      dockerSetupInstall: () => this.deps.dockerSetup.install(),
      dockerSetupStart: () => this.deps.dockerSetup.start(),
      dockerSetupInstallWsl: () => this.deps.dockerSetup.installWsl(),
      dockerSetupShow: () => this.deps.dockerSetup.show(),
      useRemoteDockerHost: async () => this.deps.remoteDocker?.useRemoteHost(),
      useLocalDocker: async () => this.deps.remoteDocker?.useLocalDocker(),
      chooseDockerHost: async () => this.deps.remoteDocker?.chooseDockerHost(),
      askAgainDockerHost: async () => this.deps.remoteDocker?.askAgain(),
      rowActivated: (argument) => this.rowActivated(argument),
      showProgressDetails: async (argument) => {
        this.logger.show();
        hideProgressNotification(argument);
      },
    };
    // Each command is one operation on the Docker host that is current when it starts; the two commands that change the
    // host read it themselves. A click on a row is no operation: only the Start of a double-click is one.
    const ownTarget = new Set<CommandName>(['useRemoteDockerHost', 'useLocalDocker', 'chooseDockerHost', 'askAgainDockerHost', 'rowActivated', 'showProgressDetails']);
    const run = async (name: CommandName, argument: unknown): Promise<void> => {
      try {
        if (ownTarget.has(name)) await handlers[name](argument);
        else await this.withDockerTarget(() => handlers[name](argument));
      } catch (error) {
        this.showError(error);
      }
    };
    return (Object.keys(handlers) as CommandName[]).map((name) =>
      vscode.commands.registerCommand(Commands[name], (argument: unknown) => run(name, argument)),
    );
  }

  /** Status bar "Updating owner/name…" while a pipeline runs. */
  onBusyChanged(change: BusyChange): void {
    if (change.busy && change.repository) this.deps.statusBar.showBusy(change.repository);
    else this.deps.statusBar.clearBusy();
  }

  /**
   * Every 15 seconds (the window heartbeat): is the container of this window still running, and does another window ask
   * this window to close its connection?
   */
  onHeartbeat(): void {
    this.background(this.checkConnection(), 'check the connection');
    this.onDisconnectRequested();
  }

  /**
   * Watches the disconnect requests of other windows, so that this window answers at once; the heartbeat checks them
   * as well. Call once at activation.
   */
  watchDisconnectRequests(): vscode.Disposable {
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = this.deps.disconnectRequests.watch(
      () => this.onDisconnectRequested(),
      (error) => this.logger.warn(`The requests of other windows cannot be watched: ${errorMessage(error)}`),
    );
    return {
      dispose: () => {
        this.disconnectWatcher?.dispose();
        this.disconnectWatcher = undefined;
      },
    };
  }

  /** A disconnect request may have changed. Only a window with a devspace answers. */
  onDisconnectRequested(): void {
    if (!this.current || this.disposed) return;
    this.background(this.disconnectTask.request(), 'check the requests of other windows');
  }

  /**
   * The branches of the running containers were read, or the sidebar was rendered: the status bar shows the current
   * branch, and the name of the devspace as the sidebar shows it now (with the word of its source when the repository
   * has several sources, which the list of the sidebar and the settings decide).
   */
  onStatesRefreshed(): void {
    const current = this.current;
    if (!current) return;
    const branch = this.deps.sidebar.liveBranch(current.devspace.id);
    if (branch && branch !== current.branch) current.branch = branch;
    this.updateStatusBar();
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Window roles at activation

  /**
   * Role A: VS Code restored this window, reloaded it, or our own `vscode.openFolder` opened it, attached to the
   * container of `devspace`. Unless the open pipeline has just run for it (a fresh pending connection file), the
   * pipeline runs now (the check before each connection; the Docker start, container start, recreation). activate()
   * awaits this.
   */
  async openAttachedWindow(
    attached: Devspace,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    this.attaching = true;
    // The devspace of another account runs no pipeline and starts no container; the window closes.
    const devspace = await this.ownWindowDevspace(attached, containerName);
    if (!devspace) return;
    // A devspace of another Docker host (for example a window of Open Recent after a switch, or Docker Desktop
    // reset the context) is used only after the user switched back; otherwise the window closes its connection.
    if (!(await this.onWindowHost(devspace))) return;
    await this.withDockerTarget(() => this.openAttachedDevspace(devspace, containerName, pending));
  }

  private async openAttachedDevspace(
    devspace: Devspace,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    this.current = { devspace, containerName, lost: false };
    this.updateStatusBar();
    // A window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(devspace.id);
    // An account change while the window checked its devspace found no devspace of this window yet. Check the
    // account again now that the window has one; the window leaves (and the token file is removed) when the devspace
    // is not the account's.
    if (!(await this.stillAvailable(devspace))) return;
    const repository = this.displayName({ repository: devspace.repository });
    if (pipelineJustRan(pending, devspace.id, this.clock.now())) {
      this.logger.info(`The open pipeline of ${repository} has just run for this window.`);
    } else {
      this.logger.info(`This window was restored or reloaded. The open pipeline of ${repository} runs before it connects.`);
      // Assumption: activation through ATTACHED_CONTAINER_ACTIVATION_EVENT blocks the connection until activate()
      // resolves, also when the pipeline starts Docker or updates the devspace for several minutes.
      const shown = this.shownName(this.devspaceTarget(devspace));
      const succeeded = await this.operation(
        this.keyOfDevspace(repository, devspace),
        'Open',
        () =>
          runWithProgress({
            title: Messages.opening(shown),
            repository: shown,
            cancellable: true,
            task: async (progress, signal) => {
              // The devspace opens with its own source (sourceOf, with the default image of the settings now, so that a
              // changed setting is noticed: Rebuild now / Later), as every other open of an existing devspace.
              await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, source: sourceOf(devspace, this.deps.settings()) });
            },
          }),
        { retry: () => this.start({ kind: 'devspace', devspaceId: devspace.id }) },
      );
      if (!succeeded) {
        // "Delete devspace" for missing files removed the devspace of this window.
        if (await this.leaveDeletedDevspace(devspace.id)) return;
        // The pipeline did not make the container of an older version again (for example the host access policy refused
        // the configuration, or the user cancelled). That container lacks the current setup, so the window must not
        // attach to it. A current container stays: it passed the policy when it was made. So does a container that was
        // made while the host access checks were off, when they are on now and the pipeline refused the configuration:
        // it must not be used as it is.
        const outdated = this.current?.devspace.id === devspace.id ? await this.containerOutdated(devspace) : undefined;
        if (outdated) {
          this.logger.info(`${this.outdatedTexts(outdated, repository).log} It was not made again.`);
          await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
            devspaceId: devspace.id,
            containerName,
            repository,
            reason: 'outdated',
          });
          return;
        }
        // The pipeline refuses a devspace that the account signed in now may not use (otherAccount): the window leaves
        // it and its token file, instead of keeping the connection.
        if (this.current?.devspace.id === devspace.id && !(await this.stillAvailable(devspace))) return;
        // The window shows its own connection error; the status bar offers Reconnect.
        if (this.current) {
          this.current.lost = true;
          this.updateStatusBar();
        }
      }
    }
    this.background(this.readWindowBranch(), 'read the branch of the devspace');
  }

  /**
   * Role B: an empty window. First the pending operations that a window left when it closed its remote connection,
   * oldest first; then the reopen rule (decideReopen).
   *
   * `activatedAt`: the time at which the window's activation began (`activate()` passes it), taken before any await.
   * The age of the reopen record is measured at this time, not at the check: the awaits (the window status, the stale
   * claims, the operations, the GitHub account) and the pause of REOPEN_CHECK_DELAY_MS take several seconds, and a
   * Close Remote Connection whose empty window activates 2 to 3 seconds later must still count as younger than
   * REOPEN_MIN_AGE_MS.
   */
  async runEmptyWindowTasks(activatedAt: number = this.clock.now()): Promise<void> {
    await this.withDockerTarget(() => this.runEmptyWindowTasksNow(activatedAt));
  }

  private async runEmptyWindowTasksNow(activatedAt: number): Promise<void> {
    await this.ready;
    const { sessionFiles, coordinator, registry, connection } = this.deps;
    await sessionFiles
      .cleanupStaleClaims()
      .catch((error: unknown) => this.logger.warn(`Old claimed operations could not be removed: ${errorMessage(error)}`));
    // An operation file that cannot be read is not run and not dropped, and the user is told; the operations of the
    // other devspaces still run (the files are per devspace).
    let known: Awaited<ReturnType<typeof sessionFiles.readOperationsKnown>>;
    try {
      known = await sessionFiles.readOperationsKnown();
    } catch (error) {
      this.logger.warn(`The pending operations could not be read: ${errorMessage(error)}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(errorMessage(error)));
      return;
    }
    for (const { file, error } of known.unreadable) {
      const cause = `${path.basename(file)}: ${errorMessage(error)}`;
      this.logger.warn(`A pending operation could not be read: ${cause}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(cause));
    }
    const { runnable, stale } = sortPendingOperations(known.operations, this.clock.now());
    for (const operation of stale) {
      this.logger.info(`The pending ${operation.operation} of ${operation.devspaceId} is too old and is dropped.`);
      await this.removeOperationQuietly(operation.devspaceId);
    }
    const account = await this.readAccount();
    const dockerHost = await this.currentDockerHost();
    for (const operation of runnable) {
      if (this.disposed) return;
      // An operation of a devspace of another account is not run by this window; it expires.
      const target = await registry.get(operation.devspaceId);
      if (target && !isAvailableTo(target, account)) {
        this.logger.info(
          `The pending ${operation.operation} of ${operation.devspaceId} is for another GitHub account. It is not run.`,
        );
        continue;
      }
      // Nor one of a devspace of another Docker host; it expires.
      if (target && !isOnDockerHost(target, dockerHost)) {
        this.logger.info(`The pending ${operation.operation} of ${operation.devspaceId} is for another Docker host. It is not run.`);
        continue;
      }
      let claimed: PendingOperation | undefined;
      try {
        claimed = await sessionFiles.claimOperation(operation.devspaceId, coordinator.windowId);
      } catch (error) {
        this.logger.warn(`The pending operation of ${operation.devspaceId} could not be claimed: ${errorMessage(error)}`);
        continue;
      }
      if (claimed) await this.runPendingOperation(claimed);
    }
    // Not known whether an operation is pending: the window is not opened again.
    if (runnable.length > 0 || known.unreadable.length > 0) return;

    await this.delay(this.deps.timing?.reopenCheckDelayMs ?? REOPEN_CHECK_DELAY_MS);
    if (this.disposed) return;
    const [others, operations, record, devspaces] = await Promise.all([
      coordinator.otherActiveWindows(),
      sessionFiles.readOperations(),
      sessionFiles.readReopen(),
      registry.list(),
    ]);
    const decision = decideReopen({
      settings: this.deps.settings(),
      emptyWindow: connection.isEmptyWindow(),
      otherActiveWindows: others.length,
      otherConnectedWindows: others.filter((status) => status.devspaceId !== null).length,
      pendingOperations: operations.length,
      record,
      // Only a devspace of the signed-in account is opened again, and only of the current Docker host.
      devspaceIds: new Set(
        availableDevspaces(devspacesOfHost(devspaces, dockerHost), account).map((devspace) => devspace.id),
      ),
      // The age of the record at activation (see `activatedAt`), not after the awaits and the pause.
      now: activatedAt,
      development: this.deps.development,
    });
    if (!decision.reopen) {
      this.logger.info(`The last devspace is not opened: ${decision.reason}.`);
      return;
    }
    const devspace = devspaces.find((candidate) => candidate.id === decision.devspaceId);
    if (!devspace) return;
    this.logger.info(`Opening the last used devspace ${devspace.repository}.`);
    // The progress notification "Opening owner/name…" has Cancel: the user can stay in the empty window. The user did
    // not start it, so it asks nothing about the Monitor of the engine.
    await this.startTarget(this.devspaceTarget(devspace), { automatic: true });
  }

  /**
   * Entries for the volumes with the label nimblescape.devspaces.id, when registry.json is missing, not
   * valid, or has invalid entries. Only when Docker runs; Docker is not started for this. By the worker of the Docker
   * host; `passive` (the default, a call in the background): it is made ready as for the refresh. `adopt`, for a window
   * whose container the registry did not know at activation (no open pipeline runs for it): it takes its devspace
   * also when the registry was restored already (by an earlier restore of this window whose answer came too late, or by
   * another window).
   */
  async reconcileIfRegistryLost(options: { passive: boolean; adopt?: boolean } = { passive: true }): Promise<void> {
    await this.withDockerTarget(() => this.reconcileIfRegistryLostNow(options));
  }

  private async reconcileIfRegistryLostNow(options: { passive: boolean; adopt?: boolean }): Promise<void> {
    const { docker, service } = this.deps;
    // Also when registry.json exists but its content is lost (not valid, or invalid entries), not only when it is missing.
    if (!(await this.deps.registryNeedsRestore())) {
      if (options.adopt === true) await this.adoptWindowDevspace();
      return;
    }
    // reconcileInWorker checks the Docker target first (never an endpoint that is neither local nor SSH), then whether
    // Docker runs; no `docker info` here before that check. By the worker of the Docker host.
    if (!docker.isInstalled()) return;
    const added = await service.reconcileInWorker({ passive: options.passive });
    if (added === 0 && options.adopt !== true) return;
    await this.adoptWindowDevspace();
    if (added > 0) await this.deps.sidebar.render();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands

  /**
   * Start. `window`: Start in New Window or Start in Current Window; plain Start follows the setting openInNewWindow.
   */
  async start(argument: CommandArgument, window: WindowRequest = 'default'): Promise<void> {
    const target = await this.resolveTarget(argument, 'open', ControllerTexts.selectRepositoryToStart);
    if (target) await this.startTarget(target, { window });
  }

  /**
   * The command of a repository row: VS Code runs it on a click, Enter, or Space in the row. A double-click runs Start
   * with the row, the same as its Start button (rowActivation.ts); a single click only selects the row. Nothing happens
   * where the row shows no Start: this window is connected to the devspace, or it is updating.
   */
  async rowActivated(argument: unknown): Promise<void> {
    const row = activatedRow(argument);
    const parsed = parseCommandArgument(argument);
    if (!row || parsed.kind !== 'row') return;
    const openMode = (this.deps.listOpenMode ?? readListOpenMode)();
    if (!this.rowActivations.activate(row.id, openMode) || !row.canStart) return;
    // The row may be older than the connection of this window; a lost connection shows Start (Reconnect).
    if (parsed.devspaceId !== undefined && this.current?.devspace.id === parsed.devspaceId && !this.current.lost) return;
    await this.withDockerTarget(() => this.start(parsed));
  }

  /** Stop: the container stops at once; a connected window closes its connection first. */
  async stop(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToStop);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    if (this.isConnectedHere(devspace)) {
      await this.handOff(target, devspace, { operation: 'stop', reason: 'manual' });
      return;
    }
    const shown = this.shownName(target);
    if (await this.connectedInOtherWindow(devspace.id)) {
      // The other window closes its connection first, and its reloaded window stops the container.
      if (!(await this.confirmOtherWindow(shown, ControllerTexts.stop))) return;
      await this.operation(this.operationKey(target), 'Stop', () =>
        this.requestOtherWindowHandOff(shown, devspace, { operation: 'stop', reason: 'manual' }),
      );
      return;
    }
    await this.stopNow(target, devspace);
  }

  /**
   * Keep Running When Closed (`keep`) and Stop When Closed: writes the switch `keepRunning` of the devspace into the
   * registry (under its lock) and renders the sidebar. The Monitor never stops a kept devspace; Stop and
   * Delete still do, and Stop keeps the switch. Nothing is started or stopped here: a kept devspace whose container
   * is stopped stays stopped, and one that is not kept any more stops after the waiting time once no window uses it.
   */
  async setKeepRunning(argument: CommandArgument, keep: boolean): Promise<void> {
    const placeholder = keep ? ControllerTexts.selectDevspaceToKeepRunning : ControllerTexts.selectDevspaceToStopWhenClosed;
    const target = await this.resolveTarget(argument, 'devspace', placeholder);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    const repository = this.shownName(target);
    const updated = await this.deps.registry.updateDevspace(devspace.id, (current) => {
      if (keep) current.keepRunning = true;
      else delete current.keepRunning;
    });
    if (!updated) {
      this.inform(PipelineTexts.devspaceMissing);
      return;
    }
    this.logger.info(keep ? `${repository} keeps running when no window uses it.` : `${repository} stops when no window uses it.`);
    await this.renderQuietly();
    // The Monitor of the engine learns the choice at once, on every engine (it keeps or stops the container
    // when no window sends heartbeats). The choice stays stored when it fails; a window that uses the devspace tells
    // it at its next heartbeat.
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(devspace.id)) ?? { ok: true as const };
    if (!sent.ok) {
      this.logger.warn(`The Monitor could not be told that ${repository} ${keep ? 'keeps running' : 'stops'} when closed: ${sent.detail}`);
      this.warn(ControllerTexts.keepRunningNotSent(repository));
      return;
    }
    // With the setting stopOnClose off, every devspace keeps running already; say so instead of a promise that the
    // devspace stops.
    if (!keep && this.deps.settings().stopOnClose === false) this.inform(ControllerTexts.keepAllRunning);
    else this.inform(keep ? ControllerTexts.keptRunning(repository) : ControllerTexts.stopsWhenClosed(repository));
  }

  /**
   * Close and Keep Running: closes this window, and the container of its devspace keeps running this time. It sets
   * `keepRunningOnce` in the registry (under its lock), which the Monitor treats like Keep Running When Closed
   * until a window connects again, or Stop or Delete. One heartbeat with the keep-running flag goes to the Session
   * Monitor container of its engine first (on every engine), so that it keeps the container also when this computer
   * goes offline; when it fails, the flag is cleared again, an error says so, and the window stays open. The flag stays
   * until the next open or attach of the devspace, or Stop or Delete, also when the user cancels the close (the
   * dialog about unsaved files): `workbench.action.closeWindow` resolves when the close starts, not after that dialog,
   * so the window cannot tell. A cancelled close leaves the devspace kept until then: the safe side.
   */
  async closeAndKeepRunning(): Promise<void> {
    const current = this.current;
    if (!current) {
      this.inform(ControllerTexts.closeAndKeepRunningNotConnected);
      return;
    }
    const devspace = current.devspace;
    const repository = this.shownName(this.devspaceTarget(devspace));
    // On every engine; the heartbeat goes to the engine of the devspace, so Docker must still be set to it.
    const host = dockerHostOf(devspace);
    const currentHost = await this.currentDockerHost();
    if (currentHost !== host) {
      this.warn(Messages.otherDockerHost(repository, host, currentHost));
      return;
    }
    const updated = await this.deps.registry.updateDevspace(devspace.id, (entry) => {
      entry.keepRunningOnce = true;
    });
    if (!updated) {
      this.inform(PipelineTexts.devspaceMissing);
      return;
    }
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(devspace.id)) ?? {
      ok: false as const,
      detail: 'The Monitor is not available in this window.',
    };
    if (!sent.ok) {
      this.logger.warn(`Close and Keep Running: the heartbeat to the Monitor on ${host === '' ? 'the local Docker' : host} failed: ${sent.detail}`);
      await this.clearKeepRunningOnce(devspace.id);
      const minutes = Math.round(stopAfterSeconds(this.deps.settings().stopAfterMinutes) / 60);
      showErrorMessage(ControllerTexts.closeAndKeepRunningUnreachable(host, minutes))
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      return;
    }
    this.logger.info(`${repository} keeps running this time. The window closes.`);
    await this.deps.connection.closeWindow();
  }

  /** Removes `keepRunningOnce` (a window connected again, or the heartbeat failed). Never throws. */
  private async clearKeepRunningOnce(devspaceId: string): Promise<void> {
    try {
      if ((await this.deps.registry.get(devspaceId))?.keepRunningOnce === undefined) return;
      await this.deps.registry.updateDevspace(devspaceId, (entry) => {
        delete entry.keepRunningOnce;
      });
    } catch (error) {
      this.logger.warn(`Close and Keep Running could not be cleared: ${errorMessage(error)}`);
    }
  }

  /** Delete: safety check, confirmation, then the removal. */
  async delete(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToDelete);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    const repository = this.shownName(target);
    if ((await this.otherWindowMark(devspace.id))?.operation === 'delete') {
      this.inform(ControllerTexts.alreadyDeleting(repository));
      return;
    }
    let openInstead = false;
    await this.operation(
      this.operationKey(target),
      'Delete',
      async () => {
        // The check of Delete and its questions run in the worker of the Docker host (deleteCheck.ts: the Git state,
        // the data of services, the volumes that Delete may remove); the coordination of the windows below stays here.
        const otherWindow = await this.connectedInOtherWindow(devspace.id);
        const decision = await runWithProgress({
          title: ControllerTexts.checkingChanges(repository),
          cancellable: true,
          task: (progress, signal) => this.deps.service.deleteCheckInWorker(devspace.id, { progress, signal, repository, otherWindow }),
        });
        if (decision.decision === 'open') openInstead = true;
        if (decision.decision !== 'delete') return;
        const additionalVolumesToRemove = decision.additionalVolumesToRemove;
        // Delete is possible in every state; during an operation of another window it runs afterwards.
        if (!(await this.waitForOtherWindowOperation(repository, devspace.id))) return;
        const current = await this.deps.registry.get(devspace.id);
        if (!current) {
          this.logger.info(`The devspace of ${repository} does not exist anymore. Nothing is deleted.`);
          return;
        }
        const request: HandOffRequest = { operation: 'delete', reason: 'manual', additionalVolumesToRemove };
        if (this.isConnectedHere(current)) {
          await this.handOffNow(repository, current, request, 'delete');
          return;
        }
        // A window that is connected closes its connection first.
        if (await this.connectedInOtherWindow(current.id)) {
          await this.requestOtherWindowHandOff(repository, current, request);
          return;
        }
        await this.deleteWithProgress(repository, current, additionalVolumesToRemove);
      },
      { retry: () => this.delete({ kind: 'devspace', devspaceId: devspace.id }) },
    );
    if (openInstead) {
      const fresh = await this.deps.registry.get(devspace.id);
      if (fresh) {
        await this.startTarget(this.devspaceTarget(fresh));
      }
    }
  }

  /** Rebuild. */
  async rebuild(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'devspace', ControllerTexts.selectDevspaceToRebuild);
    const devspace = this.requireDevspace(target);
    if (!target || !devspace) return;
    await this.rebuildDevspace(target, devspace, { reason: 'manual' });
  }

  /** Show on GitHub. */
  async showOnGitHub(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'gitHub', ControllerTexts.selectRepositoryForGitHub);
    if (!target) return;
    const info = target.info ?? this.deps.sidebar.repositoryInfo(target.repository);
    if (!info) {
      this.inform(TreeTexts.notListedOnGitHub);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(info.url));
  }

  /**
   * Switch Devspace…: the selected devspace or repository opens in this window, or in a new window (Switch Devspace
   * in New Window…, or the setting openInNewWindow).
   */
  async switchDevspace(window: WindowRequest = 'default'): Promise<void> {
    const { registry, sidebar } = this.deps;
    // Only the devspaces and the repositories of the signed-in account.
    const [devspaces, repositories] = await Promise.all([sidebar.availableDevspaces(), sidebar.repositoriesForPicker()]);
    if (devspaces.length === 0 && repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    await this.renderQuietly();
    const newWindow = this.opensNewWindow(window);
    const choice = await showSwitcher({ groups: sidebar.model(), devspaces, repositories, newWindow });
    if (!choice) return;
    if (choice.kind === 'devspace') {
      const devspace = await registry.get(choice.devspaceId);
      if (!devspace) {
        this.inform(PipelineTexts.devspaceMissing);
        return;
      }
      const target = await this.ownTarget(this.devspaceTarget(devspace));
      if (target) await this.startTarget(target, { window });
      return;
    }
    const target = await this.pickedRepositoryTarget(choice.repository.nameWithOwner, 'token');
    if (target) await this.startTarget(target, { window });
  }

  /** Refresh: the repository list (sign-in first when needed), a lost registry, and the states. */
  async refresh(): Promise<void> {
    if (await this.deps.auth.isSignedIn()) await this.deps.sidebar.refreshDiscovery({ again: true });
    else await this.signIn();
    // The user asked for it, so the worker is made ready in full (as for an operation of the user).
    await this.reconcileIfRegistryLost({ passive: false }).catch((error: unknown) =>
      this.logger.warn(`The devspaces could not be restored from the volumes: ${errorMessage(error)}`),
    );
    await this.deps.sidebar.refreshStates();
  }

  /**
   * "Update All Images Now": the Monitor of the Docker engine of this operation (the sidebar's) is made sure
   * and asked for its background run at once (the images in use, the VS Code server and the extensions), with a
   * progress until it took the request; then a message. The run itself is not waited for (it can take long); the
   * monitor never runs two at once. A failure is shown by the command (registerCommands).
   */
  async updateImagesNow(): Promise<void> {
    const update = this.deps.updateImagesNow;
    if (!update) return;
    await this.ready;
    const target = await this.operationTarget();
    const engine = describeDockerHost(target.host);
    // The question about the Monitor of the engine first, which the request makes sure of.
    await this.beforeUserFlow();
    await runWithProgress({ title: ControllerTexts.requestingImageUpdate(engine), task: (_progress, signal) => update(target, signal) });
    this.logger.info(`The Monitor on ${engine} took the request of "Update All Images Now".`);
    this.inform(ControllerTexts.imagesUpdatingNow(engine));
  }

  /** Search: all repositories with a text search, then Start. */
  async search(): Promise<void> {
    const repositories = await this.deps.sidebar.repositoriesForPicker();
    if (repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    const info = await pickRepository(repositories, ControllerTexts.selectRepositoryToStart);
    if (!info) return;
    const target = await this.pickedRepositoryTarget(info.nameWithOwner, 'token');
    if (target) await this.startTarget(target);
  }

  /**
   * Turn Off Host Access Checks…: after a modal warning that names what the configuration of the repository can then
   * use, the repository joins the user setting devspaces.hostAccessChecksOff. The next open of its devspace applies
   * it.
   */
  async turnOffHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    const { repository, key } = names;
    const settings = this.deps.settings();
    // The state that the pipeline applies: the switch under its key.
    if (hostAccessChecks(key, settings) === 'off') {
      this.inform(Messages.hostAccessChecksTurnedOff(repository));
      return;
    }
    const choice = await showWarningMessage(
      Messages.hostAccessChecksOffConfirm(repository),
      { modal: true, detail: Messages.hostAccessChecksOffDetail },
      Actions.turnOffChecks,
    );
    if (choice !== Actions.turnOffChecks) return;
    // Under every name of the repository here: the registry name of its devspaces (the pipeline reads it for them) and
    // the name on GitHub (the first open of another source of the repository reads it).
    await this.writeHostAccessChecks(names.all, 'off');
    this.logger.warn(`The host access checks were turned off for ${repository}. They apply from the next creation of its container.`);
    this.inform(Messages.hostAccessChecksTurnedOff(repository));
  }

  /**
   * Turn On Host Access Checks: the repository leaves the user setting devspaces.hostAccessChecksOff (no question),
   * under every name it has here (the name on GitHub and the name in the registry, which differ after a rename or a
   * transfer). At the next open, the checks run again, and a container that was created without them is created again
   * when the configuration passes them (containerIsCurrent).
   */
  async turnOnHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    await this.writeHostAccessChecks(names.all, 'on');
    this.logger.info(`The host access checks were turned on again for ${names.repository}. They apply from the next open of its devspace.`);
    this.inform(Messages.hostAccessChecksTurnedOn(names.repository));
  }

  /**
   * The names of a row or a devspace for the switch of the host access checks: `repository` for the messages (the
   * name the sidebar shows), `key` the name the open pipeline reads the switch under (the registry name of the
   * devspace when there is one), and `all` every name involved (after a rename or a transfer on GitHub the registry
   * keeps the old name). None without an argument.
   */
  private async hostAccessNames(
    argument: CommandArgument,
  ): Promise<{ repository: string; key: string; all: string[] } | undefined> {
    if (argument.kind === 'row') {
      const devspace = argument.devspaceId !== undefined ? await this.deps.registry.get(argument.devspaceId) : undefined;
      // A row without a devspace of a repository that has one (a child row of another source): the switch of the
      // repository is the one of its devspaces, under their registry name, as the sidebar shows it on every row.
      const sibling = devspace ?? repositoryRows(this.deps.sidebar.model()).find((row) => row.repository.toLowerCase() === argument.repository.toLowerCase() && row.devspace !== undefined)?.devspace;
      const key = sibling?.repository ?? argument.repository;
      return { repository: argument.repository, key, all: uniqueNames([argument.repository, key]) };
    }
    if (argument.kind === 'devspace') {
      const devspace = await this.deps.registry.get(argument.devspaceId);
      if (!devspace) {
        this.inform(PipelineTexts.devspaceMissing);
        return undefined;
      }
      const repository = this.displayName({ repository: devspace.repository });
      return { repository, key: devspace.repository, all: uniqueNames([devspace.repository, repository]) };
    }
    this.logger.info('The switch of the host access checks needs a repository row.');
    return undefined;
  }

  /**
   * Writes the switch of `repositories` into the user setting devspaces.hostAccessChecksOff (ConfigurationTarget.Global:
   * the setting has the scope `application`, so no workspace or folder can turn a check off). The other entries stay.
   */
  private async writeHostAccessChecks(repositories: readonly string[], checks: HostAccessChecks): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    let value: unknown = hostAccessChecksOffValue(configuration);
    for (const repository of repositories) value = withHostAccessChecks(value, repository, checks);
    const entries: unknown[] = Array.isArray(value) ? value : [];
    await configuration.update(HOST_ACCESS_CHECKS_OFF_SETTING, entries.length > 0 ? entries : undefined, vscode.ConfigurationTarget.Global);
  }

  /** Select Organizations…: writes the setting `owners`, the scan scope of the list. */
  async selectOwners(): Promise<void> {
    await selectOwners({
      auth: this.deps.auth,
      discoveryData: () => this.deps.sidebar.discoveryData,
      discovery: this.deps.discovery,
      settings: this.deps.settings,
      signIn: () => this.signIn(),
      logger: this.logger,
    });
  }

  /** Sign in with GitHub. */
  async signIn(): Promise<void> {
    const token = await this.deps.auth.getToken({ interactive: true });
    await this.deps.auth
      .updateContextKey()
      .catch((error: unknown) => this.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`));
    if (!token) {
      this.logger.info('The GitHub sign-in was not completed.');
      return;
    }
    // A new session also fires the session change event, which starts a refresh: reuse it instead of a second one.
    await this.deps.sidebar.onSessionChanged({ again: false });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Flows

  /**
   * Start flow: the open pipeline, then the connection of this window or of a new window (`options.window`,
   * windowChoice.ts). The window stays connected to its previous devspace while the pipeline runs (a switch is the
   * same flow); with a new window, it keeps its devspace afterwards too. A devspace that another window uses is
   * never opened a second time: that window is shown instead.
   */
  /** `retry`: Try again after a failure; by default a Start of the target again (a first open of a command sets its own). */
  private async startTarget(target: Target, options: StartOptions = {}, retry?: () => Promise<void>): Promise<void> {
    const { service, connection } = this.deps;
    const devspace = target.devspace;
    const repository = this.displayName(target);
    const shown = this.shownName(target);
    const key = this.operationKey(target);
    // The source of the open: the one of an existing devspace, fixed at its creation (with the default image of the
    // settings now, sourceOf, so that a changed setting is noticed: Rebuild now / Later); else the one of the target
    // (its row, or the pick of the source), which the first open creates the devspace from.
    const source = devspace !== undefined ? sourceOf(devspace, this.deps.settings()) : (target.source ?? options.source);
    let reconnecting = false;
    let otherWindow: WindowStatus | undefined;
    // The container of this window whose state is read again within the operation, and what that read found running.
    let recheck: string | undefined;
    let found: WindowStateValue | undefined;
    // The gate refused the operation (another one of the repository runs in this window).
    let refused = false;
    if (devspace) {
      if (this.isConnectedHere(devspace)) {
        // While an operation of this devspace runs in this window (the open pipeline of a restored window,
        // Reconnect), its end decides the state: nothing is read or left here.
        const running = this.gate.runningFor(key);
        if (running !== undefined) {
          this.logger.info(`Start of ${repository} was not started: ${running} of ${repository} is still running.`);
          return;
        }
        // "Already connected → nothing" only while the container runs; otherwise this is Reconnect.
        const containerName = this.current?.containerName ?? devspace.containerName;
        // One read of the worker gives whether it runs and whether it is outdated.
        const value = await this.windowState(devspace, containerName);
        // An operation of this devspace may have started, or the window may have left it, while the worker read.
        if (this.gate.runningFor(key) !== undefined || this.current?.devspace.id !== devspace.id) {
          this.logger.info(`Start of ${repository} was not started: the window or its operation changed while the state of its container was read.`);
          return;
        }
        // A known read decides here; the check of the connection need not read it again.
        if (value !== undefined && this.outdatedUncheckedFor?.devspaceId === devspace.id) this.outdatedUncheckedFor = undefined;
        if (value?.state === 'running') {
          // A container of an older version lacks the current setup. The pipeline must not replace it under this
          // window, so the window leaves it; a Start from the empty window makes a new container. The same for a
          // container made while the host access checks were off, when they are on now.
          const outdated = value.outdated;
          if (outdated) {
            this.logger.info(this.outdatedTexts(outdated, repository).log);
            await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
              devspaceId: devspace.id,
              containerName,
              repository,
              reason: 'outdated',
            });
            return;
          }
          this.logger.info(`This window is connected to ${repository}.`);
          // The read succeeded, so the state is known again.
          if (this.current?.lost || this.current?.unknown) {
            this.current.lost = false;
            this.current.unknown = false;
            this.updateStatusBar();
          }
          this.inform(ControllerTexts.alreadyConnected(shown));
          return;
        }
        if (value === undefined) {
          // The pipeline must not replace a running container under this window, so an unknown state is read once more
          // within the operation, with the worker made ready in full (below).
          this.logger.info(`The state of the container of ${repository} could not be read. It is read again before the window connects again.`);
          recheck = containerName;
        } else {
          this.logger.info(`The container of ${repository} does not run. The window connects again.`);
        }
        reconnecting = true;
      } else if ((otherWindow = await this.otherWindowOf(devspace.id))) {
        if ((await this.containerRuns(devspace, devspace.containerName)) === true) {
          // The pipeline must not replace the container under the other window (an update would disconnect it).
          // Assumption: VS Code shows the window that has this folder open instead of opening it again. Also for Start
          // in New Window: never two windows on one devspace.
          this.logger.info(`${repository} is open in another window. That window is shown.`);
          const folder = devspace.remoteWorkspaceFolder ?? repositoryFolder(devspace.repository);
          // A request for a new window never replaces the current window, also if VS Code does not find the other one.
          const args = this.otherWindowArgs(devspace, folder, otherWindow);
          if (this.opensNewWindow(options.window ?? 'default', false)) await connection.openInNewWindow(...args);
          else await connection.open(...args);
          return;
        }
        // Stopped: the next Start starts it. The other window has lost its connection, so the container can be started
        // (or replaced) as usual. The connection then shows the other window, which connects again.
        this.logger.info(
          `The container of ${repository} does not run. The connection of the other window is lost; the devspace starts.`,
        );
      }
    }
    // A Start of the user asks about the Monitor of the engine before its open makes sure of it; the reopen at startup
    // asks nothing.
    if (options.automatic !== true) await this.beforeUserFlow(devspace);
    const newWindow = this.opensNewWindow(options.window ?? 'default', reconnecting);
    const started = await this.operation(
      key,
      'Start',
      () =>
        runWithProgress({
          title: Messages.opening(shown),
          repository: shown,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(newWindow, async (request) => {
              let result: OpenResult;
              if (devspace && recheck !== undefined) {
                const again = await service.windowStateInWorker(devspace, recheck, { signal });
                if (signal.aborted) throw new UserFacingError('cancelled', PipelineTexts.cancelled);
                if (again === undefined) throw new UserFacingError('helperFailed', ControllerTexts.containerStateUnreadable(repository));
                if (again.state === 'running') {
                  found = again;
                  return;
                }
              }
              if (devspace) {
                result = await service.openDevspaceInWorker(devspace.id, { progress, signal, source });
              } else {
                const trusted = await this.firstOpenTrust(repository);
                result = await service.openInWorker(repositoryTarget(repository, target.info, trusted), { progress, signal, source });
              }
              await this.connect(result, progress, request, signal);
            }),
        }),
      // Try again is a Start: a repository takes the account of a session with a working token, as at the first try; it
      // opens in the same kind of window as the first try.
      {
        retry:
          retry ??
          (async () =>
            this.startTarget(await this.refreshedTarget(target, 'token'), { window: options.window, source: options.source })),
        refused: () => (refused = true),
      },
    );
    if (started && found !== undefined && devspace && this.current?.devspace.id === devspace.id) {
      // The container runs after all: as for a Start whose first read found it running.
      const containerName = recheck ?? devspace.containerName;
      // This known read decides too.
      if (this.outdatedUncheckedFor?.devspaceId === devspace.id) this.outdatedUncheckedFor = undefined;
      if (found.outdated) {
        this.logger.info(this.outdatedTexts(found.outdated, repository).log);
        await this.leaveDevspace(this.outdatedTexts(found.outdated, repository).message, { devspaceId: devspace.id, containerName, repository, reason: 'outdated' });
        return;
      }
      this.logger.info(`This window is connected to ${repository}.`);
      this.current.lost = false;
      this.current.unknown = false;
      this.updateStatusBar();
      this.inform(ControllerTexts.alreadyConnected(shown));
      return;
    }
    if (!started && !refused && reconnecting && devspace) {
      // Reconnect: "Delete devspace" for missing files removed the devspace of this window.
      if (await this.leaveDeletedDevspace(devspace.id)) return;
      // As for a restored window whose pipeline failed: a container that was not made again and must not be used as it
      // is is left.
      const outdated = this.current?.devspace.id === devspace.id ? await this.containerOutdated(devspace) : undefined;
      if (outdated) {
        this.logger.info(`${this.outdatedTexts(outdated, repository).log} It was not made again.`);
        await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
          devspaceId: devspace.id,
          containerName: this.current?.containerName ?? devspace.containerName,
          repository,
          reason: 'outdated',
        });
        return;
      }
      // A Reconnect of the user that failed leaves the window disconnected, also when the state of its container could
      // not be read before.
      if (this.current?.devspace.id === devspace.id && !this.current.lost) {
        this.current.lost = true;
        this.updateStatusBar();
      }
    }
  }

  /**
   * True if a Start with this request opens a new window (windowChoice.ts): the setting openInNewWindow, and whether this
   * window is empty or reconnects its own devspace.
   */
  private opensNewWindow(request: WindowRequest, reconnecting = false): boolean {
    return opensNewWindow({
      request,
      openInNewWindow: this.deps.settings().openInNewWindow === true,
      emptyWindow: this.deps.connection.isEmptyWindow(),
      reconnecting,
    });
  }

  /**
   * Runs a flow that ends by connecting this window, with its number for `connect`. A flow that connects a new window
   * (`newWindow`) leaves this window as it is: it is not one of the connecting flows of this window, so it neither skips
   * nor is skipped by them.
   */
  private async connectingFlow<T>(newWindow: boolean, fn: (request: ConnectRequest) => Promise<T>): Promise<T> {
    if (newWindow) return fn({ newWindow: true });
    const request = ++this.connectRequests;
    this.activeConnectRequests.add(request);
    try {
      return await fn({ newWindow: false, number: request });
    } finally {
      this.activeConnectRequests.delete(request);
    }
  }

  /**
   * Last step of the pipeline: the pending connection file, then the folder URI in this window. A flow does not connect
   * while a newer connecting flow runs in this window, for example the automatic reopen after the user selected another
   * devspace: the newest request wins, also when the older pipeline finishes first. The skipped devspace's
   * container stops after the long limit of the heartbeats of its open (stopAfterMinutes). Cancel in the progress
   * notification also counts when the pipeline has finished its last step already: the window stays as it is (Cancel
   * lets the user stay in the empty window).
   *
   * A new window (Start in New Window): the pending connection file (written with the ID of this window, the window
   * that ran the pipeline) keeps the container in use until the new window has written its status file; the new window
   * finds the fresh file at its activation, so it does not run the pipeline again (role A, `pipelineJustRan`), and
   * removes it. This window keeps its own devspace, status file, and reopen record.
   */
  private async connect(result: OpenResult, progress: ProgressReporter, request: ConnectRequest, signal: AbortSignal): Promise<void> {
    progress.step('connecting');
    // The checks of the container come first, so Cancel, a newer request, and an account change during them still keep
    // the window as it is. The log lines of the attach run meanwhile.
    const diagnostics = this.logAttachDiagnostics(result.containerName);
    const notReady = await this.readyForWindow(result.devspace, result.containerName, signal);
    const waited = new AbortController();
    // Cancel also ends this wait.
    await Promise.race([diagnostics, this.delay(ATTACH_DIAGNOSTICS_WAIT_MS, AbortSignal.any([waited.signal, signal]))]);
    waited.abort();
    if (!request.newWindow && [...this.activeConnectRequests].some((other) => other > request.number)) {
      this.logger.info(`${result.devspace.repository} is not connected: another devspace is opening in this window.`);
      return;
    }
    if (signal.aborted) {
      this.logger.info(`${result.devspace.repository} is not connected: the user cancelled.`);
      // The pipeline wrote the pending connection file for this connection; without it the container stops as usual.
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    }
    // The session is read at the start of the pipeline; the account may have changed while it ran (a build can take
    // minutes). The window connects only to a devspace of the account that is signed in now.
    const account = await this.readAccount();
    const entry = (await this.deps.registry.get(result.devspace.id).catch(() => undefined)) ?? result.devspace;
    if (!isAvailableTo(entry, account)) {
      const repository = this.displayName({ repository: result.devspace.repository });
      this.logger.info(`${repository} is not connected: the GitHub account changed while it opened.`);
      // No window connects: the Monitor container stops it when the heartbeats of the open end (their long
      // limit).
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw account
        ? new UserFacingError('otherAccount', Messages.otherAccount(repository))
        : new UserFacingError('signInRequired', Messages.signInRequired);
    }
    if (notReady) {
      // Without the pending connection file, the container stops as usual: after the long limit of the heartbeats of
      // its open (stopAfterMinutes).
      await this.deps.sessionFiles
        .removePending(result.devspace.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw notReady;
    }
    await this.deps.coordinator.writePending(result.devspace.id);
    if (request.newWindow) {
      await this.deps.connection.openInNewWindow(...(await this.windowArgs(result.devspace, result.containerName, result.remoteWorkspaceFolder)));
      return;
    }
    await this.deps.connection.open(...(await this.windowArgs(result.devspace, result.containerName, result.remoteWorkspaceFolder)));
  }

  /**
   * A first open of a repository of another owner needs a confirmation. The trust needs the list of the signed-in
   * account, so the sign-in comes first (the pipeline needs the token anyway).
   */
  private async firstOpenTrust(repository: string): Promise<boolean> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    return this.deps.sidebar.trustedOwner(splitRepository(repository).owner);
  }

  /**
   * Stops the container: every Stop runs here, one of no window and the one that a connected window hands off (its
   * reloaded empty window). First the Monitor of the engine is told to stop it (stopThroughMonitor), so the
   * Stop is not lost when VS Code quits before this stop reaches Docker; then this window's own stop with its progress
   * (usually faster), and "<owner/name> stopped." at its end. The reopen record of the devspace goes (forgetReopen).
   */
  private async stopNow(target: Target, devspace: Devspace): Promise<void> {
    const repository = this.shownName(target);
    await this.stopThroughMonitor(repository, devspace);
    await this.forgetReopen(devspace.id);
    const stopped = await this.operation(
      this.operationKey(target),
      'Stop',
      () => runWithProgress({ title: ControllerTexts.stopping(repository), task: () => this.deps.service.stop(devspace.id) }),
      { retry: () => this.stopNow(target, devspace) },
    );
    if (stopped) this.inform(ControllerTexts.stopped(repository));
  }

  /**
   * The stopNow heartbeat of the Stop of `devspace` (sendStop, within its bound); a failure is logged and the Stop
   * goes on. Not sent when the devspace is not on the Docker host of the operation (the stop refuses it), nor while
   * another window works on it (its live busy mark: the stop waits for that operation). A connected window sends it
   * from its deactivate() instead of its release (windowRelease.ts), once its connection really closes. Never throws.
   */
  private async stopThroughMonitor(repository: string, devspace: Devspace): Promise<void> {
    const monitor = this.deps.sessionMonitor;
    if (monitor === undefined) return;
    try {
      if (dockerHostOf(devspace) !== (await this.currentDockerHost())) return;
      if ((await this.otherWindowMark(devspace.id)) !== undefined) return;
      const sent = await monitor.sendStop(devspace.id);
      if (sent.ok) this.logger.info(`The Monitor of the engine of ${repository} was told to stop it: it stops the devspace also if VS Code quits first.`);
      else this.logger.warn(`The Monitor could not be told to stop ${repository}; this window stops it: ${sent.detail}`);
    } catch (error) {
      this.logger.warn(`The Monitor could not be told to stop ${repository}; this window stops it: ${errorMessage(error)}`);
    }
  }

  /**
   * A manual Stop also means "do not open it again": the reopen record of the devspace goes, so the next start of VS
   * Code does not reconnect to it. Every Stop runs here: one of no window, and the one that a connected window hands
   * off (its closing window wrote the record just before). Never throws.
   */
  private async forgetReopen(devspaceId: string): Promise<void> {
    try {
      if ((await this.deps.sessionFiles.readReopen())?.devspaceId !== devspaceId) return;
      await this.deps.sessionFiles.removeReopen();
      this.logger.info('The reopen record of the stopped devspace is removed: the next start of VS Code does not open it.');
    } catch (error) {
      this.logger.warn(`The reopen record could not be removed: ${errorMessage(error)}`);
    }
  }

  private deleteWithProgress(repository: string, devspace: Devspace, additionalVolumesToRemove: readonly string[]): Promise<void> {
    // Not cancellable: a delete that stops half-way helps nobody.
    return runWithProgress({
      title: ControllerTexts.deleting(repository),
      repository,
      // In the worker of the Docker host of the operation.
      task: (progress, signal) => this.deps.service.deleteInWorker(devspace.id, { progress, signal, additionalVolumesToRemove }),
    });
  }

  /** Rebuild of a devspace that this window may be connected to. */
  private async rebuildDevspace(target: Target, devspace: Devspace, request: { reason: PendingOperation['reason'] }): Promise<void> {
    const repository = this.shownName(target);
    // The question about the Monitor of the engine comes first, also before a hand-off: the window that runs the
    // Rebuild then asks nothing.
    await this.beforeUserFlow(devspace);
    if (this.isConnectedHere(devspace)) {
      await this.handOff(target, devspace, { operation: 'rebuild', ...request }, 'rebuild');
      return;
    }
    if (await this.connectedInOtherWindow(devspace.id)) {
      // The other window closes its connection, and its reloaded window rebuilds and connects again.
      if (!(await this.confirmOtherWindow(repository, Actions.rebuildNow))) return;
      await this.operation(this.operationKey(target), 'Rebuild', () =>
        this.requestOtherWindowHandOff(repository, devspace, { operation: 'rebuild', ...request }),
      );
      return;
    }
    await this.operation(
      this.operationKey(target),
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: async (progress, signal) => {
            // The window is not connected to this devspace, so it does not connect (the container runs until the
            // Monitor stops it). The devspace is built again from its source (sourceOf).
            await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, forceRebuild: true, source: sourceOf(devspace, this.deps.settings()) });
          },
        }),
      { retry: () => this.rebuildDevspace(target, devspace, request) },
    );
  }

  /**
   * Operation on the devspace that this window is connected to: busy mark, pending operation, then "Close Remote
   * Connection". The window becomes an empty local window, and the extension there runs the operation (role B).
   */
  private async handOff(target: Target, devspace: Devspace, request: HandOffRequest, busy?: BusyOperation): Promise<void> {
    const repository = this.shownName(target);
    await this.operation(this.operationKey(target), request.operation, () => this.handOffNow(repository, devspace, request, busy));
  }

  private async handOffNow(
    repository: string,
    devspace: Devspace,
    request: HandOffRequest,
    busy?: BusyOperation,
  ): Promise<void> {
    const { sessionFiles, coordinator, connection } = this.deps;
    await this.prepareHandOff(repository, devspace, busy);
    this.logger.info(
      `${request.operation} of ${repository}: this window closes its remote connection, and the empty window continues.`,
    );
    try {
      await sessionFiles.writeOperation({
        devspaceId: devspace.id,
        operation: request.operation,
        requestedAt: isoTime(this.clock),
        requestedBy: coordinator.windowId,
        reason: request.reason,
        additionalVolumesToRemove: request.additionalVolumesToRemove,
      });
      await connection.closeRemoteConnection();
    } catch (error) {
      await this.cancelHandOff(devspace.id);
      throw error;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.cancelHandOffIfUnclaimed(devspace.id), 'check the pending operation');
    }, this.deps.timing?.handOffCheckMs ?? HANDOFF_CHECK_MS);
    this.timers.add(timer);
  }

  /**
   * Before the connection closes: another live window must not be changing the devspace (an update, rebuild, or
   * delete). Its mark would otherwise be replaced, and the reloaded window would run a second operation on the same
   * devspace. With `operation`, sets this window's busy mark, so that the Monitor does not stop the
   * container before the reloaded window takes over.
   */
  private async prepareHandOff(
    repository: string,
    devspace: Devspace,
    operation: BusyOperation | undefined,
  ): Promise<void> {
    const owner = this.owner();
    const blocks = await this.markBlocker();
    const state: { conflict?: BusyMark } = {};
    let found: Devspace | undefined;
    if (operation) {
      const mark: BusyMark = { operation, since: isoTime(this.clock), pid: owner.pid, windowId: owner.windowId };
      found = await this.deps.registry.updateDevspace(devspace.id, (entry) => {
        if (entry.busy && blocks(entry.busy)) state.conflict = entry.busy;
        else entry.busy = mark;
      });
    } else {
      found = await this.deps.registry.get(devspace.id);
      if (found?.busy && blocks(found.busy)) state.conflict = found.busy;
    }
    if (!found) throw new UserFacingError('startFailed', Messages.noDevspace(repository));
    const conflict = state.conflict;
    if (conflict) {
      throw new UserFacingError(
        'startFailed',
        PipelineTexts.devspaceBusy(repository),
        `Busy mark: ${conflict.operation} since ${conflict.since}, process ${conflict.pid}, window ${conflict.windowId}.`,
      );
    }
  }

  /**
   * The test "a live mark of another window" (`isBlockingBusyMark`), with the window status files read once.
   */
  private async markBlocker(): Promise<(mark: BusyMark) => boolean> {
    const owner = this.owner();
    let windowStatuses: WindowStatus[] | undefined;
    try {
      windowStatuses = await this.deps.sessionFiles.readWindowStatuses();
    } catch (error) {
      this.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
    }
    const now = this.clock.now();
    return (mark) => isBlockingBusyMark(mark, owner, { now, isAlive: this.isAlive, windowStatuses });
  }

  /** The busy mark of another live window on the devspace (an operation that runs there), if any. */
  private async otherWindowMark(devspaceId: string): Promise<BusyMark | undefined> {
    const mark = (await this.deps.registry.get(devspaceId))?.busy;
    if (!mark) return undefined;
    return (await this.markBlocker())(mark) ? mark : undefined;
  }

  /**
   * Delete is possible in every state: while another window updates, rebuilds, creates, or switches the branch of the
   * devspace, the delete waits for the end of that operation, in a progress notification with Cancel. Returns false
   * when the user cancelled, or when the other window deletes the devspace itself.
   */
  private async waitForOtherWindowOperation(repository: string, devspaceId: string): Promise<boolean> {
    const mark = await this.otherWindowMark(devspaceId);
    if (!mark) return true;
    let outcome: 'free' | 'deleting' | 'cancelled' = 'deleting';
    if (mark.operation !== 'delete') {
      this.logger.info(
        `${repository} is busy (${mark.operation}) in another window (process ${mark.pid}). The delete waits for its end.`,
      );
      const pollMs = this.deps.timing?.busyPollMs ?? BUSY_POLL_MS;
      outcome = await runWithProgress({
        title: ControllerTexts.waitingForOtherWindow(repository),
        cancellable: true,
        task: async (_progress, signal): Promise<typeof outcome> => {
          for (;;) {
            await this.delay(pollMs);
            if (signal.aborted || this.disposed) return 'cancelled';
            const next = await this.otherWindowMark(devspaceId);
            if (!next) return 'free';
            if (next.operation === 'delete') return 'deleting';
          }
        },
      });
    }
    if (outcome === 'deleting') this.inform(ControllerTexts.alreadyDeleting(repository));
    if (outcome === 'cancelled') this.logger.info(`The delete of ${repository} was cancelled while it waited.`);
    return outcome === 'free';
  }

  /** This extension host still runs long after "Close Remote Connection": the connection was kept. */
  private async cancelHandOffIfUnclaimed(devspaceId: string): Promise<void> {
    if (this.disposed) return;
    // Only this devspace's file, so an unreadable file of another devspace does not keep this hand-off. When this
    // file cannot be read, its owner is not known: it throws, and the hand-off and the busy mark are kept (never
    // removed without knowing whose request it is).
    const operation = await this.deps.sessionFiles.readOperation(devspaceId);
    if (operation?.requestedBy !== this.deps.coordinator.windowId) return;
    this.logger.info('The remote connection was not closed. The pending operation is cancelled.');
    await this.cancelHandOff(devspaceId);
    this.background(this.deps.sidebar.render(), 'update the sidebar');
  }

  private async cancelHandOff(devspaceId: string): Promise<void> {
    await this.removeOperationQuietly(devspaceId);
    const owner = this.owner();
    await this.deps.registry
      .updateDevspace(devspaceId, (entry) => {
        if (entry.busy && entry.busy.windowId === owner.windowId && entry.busy.pid === owner.pid) delete entry.busy;
      })
      .catch((error: unknown) => this.logger.warn(`The busy mark could not be removed: ${errorMessage(error)}`));
  }

  /**
   * Another window is connected to the devspace (Stop, Rebuild, or Delete): that window closes its connection first.
   * This window leaves a disconnect request, which the connected window answers like its own request
   * (`checkDisconnectRequest`): VS Code asks there about unsaved files, and its reloaded empty window runs the
   * operation (role B). A request that no window takes in time is removed, and the user is told.
   */
  private async requestOtherWindowHandOff(
    repository: string,
    devspace: Devspace,
    request: HandOffRequest,
  ): Promise<void> {
    const sent: DisconnectRequest = {
      devspaceId: devspace.id,
      operation: request.operation,
      requestedAt: isoTime(this.clock),
      requestedBy: this.deps.coordinator.windowId,
      reason: request.reason,
      additionalVolumesToRemove: request.additionalVolumesToRemove,
    };
    await this.deps.disconnectRequests.write(sent);
    this.logger.info(
      `${request.operation} of ${repository}: the other window is asked to close its remote connection; its empty window continues.`,
    );
    this.inform(ControllerTexts.otherWindowContinues(repository));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.dropUnansweredRequest(repository, sent), 'check the request to the other window');
    }, this.deps.timing?.disconnectAnswerMs ?? DISCONNECT_REQUEST_MAX_AGE_MS);
    this.timers.add(timer);
  }

  /** The connected window did not take the request in time: nothing was changed. */
  private async dropUnansweredRequest(repository: string, sent: DisconnectRequest): Promise<void> {
    if (this.disposed) return;
    const { disconnectRequests } = this.deps;
    const request = await disconnectRequests.read(sent.devspaceId);
    if (!request || request.requestedAt !== sent.requestedAt || request.requestedBy !== sent.requestedBy) return;
    // `take`, so that the connected window cannot take it at the same moment.
    if (!(await disconnectRequests.take(sent.devspaceId))) return;
    this.logger.warn(`The other window did not close its connection for the ${sent.operation} of ${repository}.`);
    showWarningMessage(ControllerTexts.otherWindowNoAnswer(repository))
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  /**
   * The connected side of a disconnect request: another window stops, rebuilds, or deletes the devspace of this
   * window. This window hands off as for its own request: busy mark, pending operation, then "Close Remote Connection",
   * where VS Code asks about unsaved files. If the user keeps the connection there, the pending operation is removed
   * again (`cancelHandOffIfUnclaimed`).
   */
  private async checkDisconnectRequest(): Promise<void> {
    const current = this.current;
    if (!current || this.disposed) return;
    const { disconnectRequests, registry } = this.deps;
    const devspaceId = current.devspace.id;
    const request = await disconnectRequests.read(devspaceId);
    if (!request) return;
    const repository = this.displayName({ repository: current.devspace.repository });
    if (!isFreshDisconnectRequest(request, this.clock.now())) {
      this.logger.info(`The request of another window to close the connection to ${repository} is too old and is dropped.`);
      await disconnectRequests.remove(devspaceId);
      return;
    }
    // An operation of this devspace runs in this window (for example Reconnect): a later check answers the request.
    if (this.gate.runningFor(this.keyOfDevspace(repository, current.devspace)) !== undefined) return;
    if (!(await disconnectRequests.take(devspaceId))) return;
    const devspace = await registry.get(devspaceId);
    if (!devspace || this.current !== current) {
      this.logger.info(`The request of another window for ${repository} is dropped: this window has left the devspace.`);
      return;
    }
    if (!isAvailableTo(devspace, await this.readAccount())) {
      this.logger.info(`The request of another window for ${repository} is dropped: the devspace is of another GitHub account.`);
      return;
    }
    this.logger.info(`Another window asks this window to close its connection for the ${request.operation} of ${repository}.`);
    await this.handOff(
      this.devspaceTarget(devspace),
      devspace,
      {
        operation: request.operation,
        reason: request.reason,
        additionalVolumesToRemove: request.operation === 'delete' ? (request.additionalVolumesToRemove ?? []) : undefined,
      },
      HAND_OFF_BUSY[request.operation],
    );
  }

  /** Role B: runs a claimed pending operation. The operation file is always removed at the end. */
  private async runPendingOperation(operation: PendingOperation): Promise<void> {
    const { registry } = this.deps;
    try {
      const devspace = await registry.get(operation.devspaceId);
      if (!devspace) {
        this.logger.info(
          `The pending ${operation.operation} is dropped: the devspace ${operation.devspaceId} does not exist anymore.`,
        );
        return;
      }
      const target = this.devspaceTarget(devspace);
      this.logger.info(`Running the pending ${operation.operation} of ${this.displayName(target)}.`);
      switch (operation.operation) {
        case 'rebuild':
          // The update order, then this window connects again.
          await this.rebuildAndConnect(target, devspace, () => this.removeOperationQuietly(operation.devspaceId));
          return;
        case 'delete':
          await this.operation(
            this.operationKey(target),
            'Delete',
            () => this.deleteWithProgress(this.shownName(target), devspace, operation.additionalVolumesToRemove ?? []),
            { retry: () => this.delete({ kind: 'devspace', devspaceId: devspace.id }) },
          );
          return;
        case 'stop':
          await this.stopNow(target, devspace);
          return;
      }
    } catch (error) {
      this.showError(error);
    } finally {
      await this.removeOperationQuietly(operation.devspaceId);
    }
  }

  private async rebuildAndConnect(target: Target, devspace: Devspace, beforeConnect: () => Promise<void>): Promise<void> {
    const repository = this.shownName(target);
    await this.operation(
      this.operationKey(target),
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(false, async (connectRequest) => {
              // The devspace is built again from its source (sourceOf).
              const result = await this.deps.service.openDevspaceInWorker(devspace.id, { progress, signal, forceRebuild: true, source: sourceOf(devspace, this.deps.settings()) });
              // The window reloads when it connects; nothing after `connect` is sure to run.
              await beforeConnect();
              await this.connect(result, progress, connectRequest, signal);
            }),
        }),
      { retry: () => this.rebuildAndConnect(target, devspace, beforeConnect) },
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Connection of this window

  /**
   * Registry restored from the volumes: this window may be attached to one of the restored devspaces. Never in a
   * window of role A; one adoption at a time, and once per window.
   */
  private async adoptWindowDevspace(): Promise<void> {
    if (this.attaching || this.adopted || this.current) return;
    this.adoption ??= this.adoptWindowDevspaceNow().finally(() => {
      this.adoption = undefined;
    });
    await this.adoption;
  }

  private async adoptWindowDevspaceNow(): Promise<void> {
    const containerName = this.deps.connection.currentContainerName();
    if (!containerName) return;
    const restored = await this.deps.registry.findByContainerName(containerName);
    if (!restored || this.attaching || this.adopted) return;
    this.adopted = true;
    const devspace = await this.ownWindowDevspace(restored, containerName);
    if (!devspace || this.current) return;
    // No pipeline runs here, so a container of an older version is not made again: the window leaves it, and so it does
    // a container made while the host access checks were off, when they are on now.
    const outdated = await this.containerOutdated(devspace);
    if (this.current) return;
    if (outdated) {
      const repository = this.displayName({ repository: devspace.repository });
      this.logger.info(this.outdatedTexts(outdated, repository).log);
      await this.leaveDevspace(this.outdatedTexts(outdated, repository).message, {
        devspaceId: devspace.id,
        containerName,
        repository,
        reason: 'outdated',
      });
      return;
    }
    this.current = { devspace, containerName, lost: false };
    await this.deps.coordinator.setDevspace(devspace.id);
    this.updateStatusBar();
    // A window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(devspace.id);
    if (!(await this.stillAvailable(devspace))) return;
    this.background(this.readWindowBranch(), 'read the branch of the devspace');
  }

  /**
   * Checks the account again right after the window took `devspace` (the check of `ownWindowDevspace` ran before
   * awaits, during which the account can change without the window noticing). False when the window left it.
   */
  private async stillAvailable(devspace: Devspace): Promise<boolean> {
    await this.onSessionChanged();
    return this.current?.devspace.id === devspace.id;
  }

  /**
   * The devspace of this window was deleted, for example with "Delete devspace" when its files were missing: the
   * window leaves it and closes its remote connection, instead of offering Reconnect for a devspace that does not
   * exist anymore. Returns false when the devspace still exists.
   */
  private async leaveDeletedDevspace(devspaceId: string): Promise<boolean> {
    if (this.current?.devspace.id !== devspaceId) return false;
    try {
      if (await this.deps.registry.get(devspaceId)) return false;
    } catch (error) {
      this.logger.warn(`The registry could not be read: ${errorMessage(error)}`);
      return false;
    }
    this.logger.info('The devspace of this window was deleted. The window closes its remote connection.');
    await this.leaveDevspace();
    return true;
  }

  /**
   * The window leaves its devspace: no devspace in its status file (the coordinator sends its short release, and
   * the Monitor container stops it after the waiting time unless it is kept), the status bar, then "Close
   * Remote Connection", with `message` for the user. With `left` (a devspace that the window must not use), the
   * window does not rely on the close: VS Code lets the user keep the connection (Cancel in the dialog about unsaved
   * files), and `checkLeftConnection` closes the connection again. When the account is the reason, the token of the
   * owner account leaves the container before the close (`awaitTokenRemoval`).
   */
  private async leaveDevspace(message?: string, left?: LeftDevspace): Promise<void> {
    this.current = undefined;
    this.left = left;
    await this.deps.coordinator
      .setDevspace(null)
      .catch((error: unknown) => this.logger.warn(`The window status could not be written: ${errorMessage(error)}`));
    this.updateStatusBar();
    if (message) this.warn(message);
    if (left?.reason === 'account') {
      const requests = this.connectRequests;
      await this.awaitTokenRemoval(left, this.removeGitToken(left));
      // The owner account signed in again meanwhile, and the window reloads to open the devspace (reopenLeftDevspace).
      if (this.left !== left || this.disposed) return;
      if ([...this.activeConnectRequests].some((request) => request > requests)) {
        // A Start in this window began meanwhile and connects it elsewhere: the close must not end its pipeline.
        // Checked again later (checkLeftConnection).
        this.closeConnection(left, { closeFirst: false });
        return;
      }
    }
    this.closeConnection(left);
  }

  /**
   * "Close Remote Connection", then (with `left`) the check whether the window has closed it. Not awaited: a restored
   * window's activate() must end first, and the command reloads the window. `closeFirst: false` only schedules the
   * check.
   */
  private closeConnection(left: LeftDevspace | undefined, options: { closeFirst?: boolean } = {}): void {
    const close = options.closeFirst ?? true;
    this.background(
      this.delay(0)
        .then(() => (close ? this.deps.connection.closeRemoteConnection() : undefined))
        .finally(() => {
          // The window reloads when the connection closes, and this extension host ends: the check never runs then.
          if (!left || this.left !== left || this.disposed) return;
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.background(this.checkLeftConnection(true), 'check the connection of this window');
          }, this.deps.timing?.leaveCheckMs ?? LEAVE_CHECK_MS);
          this.timers.add(timer);
        }),
      'close the remote connection',
    );
  }

  /**
   * The window left a devspace that it must not use (`leaveDevspace` with `left`), and this extension host still
   * runs, so the window may have kept its connection. When the signed-in account may use the devspace again (the
   * user signed in with the owner account), the window reloads: the open pipeline of role A runs and writes the token
   * again. Otherwise, with `retry`, the window says so and closes its connection again.
   */
  private async checkLeftConnection(retry: boolean): Promise<void> {
    const left = this.left;
    if (!left || this.current || this.disposed || this.checkingLeft) return;
    if (this.deps.connection.currentContainerName() !== left.containerName) {
      this.left = undefined;
      return;
    }
    this.checkingLeft = true;
    try {
      if (await this.reopenLeftDevspace(left)) return;
      if (!retry) return;
      if (this.activeConnectRequests.size > 0) {
        // A Start in this window connects it elsewhere: the close must not end its pipeline. Checked again later.
        this.closeConnection(left, { closeFirst: false });
        return;
      }
      this.logger.warn(`This window is still connected to ${left.repository}, which it must not use. It closes its remote connection again.`);
      // The removal runs while the message is open; the limit of the wait counts from its end.
      const removal = left.reason === 'account' ? this.removeGitToken(left) : undefined;
      await showWarningMessage(ControllerTexts.stillConnected(left.repository), { modal: true })
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      if (removal) await this.awaitTokenRemoval(left, removal);
      // The owner account may have signed in while the message was open.
      if (await this.reopenLeftDevspace(left)) return;
      if (this.left !== left || this.current || this.disposed) return;
      if (this.activeConnectRequests.size > 0) {
        // A Start began while the message was open or during the wait (as above).
        this.closeConnection(left, { closeFirst: false });
        return;
      }
      this.closeConnection(left);
    } finally {
      this.checkingLeft = false;
    }
  }

  /**
   * The window left the devspace because of the account, and the signed-in account may use it now: the window
   * reloads, and the open pipeline of role A runs (it writes the token again). Returns true when the window reloads.
   */
  private async reopenLeftDevspace(left: LeftDevspace): Promise<boolean> {
    if (left.reason !== 'account') return false;
    const account = await this.readAccount();
    const devspace = await this.deps.registry.get(left.devspaceId).catch(() => undefined);
    if (this.left !== left || this.current || this.disposed) return false;
    if (!devspace || !isAvailableTo(devspace, account)) return false;
    this.left = undefined;
    this.logger.info(`The signed-in GitHub account may use ${left.repository} again. The window reloads to open it.`);
    await this.deps.connection.open(...(await this.windowArgs(devspace, left.containerName, devspace.remoteWorkspaceFolder ?? repositoryFolder(devspace.repository))));
    return true;
  }

  /**
   * The token of the owner account leaves the devspace that the signed-in account may not use, so that Git and the
   * GitHub CLI there cannot work as the owner while a window keeps its connection. The token is only in the memory of
   * the dev container, so it is removed from there when the container runs (the operation `tokenRemove`, a flow of the
   * worker, as root, or as the remote user of the entry when root may not); a stopped container holds no token. The
   * credential helper of the container then gives nothing; the next open of the owner writes the token again. Best
   * effort: the result is logged. Never throws.
   */
  private async removeGitToken(left: LeftDevspace): Promise<void> {
    const { containerName } = left;
    try {
      if (!this.deps.docker.isInstalled()) return;
      // Never on another Docker host (its container is not on the current engine).
      const known = await this.deps.registry.get(left.devspaceId).catch(() => undefined);
      if (known && !isOnDockerHost(known, await this.currentDockerHost())) {
        this.logger.info(`The container ${containerName} is on another Docker host. Its token is not removed from here.`);
        return;
      }
      // The flow runs in the worker of the engine (its log lines come from there), bounded
      // (TOKEN_REMOVE_FLOW_TIMEOUT_MS), through the operations of the window, as every other flow.
      await this.deps.service.removeTokenInWorker(left.devspaceId, containerName);
    } catch (error) {
      this.logger.warn(`The GitHub token could not be removed from the container ${containerName}: ${errorMessage(error)}`);
    }
  }

  /**
   * Waits for `removal` (removeGitToken) before "Close Remote Connection", which reloads the window and ends this
   * extension host, and with it a removal that has not ended. Waits at most TOKEN_REMOVE_WAIT_MS; the removal continues
   * after that while this extension host runs.
   */
  private async awaitTokenRemoval(left: LeftDevspace, removal: Promise<void>): Promise<void> {
    const waited = new AbortController();
    const limit = this.delay(this.deps.timing?.tokenRemoveWaitMs ?? TOKEN_REMOVE_WAIT_MS, waited.signal).then(() => false);
    const ended = await Promise.race([removal.then(() => true, () => true), limit]);
    waited.abort();
    if (!ended) this.logger.warn(`The GitHub token is not removed from the container ${left.containerName} yet. The window closes its remote connection without waiting longer.`);
  }

  /**
   * Role A and a restored registry: the devspace that this window is attached to, when it belongs to the signed-in
   * account (a sign-in is asked for when needed). Otherwise the window runs no pipeline, starts no container, and
   * closes its remote connection with a message; `undefined`. Assumption: the activation blocks the connection of a
   * restored window, so the window of another account never connects to a stopped container, and the token of the
   * owner leaves a container that still runs before the window connects to it (leaveDevspace, within
   * TOKEN_REMOVE_WAIT_MS); the window closes that connection right after it connected.
   */
  private async ownWindowDevspace(devspace: Devspace, containerName: string): Promise<Devspace | undefined> {
    const account = await this.readAccount(true);
    if (account && isAvailableTo(devspace, account)) return devspace;
    const repository = this.displayName({ repository: devspace.repository });
    let message: string;
    if (!account) {
      this.logger.info('Nobody is signed in to GitHub. The window closes its remote connection.');
      message = ControllerTexts.signedOutConnection(repository);
    } else {
      this.logger.info('This window is attached to a devspace of another GitHub account. It closes its remote connection.');
      message = Messages.otherAccountConnection(repository);
    }
    await this.leaveDevspace(message, { devspaceId: devspace.id, containerName, repository, reason: 'account' });
    return undefined;
  }

  /**
   * Sign-in, sign-out, or account change: a window connected to a devspace that the new account may not use closes
   * its remote connection at once, after the token of the owner left the container (leaveDevspace). The Monitor
   * container stops it after the waiting time (the release of the window). A window that has left such a devspace but
   * kept its connection reloads when the owner account signs in again.
   */
  async onSessionChanged(): Promise<void> {
    const current = this.current;
    if (this.disposed) return;
    if (!current) {
      await this.checkLeftConnection(false);
      return;
    }
    const account = await this.readAccount();
    const devspace = (await this.deps.registry.get(current.devspace.id).catch(() => undefined)) ?? current.devspace;
    if (isAvailableTo(devspace, account) || this.current !== current) return;
    const repository = this.displayName({ repository: devspace.repository });
    this.logger.info(
      account
        ? `The GitHub account changed. ${repository} belongs to another account: the window closes its remote connection.`
        : 'Nobody is signed in to GitHub anymore. The window closes its remote connection.',
    );
    await this.leaveDevspace(
      account ? Messages.otherAccountConnection(repository) : ControllerTexts.signedOutConnection(repository),
      {
        devspaceId: devspace.id,
        containerName: current.containerName,
        repository,
        reason: 'account',
      },
    );
  }

  /**
   * Why the container of the devspace exists but must not be used as it is: `version`, it was made by an older
   * version of the extension (label nimblescape.devspaces.container-version); `hostAccess`, it was made while the host
   * access checks of the repository were off, and they are on now (containerIsCurrent). `undefined` otherwise, and when
   * Docker cannot be asked. Never throws.
   */
  private async containerOutdated(devspace: Devspace): Promise<'version' | 'hostAccess' | undefined> {
    if (!this.deps.docker.isInstalled()) return undefined;
    // Read by the worker; unknown (undefined) when it cannot be read.
    const value = await this.deps.service.windowStateInWorker(devspace, devspace.containerName);
    // The window stays then, and the next check of the connection that can read it leaves an outdated container
    // (checkConnection).
    this.outdatedUncheckedFor = value === undefined ? { devspaceId: devspace.id, checks: hostAccessChecks(devspace.repository, this.deps.settings()) } : undefined;
    return value?.outdated;
  }

  /** The message and the log line when the window leaves a container for the reason of containerOutdated. */
  private outdatedTexts(reason: 'version' | 'hostAccess', repository: string): { message: string; log: string } {
    return reason === 'hostAccess'
      ? {
          message: ControllerTexts.unrestrictedContainerClosed(repository),
          log: `The container of ${repository} was made while the host access checks were off, and they are on now. The window closes its remote connection.`,
        }
      : {
          message: ControllerTexts.outdatedContainerClosed(repository),
          log: `The container of ${repository} is of an older version. The window closes its remote connection.`,
        };
  }

  /** The container of this window does not run (for example after a Docker restart). */
  private async checkConnection(): Promise<void> {
    const current = this.current;
    if (!current || this.checkingConnection || this.disposed) return;
    // While an operation of this devspace runs in this window (the open pipeline of a restored window, Reconnect),
    // the container is being started or replaced; the operation's end decides the state. Otherwise a check during the
    // pipeline could leave "Reconnect" in the status bar after a successful start.
    const repository = this.displayName({ repository: current.devspace.repository });
    const key = this.keyOfDevspace(repository, current.devspace);
    if (this.gate.runningFor(key) !== undefined) return;
    this.checkingConnection = true;
    try {
      const value = await this.windowState(current.devspace, current.containerName);
      const runs = this.deps.docker.isInstalled() ? (value === undefined ? undefined : value.state === 'running') : false;
      // The window or its operation may have changed while the worker read.
      if (this.current !== current || this.disposed || this.gate.runningFor(key) !== undefined) return;
      // Whether it is outdated could not be read when the window attached; now it can.
      const unchecked = this.outdatedUncheckedFor;
      if (value !== undefined && unchecked?.devspaceId === current.devspace.id) {
        this.outdatedUncheckedFor = undefined;
        // A container made while the checks were off is left only when they were on already when the window attached
        // ("applies from the next open").
        const sameChecks = hostAccessChecks(current.devspace.repository, this.deps.settings()) === unchecked.checks;
        if (value.outdated === 'version' || (value.outdated === 'hostAccess' && sameChecks)) {
          this.logger.info(this.outdatedTexts(value.outdated, repository).log);
          await this.leaveDevspace(this.outdatedTexts(value.outdated, repository).message, {
            devspaceId: current.devspace.id,
            containerName: current.containerName,
            repository,
            reason: 'outdated',
          });
          return;
        }
      }
      // A state that could not be read (the worker could not be reached) changes nothing but the tooltip.
      if ((runs === undefined) !== (current.unknown === true)) {
        current.unknown = runs === undefined;
        this.updateStatusBar();
      }
      if (runs === undefined) return;
      const lost = !runs;
      if (lost === current.lost) return;
      current.lost = lost;
      this.logger.info(lost ? `The container of ${repository} does not run.` : `The container of ${repository} runs again.`);
      this.updateStatusBar();
      if (this.deps.viewVisible()) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    } finally {
      this.checkingConnection = false;
    }
  }

  private async readWindowBranch(): Promise<void> {
    const current = this.current;
    if (!current) return;
    await this.checkConnection();
    // Read by the worker. A passive read, which never builds the helper image (windowStateInWorker).
    const branch = (await this.deps.service.windowStateInWorker(current.devspace, current.containerName, { branch: true }))?.branch;
    if (branch && this.current === current) {
      current.branch = branch;
      this.updateStatusBar();
    }
  }

  /**
   * The state of the container, or why it could not be read: the check of the attach (readyForWindow). Read by the
   * worker of the engine (windowStateInWorker), like every read of a container.
   */
  private async containerStateText(devspace: Devspace, containerName: string, signal: AbortSignal): Promise<string> {
    if (!this.deps.docker.isInstalled()) return 'Docker is not installed';
    // Not passive (a worker lost after the open is opened again at once), bounded, and ended by the cancel of the open.
    const value = await this.deps.service.windowStateInWorker(devspace, containerName, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(WINDOW_STATE_FLOW_TIMEOUT_MS)]),
    });
    return value === undefined ? 'not readable' : String(value.state);
  }

  /**
   * Whether the container runs, read by the worker; `undefined` when it could not be read (unknown). A Start or
   * Reconnect of the user takes unknown as "not running" and tries; its failure leaves the window disconnected.
   */
  private async containerRuns(devspace: Devspace, containerName: string): Promise<boolean | undefined> {
    if (!this.deps.docker.isInstalled()) return false;
    const value = await this.deps.service.windowStateInWorker(devspace, containerName);
    return value === undefined ? undefined : value.state === 'running';
  }

  /**
   * The state of the container and whether it is outdated, in one read of the worker (passive and bounded). `undefined`
   * when it could not be read, or Docker is not installed.
   */
  private async windowState(devspace: Devspace, containerName: string): Promise<WindowStateValue | undefined> {
    if (!this.deps.docker.isInstalled()) return undefined;
    return this.deps.service.windowStateInWorker(devspace, containerName);
  }

  private updateStatusBar(): void {
    const current = this.current;
    const { statusBar } = this.deps;
    this.updateConnectedContext(current !== undefined);
    if (!current) {
      statusBar.showStateUnknown(false);
      statusBar.showNotConnected();
      return;
    }
    const repository = this.shownName(this.devspaceTarget(current.devspace));
    statusBar.showStateUnknown(current.unknown === true);
    if (current.lost) statusBar.showConnectionLost(repository, current.devspace.id);
    else statusBar.showConnected(repository, current.branch ?? current.devspace.gitSummary?.branch ?? undefined);
  }

  /** The context key CONNECTED_CONTEXT_KEY, set when it changes. */
  private updateConnectedContext(connected: boolean): void {
    if (this.connectedContext === connected) return;
    this.connectedContext = connected;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONNECTED_CONTEXT_KEY, connected)).catch((error: unknown) =>
      this.logger.warn(`The context key ${CONNECTED_CONTEXT_KEY} could not be set: ${errorMessage(error)}`),
    );
  }

  private isConnectedHere(devspace: Devspace): boolean {
    return this.current?.devspace.id === devspace.id;
  }

  /** The status of another active window that is connected to the devspace, if any (see otherActiveWindowsKnown). */
  private async otherWindowOf(devspaceId: string): Promise<WindowStatus | undefined> {
    return (await this.otherActiveWindowsKnown()).find((window) => window.devspaceId === devspaceId);
  }

  /** Whether another active window is connected to the devspace (see otherActiveWindowsKnown). */
  private async connectedInOtherWindow(devspaceId: string): Promise<boolean> {
    return (await this.otherActiveWindowsKnown()).some((window) => window.devspaceId === devspaceId);
  }

  /**
   * The other active windows. When their files cannot be read, it is not known whether another window uses the
   * devspace, so the operation is refused (UserFacingError, otherWindowsUnknown) and nothing is stopped, removed, or
   * renamed; never "no other window".
   */
  private async otherActiveWindowsKnown(): Promise<WindowStatus[]> {
    try {
      return await this.deps.coordinator.otherActiveWindows();
    } catch (error) {
      this.logger.warn(`The other windows could not be read, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('startFailed', ControllerTexts.otherWindowsUnknown, errorMessage(error));
    }
  }

  /** Another window is connected to the devspace: it closes its connection first. */
  private async confirmOtherWindow(repository: string, action: string): Promise<boolean> {
    const choice = await showWarningMessage(
      ControllerTexts.otherWindowClosesConnection(repository),
      { modal: true },
      action,
    );
    return choice === action;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Targets and pickers

  /**
   * The target of a command: the row of the sidebar, the devspace of the status bar item, or (from the Command
   * Palette) a Quick Pick. The devspace is read from the registry again: the row may be older than the registry.
   */
  private async resolveTarget(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const target = await this.resolveTargetOfAnyAccount(argument, pick, placeholder);
    // Show on GitHub needs no devspace; every other command refuses a named devspace of another account. A
    // repository has only the devspace of the signed-in account, so it is never refused.
    if (!target || pick === 'gitHub') return target;
    return this.ownTarget(target);
  }

  /**
   * The target, when its devspace (if any) belongs to the signed-in account. Asks for a sign-in when the target has
   * a devspace and nobody is signed in. Otherwise shows Messages.otherAccount and returns `undefined`: only a
   * devspace that the command names can be one of another account (a row or the status bar item from before an
   * account change), never the devspace of a repository.
   */
  private async ownTarget(target: Target): Promise<Target | undefined> {
    const devspace = target.devspace;
    if (!devspace) return target;
    const account = await this.readAccount(true);
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    if (isAvailableTo(devspace, account)) return target;
    this.logger.info(`The devspace ${devspace.id} belongs to another GitHub account. It is not used.`);
    this.warn(Messages.otherAccount(this.shownName(target)));
    return undefined;
  }

  /**
   * The account of a session with a working token: while GitHub rejects the token of the session, the user signs in
   * again first (auth.ts). `undefined` without a sign-in, or when the session cannot be read.
   */
  private async readWorkingAccount(): Promise<GitHubAccount | undefined> {
    try {
      return (await this.deps.auth.getSession({ interactive: true }))?.account;
    } catch (error) {
      this.logger.warn(`The GitHub session could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** The signed-in account; `undefined` without a sign-in, or when the session cannot be read. */
  private async readAccount(interactive = false): Promise<GitHubAccount | undefined> {
    try {
      return await this.deps.auth.getAccount({ interactive });
    } catch (error) {
      this.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async resolveTargetOfAnyAccount(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const { registry, sidebar } = this.deps;
    // Show on GitHub needs neither a devspace nor a sign-in; Start needs a working token.
    const signIn = pick === 'gitHub' ? false : pick === 'open' || pick === 'repository' ? 'token' : true;
    switch (argument.kind) {
      case 'row': {
        const info = sidebar.repositoryInfo(argument.repository) ?? argument.info;
        // The devspace of the row while it exists; otherwise (a row without devspace, or one deleted meanwhile)
        // the devspace of the source of the row of the signed-in account.
        const named = argument.devspaceId !== undefined ? await registry.get(argument.devspaceId) : undefined;
        if (named) return { repository: argument.repository, info, devspace: named, named: true, source: sourceOf(named) };
        const target = await this.repositoryTargetFor(argument.repository, signIn, argument.source);
        return { ...target, info: target.info ?? info };
      }
      case 'devspace': {
        const devspace = await registry.get(argument.devspaceId);
        if (!devspace) {
          this.inform(PipelineTexts.devspaceMissing);
          return undefined;
        }
        return this.devspaceTarget(devspace);
      }
      case 'none': {
        if (pick === 'devspace') {
          const devspace = await this.pickDevspace(placeholder);
          return devspace ? this.devspaceTarget(devspace) : undefined;
        }
        let repositories = await sidebar.repositoriesForPicker();
        if (pick === 'gitHub') {
          repositories = repositories.filter((info) => sidebar.repositoryInfo(info.nameWithOwner) !== undefined);
        }
        if (repositories.length === 0) {
          this.inform(ControllerTexts.noRepositories);
          return undefined;
        }
        // The title "Open repository…" only where the pick opens the repository.
        const info = await pickRepository(repositories, placeholder, pick === 'open' ? undefined : null);
        if (!info) return undefined;
        // Show on GitHub needs the repository only: no source, no devspace.
        if (pick === 'gitHub') return { repository: info.nameWithOwner, info };
        return this.pickedRepositoryTarget(info.nameWithOwner, signIn);
      }
    }
  }

  private devspaceTarget(devspace: Devspace): Target {
    return { repository: devspace.repository, info: this.deps.sidebar.repositoryInfo(devspace.repository), devspace, named: true, source: sourceOf(devspace) };
  }

  /**
   * The target of a repository that a Quick Pick chose (the Command Palette, Search, the switcher): with one possible
   * source (possibleSources), that source; with several, the source that the user picks (sourceChoices), or
   * `undefined` when the pick is cancelled. `signIn` as for `repositoryTargetFor`.
   */
  private async pickedRepositoryTarget(repository: string, signIn: boolean | 'token'): Promise<Target | undefined> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const own = (await this.deps.sidebar.availableDevspaces()).filter((devspace) => devspace.repository.toLowerCase() === repository.toLowerCase());
    const sources = possibleSources({ info, devspaces: own, settings: this.deps.settings() });
    if (sources.length <= 1) return this.repositoryTargetFor(repository, signIn, sources[0]);
    const picked = await vscode.window.showQuickPick(
      sourceChoices(sources, own).map((choice) => ({ label: choice.label, description: choice.description, source: choice.source })),
      { title: ControllerTexts.selectSourceTitle, placeHolder: ControllerTexts.sourcePlaceholder(info?.nameWithOwner ?? repository), matchOnDescription: true },
    );
    return picked ? this.repositoryTargetFor(repository, signIn, picked.source) : undefined;
  }

  /**
   * The target of a repository, with the devspace of the repository of the signed-in account, if it has one. The
   * devspaces of other accounts are not looked at: they neither block nor name anything, and the first Start of an
   * account creates its own. The account decides the devspace, so with `signIn` a sign-in is asked for when nobody
   * is signed in; without it, the target has no devspace then. With `'token'` (a command that needs a working token:
   * Start) the account comes from a session with a working token, so that the new sign-in while
   * GitHub rejects the token happens before the devspace is chosen: an account change at that sign-in then chooses
   * the devspace of the new account.
   */
  private async repositoryTargetFor(repository: string, signIn: boolean | 'token', source?: DevspaceSource): Promise<Target> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const account = signIn === 'token' ? await this.readWorkingAccount() : await this.readAccount(signIn);
    if (signIn && !account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    // The devspace of the source of the repository; without a source (a repository with one source that the discovery
    // does not know), its most recently used devspace.
    const devspace = account
      ? await this.deps.registry.findForAccount(repository, account.id, await this.currentDockerHost(), source)
      : undefined;
    return { repository, info, devspace, ...(source !== undefined ? { source } : {}) };
  }

  /**
   * The target with the current registry entry (for Try again, and after a change of the devspace): a named
   * devspace while it exists, otherwise the devspace of the repository of the account that is signed in now, if
   * any. A repository never carries the devspace of the account that was signed in before. `signIn` as for
   * `repositoryTargetFor`. The source stays the one of the target.
   */
  private async refreshedTarget(target: Target, signIn: boolean | 'token' = false): Promise<Target> {
    const current = target.named && target.devspace ? await this.deps.registry.get(target.devspace.id) : undefined;
    const fresh = current
      ? this.devspaceTarget(current)
      : await this.repositoryTargetFor(target.devspace?.repository ?? target.repository, signIn, target.source ?? (target.devspace ? sourceOf(target.devspace) : undefined));
    return { ...fresh, info: fresh.info ?? target.info };
  }

  private requireDevspace(target: Target | undefined): Devspace | undefined {
    if (target && !target.devspace) this.inform(Messages.noDevspace(this.shownName(target)));
    return target?.devspace;
  }

  /** `owner/name` as GitHub writes it, when known. */
  private displayName(target: Target): string {
    return (
      target.info?.nameWithOwner ??
      this.deps.sidebar.repositoryInfo(target.repository)?.nameWithOwner ??
      target.devspace?.repository ??
      target.repository
    );
  }

  /**
   * The name of a target in the texts of the user, as the sidebar names it (devspaceName): its repository
   * (displayName), with the word of its source when the repository has child rows (`acme/api · default`,
   * `acme/api · config`, `acme/api · python`); the repository alone when it has one row.
   */
  private shownName(target: Target): string {
    const repository = this.displayName(target);
    const source = target.devspace ? sourceOf(target.devspace) : target.source;
    if (source === undefined) return repository;
    return devspaceName(repository, source, this.hasChildRows(target));
  }

  /**
   * Whether the sidebar shows the repository of a target with child rows: it has two or more possible sources
   * (possibleSources, as repositoryEntries of the tree model counts them) from its GitHub data, the devspaces of its
   * rows in the last render of the sidebar, the devspace of the target, and the settings.
   */
  private hasChildRows(target: Target): boolean {
    const key = target.repository.toLowerCase();
    const info = target.info ?? this.deps.sidebar.repositoryInfo(target.repository);
    const devspaces = repositoryRows(this.deps.sidebar.model())
      .filter((row) => row.repository.toLowerCase() === key || row.devspace?.repository.toLowerCase() === key)
      .flatMap((row) => (row.devspace ? [row.devspace] : []));
    if (target.devspace && !devspaces.some((devspace) => devspace.id === target.devspace?.id)) devspaces.push(target.devspace);
    return possibleSources({ info, devspaces, settings: this.deps.settings() }).length >= 2;
  }

  /**
   * The key of the operations of a target in the gate of this window (sourceOperationKey): the operations of one
   * devspace run one after the other, those of two devspaces of one repository (its sources) next to each other.
   * A target without a source (a repository with one source that the discovery does not know) has a key of its own.
   */
  private operationKey(target: Target): string {
    const repository = this.displayName(target);
    const source = target.devspace ? sourceOf(target.devspace) : target.source;
    return source !== undefined ? sourceOperationKey(repository, source) : `${repository.toLowerCase()}#`;
  }

  /** The key of the operations of a devspace (operationKey) under the name `repository`. */
  private keyOfDevspace(repository: string, devspace: Devspace): string {
    return sourceOperationKey(repository, sourceOf(devspace));
  }

  private async pickDevspace(placeholder: string): Promise<Devspace | undefined> {
    const { sidebar } = this.deps;
    const devspaces = await sidebar.availableDevspaces();
    if (devspaces.length === 0) {
      this.inform(ControllerTexts.noDevspaces);
      return undefined;
    }
    await this.renderQuietly();
    const items = recentDevspaces(sidebar.model(), devspaces).map((entry) => ({
      label: entry.state ? `$(${stateIcon(entry.state).id}) ${entry.name}` : entry.name,
      description: entry.description,
      devspaceId: entry.devspaceId,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
    return picked ? devspaces.find((devspace) => devspace.id === picked.devspaceId) : undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  /**
   * Runs an operation: at most one per devspace in this window (`key`: operationKey; a second request is ignored with a
   * log line), errors are shown with the action Try again where the error offers it (errors.ts), and the sidebar is
   * updated afterwards. Returns true when the operation ran without an error.
   */
  private async operation(
    key: string,
    label: string,
    fn: () => Promise<void>,
    options: { retry?: () => Promise<void>; refused?: () => void } = {},
  ): Promise<boolean> {
    await this.ready;
    try {
      const outcome = await this.gate.run(key, label, () => this.withDockerTarget(fn));
      if (!outcome.started) {
        this.logger.info(`${label} of ${key} was not started: ${outcome.running} of ${key} is still running.`);
        options.refused?.();
        return false;
      }
      return true;
    } catch (error) {
      this.showError(error, options.retry);
      return false;
    } finally {
      if (!this.disposed) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    }
  }

  /** Runs `fn` as one operation on the Docker host that is current now (DockerTargets.withOperation). */
  private withDockerTarget<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.dockerTargets ? this.deps.dockerTargets.withOperation(fn) : fn();
  }

  /** The Docker target of the operation (outside of one, the current one); the local Docker without dockerTargets. */
  private async operationTarget(): Promise<DockerTarget> {
    return this.deps.dockerTargets ? this.deps.dockerTargets.current() : LOCAL_DOCKER_TARGET;
  }

  /**
   * Before a Start, a Rebuild or "Update All Images Now" that the user started on the engine of the operation: the
   * question about the Monitor of that engine (MonitorQuestion, once per engine), so the Monitor that the flow makes
   * sure of follows the answer. Not for a target that is neither local nor SSH (every operation refuses it), nor for a
   * `devspace` of another Docker host (its open is refused). Never throws.
   */
  private async beforeUserFlow(devspace?: Devspace): Promise<void> {
    const target = await this.operationTarget();
    if (target.kind === 'unsupported' || (devspace !== undefined && !isOnDockerHost(devspace, target.host))) return;
    await this.deps.monitorQuestion?.askIfNeeded(target.host);
  }

  /** The Docker host of the operation ('' = the local Docker). */
  private async currentDockerHost(): Promise<string> {
    return this.deps.dockerTargets ? (await this.deps.dockerTargets.current()).host : '';
  }

  /**
   * A restored window whose devspace is on another Docker host than the current Docker context asks "Use <host>
   * again?" (RemoteDockerCommands.offerSwitchBack: the same test and modal as the commands). True when Docker uses the
   * devspace's host (then the open continues); otherwise the window closes its remote connection with the message,
   * and nothing runs on the other host. The pipeline of this extension runs on the current context; the Dev Containers
   * extension attaches through the context in the window's authority. Assumption: VS Code waits for activate() before
   * it resolves the authority.
   */
  private async onWindowHost(devspace: Devspace): Promise<boolean> {
    if (!this.deps.dockerTargets) return true;
    const current = await this.deps.dockerTargets.resolve();
    if (isOnDockerHost(devspace, current.host)) return true;
    const devspaceHost = dockerHostOf(devspace);
    this.logger.info(
      `This window's devspace is on ${describeDockerHost(devspaceHost)}, and Docker is set to ${describeDockerHost(current.host)}.`,
    );
    const switched = (await this.deps.remoteDocker?.offerSwitchBack(devspaceHost, current)) ?? false;
    if (switched) {
      const now = await this.deps.dockerTargets.resolve();
      if (isOnDockerHost(devspace, now.host)) return true;
    }
    const repository = this.displayName({ repository: devspace.repository });
    this.logger.info('The window closes its remote connection: its devspace is on another Docker host.');
    await this.leaveDevspace(Messages.otherDockerHost(repository, devspaceHost, current.host));
    return false;
  }

  private showError(error: unknown, retry?: () => Promise<void>): void {
    presentError(error, { logger: this.logger, showLog: () => this.logger.show(), retry });
  }

  /** Renders the sidebar, so that pickers show current states. Never throws. */
  private async renderQuietly(): Promise<void> {
    await this.deps.sidebar
      .render()
      .catch((error: unknown) => this.logger.warn(`The sidebar could not be updated: ${errorMessage(error)}`));
  }

  private inform(message: string): void {
    showInformationMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  private warn(message: string): void {
    showWarningMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  private background(promise: Promise<unknown>, what: string): void {
    promise.catch((error: unknown) => this.logger.error(`Could not ${what}.`, error));
  }

  private async removeOperationQuietly(devspaceId: string): Promise<void> {
    await this.deps.sessionFiles
      .removeOperation(devspaceId)
      .catch((error: unknown) => this.logger.warn(`The pending operation could not be removed: ${errorMessage(error)}`));
  }

  private owner(): { windowId: string; pid: number } {
    return { windowId: this.deps.coordinator.windowId, pid: process.pid };
  }

  /**
   * The arguments of ConnectionAdapter.open and openInNewWindow for `devspace`: the container, the folder, and for
   * a devspace on another Docker host its Docker context (without it in the authority, the Dev Containers extension
   * asks the local Docker first and reports the container as one that "no longer exists"). The context, in this order:
   * - the one of the running operation, when that is on the devspace's host (a context that the user made; none when
   *   DOCKER_HOST decides);
   * - outside an operation, the one in the authority of this window when it shows the same container;
   * - the current context, when that is on the devspace's host (read outside any operation);
   * - else the one that "Use a Remote Docker Host…" creates for the host (ensureRemoteContext: created when missing).
   */
  private async windowArgs(
    devspace: Devspace,
    containerName: string,
    folder: string,
  ): Promise<[containerName: string, folder: string, dockerContext?: string]> {
    const host = dockerHostOf(devspace);
    if (host === '') return [containerName, folder];
    const withContext = (context: string | undefined): [string, string, string?] =>
      context === undefined ? [containerName, folder] : [containerName, folder, context];
    const target = operationDockerTarget();
    if (target && isOnDockerHost(devspace, target.host)) return withContext(target.context);
    if (this.deps.connection.currentContainerName() === containerName) {
      const own = this.deps.connection.currentDockerContext();
      if (own !== undefined) return withContext(own);
    }
    const targets = this.deps.dockerTargets;
    if (targets) {
      const current = await outsideOperation(() => targets.resolve());
      if (isOnDockerHost(devspace, current.host)) return withContext(current.context);
    }
    return withContext(await ensureRemoteContext(this.deps.docker, host));
  }

  /**
   * The arguments that show the other window `other` of `devspace`: exactly the URI of that window, with the context
   * of its status file (none for a window without one), so that VS Code finds it. The status is the one read for the
   * decision (no second read).
   */
  private otherWindowArgs(devspace: Devspace, folder: string, other: WindowStatus): [containerName: string, folder: string, dockerContext?: string] {
    if (dockerHostOf(devspace) === '' || other.dockerContext === undefined) return [devspace.containerName, folder];
    return [devspace.containerName, folder, other.dockerContext];
  }

  /**
   * Logs which Docker the Dev Containers extension will ask when the window switches to `containerName`
   * (attachDiagnostics.ts), with the context of the running operation. Only log lines; never rejects.
   */
  private async logAttachDiagnostics(containerName: string): Promise<void> {
    try {
      if (!this.deps.docker.isInstalled()) return;
      const context = operationDockerTarget()?.context;
      const lines = await attachDiagnostics(this.deps.docker, this.deps.docker.processEnv(), containerName, context);
      for (const line of lines) this.logger.info(`Before the window connects: ${line}`);
    } catch (error) {
      this.logger.warn(`The Docker of the attach could not be logged: ${errorMessage(error)}`);
    }
  }

  /**
   * The window connects only to a container that the Docker of the window finds running. The Dev Containers extension
   * of the window attaches through the Docker context in the window's authority (or, without one, the local Docker),
   * and reports a container that it does not find as one that "no longer exists". So right before the window connects:
   * the current Docker context is still on the host of the devspace (another window or Docker Desktop may have
   * changed it while the pipeline ran), and the container answers as running (a few checks, 1 s apart, for an engine
   * that answers late). Returns the error of the refusal, or undefined when the window may connect. Stops early when
   * `signal` aborts (the caller then reports the cancel).
   */
  private async readyForWindow(devspace: Devspace, containerName: string, signal: AbortSignal): Promise<UserFacingError | undefined> {
    const repository = this.displayName({ repository: devspace.repository });
    const targets = this.deps.dockerTargets;
    if (targets) {
      // The current context itself, not the one this operation is pinned to (DOCKER_CONTEXT).
      const current = await outsideOperation(() => targets.resolve());
      if (!isOnDockerHost(devspace, current.host)) {
        const devspaceHost = dockerHostOf(devspace);
        this.logger.warn(
          `${repository} is not connected: Docker is set to ${describeDockerHost(current.host)} now, the container runs on ${describeDockerHost(devspaceHost)}.`,
        );
        return new UserFacingError('otherDockerHost', Messages.otherDockerHostAfterStart(repository, devspaceHost, current.host));
      }
    }
    // The last state that Docker reported goes into the log (Show details).
    let state = 'not read';
    for (let attempt = 1; attempt <= READY_CHECKS; attempt++) {
      if (signal.aborted) return undefined;
      state = await this.containerStateText(devspace, containerName, signal);
      if (state === 'running') return undefined;
      if (attempt < READY_CHECKS) await this.delay(this.deps.timing?.readyPollMs ?? READY_POLL_MS, signal);
    }
    if (signal.aborted) return undefined;
    this.logger.warn(`${repository} is not connected: the container ${containerName} does not run (state: ${state}).`);
    return new UserFacingError('startFailed', Messages.containerNotReady(repository, containerName));
  }

  /** Waits `ms`; ends early when `signal` aborts, at once when it has aborted already. */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.timers.delete(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.timers.add(timer);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** The names without repeats (compared without case and surrounding spaces), in their order. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

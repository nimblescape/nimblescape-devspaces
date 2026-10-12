// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User-visible texts of the controller that messages.ts lacks (plain language); to be moved there.
// No `vscode` import.

export const ControllerTexts = {
  // Progress titles (one notification per operation).
  stopping: (repository: string) => `Stopping ${repository}…`,
  // When the Stop has ended.
  stopped: (repository: string) => `${repository} stopped.`,
  // A Start in the window of the devspace whose container could not be read.
  containerStateUnreadable: (repository: string) => `The state of the container of ${repository} could not be read. Details are in the log.`,
  deleting: (repository: string) => `Deleting the devspace of ${repository}…`,
  rebuilding: (repository: string) => `Rebuilding ${repository}…`,
  checkingChanges: (repository: string) => `Checking ${repository} for changes…`,
  readingConfigurations: (repository: string) => `Reading the configurations of ${repository}…`,
  waitingForOtherWindow: (repository: string) => `Waiting until another window has finished changing ${repository}…`,
  // Messages.
  alreadyConnected: (repository: string) => `This window is connected to ${repository}.`,
  // Keep Running When Closed and Stop When Closed.
  keptRunning: (repository: string) =>
    `${repository} keeps running when no window uses it. Stop it yourself when you no longer need it.`,
  stopsWhenClosed: (repository: string) => `${repository} stops when no window uses it.`,
  keepAllRunning: 'The setting "Stop On Close" is off, so all devspaces keep running when no window uses them.',
  // Close and Keep Running.
  closeAndKeepRunningNotConnected: 'This window is not connected to a devspace.',
  // "Update All Images Now" (`engine`: describeDockerHost).
  requestingImageUpdate: (engine: string) => `Asking the Session Monitor on ${engine} to update the images…`,
  imagesUpdatingNow: (engine: string) => `The Session Monitor on ${engine} updates the images now.`,
  // On every engine; for the local Docker (host '') the Session Monitor there is named.
  closeAndKeepRunningUnreachable: (host: string, minutes: number) =>
    `${host === '' ? 'The Session Monitor of the local Docker' : `The Docker host ${host}`} cannot be reached. The container would stop after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without contact. The window stays open.`,
  /**
   * Keep Running When Closed or Stop When Closed was stored, but the Session Monitor of the engine could not be told at
   * once (the windows that use the devspace tell it at their next heartbeat).
   */
  keepRunningNotSent: (repository: string) =>
    `The Session Monitor on the Docker engine of ${repository} could not be told about this choice yet (see the Devspaces output). While no window uses ${repository}, it follows its earlier choice.`,
  // Stop, Rebuild, and Delete of a devspace that another window uses: that window closes its connection first.
  otherWindowClosesConnection: (repository: string) =>
    `${repository} is open in another window. That window closes its connection first.`,
  /**
   * The window status files could not be read, so it is not known whether another window uses the devspace; the
   * operation is refused.
   */
  otherWindowsUnknown:
    'It could not be checked whether another window uses this devspace: the window status files could not be read. Nothing was changed; see the Devspaces output.',
  /** A pending operation (a Stop, Rebuild or Delete handed over by a window) could not be read. */
  pendingOperationsUnreadable: (cause: string) =>
    `A pending operation could not be read and was not run (${cause}). Run it again if it is still needed; see the Devspaces output.`,
  otherWindowContinues: (repository: string) =>
    `The other window of ${repository} closes its connection. The operation continues in that window.`,
  otherWindowNoAnswer: (repository: string) =>
    `The other window of ${repository} did not close its connection. Nothing was changed.`,
  alreadyDeleting: (repository: string) => `The devspace of ${repository} is being deleted in another window.`,
  // Accounts. A named devspace of another account: Messages.otherAccount.
  signedOutConnection: (repository: string) =>
    `Nobody is signed in to GitHub. This window closes its connection to the devspace of ${repository}. Sign in with GitHub to use it again.`,
  /** The window kept its connection after it left a devspace that it must not use (for example Cancel on unsaved files). */
  stillConnected: (repository: string) =>
    `This window is still connected to the devspace of ${repository}, which it must not use. Save your files: the window closes its connection again.`,
  /** A container of an older version lacks the current setup. */
  outdatedContainerClosed: (repository: string) =>
    `The container of ${repository} was made by an older version of Devspaces and cannot be used. This window closes its connection. Start ${repository} again to make a new container.`,
  /**
   * A container that was made while the host access checks of the repository were off, and they are on now.
   */
  unrestrictedContainerClosed: (repository: string) =>
    `The container of ${repository} was made while the host access checks were off. They are on now, so it cannot be used. This window closes its connection. Start ${repository} again to make a new container with the checks.`,
  noDevspaces: 'There is no devspace yet. Start a repository to create one.',
  noRepositories: 'No repository is available. Sign in with GitHub, or refresh the list.',
  // Buttons.
  stop: 'Stop',
  // Quick Picks.
  selectRepositoryToStart: 'Select a repository to open in this window',
  selectDevspaceToStop: 'Select a devspace to stop',
  selectDevspaceToKeepRunning: 'Select a devspace to keep running when closed',
  selectDevspaceToStopWhenClosed: 'Select a devspace to stop when closed',
  selectDevspaceToDelete: 'Select a devspace to delete',
  selectDevspaceToRebuild: 'Select a devspace to rebuild',
  selectRepositoryForConfiguration: 'Select a repository to select its configuration',
  selectRepositoryForGitHub: 'Select a repository to show on GitHub',
  selectConfigurationTitle: 'Select Configuration',
  configurationPlaceholder: (repository: string) => `Select a configuration of ${repository}`,
  current: 'current',
} as const;

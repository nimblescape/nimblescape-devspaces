// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of package.json. No `vscode` import.

export const Commands = {
  start: 'devspaces.start',
  // Start in a new window, or (while the setting openInNewWindow is on) in the current window.
  startInNewWindow: 'devspaces.startInNewWindow',
  startInCurrentWindow: 'devspaces.startInCurrentWindow',
  // Start with the other source than the setting startWithDefaultImage gives plain Start: the default image of the
  // setting defaultImage, or the configuration of the repository. The menus show one of the two, only with a default
  // image (context key devspaces.hasDefaultImage).
  startWithDefaultImage: 'devspaces.startWithDefaultImage',
  startWithConfiguration: 'devspaces.startWithConfiguration',
  stop: 'devspaces.stop',
  delete: 'devspaces.delete',
  selectConfiguration: 'devspaces.selectConfiguration',
  rebuild: 'devspaces.rebuild',
  showOnGitHub: 'devspaces.showOnGitHub',
  switchDevspace: 'devspaces.switchDevspace',
  // The switcher for a new window, or (while the setting openInNewWindow is on) for the current window.
  switchDevspaceInNewWindow: 'devspaces.switchDevspaceInNewWindow',
  switchDevspaceInCurrentWindow: 'devspaces.switchDevspaceInCurrentWindow',
  refresh: 'devspaces.refresh',
  search: 'devspaces.search',
  showLog: 'devspaces.showLog',
  signIn: 'devspaces.signIn',
  selectOwners: 'devspaces.selectOwners',
  /** The same command with the filled filter icon, for the view title bar while the setting `owners` is set. */
  selectOwnersFiltered: 'devspaces.selectOwnersFiltered',
  // The switch of the setting showOnlyDevspaces; the view title bar shows one of the two.
  showOnlyDevspaces: 'devspaces.showOnlyDevspaces',
  showAllRepositories: 'devspaces.showAllRepositories',
  // Expand All in the view title bar, next to VS Code's own Collapse All.
  expandAll: 'devspaces.expandAll',
  // The editor of the setting repositoryGroups (Command Palette, view title "…" menu, link in the setting).
  editRepositoryGroups: 'devspaces.editRepositoryGroups',
  // The switch of the host access checks of a repository (row context menu only, hidden in the Command Palette).
  turnOffHostAccessChecks: 'devspaces.turnOffHostAccessChecks',
  turnOnHostAccessChecks: 'devspaces.turnOnHostAccessChecks',
  // The switch Keep Running When Closed of a devspace. The row context menu shows one of the two; the Command
  // Palette offers both with a picker of the devspaces, as Stop.
  keepRunning: 'devspaces.keepRunning',
  stopWhenClosed: 'devspaces.stopWhenClosed',
  // Close and Keep Running: closes the window of a devspace; its container keeps running this time. Only in a
  // window connected to a devspace (context key devspaces.connected) and in its row.
  closeAndKeepRunning: 'devspaces.closeAndKeepRunning',
  // The buttons of the Docker setup in the sidebar (welcome view), Start Docker after an installation and of the error
  // "Docker is not running." (Docker Engine on Linux), and Show Docker Setup, the action Install Docker… of the error
  // "Docker Desktop is not installed." (all hidden in the Command Palette).
  dockerSetupInstall: 'devspaces.dockerSetup.install',
  dockerSetupStart: 'devspaces.dockerSetup.start',
  dockerSetupInstallWsl: 'devspaces.dockerSetup.installWsl',
  dockerSetupShow: 'devspaces.dockerSetup.show',
  // Docker on another computer through the Docker context, and back.
  useRemoteDockerHost: 'devspaces.useRemoteDockerHost',
  useLocalDocker: 'devspaces.useLocalDocker',
  // The choice of the Docker host, the command of the first row of the view (hidden in the Command Palette): another
  // remote host, or the local Docker.
  chooseDockerHost: 'devspaces.chooseDockerHost',
  // Forgets every "Don't Ask Again" of the Docker host questions.
  askAgainDockerHost: 'devspaces.askAgainDockerHost',
  // The command of a repository row (TreeItem.command, hidden in the Command Palette): a double-click runs Start
  // (rowActivation.ts).
  rowActivated: 'devspaces.rowActivated',
  // The link "Show details" of a progress notification (hidden from the Command Palette).
  showProgressDetails: 'devspaces.showProgressDetails',
  // The Monitor of the current Docker engine runs its background run at once (the images in use, the VS Code
  // server and the extensions), for example after a new image was pushed (Command Palette, the "…" menu of the view).
  updateImagesNow: 'devspaces.updateImagesNow',
} as const;

export type CommandName = keyof typeof Commands;

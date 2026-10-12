// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of package.json. No `vscode` import.

export const Commands = {
  start: 'devspace.start',
  // Start in a new window, or (while the setting openInNewWindow is on) in the current window.
  startInNewWindow: 'devspace.startInNewWindow',
  startInCurrentWindow: 'devspace.startInCurrentWindow',
  stop: 'devspace.stop',
  delete: 'devspace.delete',
  selectConfiguration: 'devspace.selectConfiguration',
  rebuild: 'devspace.rebuild',
  showOnGitHub: 'devspace.showOnGitHub',
  switchDevspace: 'devspace.switchDevspace',
  // The switcher for a new window, or (while the setting openInNewWindow is on) for the current window.
  switchDevspaceInNewWindow: 'devspace.switchDevspaceInNewWindow',
  switchDevspaceInCurrentWindow: 'devspace.switchDevspaceInCurrentWindow',
  refresh: 'devspace.refresh',
  search: 'devspace.search',
  showLog: 'devspace.showLog',
  signIn: 'devspace.signIn',
  selectOwners: 'devspace.selectOwners',
  /** The same command with the filled filter icon, for the view title bar while the setting `owners` is set. */
  selectOwnersFiltered: 'devspace.selectOwnersFiltered',
  // The switch of the setting showOnlyDevspaces; the view title bar shows one of the two.
  showOnlyDevspaces: 'devspace.showOnlyDevspaces',
  showAllRepositories: 'devspace.showAllRepositories',
  // Expand All in the view title bar, next to VS Code's own Collapse All.
  expandAll: 'devspace.expandAll',
  // The editor of the setting repositoryGroups (Command Palette, view title "…" menu, link in the setting).
  editRepositoryGroups: 'devspace.editRepositoryGroups',
  // The switch of the host access checks of a repository (row context menu only, hidden in the Command Palette).
  turnOffHostAccessChecks: 'devspace.turnOffHostAccessChecks',
  turnOnHostAccessChecks: 'devspace.turnOnHostAccessChecks',
  // The switch Keep Running When Closed of a devspace. The row context menu shows one of the two; the Command
  // Palette offers both with a picker of the devspaces, as Stop.
  keepRunning: 'devspace.keepRunning',
  stopWhenClosed: 'devspace.stopWhenClosed',
  // Close and Keep Running: closes the window of a devspace; its container keeps running this time. Only in a
  // window connected to a devspace (context key devspace.connected) and in its row.
  closeAndKeepRunning: 'devspace.closeAndKeepRunning',
  // The buttons of the Docker setup in the sidebar (welcome view), Start Docker after an installation and of the error
  // "Docker is not running." (Docker Engine on Linux), and Show Docker Setup, the action Install Docker… of the error
  // "Docker Desktop is not installed." (all hidden in the Command Palette).
  dockerSetupInstall: 'devspace.dockerSetup.install',
  dockerSetupStart: 'devspace.dockerSetup.start',
  dockerSetupInstallWsl: 'devspace.dockerSetup.installWsl',
  dockerSetupShow: 'devspace.dockerSetup.show',
  // Docker on another computer through the Docker context, and back.
  useRemoteDockerHost: 'devspace.useRemoteDockerHost',
  useLocalDocker: 'devspace.useLocalDocker',
  // The choice of the Docker host, the command of the first row of the view (hidden in the Command Palette): another
  // remote host, or the local Docker.
  chooseDockerHost: 'devspace.chooseDockerHost',
  // Forgets every "Don't Ask Again" of the Docker host questions.
  askAgainDockerHost: 'devspace.askAgainDockerHost',
  // The command of a repository row (TreeItem.command, hidden in the Command Palette): a double-click runs Start
  // (rowActivation.ts).
  rowActivated: 'devspace.rowActivated',
  // The link "Show details" of a progress notification (hidden from the Command Palette).
  showProgressDetails: 'devspace.showProgressDetails',
  // The Monitor of the current Docker engine runs its background run at once (the images in use, the VS Code
  // server and the extensions), for example after a new image was pushed (Command Palette, the "…" menu of the view).
  updateImagesNow: 'devspace.updateImagesNow',
} as const;

export type CommandName = keyof typeof Commands;

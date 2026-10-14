# Change log

Each section lists the changes of one released version. The release workflow
takes the section of a version as the notes of its GitHub release.

## 0.6.0

**One devspace per source:** a devspace is now created for one source of its repository, a Dev Container configuration or the default image, and keeps it. A repository with several sources (several configurations, or a configuration and the default image of the setting devspaces.defaultImage) shows one child row per source in the sidebar, labelled default, config, or the folder name of the configuration; each child row is its own devspace with its own clone, so the default-image devspace and the configuration devspace of a repository can run at the same time, also each in its own window. The buttons, the state and the context menu of such a repository are on its child rows. The commands Start with Default Image, Start with Configuration and Select Configuration… are gone: Start on a row starts the devspace of that source, and a start from the Command Palette, Search or the switcher asks for the source when a repository has several. The setting devspaces.startWithDefaultImage now only places the default row first (on) or last (off). A changed default image in the settings still asks Rebuild now or Later at the next start of a default-image devspace.

The Docker names of a new devspace carry the word of its source before the random pair: devspaces-<owner>-<repo>-default-<pair>, devspaces-<owner>-<repo>-config-<pair>, or devspaces-<owner>-<repo>-<configuration name>-<pair> for the container and the workspace volume; the devspace image and the Docker Compose project keep the name without the word. The workspace volume is labelled with its source (nimblescape.devspaces.config-path or nimblescape.devspaces.default-image), so a registry rebuilt from the volumes keeps the source of every devspace. Existing devspaces keep their names: an entry last started from the default image is the default-image devspace of its repository, every other entry the devspace of its configuration; no migration is needed.

## 0.5.0

**Docker names, without migration:** the image of the worker is now devspaces-worker:<hash> (was devspaces-helper:<hash>), its cache volume devspaces-worker-cache (was devspaces-helper-cache), and its labels nimblescape.devspaces.worker, nimblescape.devspaces.worker-run and nimblescape.devspaces.worker-channel (were nimblescape.devspaces.helper...). The new image is built at the first use. After the update, remove the old devspaces-helper images and the devspaces-helper-cache volume on each Docker engine by hand; the steps are in the user guide, section [Update from version 0.4.0 or older](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md#update-from-version-040-or-older).

The worker container of a window that is not a devspace is now named devspaces-<window>-worker<number>, for example devspaces-api-worker1 (was devspaces-worker-api-1), in the same form as the worker of a devspace window, <devspace>-worker<number>.

## 0.4.0

**Default image:** the new setting devspaces.defaultImage names an image that Start can use in place of the Dev Container configuration of a repository. The setting devspaces.startWithDefaultImage (on by default) decides what a plain Start uses while a default image is set; the context menu of a row and the command palette offer the other source with Start with Configuration and Start with Default Image. A devspace built from the other source is built again from the selected one: its container is created again, and the files of its workspace volume stay. When a default image is set, the sidebar, Search and the switcher also list the repositories without a Dev Container configuration; their devspaces always start from the default image.

The worker container of a devspace window is now named after the devspace, <devspace>-worker<number>, for example devspaces-majikmate-module-html-css-2-sturdy-kahn-worker1. Other windows keep devspaces-worker-<window>-<number>.

CI now also runs tests in the VS Code window of a devspace container (attach tests): the security settings of Dev Containers, the shared VS Code server, postAttachCommand, forwarded ports, and a re-attach after a restart of VS Code.

## 0.3.0

**Breaking change, without migration:** Devspaces now uses the name of the extension everywhere. Settings, commands and keybindings are devspaces.<key> (was devspace.<key>); settings and keybindings with the old IDs are not read any more, so rename them by hand. The Docker objects are devspaces-... (was devspace-...) and their labels nimblescape.devspaces.... (was nimblescape.devspace....). This version does not show or use the devspaces of version 0.2.1 and older: push the changes in each devspace before the update, and after the update remove the old devspace-... containers, volumes, images and networks on each Docker engine before you start a devspace. A start of a repository then creates a new devspace and clones the repository again. All computers that use one Docker engine need the same version. The steps are in the user guide, section [Update from version 0.2.1 or older](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md#update-from-version-021-or-older).

The worker container of a window is now named after the window, for example devspaces-worker-api-1: the name of the saved workspace file or of the first folder, then a number. So docker ps shows which window a worker belongs to. The tests in a real VS Code now also run on Windows and macOS and against the packaged VSIX.

## 0.2.1

The Monitor tries a background run again when the run reached no server, for example right after a wake from hibernation before the Wi-Fi or VPN is back: after 2, 5, 10, 20 and 30 minutes, then every hour, until a run reaches the network. The Monitor now runs permanently on every Docker engine, local or remote, so its background work also runs while no devspace runs; the setting devspace.stopMonitorWhenIdle (off by default) ends it after 5 minutes without a running devspace. The check of a restarted Monitor reads its stored script through the archive endpoint of the Docker engine instead of running a command in the container, so a Monitor whose first load was cut off is replaced reliably.

## 0.2.0

The containers and the volume of Devspaces on a Docker engine have clearer names: the worker of a window is devspace-worker-<12 characters> (was devspace-channel-...), and the Monitor (was Session Monitor) is the container and volume devspace-monitor (was devspace-session-monitor), as its image devspace-monitor. The new Monitor starts with an empty volume; remove an old devspace-session-monitor container and volume by hand.

## 0.1.8

Maintenance release: CI runs the unit tests also as root, so the tests of the helper scripts that need root run before each release; the extension behaves as in 0.1.7.

## 0.1.7

Maintenance release: the version commit reaches main only after CI passed, and a dry run tests a release without a change; the extension behaves as in 0.1.6.

## 0.1.6

Maintenance release: the workflow "Release" created this version commit; the extension behaves as in 0.1.5.

## 0.1.5

Maintenance release: a manual start of the workflow "Release" sets the
version, creates the tag and publishes the release; the extension behaves as
in 0.1.3.

## 0.1.3

Maintenance release: the release publishes the package that CI tested and
built; the extension behaves as in 0.1.1.

## 0.1.1

Maintenance release: the test configuration and the contribution guide
changed; the extension behaves as in 0.1.0.

## 0.1.0

Initial release.

---

© 2026 Hannes Stauss (scalarion@nimblescape.com) ·
[MIT License](https://github.com/nimblescape/nimblescape-devspaces/blob/main/LICENSE).

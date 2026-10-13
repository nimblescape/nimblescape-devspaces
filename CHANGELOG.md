# Change log

Each section lists the changes of one released version. The release workflow
takes the section of a version as the notes of its GitHub release.

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

# Change log

Each section lists the changes of one released version. The release workflow
takes the section of a version as the notes of its GitHub release.

## 0.6.0

**One devspace per source:** a devspace is now created for one source of its repository, a Dev Container configuration or the default image, and keeps it. A repository with several sources (several configurations, or a configuration and the default image of the setting devspaces.defaultImage) shows one child row per source in the sidebar, labelled default, config, or the folder name of the configuration; each child row is its own devspace with its own clone, so the default-image devspace and the configuration devspace of a repository can run at the same time, also each in its own window. The buttons, the state and the context menu of such a repository are on its child rows. The commands Start with Default Image, Start with Configuration and Select Configuration… are gone: Start on a row starts the devspace of that source, and a start from the Command Palette, Search or the switcher asks for the source when a repository has several. The setting devspaces.startWithDefaultImage now only places the default row first (on) or last (off). A changed default image in the settings still asks Rebuild now or Later at the next start of a default-image devspace. A devspace keeps its source also on a branch that does not have its configuration: the start uses the first configuration of that branch and says so once.

The Docker names of a new devspace carry the word of its source before the random pair: devspaces-<owner>-<repo>-default-<pair>, devspaces-<owner>-<repo>-config-<pair>, or devspaces-<owner>-<repo>-<configuration name>-<pair> for the container and the workspace volume; the devspace image and the Docker Compose project keep the name without the word. The workspace volume is labelled with its source (nimblescape.devspaces.config-path or nimblescape.devspaces.default-image), so a registry rebuilt from the volumes keeps the source of every devspace. Existing devspaces keep their names: an entry last started from the default image is the default-image devspace of its repository, every other entry the devspace of its configuration; no migration is needed.

The shared VS Code server store now works for VS Code Insiders: before, the download of an Insiders server into the store failed, and the Dev Containers extension installed the server into each container.

**Restricted Mode:** Devspaces now also runs in a window whose folder VS Code does not trust (Restricted Mode); before, VS Code turned the extension off there. In such a window, VS Code ignores the values that the workspace or folder gives the settings of Devspaces, so only your user settings apply. The default extensions that a start records for the shared extension cache now come only from your user value of dev.containers.defaultExtensions, also in a trusted window; a workspace or folder value is ignored.

A worker whose name another container still had could fail to start when Docker refused the name before the extension sent the worker its script: the operation or refresh that needed the worker failed, the log said that the input of the helper channel cannot be written, and the refresh of the sidebar did not try again for 5 minutes unless an operation started the worker first. The worker now takes the next free number, as it already did when Docker refused the name later. In the same way, on a Docker engine without its default bridge network, the worker now starts without network also when Docker refused the bridge network before the extension sent the script.

**Security, links in messages:** the messages of Devspaces now show every text as plain text. Before, a text from a Dev Container configuration, from the worker container or from an error could contain a link `[label](command:…)`, which VS Code showed as a link in a notification; a click on it ran that command of VS Code. For example, the refusal of the host access check quoted a refused `runArgs` entry as it was written. Devspaces now breaks the syntax of a link in these texts, so they look as before but are no links. The log keeps every text as it was.

**Security, registry logins:** the worker now names the image or Feature for which it asks the login of a registry, and the extension checks that it is a valid image name with a valid host name, gives only the login of that registry, answers one request at a time, and gives the logins of at most 8 registries in one open. Each request with its answer or the reason of its refusal (never the login) is a line in the log of Devspaces. Before, the worker could ask for the login of any registry, with no limit and no line in the log.

**Repository groups:** the sidebar now runs the regular expressions of the setting devspaces.repositoryGroups in a separate thread, with a time limit of one second for each entry. The preview of the editor already ran them in a separate thread. Before, the sidebar ran them in the extension host at each update of the view, so an expression with a nested repetition such as (a+)+ could stop VS Code and all its extensions, also at each start of the window. When an entry takes longer than one second, the view now lists the repositories without groups, and a warning names the entry, until you change the setting.

**Nothing before the first use:** until you have a devspace, a start of VS Code now does no Docker work. Devspaces only reads the current Docker context, for the title of its view: it does not ask the Docker engine, restore devspaces from the volumes, build its helper image, start a worker, or read a registry login. The first Start builds the helper image. Devspaces counts as used once its list of devspaces (registry.json) exists, also after you deleted every devspace; an empty file `used` in its storage folder keeps this when the list is lost. The window of a devspace container still restores a lost list. The sidebar asks Docker nothing while the current Docker engine has no devspace, and on Windows without Docker, `wsl --status` runs only while the view shows the Docker setup, when you click Install WSL 2, and for up to 30 minutes after you start an installation. The image check now asks each registry without a login first. It uses the stored login only when the registry refuses, or answers 404 while your computer has a login for it, because some registries answer 404 for a private repository. A pull also goes without a login first, and uses the stored login only when the registry refuses it or does not find the image, or when Docker Hub limits pulls without a login. Before, every start of VS Code ran `docker info`, could build the helper image and start a worker, and read the stored Docker Hub login for the base image of the helper image, also on a computer that never had a devspace. The image check and every pull sent the stored login first. The build of the helper image still runs `docker build --pull`, so the Docker CLI of your computer sends the Docker Hub login that Docker stored, if there is one, for the public base image `node`, as for any build; this now happens only from the first Start on.

The description and the top of the README, which is the Marketplace page, now say what Devspaces does on your computer: the GitHub sign-in with the scopes repo and read:org, the Docker CLI and the Dev Containers CLI, the installation of Docker after you confirm, the background container devspaces-monitor that keeps images, the VS Code Server and extensions up to date, and the network connections. The new first section of [Security](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/security.md#what-devspaces-does-on-your-computer) describes each step.

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

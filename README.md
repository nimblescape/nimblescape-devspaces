# nimblescape Devspaces

Open your GitHub repositories in dev containers with one click, much like GitHub Codespaces, but on your own Docker.

Devspaces lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in its own dev container, a **devspace**, and connects the VS Code window to it. The containers run on the Docker of your computer, or on Docker on another computer that you reach over SSH.

## What Devspaces does on your computer

- **GitHub sign-in.** Devspaces uses the GitHub sign-in of VS Code with the scopes `repo` (read and change your repositories, also the private ones) and `read:org` (read your organization memberships). Only for a private image on `ghcr.io`, it also asks for `read:packages`. VS Code keeps the sign-in, and Devspaces saves no token on your computer. At each open from a VS Code window, Devspaces writes the token into the memory of the devspace, so that Git and the GitHub CLI work there; code in that container can use it.
- **Docker and the Dev Containers CLI.** Devspaces runs the Docker CLI on your computer. Before your first devspace, Devspaces only reads the current Docker context when VS Code starts. When that read fails and `DOCKER_HOST` is not set, it also runs `docker --version` once, on this computer only, to recognize Podman. It does not contact the Docker engine, read registry logins, build its helper image, or start a helper container. On the Docker engine, the Docker of your computer or Docker on another computer that you reach over SSH, its helper containers clone your repositories into Docker volumes, and build, create, start, stop and remove the containers of your devspaces with the Docker Engine API and the Dev Containers CLI. For another computer, Devspaces runs `ssh` to reach it and, after you confirm, creates a Docker context and makes it the current context of all Docker tools of your user. When you answer with a "Don't Ask Again" button, later changes of the Docker host happen without the question.
- **Registry logins.** Devspaces checks and pulls an image or Feature of a devspace first without a login. It uses the login that Docker stored for its registry on your computer only when the registry refuses this or does not find the image, or when Docker Hub limits pulls without a login: it reads `~/.docker/config.json` and runs its `docker-credential-*` helpers. For `ghcr.io` without such a login, it uses the GitHub sign-in with `read:packages`. Devspaces gives the login of that one registry to its helper container only for one check or pull, for at most 8 registries in one open, writes each request to its log, and never stores the login. To build its helper image, Devspaces runs `docker build --pull`: the Docker CLI of your computer then sends the Docker Hub login that Docker stored, if there is one, for the public base image `node`, as for any build.
- **Docker installation.** When Docker is missing, Devspaces can install it: WSL 2 and Docker Desktop on Windows, Docker Desktop on macOS, and Docker Engine on Linux, where your user joins the group `docker`, which gives root rights on the computer. Devspaces first shows the exact commands, or the download address of the installer, and runs them only after you confirm, in a terminal of VS Code that you see.
- **Background container.** On each Docker engine, the container `devspaces-monitor` keeps the images of your devspaces, the VS Code Server and your extensions up to date, builds the next image of a devspace in advance, removes older versions of those images that no container uses, and stops a devspace a few minutes after its last window closes, unless you keep it running. The first time that you start a devspace on an engine, Devspaces asks whether this container keeps running there, also while VS Code is closed, or stops 5 minutes after the last devspace stops. Until you answer, it stops when no devspace runs. A container that keeps running ends itself after 30 days in which no devspace was used on that engine. **Devspaces: Remove Devspaces from This Docker Engine…** removes it (see Uninstall below).
- **Network.** Devspaces and its helper containers connect to GitHub, to a remote Docker host over SSH, to the image registries of your Dev Container configurations and of the setting `devspaces.defaultImage`, to the update service of VS Code, to the Visual Studio Marketplace, to Docker Hub, Debian, Docker and npm for the helper image, and to Docker and the package sources of your system for the installation of Docker. Devspaces collects no telemetry. The code in a devspace can connect to any address.

[Security](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/security.md#what-devspaces-does-on-your-computer) describes each step and what Devspaces protects.

## Features

- **One click to code.** Devspaces clones the repository into a Docker volume, builds the image, creates the container, and connects the window. Git on your computer is not needed.
- **Fast starts.** A small container on each Docker engine, the Monitor, keeps images, the VS Code server, and your extensions up to date in the background, and prepares newer images before you need them.
- **Safe updates.** When a newer image is available, Devspaces tells you before it updates the container. Your files in the workspace are kept.
- **Stops by itself.** A devspace stops a few minutes after its last window closes, unless you keep it running.
- **Back where you left off.** When VS Code starts, it opens the devspace that you used last.
- **Remote Docker.** Run your devspaces on a stronger machine or a shared classroom server over SSH.
- **Guard rails.** Host access checks refuse configurations that reach into your computer (bind mounts, privileged mode, the Docker socket, …). The GitHub token stays in the memory of the container only.
- **Docker setup.** Without Docker, the view walks you through installing it.

## Requirements

- VS Code 1.125 or later (the Microsoft build).
- Docker: Docker Desktop (macOS, Windows with WSL 2, Linux) or Docker Engine (Linux), locally or on a computer that you reach over SSH.
- A GitHub account.
- The Dev Containers extension. VS Code installs it with Devspaces.

## Getting started

1. Select the **Devspaces** icon in the activity bar.
2. Select **Sign in with GitHub**. Your repositories with a Dev Container configuration appear, grouped by owner (with a default image, also those without one).
3. Select **Start** on a repository, double-click it, or select it and press `Enter`. A repository with several sources (several configurations, or a configuration and a default image) has a child row per source, each its own devspace. The first start takes a few minutes; later starts take seconds.

Switch between devspaces with **Devspaces: Switch Devspace…** or the status bar. On macOS, the key of the command is `Cmd+Alt+E`. On Windows and Linux, the command has no key, because on many Windows keyboards `Ctrl+Alt+E` types a character such as `€`. To set a key, open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`), search for `Devspaces: Switch Devspace`, select the row, press `Enter`, press your keys, and press `Enter` again.

## Main settings

| Setting | Default | |
|---|---|---|
| `devspaces.defaultImage` | `""` | An image that every repository can start from next to its configuration: a repository with a configuration gets a `default` row next to its configuration rows, its own devspace; a repository without a configuration starts from the image. `devspaces.startWithDefaultImage` puts the `default` row first (on) or last (off). |
| `devspaces.stopOnClose` | `true` | Stop a devspace 5 minutes after its last window closes. |
| `devspaces.updateContainer` | `notify` | At a start with a newer image: `notify` (Continue/Cancel) or `ask` (Update Now/Later). |
| `devspaces.cacheUpdateSchedule` | `7 6 * * *` | When the background updates run: a cron expression in your time zone, or minutes. |
| `devspaces.owners` | `[]` | Organizations and accounts to list. Empty: all. |
| `devspaces.repositoryGroups` | `[]` | Regular expressions that filter and group repositories by name. |

All commands, settings, and details are in the [user guide](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md).

## Security and privacy

**A repository that you open is code that you run.** Open only repositories that you trust. The host access checks are a guard rail against mistakes, not a sandbox; see [Security](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/security.md).

Devspaces uses the GitHub sign-in of VS Code, stores no token, and collects no telemetry.

## Uninstall

Before you uninstall Devspaces, run **Devspaces: Remove Devspaces from This Docker Engine…** (Command Palette, or the **…** menu of the view) on each Docker engine that you used. **Devspaces: Use a Remote Docker Host…** and **Devspaces: Use the Local Docker** switch the engine. The command removes the container `devspaces-monitor`, the helper containers and images of Devspaces, and the volumes `devspaces-monitor`, `devspaces-worker-cache` and `devspaces-vscode`. It asks first, and it asks again before it deletes your devspaces on that engine. Then uninstall the extension in VS Code. The [user guide](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md#uninstall) has the Docker commands that remove the same by hand, and the Docker contexts that Devspaces created.

---

[Change log](https://github.com/nimblescape/nimblescape-devspaces/blob/main/CHANGELOG.md) · [Contributing](https://github.com/nimblescape/nimblescape-devspaces/blob/main/CONTRIBUTING.md) · [User guide](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md) · [Issues](https://github.com/nimblescape/nimblescape-devspaces/issues) · [Source](https://github.com/nimblescape/nimblescape-devspaces)

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](https://github.com/nimblescape/nimblescape-devspaces/blob/main/LICENSE).

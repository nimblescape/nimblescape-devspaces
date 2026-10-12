# nimblescape Devspaces

Open your GitHub repositories in dev containers with one click, much like GitHub Codespaces, but on your own Docker.

Devspaces lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in its own dev container, a **devspace**, and connects the VS Code window to it. The containers run on the Docker of your computer, or on Docker on another computer that you reach over SSH.

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
2. Select **Sign in with GitHub**. Your repositories with a Dev Container configuration appear, grouped by owner.
3. Select **Start** on a repository, or double-click it. The first start takes a few minutes; later starts take seconds.

Switch between devspaces with **Devspaces: Switch Devspace…** (`Ctrl+Alt+E`, on macOS `Cmd+Alt+E`) or the status bar.

## Main settings

| Setting | Default | |
|---|---|---|
| `devspace.stopOnClose` | `true` | Stop a devspace 5 minutes after its last window closes. |
| `devspace.updateContainer` | `notify` | At a start with a newer image: `notify` (Continue/Cancel) or `ask` (Update Now/Later). |
| `devspace.cacheUpdateSchedule` | `7 6 * * *` | When the background updates run: a cron expression in your time zone, or minutes. |
| `devspace.owners` | `[]` | Organizations and accounts to list. Empty: all. |
| `devspace.repositoryGroups` | `[]` | Regular expressions that filter and group repositories by name. |

All commands, settings, and details are in the [user guide](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md).

## Security and privacy

**A repository that you open is code that you run.** Open only repositories that you trust. The host access checks are a guard rail against mistakes, not a sandbox; see [Security](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/security.md).

Devspaces uses the GitHub sign-in of VS Code, stores no token, and collects no telemetry.

---

[Change log](https://github.com/nimblescape/nimblescape-devspaces/blob/main/CHANGELOG.md) · [Contributing](https://github.com/nimblescape/nimblescape-devspaces/blob/main/CONTRIBUTING.md) · [User guide](https://github.com/nimblescape/nimblescape-devspaces/blob/main/docs/guide.md) · [Issues](https://github.com/nimblescape/nimblescape-devspaces/issues) · [Source](https://github.com/nimblescape/nimblescape-devspaces)

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](https://github.com/nimblescape/nimblescape-devspaces/blob/main/LICENSE).

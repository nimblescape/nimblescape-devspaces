# Security model

This document describes what Devspaces protects, how, and where its protection ends. The user guide is [guide.md](guide.md); how the parts work together is in [architecture.md](architecture.md).

## The trust model

**A repository that you open is code that you run.** A malicious dev container can do harm. Its Dockerfile and build, its Features, its lifecycle commands, and the extensions in its container run with the rights of the container. They can:

- use the network: the internet, your local network, a VPN of your computer, and the services of your computer through `host.docker.internal`;
- attack the kernel, which every container shares with the Docker host (with Docker Desktop: with its virtual machine);
- use the channels that VS Code keeps open to your computer: the SSH and GPG agents, a socket that answers requests for your Git and Docker credentials, the opening of URLs, the clipboard, and your X11 display when one is set (see [Hardening your computer](#hardening-your-computer));
- read and change the repository, and use the GitHub token of the devspace. The token can read and change the repositories that your account can access and read your organization memberships (scopes `repo` and `read:org`).

The user in the container is the one that the repository chooses (`remoteUser`, `containerUser`, or the image), often a user without root rights that can use `sudo`. Devspaces does not change it.

The aim of Devspaces is that no setting of a configuration grants a container access to the Docker host beyond three things that it allows on purpose: the network (including VPN connections), ports on `localhost` of the host, and URLs that open in your browser. The checks are a guard rail against mistakes and copied templates, not a sandbox: a crafted repository can get around them. Open only repositories that you trust. For others, use a virtual machine, or a separate user account with its own Docker.

The first open of a repository that belongs neither to you nor to one of your organizations asks for a confirmation.

## Trust boundaries

| Part | Where it runs | Trust |
|---|---|---|
| The extension | The local extension host of each VS Code window (`extensionKind: ui`) | Trusted. It holds the GitHub session, the local records, and the decisions. |
| The worker, its batch helpers, and the Monitor | Containers on the Docker engine | Not trusted by the extension. The engine may be on another computer and shared with other people. |
| The Docker engine | Your computer, or a remote host | Not trusted by the extension. Everyone who can use it controls every container on it. |
| The dev container | The Docker engine | Not trusted by the worker. It runs the code of the repository. |

**Extension and worker.** The extension commands the worker only through typed operations (see [architecture.md](architecture.md#the-worker-and-the-helper-channel)). No Docker command and no script crosses the channel. Both sides check every message strictly, and the extension limits each request in size. Towards the worker, the extension:

- answers a request that changes its records only for the devspace of the operation, under its own registry lock, with its own clock and its own view of the windows; there is no generic write;
- allows each operation only its own kinds of requests; only `open` may ask for a secret;
- gives a secret only when the operation asks for it: the GitHub token to an open, and the login of one registry host only for the image check or pull that needs it;
- keeps the remembered result of the host access check of a configuration in its own storage, stamped with the hash of the worker code that computed it; the worker and the engine never store it;
- uses the Monitor's registry answers only to decide whether an update is due, never as an input of a security check.

The code that runs in the worker, the batch helpers, and the Monitor comes from the extension's own `.vsix` file. The container that loads it checks it against the SHA-256 hash on its command line before it runs it (see [architecture.md](architecture.md#pipe-loading)).

**Worker and dev container.** The worker writes into a dev container only through the scripts of its registry, with the arguments as positional parameters and secrets only on standard input. These scripts follow no symbolic link that they did not create, and overwrite nothing that they did not write: a process in the dev container can plant links at any time. The batch helper that works on the volume of a devspace runs as root, but:

- the Docker socket lies in a folder that only root can enter;
- the clone runs as the user `devspace-git` (UID 52741), without groups, capabilities, or new privileges, and cannot reach the socket;
- the steps that read the repository (its configuration and its Docker Compose files) run as the user that owns the repository folder;
- root follows no link that the dev container planted in the volume.

## Host access checks

Before a container is created, Devspaces checks the final configuration: `devcontainer.json` with what its Features and its base image add to it (the label `devcontainer.metadata`), and every service of Docker Compose. It checks again before `up`, on the `runArgs` as Docker gets them and on the metadata of the image that was built. A configuration that breaks a rule is refused, before anything is pulled, built, or started, with a message that names each offending setting. The volume of the devspace is kept.

The checks are on for every repository by default. The user setting `devspace.hostAccessChecksOff` lists the repositories whose checks are off; only your user settings count, never a workspace or folder setting.

### Refused while the checks are on

- Bind mounts of files and folders of the host, also of the Docker socket (for example by a Feature), and of `${localWorkspaceFolder}`.
- Privileged mode; capabilities beyond Docker's default set and `SYS_PTRACE`; security options other than `seccomp=unconfined` and `no-new-privileges`.
- Devices and GPUs, also `hostRequirements.gpu` and limits that name devices.
- The namespaces and control groups of the host (`--pid=host`, `--ipc=host`, `--uts=host`, `--userns=host`, `--cgroupns=host`, `--cgroup-parent`).
- Other container runtimes (`--runtime`), volume drivers and volume options other than `volume-nocopy` and `volume-subpath`, and `--use-api-socket`.
- `--oom-kill-disable` and a negative `--oom-score-adj`; log drivers that write to the host or use credentials of Docker.
- The network of another container (`--network container:…`, `network_mode: container:`), `--volumes-from`, and `--link`.
- Published ports on another address than `127.0.0.1`, and `-P`.
- The setting `remote.localPortHost` in the configuration, which would make VS Code forward ports on all addresses.
- The volumes of other programs and containers: volumes that Docker Compose or the Dev Containers extension created (by their labels), and anonymous volumes of other containers.
- Build options that reach files, keys, and agents of the helper during the build (`--secret`, `--ssh`, `--output`, `--allow`, `--build-context` with a folder).

### Refused whatever the switch says

- Everything of another devspace: its workspace volume, a volume that a devspace of another GitHub account uses or that its Delete kept, its named networks, and the images of the devspaces of other accounts (by image ID, not by name).
- The processes of other containers, and their volumes through `--volumes-from` or `volumes_from`, also of the dev container for the other services of Docker Compose.
- The folders of Devspaces as paths of the configuration (a mount, a build context, or a Dockerfile): the token folder `/run/devspace` (also as `/var/run/devspace`), the configuration folder `/workspaces/.devspace+`, and the folders of the helper with the Docker socket and the token. A mount propagation that shares `/`, `/run`, or `/var/run` with the host is refused too.
- The cache volume of the helper and the volumes of Devspaces (`devspace-monitor`, `devspace-vscode`).
- The variables that set the Git configuration (`GIT_CONFIG`, `GIT_CONFIG_*`) or that Devspaces sets (`GIT_SSH_COMMAND`, `DOCKER_CONFIG`, `GH_CONFIG_DIR`), and the token and host variables of the GitHub CLI (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`), in `runArgs`, `containerEnv`, and `remoteEnv`, also when a Feature or the base image sets them.
- `initializeCommand`: it would run in the helper, which has the Docker socket.
- Labels with the prefixes `nimblescape.devspace.` and `devcontainer.` (except `devcontainer.metadata`), and the labels of Docker Compose. Such a label could hide a container from Devspaces or make it look like another devspace.
- A Dockerfile longer than 1 MiB, or one that links out of the repository.
- Options of `runArgs` and `build.options` that Devspaces does not know.

### What Devspaces changes instead of refusing

- Published ports without an address (`-p 3000:3000`, `appPort`) are bound to `127.0.0.1` while the checks are on.
- `--rm`, `-it`, and `-d` are removed, because Devspaces runs the container itself; `--name` is replaced by the name of the devspace. The log names each removed option.
- `shutdownAction` is `none`, so that only Devspaces stops the container.
- For Docker Compose, only the dev service gets the workspace volume; a bind mount of files of the repository becomes a mount of that folder of the workspace volume (Docker Engine 26 or newer); every container gets the labels of the devspace.
- Values of `${localEnv:…}` of your computer are not passed: the Dev Container CLI resolves them in the helper, where they are empty or have the helper's value.

### Turning the checks off

**Turn Off Host Access Checks…** in the context menu of a repository adds it to `devspace.hostAccessChecksOff` after a warning; **Turn On Host Access Checks** removes it. With the checks off, the refusals of the first list are lifted, so the configuration, its Features, and its base image may use the files of the host, the Docker socket (which gives full control of Docker and of every other devspace, also their tokens), privileged mode, devices, and ports on all addresses. Everything in the second list stays refused. The row shows `host access unrestricted`, and the log says so at every start. A change applies when the container is created next; a container that was created without the checks is created again at the next start after they are turned on, if the configuration passes them.

A repository with the checks off is never prepared in the background, and an open with the checks off never uses a prepared image.

## The GitHub token

Devspaces signs in with the GitHub authentication of VS Code, with the scopes `repo` (list and clone private repositories) and `read:org` (organization memberships). It asks for `read:packages` only when a private image on `ghcr.io` needs it. VS Code stores the session; Devspaces keeps no token in its settings or files.

**Never in a variable, on a command line, or in a log.** The token travels only as the secret of an operation, and every process gets it on its standard input. The worker masks every secret that an operation held in all its progress, log lines, tool output, and errors; the extension's log masks it too.

**The clone.** The batch helper clones with the token, which lies in a tmpfs of the helper (`/run/devspace-secrets`) only during the clone step and belongs to the Git user only during that step. The remote URL of the clone contains no token, and `.git/config` holds none.

**In the dev container.** Devspaces keeps the token only in the memory of the running dev container:

- `/run/devspace` is a tmpfs that Devspaces adds to every dev container it creates (`nosuid`, `nodev`, `noexec`, 1 MiB, mode 0700, owned by the remote user). It holds `github-token` (mode 0600) and `gh/hosts.yml`, which signs the GitHub CLI in with the same account. The settings of the GitHub CLI (`config.yml`) stay in the volume.
- Devspaces writes the token at each open from a window, after the container runs and before the lifecycle commands, so that they can use Git and the GitHub CLI as the owner account. The write runs as root through `docker exec` with the token on standard input. It first checks that `/run/devspace` is exactly the tmpfs that Devspaces created, with no other mount at or below it and no propagation to the host; otherwise it writes nothing, and the open says that Git could not be prepared.
- The token is never in the workspace volume, a kept volume, or an export. It is gone when the container stops. Like other memory, the kernel may swap it to the swap space of the host or of the Docker VM.
- When a window leaves a devspace because you signed out or another account signed in, Devspaces removes the token from every running dev container of that devspace at once. Otherwise it stays in the running container until the container stops or the next open replaces it. A sign-out in VS Code may not make the token invalid on GitHub; to do that, revoke the access of VS Code in the GitHub settings (Applications).
- A container that starts without an open from a window (a restart by Docker, `docker start`) has no token until the next open. The Monitor never writes the token.

**Who can read it.** While the container runs, every process in it that runs as its user or as root can read the token, and so can everyone who can use the Docker engine (`docker exec`), on your computer or on a remote host.

## Git inside the container

Git and the GitHub CLI in a devspace use only its own configuration and the token of the account that owns it, as in a codespace. Nothing of your computer is used: no copied `~/.gitconfig`, no forwarded credential helper, no forwarded Docker credentials, and no SSH agent for Git.

- The folder `/workspaces/.devspace+` in the volume holds `gitconfig` (the identity of the owner account from its GitHub profile, and a credential helper that answers only for `https://github.com` from the token file), `credentials.gitconfig` (your credential helpers for other Git servers), `docker/`, and `gh/config.yml`. It holds no secret.
- Devspaces sets only documented variables of Git, Docker, and the GitHub CLI in `containerEnv` and `remoteEnv`: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` (they remove every other credential helper and add the helper of the container), `DOCKER_CONFIG`, `GIT_SSH_COMMAND=ssh -o IdentityAgent=none`, and `GH_CONFIG_DIR=/run/devspace/gh`.
- For each container, the settings of the Dev Containers extension switch off the copy of your Git configuration (`dev.containers.copyGitConfig` and `remote.containers.copyGitConfig`), its Git credential helper (`dev.containers.gitCredentialHelperConfigLocation: none`), its Docker credential helper (`dev.containers.dockerCredentialHelper`), and the sign-in of the GitHub CLI with your token (`dev.containers.githubCLILoginWithToken`). Your global settings stay unchanged, so your other dev containers keep working.
- A container gets a `~/.gitconfig` of Devspaces when it has none or an empty one, so that Git older than 2.32 reads the configuration of the volume too.

### Variables that Devspaces never sets

The Dev Containers extension and the VS Code server expect their own values in these variables, so Devspaces never sets or changes them, in the dev container or in the helper:

- `REMOTE_CONTAINERS_IPC` and every other `REMOTE_CONTAINERS*` variable;
- `SSH_AUTH_SOCK` and `BROWSER`;
- every `VSCODE_*` variable.

`DOCKER_HOST` is never set: the helper reaches Docker through `/var/run/docker.sock`, a link to the socket of its engine, and the remote engine is chosen by the Docker context alone. The steps of the batch helper also never pass `PATH`, `HOSTNAME`, `NODE_OPTIONS`, `TMPDIR`, or any `DOCKER_*`, `BUILDX_*`, `BUILDKIT_*`, or `LD_*` variable from a configuration to the tools.

## Registry access

- **At an open**, the image check and the pulls run in the worker, on the Docker engine. For a registry that needs a login, the worker asks the extension for that one host's login: the credentials that Docker stored on your computer (the `docker-credential-*` helpers run on your computer), or for `ghcr.io` without such a login, the GitHub session with `read:packages`. The worker holds the login only for that check or pull, then forgets it, and asks again for the next one. It sends the login only in the header of its request to that registry, never into a file.
- **In the background**, the Monitor and its prepares use no token and no credentials at all. They pull and ask registries anonymously. A private image or Feature is therefore not updated or prepared in the background; its next open checks and builds it with your credentials.
- The worker and the Monitor reach the internet through the proxy of the Docker daemon (`HTTPProxy`, `HTTPSProxy`, `NoProxy` of `docker info`), never through the proxy settings of your computer or of VS Code.
- The image check asks for the digest of a tag with an HTTP `HEAD` request, which does not count against the pull limit of Docker Hub. An image is pulled only when its digest changed.

## Accounts

A devspace belongs to the GitHub account that created it. Another account that signs in to VS Code does not see it and cannot open it; its first **Start** of the repository creates its own devspace. The repository list of one account is never shown to another, and the list does not reveal that another account has a devspace of a repository.

All devspaces of a Docker engine are Docker objects of the same engine. The separation protects against using the wrong account, not against another person who can use your user account or the engine.

## Remote and shared engines

- On a remote host, the token goes into the memory of the container on that host, never onto its disk: the extension sends it over SSH to its worker there, which writes it into the container through the Docker Engine API.
- Devspaces never asks for an SSH password or accepts a host key: every SSH connection runs with `BatchMode=yes`, so an unknown host key or a key that is not loaded fails at once, with a message.
- A Docker context that points to another computer without SSH (for example `tcp://…`) is refused.
- **A shared engine is for a group that trusts each other.** Root and every member of the group `docker` on the engine can reach every container and every volume on it, including the token in the memory of another person's running devspace. The account separation of Devspaces does not protect against them. For people who must not see each other's work, each person needs an engine of their own, for example in a virtual machine.

## Known limits

- The Dockerfile and the Features are not checked: they run as trusted code, like the rest of the repository. A Dockerfile can build from or copy out of the local images of other devspaces (`FROM`, `COPY --from`, `RUN --mount`), and choose a BuildKit frontend (`# syntax`). An `ONBUILD` instruction of a base image runs unchecked in the build.
- All devspaces of an engine share its images and build cache, also across GitHub accounts. Do not open repositories that you do not trust on an engine where the devspaces of other accounts hold data that you need to protect.
- Every container reaches the ports on `localhost` of the host through `host.docker.internal` (Docker Desktop), also the ports that VS Code forwards for other devspaces. Ports on `127.0.0.1` are protected against the network, not against other containers.
- The kernel is shared. A container is not a strong security boundary.
- The channels of VS Code and the Dev Containers extension stay open in every container. Git in the devspace does not use them, but a program that looks for them can.
- The checks allow `--network host`, `SYS_PTRACE`, and `seccomp=unconfined`. With `--network host`, a server in the container that listens on all addresses can be reached from your network, and on Linux with Docker Engine the container can also reach local programs through their abstract Unix sockets (for example the X11 display and D-Bus).
- When the default runtime of Docker is `nvidia`, the variable `NVIDIA_VISIBLE_DEVICES` gives a container the GPUs. It is not refused.
- An `ENV` of an image, or an environment file of the repository, can set variables that the checks refuse in the configuration, for example `GH_TOKEN`.
- An image or a program in the container can change the settings of VS Code in the container, for example to forward ports on all addresses.
- A named volume without labels of another program (for example one made with `docker volume create`) can be mounted by any configuration that knows its name.
- For a Docker Compose build with Features, the user that the Dev Container CLI writes into its compose file is not checked.
- A symbolic link of the repository used as the build context of a single container is not resolved.
- With the checks off, a configuration can join the network of another container, use the volumes of other containers, and use the Docker socket, which controls every devspace and its token.

## Hardening your computer

The Dev Containers extension and VS Code keep some channels from the container to your computer open. Most of them cannot be switched off by a setting, and a firewall does not help: inside the container they are Unix sockets, and between the container and your computer most of them travel inside the connection of the window. What you can do is keep things of value away from the end of each channel on your computer, and have your computer ask before it gives something out.

**Git configuration, Git and Docker credentials, and the GitHub CLI.** Devspaces switches these off for its own containers. To make this the default for your other dev containers too, put this into your user `settings.json`:

```json
"dev.containers.copyGitConfig": false,
"remote.containers.copyGitConfig": false,
"dev.containers.gitCredentialHelperConfigLocation": "none",
"dev.containers.dockerCredentialHelper": false,
"dev.containers.githubCLILoginWithToken": false
```

The socket that answers credential requests stays open, and a program in the container that looks for it can still ask. On macOS, the Git credential helper `osxkeychain` gives out the passwords it stored without asking; on Windows and Linux, the usual credential helpers do too. On macOS you can make it ask: for the items that matter, open Keychain Access, select **Confirm before allowing access** in the item's **Access Control**, and remove `git-credential-osxkeychain` from **Always allow access by these applications**. Then answer each prompt with **Allow** or **Deny**, not **Always Allow**. When Git stores the password anew, repeat these steps.

**SSH agent.** This is the biggest exposure. The Dev Containers extension forwards your SSH agent into every container when one runs as VS Code starts, and no setting turns this off ([microsoft/vscode-remote-release#11413](https://github.com/microsoft/vscode-remote-release/issues/11413)).

- On Linux, start VS Code without an agent: quit VS Code, then start it with `env -u SSH_AUTH_SOCK code`. This affects every window.
- On macOS, VS Code always gets the agent of your login. Keep that agent empty (`ssh-add -D`), and do not use `AddKeysToAgent` or `UseKeychain` in `~/.ssh/config`, or `ssh-add --apple-load-keychain`. Set another agent (for example 1Password) with `IdentityAgent` in `~/.ssh/config`, not by exporting `SSH_AUTH_SOCK` in a shell startup file.
- On Windows, the agent is the service **OpenSSH Authentication Agent**, which keeps its keys across restarts. Keep it empty with `ssh-add -D`, or stop it while you do not need it (`Stop-Service ssh-agent` and `Set-Service ssh-agent -StartupType Manual` in an administrator PowerShell).
- Or have the agent ask (not with the Windows OpenSSH agent): `ssh-add -c` loads a key that needs your confirmation at each use (it needs an `ssh-askpass` program), and `ssh-add -t 1h` loads it for a short time. 1Password and Secretive can ask too; make sure they ask at each use.

**GPG agent.** It is forwarded when the container has `gpg` and your computer runs an agent. Use short cache times in `gpg-agent.conf` (for example `default-cache-ttl 60` and `max-cache-ttl 600`) and add `no-allow-external-cache`. On macOS, pinentry-mac of GPG Suite gives out a passphrase saved in Keychain without asking: switch saving off with `defaults write org.gpgtools.common DisableKeychain -bool yes`, then delete the saved passphrases (`security delete-generic-password -s GnuPG`, repeated until it finds none). Do not keep a key unlocked while a container that you do not trust is open.

**WSL and Wayland.** `"dev.containers.forwardWSLServices": false` stops forwarding the SSH and GPG agents of WSL (not the agent of your computer). `"dev.containers.mountWaylandSocket": false` stops mounting your Wayland display into the containers that the Dev Containers extension creates; Devspaces creates its containers without this mount.

**X11 display.** When `DISPLAY` is set for VS Code, the Dev Containers extension forwards your X11 display into the container, and a program there can see and type into the windows of that display. No setting turns this off ([microsoft/vscode-remote-release#8031](https://github.com/microsoft/vscode-remote-release/issues/8031)). On macOS, uninstall XQuartz if you do not need it, then log out and in. On Linux in a Wayland session, start VS Code with `env -u DISPLAY code --ozone-platform=wayland`. On an X11 desktop, only a separate user account or a virtual machine helps.

**Ports, browser, and clipboard.** With `"remote.autoForwardPorts": false` and `"remote.localPortHost": "localhost"` (the default) in your user settings, VS Code forwards fewer ports on its own, and only on localhost. No setting limits the opening of URLs; if this worries you, make a separate browser profile your default browser. No setting limits the clipboard either: do not copy secrets while a container that you do not trust is open.

**Everything else.** The only real boundary is a separate user account on your computer, or a virtual machine, for VS Code and Docker. On Linux, that account must not be in the group `docker`, which gives root rights on the computer and access to the containers of all users. Give it its own rootless Docker instead, and add `export DOCKER_HOST=unix:///run/user/<UID>/docker.sock` to a file that its login reads (for example `~/.profile`); Devspaces then mounts that socket into its helper. In that account, do not use the Docker installation or **Start Docker** of Devspaces, which set up the system Docker. With Docker Desktop, Enhanced Container Isolation (Business subscription) also hardens the container side.

## Stored data

- The repository lists (one per GitHub account) and the registry of devspaces in the global storage of the extension hold metadata only: repository names, URLs, dates, volume and image names, image digests, branch names, numbers of changes, and the user ID and login of the account of each devspace.
- The volume of the Monitor on each engine holds heartbeat records, locks, the image references in use, registry answers, and the extension lists of recent opens. It holds no secret, and no dev container mounts it.
- Devspaces collects no telemetry.

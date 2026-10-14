# Contributing

This guide explains the files, the development, the tests and the release of
the extension. The [README](README.md) describes the use in short, the
[user guide](docs/guide.md) in full. How the extension works inside is in
[architecture.md](docs/architecture.md), its security model in
[security.md](docs/security.md).

## Files

| File | Purpose |
| --- | --- |
| `src/` | The extension in TypeScript: `src/vscode` holds the editor wiring, `src/core` the logic without the editor API, and `src/helperChannel` the worker that runs in the workspace helper container. The tests (`*.test.ts`) sit beside the modules. |
| `test/docker/` | The integration tests against a running Docker engine. |
| `test/vscode/` | The tests in a real VS Code: mocha runs them in the extension host of a VS Code that `@vscode/test-cli` downloads. `test/vscode/host/` is a development extension without code, for the tests of the packaged VSIX. `test/vscode/attach/` holds the attach tests, and `test/vscode/github/` the sign-in provider `github` that they use instead of the real GitHub sign-in. |
| `resources/` | The files of the package beside the bundles: the icons, the Dockerfile of the workspace helper, and the editor of the repository groups. |
| `scripts/` | The build of the icon font, the local installation, the Marketplace setup of the repository (`marketplace-setup.sh`), and the reset of a Docker engine for tests (`purge-docker-context.sh`). |
| `docs/` | The user guide, the architecture, and the security model. |
| `esbuild.mjs` | Bundles the three entry points into `dist/`. |
| `.vscode-test.mjs` | The configurations of the tests in a real VS Code: `vscode` for the development build (`npm run test:vscode`), `vsix` for the packaged VSIX (`npm run test:vscode:vsix`), and `attach` for the attach tests (only when `DEVSPACE_TEST_ATTACH` is `plain`, `devspace`, `reattach`, a restart of VS Code in the window of the devspace, `account`, that window under another GitHub account, `longopen`, that window with an open pipeline of several minutes, `remote`, the window of a devspace on the Docker engine of another computer over SSH, `stopped`, a local folder whose tests start a second VS Code in the window of the devspace and stop and remove its container, `previous`, the window of the devspace with the last released version of the extension, or `updated`, that window again after the update to the VSIX of the checkout), with the VS Code version, the test files in `out/test/vscode/`, and the options of VS Code and mocha. |
| `package.json` | The extension manifest. The section [Manifest](#manifest) explains it. |
| `package-lock.json` | The locked development tools. npm writes this file, and nobody edits it by hand. |
| `.node-version` | The Node release of the release workflow and of `npm run package`. `actions/setup-node` in the workflows and local Node version managers read it. |
| `.github/workflows/ci.yml` | Tests and packages every push to `main`, every pull request and the commit of every release, runs the unit tests a second time as root, fails when a unit test ran in neither run, runs the integration tests against Docker, and runs the tests in a real VS Code under a virtual display (`xvfb-run`). |
| `.github/workflows/release.yml` | Releases a version on a manual start: commits the version to a temporary branch, tests and packages it with `ci.yml`, and only then moves `main` to it, creates its tag and GitHub release and publishes it to the Marketplace. A dry run tests without a change. The section [Release](#release) explains it. |
| `.github/workflows/vscode-versions.yml` | Runs the VS Code jobs of `ci.yml` once per week (Mondays at 04:23 UTC) and on a manual start, on VS Code Insiders and on the version of `engines.vscode` in `package.json`, the lowest version that the extension supports. A change of the workflow runs it on its pull request. The VS Code CLI installs the newest release of Dev Containers that supports the VS Code version, and the tests print both versions. Each attach job keeps the Insiders build that is the newest at its start. GitHub documents that it sends the notice of a failed scheduled run to the person who last changed the `cron` line, and that it turns off the schedule of a public repository after 60 days without activity in the repository; the tab "Actions" turns it on again. |
| `.github/workflows/marketplace-identity.yml` | Prints the Marketplace member ID of the publishing identity, to check the setup of the repository. |
| `.github/dependabot.yml` | Proposes weekly updates of the development tools and of the pinned actions. |
| `.vscodeignore` | Lists the files of the package: the bundles in `dist/`, `resources/`, `package.json`, `README.md`, `CHANGELOG.md` and `LICENSE`. |

## Development

Everything runs on Node.js 24: the release in `.node-version` for the tools,
the tests and CI, including
[`@vscode/vsce`](https://github.com/microsoft/vscode-vsce), the Microsoft tool
that packages and publishes extensions, and the runtime of VS Code 1.125 and
later (`engines.vscode`) for the extension.

| Command | Effect |
| --- | --- |
| `npm ci` | Installs the locked development tools. |
| `npm run typecheck` | Checks the types with `tsc`. |
| `npm test` | Runs the unit tests with vitest, without VS Code and without Docker. The tests of the helper scripts that run as root in the helper container (`chown` to other users, `mknod`, `mount --bind`) need root and skip themselves for another user, and a few tests need a user without root; `sudo npm test` on Linux runs the tests as root. |
| `npm run test:docker` | Runs the integration tests against the running Docker engine. |
| `npm run test:vscode` | Builds `dist/` and the tests of `test/vscode/`, downloads VS Code (stable, or the version in the environment variable `VSCODE_TEST_VERSION`) and the Dev Containers extension to `.vscode-test/`, and runs the tests in that VS Code with the extension from `dist/`. That VS Code gets its own user data folder and a `DOCKER_HOST` without a Docker engine, so the tests never touch your VS Code settings or your Docker engine. It needs network access to the VS Code downloads and the Marketplace. On Linux without a display, run `xvfb-run -a npm run test:vscode`. |
| `npm run test:vscode:vsix` | Runs the same tests against the packaged VSIX of the version in `package.json`, as users install it: run `npm run package` first. VS Code installs the VSIX and the Dev Containers extension, and loads `test/vscode/host/` as development extension, so that the extension runs from the VSIX. On Linux without a display, run it under `xvfb-run -a`. On Windows, the path of the checkout must have no space: `@vscode/test-cli` passes the path of the VSIX to the VS Code command line without quotes. |
| `npm run test:vscode:attach:prepare` and `npm run test:vscode:attach` | The attach tests, only on CI (the jobs "vscode attach", "vscode attach remote", whose preparation runs with `DEVSPACE_TEST_ATTACH_PREPARE=remote`, and "vscode update", with `DEVSPACE_TEST_ATTACH_PREPARE=update`): VS Code starts in the window of a container on the real Docker engine, through the real Dev Containers extension, and the extension creates its objects there with the names of a real installation. The preparation refuses to run without `CI=true`. It changes the test copies of VS Code and Dev Containers in `.vscode-test/`: VS Code lets the extension use the test sign-in without a question, and Dev Containers does not ask before the first attach (VS Code refuses every dialog in tests). `npm run test:vscode:attach` makes the same change of Dev Containers before each run, in every release of it in `.vscode-test/extensions`, because VS Code can install a newer release during a run. With `DEVSPACE_TEST_ATTACH_PREPARE=remote`, it prepares no devspace and no plain container on the local Docker; instead it starts a container with a Docker engine and an SSH server, puts the devspace on that engine, starts a container with the name of the devspace container on the local Docker (the window must not use it), adds the host `devspaces-test-remote` to the SSH config in `~/.ssh`, and makes the Docker context of that host the current context. With `DEVSPACE_TEST_ATTACH_PREPARE=update`, it prepares no plain container; it installs the last released version of the extension into `.vscode-test/extensions` from the VSIX that the release workflow attached to the latest GitHub release (its publish job publishes this file to the Marketplace), and it builds the helper image as that version builds it (from its Dockerfile and its version of the Dev Container CLI). Before the runs `stopped` and `updated`, `node scripts/install-attach-extensions.mjs` packages the extension and the test sign-in provider and installs them from their VSIX files into `.vscode-test/extensions`, over an installed version too: the second VS Code of the run `stopped` loads them as users install them, because VS Code closes a window of development extensions when its remote connection is lost, and the run `updated` checks that VS Code loads the packaged build after the update. `npm run test:vscode:attach` fails when mocha reports no result, also when VS Code ends with exit code 0. |
| `npm run build` | Bundles `dist/extension.js`, `dist/groupsPreviewWorker.js` and `dist/helperChannel.js`. |
| `npm run package` | Builds `nimblescape-devspaces-<version>.vsix` with vsce. vsce also validates the manifest and the README. |
| `npm run install-local` | Builds the package and installs it into every VS Code profile (`-- --profile <name>` into one). |
| `code --install-extension nimblescape-devspaces-<version>.vsix` | Installs the built package. Reload the window after an update of an active extension. |
| `bash scripts/purge-docker-context.sh --dry-run` | Shows what a reset of the engine of the current Docker context removes. Without `--dry-run`, it removes **everything** on that engine (all containers, volumes, images, unused networks and the build cache, not only those of Devspaces), after you type the name of the context, so that the next start begins like a fresh installation. Changes that are not pushed are lost. |

## Manifest

`package.json` is the extension manifest. It has these parts:

- The name and the publisher define the extension ID `nimblescape.nimblescape-devspaces`; the section [Naming](#naming) explains the name.
- The version is the only source of the package version, and the tag of a release names it.
- The engine range defines the compatible VS Code versions, and `extensionDependencies` the Dev Containers extension.
- `main` selects the bundle `dist/extension.js`.
- `contributes` declares the view, the commands, the menus, the settings and the icons.
- The icon of the Marketplace is `resources/icon.png`, the sidebar icon `resources/icon.svg` on a blue tile, because the Marketplace takes no SVG icon. The description, categories, keywords and the banner color complete the Marketplace page.

`README.md` is the page of the Marketplace and `CHANGELOG.md` its tab
"Changelog". vsce does not rewrite relative links
(`--no-rewrite-relative-links`), so both use full `https://github.com/…`
links.

## Naming

Every extension of the publisher `nimblescape` uses one name,
`nimblescape-<name>`, for the repository, the package and the extension:

| What | Form | This extension |
| --- | --- | --- |
| Repository | `nimblescape/nimblescape-<name>` | `nimblescape/nimblescape-devspaces` |
| `name` in `package.json` | `nimblescape-<name>` | `nimblescape-devspaces` |
| Extension ID | `nimblescape.nimblescape-<name>` | `nimblescape.nimblescape-devspaces` |
| Package file | `nimblescape-<name>-<version>.vsix` | `nimblescape-devspaces-<version>.vsix` |
| Display name | `nimblescape <Title>` | `nimblescape Devspaces` |

The prefix keeps the name apart from the names of other publishers, because
the Marketplace accepts a `name` only once. The Marketplace cannot rename an
extension ID: another `name` publishes a new extension, and the old one stays
with its installations. An extension that is no longer wanted is unpublished
(More Actions, Unpublish, which can be undone), never removed: the Marketplace
keeps the `name` of a removed extension reserved for good, also for its own
publisher.

## Release

A released version is a tag `v<version>` whose `<version>` equals the version
in `package.json`. The workflow "Release" creates the version, its tag, its
GitHub release and its Marketplace version in one run. To release a version,
follow these steps:

1. Optional: add a section `## <version>` to `CHANGELOG.md` on `main`.
2. In the tab "Actions", choose the workflow "Release", then "Run workflow" on the branch `main`. Enter the version, for example `0.1.7`. When `CHANGELOG.md` has no section for the version, enter its notes too: they become the section. The GitHub website starts a workflow also in the browser of a phone.

The run has four jobs:

1. "Version commit" checks that the run starts from `main`, that the version has the form `<major>.<minor>.<patch>`, that it is not lower than the version in `package.json` and that its tag does not exist. It sets the version in `package.json` and `package-lock.json`, adds the section of the notes to `CHANGELOG.md` when the file has none, commits the change as "Release `<version>`" and pushes it to the temporary branch `release/run-<run ID>`, not to `main`. When `main` holds the version and its section already, it commits nothing. It also deletes the temporary branches of earlier runs that failed.
2. "CI" runs the workflow `ci.yml` for the commit of the version, because a push with the token of a workflow starts no other workflow. The VSIX that this job tests and builds is the VSIX of the release, so the release repeats no test and no build.
3. "Main, tag and GitHub release" runs only when CI passed. It moves `main` to the commit of the version as a fast-forward and deletes the temporary branch. When `main` changed during the run, it stops before the tag. Then it creates the tag `v<version>` on the commit and the release of the tag with the GitHub CLI `gh`. The section of the version in `CHANGELOG.md` becomes the notes, and the VSIX becomes the file of the release. A release that exists keeps its notes and receives the VSIX only when it holds none.
4. "Publish to the Visual Studio Marketplace" downloads the VSIX of the GitHub release, signs in to Microsoft Entra ID with the official [`azure/login`](https://github.com/Azure/login) action and publishes the VSIX with `vsce publish --azure-credential`.

`main` receives the version commit only after CI passed. When CI fails,
`main`, the tags, the releases and the Marketplace stay unchanged, and the
version stays free: fix the cause on `main` and start the release of the same
version again. The jobs move and push with the token of the workflow, so a
rule of `main` that blocks direct pushes stops the release.

A dry run tests a release without a change: choose "Dry run" when you start
the workflow. The run makes the version commit on its temporary branch, runs
CI for it and deletes the branch; it changes neither `main`, a tag, a release
nor the Marketplace. A dry run may start from another branch than `main`, so
it also tests a change of `release.yml` on that branch before the change
reaches `main`.

When a job fails, remove the cause and choose "Re-run failed jobs" on the
run. A re-run keeps the tag and the VSIX that the GitHub release already
holds, and the Marketplace skips a version that it already holds, so a re-run
never publishes a version twice. A new run deletes the temporary branch of a
failed run, so a failed run can no longer be re-run after a new run started.

The workflows `release.yml` and `marketplace-identity.yml` and this section
are the same in every extension repository of nimblescape. A change to them
goes into every repository.

## Marketplace setup

The workflow publishes with a Microsoft Entra ID token, as the
[Microsoft publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
recommends. It uses no personal access token, because Azure DevOps retires
the global personal access tokens that the Marketplace needs on
1 December 2026. The publishing identity is an app registration with a
federated credential for each repository: GitHub Actions proves the identity
of the job with an OpenID Connect token, so no secret is stored. An app
registration needs no Azure subscription. One app registration publishes
every extension of the publisher `nimblescape`, because the Marketplace
grants the role of a member for the whole publisher.

### What exists

| Part | Where | Value |
| --- | --- | --- |
| Publisher | [Marketplace publisher management](https://marketplace.visualstudio.com/manage) | `nimblescape`, the `publisher` in `package.json` |
| App registration | [Microsoft Entra admin center](https://entra.microsoft.com), "App registrations" | `vscode-marketplace-publisher`, a member of the publisher `nimblescape` with the role "Contributor" |
| Organization variables | GitHub organization `nimblescape`, "Secrets and variables", "Actions", "Variables" | `AZURE_CLIENT_ID` (the application ID of the app) and `AZURE_TENANT_ID` (its directory ID); identifiers, not secrets |
| Federated credential | the app, "Certificates & secrets", "Federated credentials" | one for each repository, named after it |
| Environment | the settings of each repository, "Environments" | `marketplace`, reachable from the tags `v*` and the branch `main` only |

### Setup of a repository

A new extension repository needs its federated credential and its
environment. The script `scripts/marketplace-setup.sh` sets both up for the
GitHub repository of the remote `origin` of the clone, whose name must be the
`name` of `package.json`; it needs the Azure CLI, the GitHub CLI and Node.js,
the two CLIs signed in with an account that may change the app registration
and the settings of the repository. It shows what it sets up and
asks before it changes anything. It changes nothing that already exists, so it
can run again:

```sh
az login --allow-no-subscriptions
gh auth login
scripts/marketplace-setup.sh
```

Then run the workflow "Marketplace identity" in the tab "Actions" of the
repository: it signs in like the publish job and prints the member ID of the
app, which shows that the setup works.

The script gives the credential these values. For this repository:

| Field of the federated credential | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:nimblescape@156021698/nimblescape-devspaces@1415774996:environment:marketplace` |
| Audience | `api://AzureADTokenExchange` |

GitHub puts the owner ID and the repository ID into the subject of every
repository created after 15 July 2026, so a new owner of a reused name gets no
token. The subject also holds the name of the repository: after a rename of
the repository, run the script again and delete the credential of the old
name. One app accepts at most 20 federated credentials.

### Setup from scratch

Only when the publisher, the app or the variables are lost:

1. Create the publisher `nimblescape` on the publisher management page, signed in with the Microsoft account of nimblescape e.U.
2. Register the app `vscode-marketplace-publisher` in the Entra admin center: "New registration", "Single tenant", no API permission, no secret.
3. Set the organization variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` to the application ID and the directory ID of the app. Organization variables reach private repositories only on a paid GitHub plan.
4. Set up a repository with the script, and run its workflow "Marketplace identity".
5. On the publisher management page, open the publisher `nimblescape`, then "Members", and add the member ID that the workflow printed with the role "Contributor".

---

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](LICENSE).

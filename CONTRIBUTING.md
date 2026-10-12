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
| `resources/` | The files of the package beside the bundles: the icons, the Dockerfile of the workspace helper, and the editor of the repository groups. |
| `scripts/` | The build of the icon font, the local installation, the Marketplace setup of the repository (`marketplace-setup.sh`), and the reset of a Docker engine for tests (`purge-docker-context.sh`). |
| `docs/` | The user guide, the architecture, and the security model. |
| `esbuild.mjs` | Bundles the three entry points into `dist/`. |
| `package.json` | The extension manifest. The section [Manifest](#manifest) explains it. |
| `package-lock.json` | The locked development tools. npm writes this file, and nobody edits it by hand. |
| `.node-version` | The Node release of the release workflow and of `npm run package`. `actions/setup-node` in the workflows and local Node version managers read it. |
| `.github/workflows/ci.yml` | Tests and packages every push to `main` and every pull request, and runs the integration tests against Docker. |
| `.github/workflows/release.yml` | Builds a released version, creates its GitHub release and publishes it to the Marketplace. The section [Release](#release) explains it. |
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
| `npm test` | Runs the unit tests with vitest, without VS Code and without Docker. |
| `npm run test:docker` | Runs the integration tests against the running Docker engine. |
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
with its installations.

## Release

A released version is a tag `v<version>` whose `<version>` equals the version
in `package.json`. To release a version, follow these steps:

1. Run `npm version <version> --no-git-tag-version`. The command updates `package.json` and `package-lock.json`.
2. Add a section `## <version>` to `CHANGELOG.md`.
3. Merge the change to `main`.
4. Tag the merged commit and push the tag: `git tag v<version>`, then `git push origin v<version>`.

The tag starts the workflow "Release". It runs three jobs:

1. "Release build" tests the tagged source and builds the VSIX with vsce. It stops when the tag differs from the manifest version or when `CHANGELOG.md` has no section for the version.
2. "GitHub release" creates the release of the tag with the GitHub CLI `gh`. The section of the version in `CHANGELOG.md` becomes the notes, and the VSIX becomes the file of the release. A release that exists, for example one created on the GitHub website, keeps its notes and receives the VSIX only when it holds none.
3. "Publish to the Visual Studio Marketplace" downloads the VSIX of the GitHub release, signs in to Microsoft Entra ID with the official [`azure/login`](https://github.com/Azure/login) action and publishes the VSIX with `vsce publish --azure-credential`.

When a job fails, remove the cause and choose "Re-run failed jobs" on the
run. A re-run keeps the VSIX that the GitHub release already holds, and the
Marketplace skips a version that it already holds, so a re-run never
publishes a version twice.

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
| Subject | `repo:nimblescape@156021698/nimblescape-devspaces@1386151532:environment:marketplace` |
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

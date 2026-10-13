// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sign-in provider `github` of the attach tests, in place of the built-in one (VS Code starts with
// --disable-extension vscode.github-authentication). Every request gets a session of the test account of the Docker
// tests (test/docker/harness.ts TEST_ACCOUNT) with a dummy token, for exactly the scopes that it asks for, without a
// dialog. GitHub rejects the token, so every question to GitHub fails.
const vscode = require('vscode');

const ACCOUNT = { id: '4242', label: 'devspaces-test' };
const TOKEN = 'dummy-token-of-the-vscode-attach-tests';

function session(scopes) {
  return { id: `test-${[...scopes].sort().join(' ')}`, accessToken: TOKEN, account: ACCOUNT, scopes: [...scopes] };
}

exports.activate = (context) => {
  const changes = new vscode.EventEmitter();
  context.subscriptions.push(
    changes,
    vscode.authentication.registerAuthenticationProvider(
      'github',
      'GitHub',
      {
        onDidChangeSessions: changes.event,
        getSessions: async (scopes) => [session(scopes ?? [])],
        createSession: async (scopes) => session(scopes),
        removeSession: async () => {},
      },
      { supportsMultipleAccounts: false },
    ),
  );
};

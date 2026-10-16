// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// On an engine with the removal mark of "Remove Devspaces from This Docker Engine…" (docker-engines.json), this computer
// does no Docker work by itself. The gates are in the wiring of extension.ts, which cannot be loaded without VS Code:
// they are read from its source here; what they guard is tested where it lives (heartbeatWiring.test.ts).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');

describe('the gates of extension.ts on an engine with the removal mark', () => {
  it('a heartbeat prepares no worker there: heartbeatWiring gets the mark', () => {
    expect(source).toMatch(/const heartbeats = heartbeatWiring\(\{[^}]*\n\s*engineRemoved,\n/);
  });
});

// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of this process: the file that the pipe loader checked against the hash on its command line, stored and
// loaded (`__filename` of the bundle dist/helperChannel.js). The same file is the program of the batch helpers and of
// the Monitor, which the worker starts with its text, and of the threads of the host access analysis, which start from
// the file itself (configurationAnalysisRunner.ts). Read and hashed once, at the first use; no I/O when the module is
// loaded.
import * as fs from 'fs';
import { bundleHash } from '../core/loader/pipeLoader';

/** The script of this process. */
export interface OwnScript {
  /** The file of the script. */
  file: string;
  /** Its text. */
  text: string;
  /** The SHA-256 hash of the text (bundleHash), as the loader checked it. */
  hash: string;
}

let own: OwnScript | undefined;

/** The script of this process, read and hashed at the first call. A failed read throws, and the next call reads again. */
export function ownScript(): OwnScript {
  if (own === undefined) {
    const text = fs.readFileSync(__filename, 'utf8');
    own = { file: __filename, text, hash: bundleHash(text) };
  }
  return own;
}

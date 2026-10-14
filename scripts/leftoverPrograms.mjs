// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The programs that a test VS Code left running after it quit (Linux only, from /proc). The configurations of
// .vscode-test.mjs give the test VS Code the environment variable DEVSPACE_TEST_USER_DATA_DIR; every program that it
// starts, and every program that those start, inherits it (the extension and the Dev Containers extension pass the
// environment of the extension host on), and no other program of a CI job has it. VS Code does not end the programs
// of its extension host when it quits (seen in CI: Docker CLI programs that the runner ended at the end of the job).
// scripts/run-attach-tests.mjs lists them after each attach run; `node scripts/leftoverPrograms.mjs` lists them after
// the tests of the job "vscode".
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const MARKER = 'DEVSPACE_TEST_USER_DATA_DIR=';

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function commandLine(pid) {
  return (readText(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).join(' ');
}

/** Clock ticks per second of /proc/<pid>/stat. */
function clockTicks() {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    return 100;
  }
}

/**
 * The running programs with DEVSPACE_TEST_USER_DATA_DIR in their environment, except this process. Empty on other
 * systems than Linux.
 * @returns {{ pid: number, ppid: number, ageSeconds: number, userDataDir: string, command: string, parentCommand: string }[]}
 */
export function leftoverPrograms() {
  if (process.platform !== 'linux') return [];
  const ticks = clockTicks();
  const uptime = Number(readText('/proc/uptime')?.split(' ')[0] ?? 0);
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const pid = Number(entry);
    const marker = readText(`/proc/${pid}/environ`)
      ?.split('\0')
      .find((variable) => variable.startsWith(MARKER));
    const stat = readText(`/proc/${pid}/stat`);
    if (marker === undefined || stat === undefined) continue;
    // The fields after the name in parentheses, which can hold spaces and parentheses: state, ppid, … starttime (22).
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') continue;
    const ppid = Number(fields[1]);
    found.push({
      pid,
      ppid,
      ageSeconds: Math.round(uptime - Number(fields[19]) / ticks),
      userDataDir: marker.slice(MARKER.length),
      command: commandLine(pid),
      parentCommand: commandLine(ppid),
    });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/** One line per program. */
export function describePrograms(programs) {
  return programs.map(
    (p) => `  pid ${p.pid}, ${p.ageSeconds} s old, user data folder ${path.basename(p.userDataDir)}: ${p.command}\n    parent ${p.ppid}: ${p.parentCommand}`,
  );
}

/**
 * Prints the programs that run right after the quit, waits up to `waitMs` for them to end, and prints those that still
 * run then. Resolves the programs that still run.
 */
export async function reportLeftoverPrograms(waitMs = 10_000) {
  let programs = leftoverPrograms();
  if (programs.length === 0) {
    console.log('No program of the test VS Code runs after it quit.');
    return [];
  }
  console.log(`Programs of the test VS Code that run after it quit (${programs.length}):\n${describePrograms(programs).join('\n')}`);
  const deadline = Date.now() + waitMs;
  while (programs.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    programs = leftoverPrograms();
  }
  if (programs.length === 0) console.log(`They ended within ${waitMs / 1000} s.`);
  else console.log(`Still running after ${waitMs / 1000} s (${programs.length}):\n${describePrograms(programs).join('\n')}`);
  return programs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await reportLeftoverPrograms();

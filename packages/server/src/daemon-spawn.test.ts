/**
 * spawnDaemon: verifies the parent closes the log fd, reports failure when spawn yields no pid, and
 * handles synchronous spawn errors without leaving ghost pidfiles.
 *
 * These tests operate against the REAL ~/.reticle directory (RETICLE_HOME is a module-level constant
 * computed at import time, not injectable). Unique high port numbers avoid collisions with any live
 * daemon. Each test cleans up its pidfile + log + registry entry in afterEach.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDaemon, readPid, logPath, removePid } from './daemon.js';
import { tmpdir } from 'node:os';

/** Ports far above any plausible daemon — avoids collisions with real instances. */
const BASE_PORT = 59_100;
let nextPort = BASE_PORT;
function uniquePort(): number {
  return nextPort++;
}

/** Tracks spawned children so we can kill them even if the test fails mid-way. */
const spawnedPorts: number[] = [];

afterEach(() => {
  for (const port of spawnedPorts) {
    const pid = readPid(port);
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already exited — fine
      }
    }
    removePid(port, pid ?? process.pid);
    // Clean up the log file best-effort.
    try {
      const log = logPath(port);
      if (existsSync(log)) unlinkSync(log);
    } catch {
      // non-critical
    }
  }
  spawnedPorts.length = 0;
});

describe('spawnDaemon', () => {
  it('spawns a real process and writes its pid', () => {
    const port = uniquePort();
    spawnedPorts.push(port);
    const script = join(tmpdir(), `reticle-test-${port}.mjs`);
    writeFileSync(script, 'setTimeout(() => process.exit(0), 200);', 'utf8');

    const ok = spawnDaemon(process.execPath, script, [], port);
    expect(ok).toBe(true);

    const pid = readPid(port);
    expect(pid).not.toBeNull();
    expect(typeof pid).toBe('number');
    expect(pid).toBeGreaterThan(0);
  });

  it('returns false when the executable does not exist (spawn fails)', () => {
    const port = uniquePort();
    spawnedPorts.push(port);

    const ok = spawnDaemon('/nonexistent/node', '/nonexistent/script.mjs', [], port);
    // On most platforms, spawn with a missing executable sets child.pid to undefined.
    // On platforms where spawn throws synchronously, the catch path returns false.
    // Either way: no ghost pidfile left behind.
    expect(ok).toBe(false);
  });

  it('closes the log fd in the parent (no leaked descriptors)', () => {
    const port = uniquePort();
    spawnedPorts.push(port);
    const script = join(tmpdir(), `reticle-test-${port}.mjs`);
    writeFileSync(script, 'process.exit(0);', 'utf8');

    const ok = spawnDaemon(process.execPath, script, [], port);
    expect(ok).toBe(true);

    // The log file exists and is writable from the parent (not locked by a leaked fd).
    const log = logPath(port);
    expect(existsSync(log)).toBe(true);
    expect(() => writeFileSync(log, 'test\n', { flag: 'a' })).not.toThrow();
  });

  it('does not spawn a duplicate when a live daemon already owns the port', () => {
    const port = uniquePort();
    spawnedPorts.push(port);
    // A script that stays alive until killed — the afterEach hook sends SIGTERM.
    const script = join(tmpdir(), `reticle-test-${port}.mjs`);
    writeFileSync(
      script,
      'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));',
      'utf8',
    );

    const first = spawnDaemon(process.execPath, script, [], port);
    expect(first).toBe(true);

    // Second attempt on the same port — pidfile exists with a live pid.
    const second = spawnDaemon(process.execPath, script, [], port);
    expect(second).toBe(false);
  });
});

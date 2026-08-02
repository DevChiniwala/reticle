import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  readdirSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import {
  daemonRegistryFileName,
  daemonRegistryPort,
  DaemonRegistryEntrySchema,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from '@reticlehq/core';

const RETICLE_HOME = join(homedir(), '.reticle');

function pidPath(port: number, home: string = RETICLE_HOME): string {
  return join(home, `daemon-${port}.pid`);
}

function registryPath(port: number): string {
  return join(RETICLE_HOME, daemonRegistryFileName(port));
}

export function logPath(port: number): string {
  return join(RETICLE_HOME, `daemon-${port}.log`);
}

export function readPid(port: number, home: string = RETICLE_HOME): number | null {
  const path = pidPath(port, home);
  if (!existsSync(path)) return null;
  const n = parseInt(readFileSync(path, 'utf8').trim(), 10);
  return isNaN(n) ? null : n;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePid(port: number): void {
  mkdirSync(RETICLE_HOME, { recursive: true });
  writeFileSync(pidPath(port), String(process.pid), 'utf8');
}

/**
 * Pure decision: may `expectedPid` remove a pidfile owned by `owner` (alive = is that owner running)?
 * Yes when we own it, it's empty, or its daemon is dead — never when a LIVE sibling owns it. This is
 * the orphan-race guard: a losing childB (EADDRINUSE) must not delete the winning childA's live pidfile.
 */
export function shouldRemovePid(
  owner: number | null,
  expectedPid: number,
  alive: boolean,
): boolean {
  return owner === null || owner === expectedPid || !alive;
}

export function removePid(port: number, expectedPid = process.pid): void {
  const path = pidPath(port);
  if (existsSync(path)) {
    const owner = readPid(port);
    if (shouldRemovePid(owner, expectedPid, owner !== null && isAlive(owner))) unlinkSync(path);
  }
  // The discovery registry entry shares this daemon's lifetime — clean both so a dead daemon never
  // lingers in discovery. Keyed by port, so this is safe from the parent (stop) or the child (shutdown).
  removeDaemonRegistry(port);
}

/**
 * Publish this daemon to the discovery registry so a build-time plugin can find it by projectId. Called
 * from the daemon CHILD on ready (only it knows its cwd/projectId). Best-effort: a write failure must
 * never fail daemon startup — discovery just falls back to the default port.
 */
export function writeDaemonRegistry(
  port: number,
  meta: { pid: number; cwd: string; projectId?: string; startedAt: number },
): void {
  const entry: DaemonRegistryEntry = {
    port,
    pid: meta.pid,
    cwd: meta.cwd,
    startedAt: meta.startedAt,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
  };
  try {
    mkdirSync(RETICLE_HOME, { recursive: true });
    writeFileSync(registryPath(port), JSON.stringify(entry), 'utf8');
  } catch {
    // discovery is a convenience — never block startup on it
  }
}

export function removeDaemonRegistry(port: number): void {
  const path = registryPath(port);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // racing another cleaner — already gone
  }
}

/**
 * Discover the port of a live daemon serving `projectId` by reading the registry entries in ~/.reticle.
 * Returns null when none matches (caller falls back to the default port — never guesses a mismatched
 * daemon). Stale entries (crashed daemons) are ignored via the pid liveness probe.
 */
export function discoverDaemonPortForProject(projectId: string | undefined): number | null {
  const entries: DaemonRegistryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(RETICLE_HOME);
  } catch {
    return null; // no ~/.reticle yet
  }
  for (const file of files) {
    if (daemonRegistryPort(file) === null) continue;
    try {
      const parsed = DaemonRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(RETICLE_HOME, file), 'utf8')),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // unreadable/corrupt entry — skip it
    }
  }
  return pickDaemonPort(entries, projectId, isAlive);
}

export function isRunning(port: number): boolean {
  const pid = readPid(port);
  return pid !== null && isAlive(pid);
}

/**
 * Find the port of a live reticle daemon by scanning ~/.reticle/daemon-<port>.pid files — so `reticle open`
 * can "find the port" itself instead of making the user reconcile it. Returns the first live one
 * (lowest port, deterministic), or null when none is running.
 */
export function discoverDaemonPort(): number | null {
  reclaimStaleDaemons(); // sweep crashed daemons' stale pidfiles before scanning for live ones
  let found: number | null = null;
  try {
    for (const file of readdirSync(RETICLE_HOME)) {
      const m = /^daemon-(\d+)\.pid$/.exec(file);
      if (m === null) continue;
      const port = Number(m[1]);
      if (isRunning(port) && (found === null || port < found)) found = port;
    }
  } catch {
    // no ~/.reticle yet → nothing running
  }
  return found;
}

/**
 * Sweep ~/.reticle for daemon-<port>.pid files whose process is no longer alive and delete them, so a
 * crashed daemon never leaves a stale pidfile that confuses discovery or makes a port look "taken".
 * Returns the ports reclaimed. `home` and `pidAlive` are injectable for testing (default to the real
 * ~/.reticle and the process.kill(pid,0) liveness probe).
 */
export function reclaimStaleDaemons(
  home: string = RETICLE_HOME,
  pidAlive: (pid: number) => boolean = isAlive,
): number[] {
  const reclaimed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return reclaimed; // no ~/.reticle yet → nothing to reclaim
  }
  for (const file of files) {
    const match = /^daemon-(\d+)\.pid$/.exec(file);
    if (match === null) continue;
    const path = join(home, file);
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (isNaN(pid)) pid = null;
    } catch {
      pid = null; // unreadable pidfile counts as stale
    }
    if (pid === null || !pidAlive(pid)) {
      try {
        unlinkSync(path);
        removeDaemonRegistry(Number(match[1])); // drop the sidecar discovery entry too
        reclaimed.push(Number(match[1]));
      } catch {
        // racing another reclaimer — fine, it's already gone
      }
    }
  }
  return reclaimed;
}

/** The minimal shape of a spawned child that spawnDaemon uses. */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  unref(): void;
}

/** Injectable deps for spawnDaemon — the testability seam. Defaults to the real implementations. */
export interface SpawnDaemonDeps {
  readonly home: string;
  openFile(path: string, flags: string): number;
  closeFile(fd: number): void;
  spawnChild(
    command: string,
    args: readonly string[],
    options: { detached: boolean; stdio: readonly ('ignore' | number)[] },
  ): SpawnedChild;
  pidAlive(pid: number): boolean;
}

export function defaultSpawnDaemonDeps(): SpawnDaemonDeps {
  return {
    home: RETICLE_HOME,
    openFile: openSync,
    closeFile: closeSync,
    spawnChild: (command, args, options) =>
      spawn(command, [...args], { detached: options.detached, stdio: [...options.stdio] }),
    pidAlive: isAlive,
  };
}

/**
 * Spawn the reticle daemon as a detached background process, redirecting output to the log file.
 * Writes the PID file from the parent before returning so callers can call isRunning
 * immediately without a race window.
 *
 * `deps` is injectable for testing (default: real fs/spawn against ~/.reticle). The same seam
 * pattern as reclaimStaleDaemons(home, pidAlive).
 */
export function spawnDaemon(
  nodeExec: string,
  scriptPath: string,
  args: string[],
  port: number,
  deps: SpawnDaemonDeps = defaultSpawnDaemonDeps(),
): boolean {
  mkdirSync(deps.home, { recursive: true });
  const pidFilePath = join(deps.home, `daemon-${port}.pid`);
  const logFilePath = join(deps.home, `daemon-${port}.log`);
  // O_EXCL spawn-lock: only the FIRST racer to create the pidfile spawns. A concurrent second gets
  // EEXIST — if a LIVE daemon owns the port it skips (no duplicate detached daemon, no clobbered pid);
  // a stale pidfile from a crashed daemon is reclaimed. Returns false when it did not spawn.
  let lockFd: number;
  try {
    lockFd = deps.openFile(pidFilePath, 'wx');
  } catch {
    const existing = readPid(port, deps.home);
    if (existing !== null && deps.pidAlive(existing)) return false;
    try {
      unlinkSync(pidFilePath);
      lockFd = deps.openFile(pidFilePath, 'wx');
    } catch {
      return false; // lost a concurrent reclaim race
    }
  }
  let logFd: number;
  try {
    logFd = deps.openFile(logFilePath, 'a');
  } catch {
    // Log path unwritable (permissions, disk full). Clean up the lock so we don't leave a ghost.
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  let child: SpawnedChild;
  try {
    child = deps.spawnChild(nodeExec, [scriptPath, ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch {
    // spawn can throw synchronously on some platforms (e.g. ENOMEM, invalid args).
    deps.closeFile(logFd);
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  // The parent's copy of logFd is no longer needed — spawn duplicated it into the child.
  deps.closeFile(logFd);
  // Suppress the async ENOENT/EACCES that fires when the executable is missing or unexecutable.
  // The failure is already detected synchronously via `child.pid === undefined`; without this
  // handler the error propagates as an uncaught exception and crashes the parent process.
  child.on('error', () => undefined);
  if (child.pid === undefined) {
    // Spawn failed silently (resource exhaustion, invalid executable on some platforms). The pidfile
    // is empty — clean it up so discovery doesn't see a ghost, and report failure honestly.
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  writeFileSync(lockFd, String(child.pid), 'utf8');
  deps.closeFile(lockFd);
  child.unref();
  return true;
}

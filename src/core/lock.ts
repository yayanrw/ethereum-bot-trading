/**
 * Single-instance lock for the bot.
 *
 * The in-process write queue in memory.ts only serialises writes within ONE
 * process. Two bot processes against the same data dir would place duplicate
 * orders and clobber each other's state. This lock makes that impossible: the
 * second process refuses to start.
 *
 * Mechanism: an atomic exclusive-create lockfile (`open` with the `wx` flag,
 * which fails if the file already exists — no TOCTOU race between the check and
 * the create). The file records the holder's pid/host/start time.
 *
 * Staleness: a crash leaves the lockfile behind. On startup, if the lock exists,
 * we check whether its pid is still alive on this host; a dead pid means a stale
 * lock and we take over.
 *
 * ponytail: PID lockfile, single-host. Ceilings, both handled conservatively
 * (refuse to start, so the safe direction):
 *   - PID reuse: a recycled pid can look "alive" and block a genuinely stale
 *     lock. Rare; the fix is to delete the lockfile manually.
 *   - Shared data dir across HOSTS (NFS): a pid from another host is
 *     unverifiable, so we assume it's alive and refuse. For multi-host you'd
 *     want a real distributed lock (e.g. a DB row or redis).
 */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

async function readHolder(path: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/** True if the lock's holder is (or must be assumed) still running. */
function isHolderAlive(holder: LockInfo): boolean {
  // A pid only means anything on the host that issued it.
  if (holder.host !== hostname()) return true;
  try {
    // Signal 0 checks existence without delivering a signal.
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we can't signal it — still alive.
    // ESRCH: no such process — the lock is stale.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the lock, or throw LockError if another live instance holds it.
 * Returns a release function; call it on shutdown.
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  const payload = `${JSON.stringify(info, null, 2)}\n`;

  await mkdir(dirname(path), { recursive: true });

  // Two attempts: the second is for the case where we found a stale lock, removed
  // it, and now race to create ours.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx'); // atomic: fails with EEXIST if present
      await fh.writeFile(payload);
      await fh.close();
      return () => releaseLock(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const holder = await readHolder(path);
      if (holder && isHolderAlive(holder)) {
        throw new LockError(
          `Another bot instance is already running (pid ${holder.pid} on ${holder.host}, ` +
            `since ${holder.startedAt}). Refusing to start a second instance against the same ` +
            `data dir — that would place duplicate orders. If you are certain it is dead, ` +
            `delete ${path}.`,
        );
      }
      // Stale (crashed holder) or unreadable lock — remove and retry once.
      await unlink(path).catch(() => undefined);
    }
  }

  throw new LockError(`Could not acquire lock at ${path} after retrying past a stale lock`);
}

/** Remove the lockfile, but only if we are still its owner. */
export async function releaseLock(path: string): Promise<void> {
  const holder = await readHolder(path);
  if (holder && holder.pid === process.pid && holder.host === hostname()) {
    await unlink(path).catch(() => undefined);
  }
}

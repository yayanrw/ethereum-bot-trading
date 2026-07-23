import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockError, releaseLock } from '../src/core/lock.ts';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  lockPath = join(dir, 'bot.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe('acquireLock', () => {
  test('creates the lockfile and records this process', async () => {
    const release = await acquireLock(lockPath);
    expect(await exists(lockPath)).toBe(true);
    const info = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe(hostname());
    await release();
  });

  test('release removes the lockfile', async () => {
    const release = await acquireLock(lockPath);
    await release();
    expect(await exists(lockPath)).toBe(false);
  });

  test('refuses when a live holder already owns it', async () => {
    // Current process is alive, so a lock naming our own pid must block.
    const release = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toBeInstanceOf(LockError);
    await release();
  });

  test('takes over a stale lock whose holder is dead', async () => {
    // A pid that is essentially never alive on this host.
    const stale = { pid: 2 ** 30, host: hostname(), startedAt: '2020-01-01T00:00:00.000Z' };
    await writeFile(lockPath, JSON.stringify(stale));

    const release = await acquireLock(lockPath); // should succeed by removing the stale lock
    const info = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid); // now ours
    await release();
  });

  test('takes over an unreadable/corrupt lockfile', async () => {
    await writeFile(lockPath, 'not json at all');
    const release = await acquireLock(lockPath);
    const info = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
    await release();
  });

  test('refuses a lock held on another host (pid unverifiable, assumed alive)', async () => {
    const foreign = { pid: 12345, host: 'some-other-host', startedAt: '2026-07-24T00:00:00.000Z' };
    await writeFile(lockPath, JSON.stringify(foreign));
    await expect(acquireLock(lockPath)).rejects.toBeInstanceOf(LockError);
  });
});

describe('releaseLock', () => {
  test("does not remove a lock owned by a different process", async () => {
    const foreign = { pid: 12345, host: hostname(), startedAt: '2026-07-24T00:00:00.000Z' };
    await writeFile(lockPath, JSON.stringify(foreign));
    await releaseLock(lockPath); // not ours — must leave it alone
    expect(await exists(lockPath)).toBe(true);
  });

  test('is a no-op when there is no lockfile', async () => {
    await releaseLock(lockPath); // must not throw
    expect(await exists(lockPath)).toBe(false);
  });
});

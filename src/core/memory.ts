import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { freshBreakerState, type BreakerState } from './breaker.ts';
import type { Decision, LessonsFile, PositionsFile } from '../types.ts';

// Resolved per access, not at import: tests and one-off runs point DATA_DIR at a
// scratch directory, and a module-level constant would bake in whatever the value
// happened to be when the first import ran.
const dir = () => process.env.DATA_DIR ?? 'data';

export const paths = {
  get lessons() {
    return join(dir(), 'lessons.json');
  },
  get lessonsBackup() {
    return join(dir(), 'lessons.bak.json');
  },
  get positions() {
    return join(dir(), 'positions.json');
  },
  get decisions() {
    return join(dir(), 'decision-log.json');
  },
  get breaker() {
    return join(dir(), 'breaker.json');
  },
  get lock() {
    return join(dir(), 'bot.lock');
  },
};

// ponytail: single-process serialisation. Two writers to the same path in one
// process are chained; a second OS process would still need proper-lockfile.
// The bot only writes positions/decisions, the evaluator only writes lessons,
// so they never contend.
const writeQueue = new Map<string, Promise<unknown>>();

function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueue.get(path) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive even if a write fails, so one error doesn't wedge the queue.
  writeQueue.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Read JSON, falling back to `fallback` when the file is missing or unparseable.
 * A corrupt file is moved aside rather than silently overwritten — losing a
 * decision log to a bad parse would destroy the evaluator's only input.
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      await writeJson(path, fallback);
      return fallback;
    }
    if (err instanceof SyntaxError) {
      const quarantine = `${path}.corrupt.${Date.now()}`;
      await rename(path, quarantine).catch(() => undefined);
      console.error(`[memory] ${path} was unparseable; moved to ${quarantine}, starting fresh.`);
      await writeJson(path, fallback);
      return fallback;
    }
    throw err;
  }
}

/** Write via temp file + rename, so a crash mid-write can never leave half a JSON document. */
export async function writeJson(path: string, data: unknown): Promise<void> {
  return enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  });
}

/** Read-modify-write under the path's queue, so concurrent updates don't clobber each other. */
export async function updateJson<T>(path: string, fallback: T, fn: (current: T) => T): Promise<T> {
  return enqueue(path, async () => {
    let current: T;
    try {
      current = JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      current = fallback;
    }
    const next = fn(current);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return next;
  });
}

export const emptyLessons: LessonsFile = {
  version: 0,
  updatedAt: new Date(0).toISOString(),
  rules: [],
};

export const loadLessons = () => readJson<LessonsFile>(paths.lessons, emptyLessons);
export const saveLessons = (l: LessonsFile) => writeJson(paths.lessons, l);

export const emptyPositions: PositionsFile = { lots: [], bids: [] };

export const loadPositions = () => readJson<PositionsFile>(paths.positions, emptyPositions);
export const savePositions = (p: PositionsFile) => writeJson(paths.positions, p);

export const loadDecisions = () => readJson<Decision[]>(paths.decisions, []);

export const loadBreaker = () => readJson<BreakerState>(paths.breaker, freshBreakerState);
export const saveBreaker = (s: BreakerState) => writeJson(paths.breaker, s);

export async function appendDecisions(entries: Decision[]): Promise<void> {
  if (entries.length === 0) return;
  await updateJson<Decision[]>(paths.decisions, [], (log) => [...log, ...entries]);
}

/** Flush any pending writes — call before exiting. */
export async function flush(): Promise<void> {
  await Promise.allSettled([...writeQueue.values()]);
}

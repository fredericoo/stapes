import { openDatabase, type Database } from "./db";

/**
 * Open the world's database, refusing to be the second process to do so.
 *
 * The Durable Object gave this away free: a namespace guarantees exactly one
 * instance of `world` exists anywhere, and every line of `GameServer` that
 * treats its in-memory board as authoritative depends on it. Nothing on a
 * virtual machine provides it, and the ways two processes end up sharing a
 * database are ordinary — a drain overlapping a boot, a deploy retry, a
 * `docker compose up` run by hand on the box.
 *
 * Ordinary SQLite locking is not enough. It prevents *corruption*, serialising
 * two writers rather than interleaving them mid-statement, but both may open
 * the same file and both write. Two divergent in-memory boards writing in turn
 * still produce one blended world, and because the checkpoint is preferred over
 * the authored map on load, it persists. Nothing logs it.
 *
 * `PRAGMA locking_mode = EXCLUSIVE` is the guarantee, and it is a better one
 * than a lockfile:
 *
 * - A second process fails at **open**, before it can run a line of world code,
 *   with `File is locked by another process`.
 * - The lock is held by the kernel against the file, so it is released when the
 *   process dies — `SIGKILL` and OOM included. There is no stale lock to detect
 *   and no PID liveness heuristic to get wrong inside a container, which is
 *   exactly where PID-based lockfiles are least trustworthy.
 *
 * Both halves are verified in `server/lock.test.ts`.
 */
export async function openWorldDatabaseExclusively(
  path: string,
  { attempts = 20, delayMs = 500 } = {},
): Promise<Database> {
  let last: unknown;

  // The retry is what makes this compatible with a deploy rather than a hazard
  // to one: the replacement process starts while its predecessor is still
  // flushing a final checkpoint, and it should wait that out rather than fail
  // the rollout. Ten seconds by default, against a drain budgeted at two.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await openDatabase(path, { exclusive: true });
    } catch (error) {
      last = error;
      if (!isLockError(error)) throw error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Another process is holding ${path}. Refusing to start a second writer — ` +
      `two processes on one world silently blend the board. Cause: ${String(last)}`,
  );
}

/**
 * Whether a failure to open was contention rather than a broken database.
 *
 * Matched on the message, because that is what the driver offers. A corrupt
 * file or a missing directory must propagate immediately: retrying those for
 * the full window turns a clear error into a slow one, and buries the message
 * that would have explained it.
 *
 * **Matched on the driver's own phrasing rather than on the word "lock".** The
 * error text embeds the database path, so a looser pattern matches any
 * deployment whose data directory happens to be named for a lock — which is
 * how this first went wrong, against a temporary directory called
 * `stapes-lock-…`. `server/lock.test.ts` still uses that prefix on purpose.
 */
function isLockError(error: unknown): boolean {
  return /Locking error|locked by another process/i.test(String(error));
}

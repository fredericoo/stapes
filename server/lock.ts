import { openDatabase, type Database } from "./db";

export async function openWorldDatabaseExclusively(
  path: string,
  { attempts = 20, delayMs = 500 } = {},
): Promise<Database> {
  let last: unknown;

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

function isLockError(error: unknown): boolean {
  return /Locking error|locked by another process/i.test(String(error));
}

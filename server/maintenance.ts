import type { Database } from "./db";

/** The world is closed to players, since when, and what they are told. */
export type MaintenanceState = {
  /** Shown to players on the maintenance screen. Null shows a generic line. */
  message: string | null;
  /** When it was switched on, in epoch milliseconds. */
  sinceMs: number;
};

/** Longer than anybody should be reading on a screen that is in the way. */
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 280;

/**
 * Whether the world is closed to everybody but administrators.
 *
 * **Kept in the database, not in the environment.** An environment variable
 * would need a redeploy to change, and a redeploy restarts the world — which
 * is the thing maintenance mode exists to let somebody avoid doing in front of
 * players. A row survives a restart, so a world switched off stays off through
 * the deploys made while it is off.
 *
 * Read once at boot and held in memory after that. Every socket that opens asks
 * for it, and this process is the only writer — see `./lock` — so the copy in
 * memory cannot go stale.
 */
export class Maintenance {
  private constructor(
    private readonly db: Database,
    private current: MaintenanceState | null,
  ) {}

  static async load(db: Database): Promise<Maintenance> {
    const query = await db.prepare("SELECT message, since_ms FROM maintenance WHERE id = 0");
    const row = (await query.get()) as { message: string | null; since_ms: number } | undefined;
    return new Maintenance(db, row ? { message: row.message, sinceMs: row.since_ms } : null);
  }

  /** Null when the world is open. */
  get state(): MaintenanceState | null {
    return this.current;
  }

  /**
   * Close the world, or change what the closed world says.
   *
   * Switching it on again while it is on keeps the original `sinceMs`: the
   * message is what somebody is editing, and the time is when players were
   * first shut out.
   */
  async begin(message: string | null, nowMs = Date.now()): Promise<MaintenanceState> {
    const trimmed = message?.trim().slice(0, MAINTENANCE_MESSAGE_MAX_LENGTH) || null;
    const next = { message: trimmed, sinceMs: this.current?.sinceMs ?? nowMs };
    const write = await this.db.prepare(
      "INSERT OR REPLACE INTO maintenance (id, message, since_ms) VALUES (0, ?, ?)",
    );
    await write.run([next.message, next.sinceMs]);
    this.current = next;
    return next;
  }

  /** Open the world again. */
  async end(): Promise<void> {
    await this.db.exec("DELETE FROM maintenance WHERE id = 0");
    this.current = null;
  }
}

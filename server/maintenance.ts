import type { Database } from "./db";

export type MaintenanceState = {
  message: string | null;
  sinceMs: number;
};

export const MAINTENANCE_MESSAGE_MAX_LENGTH = 280;

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

  get state(): MaintenanceState | null {
    return this.current;
  }

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

  async end(): Promise<void> {
    await this.db.exec("DELETE FROM maintenance WHERE id = 0");
    this.current = null;
  }
}

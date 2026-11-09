import type { Database } from "./db";
import type { TickWindow } from "./tickMeter";

export const TICK_LOG_INTERVAL_MS = 60_000;

export const TICK_LOG_KEPT_MS = 30 * 24 * 60 * 60_000;

export const TICK_LOG_READ_LIMIT = 1500;

export type TickSample = TickWindow & {
  at: number;
  players: number;
  rssMb: number;
};

type Row = { at: number; sample: string };

/**
 * A sample is stored as JSON beside its time, so a phase added to `TickWindow`
 * needs no migration. A minute in which no tick ran has no row.
 */
export class TickLog {
  constructor(private readonly db: Database) {}

  async add(sample: TickSample): Promise<void> {
    const { at, ...rest } = sample;
    const insert = await this.db.prepare("INSERT INTO tick_window (at, sample) VALUES (?, ?)");
    await insert.run([at, JSON.stringify(rest)]);
  }

  async since(at: number): Promise<TickSample[]> {
    const select = await this.db.prepare(
      "SELECT at, sample FROM tick_window WHERE at >= ? ORDER BY at DESC LIMIT ?",
    );
    const rows = (await select.all([at, TICK_LOG_READ_LIMIT])) as Row[];
    return rows
      .map((row) => ({ ...(JSON.parse(row.sample) as Omit<TickSample, "at">), at: row.at }))
      .reverse();
  }

  async prune(before: number): Promise<void> {
    const remove = await this.db.prepare("DELETE FROM tick_window WHERE at < ?");
    await remove.run([before]);
  }
}

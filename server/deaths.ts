import type { Blame } from "../app/game/blame";
import type { DeathCost } from "../app/game/deathCost";
import type { Coord } from "../app/lib/types";
import type { Database } from "./db";

export type DeathRecord = {
  id: number;
  at: number;
  where: Coord | null;
  cause: Blame | null;
  cost: DeathCost;
};

export const INSERT_DEATH_SQL = `INSERT INTO death (character_id, at, x, y, z, source, killer, cost)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

type Row = {
  id: number;
  at: number;
  x: number | null;
  y: number | null;
  z: number | null;
  source: string | null;
  killer: string | null;
  cost: string;
};

/**
 * Rows are written by `GameServer` through the world store's buffered `sql`, so
 * a death is committed in the same transaction as the kit and position it
 * overwrote, and reads here see it only after that checkpoint.
 */
export class Deaths {
  constructor(private readonly db: Database) {}

  async of(characterId: string, limit: number): Promise<DeathRecord[]> {
    const select = await this.db.prepare(
      "SELECT * FROM death WHERE character_id = ? ORDER BY at DESC, id DESC LIMIT ?",
    );
    const rows = (await select.all([characterId, limit])) as Row[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      where: row.x === null ? null : { x: row.x, y: row.y!, z: row.z! },
      cause:
        row.source === null
          ? null
          : { source: row.source, ...(row.killer === null ? {} : { by: row.killer }) },
      cost: JSON.parse(row.cost) as DeathCost,
    }));
  }

  async counts(): Promise<Map<string, number>> {
    const select = await this.db.prepare(
      "SELECT character_id, COUNT(*) AS n FROM death GROUP BY character_id",
    );
    const rows = (await select.all()) as { character_id: string; n: number }[];
    return new Map(rows.map((row) => [row.character_id, row.n]));
  }
}

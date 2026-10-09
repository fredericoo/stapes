import type { DeathCost } from "../app/game/deathCost";
import type { Coord } from "../app/lib/types";
import type { Database } from "./db";

export type DeathRecord = {
  id: number;
  at: number;
  where: Coord | null;
  cause: { source: string; by?: string } | null;
  victim: { id: string; name: string | null; character: boolean };
  killer: { id: string; character: boolean } | null;
  cost: DeathCost | null;
};

export const INSERT_DEATH_SQL = `INSERT INTO death
   (at, victim_id, victim_name, x, y, z, cause_source, cause_by, killer_id, cost)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type Row = {
  id: number;
  at: number;
  victim_id: string;
  victim_name: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  cause_source: string | null;
  cause_by: string | null;
  killer_id: string | null;
  cost: string | null;
  victim_is_character: number;
  killer_is_character: number;
};

const SELECT = `SELECT death.*,
     EXISTS (SELECT 1 FROM character WHERE character.id = death.victim_id) AS victim_is_character,
     EXISTS (SELECT 1 FROM character WHERE character.id = death.killer_id) AS killer_is_character
   FROM death`;

/**
 * Rows are written by `GameServer` through the world store's buffered `sql`, so
 * a death is committed in the same transaction as the kit and position it
 * overwrote, and reads here see it only after that checkpoint.
 */
export class Deaths {
  constructor(private readonly db: Database) {}

  of(characterId: string, limit: number): Promise<DeathRecord[]> {
    return this.list("victim_id", characterId, limit);
  }

  killsBy(characterId: string, limit: number): Promise<DeathRecord[]> {
    return this.list("killer_id", characterId, limit);
  }

  async countOf(characterId: string): Promise<number> {
    const select = await this.db.prepare("SELECT COUNT(*) AS n FROM death WHERE victim_id = ?");
    const row = (await select.get([characterId])) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async counts(): Promise<{ deaths: Map<string, number>; kills: Map<string, number> }> {
    const [deaths, kills] = await Promise.all([
      this.countBy("victim_id"),
      this.countBy("killer_id"),
    ]);
    return { deaths, kills };
  }

  private async list(
    column: "victim_id" | "killer_id",
    actorId: string,
    limit: number,
  ): Promise<DeathRecord[]> {
    const select = await this.db.prepare(
      `${SELECT} WHERE ${column} = ? ORDER BY at DESC, id DESC LIMIT ?`,
    );
    const rows = (await select.all([actorId, limit])) as Row[];
    return rows.map(recordOf);
  }

  private async countBy(column: "victim_id" | "killer_id"): Promise<Map<string, number>> {
    const select = await this.db.prepare(
      `SELECT ${column} AS actor, COUNT(*) AS n FROM death
       WHERE ${column} IN (SELECT id FROM character) GROUP BY ${column}`,
    );
    const rows = (await select.all()) as { actor: string; n: number }[];
    return new Map(rows.map((row) => [row.actor, row.n]));
  }
}

function recordOf(row: Row): DeathRecord {
  return {
    id: row.id,
    at: row.at,
    where: row.x === null ? null : { x: row.x, y: row.y!, z: row.z! },
    cause:
      row.cause_source === null
        ? null
        : { source: row.cause_source, ...(row.cause_by === null ? {} : { by: row.cause_by }) },
    victim: {
      id: row.victim_id,
      name: row.victim_name,
      character: row.victim_is_character === 1,
    },
    killer:
      row.killer_id === null
        ? null
        : { id: row.killer_id, character: row.killer_is_character === 1 },
    cost: row.cost === null ? null : (JSON.parse(row.cost) as DeathCost),
  };
}

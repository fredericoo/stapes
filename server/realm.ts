import type { Database } from "./db";
import type { WorldStore } from "./WorldStore";

export const REALM_LEADERS = 3;

export type Contender = {
  characterId: string;
  name: string;
  rating: number;
  createdAt: number;
};

export type Leader = { name: string; rating: number };

export type RealmState = {
  king: (Leader & { since: number }) | null;
  leaders: Leader[];
};

type Reign = { characterId: string; since: number };

/**
 * A tie keeps the crown where it is, so two characters level on rating do not
 * trade it on every refresh. Otherwise the older character ranks first.
 */
export function rank(contenders: readonly Contender[], holderId: string | null): Contender[] {
  return [...contenders].sort(
    (a, b) =>
      b.rating - a.rating ||
      Number(b.characterId === holderId) - Number(a.characterId === holderId) ||
      a.createdAt - b.createdAt ||
      (a.characterId < b.characterId ? -1 : 1),
  );
}

/**
 * Reign rows go through the world store's buffered `sql`, like deaths, so a
 * crown changes hands in the same checkpoint as the ratings that decided it.
 * The reign in progress is therefore kept here as well, because the table
 * does not show it until that checkpoint.
 */
export class Realm {
  private reign: Reign | null;
  state: RealmState = { king: null, leaders: [] };

  private constructor(
    private readonly store: WorldStore,
    reign: Reign | null,
  ) {
    this.reign = reign;
  }

  static async load(db: Database, store: WorldStore): Promise<Realm> {
    const select = await db.prepare(
      "SELECT character_id, started_at FROM reign WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
    );
    const row = (await select.get()) as { character_id: string; started_at: number } | undefined;
    return new Realm(store, row ? { characterId: row.character_id, since: row.started_at } : null);
  }

  settle(contenders: readonly Contender[], at: number): void {
    const ranked = rank(contenders, this.reign?.characterId ?? null);
    const top = ranked[0] ?? null;
    if (top?.characterId !== this.reign?.characterId) {
      this.store.sql.exec("UPDATE reign SET ended_at = ? WHERE ended_at IS NULL", at);
      if (top) {
        this.store.sql.exec(
          "INSERT INTO reign (character_id, name, started_at) VALUES (?, ?, ?)",
          top.characterId,
          top.name,
          at,
        );
      }
      this.reign = top && { characterId: top.characterId, since: at };
    }
    const leaders = ranked.slice(0, REALM_LEADERS).map(({ name, rating }) => ({ name, rating }));
    this.state = {
      king: top && this.reign ? { ...leaders[0]!, since: this.reign.since } : null,
      leaders,
    };
  }

  forget(): void {
    this.store.sql.exec("DELETE FROM reign");
    this.reign = null;
    this.state = { king: null, leaders: [] };
  }
}

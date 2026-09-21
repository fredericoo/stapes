import {
  MAX_CHARACTERS_PER_ACCOUNT,
  characterNameProblem,
  normaliseCharacterName,
} from "../app/lib/characterName";
import type { Database } from "./db";

/** One character, as an account sees it. */
export type Character = {
  id: string;
  name: string;
  createdAt: number;
};

/**
 * The characters an account holds, and the rules about making one.
 *
 * Plain SQL against the same connection everything else uses, rather than
 * another Kysely model: there are four statements here, and routing them
 * through Better Auth's adapter would put the game's own table behind a
 * library that has no opinion about it.
 *
 * **A character id is an actor id.** Everything the world remembers about
 * somebody — `pos:`, `equip:`, `mast:`, the body in the `chunk:` rows — is
 * keyed by it, and none of that changed when accounts arrived. What arrived is
 * a row saying who the id belongs to.
 */
export class Characters {
  constructor(private readonly db: Database) {}

  async listFor(userId: string): Promise<Character[]> {
    const statement = await this.db.prepare(
      "SELECT id, name, created_at FROM character WHERE user_id = ? ORDER BY created_at",
    );
    const rows = (await statement.all([userId])) as {
      id: string;
      name: string;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  /**
   * Whether this account may play this character.
   *
   * The whole of the ownership check, and it is asked at the socket upgrade
   * rather than trusted from the page — see `server/index.ts`. A client names
   * the character it wants to be; this is what stops it naming somebody
   * else's.
   */
  async ownedBy(characterId: string, userId: string): Promise<Character | null> {
    const statement = await this.db.prepare(
      "SELECT id, name, created_at FROM character WHERE id = ? AND user_id = ?",
    );
    const row = (await statement.get([characterId, userId])) as
      | { id: string; name: string; created_at: number }
      | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }

  /**
   * What to call this body, asked by the world rather than by a page.
   *
   * Null for an id with no character behind it, which is every creature on the
   * map: the world asks this about each actor it seats, and most of them are
   * deer. @see `GameServer.seatActor`
   */
  async nameOf(characterId: string): Promise<string | null> {
    const statement = await this.db.prepare("SELECT name FROM character WHERE id = ?");
    const row = (await statement.get([characterId])) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * Make a character, or say why not.
   *
   * Returns a reason rather than throwing, because every failure here is
   * something the person typing is entitled to read: the name is not a name,
   * somebody already has it, or this account is full.
   *
   * **The name race is settled by the index, not by a lookup.** Checking for
   * the name first and inserting after leaves a window two signups can both
   * pass through, and the window is widest exactly when it matters — the
   * minute after a new name becomes plausible. So the insert is the check, and
   * a unique-constraint failure is translated back into the sentence a
   * pre-flight lookup would have produced.
   *
   * The count is not protected that way and does not need to be. SQLite has no
   * constraint to express "at most three rows per owner", and the cost of
   * losing the race is one account with four characters rather than a name
   * two people answer to.
   */
  async create(
    userId: string,
    typed: string,
  ): Promise<{ character: Character } | { error: string }> {
    const problem = characterNameProblem(typed);
    if (problem) return { error: problem };

    const existing = await this.listFor(userId);
    if (existing.length >= MAX_CHARACTERS_PER_ACCOUNT) {
      return {
        error: `An account holds at most ${MAX_CHARACTERS_PER_ACCOUNT} characters.`,
      };
    }

    const character: Character = {
      id: crypto.randomUUID(),
      name: normaliseCharacterName(typed),
      createdAt: Date.now(),
    };
    const insert = await this.db.prepare(
      "INSERT INTO character (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
    );
    try {
      await insert.run([character.id, userId, character.name, character.createdAt]);
    } catch (error) {
      if (isNameTaken(error)) {
        return { error: `${character.name} is already taken.` };
      }
      throw error;
    }
    return { character };
  }
}

/**
 * Whether a failed insert failed because the name was gone.
 *
 * Matched on the message because that is what the driver gives: Turso raises a
 * `SqliteError` whose text names the constraint, and there is no typed code to
 * switch on. Narrow enough to be honest — a failure that is not this one is
 * rethrown, so a full disk does not read as a taken name.
 */
function isNameTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: character\.name/i.test(message);
}

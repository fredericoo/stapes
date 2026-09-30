import {
  MAX_CHARACTERS_PER_ACCOUNT,
  characterNameProblem,
  normaliseCharacterName,
} from "../app/lib/characterName";
import type { Database } from "./db";

export type Character = {
  id: string;
  name: string;
  createdAt: number;
};

export type RosterEntry = {
  userId: string;
  username: string | null;
  guest: boolean;
  admin: boolean;
  accountCreatedAt: number;
  character: (Character & { lastSeenAt: number | null }) | null;
};

type RosterRow = {
  user_id: string;
  username: string | null;
  isAnonymous: number;
  role: string;
  user_created_at: string;
  id: string | null;
  name: string | null;
  created_at: number | null;
  last_seen_at: number | null;
};

const ROSTER_SQL = `SELECT user.id AS user_id, user.username, user.isAnonymous, user.role,
         user.createdAt AS user_created_at,
         character.id, character.name, character.created_at, character.last_seen_at
  FROM user LEFT JOIN character ON character.user_id = user.id`;

function rosterEntryOf(row: RosterRow): RosterEntry {
  return {
    userId: row.user_id,
    username: row.username,
    guest: row.isAnonymous === 1,
    admin: row.role === "ADMIN",
    accountCreatedAt: Date.parse(row.user_created_at),
    character:
      row.id === null
        ? null
        : {
            id: row.id,
            name: row.name!,
            createdAt: row.created_at!,
            lastSeenAt: row.last_seen_at,
          },
  };
}

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

  async ownedBy(characterId: string, userId: string): Promise<Character | null> {
    const statement = await this.db.prepare(
      "SELECT id, name, created_at FROM character WHERE id = ? AND user_id = ?",
    );
    const row = (await statement.get([characterId, userId])) as
      | { id: string; name: string; created_at: number }
      | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }

  async nameOf(characterId: string): Promise<string | null> {
    const statement = await this.db.prepare("SELECT name FROM character WHERE id = ?");
    const row = (await statement.get([characterId])) as { name: string } | undefined;
    return row?.name ?? null;
  }

  async markSeen(characterId: string, at: number): Promise<void> {
    const update = await this.db.prepare("UPDATE character SET last_seen_at = ? WHERE id = ?");
    await update.run([at, characterId]);
  }

  /** One entry per character, plus one for each account that has none yet. */
  async roster(): Promise<RosterEntry[]> {
    const select = await this.db.prepare(ROSTER_SQL);
    return ((await select.all()) as RosterRow[]).map(rosterEntryOf);
  }

  async rosterEntry(characterId: string): Promise<RosterEntry | null> {
    const select = await this.db.prepare(`${ROSTER_SQL} WHERE character.id = ?`);
    const row = (await select.get([characterId])) as RosterRow | undefined;
    return row ? rosterEntryOf(row) : null;
  }

  async nameTaken(typed: string): Promise<boolean> {
    const statement = await this.db.prepare("SELECT 1 FROM character WHERE name = ?");
    return (await statement.get([normaliseCharacterName(typed)])) !== undefined;
  }

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

function isNameTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: character\.name/i.test(message);
}

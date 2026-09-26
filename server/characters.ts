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

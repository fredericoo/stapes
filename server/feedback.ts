import type { Database } from "./db";

export const MAX_FEEDBACK_LENGTH = 2000;

export const MAX_FEEDBACK_CONTEXT_BYTES = 16_384;

export const FEEDBACK_PER_WINDOW = 3;

export const FEEDBACK_WINDOW_MS = 60_000;

export type FeedbackEntry = {
  id: number;
  at: number;
  userId: string;
  username: string | null;
  guest: boolean;
  characterName: string | null;
  message: string;
  context: Record<string, unknown>;
};

export type NewFeedback = Omit<FeedbackEntry, "id">;

type Row = {
  id: number;
  at: number;
  user_id: string;
  username: string | null;
  guest: number;
  character_name: string | null;
  message: string;
  context: string;
};

/**
 * Rows keep the username and character name as they were when the message was
 * sent, and `user_id` is not a foreign key, so feedback outlives the account
 * that wrote it.
 */
export class Feedback {
  constructor(private readonly db: Database) {}

  async add(entry: NewFeedback): Promise<void> {
    const insert = await this.db.prepare(
      `INSERT INTO feedback (at, user_id, username, guest, character_name, message, context)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    await insert.run([
      entry.at,
      entry.userId,
      entry.username,
      entry.guest ? 1 : 0,
      entry.characterName,
      entry.message,
      JSON.stringify(entry.context),
    ]);
  }

  async sentSince(userId: string, since: number): Promise<number> {
    const count = await this.db.prepare(
      "SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND at >= ?",
    );
    return ((await count.get([userId, since])) as { n: number }).n;
  }

  async recent(limit: number): Promise<FeedbackEntry[]> {
    const select = await this.db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT ?");
    const rows = (await select.all([limit])) as Row[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      userId: row.user_id,
      username: row.username,
      guest: row.guest === 1,
      characterName: row.character_name,
      message: row.message,
      context: JSON.parse(row.context) as Record<string, unknown>,
    }));
  }
}

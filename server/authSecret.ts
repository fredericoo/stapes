import type { Database } from "./db";

/**
 * What session cookies are signed with.
 *
 * **Configured, or generated once and kept.** `AUTH_SECRET` wins when it is
 * set; when it is not, a deployment mints 32 random bytes on its first boot and
 * reads the same value back on every boot after. What must never happen is
 * Better Auth falling back to the constant it ships in its own source, which is
 * a session anybody who has read that source can forge.
 *
 * **It used to be a hard requirement, and that was the wrong call.** A server
 * that refuses to start until somebody sets a variable is a server that does
 * not come up on a deployment whose environment nobody has touched yet — which
 * is every preview, and the first deploy of anything. The failure is also the
 * worst kind to read: the container crash-loops, no backend answers, no
 * certificate is ever issued, and the health check times out against a
 * self-signed cert with nothing in the log about a missing variable.
 *
 * Storing it beside the sessions is not a weakening. The secret's whole job is
 * to make a cookie unforgeable by somebody who does not have the database;
 * anybody who *has* the database already has the `session` table and does not
 * need to forge anything. An operator who would rather it lived somewhere else
 * sets `AUTH_SECRET` and this row is never read.
 *
 * Its own table rather than a `kv` row, on the terms `alarm` has one: `kv` is
 * the world being played and `POST /api/reset` empties it. Signing everybody
 * out because somebody reset the map would be a reset doing something it does
 * not say it does.
 */
export async function resolveAuthSecret(
  db: Database,
  configured: string | undefined,
): Promise<string> {
  if (configured) return configured;

  const existing = await db.prepare("SELECT secret FROM auth_secret WHERE id = 0");
  const row = (await existing.get()) as { secret: string } | undefined;
  if (row?.secret) return row.secret;

  const minted = mintSecret();
  // `INSERT OR IGNORE`, so two processes racing to a fresh database cannot end
  // up with the second overwriting the first's — the loser reads the winner's
  // back below. `server/lock.ts` makes that race impossible today; the row is
  // written once ever, and this is the cheaper thing to get right than to
  // remember.
  const insert = await db.prepare("INSERT OR IGNORE INTO auth_secret (id, secret) VALUES (0, ?)");
  await insert.run([minted]);

  const settled = await db.prepare("SELECT secret FROM auth_secret WHERE id = 0");
  const stored = (await settled.get()) as { secret: string } | undefined;
  return stored?.secret ?? minted;
}

/**
 * 32 bytes, base64. Better Auth warns below 32 characters, and a key shorter
 * than the digest it feeds is a key with less entropy than the thing it signs.
 */
function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

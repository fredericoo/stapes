import type { Database } from "./db";

export async function resolveAuthSecret(
  db: Database,
  configured: string | undefined,
): Promise<string> {
  if (configured) return configured;

  const existing = await db.prepare("SELECT secret FROM auth_secret WHERE id = 0");
  const row = (await existing.get()) as { secret: string } | undefined;
  if (row?.secret) return row.secret;

  const minted = mintSecret();
  const insert = await db.prepare("INSERT OR IGNORE INTO auth_secret (id, secret) VALUES (0, ?)");
  await insert.run([minted]);

  const settled = await db.prepare("SELECT secret FROM auth_secret WHERE id = 0");
  const stored = (await settled.get()) as { secret: string } | undefined;
  return stored?.secret ?? minted;
}

function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

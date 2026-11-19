/**
 * Tile ids that were renamed after worlds had already stored them. Append
 * only: `server/db.ts` builds a migration from each entry once and never again.
 */
export const TILE_ID_PREFIX_RENAMES: readonly { from: string; to: string }[] = [
  { from: "arcane-stone-of-", to: "rune-" },
];

/**
 * Rewrites every renamed tile id in a stored JSON text. Ids are matched with
 * the opening quote, so only a whole string or object key that starts with an
 * old prefix changes. No new id starts with an old prefix, so rewriting a text
 * twice gives the same text as rewriting it once.
 */
export function renameTileIdsInJson(text: string): string {
  let out = text;
  for (const { from, to } of TILE_ID_PREFIX_RENAMES) {
    out = out.replaceAll(`"${from}`, `"${to}`);
  }
  return out;
}

/** The same rewrite as `renameTileIdsInJson`, as SQL over one table's JSON column. */
export function renameTileIdsSql(
  rename: { from: string; to: string },
  table: string,
  column: string,
) {
  const from = `"${rename.from}`;
  const to = `"${rename.to}`;
  return `UPDATE ${table} SET ${column} = replace(CAST(${column} AS TEXT), '${from}', '${to}') WHERE instr(CAST(${column} AS TEXT), '${from}') > 0`;
}

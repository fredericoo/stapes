/**
 * A tile id renamed after worlds had already stored it. A prefix rename
 * rewrites every id that starts with `from`; an exact one rewrites only the
 * id `from` itself where a placement names it as its `tileId`, so `grass`
 * can become `tuft` without touching `grass-2`.
 */
export type TileRename = { from: string; to: string; exact?: boolean };

/**
 * Append only: `server/db.ts` builds a migration from each entry once and
 * never again, and a tab's world records how many it has applied. A rename
 * may free an id for a new tile (`grass` became `tuft`, then the grass
 * autotile took `grass`), so applying one twice is not safe.
 */
export const TILE_ID_RENAMES: readonly TileRename[] = [
  { from: "arcane-stone-of-", to: "rune-" },
  { from: "sand-dunes", to: "sand" },
  { from: "grass", to: "tuft", exact: true },
];

function needle(rename: TileRename, id: string): string {
  return rename.exact ? `"tileId":"${id}"` : `"${id}`;
}

/**
 * Rewrites the renamed tile ids in a stored JSON text, from the rename at
 * `first` on. Ids are matched with their opening quote, so only a whole
 * string or object key that starts with an old prefix changes; an exact
 * rename matches the whole `"tileId":"…"` pair as `JSON.stringify` writes it.
 */
export function renameTileIdsInJson(text: string, first = 0): string {
  let out = text;
  for (const rename of TILE_ID_RENAMES.slice(first)) {
    out = out.replaceAll(needle(rename, rename.from), needle(rename, rename.to));
  }
  return out;
}

/** The same rewrite as `renameTileIdsInJson`, as SQL over one table's JSON column. */
export function renameTileIdsSql(rename: TileRename, table: string, column: string) {
  const from = needle(rename, rename.from);
  const to = needle(rename, rename.to);
  return `UPDATE ${table} SET ${column} = replace(CAST(${column} AS TEXT), '${from}', '${to}') WHERE instr(CAST(${column} AS TEXT), '${from}') > 0`;
}

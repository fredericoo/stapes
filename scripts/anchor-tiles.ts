/**
 * Rewrites `data/tiles.json` into the anchored sprite encoding, once.
 *
 *   bun scripts/anchor-tiles.ts            # rewrite in place
 *   bun scripts/anchor-tiles.ts --check    # say what would change, write nothing
 *
 * A tile used to name a sheet on every one of its sprites and measure every rect
 * from that sheet's corner. It now names the sheet once, on `TileDef.anchor`,
 * and measures every rect from there — see `app/lib/types`.
 *
 * `normalizeTileDef` migrates the old encoding on load, so the game reads the
 * file either way and this script changes nothing anybody can see. It exists so
 * that *reading* `data/tiles.json` tells you what the game will do with it,
 * which is the same reason `settleTileDef` writes `lightPassing` out rather than
 * only answering for it. Run once; there is nothing left for it to do afterwards.
 *
 * **It refuses a tile whose sprites disagree about their sheet.** The migration
 * takes the first sheet it finds and would silently draw the rest of that tile
 * from the wrong picture. Nothing in the catalogue has ever done this — checked
 * before the encoding changed — so the refusal is a guard against a hand-edit,
 * not a case anybody has to handle.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeTiles } from "../app/lib/types";

const FILE = "data/tiles.json";
const check = process.argv.includes("--check");

type RawSprite = { tilesetId?: string; rect?: { x: number; y: number } };

/** Every sheet named anywhere on this tile, however deeply it is nested. */
function sheetsNamedBy(node: unknown, out: Set<string>): Set<string> {
  if (!node || typeof node !== "object") return out;
  const sprite = node as RawSprite;
  if (typeof sprite.tilesetId === "string") out.add(sprite.tilesetId);
  for (const value of Object.values(node)) sheetsNamedBy(value, out);
  return out;
}

const raw = JSON.parse(readFileSync(FILE, "utf8")) as unknown[];

const spread = raw
  .map((tile) => ({
    id: (tile as { id?: string }).id ?? "(unnamed)",
    sheets: [...sheetsNamedBy(tile, new Set())],
  }))
  .filter((t) => t.sheets.length > 1);

if (spread.length > 0) {
  for (const { id, sheets } of spread) {
    console.error(`${id} draws from ${sheets.length} sheets: ${sheets.join(", ")}`);
  }
  console.error("\nA tile draws from one sheet. Split these before rewriting.");
  process.exit(1);
}

/**
 * The anchor where a reader expects it — with the other facts about what the
 * tile *is* — rather than after everything the tile does.
 *
 * `normalizeTileDef` appends it, which is invisible in memory and would put it
 * several hundred lines below the sprites it governs in the file.
 */
const anchored = normalizeTiles(raw).map(
  ({ id, name, height, type, kind, attributes, anchor, ...rest }) => ({
    id,
    name,
    height,
    type,
    kind,
    attributes,
    anchor,
    ...rest,
  }),
);
const before = raw.filter((t) => (t as { anchor?: unknown }).anchor == null).length;

if (check) {
  console.log(`${before} of ${raw.length} tiles would gain an anchor.`);
  process.exit(0);
}

writeFileSync(FILE, `${JSON.stringify(anchored, null, 2)}\n`);
console.log(`Rewrote ${FILE}: ${before} of ${raw.length} tiles gained an anchor.`);

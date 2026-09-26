import { readFileSync, writeFileSync } from "node:fs";
import { normalizeTiles } from "../app/lib/types";

const FILE = "data/tiles.json";
const check = process.argv.includes("--check");

type RawSprite = { tilesetId?: string; rect?: { x: number; y: number } };

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

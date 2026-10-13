import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import * as v from "valibot";
import { normalize, normalShade, type Vec3 } from "../app/render/spriteNormals";
import type { TileDef, TilesetDef } from "../app/lib/types";
import {
  TO_CAMERA,
  baseNormal,
  decodeNormal,
  encodeNormal,
  hexAt,
  isOpaque,
  shapeAt,
  spriteUses,
  withDetail,
  type Sheet,
  type SpriteUse,
} from "./normal-maps/normals";
import { NormalSheetSpec, type TileSpec } from "./normal-maps/spec";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const SPECS = path.join(DATA, "normals");
const TILESETS = path.join(DATA, "tilesets");
const NORMAL_SUFFIX = "_normal.png";
const RGBA = 4;
const CHANNEL_MAX = 255;

const PREVIEW_SCALE = 6;
const PREVIEW_GAP_PX = 2;
const PREVIEW_MAX_SPRITES = 8;
const PREVIEW_LIGHTS: [string, Vec3][] = [
  ["east", normalize([1, 0, 0.8])],
  ["west", normalize([-1, 0, 0.8])],
  ["north", normalize([0, 1, 0.8])],
  ["south", normalize([0, -1, 0.8])],
  ["overhead", [0, 0, 1]],
];

type Loaded = { spec: NormalSheetSpec; files: string[]; tileset: TilesetDef };

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/** A sheet's tiles may be split across several files, so two people can write one sheet. */
/**
 * A preview reads only one sheet, so it skips another file that does not parse
 * rather than failing on somebody else's half-written entry.
 */
async function readSpec(name: string, lenient: boolean): Promise<NormalSheetSpec | null> {
  try {
    return v.parse(NormalSheetSpec, await readJson(path.join(SPECS, name)));
  } catch (err) {
    const why = v.isValiError(err) ? JSON.stringify(v.flatten(err.issues).nested) : String(err);
    if (!lenient) throw new Error(`data/normals/${name}: ${why}`, { cause: err });
    console.warn(`skipping data/normals/${name}: ${why}`);
    return null;
  }
}

async function loadSpecs(tilesets: TilesetDef[], lenient: boolean): Promise<Loaded[]> {
  const names = (await fs.readdir(SPECS).catch(() => [])).filter((n) => n.endsWith(".json"));
  const bySheet = new Map<string, Loaded>();
  for (const name of names.sort()) {
    const spec = await readSpec(name, lenient);
    if (!spec) continue;
    const tileset = tilesets.find((t) => t.id === spec.sheet);
    if (!tileset) throw new Error(`${name}: tilesets.json has no sheet "${spec.sheet}"`);
    const into = bySheet.get(spec.sheet);
    if (!into) {
      bySheet.set(spec.sheet, { spec, files: [name], tileset });
      continue;
    }
    mergeTiles(into, spec, name);
  }
  return [...bySheet.values()];
}

function mergeTiles(into: Loaded, spec: NormalSheetSpec, name: string) {
  for (const [id, tile] of Object.entries(spec.tiles)) {
    if (into.spec.tiles[id])
      throw new Error(`${name}: "${id}" is also in ${into.files.join(", ")}`);
    into.spec.tiles[id] = tile;
  }
  into.files.push(name);
}

async function readSheet(tileset: TilesetDef): Promise<Sheet> {
  const png = PNG.sync.read(await fs.readFile(path.join(TILESETS, tileset.file)));
  return { width: png.width, height: png.height, data: png.data };
}

/** Per-pixel normals for one sprite, keyed by sheet pixel index. */
function spriteNormals(sheet: Sheet, use: SpriteUse, spec: TileSpec): Map<number, Vec3> {
  const groups = new Map<number, string>();
  const bases = new Map<number, Vec3>();
  forEachOpaque(sheet, use, (x, y, i) => {
    const shape = shapeAt(spec, use, hexAt(sheet, x, y), x - use.rect.x, y - use.rect.y);
    groups.set(i, JSON.stringify(shape));
    bases.set(i, baseNormal(shape, sheet, use, x, y));
  });
  const groupAt = (x: number, y: number) => groups.get(y * sheet.width + x) ?? null;
  const out = new Map<number, Vec3>();
  for (const [i, n] of bases) {
    const x = i % sheet.width;
    const y = Math.floor(i / sheet.width);
    out.set(i, withDetail(n, { sheet, use, spec, groupAt }, x, y));
  }
  return out;
}

function forEachOpaque(
  sheet: Sheet,
  use: SpriteUse,
  visit: (x: number, y: number, i: number) => void,
) {
  const { x: rx, y: ry, w, h } = use.rect;
  for (let y = ry; y < ry + h; y++) {
    for (let x = rx; x < rx + w; x++) {
      if (isOpaque(sheet, x, y)) visit(x, y, y * sheet.width + x);
    }
  }
}

function usesFor(spec: NormalSheetSpec, tiles: TileDef[]): [SpriteUse, TileSpec][] {
  return tiles
    .filter((t) => t.anchor.tilesetId === spec.sheet && spec.tiles[t.id])
    .flatMap((t) => spriteUses(t).map((u): [SpriteUse, TileSpec] => [u, spec.tiles[t.id]!]));
}

type Built = { png: PNG; clashes: string[] };

/**
 * Tiles that draw the same pixels share one normal there, so two entries that
 * disagree about them are reported rather than left to whichever runs last.
 */
function buildNormalMap(sheet: Sheet, spec: NormalSheetSpec, tiles: TileDef[]): Built {
  const png = new PNG({ width: sheet.width, height: sheet.height });
  const camera = encodeNormal(TO_CAMERA);
  for (let i = 0; i < sheet.width * sheet.height; i++) {
    if (sheet.data[i * RGBA + 3]! === 0) continue;
    png.data.set([...camera, CHANNEL_MAX], i * RGBA);
  }
  const owners = new Map<number, { tileId: string; rgb: string }>();
  const clashCounts = new Map<string, number>();
  for (const [use, tileSpec] of usesFor(spec, tiles)) {
    for (const [i, n] of spriteNormals(sheet, use, tileSpec)) {
      const rgb = encodeNormal(n);
      const owner = owners.get(i);
      if (owner && owner.tileId !== use.tileId && owner.rgb !== rgb.join()) {
        const key = `"${owner.tileId}" and "${use.tileId}"`;
        clashCounts.set(key, (clashCounts.get(key) ?? 0) + 1);
      }
      owners.set(i, { tileId: use.tileId, rgb: rgb.join() });
      png.data.set([...rgb, CHANNEL_MAX], i * RGBA);
    }
  }
  const clashes = [...clashCounts].map(
    ([pair, n]) => `${spec.sheet}: ${pair} share ${n} px but give them different normals`,
  );
  return { png, clashes };
}

function coverage(loaded: Loaded[], tiles: TileDef[]): string[] {
  const problems: string[] = [];
  for (const { spec, files } of loaded) {
    const onSheet = tiles.filter((t) => t.anchor.tilesetId === spec.sheet);
    const name = files.join(", ");
    for (const t of onSheet) {
      if (!spec.tiles[t.id]) problems.push(`${name}: no entry for tile "${t.id}"`);
    }
    for (const id of Object.keys(spec.tiles)) {
      if (!onSheet.some((t) => t.id === id)) {
        problems.push(`${name}: "${id}" is not a tile on sheet "${spec.sheet}"`);
      }
    }
  }
  return problems;
}

/** One sprite of each facing comes first, so a short preview still shows every direction. */
function previewOrder(uses: SpriteUse[]): SpriteUse[] {
  const seen = new Set<string>();
  const unique = uses.filter((u) => {
    const key = `${u.rect.x},${u.rect.y},${u.facing}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = new Map<SpriteUse, number>();
  const perFacing = new Map<string, number>();
  for (const u of unique) {
    const n = perFacing.get(u.facing) ?? 0;
    perFacing.set(u.facing, n + 1);
    rank.set(u, n);
  }
  return unique.sort((a, b) => rank.get(a)! - rank.get(b)!);
}

function paintPanel(
  out: PNG,
  sheet: Sheet,
  normals: PNG,
  use: SpriteUse,
  at: { x: number; y: number },
  light: Vec3 | "albedo" | "normal",
) {
  for (let y = 0; y < use.rect.h; y++) {
    for (let x = 0; x < use.rect.w; x++) {
      const si = ((use.rect.y + y) * sheet.width + use.rect.x + x) * RGBA;
      const colour = previewColour(sheet, normals, si, light);
      fillBlock(out, at.x + x * PREVIEW_SCALE, at.y + y * PREVIEW_SCALE, colour);
    }
  }
}

function previewColour(sheet: Sheet, normals: PNG, si: number, light: Vec3 | "albedo" | "normal") {
  if (sheet.data[si + 3]! < CHANNEL_MAX / 2) return [40, 40, 48];
  if (light === "normal") return [normals.data[si]!, normals.data[si + 1]!, normals.data[si + 2]!];
  const shade = light === "albedo" ? 1 : normalShade(decodeNormal(normals.data, si), light);
  return [0, 1, 2].map((c) => Math.min(CHANNEL_MAX, Math.round(sheet.data[si + c]! * shade)));
}

function fillBlock(out: PNG, x0: number, y0: number, colour: number[]) {
  for (let y = y0; y < y0 + PREVIEW_SCALE; y++) {
    for (let x = x0; x < x0 + PREVIEW_SCALE; x++) {
      out.data.set([...colour, CHANNEL_MAX], (y * out.width + x) * RGBA);
    }
  }
}

function preview(sheet: Sheet, normals: PNG, uses: SpriteUse[]): PNG {
  const panels: (Vec3 | "albedo" | "normal")[] = [
    "albedo",
    "normal",
    ...PREVIEW_LIGHTS.map((l) => l[1]),
  ];
  const cellW =
    Math.max(...uses.map((u) => u.rect.w)) * PREVIEW_SCALE + PREVIEW_GAP_PX * PREVIEW_SCALE;
  const cellH =
    Math.max(...uses.map((u) => u.rect.h)) * PREVIEW_SCALE + PREVIEW_GAP_PX * PREVIEW_SCALE;
  const out = new PNG({ width: cellW * panels.length, height: cellH * uses.length });
  out.data.fill(CHANNEL_MAX / 5);
  uses.forEach((use, row) => {
    panels.forEach((light, col) =>
      paintPanel(out, sheet, normals, use, { x: col * cellW, y: row * cellH }, light),
    );
  });
  return out;
}

function palette(sheet: Sheet, uses: SpriteUse[], spec: TileSpec): string[] {
  const counts = new Map<string, { n: number; shape: string }>();
  for (const use of uses) {
    forEachOpaque(sheet, use, (x, y) => {
      const hex = hexAt(sheet, x, y);
      const shape = JSON.stringify(shapeAt(spec, use, hex, x - use.rect.x, y - use.rect.y));
      const seen = counts.get(hex) ?? { n: 0, shape };
      counts.set(hex, { n: seen.n + 1, shape: seen.shape });
    });
  }
  return [...counts]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([hex, c]) => `${hex}  ${c.n}px  → ${c.shape}`);
}

async function runPreview(
  tileId: string,
  outFile: string,
  limit: number,
  loaded: Loaded[],
  tiles: TileDef[],
) {
  const def = tiles.find((t) => t.id === tileId);
  if (!def) throw new Error(`no tile "${tileId}" in tiles.json`);
  const entry = loaded.find((l) => l.spec.sheet === def.anchor.tilesetId && l.spec.tiles[tileId]);
  if (!entry)
    throw new Error(`no data/normals entry for "${tileId}" on sheet ${def.anchor.tilesetId}`);
  const sheet = await readSheet(entry.tileset);
  const normals = buildNormalMap(sheet, entry.spec, tiles).png;
  const uses = previewOrder(spriteUses(def)).slice(0, limit);
  await fs.writeFile(outFile, PNG.sync.write(preview(sheet, normals, uses)));
  console.log(`${tileId}: ${uses.length} sprites → ${outFile}`);
  console.log("columns: albedo | normal | lit from east | west | north | south | overhead");
  console.log(
    uses
      .map((u) => `  ${u.facing} rect ${u.rect.x},${u.rect.y} ${u.rect.w}×${u.rect.h}`)
      .join("\n"),
  );
  console.log(palette(sheet, spriteUses(def), entry.spec.tiles[tileId]!).join("\n"));
}

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    preview: { type: "string" },
    out: { type: "string" },
    sprites: { type: "string" },
  },
});

const tiles = (await readJson(path.join(DATA, "tiles.json"))) as TileDef[];
const tilesets = (await readJson(path.join(DATA, "tilesets.json"))) as TilesetDef[];
const loaded = await loadSpecs(tilesets, values.preview !== undefined);

if (values.preview) {
  const limit = values.sprites ? Number(values.sprites) : PREVIEW_MAX_SPRITES;
  const out = values.out ?? `/tmp/normal-${values.preview}.png`;
  await runPreview(values.preview, out, limit, loaded, tiles);
} else {
  const problems = coverage(loaded, tiles);
  const built = await Promise.all(
    loaded.map(async ({ spec, tileset }) => ({
      tileset,
      ...buildNormalMap(await readSheet(tileset), spec, tiles),
    })),
  );
  problems.push(...built.flatMap((b) => b.clashes));
  for (const p of problems) console.warn(p);
  if (values.check) process.exit(problems.length > 0 ? 1 : 0);
  for (const { tileset, png } of built) {
    const target = path.join(TILESETS, tileset.file.replace(/\.png$/, NORMAL_SUFFIX));
    await fs.writeFile(target, PNG.sync.write(png));
    console.log(`wrote ${path.relative(ROOT, target)}`);
  }
}

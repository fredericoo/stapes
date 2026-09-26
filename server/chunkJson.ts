import { chunkCopiedFrom, getChunk, listChunkKeys } from "../app/lib/mapData";
import { visibleStack } from "../app/net/interest";
import type { CellAffliction, CellPatch } from "../app/net/protocol";
import type { ChunkCells, MapFile, PlacedTile } from "../app/lib/types";
import { MAP_FILE_VERSION, MAX_LEVEL, MIN_LEVEL, levelKey } from "../app/lib/types";

type ChunkText = {
  z: number;
  keys: readonly string[];
  index: Map<string, number> | null;
  stacks: StackText[];
  bodyCells: number;
  cellsJoined: string | null;
  entriesJoined: string | null;
};

type StackText = {
  key: string;
  z: number;
  stack: PlacedTile[];
  owners: string[] | null;
  bare: string | null;
  cell: string | null;
  entry: string | null;
};

const texts = new WeakMap<ChunkCells, ChunkText>();
const stackTexts = new WeakMap<PlacedTile[], StackText>();

const MAX_INHERIT_STEPS = 256;

const NOBODY: ReadonlySet<string> = new Set();

function stackTextOf(stack: PlacedTile[], key: string, z: number): StackText {
  const kept = stackTexts.get(stack);
  if (kept !== undefined && kept.key === key && kept.z === z) return kept;
  let owners: string[] | null = null;
  for (const placed of stack) {
    if (placed.owner) (owners ??= []).push(placed.owner);
  }
  const text: StackText = { key, z, stack, owners, bare: null, cell: null, entry: null };
  stackTexts.set(stack, text);
  return text;
}

function bareOf(text: StackText): string {
  text.bare ??= JSON.stringify(text.owners ? visibleStack(text.stack, NOBODY) : text.stack);
  return text.bare;
}

function cellTextOf(text: StackText): string {
  if (text.cell !== null) return text.cell;
  const { x, y } = cellXY(text.key);
  text.cell =
    `{"x":${JSON.stringify(x)},"y":${JSON.stringify(y)},"z":${JSON.stringify(text.z)}` +
    `,"stack":${bareOf(text)}}`;
  return text.cell;
}

function entryTextOf(text: StackText): string {
  text.entry ??= `${JSON.stringify(text.key)}:${bareOf(text)}`;
  return text.entry;
}

function textOf(chunk: ChunkCells, z: number): ChunkText {
  const kept = texts.get(chunk);
  /** Two levels can share one chunk object, and the level is part of the text. */
  if (kept && kept.z === z) return kept;
  const text = inheritedText(chunk, z) ?? readText(chunk, z);
  texts.set(chunk, text);
  return text;
}

function readText(chunk: ChunkCells, z: number): ChunkText {
  const keys: string[] = [];
  const stacks: StackText[] = [];
  let bodyCells = 0;
  for (const key in chunk) {
    const stack = stackTextOf(chunk[key]!, key, z);
    keys.push(key);
    stacks.push(stack);
    if (stack.owners) bodyCells++;
  }
  return { z, keys, index: null, stacks, bodyCells, cellsJoined: null, entriesJoined: null };
}

function inheritedText(chunk: ChunkCells, z: number): ChunkText | null {
  const written = new Set<string>();
  let at = chunk;
  for (let steps = 0; steps < MAX_INHERIT_STEPS; steps++) {
    const link = chunkCopiedFrom(at);
    if (link === null) return null;
    for (const key of link.keys) {
      if (link.from[key] === undefined || at[key] === undefined) return null;
      written.add(key);
    }
    const base = texts.get(link.from);
    if (base !== undefined && base.z === z) return carriedDown(base, chunk, z, written);
    at = link.from;
  }
  return null;
}

function carriedDown(
  base: ChunkText,
  chunk: ChunkCells,
  z: number,
  written: ReadonlySet<string>,
): ChunkText {
  const index = (base.index ??= new Map(base.keys.map((key, i) => [key, i])));
  const stacks = base.stacks.slice();
  let bodyCells = base.bodyCells;
  let sameText = true;
  for (const key of written) {
    const i = index.get(key)!;
    const was = stacks[i]!;
    const now = stackTextOf(chunk[key]!, key, z);
    if (now === was) continue;
    if (bareOf(now) !== bareOf(was)) sameText = false;
    if (was.owners) bodyCells--;
    if (now.owners) bodyCells++;
    stacks[i] = now;
  }
  return {
    z,
    keys: base.keys,
    index,
    stacks,
    bodyCells,
    cellsJoined: sameText ? base.cellsJoined : null,
    entriesJoined: sameText ? base.entriesJoined : null,
  };
}

function holdsAny(owners: readonly string[] | null, held: ReadonlySet<string>): boolean {
  if (owners === null || held.size === 0) return false;
  for (const owner of owners) if (held.has(owner)) return true;
  return false;
}

function cellXY(key: string): { x: number; y: number } {
  const comma = key.indexOf(",");
  return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
}

function cellPatchOf(
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
  afflicted: CellAffliction[] | undefined,
): CellPatch {
  return afflicted ? { x, y, z, stack, afflicted } : { x, y, z, stack };
}

export function handoverCellsJson(
  map: MapFile,
  chunks: Iterable<string>,
  held: ReadonlySet<string>,
  burning: (x: number, y: number, z: number) => CellAffliction[] | undefined,
  burningChunks: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  for (const chunkKey of chunks) {
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const chunk = getChunk(map, z, chunkKey);
      if (!chunk) continue;
      const text = textOf(chunk, z);
      if (text.keys.length === 0) continue;
      const onFire = burningChunks.has(`${z}:${chunkKey}`);
      const bodiesHeld =
        text.bodyCells > 0 && text.stacks.some((stack) => holdsAny(stack.owners, held));
      if (!onFire && !bodiesHeld) {
        text.cellsJoined ??= text.stacks.map(cellTextOf).join(",");
        parts.push(text.cellsJoined);
        continue;
      }
      for (let i = 0; i < text.keys.length; i++) {
        const stack = text.stacks[i]!;
        const { x, y } = cellXY(text.keys[i]!);
        const afflicted = onFire ? burning(x, y, z) : undefined;
        if (!afflicted && !holdsAny(stack.owners, held)) {
          parts.push(cellTextOf(stack));
          continue;
        }
        parts.push(
          JSON.stringify(cellPatchOf(x, y, z, visibleStack(stack.stack, held), afflicted)),
        );
      }
    }
  }
  return parts.join(",");
}

export function mapOfInterestJson(
  map: MapFile,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
): string {
  const levels = new Map<string, string[]>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const present = listChunkKeys(map, z);
    const walk = present.length < chunks.size ? present : [...chunks];
    let parts: string[] | null = null;
    for (const chunkKey of walk) {
      if (!chunks.has(chunkKey)) continue;
      const chunk = getChunk(map, z, chunkKey);
      if (!chunk) continue;
      const text = textOf(chunk, z);
      if (text.keys.length === 0) continue;
      parts ??= [];
      if (text.bodyCells === 0 || !text.stacks.some((stack) => holdsAny(stack.owners, held))) {
        text.entriesJoined ??= text.stacks.map(entryTextOf).join(",");
        parts.push(text.entriesJoined);
        continue;
      }
      for (const stack of text.stacks) {
        parts.push(
          holdsAny(stack.owners, held)
            ? `${JSON.stringify(stack.key)}:${JSON.stringify(visibleStack(stack.stack, held))}`
            : entryTextOf(stack),
        );
      }
    }
    if (parts) levels.set(levelKey(z), parts);
  }
  /**
   * The key order an object built from these keys lists them in (integer keys
   * ascending, then the rest as inserted), which is how `JSON.stringify` writes
   * `mapOfInterest`'s `levels`.
   */
  const order = Object.keys(Object.fromEntries([...levels.keys()].map((key) => [key, 0])));
  const body = order.map((key) => `${JSON.stringify(key)}:{${levels.get(key)!.join(",")}}`);
  return `{"version":${MAP_FILE_VERSION},"levels":{${body.join(",")}}}`;
}

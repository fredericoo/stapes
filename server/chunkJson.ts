import { getChunk, listChunkKeys } from "../app/lib/mapData";
import { visibleStack } from "../app/net/interest";
import type { CellAffliction, CellPatch } from "../app/net/protocol";
import type { ChunkCells, MapFile, PlacedTile } from "../app/lib/types";
import { MAP_FILE_VERSION, MAX_LEVEL, MIN_LEVEL, levelKey } from "../app/lib/types";

/**
 * The board's chunks as JSON, written once per chunk rather than once per
 * client that is handed them.
 *
 * Two messages hand a client whole chunks of ground: the `hello`, whose map is
 * every chunk in reach, and the patch that hands over ground coming into reach
 * as somebody walks. Both used to build every cell of every chunk as an object
 * and serialize it, for every client — a `hello` on the shipped map is about
 * 2.5MB of JSON, and at a thousand players one goes out on every join and
 * every rebirth.
 *
 * **A chunk that is the same object is the same cells**, because the board is
 * copy-on-write (`../app/lib/mapData`'s `setStacks`), so its text is the same
 * text. It is written the first time anybody needs it and kept against the
 * chunk object, and an edit, which replaces the object, is what retires it.
 *
 * **What is kept is the chunk with every body taken out**, which is what
 * almost every client is owed: a client is told about the bodies near it and
 * about no others, and ground being handed over is ground at the far edge of
 * its reach. The cells that do hold a body it has been told about, and cells
 * with a fire in them, are written for that client alone — the same way they
 * always were — and spliced in where they fall.
 *
 * Nothing here decides what anybody is sent; `../app/net/interest` still does.
 * These functions write the same bytes `JSON.stringify` would have written of
 * what `cellsOfChunks` and `mapOfInterest` build, and `chunkJson.test.ts` holds
 * them to it.
 */

/** One chunk of one level, as kept. */
type ChunkText = {
  z: number;
  /** The chunk's cell keys, in the order the chunk holds them. */
  keys: string[];
  /** Whose bodies stand in each cell, or null for a cell with none — which is nearly all. */
  owners: Array<string[] | null>;
  /** Whether any cell has a body in it at all. */
  anyBody: boolean;
  /** Each cell as a handover carries it (`CellPatch`), with every body taken out. */
  cells: string[] | null;
  /** Each cell as a `hello`'s map carries it (`"x,y":[...]`), with every body taken out. */
  entries: string[] | null;
  /** `cells`, joined. */
  cellsJoined: string | null;
  /** `entries`, joined. */
  entriesJoined: string | null;
};

const texts = new WeakMap<ChunkCells, ChunkText>();

/** Nobody, for writing a chunk with every body taken out. */
const NOBODY: ReadonlySet<string> = new Set();

function textOf(chunk: ChunkCells, z: number): ChunkText {
  const kept = texts.get(chunk);
  // A chunk object belongs to one level, but nothing stops two levels sharing
  // one; the level is part of what is written, so it is part of the key.
  if (kept && kept.z === z) return kept;
  const keys: string[] = [];
  const owners: Array<string[] | null> = [];
  let anyBody = false;
  for (const key in chunk) {
    keys.push(key);
    let whose: string[] | null = null;
    for (const placed of chunk[key]!) {
      if (!placed.owner) continue;
      (whose ??= []).push(placed.owner);
    }
    owners.push(whose);
    if (whose) anyBody = true;
  }
  const text: ChunkText = {
    z,
    keys,
    owners,
    anyBody,
    cells: null,
    entries: null,
    cellsJoined: null,
    entriesJoined: null,
  };
  texts.set(chunk, text);
  return text;
}

/** Does this client hold any of the bodies standing in this cell? */
function holdsAny(owners: readonly string[] | null, held: ReadonlySet<string>): boolean {
  if (owners === null || held.size === 0) return false;
  for (const owner of owners) if (held.has(owner)) return true;
  return false;
}

function cellXY(key: string): { x: number; y: number } {
  const comma = key.indexOf(",");
  return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
}

/** A cell as a handover carries it: `cellPatch`'s shape, in its key order. */
function cellPatchOf(
  x: number,
  y: number,
  z: number,
  stack: PlacedTile[],
  afflicted: CellAffliction[] | undefined,
): CellPatch {
  return afflicted ? { x, y, z, stack, afflicted } : { x, y, z, stack };
}

/**
 * The cells of some chunks as a handover patch carries them, on every level,
 * each stripped of the bodies `held` does not name and carrying what is burning
 * in it — the JSON of `cellsOfChunks` passed through the server's `cellPatch`,
 * without the brackets. Empty when the chunks hold nothing.
 *
 * @param burning what is burning in a cell, if anything, by coordinates.
 * @param burningChunks the chunks (`z:chunk`) with anything burning in them at
 *   all, so a chunk with no fire in it is not asked about cell by cell.
 */
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
      text.cells ??= text.keys.map((key, i) => {
        const { x, y } = cellXY(key);
        const stack = chunk[key]!;
        return JSON.stringify(
          cellPatchOf(x, y, z, text.owners[i] ? visibleStack(stack, NOBODY) : stack, undefined),
        );
      });
      const onFire = burningChunks.has(`${z}:${chunkKey}`);
      const bodiesHeld = text.anyBody && text.owners.some((whose) => holdsAny(whose, held));
      if (!onFire && !bodiesHeld) {
        parts.push((text.cellsJoined ??= text.cells.join(",")));
        continue;
      }
      // Written cell by cell, and only the cells that differ from the kept text:
      // one with a body this client holds, or one with a fire in it.
      for (let i = 0; i < text.keys.length; i++) {
        const key = text.keys[i]!;
        const { x, y } = cellXY(key);
        const afflicted = onFire ? burning(x, y, z) : undefined;
        if (!afflicted && !holdsAny(text.owners[i]!, held)) {
          parts.push(text.cells[i]!);
          continue;
        }
        parts.push(
          JSON.stringify(cellPatchOf(x, y, z, visibleStack(chunk[key]!, held), afflicted)),
        );
      }
    }
  }
  return parts.join(",");
}

/**
 * The map a joiner is sent, as JSON: exactly `JSON.stringify` of what
 * `mapOfInterest(map, chunks, held)` builds — the same levels in the same
 * order, the same cells in the same order — written from the kept text of
 * every chunk that has no body `held` names in it.
 */
export function mapOfInterestJson(
  map: MapFile,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
): string {
  const levels = new Map<string, string[]>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    // Whichever list is shorter, walked in the order `mapOfInterest` walks it,
    // which is the order its cells are written in.
    const present = listChunkKeys(map, z);
    const walk = present.length < chunks.size ? present : [...chunks];
    let parts: string[] | null = null;
    for (const chunkKey of walk) {
      if (!chunks.has(chunkKey)) continue;
      const chunk = getChunk(map, z, chunkKey);
      if (!chunk) continue;
      const text = textOf(chunk, z);
      if (text.keys.length === 0) continue;
      text.entries ??= text.keys.map(
        (key, i) =>
          `${JSON.stringify(key)}:${JSON.stringify(
            text.owners[i] ? visibleStack(chunk[key]!, NOBODY) : chunk[key]!,
          )}`,
      );
      parts ??= [];
      if (!text.anyBody || !text.owners.some((whose) => holdsAny(whose, held))) {
        parts.push((text.entriesJoined ??= text.entries.join(",")));
        continue;
      }
      for (let i = 0; i < text.keys.length; i++) {
        const key = text.keys[i]!;
        parts.push(
          holdsAny(text.owners[i]!, held)
            ? `${JSON.stringify(key)}:${JSON.stringify(visibleStack(chunk[key]!, held))}`
            : text.entries[i]!,
        );
      }
    }
    if (parts) levels.set(levelKey(z), parts);
  }
  // The order an object built by inserting these keys would list them in —
  // integer keys ascending, then the rest as inserted — which is the order
  // `JSON.stringify` writes `mapOfInterest`'s `levels` in.
  const order = Object.keys(Object.fromEntries([...levels.keys()].map((key) => [key, 0])));
  const body = order.map((key) => `${JSON.stringify(key)}:{${levels.get(key)!.join(",")}}`);
  return `{"version":${MAP_FILE_VERSION},"levels":{${body.join(",")}}}`;
}

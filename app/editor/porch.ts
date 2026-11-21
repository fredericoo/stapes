import { getStack, type StackEdit } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { mulberry32, placed, type Bounds } from "./generator";

export const PORCH_USES = ["empty", "seating", "smithy", "drill"] as const;

export type PorchUse = (typeof PORCH_USES)[number];

export const PORCH_DEPTH_RANGE = { min: 1, max: 8 } as const;

/**
 * What a smith works at, in the order it is placed. A station the tile
 * catalogue does not hold is left out, which is how `kiln` is listed before
 * its tile is drawn.
 */
export const SMITHY_STATIONS = ["stone-forge", "anvil", "kiln"] as const;

/** A deck against one side of a building, `depth` cells out from its wall and as long as that wall. */
export type PorchSpec = {
  name: string;
  side: Direction;
  depth: number;
  use: PorchUse;
  seed: number;
  floorTileId: string;
  /** What stands along the open edges, with a gap to step through; `null` leaves the deck open. */
  railTileId: string | null;
};

const FLOOR = 0;
const RAIL = 1;
const FURNITURE = 2;

/** The shortest wall whose porch has a rail across both ends as well as along the front. */
const RAILED_ENDS_FROM = 5;
const DUMMY_SPACING = 3;

/** The building's walls once every porch has taken its depth off its side of the plot. */
export function walledBounds(plot: Bounds, porches: readonly PorchSpec[]): Bounds {
  const taken = (side: Direction) =>
    porches.reduce((sum, porch) => (porch.side === side ? sum + porch.depth : sum), 0);
  return {
    minX: plot.minX + taken("w"),
    maxX: plot.maxX - taken("e"),
    minY: plot.minY + taken("n"),
    maxY: plot.maxY - taken("s"),
  };
}

/** A porch's cells: `along` runs the length of the wall and `out` away from it, both from 0. */
type Deck = {
  length: number;
  depth: number;
  kinds: Uint8Array;
  keep: Uint8Array;
  cell(along: number, out: number): { x: number; y: number };
};

function deckOf(walled: Bounds, spec: PorchSpec): Deck {
  const sideways = spec.side === "n" || spec.side === "s";
  const length = sideways ? walled.maxX - walled.minX + 1 : walled.maxY - walled.minY + 1;
  const cell = (along: number, out: number) => {
    if (spec.side === "s") return { x: walled.minX + along, y: walled.maxY + 1 + out };
    if (spec.side === "n") return { x: walled.minX + along, y: walled.minY - 1 - out };
    if (spec.side === "e") return { x: walled.maxX + 1 + out, y: walled.minY + along };
    return { x: walled.minX - 1 - out, y: walled.minY + along };
  };
  return {
    length,
    depth: spec.depth,
    kinds: new Uint8Array(length * spec.depth),
    keep: new Uint8Array(length * spec.depth),
    cell,
  };
}

export function porchBounds(walled: Bounds, spec: PorchSpec): Bounds {
  const deck = deckOf(walled, spec);
  const a = deck.cell(0, 0);
  const b = deck.cell(deck.length - 1, deck.depth - 1);
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

function connected(deck: Deck): boolean {
  const start = deck.kinds.indexOf(FLOOR);
  if (start < 0) return true;
  const seen = new Uint8Array(deck.kinds.length);
  const queue = [start];
  seen[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const along = at % deck.length;
    const next = [at - deck.length, at + deck.length];
    if (along > 0) next.push(at - 1);
    if (along < deck.length - 1) next.push(at + 1);
    for (const n of next) {
      if (n < 0 || n >= deck.kinds.length || seen[n] || deck.kinds[n] !== FLOOR) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return deck.kinds.every((kind, at) => kind !== FLOOR || seen[at] === 1);
}

type Furnisher = {
  deck: Deck;
  side: Direction;
  random: () => number;
  has(id: string): boolean;
  tile(id: string, direction?: Direction): PlacedTile;
  /** Puts a stack on a bare cell unless that cuts some of the deck off from the rest. */
  put(along: number, out: number, stack: PlacedTile[]): boolean;
  /** The longest stretch of bare cells in `row`, as `along` positions in order. */
  run(): number[];
  /**
   * The row furniture stands in. A wall is drawn over the cell north of it
   * and the cell west of it, so on those sides it is the second row out
   * where the porch has one, and the row against the wall on the others.
   */
  row: number;
  /** The row furthest from the wall that is not rail. */
  frontRow: number;
};

/** The world direction of a step along the wall, towards higher `along`. */
function alongDirection(side: Direction): Direction {
  return side === "n" || side === "s" ? "e" : "s";
}

const OPPOSITE: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };

const EXTRAS = ["barrel", "wooden-box"];

const FURNISH: Record<PorchUse, (f: Furnisher) => void> = {
  empty: () => {},
  seating(f) {
    const run = f.run();
    const middle = run[Math.floor(run.length / 2)];
    if (middle === undefined || !f.put(middle, f.row, [f.tile("table")])) return;
    const facing = alongDirection(f.side);
    if (run.includes(middle - 1)) f.put(middle - 1, f.row, [f.tile("stool", facing)]);
    if (run.includes(middle + 1)) f.put(middle + 1, f.row, [f.tile("stool", OPPOSITE[facing])]);
    if (run.length >= RAILED_ENDS_FROM) f.put(run[0]!, f.row, [f.tile("barrel")]);
  },
  smithy(f) {
    const run = f.run();
    const stations = SMITHY_STATIONS.filter((id) => f.has(id));
    stations.forEach((id, i) => {
      if (run[i] !== undefined) f.put(run[i]!, f.row, [f.tile(id, f.side)]);
    });
    for (const along of run.slice(stations.length)) {
      if (f.random() < 0.5) continue;
      f.put(along, f.row, [f.tile(EXTRAS[Math.floor(f.random() * EXTRAS.length)]!)]);
    }
  },
  drill(f) {
    for (let along = 1; along < f.deck.length - 1; along += DUMMY_SPACING) {
      f.put(along, f.frontRow, [f.tile("training-dummy")]);
    }
  },
};

/**
 * Lays one porch against `walled`. `doors` are the door cells in the wall the
 * porch is on. The cells straight out from each stay bare, and the gap in
 * the rail is straight out from the first, so a body walks from the street
 * to that door in a line.
 */
export function planPorch(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  walled: Bounds,
  z: number,
  spec: PorchSpec,
  doors: ReadonlyArray<{ x: number; y: number }>,
): StackEdit[] {
  const deck = deckOf(walled, spec);
  const { length, depth, kinds, keep } = deck;
  const at = (along: number, out: number) => out * length + along;
  const sideways = spec.side === "n" || spec.side === "s";
  const doorways = doors.map((door) => (sideways ? door.x - walled.minX : door.y - walled.minY));
  const clearWay = (along: number) => {
    for (let out = 0; out < depth; out++) keep[at(along, out)] = 1;
  };
  doorways.forEach(clearWay);

  const railed = spec.railTileId !== null && depth >= 2;
  if (railed) {
    const ends = length >= RAILED_ENDS_FROM;
    for (let along = 0; along < length; along++) {
      for (let out = 0; out < depth; out++) {
        if (out === depth - 1 || (ends && (along === 0 || along === length - 1))) {
          kinds[at(along, out)] = RAIL;
        }
      }
    }
    const gap = doorways[0] ?? Math.floor(length / 2);
    kinds[at(gap, depth - 1)] = FLOOR;
    clearWay(gap);
  }

  const frontRow = railed ? depth - 2 : depth - 1;
  const furniture = new Map<number, PlacedTile[]>();
  const bare = (along: number, out: number) =>
    kinds[at(along, out)] === FLOOR && !keep[at(along, out)];
  FURNISH[spec.use]({
    deck,
    side: spec.side,
    random: mulberry32(spec.seed),
    has: (id) => tilesById[id] !== undefined,
    tile: (id, direction) => placed(id, tilesById, direction),
    row: spec.side === "n" || spec.side === "w" ? Math.min(1, frontRow) : 0,
    frontRow,
    put(along, out, stack) {
      if (!bare(along, out)) return false;
      kinds[at(along, out)] = FURNITURE;
      if (!connected(deck)) {
        kinds[at(along, out)] = FLOOR;
        return false;
      }
      furniture.set(at(along, out), stack);
      return true;
    },
    run() {
      let best: number[] = [];
      let run: number[] = [];
      for (let along = 0; along <= length; along++) {
        if (along < length && bare(along, this.row)) {
          run.push(along);
          continue;
        }
        if (run.length > best.length) best = run;
        run = [];
      }
      return best;
    },
  });

  const floor = placed(spec.floorTileId, tilesById);
  const edits: StackEdit[] = [];
  for (let out = 0; out < depth; out++) {
    for (let along = 0; along < length; along++) {
      const { x, y } = deck.cell(along, out);
      const on =
        kinds[at(along, out)] === RAIL
          ? [{ tileId: spec.railTileId! }]
          : (furniture.get(at(along, out)) ?? []);
      const under = getStack(map, x, y, z).map((p) => ({ ...p }));
      edits.push({ x, y, z, stack: [...under, { ...floor }, ...on] });
    }
  }
  return edits;
}

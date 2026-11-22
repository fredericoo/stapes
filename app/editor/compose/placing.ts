import { stackHeight, type StackEdit } from "../../lib/mapData";
import {
  HEIGHT_PER_LEVEL,
  MAX_STACK_HEIGHT,
  coversCells,
  footprintCells,
  footprintOf,
  physicalHeight,
  type Direction,
  type PlacedTile,
  type TileDef,
} from "../../lib/types";
import { hashCell, placed } from "../generator";
import type { BuildContext } from "./build";

type Cell = { x: number; y: number };

export type Refusal = { ok: false; why: "ground" | "level" | "room" | "taken"; at: Cell };

export type PutOptions = {
  z?: number;
  facing?: Direction;
  settings?: Partial<PlacedTile>;
  /** Asked of every cell the tile would cover, with the stack already there. */
  on?: (stack: readonly PlacedTile[], x: number, y: number) => boolean;
};

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SPAN_ID_DIGITS = 8;

function hashOf(text: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  return h;
}

/**
 * A part finds its anchor by offset and then by id, so an id only has to
 * differ between footprints anchored in one cell. It is hashed from the anchor
 * and the tile rather than minted, so the same tree builds the same map.
 */
function spanId(tileId: string, anchor: Cell, z: number): string {
  return hashCell(anchor.x, anchor.y, hashOf(tileId) ^ z)
    .toString(16)
    .padStart(SPAN_ID_DIGITS, "0");
}

/** The cells `tile` covers when its south-east cell is `anchor`, the anchor first. */
export function cellsCovered(
  def: TileDef | undefined,
  anchor: Cell,
  facing?: Direction,
): Array<Cell & { dx: number; dy: number }> {
  return footprintCells(anchor.x, anchor.y, footprintOf(def, facing));
}

/**
 * Collects the edits of one node that stands tiles on what is already there.
 * A tile wider than a cell is placed whole or not at all: the anchor in its
 * south-east cell and a part carrying `span` in each other cell
 * (`docs/terrain.md`). It is refused where any cell has no ground, where the
 * cells are on different levels or of different heights, where it would rise
 * into a next level that holds anything (the rule `fitsInColumn` applies in
 * the game), and where this node already put something.
 */
export function placer(ctx: Pick<BuildContext, "tilesById" | "stackAt" | "raisedAt" | "z">) {
  const edits: StackEdit[] = [];
  const taken = new Set<string>();

  function put(tileId: string, anchor: Cell, opts: PutOptions = {}): { ok: true } | Refusal {
    const def = ctx.tilesById[tileId];
    const z = opts.z ?? ctx.z;
    const cells = cellsCovered(def, anchor, opts.facing);
    const wide = coversCells(footprintOf(def, opts.facing));
    const id = spanId(tileId, anchor, z);
    const stacks: PlacedTile[][] = [];
    let height: number | null = null;
    for (const at of cells) {
      if (taken.has(`${at.x},${at.y}`)) return { ok: false, why: "taken", at };
      const stack = ctx.stackAt(at.x, at.y, z);
      if (stack.length === 0 || (opts.on && !opts.on(stack, at.x, at.y))) {
        return { ok: false, why: "ground", at };
      }
      if (ctx.raisedAt(at.x, at.y) !== ctx.raisedAt(anchor.x, anchor.y)) {
        return { ok: false, why: "level", at };
      }
      const h = stackHeight(stack, ctx.tilesById);
      if (height !== null && h !== height) return { ok: false, why: "level", at };
      height = h;
      const top = h + (def ? physicalHeight(def) : 0);
      if (top > MAX_STACK_HEIGHT) return { ok: false, why: "room", at };
      if (
        top > HEIGHT_PER_LEVEL &&
        (h >= HEIGHT_PER_LEVEL || ctx.stackAt(at.x, at.y, z + 1).length > 0)
      ) {
        return { ok: false, why: "room", at };
      }
      if (wide && stack.some((p) => p.span?.id === id)) return { ok: false, why: "taken", at };
      stacks.push(stack);
    }
    const shape = placed(tileId, ctx.tilesById, opts.facing);
    cells.forEach((at, i) => {
      const tile: PlacedTile =
        at.dx === 0 && at.dy === 0
          ? { ...opts.settings, ...shape, ...(wide ? { span: { id, dx: 0, dy: 0 } } : {}) }
          : { ...shape, span: { id, dx: at.dx, dy: at.dy } };
      taken.add(`${at.x},${at.y}`);
      edits.push({ x: at.x, y: at.y, z, stack: [...stacks[i]!, tile] });
    });
    return { ok: true };
  }

  return { edits, put, taken: (x: number, y: number) => taken.has(`${x},${y}`) };
}

/** The south-east cell of `tile` when its north-west cell is `nw`, which is how a row-by-row scan places it. */
export function anchorFrom(def: TileDef | undefined, nw: Cell, facing?: Direction): Cell {
  const { w, d } = footprintOf(def, facing);
  return { x: nw.x + w - 1, y: nw.y + d - 1 };
}

import type { ChunkCells, Coord, MapFile, PlacedTile, TileDef } from "./types";
import {
  MAP_FILE_VERSION,
  coordKey,
  coversCells,
  footprintCells,
  footprintOf,
  parseCoordKey,
} from "./types";
import {
  changedCellsOnLevel,
  getStack,
  setStacks,
  tileIdsInChunk,
  type StackEdit,
} from "./mapData";
import { canReplaceStack } from "./validation";

/**
 * Tiles that cover more than one cell. See `docs/notes.md`, "A tile can cover
 * more than one cell".
 *
 * A footprint is stored as one placement per cell: the **anchor**, in the
 * south-east cell, and a **part** in every other cell, each carrying the tile
 * and a {@link PlacedTile.span} that points back to the anchor. Everything that
 * reads a cell — height, walkability, light, what a step may enter — therefore
 * sees the bed in it without knowing that beds are wide.
 *
 * What keeps the parts honest is {@link settleSpans}, and it is the only thing
 * that writes a part. It runs over every map a session or the editor commits,
 * and makes whatever happened to one cell of a footprint happen to all of it.
 */

/** Whether this placement is a part — a cell of a footprint other than its anchor. */
export function isSpanPart(placed: PlacedTile): boolean {
  return placed.span != null && (placed.span.dx !== 0 || placed.span.dy !== 0);
}

/**
 * The anchor a placement belongs to: itself for anything that is not a part,
 * and the anchor's own cell and slot for a part. Null for a part whose anchor
 * is not where it says — which {@link settleSpans} removes on its next pass.
 *
 * **Everything that acts on a placement goes through this first.** A part
 * carries the tile but none of the placement's own fields — no inscription, no
 * channel, no contents — so reading a part is reading a bed with the sheets
 * taken off it.
 */
export function spanAnchor<T extends Coord & { stackIndex: number }>(
  map: MapFile,
  ref: T,
): (Coord & { stackIndex: number }) | null {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed || !isSpanPart(placed)) return ref;
  const { id, dx, dy } = placed.span!;
  const at = { x: ref.x + dx, y: ref.y + dy, z: ref.z };
  const stackIndex = getStack(map, at.x, at.y, at.z).findIndex(
    (p) => p.span?.id === id && p.span.dx === 0 && p.span.dy === 0,
  );
  return stackIndex < 0 ? null : { ...at, stackIndex };
}

/**
 * A fresh id for a footprint.
 *
 * It only has to tell apart the footprints anchored in one cell, which is
 * almost always one and at most a handful, so eight hex digits is plenty and
 * keeps `data/map.json` readable.
 */
export function mintSpanId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const spanningByCatalogue = new WeakMap<Record<string, TileDef>, ReadonlySet<string>>();

/** Every tile id in the catalogue that covers more than one cell facing some way. */
export function spanningTileIds(tilesById: Record<string, TileDef>): ReadonlySet<string> {
  const cached = spanningByCatalogue.get(tilesById);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (coversCells(footprintOf(def))) ids.add(def.id);
  }
  spanningByCatalogue.set(tilesById, ids);
  return ids;
}

/** The fields a part copies from its anchor. Everything else stays on the anchor. */
type Shape = Pick<PlacedTile, "tileId" | "direction" | "variant">;

function sameShape(a: Shape, b: Shape): boolean {
  return a.tileId === b.tileId && a.direction === b.direction && a.variant === b.variant;
}

function withShape(placed: PlacedTile, shape: Shape): PlacedTile {
  if (sameShape(placed, shape)) return placed;
  const next: PlacedTile = { ...placed, tileId: shape.tileId };
  if (shape.direction) next.direction = shape.direction;
  else delete next.direction;
  if (shape.variant) next.variant = shape.variant;
  else delete next.variant;
  return next;
}

function partOf(shape: Shape, id: string, dx: number, dy: number): PlacedTile {
  return {
    tileId: shape.tileId,
    ...(shape.direction ? { direction: shape.direction } : {}),
    ...(shape.variant ? { variant: shape.variant } : {}),
    span: { id, dx, dy },
  };
}

function memberIndex(stack: readonly PlacedTile[], id: string): number {
  return stack.findIndex((p) => p.span?.id === id);
}

/** One footprint an edit touched: where its anchor is, and which of its cells changed. */
type Touched = { z: number; x: number; y: number; id: string; changed: Set<string> };

/**
 * Make every footprint an edit touched whole again, and return the map with
 * that done. `prev` is the map before the edit, `next` the map after it.
 *
 * **Whatever happened to one cell of a footprint happens to all of it.**
 *
 * - The anchor was removed, or any part was → every cell of it goes.
 * - The anchor changed tile, facing or variant → every part follows, and the
 *   footprint is re-cut to the new tile's size: a bed that burns into a
 *   one-cell heap of ash leaves one heap.
 * - A part changed → the anchor takes the change, and the rest follow it.
 *   So a fire that burns through the foot of a bed burns the bed.
 * - A placement of a spanning tile with no `span` → it is a new anchor, and
 *   its parts are placed on top of the cells it covers. Nothing that puts a
 *   tile down has to know that some tiles are wide.
 * - A part whose anchor is not there → removed.
 *
 * **A change the whole footprint cannot take is taken back from all of it**,
 * the "refuse rather than force" every swap in the world already follows: a
 * part is checked with `canReplaceStack` in its own cell, and if one of them
 * does not fit the footprint is put back as it was in `prev` — or, for a new
 * one, not placed at all.
 *
 * Cost is proportional to what changed. Chunks are ruled out by
 * {@link tileIdsInChunk} before a cell is compared, and a catalogue with no
 * wide tile in it returns at the first line.
 */
export function settleSpans(
  prev: MapFile,
  next: MapFile,
  tilesById: Record<string, TileDef>,
): MapFile {
  if (prev === next) return next;
  const spanning = spanningTileIds(tilesById);
  if (spanning.size === 0) return next;

  const holdsSpanning = (chunk: ChunkCells | undefined) => {
    if (!chunk) return false;
    const ids = tileIdsInChunk(chunk);
    for (const id of spanning) if (ids.has(id)) return true;
    return false;
  };
  const filter = (a: ChunkCells | undefined, b: ChunkCells | undefined) =>
    holdsSpanning(a) || holdsSpanning(b);

  const levelKeys = new Set<string>();
  for (const zk in next.levels) if (prev.levels[zk] !== next.levels[zk]) levelKeys.add(zk);
  for (const zk in prev.levels) if (prev.levels[zk] !== next.levels[zk]) levelKeys.add(zk);
  if (levelKeys.size === 0) return next;

  const cells: Coord[] = [];
  for (const zk of levelKeys) {
    const z = levelFromKey(zk);
    if (z == null) continue;
    for (const ck of changedCellsOnLevel(prev, next, z, filter)) {
      cells.push({ ...parseCoordKey(ck), z });
    }
  }
  return settleCells(prev, next, cells, tilesById, spanning);
}

/**
 * Settle every footprint in the map, treating the whole of it as new.
 *
 * For a map arriving from somewhere nothing kept consistent — a file, a
 * checkpoint, a catalogue whose footprints were just edited. A sweep, and it
 * belongs only where the world already sweeps: once, at load.
 */
export function settleAllSpans(map: MapFile, tilesById: Record<string, TileDef>): MapFile {
  const spanning = spanningTileIds(tilesById);
  const cells: Coord[] = [];
  for (const zk in map.levels) {
    const z = levelFromKey(zk);
    if (z == null) continue;
    for (const chunk of Object.values(map.levels[zk]!)) {
      for (const ck in chunk) {
        if (chunk[ck]!.some((p) => p.span || spanning.has(p.tileId))) {
          cells.push({ ...parseCoordKey(ck), z });
        }
      }
    }
  }
  if (cells.length === 0) return map;
  // Against an empty board: every footprint is new, so each is re-derived from
  // its anchor and nothing is taken to have been removed.
  return settleCells(EMPTY, map, cells, tilesById, spanning);
}

const EMPTY: MapFile = { version: MAP_FILE_VERSION, levels: {} };

/** A level key back to its level. Keys are `String(z)`; see `./types`' `levelKey`. */
function levelFromKey(zk: string): number | null {
  const z = Number(zk);
  return Number.isInteger(z) ? z : null;
}

function settleCells(
  prev: MapFile,
  next: MapFile,
  cells: readonly Coord[],
  tilesById: Record<string, TileDef>,
  spanning: ReadonlySet<string>,
): MapFile {
  let map = next;
  const touched = new Map<string, Touched>();
  const touch = (z: number, cellX: number, cellY: number, placed: PlacedTile) => {
    const { id, dx, dy } = placed.span!;
    const x = cellX + dx;
    const y = cellY + dy;
    const key = `${z}|${x},${y}|${id}`;
    let t = touched.get(key);
    if (!t) {
      t = { z, x, y, id, changed: new Set() };
      touched.set(key, t);
    }
    t.changed.add(coordKey(cellX, cellY));
  };

  for (const { x, y, z } of cells) {
    // A spanning tile put down without a span is a new anchor, and gets one.
    const stack = getStack(map, x, y, z);
    if (stack.some((p) => !p.span && spanning.has(p.tileId))) {
      const minted = stack.map((p) =>
        !p.span && spanning.has(p.tileId) ? { ...p, span: { id: mintSpanId(), dx: 0, dy: 0 } } : p,
      );
      map = setStacks(map, [{ x, y, z, stack: minted }]);
    }
    for (const placed of getStack(prev, x, y, z)) if (placed.span) touch(z, x, y, placed);
    for (const placed of getStack(map, x, y, z)) if (placed.span) touch(z, x, y, placed);
  }

  for (const t of touched.values()) map = settleOne(prev, map, t, tilesById);
  return map;
}

function settleOne(
  prev: MapFile,
  map: MapFile,
  t: Touched,
  tilesById: Record<string, TileDef>,
): MapFile {
  const { x, y, z, id } = t;
  const anchorKey = coordKey(x, y);
  const prevStack = getStack(prev, x, y, z);
  const prevIndex = memberIndex(prevStack, id);
  const prevAnchor = prevIndex >= 0 ? prevStack[prevIndex] : undefined;
  const nextStack = getStack(map, x, y, z);
  const nextIndex = memberIndex(nextStack, id);
  const nextAnchor = nextIndex >= 0 ? nextStack[nextIndex] : undefined;

  let removed = !nextAnchor;
  let leader: Shape | undefined;
  if (
    !removed &&
    t.changed.has(anchorKey) &&
    (!prevAnchor || !sameShape(prevAnchor, nextAnchor!))
  ) {
    leader = nextAnchor;
  }
  if (!removed && !leader) {
    for (const ck of t.changed) {
      if (ck === anchorKey) continue;
      const c = parseCoordKey(ck);
      const before = getStack(prev, c.x, c.y, z).find((p) => p.span?.id === id);
      const after = getStack(map, c.x, c.y, z).find((p) => p.span?.id === id);
      if (before && !after) {
        removed = true;
        break;
      }
      if (before && after && !sameShape(before, after)) leader ??= after;
    }
  }

  // Every cell the footprint covered or covers, plus any cell a stray member of
  // it turned up in.
  const region = new Map<string, { x: number; y: number }>();
  const addRegion = (shape: Shape | undefined) => {
    if (!shape) return;
    const fp = footprintOf(tilesById[shape.tileId], shape.direction);
    for (const c of footprintCells(x, y, fp)) region.set(coordKey(c.x, c.y), c);
  };
  addRegion(prevAnchor);
  addRegion(nextAnchor);
  for (const ck of t.changed) region.set(ck, parseCoordKey(ck));

  const without = (cx: number, cy: number) =>
    getStack(map, cx, cy, z).filter((p) => p.span?.id !== id);

  if (removed) {
    const edits: StackEdit[] = [];
    for (const c of region.values()) {
      const stack = getStack(map, c.x, c.y, z);
      if (memberIndex(stack, id) >= 0) edits.push({ ...c, z, stack: without(c.x, c.y) });
    }
    return setStacks(map, edits);
  }

  const shape: Shape = leader ?? nextAnchor!;
  const fp = footprintOf(tilesById[shape.tileId], shape.direction);
  addRegion(shape);
  const covered = new Set(footprintCells(x, y, fp).map((c) => coordKey(c.x, c.y)));
  const wide = covered.size > 1;

  const edits: StackEdit[] = [];
  const checks: StackEdit[] = [];
  for (const c of region.values()) {
    const key = coordKey(c.x, c.y);
    const stack = getStack(map, c.x, c.y, z);
    const at = memberIndex(stack, id);
    let desired: PlacedTile | undefined;
    if (key === anchorKey) {
      const anchored = withShape(nextAnchor!, shape);
      if (wide) {
        desired =
          anchored.span?.dx === 0 && anchored.span.dy === 0
            ? anchored
            : { ...anchored, span: { id, dx: 0, dy: 0 } };
      } else {
        const { span: _span, ...rest } = anchored;
        desired = rest;
      }
    } else if (wide && covered.has(key)) {
      const dx = x - c.x;
      const dy = y - c.y;
      const existing = at >= 0 ? stack[at] : undefined;
      desired =
        existing &&
        sameShape(existing, shape) &&
        existing.span!.dx === dx &&
        existing.span!.dy === dy
          ? existing
          : partOf(shape, id, dx, dy);
    }

    if (desired === (at >= 0 ? stack[at] : undefined)) continue;
    let nextCell: PlacedTile[];
    if (at >= 0) {
      nextCell = [...stack];
      if (desired) nextCell[at] = desired;
      else nextCell.splice(at, 1);
    } else {
      nextCell = [...stack, desired!];
    }
    const edit = { x: c.x, y: c.y, z, stack: nextCell };
    edits.push(edit);
    if (desired && key !== anchorKey) checks.push(edit);
  }
  if (edits.length === 0) return map;

  const fits = checks.every((e) => canReplaceStack(map, e.x, e.y, e.z, e.stack, tilesById).ok);
  if (fits) return setStacks(map, edits);
  return revert(prev, map, t, region, tilesById);
}

/**
 * Put a footprint back as it was in `prev`, in every cell it reaches — or take
 * it off the board entirely when it did not exist there.
 */
function revert(
  prev: MapFile,
  map: MapFile,
  t: Touched,
  region: Map<string, { x: number; y: number }>,
  tilesById: Record<string, TileDef>,
): MapFile {
  const { z, id } = t;
  const prevStack = getStack(prev, t.x, t.y, z);
  const existed = memberIndex(prevStack, id) >= 0;
  const prevAnchor = existed ? prevStack[memberIndex(prevStack, id)] : undefined;
  if (prevAnchor) {
    const fp = footprintOf(tilesById[prevAnchor.tileId], prevAnchor.direction);
    for (const c of footprintCells(t.x, t.y, fp)) region.set(coordKey(c.x, c.y), c);
  }
  const edits: StackEdit[] = [];
  for (const c of region.values()) {
    const current = getStack(map, c.x, c.y, z);
    const stack = current.filter((p) => p.span?.id !== id);
    if (existed) {
      const before = getStack(prev, c.x, c.y, z);
      const i = memberIndex(before, id);
      if (i >= 0) stack.splice(Math.min(i, stack.length), 0, before[i]!);
    }
    if (stack.length !== current.length || stack.some((p, i) => p !== current[i])) {
      edits.push({ ...c, z, stack });
    }
  }
  return setStacks(map, edits);
}

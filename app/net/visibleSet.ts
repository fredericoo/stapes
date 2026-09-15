/**
 * PROTOTYPE — not wired into any shipped path. See `scripts/bench-occlusion.ts`.
 *
 * What a body can actually see, as the shape a subscription could take.
 *
 * Today a client is sent a square of chunk columns around it
 * (`./interest.ts`), every level, whether or not it could ever look at any of
 * it. That square is 176 cells across against a 23-cell view, it does not care
 * that you are standing in a sealed room, and it hands you the whole cave
 * system under your feet. The idea being tested here is the other shape: send
 * what the body can see, and let going down a hole be the thing that starts
 * streaming the hole.
 *
 * ## Two questions, two answers
 *
 * - {@link visibleFrom} is line of sight from this body's eye. This is what a
 *   *body* is scoped by: you hear about a wolf's hit points when you can see
 *   the wolf.
 * - {@link nearVisible} is that set with slack around it, and it is what
 *   *ground* is scoped by. The margin is not politeness: the renderer builds
 *   geometry past the camera, the light bake reads an apron past what it bakes,
 *   and a set cut exactly at what you can see would pop a wall into existence
 *   on the frame you round the corner.
 *
 * It is a predicate rather than a second set on purpose. Materialising the
 * dilation means a cube per visible cell — at a few thousand visible cells and
 * a margin of six that is millions of inserts, every time somebody takes a step.
 * Asked the other way round it is one cube per *question*, and the questions are
 * the handful of cells that changed on a tick.
 *
 * ## The sight rules are duplicated here, and that is a prototype debt
 *
 * `app/game/sight.ts` is the real statement of what blocks a look, and it reads
 * the map through `getStack`. That is three string builds and three hash
 * lookups per cell, which is fine for the handful of rays a brain casts and
 * hopeless for a flood over tens of thousands of cells — the first cut of this
 * spent 43 of its 59 milliseconds there. So the same rules are restated against
 * {@link SightField}'s flat arrays. **If this graduates, one of the two has to
 * go**: either `sight.ts` moves onto a field of its own, or this calls it.
 *
 * ## Why the boundary might be light-tight, which the chunk square never was
 *
 * The reason a chunk subscription has to be 79 cells wide is that a cell the
 * client has not been sent reads as open air to its own sky flood, so a
 * boundary in the middle of a room seeds daylight inward. An occlusion boundary
 * may not have that problem, and it would not be luck: **sight is light here.**
 * `sight.ts` stops a look on exactly what `stackOcclusion` says stops light, so
 * the cells that bound this flood are the cells that would have bounded the
 * daylight. What is left is the *radius* edge — open ground fading out at
 * maximum range — and that is outdoors, where daylight is the right answer.
 *
 * That argument is the main thing this prototype exists to test.
 */
import { SightField } from "./sightField";
import { getStack } from "../lib/mapData";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  type Coord,
  type FlatMapFile,
  type MapFile,
  type TileDef,
} from "../lib/types";

/**
 * How far a body's subscription reaches laterally, in cells.
 *
 * Against 79 for the chunk square. The old number is derived from what the
 * *client's* light cache reads — half the view, the level span,
 * `LIGHT_WINDOW_MARGIN`, `LIGHT_CHUNK_SIZE`, `LIGHT_APRON` — and most of it is
 * that cache's world-aligned 32-cell chunking rather than anything about
 * seeing.
 *
 * Swept at 16, 24 and 32 by `scripts/bench-occlusion.ts`, and 16 is where it
 * belongs: it costs a third of what 32 does and hands over almost exactly the
 * same ground. That is not a lucky cut, it is the point of the whole idea —
 * what you can see is bounded by walls and floors, not by the radius, so on the
 * den floor the radius never binds at all and the join is the same 1,218 cells
 * at every setting.
 */
export const SIGHT_REACH_CELLS = 16;

/**
 * How many storeys down it reaches, and how many up.
 *
 * Asymmetric because the two directions cost differently. Downward is holes and
 * caves, and the flood only goes that way where a floor is actually open.
 * Upward, outdoors, is sky: every cell of the disc would flood straight up
 * through open air to the cap, for nothing at all to look at.
 */
export const SIGHT_REACH_DOWN = 4;
export const SIGHT_REACH_UP = 1;

/** Cells of slack around what can be seen, for geometry and the light apron. */
export const GROUND_MARGIN = 6;

/** `x,y,z` — the key everything here is a set of. */
export function cellKey3(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function parseCellKey3(key: string): Coord {
  const parts = key.split(",");
  return { x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) };
}

export type VisibleSet = {
  /** Cells with something in them that this body can see. Scopes bodies. */
  visible: Set<string>;
  /** Cells the field had to read — the fill cost. */
  filled: number;
  /** Cells the flood walked through. Most of them are air. */
  flooded: number;
  /** Cells the ray was actually asked about. */
  probed: number;
  /** Milliseconds in each pass, so the bench can say which one to fix. */
  fillMs: number;
  floodMs: number;
  rayMs: number;
};

/** The eight lateral neighbours, as offsets. */
const LATERAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * What this body can see from where it is standing.
 *
 * Three passes. The field is read once; the flood bounds the question; the ray
 * decides it.
 *
 * **The flood walks the box.** Open air blocks nothing, so outdoors this really
 * does visit most of the cells in reach — the cost tracks the *radius*, not
 * what there is to see, and the first cut's doc comment claiming otherwise was
 * wrong. Against flat arrays that is affordable; it is also the reason the real
 * version of this wants shadowcasting, which is O(cells in view) and needs no
 * ray at all.
 *
 * **Only cells with something in them are probed or subscribed.** The flood
 * walks through air, because that is what looking across a room is, but air is
 * nothing to send and nothing to draw.
 *
 * **The ray decides.** A flood alone sees around corners: it reaches the cell
 * behind a pillar by walking around the pillar.
 */
export function visibleFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  reach: number = SIGHT_REACH_CELLS,
  eyeHeight: number = HEIGHT_PER_LEVEL,
): VisibleSet {
  const fillStart = performance.now();
  const minZ = Math.max(MIN_LEVEL, from.z - SIGHT_REACH_DOWN);
  const maxZ = Math.min(MAX_LEVEL, from.z + SIGHT_REACH_UP);
  const side = reach * 2 + 1;
  const field = new SightField(
    map,
    tilesById,
    from.x - reach,
    from.y - reach,
    minZ,
    side,
    side,
    maxZ - minZ + 1,
  );

  const floodStart = performance.now();
  const self = field.at(from.x, from.y, from.z);
  const eyeAt = from.z * HEIGHT_PER_LEVEL + (self < 0 ? 0 : field.blockH[self]!) + eyeHeight;

  const seen = new Uint8Array(field.w * field.h * field.d);
  // Indices rather than coordinates: the flood never leaves the box, so the
  // index *is* the cell, and the coordinates are recovered once at the end for
  // the handful of cells that turn out to be worth probing.
  const queue: number[] = [];
  const candidates: number[] = [];
  if (self >= 0) {
    seen[self] = 1;
    queue.push(self);
  }

  const plane = field.w * field.h;
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (field.present[at]) candidates.push(at);

    // The blocker itself is a candidate — you can see the face of the wall —
    // but nothing is expanded through it.
    if (at !== self) {
      const blockH = field.blockH[at]!;
      const z = field.z0 + Math.floor(at / plane);
      if (blockH > 0 && z * HEIGHT_PER_LEVEL + blockH >= eyeAt) continue;
    }

    const iz = Math.floor(at / plane);
    const rest = at - iz * plane;
    const iy = Math.floor(rest / field.w);
    const ix = rest - iy * field.w;

    for (const [dx, dy] of LATERAL) {
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= field.w || ny >= field.h) continue;
      const next = (iz * field.h + ny) * field.w + nx;
      if (seen[next]) continue;
      seen[next] = 1;
      queue.push(next);
    }

    // Down through a hole and up through an opening. `sealed` is asked of the
    // ground at the *upper* of the two levels, which is the floor between them.
    if (iz > 0 && !field.sealed[at]) {
      const below = at - plane;
      if (!seen[below]) {
        seen[below] = 1;
        queue.push(below);
      }
    }
    if (iz + 1 < field.d) {
      const above = at + plane;
      if (!field.sealed[above] && !seen[above]) {
        seen[above] = 1;
        queue.push(above);
      }
    }
  }

  const rayStart = performance.now();
  const visible = new Set<string>();
  for (const at of candidates) {
    const iz = Math.floor(at / plane);
    const rest = at - iz * plane;
    const iy = Math.floor(rest / field.w);
    const ix = rest - iy * field.w;
    const x = field.x0 + ix;
    const y = field.y0 + iy;
    const z = field.z0 + iz;
    if (lineOfSight(field, from, x, y, z, eyeAt)) visible.add(cellKey3(x, y, z));
  }

  return {
    visible,
    filled: field.filled,
    flooded: candidates.length + countSeen(seen),
    probed: candidates.length,
    fillMs: floodStart - fillStart,
    floodMs: rayStart - floodStart,
    rayMs: performance.now() - rayStart,
  };
}

function countSeen(seen: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < seen.length; i++) n += seen[i]!;
  return n;
}

/**
 * `hasLineOfSight` against the field — the same walk, the same two ways to be
 * blocked, without the string keys. See the prototype-debt note at the top.
 */
function lineOfSight(
  field: SightField,
  from: Coord,
  toX: number,
  toY: number,
  toZ: number,
  eyeAt: number,
): boolean {
  const dx = toX - from.x;
  const dy = toY - from.y;
  const dz = toZ - from.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return true;

  let prevX = from.x;
  let prevY = from.y;
  let prevZ = from.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(from.x + dx * t);
    const y = Math.round(from.y + dy * t);
    const z = Math.round(from.z + dz * t);

    if (z !== prevZ) {
      const lowerX = z < prevZ ? x : prevX;
      const lowerY = z < prevZ ? y : prevY;
      const seal = field.at(lowerX, lowerY, Math.max(z, prevZ));
      if (seal >= 0 && field.sealed[seal]) return false;
    }
    prevX = x;
    prevY = y;
    prevZ = z;

    if (i < steps) {
      const at = field.at(x, y, z);
      if (at >= 0) {
        const blockH = field.blockH[at]!;
        if (blockH > 0 && z * HEIGHT_PER_LEVEL + blockH >= eyeAt) return false;
      }
    }
  }
  return true;
}

/**
 * Is anything within `by` of this cell visible?
 *
 * The ground predicate — see the note at the top of this file for why it is a
 * predicate and not a set. Lateral slack is the full margin; vertical slack is
 * one storey, because a level is drawn one cell up-left of the one below and a
 * margin measured in storeys would be a margin measured in whole rooms.
 */
export function nearVisible(
  visible: ReadonlySet<string>,
  x: number,
  y: number,
  z: number,
  by: number = GROUND_MARGIN,
): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -by; dy <= by; dy++) {
      for (let dx = -by; dx <= by; dx++) {
        if (visible.has(cellKey3(x + dx, y + dy, z + dz))) return true;
      }
    }
  }
  return false;
}

/**
 * The ground to hand over for a visible set — what {@link nearVisible} would
 * say yes to, enumerated.
 *
 * Only wanted once per join, which is why the expensive direction is allowed
 * here.
 */
export function groundFor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  visible: ReadonlySet<string>,
  by: number = GROUND_MARGIN,
): Set<string> {
  const out = new Set<string>();
  if (visible.size === 0) return out;

  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const key of visible) {
    const at = parseCellKey3(key);
    x0 = Math.min(x0, at.x);
    y0 = Math.min(y0, at.y);
    z0 = Math.min(z0, at.z);
    x1 = Math.max(x1, at.x);
    y1 = Math.max(y1, at.y);
    z1 = Math.max(z1, at.z);
  }
  const field = new SightField(
    map,
    tilesById,
    x0 - by,
    y0 - by,
    Math.max(MIN_LEVEL, z0 - 1),
    x1 - x0 + by * 2 + 1,
    y1 - y0 + by * 2 + 1,
    Math.min(MAX_LEVEL, z1 + 1) - Math.max(MIN_LEVEL, z0 - 1) + 1,
  );

  for (const key of visible) {
    const at = parseCellKey3(key);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -by; dy <= by; dy++) {
        for (let dx = -by; dx <= by; dx++) {
          const x = at.x + dx;
          const y = at.y + dy;
          const z = at.z + dz;
          const idx = field.at(x, y, z);
          if (idx < 0 || !field.present[idx]) continue;
          out.add(cellKey3(x, y, z));
        }
      }
    }
  }
  return out;
}

/**
 * PROTOTYPE — the whole subscription for one body, both halves, one field.
 *
 * `visibleFrom` and `groundFor` each build a {@link SightField}, and building it
 * is the single most expensive thing either of them does. The server wants both
 * answers about the same body at the same instant, so it gets them off one read
 * of the map.
 *
 * The field is grown by {@link GROUND_MARGIN} past the sight reach, because the
 * ground answer dilates past the visible one and a cell outside the field reads
 * as absent — which would put a ragged hole in the margin exactly where the
 * margin exists to prevent one.
 */
export function subscriptionFor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  reach: number = SIGHT_REACH_CELLS,
  margin: number = GROUND_MARGIN,
): { visible: Set<string>; ground: Set<string>; ms: number } {
  const started = performance.now();
  const { visible } = visibleFrom(map, tilesById, from, reach);
  const ground = groundFor(map, tilesById, visible, margin);
  // The body's own cell and the ones it might step or fall into are ground
  // whether or not it can see them: a client that has not been sent the floor
  // under its own feet has nowhere to land.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        ground.add(cellKey3(from.x + dx, from.y + dy, from.z + dz));
      }
    }
  }
  return { visible, ground, ms: performance.now() - started };
}

/** PROTOTYPE — the cells of a subscription, as the map a joiner is sent. */
export function mapOfCells(
  map: MapFile,
  cells: ReadonlySet<string>,
): FlatMapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const key of cells) {
    const at = parseCellKey3(key);
    const stack = getStack(map, at.x, at.y, at.z);
    if (stack.length === 0) continue;
    (levels[levelKey(at.z)] ??= {})[coordKey(at.x, at.y)] = stack;
  }
  return { version: 1, levels };
}

/**
 * PROTOTYPE — is the occlusion-shaped subscription switched on?
 *
 * On by default *on this branch*, because the branch exists to be played: a
 * preview deployment nobody can tell apart from `main` proves nothing.
 * `STAPES_OCCLUSION=0` puts the chunk square back, which is what makes an A/B
 * on one deployment possible.
 *
 * Read once. It decides which of two subscription machines the server runs, and
 * a value that changed under a running world would leave half the clients on
 * each.
 */
export const OCCLUSION_SUBSCRIPTIONS =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.STAPES_OCCLUSION !== "0";

import { getStack } from "./mapData";
import {
  type CellOcclusion,
  rayTransmission,
  stackOcclusion,
} from "./lighting";
import type { MapFile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
} from "./types";

/** Euclidean cell radius around the view anchor for roof-hide checks. */
export const VIEW_RADIUS = 2.5;

const TRANSMISSION_EPSILON = 1e-3;

export type ViewAnchor = { x: number; y: number; z: number };

/** Minimal actor shape — satisfied by ActorSnapshot. */
export type ViewAnchorActor = {
  x: number;
  y: number;
  z: number;
  walk: { to: { x: number; y: number; z: number } } | null;
  fall: { landingAbs: number } | null;
};

function cellKey(x: number, y: number, z: number): string {
  return `${z}:${coordKey(x, y)}`;
}

/** Map level for feet at absolute elevation — matches game/gravity cellForFeetAbs. */
function levelForFeetAbs(feetAbs: number): number {
  let z = Math.floor(feetAbs / HEIGHT_PER_LEVEL);
  if (z < MIN_LEVEL) z = MIN_LEVEL;
  if (z > MAX_LEVEL) z = MAX_LEVEL;
  return z;
}

/**
 * Where level-visibility is evaluated from: walk destination while walking,
 * landing level while falling, otherwise the committed cell.
 *
 * Takes one actor rather than the whole snapshot, and deliberately stays
 * single-anchor with many actors on the board: the roof-cut is an affordance
 * for whoever is looking, so it follows the viewer's own actor. Two players on
 * different floors cannot both get a correct cut — visibility is one boolean
 * per level group for the whole scene.
 */
export function viewAnchorFor(actor: ViewAnchorActor): ViewAnchor {
  if (actor.walk) {
    return { x: actor.walk.to.x, y: actor.walk.to.y, z: actor.walk.to.z };
  }
  if (actor.fall) {
    return {
      x: actor.x,
      y: actor.y,
      z: levelForFeetAbs(actor.fall.landingAbs),
    };
  }
  return { x: actor.x, y: actor.y, z: actor.z };
}

/**
 * Same occlusion model as lighting: light-passing tiles are ignored, height
 * maps to opacity, full walls seal the ray.
 */
/**
 * Occluders the roof-cut probe can consult: the anchor's own level, within
 * `span` cells of it.
 *
 * That is the whole reachable set — {@link hideRayClear} rays on a single level
 * between two points inside the radius, so the walk cannot leave the box. This
 * runs every frame, and sweeping the world to look at a handful of cells around
 * the player put the map's size into the frame budget.
 */
function buildOcclusion(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  span: number,
): Map<string, CellOcclusion> {
  const occlusion = new Map<string, CellOcclusion>();
  if (!map.levels[levelKey(view.z)]) return occlusion;

  for (let y = view.y - span; y <= view.y + span; y++) {
    for (let x = view.x - span; x <= view.x + span; x++) {
      const stack = getStack(map, x, y, view.z);
      if (!stack.length) continue;
      const occ = stackOcclusion(stack, tilesById);
      if (occ.opacity > 0 || occ.sealsLevel) {
        occlusion.set(cellKey(x, y, view.z), occ);
      }
    }
  }
  return occlusion;
}

/** Levels above `viewZ` at (x, y) that hold anything, nearest first. */
function contentAbove(
  map: MapFile,
  x: number,
  y: number,
  viewZ: number,
  into: number[],
): number[] {
  into.length = 0;
  for (let z = viewZ + 1; z <= MAX_LEVEL; z++) {
    if (getStack(map, x, y, z).length > 0) into.push(z);
  }
  return into;
}

/**
 * Same-floor LOS for roof-hide, matching light: intermediate cells attenuate
 * by opacity, and a fully opaque destination (solid wall) blocks looking into
 * that cell. Light-passing tiles (windows) stay see-through.
 */
function hideRayClear(
  x0: number,
  y0: number,
  z: number,
  x1: number,
  y1: number,
  occlusion: Map<string, CellOcclusion>,
): boolean {
  if (x0 === x1 && y0 === y1) return true;

  const transmission = rayTransmission(x0, y0, z, x1, y1, z, occlusion);
  if (transmission < TRANSMISSION_EPSILON) return false;

  // rayTransmission skips the destination; a solid wall on the probe cell
  // still means you cannot look through it into content above.
  const dest = occlusion.get(cellKey(x1, y1, z));
  if (dest && dest.opacity >= 1 - TRANSMISSION_EPSILON) return false;

  return true;
}

/**
 * Most cells one roof-cut may hide before it stops being a *structure*.
 *
 * The fill exists to separate one building from the next, and a building is
 * tens of cells. A fill that runs past this is not walking a roof — it is
 * walking terrain: the level above a cliff you are standing under is a whole
 * hillside, connected to itself for hundreds of cells, and there is no smaller
 * thing there to cut.
 *
 * Past the budget the cut degrades to the whole storey (`cells: null`) rather
 * than to whatever the fill had reached, and that is the important half. A
 * truncated fill would hide *part* of the hillside — a hard edge across
 * continuous ground, moving as you walk. Hiding all of it is what this did
 * before per-structure cuts existed, so the worst case is the old behaviour and
 * not a new artefact.
 */
export const MAX_CUT_CELLS = 4096;

/**
 * The geometry the view has cut away, and the level it was cut for.
 *
 * `cells` is per level so the renderer can ask a level for its own cut without
 * walking the rest, and `null` means *every* level above `floor` — the
 * whole-storey cut, kept for the case the fill refuses (see
 * {@link MAX_CUT_CELLS}).
 */
export type RoofCut = {
  /** The viewer's own level. Nothing at or below it is ever cut. */
  readonly floor: number;
  /** Cut cells by level, each keyed by {@link coordKey}; null cuts everything. */
  readonly cells: ReadonlyMap<number, ReadonlySet<string>> | null;
};

/** Is this cell one the view has cut away? The only question a cut answers. */
export function cutHides(
  cut: RoofCut | undefined,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!cut || z <= cut.floor) return false;
  if (cut.cells === null) return true;
  return cut.cells.get(z)?.has(coordKey(x, y)) === true;
}

/** Levels this cut takes away in their entirety, so a caller can skip drawing them. */
export function cutHidesWholeLevel(
  cut: RoofCut | undefined,
  z: number,
): boolean {
  return cut !== undefined && cut.cells === null && z > cut.floor;
}

/**
 * Cells above the view that the viewer has same-floor line of sight to.
 *
 * The seeds of the cut, and the whole of what used to be
 * `levelsAboveShouldHide`: this is the same probe, reporting *what* it found
 * instead of merely that it found something.
 *
 * Every content cell in a reachable column is a seed, not just the lowest.
 * What stands between you and the sky in a doorway may be a roof at one level
 * and a walkway three levels up with a gap between them, and both are drawn
 * over the room you are trying to look into. Taking only the nearest would
 * leave the walkway in place across the cut.
 */
function cutSeeds(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius: number,
): Array<{ x: number; y: number; z: number }> {
  const r2 = radius * radius;
  const span = Math.ceil(radius);
  const occlusion = buildOcclusion(map, tilesById, view, span);
  const seeds: Array<{ x: number; y: number; z: number }> = [];
  const levels: number[] = [];

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > r2) continue;

      const x = view.x + dx;
      const y = view.y + dy;
      // Before the ray, because it is a column of cell lookups and the ray is a
      // walk — the overwhelming majority of cells in the radius have open sky
      // and never need one.
      if (contentAbove(map, x, y, view.z, levels).length === 0) continue;
      if (!hideRayClear(view.x, view.y, view.z, x, y, occlusion)) continue;

      for (const z of levels) seeds.push({ x, y, z });
    }
  }
  return seeds;
}

/**
 * Every cell reachable from `seeds` through touching geometry above `floor`.
 *
 * **26-way, and deliberately the most generous adjacency there is.** The two
 * ways to be wrong are not symmetric. Merging two structures that only touch
 * at a corner costs one extra roof lifting with yours — which is what happened
 * on every roof in town until now, so nobody will notice one. *Splitting* a
 * structure costs half a roof drawn and half cut, a hard diagonal edge through
 * a building, and it is the artefact a 4-way fill produces the first time
 * somebody authors a roof that steps diagonally. Include the level above and
 * below in the same neighbourhood, or a two-storey house whose upper floor sits
 * one cell in from its roof cuts as two things.
 *
 * The fill is bounded by the structure, never by the map: it starts at cells the
 * probe already found and only ever steps onto occupied ones, so a lone shed
 * costs a shed's worth of lookups whatever the world is doing elsewhere.
 */
function fillStructure(
  map: MapFile,
  floor: number,
  seeds: ReadonlyArray<{ x: number; y: number; z: number }>,
): Map<number, Set<string>> | null {
  const byLevel = new Map<number, Set<string>>();
  const queue = [...seeds];
  let size = 0;

  const claim = (x: number, y: number, z: number): boolean => {
    let level = byLevel.get(z);
    if (!level) {
      level = new Set();
      byLevel.set(z, level);
    }
    const key = coordKey(x, y);
    if (level.has(key)) return false;
    level.add(key);
    size++;
    return true;
  };

  for (const seed of seeds) claim(seed.x, seed.y, seed.z);

  // Index rather than shift: a shift off the front of a several-hundred entry
  // array is a copy of the rest of it, once per cell.
  for (let head = 0; head < queue.length; head++) {
    if (size > MAX_CUT_CELLS) return null;
    const cell = queue[head]!;
    for (let dz = -1; dz <= 1; dz++) {
      const z = cell.z + dz;
      if (z <= floor || z > MAX_LEVEL) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const x = cell.x + dx;
          const y = cell.y + dy;
          if (getStack(map, x, y, z).length === 0) continue;
          if (!claim(x, y, z)) continue;
          queue.push({ x, y, z });
        }
      }
    }
  }

  return byLevel;
}

/**
 * What the view cuts away from where the player is standing, or undefined when
 * it cuts nothing.
 *
 * **The cut is the structure you can see into, not the storey it is on.** Seeing
 * inside one house used to lift the roof off every house on the street, because
 * the answer was a single level threshold for the whole scene. What a player
 * reads into that is a claim about the town — every building is open — when the
 * only thing that happened is that they opened a door.
 *
 * So the probe's answer is turned into geometry: the cells it can see above the
 * viewer seed a flood fill through whatever touches them, and that component is
 * the cut. The house you are in lifts its roof; the one across the road keeps
 * its own.
 *
 * **Recomputed from the map rather than indexed off it, and that is on
 * purpose.** A structure index built when the world loads would have to be
 * invalidated by every wall a player places, every roof authored in the editor
 * and every tile decay — and would still be answering a question that changes
 * whenever the viewer takes a step, since which component counts depends on
 * where they are standing. The fill is proportional to one building, so
 * recomputing it when the map or the anchor changes is cheaper than maintaining
 * the index would be, and it cannot go stale. Callers should cache on those two
 * identities (see `GameRenderer.roofCutFor`), not on a clock.
 */
export function roofCutFor(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  view: ViewAnchor,
  radius = VIEW_RADIUS,
): RoofCut | undefined {
  const seeds = cutSeeds(map, tilesById, view, radius);
  if (seeds.length === 0) return undefined;
  return { floor: view.z, cells: fillStructure(map, view.z, seeds) };
}

/**
 * The house generator: a rectangle plus a settings object, turned into the
 * stack edits that build a house.
 *
 * Pure, and deliberately separate from the tool that drives it — the same plan
 * is what the drag preview ghosts and what the commit writes, so the two cannot
 * describe different houses. It is also the whole of the fit test: a plan that
 * cannot be built comes back as a refusal with a reason, and nothing is written.
 *
 * The grammar it copies is the one the two example buildings in `data/map.json`
 * define — the cottage at (12,3) and the shop at (7,-8). See docs/notes.md,
 * "A house is a rectangle, a stack grammar and a roof that steps inward".
 */

import {
  getStack,
  isPlayerBody,
  setStacks,
  stackHeight,
  type StackEdit,
} from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  isDirectional,
  physicalHeight,
  resolveActor,
} from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  MAX_FOOTPRINT,
  type Bounds,
  type GeneratedPlan,
  type Rect,
  boundsOf,
  placed,
} from "./generator";

/** Which way the ridge runs, named for how the line looks on the map. */
export type RoofOrientation = "vertical" | "horizontal";

/**
 * The orientation as it is *authored*: either one of them, or left to the
 * footprint.
 */
export type RoofOrientationSetting = RoofOrientation | "auto";

/**
 * Which way a roof over `width` x `depth` cells should run.
 *
 * A gable's ridge runs along the length of the building, so the roof steps
 * inward across the *short* axis: a hall twice as long as it is wide gets a
 * long low roof rather than a short tall one. That is the answer nearly every
 * time, which is why it is the default rather than a suggestion — the two
 * explicit settings are there for the building that means something else by
 * its shape.
 *
 * A square has no long axis, and takes the same number of roof levels either
 * way; it runs north-south, which is how the cottage at (12,3) is roofed.
 */
export function resolveRoofOrientation(
  setting: RoofOrientationSetting,
  width: number,
  depth: number,
): RoofOrientation {
  if (setting !== "auto") return setting;
  return width > depth ? "horizontal" : "vertical";
}

export type RoofColour = "red" | "yellow" | "blue";

/**
 * The two tiles a roof is built from: the four-unit eave that fills a whole
 * level, and the two-unit cap that finishes a span one cell wide.
 */
export const ROOF_COLOURS: Record<
  RoofColour,
  { label: string; eaveTileId: string; ridgeTileId: string }
> = {
  red: { label: "Red", eaveTileId: "roof-1", ridgeTileId: "roof-3" },
  yellow: { label: "Yellow", eaveTileId: "roof-2", ridgeTileId: "roof-5" },
  blue: { label: "Blue", eaveTileId: "roof-4", ridgeTileId: "roof-6" },
};

export const ROOF_COLOUR_IDS = Object.keys(ROOF_COLOURS) as RoofColour[];

/** Where the roof's flat middle comes from — two of them fill one level. */
export const ROOF_FILL_TILE_ID = "plaster";

/** Vertical third of the wall ring the door sits on. */
export type DoorRow = "north" | "centre" | "south";
/** Horizontal third of it. Both `centre` is no wall at all, so no door. */
export type DoorColumn = "west" | "centre" | "east";

export type HouseConfig = {
  generator: "house";
  /** Storeys of wall, each one level tall. The roof starts above the top one. */
  storeys: number;
  roofOrientation: RoofOrientationSetting;
  /**
   * `null` tops the walls with nothing at all — a curtain wall, a tower, a
   * yard. The roof is what makes a rectangle of wall a *house*, so leaving it
   * out is how the same generator builds the things that are not one.
   */
  roofColour: RoofColour | null;
  wallTileId: string;
  floorTileId: string;
  /** `null` leaves the walls blank so windows can be placed by hand. */
  windowTileId: string | null;
  /** Cells between one window and the next along a wall. @see WINDOW_SPACING_RANGE */
  windowSpacing: number;
  /** `null` leaves the doorway to be cut by hand. */
  doorTileId: string | null;
  doorRow: DoorRow;
  doorColumn: DoorColumn;
};

export type HousePlan = GeneratedPlan;

/**
 * The smallest house with an inside. Two cells across is a solid block of
 * wall, which is a pillar rather than a building.
 */
export const MIN_FOOTPRINT = 3;

export { MAX_FOOTPRINT } from "./generator";

/**
 * "N tiles away" throughout here means an index distance of N along the wall
 * run: `DOOR_MIN_FROM_CORNER = 2` puts the door of a five-wide wall dead
 * centre, which is where the cottage's is.
 */
const DOOR_MIN_FROM_CORNER = 2;
const WINDOW_MIN_FROM_CORNER = 1;
/**
 * Two, not one: one only says "not the door's own cell", which the door
 * already says for itself. Two is the smallest number that leaves wall
 * between them.
 */
const WINDOW_MIN_FROM_DOOR = 2;

/**
 * How far apart windows may be set, as an index distance along the wall run.
 *
 * Authored rather than fixed, because the right answer is not a property of
 * the tiles: two is a shopfront and five is a cottage, and which one a house
 * wants is the thing being decided. The floor is two — one would put windows
 * in every wall cell — and the ceiling is only there so a number typed by
 * accident cannot silently mean "one window, somewhere near the middle".
 */
export const WINDOW_SPACING_RANGE = { min: 2, max: 12 } as const;

/**
 * Roof levels a span of `span` cells needs.
 *
 * Each level steps in one cell from both sides, and the last one is either two
 * cells of opposing eave or a single ridge cap.
 */
export function roofLevelsFor(span: number): number {
  return Math.max(0, Math.ceil(span / 2));
}

/**
 * The face of a window set into a wall running `wall`-wards.
 *
 * `window-1` has two sprites under four names — the north/south pair and the
 * east/west pair — so a wall running east-west shows its south face and one
 * running north-south its east face. That is the convention every window in
 * `data/map.json` is authored with, and it is why a window does not simply
 * wear its own wall the way the door does: the picture is the same either way,
 * and matching what is already down is worth more than the symmetry.
 */
function windowDirectionFor(wall: Direction): Direction {
  return wall === "n" || wall === "s" ? "s" : "e";
}

/**
 * Where along a wall run [lo, hi] an anchor lands, keeping `margin` cells clear
 * of both corners. `null` when the wall is too short to hold anything.
 */
function anchorAlong(
  lo: number,
  hi: number,
  anchor: "low" | "centre" | "high",
  margin: number,
): number | null {
  const first = lo + margin;
  const last = hi - margin;
  if (first > last) return null;
  if (anchor === "low") return first;
  if (anchor === "high") return last;
  const middle = Math.floor((lo + hi) / 2);
  return Math.min(last, Math.max(first, middle));
}

type DoorSpot = { x: number; y: number; wall: Direction };

/**
 * The cell the door occupies, or `null` when the settings ask for no door or
 * the wall it would sit on is too short to keep it clear of the corners.
 */
export function doorSpotFor(
  bounds: Bounds,
  row: DoorRow,
  column: DoorColumn,
): DoorSpot | null {
  const { minX, maxX, minY, maxY } = bounds;
  const columnAnchor =
    column === "west" ? "low" : column === "east" ? "high" : "centre";
  const rowAnchor =
    row === "north" ? "low" : row === "south" ? "high" : "centre";

  // The row picks the wall wherever it names one; a centred row leaves the
  // choice to the column, and both centred name no wall at all.
  if (row === "north" || row === "south") {
    const x = anchorAlong(minX, maxX, columnAnchor, DOOR_MIN_FROM_CORNER);
    if (x == null) return null;
    return row === "north"
      ? { x, y: minY, wall: "n" }
      : { x, y: maxY, wall: "s" };
  }

  if (column === "centre") return null;

  const y = anchorAlong(minY, maxY, rowAnchor, DOOR_MIN_FROM_CORNER);
  if (y == null) return null;
  return column === "west"
    ? { x: minX, y, wall: "w" }
    : { x: maxX, y, wall: "e" };
}

/**
 * Window positions along one wall run, laid out symmetrically about its middle
 * and stepped by `spacing`. `blocked` is the door's position on this same wall,
 * when there is one.
 *
 * **A wall reads as symmetrical or as a mistake, and there is nothing in
 * between.** As many windows as fit at the spacing, with the two margins the
 * same, and whatever the wall cannot divide evenly widening the *middle* gap.
 * Slack put at one end instead is the version this replaced: an extra blank
 * cell at the east end of a wall and none at the west looks like the run was
 * measured from the wrong corner, which is exactly what it was.
 *
 * Perfect symmetry is not always available — a lone window on a wall with an
 * even number of usable cells has no middle gap for the odd cell to go into —
 * and there it sits one short of the middle.
 */
export function windowsAlong(
  lo: number,
  hi: number,
  blocked: number | null,
  spacing: number,
): number[] {
  const first = lo + WINDOW_MIN_FROM_CORNER;
  const last = hi - WINDOW_MIN_FROM_CORNER;
  if (first > last) return [];

  const step = Math.max(WINDOW_SPACING_RANGE.min, Math.floor(spacing));
  const count = Math.floor((last - first) / step) + 1;
  // Cells the run does not use: half at each margin, and the odd one — there is
  // at most one — into the gap at the middle.
  const slack = last - first - (count - 1) * step;
  const margin = Math.floor(slack / 2);
  const widenedGap = slack - margin * 2;
  const afterMiddle = Math.ceil(count / 2);

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const at =
      first + margin + i * step + (i >= afterMiddle ? widenedGap : 0);
    if (blocked != null && Math.abs(at - blocked) < WINDOW_MIN_FROM_DOOR) {
      continue;
    }
    out.push(at);
  }
  return out;
}

/** Every wall cell of one storey that wears a window, keyed `x,y`. */
function windowCells(
  bounds: Bounds,
  door: DoorSpot | null,
  spacing: number,
): Map<string, Direction> {
  const { minX, maxX, minY, maxY } = bounds;
  const out = new Map<string, Direction>();

  const doorAlong = (wall: Direction): number | null => {
    if (!door || door.wall !== wall) return null;
    return wall === "n" || wall === "s" ? door.x : door.y;
  };

  for (const wall of ["n", "s"] as const) {
    const y = wall === "n" ? minY : maxY;
    for (const x of windowsAlong(minX, maxX, doorAlong(wall), spacing)) {
      out.set(`${x},${y}`, windowDirectionFor(wall));
    }
  }
  for (const wall of ["w", "e"] as const) {
    const x = wall === "w" ? minX : maxX;
    for (const y of windowsAlong(minY, maxY, doorAlong(wall), spacing)) {
      out.set(`${x},${y}`, windowDirectionFor(wall));
    }
  }
  return out;
}

/**
 * The wall ring's cells for one storey, plus its floor.
 *
 * `standingOn` is what the cell already holds — the ground floor is laid *on*
 * the site rather than in place of it, so a house built on a road keeps its
 * road and one built on grass keeps its grass. Every storey above the ground
 * one is written into an empty level and has nothing under it.
 */
function storeyEdits(
  bounds: Bounds,
  z: number,
  config: HouseConfig,
  tilesById: Record<string, TileDef>,
  door: DoorSpot | null,
  standingOn: (x: number, y: number) => readonly PlacedTile[],
): StackEdit[] {
  const { minX, maxX, minY, maxY } = bounds;
  const windows = config.windowTileId
    ? windowCells(bounds, door, config.windowSpacing)
    : new Map();
  const floor = placed(config.floorTileId, tilesById);
  const edits: StackEdit[] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const under = standingOn(x, y).map((p) => ({ ...p }));
      const onWall = x === minX || x === maxX || y === minY || y === maxY;
      if (!onWall) {
        edits.push({ x, y, z, stack: [...under, { ...floor }] });
        continue;
      }

      if (door && config.doorTileId && door.x === x && door.y === y) {
        edits.push({
          x,
          y,
          z,
          stack: [
            ...under,
            { ...floor },
            // A door faces out of the house, so it wears the wall it is set
            // into: the north wall's door faces north. `DoorSpot.wall` is
            // already that outward normal.
            placed(config.doorTileId, tilesById, door.wall),
          ],
        });
        continue;
      }

      const windowFace = windows.get(`${x},${y}`);
      const top =
        windowFace && config.windowTileId
          ? placed(config.windowTileId, tilesById, windowFace)
          : placed(config.wallTileId, tilesById);
      edits.push({ x, y, z, stack: [...under, { ...floor }, top] });
    }
  }
  return edits;
}

/**
 * The roof, stepping inward one cell a level until the span runs out.
 *
 * The two eaves face each other across the ridge, so the low side wears the
 * direction pointing at the high side and not the other way round.
 */
function roofEdits(
  bounds: Bounds,
  baseLevel: number,
  config: HouseConfig,
  orientation: RoofOrientation,
  tilesById: Record<string, TileDef>,
): StackEdit[] {
  if (!config.roofColour) return [];

  const { minX, maxX, minY, maxY } = bounds;
  const { eaveTileId, ridgeTileId } = ROOF_COLOURS[config.roofColour];
  const vertical = orientation === "vertical";
  const span = vertical ? maxX - minX + 1 : maxY - minY + 1;
  const fill: PlacedTile[] = [
    { tileId: ROOF_FILL_TILE_ID },
    { tileId: ROOF_FILL_TILE_ID },
  ];
  const edits: StackEdit[] = [];

  for (let step = 0; step < roofLevelsFor(span); step++) {
    const z = baseLevel + step;
    const lo = (vertical ? minX : minY) + step;
    const hi = (vertical ? maxX : minY + span - 1) - step;
    const acrossLo = vertical ? minY : minX;
    const acrossHi = vertical ? maxY : maxX;

    // `at` is the coordinate along the axis the roof steps in; `across` runs
    // the full length of the ridge at every level.
    const put = (at: number, across: number, stack: PlacedTile[]) => {
      edits.push(
        vertical
          ? { x: at, y: across, z, stack }
          : { x: across, y: at, z, stack },
      );
    };

    for (let across = acrossLo; across <= acrossHi; across++) {
      if (lo === hi) {
        put(lo, across, [
          placed(ridgeTileId, tilesById, vertical ? "s" : "e"),
        ]);
        continue;
      }
      put(lo, across, [placed(eaveTileId, tilesById, vertical ? "e" : "s")]);
      put(hi, across, [placed(eaveTileId, tilesById, vertical ? "w" : "n")]);
      for (let at = lo + 1; at < hi; at++) {
        put(at, across, fill.map((p) => ({ ...p })));
      }
    }
  }
  return edits;
}

/**
 * How tall the site under the footprint stands, or why it cannot be built on.
 *
 * The ground floor is laid on top of what is already there, so the site does
 * not have to be bare — it has to be **level**. Every cell in the footprint has
 * to stand the same number of units tall, because a floor laid across cells of
 * two different heights is a floor with a step in it, and the walls resting on
 * it would end at two different heights too. Any height will do, including
 * none: grass, a cobbled road and a plinth of half-blocks are all level sites.
 */
function measureSite(
  map: MapFile,
  bounds: Bounds,
  z: number,
  tilesById: Record<string, TileDef>,
): { ok: true; height: number } | { ok: false; reason: string } {
  let height: number | null = null;
  let measuredAt = "";

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const stack = getStack(map, x, y, z);
      for (const p of stack) {
        const def = tilesById[p.tileId];
        if (isPlayerBody(p) || (def && resolveActor(def))) {
          return { ok: false, reason: `Somebody is standing at ${x},${y}` };
        }
      }
      const here = stackHeight(stack, tilesById);
      if (height == null) {
        height = here;
        measuredAt = `${x},${y}`;
        continue;
      }
      if (here !== height) {
        return {
          ok: false,
          reason: `The ground is not level: ${measuredAt} stands ${height} units and ${x},${y} stands ${here}`,
        };
      }
    }
  }
  return { ok: true, height: height ?? 0 };
}

/**
 * What one wall cell of the ground floor would measure, site included.
 *
 * A storey is one level, so the site plus the floor plus the wall has to fit in
 * `HEIGHT_PER_LEVEL`. Full-height walls therefore only stand on a flat site;
 * a plinth needs walls short enough to leave room for it. That is worth saying
 * in those words rather than letting {@link canReplaceStack} report it as an
 * overflow into the level the next storey is being written to.
 */
function groundFloorHeight(
  siteHeight: number,
  config: HouseConfig,
  tilesById: Record<string, TileDef>,
): number {
  const heightOf = (id: string) => {
    const def = tilesById[id];
    return def ? physicalHeight(def) : 0;
  };
  return siteHeight + heightOf(config.floorTileId) + heightOf(config.wallTileId);
}

/** Everything above the ground floor has to be empty for the house to fit. */
function occupiedAbove(
  map: MapFile,
  edits: readonly StackEdit[],
  groundLevel: number,
): string | null {
  for (const edit of edits) {
    if (edit.z === groundLevel) continue;
    if (getStack(map, edit.x, edit.y, edit.z).length > 0) {
      return `Something is already at ${edit.x},${edit.y} on z${edit.z}`;
    }
  }
  return null;
}

/**
 * The whole house as one list of stack edits, or the reason it cannot be built.
 *
 * `z` is the level the ground floor sits on — the editor's current level.
 */
export function planHouse(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  config: HouseConfig,
): HousePlan {
  const bounds = boundsOf(rect);
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxY - bounds.minY + 1;

  if (width < MIN_FOOTPRINT || depth < MIN_FOOTPRINT) {
    return {
      ok: false,
      reason: `A house is at least ${MIN_FOOTPRINT}×${MIN_FOOTPRINT} cells`,
    };
  }
  if (width > MAX_FOOTPRINT || depth > MAX_FOOTPRINT) {
    return {
      ok: false,
      reason: `A house is at most ${MAX_FOOTPRINT}×${MAX_FOOTPRINT} cells`,
    };
  }
  if (config.storeys < 1) {
    return { ok: false, reason: "A house has at least one storey" };
  }

  const roofBase = z + config.storeys;
  const orientation = resolveRoofOrientation(
    config.roofOrientation,
    width,
    depth,
  );
  const roofSpan = orientation === "vertical" ? width : depth;
  // With no roof the building tops out at its highest storey, and the level
  // that has to exist is that one rather than a ridge above it.
  const topLevel = config.roofColour
    ? roofBase + roofLevelsFor(roofSpan) - 1
    : roofBase - 1;
  if (topLevel > MAX_LEVEL) {
    return {
      ok: false,
      reason: `The building would pass z${MAX_LEVEL}`,
    };
  }

  const site = measureSite(map, bounds, z, tilesById);
  if (!site.ok) return site;

  const storeyHeight = groundFloorHeight(site.height, config, tilesById);
  if (storeyHeight > HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: `The site stands ${site.height} units and a storey on it would be ${storeyHeight}, past the ${HEIGHT_PER_LEVEL} a level holds`,
    };
  }

  const door = config.doorTileId
    ? doorSpotFor(bounds, config.doorRow, config.doorColumn)
    : null;

  const edits: StackEdit[] = [];
  for (let storey = 0; storey < config.storeys; storey++) {
    // The door is a way into the house, so it belongs to the ground floor and
    // the storeys above it get an unbroken wall there. Only the ground floor
    // has a site under it; the rest are written into empty levels.
    edits.push(
      ...storeyEdits(
        bounds,
        z + storey,
        config,
        tilesById,
        storey === 0 ? door : null,
        storey === 0 ? (x, y) => getStack(map, x, y, z) : () => [],
      ),
    );
  }
  edits.push(...roofEdits(bounds, roofBase, config, orientation, tilesById));

  const blocked = occupiedAbove(map, edits, z);
  if (blocked) return { ok: false, reason: blocked };

  // Checked against the map the edits *make*, not the one they start from: a
  // storey's own floor is what the storey above rests on, and a chosen floor
  // tile tall enough to overflow its level has to be caught here rather than
  // written and left for the validator on the next save to complain about.
  const built = setStacks(map, edits);
  for (const edit of edits) {
    const check = canReplaceStack(
      built,
      edit.x,
      edit.y,
      edit.z,
      edit.stack,
      tilesById,
    );
    if (!check.ok) {
      return { ok: false, reason: `${check.reason} at ${edit.x},${edit.y}` };
    }
  }

  return { ok: true, edits };
}

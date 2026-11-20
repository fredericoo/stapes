import { listCoords, presentLevels } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";

export type LandscapeProblemKind =
  | "river-corner"
  | "river-bed"
  | "river-bank"
  | "river-ground"
  | "water-mud"
  | "ground-patch"
  | "straight-edge"
  | "crowded";

export type LandscapeProblem = {
  kind: LandscapeProblemKind;
  x: number;
  y: number;
  z: number;
  message: string;
};

export type LandscapeInput = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
};

export type LandscapeReport = {
  problems: LandscapeProblem[];
  /** Surface cells looked at: the highest stack on its ground in each column at level 0 or above. */
  cells: number;
  /** For each kind of ground, the share of its open cells that something stands on, in the most crowded window. */
  densest: Partial<Record<Kind, { share: number; at: string }>>;
};

export type Kind = "grass" | "snow" | "sand";

export const KIND_OF_BASE: Record<string, Kind> = {
  "grass-2": "grass",
  "grass-brink": "grass",
  snow: "snow",
  "snow-brink": "snow",
  "sand-dunes": "sand",
  "sand-brink": "sand",
  "beach-sand": "sand",
};

export const WATER_TILES: ReadonlySet<string> = new Set(["water", "deep-water"]);

/** What lies on the ground rather than standing on it: a river bank may be any of these, and a cell with one is not open ground. */
export const COVER_TILES: ReadonlySet<string> = new Set([
  "mud",
  "dirt",
  "basalt",
  "lava-crust",
  "lava",
  "cobblestone",
  "flagstone-floor",
  "moss-flagstone",
  "wooden-floor",
  "half-stone",
  "ramp",
  "swamp",
]);

/** Shortest piece of one ground that is a place rather than noise; the generator's own floor is `MIN_PATCH_CELLS` in `scripts/island/terrain.ts`, which is larger. */
export const MIN_PATCH_CELLS = 16;
/** Snow lies on the peak, so a field of it smaller than this, in other ground, is a hilltop that caught the snow line rather than a place. */
export const MIN_SNOW_PATCH_CELLS = 200;
/** Longest straight line two grounds may meet along before it reads as drawn with a ruler. */
export const MAX_STRAIGHT_EDGE_CELLS = 12;
/** A river's bank stops this far from the shore of the sea or a lake, as `scripts/island/stacks.ts` lays it; a river that close is its mouth. */
const SHORE_CLEAR_CELLS = 2;
/** A river's banks are the cells beside it; the land it runs through is the ring past them. */
const RING_INNER_CELLS = 2;
const RING_OUTER_CELLS = 5;
/** Share of the ring that has to be one other ground before the river is on the wrong one, so a river along a border passes. */
const RING_MAJORITY = 0.75;
const RING_MIN_CELLS = 8;
const WINDOW_CELLS = 32;
/** A wall, a fence or a lamp stands within this of a floor, a street or a bank, and is not growth. */
const BUILT_REACH_CELLS = 2;
/** A window needs this many open cells of a ground before its crowding is judged. */
const WINDOW_MIN_OPEN = 256;
/** Most of a desert or a snowfield is open ground; the woods are meant to be thick, so grass has no limit. */
export const MAX_STANDING_SHARE: Partial<Record<Kind, number>> = { sand: 0.04, snow: 0.05 };

type Cell = {
  x: number;
  y: number;
  z: number;
  stack: PlacedTile[];
  kind: Kind | null;
  water: boolean;
  /** Water on grass or snow, outside a swamp, that is not the sea or a lake or its edge. */
  river: boolean;
  swamp: boolean;
  covered: boolean;
  standing: boolean;
};

const key = (x: number, y: number) => `${x},${y}`;
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function isStanding(placed: PlacedTile, tilesById: Record<string, TileDef>): boolean {
  if (COVER_TILES.has(placed.tileId) || WATER_TILES.has(placed.tileId)) return false;
  const def = tilesById[placed.tileId];
  if (!def || def.type === "autotile") return false;
  return def.walkable === false || (def.height ?? 0) > 0 || !!def.footprint;
}

function describe(stack: PlacedTile[], z: number, x: number, y: number): Cell | null {
  const base = stack[0]?.tileId;
  if (!base) return null;
  const water = stack.some((p) => WATER_TILES.has(p.tileId));
  const kind = KIND_OF_BASE[base] ?? null;
  if (!kind && !water) return null;
  const swamp = stack.some((p) => p.tileId === "swamp");
  return {
    x,
    y,
    z,
    stack,
    kind,
    water,
    river: false,
    swamp,
    covered: stack.slice(1).some((p) => COVER_TILES.has(p.tileId)),
    standing: false,
  };
}

/**
 * Something standing that has the same tile beside it is a wall, a fence or
 * a row of them, not growth; a prop covering several cells (`span`) is one
 * thing however many cells it covers, counted at its anchor.
 */
function markGrowth(surface: Map<string, Cell>, tilesById: Record<string, TileDef>) {
  for (const cell of surface.values()) {
    const grown = cell.stack.slice(1).filter((p) => isStanding(p, tilesById));
    cell.standing = grown.some((p) =>
      p.span ? p.span.dx === 0 && p.span.dy === 0 : !besideSame(surface, cell, p.tileId),
    );
  }
}

function besideSame(surface: Map<string, Cell>, cell: Cell, tileId: string): boolean {
  return SIDES.some(([dx, dy]) =>
    surface.get(key(cell.x + dx, cell.y + dy))?.stack.some((p) => p.tileId === tileId),
  );
}

/** The top of the ground in every column, ignoring floors and roofs built over it. */
function surfaceOf(map: MapFile): Map<string, Cell> {
  const surface = new Map<string, Cell>();
  for (const z of presentLevels(map)) {
    if (z < 0) continue;
    for (const { x, y, stack } of listCoords(map, z)) {
      const cell = describe(stack, z, x, y);
      const known = surface.get(key(x, y));
      if (cell && (!known || known.z < z)) surface.set(key(x, y), cell);
    }
  }
  return surface;
}

/**
 * Checks the rules a generated landscape keeps: rivers joined side to side,
 * a dirt bed and banks under a river on grass and no mud by any water, rivers
 * on the ground of the land they run through, no tiny patches of one ground
 * inside another, no straight borders between grounds, and deserts and
 * snowfields mostly open.
 */
export function checkLandscape({ map, tilesById }: LandscapeInput): LandscapeReport {
  const surface = surfaceOf(map);
  const shore = markRivers(surface);
  markGrowth(surface, tilesById);
  const problems: LandscapeProblem[] = [
    ...riverCorners(surface),
    ...riverBeds(surface, shore),
    ...riverGrounds(surface),
    ...waterMud(surface),
    ...groundPatches(surface, shore),
    ...straightEdges(surface, shore),
  ];
  const crowding = crowded(surface);
  problems.push(...crowding.problems);
  return { problems, cells: surface.size, densest: crowding.densest };
}

/** Water at least this wide both ways is a lake or the sea, since the widest river the generator cuts is three cells. */
const OPEN_WATER_CELLS = 4;

const near = (x: number, y: number, reach: number) => {
  const out: string[] = [];
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) if (dx || dy) out.push(key(x + dx, y + dy));
  return out;
};

/**
 * Marks every cell of water that is part of a river rather than of open
 * water, and returns the open water and the cells beside it: the sea, the
 * lakes and their shores.
 */
function markRivers(surface: Map<string, Cell>): Set<string> {
  const wet = (x: number, y: number) => {
    const cell = surface.get(key(x, y));
    return cell?.water === true && !cell.swamp;
  };
  const open = new Set<string>();
  for (const cell of surface.values()) {
    if (!wet(cell.x, cell.y)) continue;
    if (!blockIsWet(wet, cell.x, cell.y)) continue;
    for (let dy = 0; dy < OPEN_WATER_CELLS; dy++)
      for (let dx = 0; dx < OPEN_WATER_CELLS; dx++) open.add(key(cell.x + dx, cell.y + dy));
  }
  const shore = new Set(open);
  for (const at of open) {
    const [x, y] = at.split(",").map(Number) as [number, number];
    for (const k of near(x, y, 1)) if (surface.get(k)?.water) shore.add(k);
  }
  for (const cell of surface.values()) {
    const onLand = cell.kind === "grass" || cell.kind === "snow";
    cell.river = cell.water && !cell.swamp && onLand && !shore.has(key(cell.x, cell.y));
  }
  return shore;
}

function blockIsWet(wet: (x: number, y: number) => boolean, x: number, y: number): boolean {
  for (let dy = 0; dy < OPEN_WATER_CELLS; dy++)
    for (let dx = 0; dx < OPEN_WATER_CELLS; dx++) if (!wet(x + dx, y + dy)) return false;
  return true;
}

/** Mud is the swamp's: it is dark against grass and slows whoever walks on it, so a river or a shore has dirt where it has anything. */
function waterMud(surface: Map<string, Cell>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  for (const cell of surface.values()) {
    if (cell.swamp || !cell.stack.some((p) => p.tileId === "mud")) continue;
    const open = (other: Cell | undefined) => !!other?.water && !other.swamp;
    if (!open(cell) && !near(cell.x, cell.y, 1).some((k) => open(surface.get(k)))) continue;
    out.push({
      kind: "water-mud",
      x: cell.x,
      y: cell.y,
      z: cell.z,
      message: `${cell.x},${cell.y} L${cell.z} is mud by water outside a swamp; a river's bed and banks are dirt`,
    });
  }
  return out;
}

function riverCorners(surface: Map<string, Cell>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  const wet = (x: number, y: number) => surface.get(key(x, y))?.water === true;
  for (const cell of surface.values()) {
    if (!cell.river) continue;
    for (const dx of [-1, 1]) {
      const other = surface.get(key(cell.x + dx, cell.y + 1));
      if (!other?.river || wet(cell.x + dx, cell.y) || wet(cell.x, cell.y + 1)) continue;
      out.push({
        kind: "river-corner",
        x: cell.x,
        y: cell.y,
        z: cell.z,
        message: `the river at ${cell.x},${cell.y} L${cell.z} meets ${other.x},${other.y} only at a corner, so it shows a gap; one of the cells beside both should be water`,
      });
    }
  }
  return out;
}

function riverBeds(surface: Map<string, Cell>, shore: Set<string>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  for (const cell of surface.values()) {
    if (!cell.river || cell.kind !== "grass") continue;
    const nearShore = near(cell.x, cell.y, SHORE_CLEAR_CELLS).some((k) => shore.has(k));
    if (nearShore) continue;
    if (!cell.stack.some((p) => p.tileId === "dirt")) {
      out.push({
        kind: "river-bed",
        x: cell.x,
        y: cell.y,
        z: cell.z,
        message: `the river at ${cell.x},${cell.y} L${cell.z} runs over grass with no dirt under the water`,
      });
    }
    out.push(...bareBanks(surface, shore, cell));
  }
  return out;
}

/**
 * A bank on a cliff's edge keeps its brink, which draws the edge; a bank on
 * a shore is bare; and so is a bank where the land beside it changes ground,
 * since dirt there would draw a line of one ground into the other.
 */
function bareBanks(surface: Map<string, Cell>, shore: Set<string>, cell: Cell): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bank = surface.get(key(cell.x + dx, cell.y + dy));
      if (!bank || bank.water || bank.z !== cell.z || bank.kind !== "grass" || bank.covered)
        continue;
      if (bank.stack[0]!.tileId !== "grass-2") continue;
      if (near(bank.x, bank.y, SHORE_CLEAR_CELLS).some((k) => shore.has(k))) continue;
      if (besideOtherGround(surface, bank)) continue;
      out.push({
        kind: "river-bank",
        x: bank.x,
        y: bank.y,
        z: bank.z,
        message: `${bank.x},${bank.y} L${bank.z} is bare grass beside the river at ${cell.x},${cell.y}; a river on grass has a bank of dirt`,
      });
    }
  }
  return out;
}

const PLAIN_GROUNDS = new Set(["grass-2", "snow", "sand-dunes"]);

function besideOtherGround(surface: Map<string, Cell>, bank: Cell): boolean {
  return near(bank.x, bank.y, 1).some((k) => {
    const other = surface.get(k);
    const base = other?.stack[0]?.tileId;
    return (
      other?.z === bank.z && !!base && PLAIN_GROUNDS.has(base) && base !== bank.stack[0]!.tileId
    );
  });
}

/**
 * Judged per stretch of one level, as the generator lays it: a river keeps
 * one ground until it drops, so a short run past a patch of other land is not
 * on the wrong ground.
 */
function riverGrounds(surface: Map<string, Cell>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  const seen = new Set<string>();
  for (const start of surface.values()) {
    if (!start.river || seen.has(key(start.x, start.y))) continue;
    const stretch = floodStretch(surface, start, seen);
    const wrong = wrongGround(surface, stretch);
    if (!wrong) continue;
    out.push({
      kind: "river-ground",
      x: start.x,
      y: start.y,
      z: start.z,
      message: `the river at ${start.x},${start.y} L${start.z} is laid on ${wrong.laid} for ${stretch.length} cells through land that is ${wrong.land}`,
    });
  }
  return out;
}

function floodStretch(surface: Map<string, Cell>, start: Cell, seen: Set<string>): Cell[] {
  const stretch: Cell[] = [];
  const queue = [start];
  seen.add(key(start.x, start.y));
  while (queue.length) {
    const cell = queue.pop()!;
    stretch.push(cell);
    for (const [dx, dy] of SIDES) {
      const next = surface.get(key(cell.x + dx, cell.y + dy));
      if (!next?.river || next.z !== cell.z || seen.has(key(next.x, next.y))) continue;
      seen.add(key(next.x, next.y));
      queue.push(next);
    }
  }
  return stretch;
}

function wrongGround(
  surface: Map<string, Cell>,
  stretch: Cell[],
): { laid: Kind; land: Kind } | null {
  const ring: Record<Kind, number> = { grass: 0, snow: 0, sand: 0 };
  const laidOn: Record<Kind, number> = { grass: 0, snow: 0, sand: 0 };
  for (const cell of stretch) {
    if (cell.kind) laidOn[cell.kind]++;
    const around = ringKinds(surface, cell);
    for (const kind of KINDS) ring[kind] += around[kind];
  }
  const total = ring.grass + ring.snow + ring.sand;
  if (total < RING_MIN_CELLS) return null;
  const land = mostOf(ring);
  const laid = mostOf(laidOn);
  if (land === laid || ring[land] < total * RING_MAJORITY) return null;
  return { laid, land };
}

const KINDS: readonly Kind[] = ["grass", "snow", "sand"];
const mostOf = (counts: Record<Kind, number>): Kind =>
  KINDS.reduce((best, kind) => (counts[kind] > counts[best] ? kind : best));

function ringKinds(surface: Map<string, Cell>, cell: Cell): Record<Kind, number> {
  const ring: Record<Kind, number> = { grass: 0, snow: 0, sand: 0 };
  for (let dy = -RING_OUTER_CELLS; dy <= RING_OUTER_CELLS; dy++) {
    for (let dx = -RING_OUTER_CELLS; dx <= RING_OUTER_CELLS; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= RING_INNER_CELLS) continue;
      const other = surface.get(key(cell.x + dx, cell.y + dy));
      if (other?.kind && !other.water) ring[other.kind]++;
    }
  }
  return ring;
}

const isLand = (cell: Cell | undefined): cell is Cell & { kind: Kind } =>
  !!cell?.kind && !cell.water;
/**
 * Ground that shows: mud, a street or a floor over it hides which ground it
 * is. A patch starts only on ground that shows, but runs on under a cover of
 * the same ground, since the cover's edge draws that ground round it.
 */
const isOpenLand = (cell: Cell | undefined): cell is Cell & { kind: Kind } =>
  isLand(cell) && !cell.covered;

function groundPatches(surface: Map<string, Cell>, shore: Set<string>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  const seen = new Set<string>();
  for (const start of surface.values()) {
    if (!isOpenLand(start) || seen.has(key(start.x, start.y))) continue;
    const piece = floodKind(surface, start, seen);
    const least = start.kind === "snow" ? MIN_SNOW_PATCH_CELLS : MIN_PATCH_CELLS;
    if (piece.length >= least || !touchesOtherGround(surface, piece, start.kind)) continue;
    if (piece.some(({ x, y }) => near(x, y, 1).some((k) => shore.has(k)))) continue;
    if (piece.some((cell) => banksOwnWater(surface, cell))) continue;
    out.push({
      kind: "ground-patch",
      x: start.x,
      y: start.y,
      z: start.z,
      message: `${piece.length} cells of ${start.kind} at ${start.x},${start.y} L${start.z} stand alone inside other ground`,
    });
  }
  return out;
}

/** A strip of ground beside water laid on the same ground is that water's bank, the edge its autotile draws, not a patch. */
function banksOwnWater(surface: Map<string, Cell>, cell: Cell): boolean {
  return near(cell.x, cell.y, 1).some((k) => {
    const other = surface.get(k);
    return !!other?.water && other.z === cell.z && other.kind === cell.kind;
  });
}

function floodKind(
  surface: Map<string, Cell>,
  start: Cell & { kind: Kind },
  seen: Set<string>,
): Cell[] {
  const piece = [start];
  seen.add(key(start.x, start.y));
  for (let k = 0; k < piece.length; k++) {
    const { x, y } = piece[k]!;
    for (const [dx, dy] of SIDES) {
      const next = surface.get(key(x + dx, y + dy));
      if (!isLand(next) || next.kind !== start.kind || seen.has(key(next.x, next.y))) continue;
      seen.add(key(next.x, next.y));
      piece.push(next);
    }
  }
  return piece;
}

/** A small piece that meets only water is an islet or a sandbar, not a patch inside other land; one on a shore is a beach. */
function touchesOtherGround(surface: Map<string, Cell>, piece: Cell[], kind: Kind): boolean {
  return piece.some(({ x, y }) =>
    SIDES.some(([dx, dy]) => {
      const next = surface.get(key(x + dx, y + dy));
      return isOpenLand(next) && next.kind !== kind;
    }),
  );
}

/**
 * What a cell of land looks like from above: its ground, or mud where mud
 * covers it away from water. A road, a floor or a river bank has no look:
 * a bank takes the river's ground and follows its course, so a border along
 * a straight road or a straight reach of river is not a ruled line.
 */
function lookOf(surface: Map<string, Cell>, cell: Cell | undefined): string | null {
  if (!isLand(cell)) return null;
  const around = near(cell.x, cell.y, 1).map((k) => surface.get(k));
  if (around.some((other) => other?.water && !other.swamp)) return null;
  if (!cell.covered) return cell.kind;
  const mud = cell.stack.some((p) => p.tileId === "mud");
  return mud && !around.some((other) => other?.water) ? "mud" : null;
}

/** A beach follows the coast it is on, and a straight reach of coast is the sketch's; only a border this far from any shore is judged. */
const SHORE_REACH_CELLS = 8;

function straightEdges(surface: Map<string, Cell>, shore: Set<string>): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  for (const [ax, ay] of [
    [1, 0],
    [0, 1],
  ] as const) {
    out.push(...straightRuns(surface, ax, ay));
  }
  return out.filter(({ x, y }) => !near(x, y, SHORE_REACH_CELLS).some((k) => shore.has(k)));
}

/**
 * Walks every line of cells along `ax`, `ay` and counts how many cells in a
 * row have one look and the cell across the line another, the same two all
 * the way along.
 */
function straightRuns(surface: Map<string, Cell>, ax: number, ay: number): LandscapeProblem[] {
  const out: LandscapeProblem[] = [];
  const across = { x: ay, y: ax };
  const pairAt = (x: number, y: number) => {
    const a = lookOf(surface, surface.get(key(x, y)));
    const b = lookOf(surface, surface.get(key(x + across.x, y + across.y)));
    return a && b && a !== b ? `${a}|${b}` : null;
  };
  for (const cell of surface.values()) {
    const pair = pairAt(cell.x, cell.y);
    if (!pair || pairAt(cell.x - ax, cell.y - ay) === pair) continue;
    let length = 1;
    while (pairAt(cell.x + ax * length, cell.y + ay * length) === pair) length++;
    if (length <= MAX_STRAIGHT_EDGE_CELLS) continue;
    const [a, b] = pair.split("|");
    out.push({
      kind: "straight-edge",
      x: cell.x,
      y: cell.y,
      z: cell.z,
      message: `${a} meets ${b} along a straight line ${length} cells long from ${cell.x},${cell.y} L${cell.z}`,
    });
  }
  return out;
}

type Window = { open: number; standing: number };

function crowded(surface: Map<string, Cell>): {
  problems: LandscapeProblem[];
  densest: LandscapeReport["densest"];
} {
  const built = new Set<string>();
  for (const cell of surface.values()) {
    if (!cell.covered) continue;
    for (const k of near(cell.x, cell.y, BUILT_REACH_CELLS)) built.add(k);
  }
  const windows = new Map<string, Window>();
  for (const cell of surface.values()) {
    if (!isLand(cell) || cell.covered || !MAX_STANDING_SHARE[cell.kind]) continue;
    if (built.has(key(cell.x, cell.y))) continue;
    const at = `${cell.kind}|${Math.floor(cell.x / WINDOW_CELLS)},${Math.floor(cell.y / WINDOW_CELLS)}`;
    const window = windows.get(at) ?? { open: 0, standing: 0 };
    window.open++;
    if (cell.standing) window.standing++;
    windows.set(at, window);
  }
  const problems: LandscapeProblem[] = [];
  const densest: LandscapeReport["densest"] = {};
  for (const [at, window] of windows) {
    if (window.open < WINDOW_MIN_OPEN) continue;
    const [kind, corner] = at.split("|") as [Kind, string];
    const [wx, wy] = corner.split(",").map(Number) as [number, number];
    const share = window.standing / window.open;
    const x = wx * WINDOW_CELLS;
    const y = wy * WINDOW_CELLS;
    if (share > (densest[kind]?.share ?? -1)) densest[kind] = { share, at: `${x},${y}` };
    if (share <= MAX_STANDING_SHARE[kind]!) continue;
    problems.push({
      kind: "crowded",
      x,
      y,
      z: 0,
      message: `${(share * 100).toFixed(1)}% of the open ${kind} in the ${WINDOW_CELLS}-cell square from ${x},${y} has something standing on it; the most allowed is ${(MAX_STANDING_SHARE[kind]! * 100).toFixed(0)}%`,
    });
  }
  return { problems, densest };
}

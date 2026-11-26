import { resolveSwitch } from "../../../lib/interactions";
import { HEIGHT_PER_LEVEL, resolveIntangible } from "../../../lib/types";
import type { Direction, PlacedTile, TileDef } from "../../../lib/types";
import { isBrink, isFlat } from "../brinks";
import { isWet, pathTo, type Cell, type RouteCell } from "./line";
import { STEP } from "./ramp";

/** A route cell a tunnel carries on `under`, the level it is dug on, below the ground raised over it. */
export type Tunnelled = RouteCell & { under?: number };

/** A stack the road writes on an absolute level rather than on the ground it lies on. */
export type LevelEdit = { x: number; y: number; level: number; stack: PlacedTile[] };

/** What a tunnel is dug through: how high each cell's ground is, what stands on any level of it, and the road's own idea of clear ground. */
export type TunnelGround = {
  level(x: number, y: number): number;
  stackOn(x: number, y: number, level: number): readonly PlacedTile[];
  clear(x: number, y: number): boolean;
  rampGround(x: number, y: number): string | undefined;
  tilesById: Readonly<Record<string, TileDef>>;
};

export type TunnelStyle = { floor: string; mouth: string };

/** How far from where the route meets a cliff it looks for a straight stretch to open a mouth in. */
const MOUTH_REACH = 8;
/** How many of the nearest mouths on the near side are tried before the hill is left unjoined. */
const MOUTH_TRIES = 4;
/** How far past the route's own cells the dig may wander to reach a dungeon's passages. */
const DIG_MARGIN = 16;
/** A way round the foot of a hill is taken over a tunnel when it is at most this many times as long as the stretch it replaces, plus `MOUTH_REACH`. */
const DETOUR_STRETCH = 2;
/** A dug cell costs this many walked ones, so a tunnel goes through a dungeon's passages where it can. */
const DIG_COST = 4;

const DIRECTIONS: readonly Direction[] = ["s", "e", "w", "n"];
const SIDEWAYS: Record<Direction, Cell> = {
  n: { x: 1, y: 0 },
  s: { x: 1, y: 0 },
  e: { x: 0, y: 1 },
  w: { x: 0, y: 1 },
};
const N4 = [STEP.n, STEP.e, STEP.s, STEP.w];
const N8 = [...N4, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }];
const SQUARE = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];
const DEFAULT_MOUTH = "hill-cave-mouth";
const HILL_WALL = "hill-wall";

const key = (c: Cell) => `${c.x},${c.y}`;
const plus = (a: Cell, b: Cell, n = 1): Cell => ({ x: a.x + b.x * n, y: a.y + b.y * n });
const apart = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

type Mouth = { at: Cell; facing: Direction; outside: Cell; behind: Cell; rank: number };

/**
 * The cells of a hill on one level, read the way a cave reads them: rock is
 * a solid full block standing on flat tiles, and a passage is what a body
 * walks through on that level, a door it opens with its hands included.
 */
function hillOn(ground: TunnelGround, level: number) {
  const { tilesById } = ground;
  const rock = (c: Cell) => {
    if (ground.level(c.x, c.y) <= level) return false;
    const stack = ground.stackOn(c.x, c.y, level);
    const top = stack.at(-1);
    const def = top && tilesById[top.tileId];
    return (
      !!def &&
      !top.direction &&
      def.walkable === false &&
      def.height === HEIGHT_PER_LEVEL &&
      stack.slice(0, -1).every((p) => tilesById[p.tileId]?.height === 0)
    );
  };
  const opens = (p: PlacedTile) => {
    const def = tilesById[p.tileId];
    if (!def) return false;
    if (resolveIntangible(def) || (def.height === 0 && def.walkable !== false)) return true;
    const target = resolveSwitch(def)?.targetTileId;
    const opened = target ? tilesById[target] : undefined;
    return !!opened && resolveIntangible(opened);
  };
  const passage = (c: Cell) => {
    if (ground.level(c.x, c.y) <= level) return false;
    const stack = ground.stackOn(c.x, c.y, level);
    return stack.length > 0 && !isWet(stack) && stack.every(opens);
  };
  /** A dug cell keeps a full block over it, and rock or passage on every side, so the tunnel breaks out of the hill only at its mouths. */
  const diggable = (c: Cell) =>
    rock(c) &&
    ground.level(c.x, c.y) >= level + 2 &&
    N8.every((d) => ground.level(c.x + d.x, c.y + d.y) > level);
  return { rock, passage, diggable };
}

/**
 * Mouths that open from the hill onto clear ground on `level` near a cell,
 * nearest first, south and east faces before the others at the same
 * distance since those are the faces the projection draws. A mouth goes in
 * a straight stretch of cliff with a full block over it, and the cell
 * behind it has to be rock to dig or a passage already there.
 */
function mouthsNear(ground: TunnelGround, level: number, near: Cell): Mouth[] {
  const hill = hillOn(ground, level);
  const out: Mouth[] = [];
  for (let dy = -MOUTH_REACH; dy <= MOUTH_REACH; dy++) {
    for (let dx = -MOUTH_REACH; dx <= MOUTH_REACH; dx++) {
      const at = { x: near.x + dx, y: near.y + dy };
      if (!hill.rock(at) || ground.level(at.x, at.y) < level + 2) continue;
      for (const facing of DIRECTIONS) {
        const outside = plus(at, STEP[facing]);
        const behind = plus(at, STEP[facing], -1);
        const side = SIDEWAYS[facing];
        if (ground.level(outside.x, outside.y) !== level || !ground.clear(outside.x, outside.y)) {
          continue;
        }
        if (!hill.passage(behind) && !hill.diggable(behind)) continue;
        if (![-1, 1].every((s) => hill.rock(plus(at, side, s)))) continue;
        const rank = Math.hypot(dx, dy) + DIRECTIONS.indexOf(facing) * 0.5;
        out.push({ at, facing, outside, behind, rank });
      }
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * The cheapest way through the hill from one cell to every other it can
 * reach on `level`, inside `box`: a step along a passage costs one and a
 * step that digs costs `DIG_COST`, so a tunnel follows a dungeon's corridors
 * as far as they go its way and digs only to join them.
 */
function cheapestFrom(
  ground: TunnelGround,
  level: number,
  start: Cell,
  box: { minX: number; minY: number; maxX: number; maxY: number },
) {
  const hill = hillOn(ground, level);
  const cost = new Map<string, number>([[key(start), 0]]);
  const from = new Map<string, Cell | null>([[key(start), null]]);
  const buckets: Cell[][] = [[start]];
  for (let at = 0; at < buckets.length; at++) {
    for (const c of buckets[at] ?? []) {
      if (cost.get(key(c)) !== at) continue;
      for (const d of N4) {
        const next = plus(c, d);
        if (next.x < box.minX || next.x > box.maxX || next.y < box.minY || next.y > box.maxY) {
          continue;
        }
        const step = hill.passage(next) ? 1 : hill.diggable(next) ? DIG_COST : 0;
        if (step === 0) continue;
        const total = at + step;
        if (total >= (cost.get(key(next)) ?? Infinity)) continue;
        cost.set(key(next), total);
        from.set(key(next), c);
        (buckets[total] ??= []).push(next);
      }
    }
  }
  const pathFrom = (end: Cell): Cell[] | null => {
    if (!from.has(key(end))) return null;
    const cells: Cell[] = [];
    for (let c: Cell | null = end; c; c = from.get(key(c)) ?? null) cells.push(c);
    return cells.reverse();
  };
  return pathFrom;
}

type Dug = { from: number; to: number; laid: Tunnelled[]; edits: LevelEdit[] };

/**
 * Takes the route through a hill it has no other way over. `last` is the
 * route's last cell on `level` before the hill and `next` its first after
 * it; `passed` and `ahead` index the route's cells either side. A mouth is
 * opened near each, and the two are joined on `level` by the cheapest way
 * through the hill, which runs along any passage a dungeon left there and
 * digs the rest two cells wide. The road reaches each mouth from its own
 * route over clear ground, the way it reaches a ramp.
 */
function digThrough(
  ground: TunnelGround,
  style: TunnelStyle,
  level: number,
  last: Cell,
  next: Cell,
  passed: ReadonlyMap<string, number>,
  ahead: ReadonlyMap<string, number>,
  stretch: readonly Cell[],
): Dug | null {
  const hill = hillOn(ground, level);
  const entries = mouthsNear(ground, level, last).slice(0, MOUTH_TRIES);
  const exits = mouthsNear(ground, level, next);
  const xs = stretch.map((c) => c.x);
  const ys = stretch.map((c) => c.y);
  const box = {
    minX: Math.min(...xs) - DIG_MARGIN,
    maxX: Math.max(...xs) + DIG_MARGIN,
    minY: Math.min(...ys) - DIG_MARGIN,
    maxY: Math.max(...ys) + DIG_MARGIN,
  };
  const outsideOpen = (near: Cell, taken: ReadonlySet<string>) => (c: Cell) =>
    ground.level(c.x, c.y) === level &&
    !taken.has(key(c)) &&
    apart(c, near) <= 2 * MOUTH_REACH &&
    ground.clear(c.x, c.y);
  const onRoute = (index: ReadonlyMap<string, number>) => (c: Cell) =>
    ground.level(c.x, c.y) === level ? index.get(key(c)) : undefined;

  for (const entry of entries) {
    const pathFrom = cheapestFrom(ground, level, entry.behind, box);
    for (const exit of exits) {
      if (exit.at.x === entry.at.x && exit.at.y === entry.at.y) continue;
      const inside = pathFrom(exit.behind);
      if (!inside) continue;
      const taken = new Set([entry.at, exit.at, ...inside].map(key));
      const back = pathTo(entry.outside, outsideOpen(last, taken), onRoute(passed));
      const on = pathTo(exit.outside, outsideOpen(next, taken), onRoute(ahead));
      if (!back || !on) continue;
      const through = [entry.at, ...inside, exit.at];
      const sided = (cells: readonly Cell[], under?: number): Tunnelled[] =>
        cells.map((c, n) => {
          const other = cells[n + 1] ?? cells[n - 1] ?? c;
          const side = other.x !== c.x ? { x: 0, y: 1 } : { x: 1, y: 0 };
          return under === undefined ? { ...c, side } : { ...c, side, under };
        });
      return {
        from: back.index,
        to: on.index,
        laid: [
          ...sided(back.cells.reverse()).slice(1),
          ...sided(through, level),
          ...sided(on.cells),
        ],
        edits: carve(ground, style, level, entry, exit, inside, hill),
      };
    }
  }
  return null;
}

/**
 * The stacks a tunnel writes on its level. Every rock cell on the way is
 * dug, with the cells beside it that make a two-by-two square, so a body
 * passes another in it; a passage already there is left as it is. The floor
 * lies on the ground outside the first mouth, as a cave's lies on the
 * hill's. Rock left bare beside the new floor is stood on that floor, as a
 * cave stands its walls, unless it is on the hill's face, which keeps the
 * ground it shows. Each mouth is the hill wall's own mouth, on the ground
 * outside it.
 */
function carve(
  ground: TunnelGround,
  style: TunnelStyle,
  level: number,
  entry: Mouth,
  exit: Mouth,
  inside: readonly Cell[],
  hill: ReturnType<typeof hillOn>,
): LevelEdit[] {
  const { tilesById } = ground;
  const tile = (id: string, direction?: Direction): PlacedTile =>
    direction ? { tileId: id, direction } : { tileId: id };
  const outsideBottom = ground.stackOn(entry.outside.x, entry.outside.y, level)[0];
  const base =
    outsideBottom && isFlat(outsideBottom, tilesById) && !isBrink(outsideBottom.tileId)
      ? outsideBottom.tileId
      : (ground.rampGround(entry.at.x, entry.at.y) ?? "grass-2");
  const floor = () => [tile(base), tile(style.floor)];
  const mouths = new Set([key(entry.at), key(exit.at)]);
  const dug = new Map<string, Cell>();
  for (const c of inside) {
    if (!hill.diggable(c)) continue;
    for (const d of SQUARE) {
      const k = plus(c, d);
      if (!mouths.has(key(k)) && hill.diggable(k)) dug.set(key(k), k);
    }
  }
  const edits: LevelEdit[] = [];
  for (const c of dug.values()) edits.push({ ...c, level, stack: floor() });
  const walled = new Set<string>();
  for (const c of dug.values()) {
    for (const d of N8) {
      const w = plus(c, d);
      if (dug.has(key(w)) || mouths.has(key(w)) || walled.has(key(w)) || !hill.rock(w)) continue;
      walled.add(key(w));
      const stack = ground.stackOn(w.x, w.y, level);
      const onFace = N8.some((e) => ground.level(w.x + e.x, w.y + e.y) <= level);
      if (stack.length > 1 || onFace) continue;
      edits.push({ ...w, level, stack: [...floor(), ...stack] });
    }
  }
  for (const mouth of [entry, exit]) {
    const outside = ground
      .stackOn(mouth.outside.x, mouth.outside.y, level)
      .filter((p) => isFlat(p, tilesById) && !tilesById[p.tileId]?.intangible && !isWet([p]));
    const wall = ground.stackOn(mouth.at.x, mouth.at.y, level).at(-1)?.tileId;
    edits.push({
      ...mouth.at,
      level,
      stack: [
        ...outside.map((p) => ({ ...p })),
        tile(mouthIn(style.mouth, wall, tilesById), mouth.facing),
      ],
    });
  }
  return edits;
}

/** The default mouth comes in each hill wall's stone, as a cave's does. */
function mouthIn(
  mouth: string,
  wall: string | undefined,
  tilesById: Readonly<Record<string, TileDef>>,
) {
  if (mouth !== DEFAULT_MOUTH || !wall?.startsWith(HILL_WALL)) return mouth;
  const matching = DEFAULT_MOUTH + wall.slice(HILL_WALL.length);
  return tilesById[matching] ? matching : mouth;
}

/**
 * The way round the foot of a hill on `level`, for a route that only clips
 * it: a tunnel that comes out of the face it went in by is a detour under
 * the rim. It is taken only when it is short beside the stretch it replaces.
 */
function aroundTheFoot(
  ground: TunnelGround,
  level: number,
  last: Cell,
  stretch: readonly Cell[],
  ahead: ReadonlyMap<string, number>,
): { to: number; laid: Tunnelled[] } | null {
  const longest = DETOUR_STRETCH * stretch.length + MOUTH_REACH;
  const open = (c: Cell) =>
    ground.level(c.x, c.y) === level &&
    ground.clear(c.x, c.y) &&
    stretch.some((s) => apart(c, s) <= longest / 2);
  const goal = (c: Cell) => (ground.level(c.x, c.y) === level ? ahead.get(key(c)) : undefined);
  const way = pathTo(last, open, goal);
  if (!way || way.cells.length > longest) return null;
  const laid = way.cells.slice(1).map((c, n, cells) => {
    const other = cells[n + 1] ?? cells[n - 1] ?? last;
    return { ...c, side: other.x !== c.x ? { x: 0, y: 1 } : { x: 1, y: 0 } };
  });
  return { to: way.index, laid };
}

/**
 * Takes the route under every hill it crosses and cannot climb. A stretch
 * of the route that leaves `level` for higher ground and comes back down to
 * the same level is tunnelled when `climbs` says the road cannot get over it
 * by ramps, which is the case for a cliff more than a level high or a shelf
 * too narrow for a ramp, and cannot go round its foot instead
 * (`aroundTheFoot`). A stretch that ends on the hill, or comes down on
 * another level, is left to the ramps. So is one no mouth or tunnel fits.
 */
export function withTunnels(
  cells: readonly RouteCell[],
  ground: TunnelGround,
  style: TunnelStyle,
  climbs: (stretch: readonly RouteCell[]) => boolean,
): { cells: Tunnelled[]; edits: LevelEdit[] } {
  const out: Tunnelled[] = [];
  const edits: LevelEdit[] = [];
  const level = (c: Cell) => ground.level(c.x, c.y);
  let i = 0;
  while (i < cells.length) {
    const c = cells[i]!;
    const prev = out.at(-1);
    if (!prev || prev.under !== undefined || level(c) <= level(prev)) {
      out.push(c);
      i++;
      continue;
    }
    const floor = level(prev);
    let j = i;
    while (j < cells.length && level(cells[j]!) > floor) j++;
    const stretch = cells.slice(i, j);
    if (j >= cells.length || level(cells[j]!) !== floor || climbs([prev, ...stretch, cells[j]!])) {
      out.push(...stretch);
      i = j;
      continue;
    }
    const ahead = new Map<string, number>();
    for (let n = cells.length - 1; n >= j; n--) ahead.set(key(cells[n]!), n);
    const round = aroundTheFoot(ground, floor, prev, stretch, ahead);
    if (round) {
      out.push(...round.laid);
      i = round.to + 1;
      continue;
    }
    const passed = new Map(out.map((k, n) => [key(k), n]));
    const dug = digThrough(ground, style, floor, prev, cells[j]!, passed, ahead, [
      prev,
      ...stretch,
    ]);
    if (!dug) {
      out.push(...stretch);
      i = j;
      continue;
    }
    out.length = dug.from + 1;
    out.push(...dug.laid);
    edits.push(...dug.edits);
    i = dug.to + 1;
  }
  return { cells: out, edits };
}

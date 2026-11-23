import * as v from "valibot";
import { getStack, type StackEdit } from "../../../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../../../lib/types";
import { HEIGHT_PER_LEVEL } from "../../../lib/types";
import { placed, valueNoise, type Bounds } from "../../generator";
import { brinkOf, groundOf } from "../brinks";
import type { Component } from "../build";
import { TILES, field } from "../field";
import type { Point } from "../doc";
import { LADDER_TOP, LADDER_UP } from "./cave";
import { isWet } from "./line";
import { maskShape } from "./mask";

export const CHASM_TYPE = "chasm";

const BOTTOMS = { lava: "lava", water: "water", floor: null } as const;

export const ChasmSchema = v.object({
  /** How many cells each level's opening loses on its north and west sides, which is how wide the ledge it leaves is. */
  ledge: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  ragged: v.optional(field.percent(), 40),
  raggedScale: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(32)), 6),
  floor: v.optional(field.tile(TILES.ground), "basalt"),
  wall: v.optional(field.tile(TILES.wall), "hill-wall-basalt"),
  bottom: v.optional(v.picklist(Object.keys(BOTTOMS) as Array<keyof typeof BOTTOMS>), "lava"),
  /** Points on the rim where lava pours in and runs down every ledge to the bottom. */
  cascades: v.optional(field.points(), []),
  /** How far, in cells, each level's floor runs back under the rock round the chasm, so the level is a cavern with the chasm in it. 0 leaves a bare ledge. */
  cavern: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(12)), 5),
  /** How many tunnels join each level's cave to each dry part of its ledge. */
  openings: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)), 1),
});

export type ChasmProps = v.InferOutput<typeof ChasmSchema>;

/**
 * Writes nothing of its own: the dungeon it is part of cuts it, before it
 * digs its levels, and then joins each level to its ledge and pours the
 * cascades (`cutChasm`, `openOntoLedges`, `pourCascades`).
 */
export const chasm: Component<ChasmProps> = {
  type: CHASM_TYPE,
  label: "Chasm",
  starter: { frame: { x: 8, y: 6, w: 22, h: 18 } },
  schema: ChasmSchema,
  within: ["dungeon"],
  build: () => ({ ok: true, edits: [] }),
};

type Cell = { x: number; y: number };

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const N8 = [...N4, [1, -1], [1, 1], [-1, 1], [-1, -1]] as const;

const key = (x: number, y: number) => `${x},${y}`;

/**
 * The openings of a chasm: `holes[0]` is cut out of the ground, and on the
 * dungeon's level `i` the sky is over `holes[i]` and `holes[i + 1]` is open
 * through to the level below, so that level's ledge is the one less the
 * other. On the last level `holes[i + 1]` is the pool `bottom` fills. Each
 * opening is the one above with its north and west sides pulled in by
 * `ledge` and its south and east sides by one cell. The projection never
 * shows the faces of south and east walls, so the ledges a body can see
 * from the rim are all on the north and west.
 */
export type ChasmPlan = {
  readonly holes: ReadonlyArray<ReadonlySet<string>>;
  readonly box: Bounds;
  readonly props: ChasmProps;
  readonly seed: number;
};

/**
 * Cells each opening loses on its south and east sides. Those ledges are
 * hidden under the rim, so they only narrow the chasm as it goes down.
 */
const SIDE_LEDGE = 1;

export function planChasm(
  bounds: Bounds,
  seed: number,
  props: ChasmProps,
  levels: number,
): ChasmPlan | { reason: string } {
  const shape = maskShape(
    {
      shape: "oval",
      op: "add",
      ragged: props.ragged,
      raggedScale: props.raggedScale,
      grow: 0,
      only: [],
      from: null,
    },
    bounds,
    seed,
    null,
  );
  let hole = new Set<string>();
  for (let i = 0; i < shape.cells.length; i++) {
    if (shape.cells[i]) {
      hole.add(key(shape.minX + (i % shape.width), shape.minY + Math.floor(i / shape.width)));
    }
  }
  const holes = [hole];
  for (let level = 1; level <= levels; level++) {
    const above = hole;
    hole = new Set<string>();
    for (const k of above) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      let open = true;
      for (let dy = -SIDE_LEDGE; dy <= props.ledge && open; dy++) {
        for (let dx = -SIDE_LEDGE; dx <= props.ledge && open; dx++) {
          open = above.has(key(x - dx, y - dy));
        }
      }
      if (open) hole.add(k);
    }
    if (hole.size === 0) {
      return {
        reason: `The chasm closes up above level ${level} of the dungeon. Make it bigger or its ledges narrower.`,
      };
    }
    holes.push(hole);
  }
  const box = {
    minX: shape.minX - 2,
    minY: shape.minY - 2,
    maxX: shape.minX + shape.width + 1,
    maxY: shape.minY + shape.height + 1,
  };
  return { holes, box, props, seed };
}

type Lay = {
  readonly map: MapFile;
  readonly tilesById: Record<string, TileDef>;
  /** The dungeon's own level, where its first Level is dug. */
  readonly z: number;
  raisedAt(x: number, y: number): number;
};

const isOpen = (plan: ChasmPlan, i: number, x: number, y: number) =>
  plan.holes[i]?.has(key(x, y)) ?? false;

const beside = (plan: ChasmPlan, i: number, x: number, y: number, around = N8) =>
  around.some(([dx, dy]) => isOpen(plan, i, x + dx, y + dy));

/**
 * Cuts the ground out of `holes[0]`, from the surface down to the first
 * level, and cuts the ground at the rim to its brink. Then on each level it
 * lays the ledge, cut to its brink beside the next drop, and stands `wall`
 * round the opening on every empty cell beside it, on ground wherever it
 * faces a ledge. The last level has no opening: what would be the next is
 * the pool `bottom` fills.
 */
export function cutChasm(lay: Lay, plan: ChasmPlan): StackEdit[] {
  const { box, props, holes } = plan;
  const tile = (id: string) => placed(id, lay.tilesById);
  const edits: StackEdit[] = [];
  const last = holes.length - 2;
  const liquid = BOTTOMS[props.bottom];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const top = Math.max(lay.raisedAt(x, y), lay.z + 1);
      if (isOpen(plan, 0, x, y)) {
        for (let z = lay.z + 1; z <= top; z++) edits.push({ x, y, z, stack: [] });
      } else if (beside(plan, 0, x, y)) {
        const ground = getStack(lay.map, x, y, top)[0];
        const brink = ground && brinkOf(ground.tileId);
        if (brink) edits.push({ x, y, z: top, stack: [tile(brink)] });
      }
      for (let i = 0; i <= last; i++) {
        const z = lay.z - i;
        if (isOpen(plan, i, x, y)) {
          const below = isOpen(plan, i + 1, x, y);
          let stack: PlacedTile[];
          if (i === last)
            stack = below && liquid ? [tile(props.floor), tile(liquid)] : [tile(props.floor)];
          else if (below) stack = [];
          else {
            const edge = beside(plan, i + 1, x, y);
            stack = [tile(edge ? (brinkOf(props.floor) ?? props.floor) : props.floor)];
          }
          edits.push({ x, y, z, stack });
        } else if (beside(plan, i, x, y) && getStack(lay.map, x, y, z).length === 0) {
          const facesFloor = N8.some(
            ([dx, dy]) =>
              isOpen(plan, i, x + dx, y + dy) &&
              (i === last || !isOpen(plan, i + 1, x + dx, y + dy)),
          );
          edits.push({
            x,
            y,
            z,
            stack: facesFloor ? [tile(props.floor), tile(props.wall)] : [tile(props.wall)],
          });
        }
      }
    }
  }
  return edits;
}

const isLedge = (plan: ChasmPlan, i: number, x: number, y: number) =>
  isOpen(plan, i, x, y) && (i === plan.holes.length - 2 || !isOpen(plan, i + 1, x, y));

/** Rock a tunnel may be cut through: an empty cell, or nothing but one solid wall standing on ground. */
function cuttable(stack: readonly PlacedTile[], tilesById: Record<string, TileDef>): boolean {
  if (stack.length === 0) return true;
  if (stack.length > 2) return false;
  const top = tilesById[stack.at(-1)!.tileId];
  return top?.walkable === false && top.height === HEIGHT_PER_LEVEL && !stack.at(-1)!.direction;
}

const soaked = (stack: readonly PlacedTile[]) =>
  isWet(stack) || stack.some((p) => p.tileId === "lava" || p.tileId.startsWith("lavafall"));

/**
 * The parts of a level's ledge a body can walk between without stepping in
 * lava or water. A cascade running across the ledge cuts it in two, and each
 * part needs its own way out.
 */
function dryPieces(
  plan: ChasmPlan,
  i: number,
  stackAt: (x: number, y: number) => readonly PlacedTile[],
  cavern: ReadonlySet<string>,
): Array<Set<string>> {
  const pieces: Array<Set<string>> = [];
  const taken = new Set<string>();
  const floor = (x: number, y: number) =>
    (isLedge(plan, i, x, y) || cavern.has(key(x, y))) && !soaked(stackAt(x, y));
  for (const k of [...plan.holes[i]!, ...cavern]) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (taken.has(k) || !floor(x, y)) continue;
    const piece = new Set([k]);
    taken.add(k);
    const queue: Cell[] = [{ x, y }];
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      for (const [dx, dy] of N4) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        const nk = key(nx, ny);
        if (taken.has(nk) || !floor(nx, ny)) continue;
        taken.add(nk);
        piece.add(nk);
        queue.push({ x: nx, y: ny });
      }
    }
    pieces.push(piece);
  }
  return pieces;
}

/**
 * Hollows each level out behind the cliff round its ledge, `cavern` cells
 * deep give or take half as many again, so the level is a cave with the chasm
 * in the middle of it rather than a ledge in a shaft. The cliff itself stays:
 * it is the face under the ledge above, and without it that ledge is drawn
 * hanging in the air. It is opened every few cells onto the ledge instead,
 * as a cave mouth where the face is drawn. The hollow runs only through rock
 * a tunnel could cut, never by a flight of stairs or out from under the
 * ground, and is walled where it ends. It runs after the cascades are poured,
 * so their lava stays on the ledges.
 */
export function openCaverns(
  lay: Lay,
  plan: ChasmPlan,
): { edits: StackEdit[]; caverns: Array<Set<string>> } {
  const edits: StackEdit[] = [];
  const caverns: Array<Set<string>> = [];
  const reach = plan.props.cavern;
  const tile = (id: string, direction?: Direction) => placed(id, lay.tilesById, direction);
  for (let i = 0; i < plan.holes.length - 1; i++) {
    const z = lay.z - i;
    const cavern = new Set<string>();
    caverns.push(cavern);
    if (reach === 0) continue;
    const limit = (x: number, y: number) =>
      reach * (0.5 + valueNoise(x, y, plan.seed ^ (0x5ca1 + i), reach * 2));
    const climbs = (x: number, y: number, level: number) =>
      getStack(lay.map, x, y, level).some(
        (p) => p.direction || p.tileId === LADDER_UP || p.tileId === LADDER_TOP,
      );
    /**
     * A flight lands two cells past its top step, so floor that close to one
     * would be a lower floor to step onto in place of its landing, and floor
     * over one would close the shaft it is climbed out of.
     */
    const nearStairs = (x: number, y: number) => {
      if (climbs(x, y, z - 1)) return true;
      for (let dy = -STAIR_CLEARANCE; dy <= STAIR_CLEARANCE; dy++) {
        for (let dx = -STAIR_CLEARANCE; dx <= STAIR_CLEARANCE; dx++) {
          if (climbs(x + dx, y + dy, z)) return true;
        }
      }
      return false;
    };
    const roofed = (x: number, y: number) => {
      for (let level = z + 1; level <= Math.max(lay.raisedAt(x, y), z + 1); level++) {
        if (getStack(lay.map, x, y, level).length > 0) return true;
      }
      return false;
    };
    const steps = new Map<string, number>();
    const queue: Cell[] = [];
    const ring = new Set<string>();
    for (let y = plan.box.minY; y <= plan.box.maxY; y++) {
      for (let x = plan.box.minX; x <= plan.box.maxX; x++) {
        if (isOpen(plan, i, x, y) || !beside(plan, i, x, y)) continue;
        ring.add(key(x, y));
        steps.set(key(x, y), 0);
        queue.push({ x, y });
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      const at = steps.get(key(c.x, c.y))!;
      for (const [dx, dy] of N4) {
        const x = c.x + dx;
        const y = c.y + dy;
        const k = key(x, y);
        if (steps.has(k) || isOpen(plan, i, x, y)) continue;
        if (at + 1 > limit(x, y)) continue;
        if (!cuttable(getStack(lay.map, x, y, z), lay.tilesById)) continue;
        if (nearStairs(x, y) || !roofed(x, y)) continue;
        steps.set(k, at + 1);
        cavern.add(k);
        queue.push({ x, y });
      }
    }
    for (const k of cavern) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      edits.push({ x, y, z, stack: [tile(plan.props.floor)] });
    }
    const mouths: Cell[] = [];
    for (const k of ring) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      if (mouths.some((m) => Math.abs(m.x - x) + Math.abs(m.y - y) < MOUTH_SPACING)) continue;
      if (nearStairs(x, y)) continue;
      const facing = MOUTH_FACES.find(({ dx, dy }) => {
        const inside =
          isLedge(plan, i, x + dx, y + dy) && !soaked(getStack(lay.map, x + dx, y + dy, z));
        return inside && cavern.has(key(x - dx, y - dy));
      });
      if (!facing) continue;
      mouths.push({ x, y });
      cavern.add(k);
      edits.push({
        x,
        y,
        z,
        stack: facing.drawn
          ? [tile(plan.props.floor), tile(mouthOf(plan.props.wall, lay.tilesById), facing.drawn)]
          : [tile(plan.props.floor)],
      });
    }
    const walled = new Set<string>();
    for (const k of cavern) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        const nk = key(nx, ny);
        if (cavern.has(nk) || walled.has(nk) || isOpen(plan, i, nx, ny)) continue;
        if (getStack(lay.map, nx, ny, z).length > 0 || climbs(nx, ny, z - 1)) continue;
        walled.add(nk);
        edits.push({ x: nx, y: ny, z, stack: [tile(plan.props.floor), tile(plan.props.wall)] });
      }
    }
  }
  return { edits, caverns };
}

const STAIR_CLEARANCE = 2;
/** How far apart, along the cliff round one level's ledge, two ways into its cavern are. */
const MOUTH_SPACING = 9;
/**
 * The ways a ledge can lie from the cliff behind it. Only a south or east face
 * of a cliff is drawn, so only there is the way in drawn as a cave mouth; on
 * the other sides the cliff is simply left open.
 */
const MOUTH_FACES = [
  { dx: 0, dy: 1, drawn: "s" },
  { dx: 1, dy: 0, drawn: "e" },
  { dx: 0, dy: -1, drawn: null },
  { dx: -1, dy: 0, drawn: null },
] as const;
const HILL_WALL = "hill-wall";
const CAVE_MOUTH = "hill-cave-mouth";

function mouthOf(wall: string, tilesById: Record<string, TileDef>): string {
  const matching = wall.startsWith(HILL_WALL) ? CAVE_MOUTH + wall.slice(HILL_WALL.length) : "";
  return tilesById[matching] ? matching : CAVE_MOUTH;
}

/** How far from a ledge a tunnel may run to find the cave. */
const REACH = 16;
/** How far apart along the ledge two openings on one level start. */
const OPENING_SPACING = 10;

/**
 * Joins the cave dug on each level to that level's ledge. The cave keeps two
 * cells of rock between itself and the chasm's wall, as it does round any
 * cell that is not rock, so it never opens onto the ledge by itself. Each
 * tunnel is the shortest run of rock from the ledge to the cave's floor, in
 * the floor the cave is made of, walled where it passes empty rock. It runs
 * after the cascades, so every part of the ledge their lava cuts off gets one.
 */
export function openOntoLedges(
  lay: Lay,
  plan: ChasmPlan,
  floors: ReadonlyArray<ReadonlySet<string>>,
  caverns: ReadonlyArray<ReadonlySet<string>>,
): StackEdit[] {
  const edits: StackEdit[] = [];
  const tile = (id: string) => placed(id, lay.tilesById);
  for (let i = 0; i < floors.length && i < plan.holes.length - 1; i++) {
    const z = lay.z - i;
    const floor = floors[i]!;
    if (floor.size === 0) continue;
    const written = new Map<string, PlacedTile[]>();
    const stackAt = (x: number, y: number) => written.get(key(x, y)) ?? getStack(lay.map, x, y, z);
    const pieces = dryPieces(
      plan,
      i,
      (x, y) => getStack(lay.map, x, y, z),
      caverns[i] ?? new Set(),
    ).filter(
      (piece) =>
        ![...piece].some((k) => {
          const [x, y] = k.split(",").map(Number) as [number, number];
          return N4.some(([dx, dy]) => floor.has(key(x + dx, y + dy)));
        }),
    );
    const starts: Cell[] = [];
    for (let n = 0; n < plan.props.openings * pieces.length; n++) {
      const piece = pieces[n % pieces.length]!;
      const seen = new Map<string, string | null>();
      const queue: Cell[] = [];
      for (const k of piece) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        if (
          starts.some(
            (s) =>
              piece.has(key(s.x, s.y)) && Math.abs(s.x - x) + Math.abs(s.y - y) < OPENING_SPACING,
          )
        )
          continue;
        for (const [dx, dy] of N4) {
          const nx = x + dx;
          const ny = y + dy;
          const nk = key(nx, ny);
          if (isOpen(plan, i, nx, ny) || piece.has(nk) || seen.has(nk)) continue;
          if (!cuttable(stackAt(nx, ny), lay.tilesById)) continue;
          seen.set(nk, null);
          queue.push({ x: nx, y: ny });
        }
      }
      const steps = new Map<string, number>();
      for (const q of queue) steps.set(key(q.x, q.y), 1);
      let found: string | null = null;
      for (let head = 0; head < queue.length && !found; head++) {
        const c = queue[head]!;
        const ck = key(c.x, c.y);
        if ((steps.get(ck) ?? 0) > REACH) continue;
        for (const [dx, dy] of N4) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          const nk = key(nx, ny);
          if (seen.has(nk) || isOpen(plan, i, nx, ny)) continue;
          if (floor.has(nk)) {
            seen.set(nk, ck);
            found = nk;
            break;
          }
          if (!cuttable(stackAt(nx, ny), lay.tilesById)) continue;
          seen.set(nk, ck);
          steps.set(nk, (steps.get(ck) ?? 0) + 1);
          queue.push({ x: nx, y: ny });
        }
      }
      if (!found) continue;
      const [fx, fy] = found.split(",").map(Number) as [number, number];
      const ground = stackAt(fx, fy)[0]!;
      const path: Cell[] = [];
      for (let at = seen.get(found) ?? null; at; at = seen.get(at) ?? null) {
        const [x, y] = at.split(",").map(Number) as [number, number];
        path.push({ x, y });
      }
      const head = path.at(-1)!;
      const start = N4.map(([dx, dy]) => ({ x: head.x + dx, y: head.y + dy })).find((c) =>
        isLedge(plan, i, c.x, c.y),
      );
      if (start) starts.push(start);
      const cut = new Set(path.map((c) => key(c.x, c.y)));
      for (const c of path) written.set(key(c.x, c.y), [{ ...ground }]);
      for (const c of path) {
        for (const [dx, dy] of N8) {
          const x = c.x + dx;
          const y = c.y + dy;
          const k = key(x, y);
          if (cut.has(k) || isOpen(plan, i, x, y) || stackAt(x, y).length > 0) continue;
          if (getStack(lay.map, x, y, z - 1).some((p) => p.direction)) continue;
          written.set(k, [{ ...ground }, tile(plan.props.wall)]);
        }
      }
    }
    for (const [k, stack] of written) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      edits.push({ x, y, z, stack });
    }
  }
  return edits;
}

/** A fall stands in the lower cell against the cliff it comes down, which is drawn only on a south or east face. */
const FALLS = {
  s: { dx: 0, dy: 1, segments: ["lavafall-base", "lavafall-middle", "lavafall-top"] },
  e: {
    dx: 1,
    dy: 0,
    segments: ["lavafall-east-base", "lavafall-east-middle", "lavafall-east-top"],
  },
} as const;
type Flow = keyof typeof FALLS;
const TURN: Record<Flow, Flow> = { s: "e", e: "s" };
/** A fall segment is half a level tall. */
const SEGMENTS_PER_LEVEL = 2;
/** How many cells back from the rim the lava that feeds a cascade runs. */
const SPRING = 3;

/** One cell a cascade lays: lava on a ledge, or a fall dropping `levels` onto the cell's own level `z`. */
type Pour = { x: number; y: number; z: number; flow: Flow; levels: number };

/**
 * Pours lava in at the rim nearest each cascade point and runs it down to the
 * bottom: south or east across each ledge, turning to the other where the
 * ledge goes on, and down a fall wherever it reaches the edge, as many
 * levels tall as it drops. It flows only south and east because a fall can
 * only be drawn on those faces. The stream is two cells wide: the second
 * follows the first a cell to its side wherever the ground there is the same.
 */
export function pourCascades(
  lay: Lay,
  plan: ChasmPlan,
  points: ReadonlyArray<Point>,
  point: (p: Point) => Cell | null,
): StackEdit[] {
  const tile = (id: string) => placed(id, lay.tilesById);
  const last = plan.holes.length - 2;
  const surface = (x: number, y: number) => Math.max(lay.raisedAt(x, y), lay.z + 1);
  const levelOf = (z: number) => lay.z - z;
  /** The level a stream at z is on, -1 for the ground round the rim. */
  const levelAt = (z: number) => (z > lay.z ? -1 : levelOf(z));
  /** Whether lava can lie at x,y on z: the ground round the rim, or a ledge. */
  const dry = (x: number, y: number, z: number) =>
    z > lay.z ? !isOpen(plan, 0, x, y) : isLedge(plan, levelOf(z), x, y) && !isPool(x, y, z);
  const isPool = (x: number, y: number, z: number) =>
    levelOf(z) === last && isOpen(plan, last + 1, x, y);
  /** The level a body or a stream falling into x,y from above level `level` lands on. */
  const landsOn = (x: number, y: number, level: number) => {
    let lands = level + 1;
    while (lands < last && isOpen(plan, lands + 1, x, y)) lands++;
    return lands;
  };

  const run = (start: Cell, startFlow: Flow): Pour[] => {
    const pours: Pour[] = [];
    let flow = startFlow;
    let at = start;
    let z = surface(at.x, at.y);
    for (let back = SPRING - 1; back > 0; back--) {
      const x = at.x - FALLS[flow].dx * back;
      const y = at.y - FALLS[flow].dy * back;
      if (dry(x, y, surface(x, y))) pours.push({ x, y, z: surface(x, y), flow, levels: 0 });
    }
    pours.push({ ...at, z, flow, levels: 0 });
    for (let guard = 0; guard < 400; guard++) {
      const level = levelAt(z);
      const f = FALLS[flow];
      const x = at.x + f.dx;
      const y = at.y + f.dy;
      if (isPool(x, y, z)) break;
      if (isOpen(plan, level + 1, x, y)) {
        const below = lay.z - landsOn(x, y, level);
        pours.push({ x, y, z: below, flow, levels: z - below });
        if (isPool(x, y, below)) break;
        at = { x, y };
        z = below;
        continue;
      }
      if (level >= 0 && dry(x, y, z)) {
        pours.push({ x, y, z, flow, levels: 0 });
        at = { x, y };
        continue;
      }
      const turned = FALLS[TURN[flow]];
      const tx = at.x + turned.dx;
      const ty = at.y + turned.dy;
      if (level < 0 || !(isOpen(plan, level + 1, tx, ty) || dry(tx, ty, z))) break;
      flow = TURN[flow];
    }
    return pours;
  };

  const laid = new Map<string, StackEdit[]>();
  const lay1 = (p: Pour) => {
    const k = `${p.z}:${p.x},${p.y}`;
    if (laid.get(k)?.some((e) => e.stack.length > 2)) return;
    const ground = getStack(lay.map, p.x, p.y, p.z)[0];
    const base = tile(p.levels === 0 && ground ? groundOf(ground.tileId) : plan.props.floor);
    if (p.levels === 0) {
      laid.set(k, [{ x: p.x, y: p.y, z: p.z, stack: [base, tile("lava")] }]);
      return;
    }
    const [foot, middle, crest] = FALLS[p.flow].segments;
    const segments = [
      foot,
      ...Array.from({ length: p.levels * SEGMENTS_PER_LEVEL - 2 }, () => middle),
      crest,
    ].map(tile);
    const edits = [
      {
        x: p.x,
        y: p.y,
        z: p.z,
        stack: [base, tile("lava"), ...segments.slice(0, SEGMENTS_PER_LEVEL)],
      },
    ];
    for (let k2 = SEGMENTS_PER_LEVEL; k2 < segments.length; k2 += SEGMENTS_PER_LEVEL) {
      edits.push({
        x: p.x,
        y: p.y,
        z: p.z + k2 / SEGMENTS_PER_LEVEL,
        stack: segments.slice(k2, k2 + SEGMENTS_PER_LEVEL),
      });
    }
    laid.set(k, edits);
  };

  for (const p of points) {
    const near = point(p);
    if (!near) continue;
    let best: { at: Cell; flow: Flow; d: number } | null = null;
    for (let y = plan.box.minY; y <= plan.box.maxY; y++) {
      for (let x = plan.box.minX; x <= plan.box.maxX; x++) {
        if (isOpen(plan, 0, x, y)) continue;
        for (const flow of ["s", "e"] as const) {
          const f = FALLS[flow];
          if (!isOpen(plan, 0, x + f.dx, y + f.dy)) continue;
          const d = Math.hypot(x - near.x, y - near.y);
          if (!best || d < best.d) best = { at: { x, y }, flow, d };
        }
      }
    }
    if (!best) continue;
    const pours = run(best.at, best.flow);
    for (const pour of pours) lay1(pour);
    for (const pour of pours) {
      const f = FALLS[pour.flow];
      const side = { x: pour.x + f.dy, y: pour.y + f.dx };
      const fits =
        pour.levels === 0
          ? dry(side.x, side.y, pour.z)
          : isOpen(plan, levelAt(pour.z + pour.levels) + 1, side.x, side.y) &&
            (pour.z + pour.levels > lay.z
              ? !isOpen(plan, 0, side.x - f.dx, side.y - f.dy)
              : dry(side.x - f.dx, side.y - f.dy, pour.z + pour.levels)) &&
            lay.z - landsOn(side.x, side.y, levelAt(pour.z + pour.levels)) === pour.z;
      if (fits) lay1({ ...pour, ...side });
    }
  }
  return [...laid.values()].flat();
}

import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Direction, PlacedTile } from "../../../lib/types";
import { HEIGHT_PER_LEVEL } from "../../../lib/types";
import { stackOcclusion } from "../../../lib/lighting";
import { carveCave, type CaveConfig, type CaveShape } from "../../cave";
import { hashCell, isOpen, placed, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { isWet } from "./line";
import { carveCrypt } from "./crypt";
import { STEP, type Cell } from "./ramp";

const CRYPT = "crypt";
const SHAPES = ["caverns", "veins", "tunnels", CRYPT] as const satisfies ReadonlyArray<
  CaveShape | typeof CRYPT
>;

/** What a cave is made of when its props leave a tile out, by whether it was dug by water or by hand. */
const LOOK = {
  natural: { floor: "dirt", wall: "cave-wall-sloped", rock: null, prop: "stalagmite" },
  crypt: {
    floor: "flagstone-floor",
    wall: "brick-wall",
    rock: "cave-wall-sloped-grey",
    prop: null,
  },
} as const;

export const CaveSchema = v.object({
  shape: v.optional(v.picklist(SHAPES), "caverns"),
  density: v.optional(field.percent(), 30),
  floor: v.optional(field.tile(TILES.ground)),
  wall: v.optional(field.tile(TILES.any)),
  /** What fills the rock a cave closes round below ground, where no wall faces its floor; its wall when left out. */
  rock: v.optional(v.nullable(field.tile(TILES.any))),
  mouth: v.optional(field.tile(TILES.any), "hill-cave-mouth"),
  mouths: v.optional(field.points(), []),
  steps: v.optional(field.tile(TILES.stairs), "stone-stairs"),
  stairs: v.optional(field.points(), []),
  ladders: v.optional(field.points(), []),
  prop: v.optional(v.nullable(field.tile(TILES.standing))),
  propEvery: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 22),
  /** A crypt's cells of rock between two rooms, the length of its shortest corridor. */
  spacing: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)), 2),
  /** How many cells across a crypt's corridors are. */
  corridor: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 2),
  /** The door a crypt puts where a corridor leaves a room, or none. */
  door: v.optional(v.nullable(field.tile(TILES.door)), null),
});

export type CaveProps = v.InferOutput<typeof CaveSchema>;

const FACES: readonly Direction[] = ["s", "e", "w", "n"];
const OPPOSITE: Record<Direction, Direction> = { n: "s", s: "n", e: "w", w: "e" };
/** Stairs climb north or west first, so the flight is drawn rising away from the camera. */
const CLIMBS: readonly Direction[] = ["n", "w", "e", "s"];
const STAIR_BLOCK = "half-stone";
const LADDER_UP = "ladder-up";
const LADDER_TOP = "ladder-top";
const SIDEWAYS: Record<Direction, Cell> = {
  n: { x: 1, y: 0 },
  s: { x: 1, y: 0 },
  e: { x: 0, y: 1 },
  w: { x: 0, y: 1 },
};
/** How much further away a mouth may be for each face the projection shows less of. */
const FACE_COST = 6;
/** Cells of rock kept between a cave and the outside of its hill. */
const SHELL = 2;
/** The fewest cells of floor cut off from the ways in that are joined back rather than filled in. */
const MIN_PIECE = 12;
/** How far behind its mouth a tunnel is cut before it has to meet the cave. */
const TUNNEL = 4;

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

const N8 = [...N4, [1, -1], [1, 1], [-1, 1], [-1, -1]] as const;

type Mouth = { at: Cell; facing: Direction };
/** A flight two cells wide whose foot is `at`, climbed heading `climbs` onto the level above. */
type Stairs = { at: Cell; climbs: Direction };

const key = (x: number, y: number) => `${x},${y}`;

const SQUARE = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/**
 * Digs one level of cave on the level its frame is on, the way Rune Isle's
 * caves are dug (`scripts/island/underground.ts`). On level 0 and up it digs
 * into the rock of a hill, and only where the hill is rock above the cave as
 * well, since the hilltop's floor lets daylight through anything standing on
 * it (`docs/notes.md`, "`carve:hill-caves` digs only where a hill is rock
 * above the cave as well"). Below level 0 it digs wherever the ground over
 * the cell keeps the sky out, and walls the cave with `wall`. Either way
 * every cave cell has two cells of rock to every side. The `crypt` shape is
 * dug by hand: rooms and corridors, in flagstone and grey rock unless the
 * props say otherwise, and walled with `wall` inside a hill as well.
 *
 * The ways in are points: each of `mouths` goes on the nearest straight
 * stretch of cliff with open ground in front of it, south and east faces
 * first; each of `stairs` is a flight up to flat ground on the level above,
 * which is the surface or a cave laid earlier; each of `ladders` climbs to
 * the same. Caves at any depth are joined by laying them top down, each with
 * stairs or a ladder up to the one before it.
 */
export const cave: Component<CaveProps> = {
  type: "cave",
  label: "Cave",
  starter: {
    frame: { x: 2, y: 2, w: 24, h: 18 },
    props: { mouths: [{ x: 0, y: 0, pinX: "center", pinY: "bottom" }] },
  },
  schema: CaveSchema,
  shapesItself: true,
  ownLevels: true,
  build(ctx, given) {
    const look = LOOK[given.shape === CRYPT ? "crypt" : "natural"];
    const props = {
      ...given,
      floor: given.floor ?? look.floor,
      wall: given.wall ?? look.wall,
      rock: given.rock ?? look.rock ?? given.wall ?? look.wall,
      prop: given.prop === undefined ? look.prop : given.prop,
    };
    const z = ctx.z;
    const underground = z < 0;
    const { minX, maxX, minY, maxY } = ctx.bounds;
    const inFrame = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const seals = (x: number, y: number, level: number) => {
      const stack = ctx.stackAt(x, y, level);
      if (stack.length === 0) return false;
      const o = stackOcclusion(stack, ctx.tilesById);
      return o.sealsLevel || o.opacity >= 1;
    };
    const rock = new Map<string, boolean>();
    /**
     * In a hill, rock is the fill of a raised column. Underground it is any
     * empty cell that some level of its column, up to the ground, closes
     * off from the sky.
     */
    const isRock = (x: number, y: number) => {
      const k = key(x, y);
      let known = rock.get(k);
      if (known === undefined) {
        const stack = ctx.stackAt(x, y, z);
        if (underground) {
          known = stack.length === 0;
          if (known) {
            known = false;
            for (let level = z + 1; level <= ctx.raisedAt(x, y) && !known; level++) {
              known = seals(x, y, level);
            }
          }
        } else {
          const top = stack.at(-1);
          const def = top && ctx.tilesById[top.tileId];
          known =
            ctx.raisedAt(x, y) > z &&
            stack.length <= 2 &&
            !!def &&
            !top.direction &&
            def.walkable === false &&
            def.height === HEIGHT_PER_LEVEL;
        }
        rock.set(k, known);
      }
      return known;
    };
    const open = new Set<string>();
    const pinned = new Set<string>();
    /** Rock a way in needs left standing, which no tunnel or cave may open. */
    const kept = new Set<string>();
    const isOpenAt = (x: number, y: number) => open.has(key(x, y));
    const diggable = (x: number, y: number) => {
      if (!inFrame(x, y) || !ctx.covered(x, y) || kept.has(key(x, y))) return false;
      if (!underground && ctx.raisedAt(x, y) <= z + 1) return false;
      for (let dy = -SHELL; dy <= SHELL; dy++) {
        for (let dx = -SHELL; dx <= SHELL; dx++) {
          if (!isRock(x + dx, y + dy)) return false;
        }
      }
      return true;
    };
    const plain = (x: number, y: number) => {
      const stack = ctx.stackAt(x, y, z);
      return (
        ctx.raisedAt(x, y) === z &&
        stack.length > 0 &&
        !isWet(stack) &&
        stack.every((p) => ctx.tilesById[p.tileId]?.height === 0)
      );
    };
    /**
     * Flat, dry floor on the level above the cave that a body can stand on:
     * the top of its column, or the floor of a cave laid there earlier.
     */
    const landing = (x: number, y: number) => {
      const stack = ctx.stackAt(x, y, z + 1);
      return (
        stack.length > 0 &&
        !isWet(stack) &&
        stack.every((p) => {
          const def = ctx.tilesById[p.tileId];
          return def?.height === 0 && def.walkable !== false && !def.intangible && !isWet([p]);
        }) &&
        (ctx.raisedAt(x, y) <= z + 1 || ctx.stackAt(x, y, z + 2).length > 0)
      );
    };

    const cellOf = (k: string): Cell => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return { x, y };
    };
    const isSolid = (stack: readonly PlacedTile[]) => {
      const def = stack.at(-1) && ctx.tilesById[stack.at(-1)!.tileId];
      return !!def && def.walkable === false && def.height === HEIGHT_PER_LEVEL;
    };

    const mouthNear = (near: Cell): Mouth | null => {
      let best: (Mouth & { rank: number }) | null = null;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          for (const facing of FACES) {
            const out = STEP[facing];
            const side = SIDEWAYS[facing];
            const rank = Math.hypot(x - near.x, y - near.y) + FACES.indexOf(facing) * FACE_COST;
            if (best && rank >= best.rank) continue;
            if (!plain(x + out.x, y + out.y)) continue;
            const behind = [0, 1].every((k) => {
              const ix = x + side.x * k;
              const iy = y + side.y * k;
              if (!isRock(ix, iy)) return false;
              for (let n = 1; n <= TUNNEL; n++) {
                const bx = ix - out.x * n;
                const by = iy - out.y * n;
                if (n <= SHELL ? !isRock(bx, by) : !diggable(bx, by)) return false;
              }
              return true;
            });
            if (!behind) continue;
            const flanked = [-1, 2].every(
              (k) =>
                isRock(x + side.x * k, y + side.y * k) &&
                isRock(x + side.x * k - out.x, y + side.y * k - out.y),
            );
            if (flanked) best = { at: { x, y }, facing, rank };
          }
        }
      }
      return best;
    };

    /**
     * The cells of a flight, `n` cells along the way it climbs from its foot
     * and `k` across: 0 and 1 are the stairs, under the open shaft a body
     * climbs out of, 2 and 3 the floor above it lands on, and -1 and -2 the
     * cave floor in front of it.
     */
    const flight = (s: Stairs, n: number, k: number): Cell => {
      const up = STEP[s.climbs];
      const side = SIDEWAYS[s.climbs];
      return { x: s.at.x + up.x * n + side.x * k, y: s.at.y + up.y * n + side.y * k };
    };
    /**
     * Opening the shaft takes floor away from the level above, which can cut
     * it in two. Every floor cell round the shaft has to reach every other
     * without it, inside the frame and two cells round it.
     */
    const keepsJoined = (site: Stairs) => {
      const shaft = new Set<string>();
      for (const n of [0, 1]) {
        for (const k of [0, 1]) shaft.add(key(flight(site, n, k).x, flight(site, n, k).y));
      }
      const ring: string[] = [];
      for (let n = -1; n <= 2; n++) {
        for (let k = -1; k <= 2; k++) {
          const c = flight(site, n, k);
          if (!shaft.has(key(c.x, c.y)) && landing(c.x, c.y)) ring.push(key(c.x, c.y));
        }
      }
      const within = (x: number, y: number) =>
        x >= minX - 2 && x <= maxX + 2 && y >= minY - 2 && y <= maxY + 2;
      const seen = new Set([ring[0]!]);
      const queue = [cellOf(ring[0]!)];
      for (let head = 0; head < queue.length; head++) {
        for (const [dx, dy] of N4) {
          const x = queue[head]!.x + dx;
          const y = queue[head]!.y + dy;
          const k = key(x, y);
          if (seen.has(k) || shaft.has(k) || !within(x, y) || !landing(x, y)) continue;
          seen.add(k);
          queue.push({ x, y });
        }
      }
      return ring.every((k) => seen.has(k));
    };
    const stairsNear = (near: Cell): Stairs | null => {
      const sites: Array<Stairs & { rank: number }> = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          for (const climbs of CLIMBS) {
            const site = { at: { x, y }, climbs };
            const fits = [0, 1].every((k) => {
              const cell = (n: number) => flight(site, n, k);
              return (
                [-2, -1, 0, 1, 2, 3].every((n) => isRock(cell(n).x, cell(n).y)) &&
                diggable(cell(-2).x, cell(-2).y) &&
                [0, 1, 2, 3].every((n) => landing(cell(n).x, cell(n).y))
              );
            });
            /**
             * Every cell round the open shaft has to be floor or rock. A
             * flight there would have its foot taken away by the shaft, or
             * leave a cell between the two that only the shaft reaches.
             */
            let walled = true;
            for (let n = -1; n <= 2 && walled; n++) {
              for (let k = -1; k <= 2 && walled; k++) {
                if ((n === 0 || n === 1) && (k === 0 || k === 1)) continue;
                const { x: sx, y: sy } = flight(site, n, k);
                walled = landing(sx, sy) || isSolid(ctx.stackAt(sx, sy, z + 1));
              }
            }
            if (fits && walled) {
              const rank = Math.hypot(x - near.x, y - near.y) + CLIMBS.indexOf(climbs);
              sites.push({ ...site, rank });
            }
          }
        }
      }
      return sites.sort((p, q) => p.rank - q.rank).find(keepsJoined) ?? null;
    };
    const ladderNear = (near: Cell): { at: Cell } | null => {
      let best: { at: Cell; rank: number } | null = null;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const rank = Math.hypot(x - near.x, y - near.y);
          if (best && rank >= best.rank) continue;
          if (diggable(x, y) && landing(x, y)) best = { at: { x, y }, rank };
        }
      }
      return best;
    };

    const found = <T extends { at: Cell }>(
      points: readonly (typeof props.mouths)[number][],
      near: (cell: Cell) => T | null,
    ): T[] => {
      const out: T[] = [];
      for (const point of points) {
        const cell = ctx.point(point);
        const site = cell && near(cell);
        if (site && !out.some((o) => o.at.x === site.at.x && o.at.y === site.at.y)) {
          out.push(site);
        }
      }
      return out;
    };
    const mouths = underground ? [] : found(props.mouths, mouthNear);
    const stairs = found(props.stairs, stairsNear);
    const ladders = found(props.ladders, ladderNear).map((l) => l.at);
    if (mouths.length + stairs.length + ladders.length === 0) {
      return {
        ok: false,
        reason: underground
          ? "There is no way into this cave. Give it stairs or a ladder up to flat ground on the level above, with ground over the cave to keep the daylight out."
          : "There is no way into this cave. Above ground a cave needs at least two levels of hill above its own level, so its roof is rock and not the hilltop, and a mouth on a straight stretch of its cliff with open ground at the foot, or stairs or a ladder up to flat ground on the level above.",
      };
    }

    /**
     * Floor beyond the top step or beside the flight would be a lower floor
     * to step onto in place of the level above, so it stays rock. The flight
     * itself is kept out of the carving too, so a tunnel joining the cave to
     * the foot of the stairs is not cut short by a passage through the steps;
     * it is opened again as a pinned cell.
     */
    for (const s of stairs) {
      for (const [n, k] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
        [2, 0],
        [2, 1],
        [3, 0],
        [3, 1],
        [0, -1],
        [1, -1],
        [0, 2],
        [1, 2],
      ] as const) {
        kept.add(key(flight(s, n, k).x, flight(s, n, k).y));
      }
    }
    const crypt =
      props.shape === CRYPT
        ? carveCrypt(ctx.bounds, {
            seed: ctx.seed,
            density: props.density,
            spacing: props.spacing,
            width: props.corridor,
          })
        : null;
    const carved =
      crypt?.grid ??
      carveCave(ctx.bounds, {
        seed: ctx.seed,
        shape: props.shape as CaveShape,
        density: props.density,
      } as CaveConfig);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (isOpen(carved, x, y) && diggable(x, y)) open.add(key(x, y));
      }
    }

    /** Walks from a way in through diggable rock to the nearest cave cell, breadth first, and opens the way two cells wide. */
    const join = (start: Cell) => {
      const from = new Map<string, Cell | null>([[key(start.x, start.y), null]]);
      const queue = [start];
      let end: Cell | null = open.has(key(start.x, start.y)) ? start : null;
      for (let head = 0; head < queue.length && !end; head++) {
        const at = queue[head]!;
        for (const [dx, dy] of N4) {
          const next = { x: at.x + dx, y: at.y + dy };
          const k = key(next.x, next.y);
          if (from.has(k) || !diggable(next.x, next.y)) continue;
          from.set(k, at);
          if (open.has(k)) {
            end = next;
            break;
          }
          queue.push(next);
        }
      }
      for (let at: Cell | null = end; at; at = from.get(key(at.x, at.y)) ?? null) {
        for (const [dx, dy] of SQUARE) {
          if (diggable(at.x + dx, at.y + dy)) open.add(key(at.x + dx, at.y + dy));
        }
      }
    };
    for (const mouth of mouths) {
      const out = STEP[mouth.facing];
      const side = SIDEWAYS[mouth.facing];
      for (let n = 1; n <= TUNNEL; n++) {
        for (const k of [0, 1]) {
          pinned.add(key(mouth.at.x + side.x * k - out.x * n, mouth.at.y + side.y * k - out.y * n));
        }
      }
      join({ x: mouth.at.x - out.x * TUNNEL, y: mouth.at.y - out.y * TUNNEL });
    }
    for (const s of stairs) {
      for (const n of [-2, -1, 0, 1]) {
        for (const k of [0, 1]) pinned.add(key(flight(s, n, k).x, flight(s, n, k).y));
      }
      join(flight(s, -2, 0));
    }
    for (const ladder of ladders) {
      for (const [dx, dy] of [[0, 0], ...N8] as const)
        pinned.add(key(ladder.x + dx, ladder.y + dy));
      join(ladder);
    }
    for (const cell of pinned) open.add(cell);

    /**
     * A floor cell outside every two-by-two square of floor is a passage one
     * cell wide, which a prop or a creature blocks; filling those back can
     * cut a piece off, so the pieces no way in reaches go after it. A crypt's
     * corridors are as wide as it asks, so it is left as it was dug.
     */
    const square = (x: number, y: number) =>
      isOpenAt(x, y) && isOpenAt(x + 1, y) && isOpenAt(x, y + 1) && isOpenAt(x + 1, y + 1);
    for (let changed = !crypt; changed;) {
      changed = false;
      for (const k of [...open]) {
        if (pinned.has(k)) continue;
        const { x, y } = cellOf(k);
        if (square(x, y) || square(x - 1, y) || square(x, y - 1) || square(x - 1, y - 1)) continue;
        open.delete(k);
        changed = true;
      }
    }
    const spread = (from: Iterable<string>) => {
      const seen = new Set<string>(from);
      const walk = [...seen].map(cellOf);
      for (let head = 0; head < walk.length; head++) {
        for (const [dx, dy] of N4) {
          const k = key(walk[head]!.x + dx, walk[head]!.y + dy);
          if (!open.has(k) || seen.has(k)) continue;
          seen.add(k);
          walk.push(cellOf(k));
        }
      }
      return seen;
    };
    let reached = spread(pinned);
    /**
     * Rock a way in keeps standing can cut a passage the carving made, so
     * each piece of floor the ways in do not reach is joined back to one
     * that they do, biggest first, and a piece too small to be worth a
     * tunnel is filled in.
     */
    const pieces = [...open]
      .filter((k) => !reached.has(k))
      .reduce<string[][]>((out, k) => {
        if (out.some((piece) => piece.includes(k))) return out;
        const piece = [...spread([k])].filter((c) => !reached.has(c));
        return piece.length >= MIN_PIECE ? [...out, piece] : out;
      }, [])
      .sort((p, q) => q.length - p.length);
    for (const piece of pieces) {
      if (reached.has(piece[0]!)) continue;
      const from = new Map<string, string | null>(piece.map((k) => [k, null]));
      const queue = piece.map(cellOf);
      let end: string | null = null;
      for (let head = 0; head < queue.length && end === null; head++) {
        const at = queue[head]!;
        for (const [dx, dy] of N4) {
          const k = key(at.x + dx, at.y + dy);
          if (from.has(k)) continue;
          if (reached.has(k)) {
            end = key(at.x, at.y);
            break;
          }
          if (!diggable(at.x + dx, at.y + dy)) continue;
          from.set(k, key(at.x, at.y));
          queue.push({ x: at.x + dx, y: at.y + dy });
        }
      }
      for (let k = end; k !== null; k = from.get(k) ?? null) {
        const at = cellOf(k);
        for (const [dx, dy] of SQUARE) {
          if (diggable(at.x + dx, at.y + dy)) open.add(key(at.x + dx, at.y + dy));
        }
      }
      if (end !== null) reached = spread(pinned);
    }
    /**
     * Two cells of rock between two floors in a crypt are two walls side by
     * side, which draws as a grid of brick. The one that can be dug is opened,
     * so the floors share one wall; opening it can leave another such pair, so
     * this runs until none is left.
     */
    for (let changed = Boolean(crypt); changed;) {
      changed = false;
      for (const k of [...reached]) {
        const { x, y } = cellOf(k);
        for (const [dx, dy] of N4) {
          const near = key(x + dx, y + dy);
          const far = key(x + 2 * dx, y + 2 * dy);
          if (open.has(near) || open.has(far) || !reached.has(key(x + 3 * dx, y + 3 * dy)))
            continue;
          const dig = diggable(x + dx, y + dy)
            ? near
            : diggable(x + 2 * dx, y + 2 * dy)
              ? far
              : null;
          if (dig === null) continue;
          open.add(dig);
          changed = true;
        }
      }
      if (changed) reached = spread(pinned);
    }

    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    /** In a hill the floor lies on the hill's ground, which its edges show; underground there is nothing under it. */
    const floorAt = (x: number, y: number): PlacedTile[] =>
      underground
        ? [tile(props.floor)]
        : [tile(ctx.rampAt(x, y)?.ground ?? "grass-2"), tile(props.floor)];
    const edits: StackEdit[] = [];
    const walls = new Set<string>();
    /** The eight cells round a cell in order round it, so open cells that touch are neighbours in the list. */
    const RING = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ] as const;
    /**
     * A stalagmite is drawn leaning over the cells to its north and west, so
     * it stands only where those are floor. It stands against rock, and only
     * where the floor round it is one unbroken run, so it never blocks the
     * one way between two pieces of floor.
     */
    const takesProp = (x: number, y: number) => {
      if (props.prop === null || pinned.has(key(x, y))) return false;
      if (hashCell(x, y, ctx.seed ^ 0x57a1a6) % props.propEvery !== 0) return false;
      if (N8.some(([dx, dy]) => pinned.has(key(x + dx, y + dy)))) return false;
      const floor = RING.map(([dx, dy]) => reached.has(key(x + dx, y + dy)));
      const behind = floor[0] && floor[6] && floor[7];
      let runs = 0;
      for (let i = 0; i < floor.length; i++) if (floor[i] && !floor[(i + 7) % 8]) runs++;
      return !!behind && runs === 1 && floor.filter((f) => !f).length >= 2;
    };
    const propped = new Set<string>();
    for (const k of reached) {
      const { x, y } = cellOf(k);
      const stack = floorAt(x, y);
      const beside = N8.some(([dx, dy]) => propped.has(key(x + dx, y + dy)));
      if (!beside && takesProp(x, y)) {
        const facing = randomAt(x, y, ctx.seed) < 0.5 ? undefined : ("e" as const);
        stack.push(
          tile(
            props.prop!,
            ctx.tilesById[props.prop!]?.type === "directional" ? facing : undefined,
          ),
        );
        propped.add(k);
      }
      edits.push({ x, y, z, stack });
      for (const [dx, dy] of N8) {
        const wk = key(x + dx, y + dy);
        if (reached.has(wk) || walls.has(wk) || !isRock(x + dx, y + dy)) continue;
        walls.add(wk);
        const wall =
          underground || props.shape === CRYPT
            ? tile(props.wall)
            : ctx.stackAt(x + dx, y + dy, z).at(-1)!;
        edits.push({ x: x + dx, y: y + dy, z, stack: [...floorAt(x + dx, y + dy), wall] });
      }
    }
    /**
     * Below ground nothing is drawn where nothing is written, so rock the
     * cave closes round, with no floor beside it, would show as a hole down
     * through the level. Every cell no step from outside the frame reaches
     * without crossing floor or wall is walled as well.
     */
    if (underground) {
      const outside = new Set<string>();
      const queue: Cell[] = [];
      for (let x = minX - 1; x <= maxX + 1; x++) queue.push({ x, y: minY - 1 }, { x, y: maxY + 1 });
      for (let y = minY; y <= maxY; y++) queue.push({ x: minX - 1, y }, { x: maxX + 1, y });
      for (const c of queue) outside.add(key(c.x, c.y));
      for (let head = 0; head < queue.length; head++) {
        for (const [dx, dy] of N4) {
          const x = queue[head]!.x + dx;
          const y = queue[head]!.y + dy;
          const k = key(x, y);
          if (!inFrame(x, y) || outside.has(k) || reached.has(k) || walls.has(k)) continue;
          outside.add(k);
          queue.push({ x, y });
        }
      }
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const k = key(x, y);
          if (outside.has(k) || reached.has(k) || walls.has(k) || !isRock(x, y)) continue;
          walls.add(k);
          edits.push({ x, y, z, stack: [...floorAt(x, y), tile(props.rock)] });
        }
      }
    }
    for (const doorway of props.door ? (crypt?.doorways ?? []) : []) {
      const k = key(doorway.x, doorway.y);
      if (!reached.has(k) || pinned.has(k) || propped.has(k)) continue;
      const side = doorway.facing === "e" ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const shut = (x: number, y: number) =>
        walls.has(key(x, y)) ||
        (crypt!.doorways.some((d) => d.x === x && d.y === y) && reached.has(key(x, y)));
      if (
        !shut(doorway.x + side.x, doorway.y + side.y) ||
        !shut(doorway.x - side.x, doorway.y - side.y)
      ) {
        continue;
      }
      edits.push({
        x: doorway.x,
        y: doorway.y,
        z,
        stack: [...floorAt(doorway.x, doorway.y), tile(props.door!, doorway.facing)],
      });
    }
    for (const mouth of mouths) {
      const out = STEP[mouth.facing];
      const outside = ctx.stackAt(mouth.at.x + out.x, mouth.at.y + out.y, z)[0]!;
      edits.push({
        x: mouth.at.x,
        y: mouth.at.y,
        z,
        stack: [{ ...outside }, tile(props.floor), tile(props.mouth, mouth.facing)],
      });
    }
    /**
     * A flight faces the opposite way to the way it is climbed, and the two
     * cells over it are left empty: that is where a body climbs out
     * (`docs/notes.md`, "A ramp between two levels needs a hole above it").
     */
    for (const s of stairs) {
      const facing = OPPOSITE[s.climbs];
      for (const k of [0, 1]) {
        const low = flight(s, 0, k);
        const high = flight(s, 1, k);
        edits.push(
          { ...low, z, stack: [...floorAt(low.x, low.y), tile(props.steps, facing)] },
          {
            ...high,
            z,
            stack: [...floorAt(high.x, high.y), tile(STAIR_BLOCK), tile(props.steps, facing)],
          },
          { ...low, z: z + 1, stack: [] },
          { ...high, z: z + 1, stack: [] },
        );
      }
    }
    for (const ladder of ladders) {
      const above = ctx.stackAt(ladder.x, ladder.y, z + 1);
      edits.push(
        { ...ladder, z, stack: [...floorAt(ladder.x, ladder.y), tile(LADDER_UP)] },
        { ...ladder, z: z + 1, stack: [...above, tile(LADDER_TOP)] },
      );
    }
    return { ok: true, edits };
  },
};

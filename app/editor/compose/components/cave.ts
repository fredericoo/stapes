import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Direction, PlacedTile } from "../../../lib/types";
import { HEIGHT_PER_LEVEL } from "../../../lib/types";
import { CAVE_SHAPES, carveCave, type CaveConfig, type CaveShape } from "../../cave";
import { hashCell, isOpen, placed, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { isWet } from "./line";
import { STEP, type Cell } from "./ramp";

const SHAPES = CAVE_SHAPES.map((s) => s.id) as [CaveShape, ...CaveShape[]];

const CaveSchema = v.object({
  shape: v.optional(v.picklist(SHAPES), "caverns"),
  density: v.optional(field.percent(), 30),
  floor: v.optional(field.tile(TILES.ground), "dirt"),
  mouth: v.optional(field.tile(TILES.any), "hill-cave-mouth"),
  mouths: v.optional(field.points(), []),
  prop: v.optional(v.nullable(field.tile(TILES.standing)), "stalagmite"),
  propEvery: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 22),
});

export type CaveProps = v.InferOutput<typeof CaveSchema>;

const FACES: readonly Direction[] = ["s", "e", "w", "n"];
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

const key = (x: number, y: number) => `${x},${y}`;

/**
 * Digs one level of cave into the rock of the hills inside its frame, on the
 * level its frame is on, the way Rune Isle's hill caves are dug
 * (`docs/notes.md`, "`carve:hill-caves` digs only where a hill is rock above
 * the cave as well"). A cave cell has rock over it, not the hilltop's floor, which lets daylight
 * through anything standing on it, and two cells of rock to every side, so nothing shows from outside but the mouths: each of `mouths`
 * is a point, and the mouth goes on the nearest straight stretch of cliff that
 * has open ground in front of it, south and east faces first.
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
  build(ctx, props) {
    const z = ctx.z;
    const { minX, maxX, minY, maxY } = ctx.bounds;
    const inFrame = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const rock = new Map<string, boolean>();
    const isRock = (x: number, y: number) => {
      const k = key(x, y);
      let known = rock.get(k);
      if (known === undefined) {
        const stack = ctx.stackAt(x, y, z);
        const top = stack.at(-1);
        const def = top && ctx.tilesById[top.tileId];
        known =
          ctx.raisedAt(x, y) > z &&
          stack.length <= 2 &&
          !!def &&
          !top.direction &&
          def.walkable === false &&
          def.height === HEIGHT_PER_LEVEL;
        rock.set(k, known);
      }
      return known;
    };
    const open = new Set<string>();
    const pinned = new Set<string>();
    const isOpenAt = (x: number, y: number) => open.has(key(x, y));
    const diggable = (x: number, y: number) => {
      if (!inFrame(x, y) || !ctx.covered(x, y) || ctx.raisedAt(x, y) <= z + 1) return false;
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

    const mouths: Mouth[] = [];
    for (const point of props.mouths) {
      const near = ctx.point(point);
      const found = near && mouthNear(near);
      if (found && !mouths.some((m) => m.at.x === found.at.x && m.at.y === found.at.y)) {
        mouths.push(found);
      }
    }
    if (mouths.length === 0) {
      return {
        ok: false,
        reason:
          "There is no cliff here to open a cave mouth in. A cave needs at least two levels of hill above its own level, so its roof is rock and not the hilltop, and open ground at the foot of a straight stretch of its cliff.",
      };
    }

    const config = { seed: ctx.seed, shape: props.shape, density: props.density } as CaveConfig;
    const carved = carveCave(ctx.bounds, config);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (isOpen(carved, x, y) && diggable(x, y)) open.add(key(x, y));
      }
    }

    /**
     * Each tunnel is pinned open behind its mouth and then walked on through
     * diggable rock to the nearest cave cell, breadth first, two cells wide.
     */
    for (const mouth of mouths) {
      const out = STEP[mouth.facing];
      const side = SIDEWAYS[mouth.facing];
      for (let n = 1; n <= TUNNEL; n++) {
        for (const k of [0, 1]) {
          const cell = key(
            mouth.at.x + side.x * k - out.x * n,
            mouth.at.y + side.y * k - out.y * n,
          );
          pinned.add(cell);
        }
      }
      const start = { x: mouth.at.x - out.x * TUNNEL, y: mouth.at.y - out.y * TUNNEL };
      const from = new Map<string, Cell | null>([[key(start.x, start.y), null]]);
      const queue = [start];
      let end: Cell | null = null;
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
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          if (diggable(at.x + dx, at.y + dy)) open.add(key(at.x + dx, at.y + dy));
        }
      }
    }
    for (const cell of pinned) open.add(cell);

    /**
     * A floor cell outside every two-by-two square of floor is a passage one
     * cell wide, which a prop or a creature blocks; filling those back can
     * cut a piece off, so the pieces no tunnel reaches go after it.
     */
    const cellOf = (k: string): Cell => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return { x, y };
    };
    const square = (x: number, y: number) =>
      isOpenAt(x, y) && isOpenAt(x + 1, y) && isOpenAt(x, y + 1) && isOpenAt(x + 1, y + 1);
    for (let changed = true; changed;) {
      changed = false;
      for (const k of [...open]) {
        if (pinned.has(k)) continue;
        const { x, y } = cellOf(k);
        if (square(x, y) || square(x - 1, y) || square(x, y - 1) || square(x - 1, y - 1)) continue;
        open.delete(k);
        changed = true;
      }
    }
    const reached = new Set<string>(pinned);
    const walk = [...pinned].map(cellOf);
    for (let head = 0; head < walk.length; head++) {
      for (const [dx, dy] of N4) {
        const k = key(walk[head]!.x + dx, walk[head]!.y + dy);
        if (!open.has(k) || reached.has(k)) continue;
        reached.add(k);
        walk.push(cellOf(k));
      }
    }

    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const groundAt = (x: number, y: number) => tile(ctx.rampAt(x, y)?.ground ?? "grass-2");
    const edits: StackEdit[] = [];
    const walls = new Set<string>();
    /**
     * A stalagmite is drawn leaning over the cells to its north and west, so
     * it stands only where those are floor, and only against rock, where it
     * cannot split the floor in two.
     */
    const takesProp = (x: number, y: number) =>
      props.prop !== null &&
      !pinned.has(key(x, y)) &&
      [
        [0, -1],
        [-1, 0],
        [-1, -1],
      ].every(([dx, dy]) => reached.has(key(x + dx!, y + dy!))) &&
      (!reached.has(key(x + 1, y)) || !reached.has(key(x, y + 1))) &&
      !N8.some(([dx, dy]) => pinned.has(key(x + dx, y + dy))) &&
      hashCell(x, y, ctx.seed ^ 0x57a1a6) % props.propEvery === 0;
    const propped = new Set<string>();
    for (const k of reached) {
      const { x, y } = cellOf(k);
      const stack: PlacedTile[] = [groundAt(x, y), tile(props.floor)];
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
        const wall = ctx.stackAt(x + dx, y + dy, z).at(-1)!;
        edits.push({
          x: x + dx,
          y: y + dy,
          z,
          stack: [groundAt(x + dx, y + dy), tile(props.floor), wall],
        });
      }
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
    return { ok: true, edits };
  },
};

import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight, type PlacedTile } from "../../../lib/types";
import type { Direction } from "../../../lib/types";
import { ACCESS, DEFAULT_STAIRS_TILE_ID, stairBlock } from "../../building";
import { placed, randomAt, valueNoise } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { isWet } from "./line";

const DeckSchema = v.object({
  floor: v.optional(field.tile(TILES.ground), "wooden-floor"),
  pole: v.optional(v.nullable(field.tile(TILES.any)), "fence"),
  poleEvery: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(8)), 3),
  reachedBy: v.optional(v.picklist(ACCESS), "ladder"),
  stairs: v.optional(field.tile(TILES.stairs), DEFAULT_STAIRS_TILE_ID),
  way: v.optional(field.point(), { x: 1, y: 0, pinY: "bottom" }),
  decay: v.optional(field.percent(), 0),
});

export type DeckProps = v.InferOutput<typeof DeckSchema>;

const LADDER_UP = "ladder-up";
const LADDER_TOP = "ladder-top";
const MOSS = "moss-top";
const FALLEN = "wreck-planks";
const DEEP_WATER = "deep-water";

/** Cells across a patch of moss, so the boards green in patches rather than in specks. */
const MOSS_SCALE = 3;

/**
 * Independent rolls for one cell, each a different salt on the same seed, so
 * whether a cell is a hole does not also decide whether its edge is ragged.
 */
const ROLL = {
  hole: 0,
  spread: 101,
  pole: 202,
  snap: 303,
  ragged: 404,
  moss: 505,
  fallen: 606,
} as const;

const NEAR = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => [dx, dy] as const));
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** The side a flight of stairs leaves the deck by, south first because that side of the deck is in view. */
const OUTWARD: ReadonlyArray<{ facing: Direction; dx: number; dy: number }> = [
  { facing: "s", dx: 0, dy: 1 },
  { facing: "w", dx: -1, dy: 0 },
  { facing: "e", dx: 1, dy: 0 },
  { facing: "n", dx: 0, dy: -1 },
];

const at = (x: number, y: number) => `${x},${y}`;

/**
 * A deck of boards one level up over its frame, on poles spaced round its
 * edge, climbed at `way` by a ladder, or by a flight of `stairs` two cells
 * long that runs off the deck's edge there. Each pole is two pieces of `pole`,
 * one on the ground under the deck and one on the deck above it, and no two
 * stand side by side, so each reads as a post rather than a fence. Every board
 * on the edge also gets the floor's `-inner` tile, so the deck covers whole
 * cells. `decay` breaks holes through it, snaps and takes out poles, leaves
 * some boards round a hole cut short and greens the rest with moss; the boards
 * left always join up, so the whole deck is walked from the way up.
 */
export const deck: Component<DeckProps> = {
  type: "deck",
  label: "Deck",
  starter: { frame: { x: 2, y: 2, w: 12, h: 3 } },
  schema: DeckSchema,
  ownLevels: true,
  build(ctx, props) {
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const raised = ctx.raisedAt(minX, minY);
    const cells = new Set<string>();
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!ctx.covered(x, y)) continue;
        if (ctx.raisedAt(x, y) !== raised) {
          return {
            ok: false,
            reason:
              "The ground under this deck is on more than one level. Move it onto flat ground or water.",
          };
        }
        cells.add(at(x, y));
      }
    }
    const ground = ctx.z + raised;
    const top = ground + 1;
    const way = ctx.point(props.way);
    if (!way || !cells.has(at(way.x, way.y))) {
      return { ok: false, reason: "The way up is not on the deck. Move it inside the frame." };
    }
    const standable = (x: number, y: number) => {
      const stack = ctx.stackAt(x, y, ground);
      const wades = isWet(stack) && !stack.some((p) => p.tileId === DEEP_WATER);
      const foot = stack.at(-1);
      return foot !== undefined && (wades || ctx.tilesById[foot.tileId]?.walkable !== false);
    };
    /** A flight's lower stair is two cells out from the deck and its upper one, on a half block, beside the deck. */
    const flight =
      props.reachedBy === "stairs"
        ? OUTWARD.map(({ facing, dx, dy }) => ({
            facing,
            high: { x: way.x + dx, y: way.y + dy },
            low: { x: way.x + dx * 2, y: way.y + dy * 2 },
          })).find(({ high, low }) =>
            [high, low].every(
              (c) =>
                !cells.has(at(c.x, c.y)) &&
                ctx.raisedAt(c.x, c.y) === raised &&
                standable(c.x, c.y) &&
                ctx.stackAt(c.x, c.y, top).length === 0,
            ),
          )
        : undefined;
    if (props.reachedBy === "stairs" && !flight) {
      return {
        ok: false,
        reason: `There is no room for stairs off the deck at ${way.x},${way.y}. They need two cells of flat ground or shallow water beside its edge.`,
      };
    }
    if (props.reachedBy === "ladder" && !standable(way.x, way.y)) {
      return {
        ok: false,
        reason: `There is nothing to stand on at the foot of the ladder at ${way.x},${way.y}.`,
      };
    }
    for (const key of cells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (ctx.stackAt(x, y, top).length > 0) {
        return { ok: false, reason: `Something is already at ${x},${y} on z${top}` };
      }
    }

    const decay = props.decay / 100;
    const roll = (x: number, y: number, salt: number) => randomAt(x, y, ctx.seed + salt);
    const byWay = (x: number, y: number) => Math.max(Math.abs(x - way.x), Math.abs(y - way.y)) <= 1;

    /**
     * A pole on every corner and every `poleEvery` cells along each side,
     * skipped on the way up and beside another pole, because a fence
     * joins up with the fence next to it.
     */
    const poles = new Set<string>();
    if (props.pole) {
      const onSide = (n: number, from: number, to: number) =>
        n === to || (n - from) % props.poleEvery === 0;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const edgeX = x === minX || x === maxX;
          const edgeY = y === minY || y === maxY;
          const wanted = (edgeX && onSide(y, minY, maxY)) || (edgeY && onSide(x, minX, maxX));
          if (!wanted || !cells.has(at(x, y)) || (x === way.x && y === way.y)) continue;
          if (NEAR.some(([dx, dy]) => poles.has(at(x + dx, y + dy)))) continue;
          poles.add(at(x, y));
        }
      }
    }
    /** A decayed pole is snapped off at the deck, or gone from the ground up. */
    const poleFate = (x: number, y: number): "whole" | "snapped" | "gone" => {
      const r = roll(x, y, ROLL.pole);
      if (r < decay * 0.3) return "gone";
      if (r < decay * 0.6) return "snapped";
      return "whole";
    };
    const upright = new Set(
      [...poles].filter((key) => {
        const [x, y] = key.split(",").map(Number) as [number, number];
        return poleFate(x, y) === "whole";
      }),
    );

    /**
     * A hole starts on a few boards and spreads to the boards beside them, so
     * holes come in ragged patches rather than single cells. Each is only
     * kept while every board left can still be walked to from the way up,
     * walking round the poles that stand on the deck.
     */
    const holes = new Set<string>();
    const joined = () => {
      const open = (key: string) => cells.has(key) && !holes.has(key) && !upright.has(key);
      const start = at(way.x, way.y);
      const seen = new Set([start]);
      const queue = [way];
      for (let head = 0; head < queue.length; head++) {
        const { x, y } = queue[head]!;
        for (const [dx, dy] of SIDES) {
          const key = at(x + dx, y + dy);
          if (seen.has(key) || !open(key)) continue;
          seen.add(key);
          queue.push({ x: x + dx, y: y + dy });
        }
      }
      return [...cells].every((key) => !open(key) || seen.has(key));
    };
    const tryHole = (x: number, y: number) => {
      const key = at(x, y);
      if (!cells.has(key) || holes.has(key) || poles.has(key) || byWay(x, y)) return false;
      holes.add(key);
      if (joined()) return true;
      holes.delete(key);
      return false;
    };
    if (decay > 0) {
      const seeds: Array<{ x: number; y: number }> = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (roll(x, y, ROLL.hole) < decay * 0.2 && tryHole(x, y)) seeds.push({ x, y });
        }
      }
      for (const { x, y } of seeds) {
        for (const [dx, dy] of SIDES) {
          if (roll(x + dx, y + dy, ROLL.spread) < decay * 0.5) tryHole(x + dx, y + dy);
        }
      }
    }

    const boards = (key: string) => cells.has(key) && !holes.has(key);
    const floor = placed(props.floor, ctx.tilesById);
    const innerId = `${props.floor}-inner`;
    const inner = ctx.tilesById[innerId] ? placed(innerId, ctx.tilesById) : null;
    const pole: PlacedTile | null = props.pole ? { tileId: props.pole } : null;
    /** Pieces of `pole` stacked from the ground to the deck, so the post below reaches the boards. */
    const stilt: PlacedTile[] = pole
      ? Array.from(
          {
            length: Math.max(
              1,
              Math.round(HEIGHT_PER_LEVEL / physicalHeight(ctx.tilesById[pole.tileId]!)),
            ),
          },
          () => pole,
        )
      : [];
    const edits: StackEdit[] = [];

    for (const key of cells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const below = ctx.stackAt(x, y, ground);
      const standsOn =
        below.length > 0 &&
        (isWet(below) || ctx.tilesById[below.at(-1)!.tileId]?.walkable !== false);
      const fate = poles.has(key) ? poleFate(x, y) : null;

      if (holes.has(key)) {
        if (standsOn && isWet(below) && roll(x, y, ROLL.fallen) < 0.5) {
          edits.push({ x, y, z: ground, stack: [...below, { tileId: FALLEN }] });
        }
        continue;
      }
      if (pole && fate && fate !== "gone" && standsOn) {
        edits.push({ x, y, z: ground, stack: [...below, ...stilt] });
      }
      const ladderHere = props.reachedBy === "ladder" && x === way.x && y === way.y;
      if (ladderHere) {
        edits.push({ x, y, z: ground, stack: [...below, { tileId: LADDER_UP }] });
      }

      /**
       * A board with an edge gets the `-inner` tile that fills the half cell
       * the floor cuts away there. Decay leaves some without it: round a hole
       * often, so the boards look snapped short, and on the outer edge less.
       */
      const column: PlacedTile[] = [floor];
      const besideHole = NEAR.some(([dx, dy]) => holes.has(at(x + dx, y + dy)));
      const onEdge = NEAR.some(([dx, dy]) => !boards(at(x + dx, y + dy)));
      const ragged = roll(x, y, ROLL.ragged) < decay * (besideHole ? 0.7 : 0.25);
      if (inner && onEdge && (byWay(x, y) || !ragged)) column.push(inner);
      const mossy =
        valueNoise(x, y, ctx.seed + ROLL.moss, MOSS_SCALE) * 0.5 + roll(x, y, ROLL.moss) * 0.5 <
        decay * 0.6;
      if (mossy && !(x === way.x && y === way.y)) column.push({ tileId: MOSS });
      if (pole && fate === "whole") column.push(pole);
      if (ladderHere) column.push({ tileId: LADDER_TOP });
      edits.push({ x, y, z: top, stack: column });
    }
    if (flight) {
      const stair = placed(props.stairs, ctx.tilesById, flight.facing);
      const block: PlacedTile = { tileId: stairBlock(props.stairs, ctx.tilesById) };
      const { high, low } = flight;
      edits.push(
        { ...high, z: ground, stack: [...ctx.stackAt(high.x, high.y, ground), block, stair] },
        { ...low, z: ground, stack: [...ctx.stackAt(low.x, low.y, ground), stair] },
      );
    }
    return { ok: true, edits };
  },
};

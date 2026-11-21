import * as v from "valibot";
import { DEFAULT_STAIRS_TILE_ID, stairBlock } from "../../building";
import type { StackEdit } from "../../../lib/mapData";
import { MAX_LEVEL, type Direction, type PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { Component } from "../build";
import type { MapNode } from "../doc";
import { TILES, field } from "../field";
import { isWet } from "./line";

export const LIGHTHOUSE_TYPE = "lighthouse";
export const TIER_TYPE = "tier";

const FINISHES = ["rubble", "limewashed"] as const;
const WALL_OF = { rubble: "lighthouse-wall", limewashed: "lighthouse-wall-limewashed" } as const;
const LEDGE = "lighthouse-ledge";
const PARAPET = "lighthouse-parapet";
const ARCADE = "lighthouse-arcade";
const ROOF = "lighthouse-roof";
const ROOF_SIDE = 3;

/** The top platform holds the 3×3 arcade, a walk round it and the parapet, and a flight needs two cells inside the wall. */
const MIN_HALF_WIDTH = 4;
const STAIR_INSET = 2;
const SLIT_OFFSETS = [0, 2];

const LighthouseSchema = v.object({
  door: v.optional(field.direction(), "s"),
  floor: v.optional(field.tile(TILES.ground), "flagstone-floor"),
  stairs: v.optional(field.tile(TILES.stairs), DEFAULT_STAIRS_TILE_ID),
  setback: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)), 2),
  beacon: v.optional(v.nullable(field.tile(TILES.any)), "wyrd"),
  crown: v.optional(v.boolean(), true),
});

export type LighthouseProps = v.InferOutput<typeof LighthouseSchema>;

const TierSchema = v.object({
  storeys: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)), 4),
  finish: v.optional(v.picklist(FINISHES), "rubble"),
  slits: v.optional(v.boolean(), true),
});

type TierProps = v.InferOutput<typeof TierSchema>;

type Spot = { x: number; y: number };

const N4: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** An octagon of half-width `r` about 0,0: a square with each corner cut on the diagonal. */
const diagonal = (r: number) => r + Math.floor(r / 2);
const inside = (r: number, x: number, y: number) =>
  Math.max(Math.abs(x), Math.abs(y)) <= r && Math.abs(x) + Math.abs(y) <= diagonal(r);
const onEdge = (r: number, x: number, y: number) =>
  N4.some(([dx, dy]) => !inside(r, x + dx, y + dy));

/** The corner tile's facing for the quadrant a cell is in: `n` is north-east, `e` south-east, `s` south-west, `w` north-west. */
const quadrant = (x: number, y: number): Direction =>
  x > 0 ? (y < 0 ? "n" : "e") : y > 0 ? "s" : "w";

/** A quarter turn clockwise about the tower's centre, `k` times. */
const turn = (p: Spot, k: number): Spot => {
  let { x, y } = p;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return { x, y };
};

const TURNS_FROM_SOUTH: Record<Direction, number> = { s: 0, w: 1, n: 2, e: 3 };
const CLIMBED_FACING: Direction[] = ["s", "w", "n", "e"];

/**
 * How many levels above its lighthouse's ground each tier starts, which is
 * the level the editor cuts the view to when the tier is selected.
 */
export function tierLevels(lighthouse: MapNode): Map<string, number> {
  const levels = new Map<string, number>();
  let from = 0;
  for (const child of lighthouse.children ?? []) {
    if (child.hidden || child.type !== TIER_TYPE) continue;
    levels.set(child.key, from);
    const parsed = v.safeParse(TierSchema, child.props ?? {});
    from += parsed.success ? parsed.output.storeys : 0;
  }
  return levels;
}

/**
 * An octagonal tower as wide as the shorter side of its frame, built from its
 * Tier children in order from the ground up. Each tier is `setback` cells
 * narrower a side than the one below and leaves a walkway on the wider one.
 * A flight climbs each storey a quarter turn further round than the last, and
 * the top is a platform with a parapet and, as its crown, an arcade round the
 * beacon under a roof.
 */
export const lighthouse: Component<LighthouseProps> = {
  type: LIGHTHOUSE_TYPE,
  label: "Lighthouse",
  starter: {
    frame: { x: 2, y: 2, w: 17, h: 17 },
    children: [
      { type: TIER_TYPE, props: { storeys: 4, finish: "rubble" } },
      { type: TIER_TYPE, props: { storeys: 6, finish: "limewashed" } },
      { type: TIER_TYPE, props: { storeys: 4, finish: "rubble" } },
    ],
  },
  schema: LighthouseSchema,
  ownLevels: true,
  parts: [TIER_TYPE],
  partLevels: tierLevels,
  build(ctx, props) {
    const tiers = ctx.parts.map((part) => part.props as TierProps);
    if (tiers.length === 0) {
      return {
        ok: false,
        reason: "This lighthouse has no tier to build. Add a Tier layer inside it.",
      };
    }
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const base = Math.floor(Math.min(maxX - minX, maxY - minY) / 2);
    const top = base - (tiers.length - 1) * props.setback;
    if (top < MIN_HALF_WIDTH) {
      const side = (MIN_HALF_WIDTH + (tiers.length - 1) * props.setback) * 2 + 1;
      return {
        ok: false,
        reason: `The top tier would be too narrow to climb. Make the frame at least ${side}×${side}, or use fewer tiers or a smaller setback.`,
      };
    }
    const centre = { x: minX + base, y: minY + base };
    const z0 = ctx.z + ctx.raisedAt(centre.x, centre.y);
    const platform = tiers.reduce((sum, tier) => sum + tier.storeys, 0);
    if (z0 + platform + 1 > MAX_LEVEL) {
      return { ok: false, reason: `The lighthouse would pass z${MAX_LEVEL}` };
    }

    const ground = new Map<string, PlacedTile>();
    for (let y = -base; y <= base; y++) {
      for (let x = -base; x <= base; x++) {
        if (!inside(base, x, y)) continue;
        const at = { x: centre.x + x, y: centre.y + y };
        if (ctx.z + ctx.raisedAt(at.x, at.y) !== z0) {
          return {
            ok: false,
            reason:
              "The ground under this lighthouse is on more than one level. Move it onto flat ground, or put it before the hill in the layers so the hill is raised round it.",
          };
        }
        const stack = ctx.stackAt(at.x, at.y, z0);
        if (stack.length === 0 || isWet(stack)) {
          return {
            ok: false,
            reason:
              "Part of this lighthouse is over water or off the land. Move it onto dry ground.",
          };
        }
        ground.set(`${x},${y}`, stack[0]!);
      }
    }

    const storeys = tiers.flatMap((tier, index) =>
      Array.from({ length: tier.storeys }, (_, nth) => ({
        tier,
        r: base - index * props.setback,
        below: nth === 0 && index > 0 ? base - (index - 1) * props.setback : null,
      })),
    );
    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const floor = tile(props.floor);
    const cells = new Map<string, PlacedTile[]>();
    const put = (x: number, y: number, level: number, stack: PlacedTile[]) => {
      const under = level === 0 ? [ground.get(`${x},${y}`)!] : [];
      cells.set(`${x},${y},${level}`, [...under, ...stack]);
    };

    const flights = storeys.map((storey, level) => {
      const a = Math.min(storey.r, storeys[level + 1]?.r ?? top) - STAIR_INSET;
      return {
        level,
        low: turn({ x: a, y: 1 }, level),
        high: turn({ x: a, y: 0 }, level),
        facing: CLIMBED_FACING[level % 4]!,
      };
    });
    const holes = new Set(
      flights.flatMap((f) => [f.low, f.high].map((p) => `${p.x},${p.y},${f.level + 1}`)),
    );
    const door = turn({ x: 0, y: base }, TURNS_FROM_SOUTH[props.door]);

    storeys.forEach(({ tier, r, below }, level) => {
      const wall = WALL_OF[tier.finish];
      const reach = below ?? r;
      for (let y = -reach; y <= reach; y++) {
        for (let x = -reach; x <= reach; x++) {
          if (!inside(r, x, y)) {
            if (below === null || !inside(below, x, y)) continue;
            put(x, y, level, onEdge(below, x, y) ? [floor, tile(LEDGE)] : [floor]);
          } else if (!onEdge(r, x, y)) {
            if (!holes.has(`${x},${y},${level}`)) put(x, y, level, [floor]);
          } else if (Math.abs(x) + Math.abs(y) === diagonal(r)) {
            put(x, y, level, [tile(`${wall}-corner`, quadrant(x, y))]);
          } else if (level === 0 && x === door.x && y === door.y) {
            put(x, y, level, [tile(`${wall}-doorway`, door.x === 0 ? "n" : "e")]);
          } else {
            const along = Math.abs(Math.abs(x) === r ? y : x);
            const slit = tier.slits && level % 2 === 1 && SLIT_OFFSETS.includes(along);
            put(x, y, level, [
              slit ? tile(`${wall}-slit`, Math.abs(x) === r ? "e" : "n") : tile(wall),
            ]);
          }
        }
      }
    });
    for (const { level, low, high, facing } of flights) {
      const step = tile(props.stairs, facing);
      put(low.x, low.y, level, [floor, step]);
      put(high.x, high.y, level, [floor, tile(stairBlock(props.stairs, ctx.tilesById)), step]);
    }

    for (let y = -top; y <= top; y++) {
      for (let x = -top; x <= top; x++) {
        if (!inside(top, x, y) || holes.has(`${x},${y},${platform}`)) continue;
        const ring = Math.max(Math.abs(x), Math.abs(y));
        if (ring === 0 && props.beacon) put(x, y, platform, [floor, tile(props.beacon)]);
        else if (ring === 1 && props.crown) put(x, y, platform, [floor, tile(ARCADE)]);
        else put(x, y, platform, onEdge(top, x, y) ? [floor, tile(PARAPET)] : [floor]);
      }
    }
    if (props.crown) {
      const reach = (ROOF_SIDE - 1) / 2;
      const id = `roof${centre.x}_${centre.y}_${z0 + platform + 1}`;
      for (let y = -reach; y <= reach; y++) {
        for (let x = -reach; x <= reach; x++) {
          put(x, y, platform + 1, [{ ...tile(ROOF), span: { id, dx: reach - x, dy: reach - y } }]);
        }
      }
    }

    const edits: StackEdit[] = [];
    for (const [key, stack] of cells) {
      const [x, y, level] = key.split(",").map(Number) as [number, number, number];
      const at = { x: centre.x + x, y: centre.y + y, z: z0 + level };
      if (level > 0 && ctx.stackAt(at.x, at.y, at.z).length > 0) {
        return { ok: false, reason: `Something is already at ${at.x},${at.y} on z${at.z}` };
      }
      edits.push({ ...at, stack });
    }
    return { ok: true, edits };
  },
};

export const tier: Component<TierProps> = {
  type: TIER_TYPE,
  label: "Tier",
  starter: {},
  schema: TierSchema,
  within: [LIGHTHOUSE_TYPE],
  build: () => ({ ok: true, edits: [] }),
};

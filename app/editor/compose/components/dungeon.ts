import * as v from "valibot";
import { getStack, setStacks, type StackEdit } from "../../../lib/mapData";
import type { PlacedTile, TileDef } from "../../../lib/types";
import { isWet } from "./line";
import type { Component } from "../build";
import type { MapNode } from "../doc";
import { field } from "../field";
import { CaveSchema, cave } from "./cave";
import {
  CHASM_TYPE,
  cutChasm,
  openOntoLedges,
  planChasm,
  pourCascades,
  type ChasmPlan,
  type ChasmProps,
} from "./chasm";

export const DUNGEON_TYPE = "dungeon";
export const LEVEL_TYPE = "level";

const DungeonSchema = v.object({});

type DungeonProps = v.InferOutput<typeof DungeonSchema>;

const WAYS = ["stairs", "ramp", "ladder"] as const;
/** A ramp is laid as a flight is, in the ramp tile in place of the level's steps. */
const RAMP_TILE = "ramp";

const { mouths: _m, stairs: _s, ladders: _l, ...shared } = CaveSchema.entries;

const LevelSchema = v.object({
  ...shared,
  /** Where the way up to the level above goes; the nearest place it fits is used. */
  up: v.optional(field.point(), { x: 0, y: 0, pinX: "center", pinY: "center" }),
  upBy: v.optional(v.picklist(WAYS), "stairs"),
});

type LevelProps = v.InferOutput<typeof LevelSchema>;

/**
 * How many levels below the dungeon's own each Level child is dug: the first
 * on the dungeon's level, each one after it a level deeper. The dungeon and
 * the editor both read it, so the level a cave is dug on and the level the
 * editor cuts the view to cannot differ.
 */
export function dungeonLevels(dungeon: MapNode): Map<string, number> {
  const levels = new Map<string, number>();
  (dungeon.children ?? [])
    .filter((c) => !c.hidden && c.type === LEVEL_TYPE)
    .forEach((c, i) => levels.set(c.key, -i));
  for (const c of dungeon.children ?? []) if (c.type === CHASM_TYPE) levels.set(c.key, 1);
  return levels;
}

/**
 * Caves stacked one level apart, dug top down as one plan: each Level is a
 * cave on its own level, with stairs or a ladder up to the level above it.
 * The first climbs to whatever is over the dungeon's level, the surface for
 * a dungeon below ground, and on level 0 or above, inside a hill, its way up
 * is a mouth in the nearest cliff instead.
 *
 * A Chasm part is cut before any level is dug, so every cave keeps its rock
 * shell off the chasm and no flight of stairs is placed where the chasm
 * would take it away. Once the levels are dug, each is joined to its ledge
 * by a tunnel, and the cascades are poured.
 */
export const dungeon: Component<DungeonProps> = {
  type: DUNGEON_TYPE,
  label: "Dungeon",
  starter: {
    frame: { x: 2, y: 2, w: 40, h: 30, z: -1 },
    children: [
      { type: LEVEL_TYPE, props: { shape: "crypt" } },
      { type: LEVEL_TYPE, props: { shape: "caverns" } },
    ],
  },
  schema: DungeonSchema,
  shapesItself: true,
  ownLevels: true,
  parts: [LEVEL_TYPE, CHASM_TYPE],
  partLevels: dungeonLevels,
  build(ctx) {
    const levels = ctx.parts.filter((p) => p.type === LEVEL_TYPE);
    if (levels.length === 0) {
      return {
        ok: false,
        reason: "This dungeon has no level to dig. Add a Level layer inside it.",
      };
    }
    let map = ctx.map;
    const edits: StackEdit[] = [];
    const lay = () => ({ map, tilesById: ctx.tilesById, z: ctx.z, raisedAt: ctx.raisedAt });
    const chasms: Array<{ plan: ChasmPlan; part: (typeof ctx.parts)[number] }> = [];
    for (const part of ctx.parts.filter((p) => p.type === CHASM_TYPE)) {
      const plan = planChasm(part.bounds, part.seed, part.props as ChasmProps, levels.length);
      if ("reason" in plan) return { ok: false, reason: plan.reason };
      chasms.push({ plan, part });
      const cut = cutChasm(lay(), plan);
      map = setStacks(map, cut);
      edits.push(...cut);
    }
    const floors: Array<Set<string>> = [];
    for (const [i, part] of levels.entries()) {
      const { up, upBy, ...own } = part.props as LevelProps;
      const z = ctx.z - i;
      const way = i === 0 && z >= 0 ? "mouths" : upBy === "ladder" ? "ladders" : "stairs";
      const steps = upBy === "ramp" ? RAMP_TILE : own.steps;
      const props = v.parse(CaveSchema, { ...own, steps, [way]: [up] });
      const current = map;
      const plan = cave.build(
        {
          ...ctx,
          map: current,
          z,
          seed: part.seed,
          stackAt: (x, y, level = z) => getStack(current, x, y, level),
          point: part.point,
          parts: [],
        },
        props,
      );
      if (!plan.ok) return { ok: false, reason: `Level ${i + 1}: ${plan.reason}` };
      map = setStacks(map, plan.edits);
      edits.push(...plan.edits);
      floors.push(
        new Set(
          plan.edits
            .filter((e) => e.z === z && e.stack.length > 0 && isFloor(e.stack, ctx.tilesById))
            .map((e) => `${e.x},${e.y}`),
        ),
      );
    }
    for (const { plan, part } of chasms) {
      const poured = pourCascades(lay(), plan, plan.props.cascades, part.point);
      map = setStacks(map, poured);
      edits.push(...poured);
      const opened = openOntoLedges(lay(), plan, floors);
      map = setStacks(map, opened);
      edits.push(...opened);
    }
    return { ok: true, edits };
  },
};

function isFloor(stack: readonly PlacedTile[], tilesById: Record<string, TileDef>): boolean {
  return stack.every((p) => {
    const def = tilesById[p.tileId];
    return def?.height === 0 && def.walkable !== false && !isWet([p]);
  });
}

export const level: Component<LevelProps> = {
  type: LEVEL_TYPE,
  label: "Level",
  starter: {},
  schema: LevelSchema,
  within: [DUNGEON_TYPE],
  build: () => ({ ok: true, edits: [] }),
};

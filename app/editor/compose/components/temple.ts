import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight, type PlacedTile } from "../../../lib/types";
import { HALF_LEVEL, placed, randomAt, type Bounds } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

export const TEMPLE_BASES = ["none", "step", "podium"] as const;
export const TEMPLE_ROOFS = ["flat", "gabled", "open"] as const;

const TempleSchema = v.object({
  height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 3),
  gap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2)), 1),
  base: v.optional(v.picklist(TEMPLE_BASES), "podium"),
  roof: v.optional(v.picklist(TEMPLE_ROOFS), "flat"),
  worn: v.optional(field.percent(), 0),
  floor: v.optional(field.tile(TILES.ground), "flagstone-floor"),
  block: v.optional(field.tile(TILES.any), "marble-block"),
});

export type TempleProps = v.InferOutput<typeof TempleSchema>;

const BOTTOM = "marble-pillar-bottom";
const MIDDLE = "marble-pillar-middle";
const TOP = "marble-pillar-top";

const CRACKED: Record<string, readonly string[]> = {
  [BOTTOM]: ["marble-pillar-bottom-cracked"],
  [MIDDLE]: ["marble-pillar-middle-cracked", "marble-pillar-middle-cracked-2"],
  [TOP]: ["marble-pillar-top-cracked"],
};

/** What a road laid afterwards climbs onto the podium by, where it does not meet the step. */
const RAMP_TILE_ID = "stone-stairs";

/** Cells in from the eaves for each half block the gable rises, which keeps it as shallow as a pediment. */
const GABLE_RUN = 2;

/**
 * The cells of the frame the colonnade stands on. A podium keeps a ring of the
 * frame round it for its step. Each side is then shortened until it is a whole
 * number of bays, because a pillar stands on every corner and a leftover cell
 * would make one bay wider than the rest. What is cut comes off both ends.
 */
export function templeFootprint(frame: Bounds, gap: number, ring: number): Bounds | null {
  const bay = gap + 1;
  const spareX = (frame.maxX - frame.minX - ring * 2) % bay;
  const spareY = (frame.maxY - frame.minY - ring * 2) % bay;
  const out = {
    minX: frame.minX + ring + Math.floor(spareX / 2),
    maxX: frame.maxX - ring - Math.ceil(spareX / 2),
    minY: frame.minY + ring + Math.floor(spareY / 2),
    maxY: frame.maxY - ring - Math.ceil(spareY / 2),
  };
  return out.maxX - out.minX >= bay && out.maxY - out.minY >= bay ? out : null;
}

/**
 * A colonnade round a stone floor with a roof of stone blocks on top: pillars
 * on every corner and every `gap` cells between, `height` levels tall, and
 * nothing between them, so it is walked into from any side. On a `podium` the
 * floor is a level up, and a ring of half blocks round it is the step that
 * climbs there; the podium is declared as raised ground, so a tile placed
 * inside afterwards stands on the floor. Like a house it stands on one level
 * only and is refused on uneven ground.
 */
export const temple: Component<TempleProps> = {
  type: "temple",
  label: "Temple",
  starter: { frame: { x: 2, y: 2, w: 9, h: 13 } },
  schema: TempleSchema,
  ownLevels: true,
  build(ctx, props) {
    const frame = ctx.bounds;
    const raised = ctx.raisedAt(frame.minX, frame.minY);
    for (let y = frame.minY; y <= frame.maxY; y++) {
      for (let x = frame.minX; x <= frame.maxX; x++) {
        if (ctx.raisedAt(x, y) === raised) continue;
        return {
          ok: false,
          reason:
            "The ground under this temple is on more than one level. Move it onto flat ground, or put it before the hill in the layers so the hill is raised round it.",
        };
      }
    }
    const blockDef = ctx.tilesById[props.block]!;
    if (physicalHeight(blockDef) !== HALF_LEVEL || blockDef.walkable === false) {
      return {
        ok: false,
        reason: `block: ${blockDef.name} is not a half block that can be stood on. Pick one like Marble block.`,
      };
    }
    const podium = props.base === "podium";
    const ring = podium ? 1 : 0;
    const site = templeFootprint(frame, props.gap, ring);
    if (!site) {
      const need = props.gap + 2 + ring * 2;
      return {
        ok: false,
        reason: `This frame is too small for a temple. Make it at least ${need} cells each way.`,
      };
    }

    const ground = ctx.z + raised;
    const roofLevel = ground + (podium ? 1 : 0) + props.height;
    const block: PlacedTile = { tileId: props.block };
    const floor = placed(props.floor, ctx.tilesById);
    const under = (x: number, y: number) =>
      ctx.stackAt(x, y, ground).filter((p) => {
        const def = ctx.tilesById[p.tileId];
        return def !== undefined && TILES.ground.test(def);
      });
    const bay = props.gap + 1;
    const pillarAt = (x: number, y: number) => {
      const onX = (x - site.minX) % bay === 0;
      const onY = (y - site.minY) % bay === 0;
      if (x === site.minX || x === site.maxX) return onY;
      if (y === site.minY || y === site.maxY) return onX;
      return false;
    };
    const segment = (id: string, x: number, y: number, nth: number): PlacedTile => {
      const roll = randomAt(x, y, ctx.seed + nth);
      if (roll * 100 >= props.worn) return { tileId: id };
      const cracked = CRACKED[id]!;
      return { tileId: cracked[Math.floor((roll * 100 * cracked.length) / props.worn)]! };
    };

    const edits: StackEdit[] = [];
    const levels = new Map<number, PlacedTile[]>();
    /** Stands `tiles` on what is already in the cell from `level` up, starting a new level whenever one is full. */
    const pile = (x: number, y: number, level: number, tiles: readonly PlacedTile[]) => {
      let z = level;
      for (const tile of tiles) {
        const size = physicalHeight(ctx.tilesById[tile.tileId]!);
        let stack = levels.get(z) ?? [];
        const used = stack.reduce((sum, p) => sum + physicalHeight(ctx.tilesById[p.tileId]!), 0);
        if (used === HEIGHT_PER_LEVEL || used + size > HEIGHT_PER_LEVEL) {
          z++;
          stack = levels.get(z) ?? [];
        }
        levels.set(z, [...stack, tile]);
      }
      for (const [at, stack] of levels) edits.push({ x, y, z: at, stack });
      levels.clear();
    };

    const ridgeAlongX = site.maxX - site.minX >= site.maxY - site.minY;
    for (let y = site.minY; y <= site.maxY; y++) {
      for (let x = site.minX; x <= site.maxX; x++) {
        const column: PlacedTile[] = [...under(x, y)];
        if (podium) column.push(block, block);
        if (props.base === "step") column.push(block);
        column.push(floor);
        if (pillarAt(x, y)) {
          const units = props.height * HEIGHT_PER_LEVEL - (props.base === "step" ? HALF_LEVEL : 0);
          const count = units / HALF_LEVEL;
          for (let i = 0; i < count; i++) {
            const id = i === 0 ? BOTTOM : i === count - 1 ? TOP : MIDDLE;
            column.push(segment(id, x, y, i));
          }
        }
        pile(x, y, ground, column);
        if (props.roof === "open") continue;
        const inset = ridgeAlongX
          ? Math.min(y - site.minY, site.maxY - y)
          : Math.min(x - site.minX, site.maxX - x);
        const courses = props.roof === "gabled" ? 1 + Math.floor(inset / GABLE_RUN) : 1;
        pile(
          x,
          y,
          roofLevel,
          Array.from({ length: courses }, () => block),
        );
      }
    }

    if (podium) {
      for (let y = site.minY - 1; y <= site.maxY + 1; y++) {
        for (let x = site.minX - 1; x <= site.maxX + 1; x++) {
          const inside = x >= site.minX && x <= site.maxX && y >= site.minY && y <= site.maxY;
          if (!inside) edits.push({ x, y, z: ground, stack: [...under(x, y), block] });
        }
      }
    }

    for (const edit of edits) {
      if (edit.z > ground && ctx.stackAt(edit.x, edit.y, edit.z).length > 0) {
        return { ok: false, reason: `Something is already at ${edit.x},${edit.y} on z${edit.z}` };
      }
    }
    if (!podium) return { ok: true, edits };
    const cells: Array<{ x: number; y: number; levels: number }> = [];
    for (let y = site.minY; y <= site.maxY; y++) {
      for (let x = site.minX; x <= site.maxX; x++) cells.push({ x, y, levels: raised + 1 });
    }
    return {
      ok: true,
      edits,
      raised: { cells, ramp: { slope: RAMP_TILE_ID, block: props.block, ground: props.floor } },
    };
  },
};

import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight, type PlacedTile } from "../../../lib/types";
import { HALF_LEVEL, placed, randomAt, valueNoise, type Bounds } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

export const TEMPLE_BASES = ["none", "step", "podium"] as const;
export const TEMPLE_ROOFS = ["flat", "gabled", "open"] as const;

const TempleSchema = v.object({
  height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 3),
  gap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2)), 1),
  base: v.optional(v.picklist(TEMPLE_BASES), "podium"),
  roof: v.optional(v.picklist(TEMPLE_ROOFS), "flat"),
  ruin: v.optional(field.percent(), 0),
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

const BROKEN = "marble-pillar-broken";
const RUBBLE = "rubble";

/** The floor a stretch of each floor tile turns into as moss takes it; a floor not listed stays bare. */
const MOSSY: Record<string, string> = { "flagstone-floor": "moss-flagstone" };

/** What grows on a ruin's floor, commonest first. Each is intangible or walkable, so none blocks a way in. */
const GROWTH = ["fern", "red-flowers", "yellow-flowers"] as const;

/** Cells across a patch of moss, so the floor greens in patches rather than in specks. */
const MOSS_SCALE = 3;

/**
 * Independent rolls for one cell, so a pillar's fate does not also decide its
 * rubble: each is a different salt on the same seed.
 */
const ROLL = {
  crack: 0,
  fail: 101,
  kept: 202,
  gone: 303,
  roof: 404,
  rubble: 505,
  growth: 606,
  moss: 707,
  kind: 808,
  ivy: 909,
  top: 1010,
  drape: 1111,
} as const;

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
 * nothing between them, so it is walked into from any side. `ruin` cracks,
 * breaks and fells pillars, drops the roof they no longer carry, and covers the
 * floor in moss, rubble and plants. On a `podium` the
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
    const ruin = props.ruin / 100;
    const roll = (x: number, y: number, salt: number) => randomAt(x, y, ctx.seed + salt);
    const segment = (id: string, x: number, y: number, nth: number): PlacedTile => {
      const r = roll(x, y, ROLL.crack + nth);
      if (r >= ruin) return { tileId: id };
      const cracked = CRACKED[id]!;
      return { tileId: cracked[Math.floor((r / ruin) * cracked.length)]! };
    };
    const units = props.height * HEIGHT_PER_LEVEL - (props.base === "step" ? HALF_LEVEL : 0);
    const count = units / HALF_LEVEL;
    /**
     * How many segments of each pillar still stand: all of them, a stump of
     * fewer under a broken end, or none. Failure grows faster than linearly
     * with `ruin`, so a lightly ruined temple is cracked before it falls.
     */
    const standing = new Map<string, number>();
    for (let y = site.minY; y <= site.maxY; y++) {
      for (let x = site.minX; x <= site.maxX; x++) {
        if (!pillarAt(x, y)) continue;
        let kept = count;
        if (roll(x, y, ROLL.fail) < ruin ** 1.5 * 0.85) {
          kept =
            roll(x, y, ROLL.gone) < ruin * 0.25
              ? 0
              : 1 + Math.floor(roll(x, y, ROLL.kept) * (count - 1));
        }
        standing.set(`${x},${y}`, kept);
      }
    }
    const whole = [...standing]
      .filter(([, kept]) => kept === count)
      .map(([key]) => key.split(",").map(Number) as [number, number]);
    const failed = new Set([...standing].filter(([, kept]) => kept < count).map(([key]) => key));
    const reachOf = (x: number, y: number) =>
      Math.min(...whole.map(([px, py]) => Math.max(Math.abs(px - x), Math.abs(py - y))), Infinity);
    let farthest = 0;
    for (let y = site.minY; y <= site.maxY; y++) {
      for (let x = site.minX; x <= site.maxX; x++) {
        const d = Math.min(x - site.minX, site.maxX - x, y - site.minY, site.maxY - y);
        farthest = Math.max(farthest, d);
      }
    }
    /**
     * A roof cell stays while a whole pillar is near enough to carry it. How
     * near shrinks from the whole temple at no ruin to the pillar's own cell
     * at full ruin, and is jittered per cell so the broken edge is ragged.
     * Only cells joined through the roof to a cell over a whole pillar are
     * kept, so no slab hangs in the air, and nothing stays over a pillar that
     * failed.
     */
    const roof = new Set<string>();
    if (props.roof !== "open") {
      const span = (1 - ruin) * (farthest + props.gap + 1);
      const carried = (x: number, y: number) =>
        !failed.has(`${x},${y}`) &&
        (ruin === 0 || reachOf(x, y) + roll(x, y, ROLL.roof) * 2 * ruin <= span);
      const queue = whole.filter(([x, y]) => carried(x, y));
      for (const [x, y] of queue) roof.add(`${x},${y}`);
      for (let head = 0; head < queue.length; head++) {
        const [x, y] = queue[head]!;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          const key = `${nx},${ny}`;
          if (nx < site.minX || nx > site.maxX || ny < site.minY || ny > site.maxY) continue;
          if (roof.has(key) || !carried(nx, ny)) continue;
          roof.add(key);
          queue.push([nx, ny]);
        }
      }
    }
    const roofed = (x: number, y: number) => roof.has(`${x},${y}`);
    /** Moss and vines take stone in patches, as they take the floor. */
    const overgrown = (x: number, y: number, salt: number, share: number) =>
      valueNoise(x, y, ctx.seed + salt, MOSS_SCALE) * 0.5 + roll(x, y, salt) * 0.5 < ruin * share;

    const edits: StackEdit[] = [];
    const levels = new Map<number, PlacedTile[]>();
    /**
     * Stands `tiles` on what is already in the cell from `level` up, starting a
     * new level whenever one is full. A floor on a full level belongs to the
     * level above; moss or a vine on one is drawn over the top of what filled it.
     */
    const pile = (x: number, y: number, level: number, tiles: readonly PlacedTile[]) => {
      let z = level;
      for (const tile of tiles) {
        const def = ctx.tilesById[tile.tileId]!;
        const size = physicalHeight(def);
        let stack = levels.get(z) ?? [];
        const used = stack.reduce((sum, p) => sum + physicalHeight(ctx.tilesById[p.tileId]!), 0);
        const full = used === HEIGHT_PER_LEVEL && !def.intangible;
        if (full || used + size > HEIGHT_PER_LEVEL) {
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
        const mossy = MOSSY[props.floor];
        const greened = mossy && valueNoise(x, y, ctx.seed + ROLL.moss, MOSS_SCALE) < ruin * 0.8;
        column.push(greened ? placed(mossy, ctx.tilesById) : floor);
        const kept = standing.get(`${x},${y}`);
        if (kept !== undefined) {
          for (let i = 0; i < kept; i++) {
            const id = i === 0 ? BOTTOM : i === count - 1 ? TOP : MIDDLE;
            column.push(segment(id, x, y, i));
          }
          if (kept > 0 && kept < count) column.push({ tileId: BROKEN });
          if (kept === 0) column.push({ tileId: RUBBLE });
        } else {
          const nearFallen = [...failed].some((key) => {
            const [px, py] = key.split(",").map(Number) as [number, number];
            return Math.max(Math.abs(px - x), Math.abs(py - y)) <= 1;
          });
          const r = roll(x, y, ROLL.rubble);
          const caved = !roofed(x, y) && props.roof !== "open";
          if ((nearFallen && r < ruin * 0.5) || (caved && r < ruin * 0.25)) {
            column.push({ tileId: RUBBLE });
          } else if (standing.has(`${x},${y - 1}`) && overgrown(x, y, ROLL.ivy, 0.6)) {
            column.push({ tileId: "ivy-tall-north" });
          } else if (roll(x, y, ROLL.growth) < ruin * 0.3) {
            const pick = roll(x, y, ROLL.kind);
            const kind = pick < 0.6 ? GROWTH[0] : pick < 0.8 ? GROWTH[1] : GROWTH[2];
            column.push(placed(kind, ctx.tilesById));
          }
        }
        pile(x, y, ground, column);
        if (!roofed(x, y)) continue;
        const inset = ridgeAlongX
          ? Math.min(y - site.minY, site.maxY - y)
          : Math.min(x - site.minX, site.maxX - x);
        const courses = props.roof === "gabled" ? 1 + Math.floor(inset / GABLE_RUN) : 1;
        const slab: PlacedTile[] = Array.from({ length: courses }, () => block);
        if (!roofed(x, y + 1) && overgrown(x, y, ROLL.drape, 0.7))
          slab.push({ tileId: "vines-south" });
        else if (overgrown(x, y, ROLL.top, 0.7)) slab.push({ tileId: "moss-top" });
        pile(x, y, roofLevel, slab);
      }
    }

    if (podium) {
      for (let y = site.minY - 1; y <= site.maxY + 1; y++) {
        for (let x = site.minX - 1; x <= site.maxX + 1; x++) {
          const inside = x >= site.minX && x <= site.maxX && y >= site.minY && y <= site.maxY;
          if (inside) continue;
          const growth: PlacedTile[] = [];
          if (y === site.maxY + 1 && overgrown(x, y, ROLL.drape, 0.7)) {
            growth.push({ tileId: "vines-south" });
          } else if (x === site.maxX + 1 && overgrown(x, y, ROLL.drape, 0.7)) {
            growth.push({ tileId: "vines-east" });
          } else if (overgrown(x, y, ROLL.top, 0.7)) growth.push({ tileId: "moss-top" });
          edits.push({ x, y, z: ground, stack: [...under(x, y), block, ...growth] });
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

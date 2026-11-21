import * as v from "valibot";
import { footprintOf, type PlacedTile } from "../../../lib/types";
import { hashCell, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { anchorFrom, cellsCovered, placer } from "../placing";
import { isWet } from "./line";

const ShipwreckSchema = v.object({
  hull: v.optional(field.tile(TILES.any), "wreck-hull"),
  ribs: v.optional(v.nullable(field.tile(TILES.any)), "wreck-ribs"),
  mast: v.optional(v.nullable(field.tile(TILES.any)), "wreck-mast"),
  debris: v.optional(field.weighted(TILES.any), [
    { tile: "wreck-planks", weight: 3 },
    { tile: "driftwood", weight: 2 },
    { tile: "rope-coil", weight: 1 },
    { tile: "barrel", weight: 1 },
  ]),
  pieces: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(40)), 8),
  adrift: v.optional(field.percent(), 20),
  clearing: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)), 2),
  onlyOn: v.optional(field.tiles(TILES.ground, 1), ["sand"]),
});

export type ShipwreckProps = v.InferOutput<typeof ShipwreckSchema>;

const DEEP_WATER_TILE_ID = "deep-water";
/** How many cells of chance are added to a spot's distance from the middle, so a piece lands near it rather than on the nearest free cell. */
const TIMBER_DRIFT_CELLS = 2;
const DEBRIS_DRIFT_CELLS = 6;
const ADRIFT_SALT = 0xad21f7;
const PICK_SALT = 0x3c1e;
const UINT32 = 4294967296;

function pick(entries: ReadonlyArray<{ tile: string; weight: number }>, hash: number) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return null;
  let at = (hash / UINT32) * total;
  for (const e of entries) {
    at -= e.weight;
    if (at < 0) return e.tile;
  }
  return entries.at(-1)!.tile;
}

/**
 * A ship broken on a beach, round the middle of its frame: the hull on the
 * sand, the ribs in the shallows, the mast, and `pieces` of debris thrown up
 * the beach, `adrift` percent of them left in the shallows. Each lands on the
 * free spot nearest the middle, give or take a few cells by the seed. Nothing
 * lands within `clearing` cells of the middle or touches another piece, so
 * whoever wakes there can walk off between them. Without sand for the hull
 * the node is refused; a piece with nowhere to go is left out.
 */
export const shipwreck: Component<ShipwreckProps> = {
  type: "shipwreck",
  label: "Shipwreck",
  starter: { frame: { x: 2, y: 2, w: 16, h: 12 } },
  schema: ShipwreckSchema,
  build(ctx, props) {
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const middle = { x: Math.floor((minX + maxX) / 2), y: Math.floor((minY + maxY) / 2) };
    const onlyOn = new Set(props.onlyOn);
    const beach = (stack: readonly PlacedTile[]) => onlyOn.has(stack.at(-1)!.tileId);
    const shallows = (stack: readonly PlacedTile[]) =>
      isWet(stack) && !stack.some((p) => p.tileId === DEEP_WATER_TILE_ID);
    const placing = placer(ctx);
    const beside = new Set<string>();
    let landed = 0;

    const land = (
      tileId: string,
      ground: (stack: readonly PlacedTile[]) => boolean,
      driftCells: number,
    ) => {
      const def = ctx.tilesById[tileId];
      const { w, d } = footprintOf(def);
      const salt = ctx.seed ^ Math.imul(++landed, PICK_SALT);
      const spots: Array<{ x: number; y: number; far: number }> = [];
      for (let y = minY; y + d - 1 <= maxY; y++) {
        for (let x = minX; x + w - 1 <= maxX; x++) {
          const reach = Math.max(
            Math.abs(x + (w - 1) / 2 - middle.x),
            Math.abs(y + (d - 1) / 2 - middle.y),
          );
          spots.push({ x, y, far: reach + randomAt(x, y, salt) * driftCells });
        }
      }
      spots.sort((a, b) => a.far - b.far);
      for (const nw of spots) {
        const anchor = anchorFrom(def, nw);
        const cells = cellsCovered(def, anchor);
        const free = cells.every(
          (c) =>
            ctx.covered(c.x, c.y) &&
            !beside.has(`${c.x},${c.y}`) &&
            Math.max(Math.abs(c.x - middle.x), Math.abs(c.y - middle.y)) > props.clearing,
        );
        if (!free || !placing.put(tileId, anchor, { on: ground }).ok) continue;
        for (const c of cells) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) beside.add(`${c.x + dx},${c.y + dy}`);
          }
        }
        return true;
      }
      return false;
    };

    if (!land(props.hull, beach, TIMBER_DRIFT_CELLS)) {
      const hull = ctx.tilesById[props.hull]!;
      const ground = props.onlyOn.map((id) => ctx.tilesById[id]?.name ?? id).join(" or ");
      return {
        ok: false,
        reason: `There is no room for the ${hull.name.toLowerCase()} on ${ground.toLowerCase()} in this frame. Move the frame onto a beach or make it larger.`,
      };
    }
    if (props.ribs && !land(props.ribs, shallows, TIMBER_DRIFT_CELLS)) {
      land(props.ribs, beach, TIMBER_DRIFT_CELLS);
    }
    if (props.mast) land(props.mast, beach, TIMBER_DRIFT_CELLS);
    for (let n = 0; n < props.pieces; n++) {
      const tile = pick(props.debris, hashCell(n, 0, ctx.seed ^ PICK_SALT));
      if (!tile) break;
      const wet = randomAt(n, 0, ctx.seed ^ ADRIFT_SALT) * 100 < props.adrift;
      if (!(wet && land(tile, shallows, DEBRIS_DRIFT_CELLS))) land(tile, beach, DEBRIS_DRIFT_CELLS);
    }
    return { ok: true, edits: placing.edits };
  },
};

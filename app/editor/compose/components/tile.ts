import * as v from "valibot";
import { stackHeight } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight, type PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

const TileSchema = v.object({
  tile: field.tile(TILES.any),
  at: field.point({ level: true }),
  facing: v.optional(field.direction(), "s"),
  placement: v.optional(field.placement("tile"), {}),
});

export type TileProps = v.InferOutput<typeof TileSchema>;

/**
 * Puts one tile on the cell at `at`, on top of what is there, with the
 * placement settings its kind of tile takes: a chest's rewards, a crate's
 * contents, a plate's channel, a portal's destination. The `player` tile is
 * the spawn, and a creature is placed the same way; the world respawns it
 * where it was placed.
 */
export const tile: Component<TileProps> = {
  type: "tile",
  label: "Tile",
  starter: { props: { tile: "quest-chest", at: { x: 0, y: 0, pinX: "center", pinY: "center" } } },
  schema: TileSchema,
  build(ctx, props) {
    const def = ctx.tilesById[props.tile]!;
    const at = ctx.point(props.at);
    if (!at) return { ok: false, reason: `There is no node called ${props.at.in ?? ""}` };
    const z = ctx.z + (props.at.z ?? 0);
    const stack = ctx.stackAt(at.x, at.y, z);
    const top = stack.at(-1);
    if (!top) return { ok: false, reason: `There is no ground at ${at.x},${at.y}` };
    if (ctx.tilesById[top.tileId]?.walkable === false) {
      return {
        ok: false,
        reason: `Nothing can stand on the ${ctx.tilesById[top.tileId]!.name} at ${at.x},${at.y}`,
      };
    }
    if (stackHeight(stack, ctx.tilesById) + physicalHeight(def) > HEIGHT_PER_LEVEL) {
      return { ok: false, reason: `There is no room for a ${def.name} at ${at.x},${at.y}` };
    }
    const { tileId: _tileId, direction: _direction, ...settings } = props.placement as PlacedTile;
    const tilePlaced = { ...settings, ...placed(props.tile, ctx.tilesById, props.facing) };
    return { ok: true, edits: [{ x: at.x, y: at.y, z, stack: [...stack, tilePlaced] }] };
  },
};

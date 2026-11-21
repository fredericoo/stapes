import * as v from "valibot";
import type { PlacedTile } from "../../../lib/types";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { cellsCovered, placer } from "../placing";

const TileSchema = v.object({
  tile: field.tile(TILES.any),
  at: field.point({ level: true }),
  facing: v.optional(field.direction(), "s"),
  placement: v.optional(field.placement("tile"), {}),
});

export type TileProps = v.InferOutput<typeof TileSchema>;

/**
 * Puts one tile on the cell at `at`, on top of what is there, with the
 * placement settings its kind of tile takes. A tile wider than a cell has its
 * south-east cell at `at` and is placed whole or refused. The settings are: a chest's rewards, a crate's
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
    for (const cell of cellsCovered(def, at, props.facing)) {
      const top = ctx.stackAt(cell.x, cell.y, z).at(-1);
      if (top && ctx.tilesById[top.tileId]?.walkable === false) {
        return {
          ok: false,
          reason: `Nothing can stand on the ${ctx.tilesById[top.tileId]!.name} at ${cell.x},${cell.y}`,
        };
      }
    }
    const { tileId: _tileId, direction: _direction, ...settings } = props.placement as PlacedTile;
    const placing = placer(ctx);
    const put = placing.put(props.tile, at, { z, facing: props.facing, settings });
    if (!put.ok) {
      const where = `${put.at.x},${put.at.y}`;
      if (put.why === "ground") return { ok: false, reason: `There is no ground at ${where}` };
      if (put.why === "room") {
        return { ok: false, reason: `There is no room for a ${def.name} at ${where}` };
      }
      return {
        ok: false,
        reason: `A ${def.name} needs level ground under all of it, and ${where} is higher or lower than the rest`,
      };
    }
    return { ok: true, edits: placing.edits };
  },
};

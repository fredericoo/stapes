import * as v from "valibot";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { fill } from "./fill";

const GrassSchema = v.object({
  tile: v.optional(field.tile(TILES.ground), "grass"),
  onlyOn: v.optional(field.tiles(TILES.ground), ["sand", "snow"]),
});

export type GrassProps = v.InferOutput<typeof GrassSchema>;

/**
 * A cover laid on every open cell of its frame whose top tile is in `onlyOn`,
 * which is a `fill` in its `on top` mode with no edge. Layers after it take it
 * out again: a road `cuts` it, and a `clear` removes it under a mask.
 */
export const grass: Component<GrassProps> = {
  type: "grass",
  label: "Grass",
  starter: {},
  schema: GrassSchema,
  build: (ctx, props) =>
    fill.build(ctx, {
      tiles: [props.tile],
      mode: "on top",
      edge: [],
      edgeWidth: 0,
      onlyOn: props.onlyOn,
    }),
};

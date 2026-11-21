import * as v from "valibot";
import {
  ROOF_COLOUR_IDS,
  ROOF_PITCHES,
  WINDOW_SPACING_RANGE,
  planHouse,
  type RoofColour,
  type RoofPitch,
} from "../../house";
import { DEFAULT_HOUSE_CONFIG, STOREY_RANGE } from "../../proceduralSettings";
import type { Component } from "../build";
import { TILES, field } from "../field";

const d = DEFAULT_HOUSE_CONFIG;

const HouseSchema = v.object({
  storeys: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(STOREY_RANGE.min), v.maxValue(STOREY_RANGE.max)),
    d.storeys,
  ),
  roofOrientation: v.optional(v.picklist(["auto", "vertical", "horizontal"]), d.roofOrientation),
  roofColour: v.optional(
    v.nullable(v.picklist(ROOF_COLOUR_IDS as [RoofColour, ...RoofColour[]])),
    d.roofColour,
  ),
  roofPitch: v.optional(v.picklist(ROOF_PITCHES as [RoofPitch, ...RoofPitch[]]), d.roofPitch),
  wall: v.optional(field.tile(TILES.wall), d.wallTileId),
  floor: v.optional(field.tile(TILES.ground), d.floorTileId),
  window: v.optional(v.nullable(field.tile(TILES.window)), d.windowTileId),
  windowSpacing: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(WINDOW_SPACING_RANGE.min),
      v.maxValue(WINDOW_SPACING_RANGE.max),
    ),
    d.windowSpacing,
  ),
  door: v.optional(v.nullable(field.tile(TILES.door)), d.doorTileId),
  doorRow: v.optional(v.picklist(["north", "centre", "south"]), d.doorRow),
  doorColumn: v.optional(v.picklist(["west", "centre", "east"]), d.doorColumn),
});

export type HouseProps = v.InferOutput<typeof HouseSchema>;

/**
 * Stands on whatever level the ground under it is on, and only on one: a
 * house whose walls started on two levels would have half its roof inside
 * the hill, so on uneven ground it is refused rather than built broken.
 */
export const house: Component<HouseProps> = {
  type: "house",
  label: "House",
  starter: { frame: { x: 2, y: 2, w: 7, h: 6 } },
  schema: HouseSchema,
  ownLevels: true,
  build(ctx, props) {
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const raised = ctx.raisedAt(minX, minY);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (ctx.raisedAt(x, y) === raised) continue;
        return {
          ok: false,
          reason:
            "The ground under this house is on more than one level. Move it onto flat ground, or put it before the hill in the layers so the hill is raised round it.",
        };
      }
    }
    const z = ctx.z + raised;
    return planHouse(ctx.map, ctx.tilesById, { x0: minX, y0: minY, x1: maxX, y1: maxY }, z, {
      generator: "house",
      storeys: props.storeys,
      roofOrientation: props.roofOrientation,
      roofColour: props.roofColour,
      roofPitch: props.roofPitch,
      wallTileId: props.wall,
      floorTileId: props.floor,
      windowTileId: props.window,
      windowSpacing: props.windowSpacing,
      doorTileId: props.door,
      doorRow: props.doorRow,
      doorColumn: props.doorColumn,
    });
  },
};

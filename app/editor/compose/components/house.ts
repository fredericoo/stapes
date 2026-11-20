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
import { TileIdSchema } from "../doc";

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
  wall: v.optional(TileIdSchema, d.wallTileId),
  floor: v.optional(TileIdSchema, d.floorTileId),
  window: v.optional(v.nullable(TileIdSchema), d.windowTileId),
  windowSpacing: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(WINDOW_SPACING_RANGE.min),
      v.maxValue(WINDOW_SPACING_RANGE.max),
    ),
    d.windowSpacing,
  ),
  door: v.optional(v.nullable(TileIdSchema), d.doorTileId),
  doorRow: v.optional(v.picklist(["north", "centre", "south"]), d.doorRow),
  doorColumn: v.optional(v.picklist(["west", "centre", "east"]), d.doorColumn),
});

export type HouseProps = v.InferOutput<typeof HouseSchema>;

export const house: Component<HouseProps> = {
  type: "house",
  label: "House",
  starter: { frame: { x: 2, y: 2, w: 7, h: 6 } },
  schema: HouseSchema,
  build(ctx, props) {
    const { minX, minY, maxX, maxY } = ctx.bounds;
    return planHouse(ctx.map, ctx.tilesById, { x0: minX, y0: minY, x1: maxX, y1: maxY }, ctx.z, {
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

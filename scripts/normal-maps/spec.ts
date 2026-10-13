import * as v from "valibot";

const FACE_NAMES = ["top", "south", "east", "west", "north", "camera"] as const;
const DIRECTION = v.picklist(["n", "e", "s", "w"]);

const Face = v.union([
  v.picklist(FACE_NAMES),
  v.strictObject({
    /** The way the surface runs downhill, and how steep it is in degrees from level. */
    slope: DIRECTION,
    pitch: v.pipe(v.number(), v.minValue(0), v.maxValue(90)),
  }),
  v.strictObject({ normal: v.tuple([v.number(), v.number(), v.number()]) }),
]);

const SHAPE_NAMES = ["inflate", "cylinder", "box"] as const;
const Shape = v.union([Face, v.picklist(SHAPE_NAMES)]);

const HEX_COLOUR = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/));
const PixelRect = v.strictObject({
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
});

const Rule = v.strictObject({
  colors: v.optional(v.array(HEX_COLOUR)),
  /** Pixels measured from the sprite rect's top-left corner, the same for every frame. */
  region: v.optional(PixelRect),
  shape: Shape,
});

const FacingOverride = v.strictObject({
  shape: v.optional(Shape),
  rules: v.optional(v.array(Rule)),
});

const TileSpec = v.strictObject({
  note: v.string(),
  shape: Shape,
  rules: v.optional(v.array(Rule)),
  seamless: v.optional(v.boolean()),
  detail: v.optional(v.pipe(v.number(), v.minValue(0))),
  facings: v.optional(v.record(v.string(), FacingOverride)),
});

export const NormalSheetSpec = v.strictObject({
  sheet: v.string(),
  tiles: v.record(v.string(), TileSpec),
});

export type Face = v.InferOutput<typeof Face>;
export type Shape = v.InferOutput<typeof Shape>;
export type Rule = v.InferOutput<typeof Rule>;
export type TileSpec = v.InferOutput<typeof TileSpec>;
export type NormalSheetSpec = v.InferOutput<typeof NormalSheetSpec>;

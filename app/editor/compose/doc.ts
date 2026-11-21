import * as v from "valibot";

export const MAP_DOC_VERSION = 1;

export const PIN_X = ["left", "right", "center", "scale"] as const;
export const PIN_Y = ["top", "bottom", "center", "scale"] as const;

export type PinX = (typeof PIN_X)[number];
export type PinY = (typeof PIN_Y)[number];

/**
 * `x` and `y` are read through the pin: cells in from the left or top edge,
 * cells in from the right or bottom edge, cells off the centre, or with
 * `scale` a fraction of the frame where 0 is flush left or top and 1 flush
 * right or bottom.
 */
export const FrameSchema = v.object({
  x: v.number(),
  y: v.number(),
  w: v.pipe(v.number(), v.integer(), v.minValue(1)),
  h: v.pipe(v.number(), v.integer(), v.minValue(1)),
  z: v.optional(v.pipe(v.number(), v.integer())),
  pinX: v.optional(v.picklist(PIN_X)),
  pinY: v.optional(v.picklist(PIN_Y)),
  absolute: v.optional(v.boolean()),
});

export type Frame = v.InferOutput<typeof FrameSchema>;

/**
 * A point is read like a frame's corner, inside the frame of the node named by
 * `in`, or of the node it belongs to. `z` is levels above that node's level,
 * for the components that place something on a level of its own.
 */
export const PointObject = v.object({
  in: v.optional(v.string()),
  x: v.number(),
  y: v.number(),
  z: v.optional(v.pipe(v.number(), v.integer())),
  pinX: v.optional(v.picklist(PIN_X)),
  pinY: v.optional(v.picklist(PIN_Y)),
});

export type Point = v.InferOutput<typeof PointObject>;

export type MapNode = {
  type: string;
  key: string;
  seed?: number;
  frame?: Frame;
  hidden?: boolean;
  props?: Record<string, unknown>;
  children?: MapNode[];
};

export const MapNodeSchema: v.GenericSchema<MapNode> = v.object({
  type: v.pipe(v.string(), v.minLength(1)),
  key: v.pipe(v.string(), v.minLength(1)),
  seed: v.optional(v.pipe(v.number(), v.integer())),
  frame: v.optional(FrameSchema),
  hidden: v.optional(v.boolean()),
  props: v.optional(v.record(v.string(), v.unknown())),
  children: v.optional(v.array(v.lazy(() => MapNodeSchema))),
});

export const MapDocSchema = v.object({
  version: v.literal(MAP_DOC_VERSION),
  seed: v.pipe(v.number(), v.integer()),
  root: MapNodeSchema,
});

export type MapDoc = v.InferOutput<typeof MapDocSchema>;

export function parseMapDoc(
  raw: unknown,
): { ok: true; doc: MapDoc } | { ok: false; reason: string } {
  const parsed = v.safeParse(MapDocSchema, raw);
  if (parsed.success) return { ok: true, doc: parsed.output };
  const issue = parsed.issues[0];
  const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";
  return { ok: false, reason: path ? `${path}: ${issue.message}` : issue.message };
}

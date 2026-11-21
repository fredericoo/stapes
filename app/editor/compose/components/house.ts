import * as v from "valibot";
import {
  ACCESS,
  FLOOR_USES,
  ROOM_RANGE,
  planBuilding,
  type FloorSpec,
  type RoofSpec,
} from "../../building";
import {
  ROOF_COLOUR_IDS,
  ROOF_PITCHES,
  WINDOW_SPACING_RANGE,
  type RoofColour,
  type RoofPitch,
} from "../../house";
import { DEFAULT_HOUSE_CONFIG } from "../../proceduralSettings";
import type { Component, Part } from "../build";
import type { MapNode } from "../doc";
import { TILES, field } from "../field";

const d = DEFAULT_HOUSE_CONFIG;

export const FLOOR_TYPE = "floor";
export const CELLAR_TYPE = "cellar";
export const ROOF_TYPE = "roof";
const HOUSE_TYPE = "house";

const HouseSchema = v.object({
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
  door: v.optional(field.tile(TILES.door), d.doorTileId ?? "door-closed"),
});

export type HouseProps = v.InferOutput<typeof HouseSchema>;

const rooms = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(ROOM_RANGE.min),
  v.maxValue(ROOM_RANGE.max),
);

const FloorSchema = v.object({
  use: v.optional(v.picklist(FLOOR_USES), "house"),
  rooms: v.optional(rooms, 1),
  reachedBy: v.optional(v.picklist(ACCESS), "stairs"),
  roomDoors: v.optional(v.boolean(), true),
  stocked: v.optional(v.boolean(), true),
  doors: v.optional(field.points(), []),
  windows: v.optional(v.boolean(), true),
  wall: v.optional(v.nullable(field.tile(TILES.wall)), null),
  floor: v.optional(v.nullable(field.tile(TILES.ground)), null),
});

type FloorProps = v.InferOutput<typeof FloorSchema>;

const CellarSchema = v.object({
  use: v.optional(v.picklist(FLOOR_USES), "storage"),
  rooms: v.optional(rooms, 1),
  reachedBy: v.optional(v.picklist(ACCESS), "stairs"),
  roomDoors: v.optional(v.boolean(), true),
  stocked: v.optional(v.boolean(), true),
  wall: v.optional(v.nullable(field.tile(TILES.wall)), "brick-wall"),
  floor: v.optional(v.nullable(field.tile(TILES.ground)), "flagstone-floor"),
});

type CellarProps = v.InferOutput<typeof CellarSchema>;

const RoofSchema = v.object({
  colour: v.optional(v.picklist(ROOF_COLOUR_IDS as [RoofColour, ...RoofColour[]]), "red"),
  pitch: v.optional(v.picklist(ROOF_PITCHES as [RoofPitch, ...RoofPitch[]]), d.roofPitch),
  orientation: v.optional(v.picklist(["auto", "vertical", "horizontal"]), d.roofOrientation),
});

type RoofProps = v.InferOutput<typeof RoofSchema>;

/**
 * How many levels above its house's ground each part is built: floors count
 * up from 0 in list order, cellars down from -1, and the roof sits on the
 * last floor. The house and the editor both read it, so the level a floor is
 * built on and the level the editor cuts the view to cannot differ.
 */
export function partLevels(house: MapNode): Map<string, number> {
  const levels = new Map<string, number>();
  const visible = (house.children ?? []).filter((c) => !c.hidden);
  const floors = visible.filter((c) => c.type === FLOOR_TYPE);
  floors.forEach((c, i) => levels.set(c.key, i));
  visible.filter((c) => c.type === CELLAR_TYPE).forEach((c, i) => levels.set(c.key, -1 - i));
  for (const c of visible) if (c.type === ROOF_TYPE) levels.set(c.key, floors.length);
  return levels;
}

/**
 * Stands on whatever level the ground under it is on, and only on one: a
 * house whose walls started on two levels would have half its roof inside
 * the hill, so on uneven ground it is refused rather than built broken. It
 * builds its Floor, Cellar and Roof children itself, as one plan, because a
 * stair on one floor is a hole in the next.
 */
export const house: Component<HouseProps> = {
  type: HOUSE_TYPE,
  label: "House",
  starter: {
    frame: { x: 2, y: 2, w: 7, h: 6 },
    children: [
      {
        type: FLOOR_TYPE,
        props: { doors: [{ x: 0, y: 0, pinX: "center", pinY: "bottom" }] },
      },
      { type: ROOF_TYPE },
    ],
  },
  schema: HouseSchema,
  ownLevels: true,
  parts: [FLOOR_TYPE, CELLAR_TYPE, ROOF_TYPE],
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
    const storey = (part: Part, own: FloorProps | CellarProps): FloorSpec => ({
      name: part.key,
      use: own.use,
      seed: part.seed,
      rooms: own.rooms,
      roomDoors: own.roomDoors,
      stocked: own.stocked,
      access: own.reachedBy,
      doors:
        "doors" in own
          ? own.doors.flatMap((point) => {
              const cell = part.point(point);
              return cell ? [cell] : [];
            })
          : [],
      wallTileId: own.wall ?? props.wall,
      floorTileId: own.floor ?? props.floor,
      windowTileId: "windows" in own && own.windows ? props.window : null,
      windowSpacing: props.windowSpacing,
      doorTileId: props.door,
    });
    const of = (type: string) => ctx.parts.filter((part) => part.type === type);
    const floors = of(FLOOR_TYPE);
    if (floors.length === 0) {
      return {
        ok: false,
        reason: "This house has no floor to build. Add a Floor layer inside it.",
      };
    }
    const roofs = of(ROOF_TYPE);
    if (roofs.length > 1) {
      return { ok: false, reason: "A house takes one roof. Remove or hide the others." };
    }
    const roofProps = roofs[0]?.props as RoofProps | undefined;
    const roof: RoofSpec | null = roofProps
      ? { colour: roofProps.colour, pitch: roofProps.pitch, orientation: roofProps.orientation }
      : null;
    return planBuilding(
      ctx.map,
      ctx.tilesById,
      { x0: minX, y0: minY, x1: maxX, y1: maxY },
      ctx.z + raised,
      {
        floors: floors.map((part) => storey(part, part.props as FloorProps)),
        cellars: of(CELLAR_TYPE).map((part) => storey(part, part.props as CellarProps)),
        roof,
      },
    );
  },
};

const nothing = () => ({ ok: true as const, edits: [] });

export const floor: Component<FloorProps> = {
  type: FLOOR_TYPE,
  label: "Floor",
  starter: {},
  schema: FloorSchema,
  within: [HOUSE_TYPE],
  build: nothing,
};

export const cellar: Component<CellarProps> = {
  type: CELLAR_TYPE,
  label: "Cellar",
  starter: {},
  schema: CellarSchema,
  within: [HOUSE_TYPE],
  build: nothing,
};

export const roof: Component<RoofProps> = {
  type: ROOF_TYPE,
  label: "Roof",
  starter: {},
  schema: RoofSchema,
  within: [HOUSE_TYPE],
  build: nothing,
};

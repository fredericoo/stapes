import * as v from "valibot";
import { DIRECTIONS, HEIGHT_PER_LEVEL, type Direction, type TileDef } from "../../lib/types";
import { PointObject } from "./doc";

/** Which tiles a tile field offers, and the words the form and a refusal use for them. */
export type TileKind = { label: string; test: (tile: TileDef) => boolean };

const hasInteraction = (tile: TileDef, name: string) =>
  Object.keys((tile as { interactions?: object }).interactions ?? {}).includes(name);

/**
 * The tiles a field can narrow to, read from what the catalogue already says
 * about each tile rather than from a list, so a tile added later shows up in
 * every field it fits.
 */
export const TILES = {
  any: { label: "any tile", test: () => true },
  ground: {
    label: "flat ground",
    test: (t) => t.kind === "prop" && t.height === 0 && t.walkable !== false,
  },
  wall: {
    label: "a wall",
    test: (t) => t.kind === "prop" && t.type === "autotile" && t.height > 0 && t.walkable === false,
  },
  window: {
    label: "a window",
    test: (t) =>
      t.kind === "prop" &&
      t.type === "directional" &&
      t.height === HEIGHT_PER_LEVEL &&
      t.lightPassing === true &&
      t.walkable === false &&
      !t.intangible &&
      !(t as { interactions?: object }).interactions,
  },
  door: {
    label: "a door",
    test: (t) =>
      t.type === "directional" &&
      t.height > 0 &&
      (hasInteraction(t, "switch") || hasInteraction(t, "receive")),
  },
  rail: {
    label: "a fence or rail",
    test: (t) =>
      t.kind === "prop" &&
      t.type === "autotile" &&
      t.height > 0 &&
      t.height < HEIGHT_PER_LEVEL &&
      t.walkable === false &&
      t.lightPassing === true,
  },
  stairs: {
    label: "stairs or a ramp",
    test: (t) => t.kind === "prop" && t.type === "directional" && t.climbFrom !== undefined,
  },
  standing: {
    label: "a plant or prop that stands",
    test: (t) =>
      t.kind === "prop" &&
      t.height > 0 &&
      t.walkable === false &&
      (t.type === "simple" || t.type === "scatter"),
  },
} satisfies Record<string, TileKind>;

export type FieldMeta =
  | { field: "tile"; tiles: TileKind }
  | { field: "tiles"; tiles: TileKind }
  | { field: "weighted"; tiles: TileKind }
  | { field: "point"; level: boolean }
  | { field: "points" }
  | { field: "node" }
  | { field: "direction" }
  | { field: "percent" }
  | { field: "placement"; tileProp: string };

/**
 * The props a component can ask for. Each is an ordinary valibot schema, so
 * it validates and types the prop as before, with a `v.metadata` that tells
 * the form which widget draws it and which tiles it offers.
 */
export const field = {
  tile: (tiles: TileKind = TILES.any) =>
    v.pipe(v.string(), v.minLength(1), v.metadata({ field: "tile", tiles } satisfies FieldMeta)),
  tiles: (tiles: TileKind = TILES.any, min = 0) =>
    v.pipe(
      v.array(v.string()),
      v.minLength(min),
      v.metadata({ field: "tiles", tiles } satisfies FieldMeta),
    ),
  weighted: (tiles: TileKind = TILES.any) =>
    v.pipe(
      v.array(v.object({ tile: v.string(), weight: v.pipe(v.number(), v.minValue(0)) })),
      v.metadata({ field: "weighted", tiles } satisfies FieldMeta),
    ),
  point: (options: { level?: boolean } = {}) =>
    v.pipe(
      PointObject,
      v.metadata({ field: "point", level: options.level ?? false } satisfies FieldMeta),
    ),
  /** Points a route passes through on its way, in order; the editor draws each as a handle on the map. */
  points: () => v.pipe(v.array(PointObject), v.metadata({ field: "points" } satisfies FieldMeta)),
  /** Another node of the tree, by key. */
  node: () => v.pipe(v.string(), v.minLength(1), v.metadata({ field: "node" } satisfies FieldMeta)),
  direction: () =>
    v.pipe(
      v.picklist(DIRECTIONS as [Direction, ...Direction[]]),
      v.metadata({ field: "direction" } satisfies FieldMeta),
    ),
  /** The placement settings of the tile named by the prop `tileProp`, edited in the map editor's dialog. */
  placement: (tileProp: string) =>
    v.pipe(
      v.record(v.string(), v.unknown()),
      v.metadata({ field: "placement", tileProp } satisfies FieldMeta),
    ),
  percent: () =>
    v.pipe(
      v.number(),
      v.minValue(0),
      v.maxValue(100),
      v.metadata({ field: "percent" } satisfies FieldMeta),
    ),
};

type Introspected = {
  type: string;
  wrapped?: Introspected;
  pipe?: Array<{ type: string; metadata?: unknown }>;
  entries?: Record<string, Introspected>;
};

export function metaOf(schema: unknown): FieldMeta | null {
  let s = schema as Introspected;
  while (s.type === "optional" || s.type === "nullable") s = s.wrapped!;
  const found = s.pipe?.find((a) => a.type === "metadata")?.metadata as FieldMeta | undefined;
  return found?.field ? found : null;
}

/**
 * Checks every tile a node's props name against its field: that the tile
 * exists, and that it is the kind of tile the field asks for. A schema
 * cannot do this itself, because it never sees the tile catalogue.
 */
export function wrongTile(
  schema: unknown,
  props: Record<string, unknown>,
  tilesById: Record<string, TileDef>,
): string | null {
  const entries = (schema as Introspected).entries ?? {};
  for (const [name, entry] of Object.entries(entries)) {
    const m = metaOf(entry);
    const value = props[name];
    if (!m || value == null) continue;
    let ids: string[] = [];
    if (m.field === "tile") ids = [value as string];
    else if (m.field === "tiles") ids = value as string[];
    else if (m.field === "weighted") ids = (value as Array<{ tile: string }>).map((w) => w.tile);
    else continue;
    for (const id of ids) {
      const tile = tilesById[id];
      if (!tile) return `${name}: there is no tile called ${id}`;
      if (!m.tiles.test(tile)) return `${name}: ${tile.name} is not ${m.tiles.label}`;
    }
  }
  return null;
}

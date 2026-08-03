export type Direction = "n" | "e" | "s" | "w";

export const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

export type CellRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SpriteRef = {
  tilesetId: string;
  /** Rectangle in 8px cells, not pixels. */
  rect: CellRect;
  /** Cell within rect (0..w-1, 0..h-1). Defaults to bottom-right. */
  base: { x: number; y: number };
};

export type Frame = {
  sprite: SpriteRef;
  durationMs: number;
};

/** 0 = flat, 1 = half level, 2 = full level. */
export type TileHeight = 0 | 1 | 2;

export type VariantKey = "default" | Direction;

export type LightDef = {
  /** Reach in cells, where attenuation hits zero. */
  radius: number;
  /** 0–1 multiplier on the emitted colour. */
  intensity: number;
  /** Hex, e.g. "#ffcc88". */
  color: string;
};

export type TileDef = {
  id: string;
  name: string;
  height: TileHeight;
  directional: boolean;
  /** Direction-less tiles use only "default"; directional use n/e/s/w. */
  variants: Partial<Record<VariantKey, Frame[]>>;
  /** Reserved for flammable/wet/frozen/pushable later. */
  attributes: Record<string, never>;
  /**
   * When true, this tile does not occlude light (e.g. water).
   * Default / absent → blocks. Prefer this over deprecated {@link blocksLight}.
   */
  lightPassing?: boolean;
  /**
   * @deprecated Use {@link lightPassing} (inverted). Kept so old tiles.json still loads.
   */
  blocksLight?: boolean;
  /** Absent means not a light source. */
  light?: LightDef;
  /**
   * When true, unsupported tiles fall until they land on something solid.
   * Default / absent → not affected by gravity.
   */
  affectedByGravity?: boolean;
  /**
   * When false, this tile’s top is not a stand / land surface.
   * Default / absent → walkable.
   */
  walkable?: boolean;
  /**
   * World-side dirs you may climb UP toward, keyed by variant.
   * Non-directional tiles use `"default"`; directional use `n`/`e`/`s`/`w`
   * for each placement facing. Missing dirs default to true. Not per-frame.
   */
  climbFrom?: Partial<Record<VariantKey, Partial<Record<Direction, boolean>>>>;
};

/** Whether this tile’s top is a stand/land surface. Default: true. */
export function resolveWalkable(def: TileDef): boolean {
  return def.walkable !== false;
}

const OPEN_CLIMB: Record<Direction, boolean> = {
  n: true,
  e: true,
  s: true,
  w: true,
};

/** World climb-from flags for a variant; missing dirs default to true. */
export function resolveClimbFrom(
  def: TileDef,
  variant: VariantKey = "default",
): Record<Direction, boolean> {
  const key: VariantKey = def.directional
    ? variant === "default"
      ? "s"
      : variant
    : "default";
  const flags = def.climbFrom?.[key] ?? def.climbFrom?.default;
  return {
    n: flags?.n !== false,
    e: flags?.e !== false,
    s: flags?.s !== false,
    w: flags?.w !== false,
  };
}

/** Persist climb-from; omit all-open variants and the field when unrestricted. */
export function climbFromForSave(
  def: TileDef,
  byVariant: Partial<Record<VariantKey, Record<Direction, boolean>>>,
): TileDef["climbFrom"] {
  const keys: VariantKey[] = def.directional ? DIRECTIONS : ["default"];
  const out: NonNullable<TileDef["climbFrom"]> = {};
  let any = false;
  for (const key of keys) {
    const flags = byVariant[key] ?? OPEN_CLIMB;
    if (flags.n && flags.e && flags.s && flags.w) continue;
    const partial: Partial<Record<Direction, boolean>> = {};
    for (const d of DIRECTIONS) {
      if (!flags[d]) partial[d] = false;
    }
    out[key] = partial;
    any = true;
  }
  return any ? out : undefined;
}

/** Height units per map level (full stack before overflow). */
export const HEIGHT_PER_LEVEL = 2;

/** Whether light passes through this tile. Default: blocks (false). */
export function resolveLightPassing(def: TileDef): boolean {
  if (def.lightPassing != null) return def.lightPassing;
  if (def.blocksLight != null) return !def.blocksLight;
  return false;
}

/** @deprecated Use {@link resolveLightPassing}. */
export function resolveBlocksLight(def: TileDef): boolean {
  return !resolveLightPassing(def);
}

export type TilesetDef = {
  id: string;
  name: string;
  file: string;
  width: number;
  height: number;
};

export type PlacedTile = {
  tileId: string;
  direction?: Direction;
};

export type MapFile = {
  version: 1;
  levels: Record<string, Record<string, PlacedTile[]>>;
};

export type Coord = {
  x: number;
  y: number;
  z: number;
};

export const MIN_LEVEL = -8;
export const MAX_LEVEL = 8;
export const CELL_SIZE = 8;
export const CHUNK_SIZE = 16;

export function defaultBase(rect: CellRect): { x: number; y: number } {
  return { x: Math.max(0, rect.w - 1), y: Math.max(0, rect.h - 1) };
}

export function coordKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseCoordKey(key: string): { x: number; y: number } {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

export function levelKey(z: number): string {
  return String(z);
}

export function clampLevel(z: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(z)));
}

export function isAnimated(tile: TileDef): boolean {
  const frames = Object.values(tile.variants);
  return frames.some((f) => (f?.length ?? 0) > 1);
}

export function getFrames(
  tile: TileDef,
  direction?: Direction,
): Frame[] | undefined {
  if (tile.directional) {
    return tile.variants[direction ?? "s"];
  }
  return tile.variants.default;
}

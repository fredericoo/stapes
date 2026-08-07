import type { TileInteractions } from "./interactions";

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

export type LightDef = {
  /** Reach in cells, where attenuation hits zero. */
  radius: number;
  /** 0–1 multiplier on the emitted colour. */
  intensity: number;
  /** Hex, e.g. "#ffcc88". */
  color: string;
};

export type Frame = {
  sprite: SpriteRef;
  durationMs: number;
  /** Absent means this frame does not emit light. */
  light?: LightDef;
};

export type TileSprite = {
  frames: Frame[];
};

/** 0 = flat, 1 = half level, 2 = full level. */
export type TileHeight = 0 | 1 | 2;

export type TileType = "simple" | "directional" | "autotile";

export const TILE_TYPES: TileType[] = ["simple", "directional", "autotile"];

/** Climb / facing key: non-directional use `"default"`; directional use n/e/s/w. */
export type VariantKey = "default" | Direction;

/** Blob autotile slice index (0 = isolated … 46 = full). */
export type AutotileSlice = number;

export const AUTOTILE_SLICE_COUNT = 47;

export type TileDef = {
  id: string;
  name: string;
  height: TileHeight;
  type: TileType;
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
  /**
   * When true, this tile contributes no physical volume — other tiles and the
   * player can pass through it. Authored {@link height} is kept for lighting
   * and drawing. Default / absent → solid.
   */
  intangible?: boolean;
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
   * Simple / autotile use `"default"`; directional use `n`/`e`/`s`/`w`
   * for each placement facing. Missing dirs default to true.
   */
  climbFrom?: Partial<Record<VariantKey, Partial<Record<Direction, boolean>>>>;
  /**
   * How this object behaves in play mode — what the player can do to it, and
   * what it does on its own. Absent → inert. Read through `resolvePush` /
   * `resolveSwitch` / `resolvePressurePlate` / `isInteractive` in
   * ./interactions, which validate the on-disk shape.
   */
  interactions?: TileInteractions;
  /** type === "simple" */
  sprite?: TileSprite;
  /** type === "directional" */
  sprites?: Partial<Record<Direction, TileSprite>>;
  /** type === "autotile" — sparse 0..46 */
  slices?: Partial<Record<AutotileSlice, TileSprite>>;
};

/** Whether this tile’s top is a stand/land surface. Default: true. */
export function resolveWalkable(def: TileDef): boolean {
  return def.walkable !== false;
}

/** Whether this tile has no physical volume. Default: solid (false). */
export function resolveIntangible(def: TileDef): boolean {
  return def.intangible === true;
}

/**
 * Height that counts for stacking, collision, and standing elevation.
 * Intangible tiles read as 0 so others can pass through; lighting and
 * sprite depth still use authored {@link TileDef.height}.
 */
export function physicalHeight(def: TileDef): number {
  return resolveIntangible(def) ? 0 : def.height;
}

const OPEN_CLIMB: Record<Direction, boolean> = {
  n: true,
  e: true,
  s: true,
  w: true,
};

export function isDirectional(def: TileDef): boolean {
  return def.type === "directional";
}

/** World climb-from flags for a variant; missing dirs default to true. */
export function resolveClimbFrom(
  def: TileDef,
  variant: VariantKey = "default",
): Record<Direction, boolean> {
  const key: VariantKey = isDirectional(def)
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
  const keys: VariantKey[] = isDirectional(def) ? DIRECTIONS : ["default"];
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

/** Context for resolving which TileSprite a placement uses. */
export type TileResolveContext = {
  direction?: Direction;
  /** Required for autotile neighbor matching. */
  map?: MapFile;
  x?: number;
  y?: number;
  z?: number;
  /** Override slice for previews (isolated = 0). */
  autotileSlice?: AutotileSlice;
};

function framesWithLight(frames: Frame[], light?: LightDef): Frame[] {
  if (!light) return frames;
  return frames.map((f) => (f.light ? f : { ...f, light }));
}

function framesToSprite(frames: Frame[] | undefined, light?: LightDef): TileSprite {
  return { frames: framesWithLight(frames ?? [], light) };
}

/**
 * Migrate legacy `directional` + `variants` (+ tile-level `light`) to the
 * type → TileSprite model. Idempotent on already-new tiles.
 */
export function normalizeTileDef(raw: unknown): TileDef {
  const t = raw as Record<string, unknown>;
  if (t && typeof t.type === "string" && TILE_TYPES.includes(t.type as TileType)) {
    const def = raw as TileDef;
    return {
      ...def,
      attributes: def.attributes ?? {},
    };
  }

  const legacy = raw as {
    id: string;
    name: string;
    height: TileHeight;
    directional?: boolean;
    variants?: Partial<Record<VariantKey, Frame[]>>;
    attributes?: Record<string, never>;
    lightPassing?: boolean;
    blocksLight?: boolean;
    intangible?: boolean;
    light?: LightDef;
    affectedByGravity?: boolean;
    walkable?: boolean;
    climbFrom?: TileDef["climbFrom"];
    interactions?: TileInteractions;
  };

  const light = legacy.light;
  const type: TileType = legacy.directional ? "directional" : "simple";
  const base: TileDef = {
    id: legacy.id,
    name: legacy.name,
    height: legacy.height,
    type,
    attributes: legacy.attributes ?? {},
    lightPassing: legacy.lightPassing,
    blocksLight: legacy.blocksLight,
    intangible: legacy.intangible,
    affectedByGravity: legacy.affectedByGravity,
    walkable: legacy.walkable,
    climbFrom: legacy.climbFrom,
    interactions: legacy.interactions,
  };

  if (type === "directional") {
    const sprites: Partial<Record<Direction, TileSprite>> = {};
    for (const d of DIRECTIONS) {
      const frames = legacy.variants?.[d];
      if (frames) sprites[d] = framesToSprite(frames, light);
    }
    return { ...base, sprites };
  }

  return {
    ...base,
    sprite: framesToSprite(legacy.variants?.default, light),
  };
}

export function normalizeTiles(raw: unknown[]): TileDef[] {
  return raw.map(normalizeTileDef);
}

/** All TileSprites on a def (for animation / light scans). */
export function allTileSprites(tile: TileDef): TileSprite[] {
  if (tile.type === "simple") {
    return tile.sprite ? [tile.sprite] : [];
  }
  if (tile.type === "directional") {
    return DIRECTIONS.map((d) => tile.sprites?.[d]).filter(
      (s): s is TileSprite => s != null,
    );
  }
  if (!tile.slices) return [];
  return Object.values(tile.slices).filter((s): s is TileSprite => s != null);
}

export function isAnimated(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) => s.frames.length > 1);
}

/** True if any frame on any sprite can emit light. */
export function tileCanEmitLight(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) =>
    s.frames.some(
      (f) => f.light && f.light.radius > 0 && f.light.intensity > 0,
    ),
  );
}

export function frameAtTime(frames: Frame[], timeMs: number): Frame | undefined {
  if (frames.length === 0) return undefined;
  if (frames.length === 1) return frames[0];
  const total = frames.reduce((sum, f) => sum + Math.max(1, f.durationMs), 0);
  let t = ((timeMs % total) + total) % total;
  for (const f of frames) {
    const d = Math.max(1, f.durationMs);
    if (t < d) return f;
    t -= d;
  }
  return frames[frames.length - 1];
}

export function frameIndexAtTime(frames: Frame[], timeMs: number): number {
  if (frames.length === 0) return 0;
  if (frames.length === 1) return 0;
  const total = frames.reduce((sum, f) => sum + Math.max(1, f.durationMs), 0);
  let t = ((timeMs % total) + total) % total;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.max(1, frames[i].durationMs);
    if (t < d) return i;
    t -= d;
  }
  return frames.length - 1;
}

// resolveTileSprite / getFrames / resolveLight live in ./tileResolve
// (needs autotile without a circular import).

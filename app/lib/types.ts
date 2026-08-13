import type { TileInteractions } from "./interactions";
import type { ItemInstance } from "./itemInstance";

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

/**
 * What a tile *is*, as opposed to what it does.
 *
 * The three are mutually exclusive, and that exclusivity is the whole reason
 * this is a stored field rather than something read off the interaction blocks
 * the way {@link resolveActor} reads actorhood. Derived from the blocks,
 * "battler" and "item" would be two independent booleans that can both be true,
 * and there would be no way to say which one a tile is — only which blocks it
 * happens to carry.
 *
 * So the field is authoritative and the blocks are subordinate: `resolveBattler`
 * and `resolveItem` both refuse a tile whose kind is not theirs, even when the
 * block is sitting right there. A stale block left behind by a hand-edit is
 * inert rather than quietly in charge.
 *
 * - `prop` — scenery and machinery. Everything the world is made of: a wall, a
 *   crate, a door, a deer with a brain. Being a prop says nothing about whether
 *   it moves or thinks; see {@link TileDef.actor}, which is orthogonal.
 * - `battler` — has hit points. See `./battler`.
 * - `item` — can be carried. See `./item`.
 */
export type TileKind = "prop" | "battler" | "item";

export const TILE_KINDS: TileKind[] = ["prop", "battler", "item"];

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
  /** What this tile is — see {@link TileKind}. Required; absent reads as prop. */
  kind: TileKind;
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
   * When true, a placement of this tile is a *body* — something driven, rather
   * than scenery — even with no brain to say so. Authoring a brain already
   * implies this (see {@link resolveActor}), so the flag is only needed for the
   * mindless body: a prop that gravity moves, a thing with no behaviour of its
   * own. Set it and leave the brain empty for that; author a brain and this
   * follows.
   *
   * Bodies walk, fall and press plates through the same paths the player does;
   * what drives them is a separate question. Placements of a body tile are
   * adopted as actors when the world loads, which is why placing one is the
   * whole of putting an NPC in the map: there is no spawner. The authored
   * `player` tile is the exception — a spawn marker driven by a socket, adopted
   * by tile id and never routed through {@link resolveActor}, so it carries
   * neither this flag nor a brain. Default / absent → scenery.
   */
  actor?: boolean;
  /**
   * Milliseconds this body takes to cross one cell. Absent → the player's pace.
   *
   * The knob that decides whether a creature can be outrun. Everything moving at
   * exactly the player's speed makes a follower impossible to shake and a
   * fleeing animal impossible to catch, since the gap between you can never
   * change.
   *
   * Read through `resolveWalkDurationMs`. Larger is slower.
   */
  walkDurationMs?: number;
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
 * Whether a placement of this tile is a body something drives.
 *
 * A brain is the usual way to say yes: authoring what drives a body is authoring
 * that it *is* one, so a tile with a brain is an actor without also ticking a
 * box. The explicit {@link TileDef.actor} flag stays for the rarer body that is
 * driven but mindless — a prop gravity moves, a thing with no behaviour of its
 * own — which has no brain to imply it.
 *
 * The player is neither: it is driven by a connection, adopted by tile id, and
 * never routed through here. That is the one hardcoded exception, and it needs
 * no flag — which is why the authored `player` tile carries none.
 */
export function resolveActor(def: TileDef): boolean {
  return def.actor === true || def.interactions?.brain != null;
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
  /**
   * Signal channel this placement is wired to. Emitters drive it, receivers
   * follow it, and sharing a name is the whole of the binding — there is no
   * link table and no per-tile identity to keep alive.
   *
   * Absent on all but the handful of wired placements in a map, which is why
   * this is a placement field rather than an id minted for every tile in the
   * world. It must survive any swap of the tile occupying the slot: a plate
   * pressing, a door opening and a crate being shoved are all the same wire.
   *
   * See ../game/signals for how it is read.
   */
  channel?: string;
  /**
   * What this placement says when somebody looks at it.
   *
   * A placement field for the same reason {@link channel} is: what a thing says
   * belongs to the slot, not to the tile filling it. Two signs share one `sign`
   * tile def and read differently, and the text has to outlive every swap of the
   * tile in the slot — a described door that opens is still the same door.
   *
   * The tile's own {@link TileDef.name} is what a look reports without one;
   * this is the line underneath. Absent on all but the few placements anybody
   * has written on.
   */
  description?: string;
  /**
   * Which actor drives this placement, for the handful of tiles that are
   * somebody's avatar rather than scenery.
   *
   * Authored maps never carry one: the map's single `player` tile marks where
   * actors enter, and ownership is assigned at runtime as they join. It is what
   * lets the simulation tell two identical player tiles apart — without it,
   * finding "this connection's actor" would mean guessing between them.
   *
   * Survives a move for free because `moveEntity` spreads the placement rather
   * than rebuilding it field by field.
   */
  owner?: string;
  /**
   * Which particular item this placement is, for the placements that are one.
   *
   * A placement field on exactly the terms {@link channel} and
   * {@link description} are: identity belongs to the slot, not to the tile def
   * filling it, and two `rusty-sword` placements are two distinct swords. It is
   * what lets the same thing be followed across being picked up and put down —
   * see `./itemInstance`, which owns both directions of that trip.
   *
   * Minted once when the world loads and never again. Absent on everything that
   * is not an item, which is almost every placement in a map.
   */
  itemId?: string;
  /**
   * What this container is holding, for the placements that hold anything.
   *
   * Here rather than on a session index because a container on the floor *is*
   * its contents' address: the checkpoint stores the map, an editor save writes
   * the map, and both keep a chest's contents with no second store to keep in
   * step. It rides the cell patch the container itself travels on.
   *
   * Flat, never nested — a container may not hold a container, so this is a list
   * and not a tree. See `./item`.
   */
  contents?: ItemInstance[];
};

/**
 * Cap on {@link PlacedTile.description}, in characters.
 *
 * A layout bound rather than a safety one — the text is authored in the editor,
 * not typed by a stranger, and it reaches the screen as `textContent`. What it
 * protects is the view: a look label wraps at 60% of the square, so a paragraph
 * would be a wall across the world it is describing.
 */
export const MAX_DESCRIPTION_LENGTH = 240;

/**
 * Cells of one chunk, keyed by {@link coordKey}.
 */
export type ChunkCells = Record<string, PlacedTile[]>;

/**
 * A level's cells, grouped into {@link CHUNK_SIZE} squares keyed by
 * {@link chunkKey}.
 *
 * Grouped rather than flat because the map is copy-on-write: editing one cell
 * copies the record holding it, and a populated floor runs to thousands of
 * cells. Chunking bounds that copy to one chunk, and gives change detection a
 * granularity between "this level" and "this cell" — which is what lets the
 * renderer rebuild the geometry around an edit instead of the whole floor.
 *
 * On disk the format stays flat; {@link parseMap} and {@link serializeMap}
 * convert at the boundary.
 */
export type LevelChunks = Record<string, ChunkCells>;

export type MapFile = {
  version: 1;
  levels: Record<string, LevelChunks>;
};

/** The on-disk shape: cells flat per level, no chunk grouping. */
export type FlatMapFile = {
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
/**
 * The kind on the wire, or `prop` when there is not a valid one.
 *
 * A default rather than a migration: it does not look at the interaction blocks
 * to guess, because guessing is the two-sources-of-truth problem {@link TileKind}
 * exists to avoid. `data/tiles.json` states every kind outright, and a tile that
 * somehow arrives without one is inert scenery — visibly wrong in the editor,
 * rather than silently in charge of a fight.
 */
function readKind(raw: Record<string, unknown>): TileKind {
  const kind = raw?.kind;
  return typeof kind === "string" && TILE_KINDS.includes(kind as TileKind)
    ? (kind as TileKind)
    : "prop";
}

export function normalizeTileDef(raw: unknown): TileDef {
  const t = raw as Record<string, unknown>;
  if (t && typeof t.type === "string" && TILE_TYPES.includes(t.type as TileType)) {
    const def = raw as TileDef;
    return {
      ...def,
      attributes: def.attributes ?? {},
      kind: readKind(t),
    };
  }

  const legacy = raw as {
    id: string;
    name: string;
    height: TileHeight;
    directional?: boolean;
    variants?: Partial<Record<VariantKey, Frame[]>>;
    attributes?: Record<string, never>;
    light?: LightDef;
  };

  const light = legacy.light;
  const type: TileType = legacy.directional ? "directional" : "simple";

  // Everything that is not part of the old sprite encoding is carried across
  // untouched, rather than copied field by field. Three fields in a row were
  // added to `TileDef` and silently lost here — the enumeration reads as
  // exhaustive and is not, and nothing fails until a creature quietly ignores
  // the flag somebody just authored. Only the keys this function *replaces*
  // need naming, and they are named right here.
  const {
    directional: _wasDirectional,
    variants: _wasVariants,
    light: _wasLight,
    ...carried
  } = raw as Record<string, unknown>;

  const base: TileDef = {
    ...(carried as Omit<TileDef, "type" | "attributes" | "kind">),
    id: legacy.id,
    name: legacy.name,
    height: legacy.height,
    type,
    kind: readKind(raw as Record<string, unknown>),
    attributes: legacy.attributes ?? {},
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

/**
 * Furthest this tile's light can reach, in cells, over every variant and frame.
 *
 * The bound has to hold across variants rather than for the placement's current
 * one: a lamp swapping to its lit form, or a directional torch turning, changes
 * which frame is live, and the cells that stop being lit are as dirty as the
 * ones that start. Zero when the tile never emits.
 */
export function maxLightRadius(tile: TileDef): number {
  let max = 0;
  for (const sprite of allTileSprites(tile)) {
    for (const frame of sprite.frames) {
      const light = frame.light;
      if (!light || light.intensity <= 0) continue;
      if (light.radius > max) max = light.radius;
    }
  }
  return max;
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

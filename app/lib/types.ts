import * as v from "valibot";
import type { Element } from "./element";
import type { TileInteractions } from "./interactions";
import { particleEmitterSchema, type ParticleEmitterDef } from "./particleVfx";
import { parseTileTransitions, type TileTransitions } from "./tileTransition";
import type { ItemInstance } from "./itemInstance";

export type Direction = "n" | "e" | "s" | "w";

export const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

export type Octant = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Clockwise from north. Angle-to-octant code indexes into it. */
export const OCTANTS: Octant[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

const NEAREST_CARDINAL: Record<Octant, Direction> = {
  n: "n",
  ne: "e",
  e: "e",
  se: "s",
  s: "s",
  sw: "w",
  w: "w",
  nw: "n",
};

export function nearestCardinal(octant: Octant): Direction {
  return NEAREST_CARDINAL[octant];
}

export type CellRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SpriteAnchor = {
  tilesetId: string;
  x: number;
  y: number;
};

export type SpriteRef = {
  rect: CellRect;
  base: { x: number; y: number };
};

export type AnchoredSprite = {
  tilesetId: string;
  rect: CellRect;
  base: { x: number; y: number };
};

export function spriteRect(anchor: SpriteAnchor, ref: SpriteRef): CellRect {
  return {
    x: anchor.x + ref.rect.x,
    y: anchor.y + ref.rect.y,
    w: ref.rect.w,
    h: ref.rect.h,
  };
}

export function anchoredSprite(anchor: SpriteAnchor, ref: SpriteRef): AnchoredSprite {
  return {
    tilesetId: anchor.tilesetId,
    rect: spriteRect(anchor, ref),
    base: ref.base,
  };
}

export type LightDef = {
  radius: number;
  intensity: number;
  color: string;
};

export type Frame = {
  sprite: SpriteRef;
  durationMs: number;
  light?: LightDef;
};

export type SpritePhase = {
  x: number;
  y: number;
};

export type TileSprite = {
  frames: Frame[];
  phase?: SpritePhase;
};

export type TileHeight = 0 | 1 | 2 | 3 | 4;

export type TileType =
  | "simple"
  | "directional"
  | "directional8"
  | "autotile"
  | "scatter"
  | "variant";

export const TILE_TYPES: TileType[] = [
  "simple",
  "directional",
  "directional8",
  "autotile",
  "scatter",
  "variant",
];

export type TileKind = "prop" | "battler" | "item" | "projectile";

export const TILE_KINDS: TileKind[] = ["prop", "battler", "item", "projectile"];

export type FacingKey = "default" | Direction;

export type AutotileSlice = number;

export const AUTOTILE_SLICE_COUNT = 47;

export type SpriteState = "idle" | "moving";

export type OverrideSpriteState = Exclude<SpriteState, "idle">;

export type StateSprites = {
  sprite?: TileSprite;
  sprites?: Partial<Record<Octant, TileSprite>>;
  slices?: Partial<Record<AutotileSlice, TileSprite>>;
  scatter?: TileSprite[];
  variants?: Record<string, TileSprite>;
};

export type TileDef = StateSprites & {
  id: string;
  name: string;
  height: TileHeight;
  type: TileType;
  anchor: SpriteAnchor;
  kind: TileKind;
  attributes: Record<string, never>;
  connectsTo?: string[];
  scatterSeed?: number;
  lightPassing?: boolean;
  blocksLight?: boolean;
  intangible?: boolean;
  affectedByGravity?: boolean;
  walkable?: boolean;
  actor?: boolean;
  walkDurationMs?: number;
  swims?: boolean;
  walkSpeedPercent?: number;
  wade?: boolean;
  climbFrom?: Partial<Record<FacingKey, Partial<Record<Direction, boolean>>>>;
  interactions?: TileInteractions;
  particles?: ParticleEmitterDef;
  transitions?: TileTransitions;
  states?: Partial<Record<OverrideSpriteState, StateSprites>>;
};

export function resolveWalkable(def: TileDef): boolean {
  return def.walkable !== false;
}

export function resolveIntangible(def: TileDef): boolean {
  return def.intangible === true;
}

export function resolveActor(def: TileDef): boolean {
  return def.actor === true || def.interactions?.brain != null || def.interactions?.dialog != null;
}

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
  return def.type === "directional" || def.type === "directional8";
}

export function facingKeysFor(def: TileDef): readonly Octant[] {
  return def.type === "directional8" ? OCTANTS : DIRECTIONS;
}

export function isCellVarying(def: TileDef): boolean {
  return def.type === "autotile" || def.type === "scatter";
}

export function resolveClimbFrom(
  def: TileDef,
  facing: FacingKey = "default",
): Record<Direction, boolean> {
  const key: FacingKey = isDirectional(def) ? (facing === "default" ? "s" : facing) : "default";
  const flags = def.climbFrom?.[key] ?? def.climbFrom?.default;
  return {
    n: flags?.n !== false,
    e: flags?.e !== false,
    s: flags?.s !== false,
    w: flags?.w !== false,
  };
}

export function climbFromForSave(
  def: TileDef,
  byFacing: Partial<Record<FacingKey, Record<Direction, boolean>>>,
): TileDef["climbFrom"] {
  const keys: FacingKey[] = isDirectional(def) ? DIRECTIONS : ["default"];
  const out: NonNullable<TileDef["climbFrom"]> = {};
  let any = false;
  for (const key of keys) {
    const flags = byFacing[key] ?? OPEN_CLIMB;
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

/** A level is four height units so a body can be shorter than a storey. One unit is `PX_PER_HEIGHT` = 2px. */
export const HEIGHT_PER_LEVEL = 4;

export function lightPassingForced(def: TileDef): boolean {
  return def.kind === "item" || def.kind === "battler" || resolveActor(def);
}

export function resolveLightPassing(def: TileDef): boolean {
  if (lightPassingForced(def)) return true;
  if (def.lightPassing != null) return def.lightPassing;
  if (def.blocksLight != null) return !def.blocksLight;
  return false;
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
  variant?: string;
  foot?: number;
  channel?: string;
  inscription?: string;
  description?: string;
  engraved?: string;
  rewardTag?: string;
  rewardTileIds?: string[];
  teleportTo?: Coord;
  owner?: string;
  castBy?: string;
  castElements?: Element[];
  itemId?: string;
  extractsLeft?: number;
  extractsReserved?: number;
  contents?: ItemInstance[];
  count?: number;
};

export const MAX_INSCRIPTION_LENGTH = 240;

export type ChunkCells = Record<string, PlacedTile[]>;

export type LevelChunks = Record<string, ChunkCells>;

export const MAP_FILE_VERSION = 2;

export type MapFile = {
  version: typeof MAP_FILE_VERSION;
  levels: Record<string, LevelChunks>;
};

export type FlatMapFile = {
  version: typeof MAP_FILE_VERSION;
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

/**
 * How far light travels, in cells. Sky spill is seeded at this level and
 * every lateral step costs at least 1, so nothing sky-lit reaches further.
 * `clampTileLight` holds every authored block emitter to the same bound,
 * which is what makes a chunked bake's apron (`LIGHT_APRON`) an exact crop
 * rather than an approximation.
 */
export const MAX_LIGHT_LEVEL = 15;

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

const LEVEL_KEYS: readonly string[] = Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) =>
  String(MIN_LEVEL + i),
);

export function levelKey(z: number): string {
  return LEVEL_KEYS[z - MIN_LEVEL] ?? String(z);
}

export function clampLevel(z: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(z)));
}

export type TileResolveContext = {
  state?: SpriteState;
  direction?: Octant;
  map?: MapFile;
  x?: number;
  y?: number;
  z?: number;
  autotileSlice?: AutotileSlice;
  scatterIndex?: number;
  variant?: string;
};

function framesWithLight(frames: Frame[], light?: LightDef): Frame[] {
  if (!light) return frames;
  return frames.map((f) => (f.light ? f : { ...f, light }));
}

function framesToSprite(frames: Frame[] | undefined, light?: LightDef): TileSprite {
  return { frames: framesWithLight(frames ?? [], light) };
}

function readKind(raw: Record<string, unknown>): TileKind {
  const kind = raw?.kind;
  return typeof kind === "string" && TILE_KINDS.includes(kind as TileKind)
    ? (kind as TileKind)
    : "prop";
}

type AbsoluteSpriteRef = SpriteRef & { tilesetId?: string };

function anchorSprites(def: TileDef): TileDef {
  if (def.anchor) return def;

  let tilesetId = "";
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  mapTileSprites(def, (sprite) => {
    for (const frame of sprite.frames) {
      const ref = frame.sprite as AbsoluteSpriteRef;
      if (!tilesetId && ref.tilesetId) tilesetId = ref.tilesetId;
      left = Math.min(left, ref.rect.x);
      top = Math.min(top, ref.rect.y);
    }
    return sprite;
  });

  const anchor: SpriteAnchor = {
    tilesetId,
    x: Number.isFinite(left) ? left : 0,
    y: Number.isFinite(top) ? top : 0,
  };

  const relative = mapTileSprites(def, (sprite) => ({
    ...sprite,
    frames: sprite.frames.map((frame) => {
      const { tilesetId: _wasOwnSheet, ...ref } = frame.sprite as AbsoluteSpriteRef;
      return {
        ...frame,
        sprite: {
          ...ref,
          rect: {
            ...ref.rect,
            x: ref.rect.x - anchor.x,
            y: ref.rect.y - anchor.y,
          },
        },
      };
    }),
  }));

  return { ...relative, anchor };
}

function settleTileDef(def: TileDef): TileDef {
  const settled = normalizeTileVfx(anchorSprites(def));
  if (!lightPassingForced(settled) || settled.lightPassing === true) {
    return settled;
  }
  return { ...settled, lightPassing: true };
}

export function normalizeTileDef(raw: unknown): TileDef {
  const t = raw as Record<string, unknown>;
  if (t && typeof t.type === "string" && TILE_TYPES.includes(t.type as TileType)) {
    const def = raw as TileDef;
    return settleTileDef({
      ...def,
      variants: def.type === "variant" ? def.variants : undefined,
      attributes: def.attributes ?? {},
      kind: readKind(t),
    });
  }

  const legacy = raw as {
    id: string;
    name: string;
    height: TileHeight;
    directional?: boolean;
    variants?: Partial<Record<FacingKey, Frame[]>>;
    attributes?: Record<string, never>;
    light?: LightDef;
  };

  const light = legacy.light;
  const type: TileType = legacy.directional ? "directional" : "simple";

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
    return settleTileDef({ ...base, sprites });
  }

  return settleTileDef({
    ...base,
    sprite: framesToSprite(legacy.variants?.default, light),
  });
}

export function normalizeTiles(raw: unknown[]): TileDef[] {
  return raw.map(normalizeTileDef);
}

function clampSpriteLight(sprite: TileSprite): TileSprite {
  if (!sprite.frames.some((f) => f.light && f.light.radius > MAX_LIGHT_LEVEL)) {
    return sprite;
  }
  return {
    ...sprite,
    frames: sprite.frames.map((f) =>
      f.light && f.light.radius > MAX_LIGHT_LEVEL
        ? { ...f, light: { ...f.light, radius: MAX_LIGHT_LEVEL } }
        : f,
    ),
  };
}

function mapStateSprites<T extends StateSprites>(
  state: T,
  fn: (sprite: TileSprite) => TileSprite,
): T {
  const out = { ...state };
  if (out.sprite) out.sprite = fn(out.sprite);
  if (out.sprites) {
    out.sprites = Object.fromEntries(
      Object.entries(out.sprites).map(([k, v]) => [k, v ? fn(v) : v]),
    ) as typeof out.sprites;
  }
  if (out.slices) {
    out.slices = Object.fromEntries(
      Object.entries(out.slices).map(([k, v]) => [k, v ? fn(v) : v]),
    ) as typeof out.slices;
  }
  if (out.scatter) out.scatter = out.scatter.map(fn);
  if (out.variants) {
    out.variants = Object.fromEntries(Object.entries(out.variants).map(([k, v]) => [k, fn(v)]));
  }
  return out;
}

function mapTileSprites(tile: TileDef, fn: (sprite: TileSprite) => TileSprite): TileDef {
  const out = mapStateSprites(tile, fn);
  if (!out.states) return out;
  return {
    ...out,
    states: Object.fromEntries(
      Object.entries(out.states).map(([state, sprites]) => [
        state,
        sprites ? mapStateSprites(sprites, fn) : sprites,
      ]),
    ) as TileDef["states"],
  };
}

function clampStateLight<T extends StateSprites>(state: T): T {
  return mapStateSprites(state, clampSpriteLight);
}

export function tilePhase(tile: TileDef): SpritePhase | undefined {
  for (const sprite of allTileSprites(tile)) {
    const phase = sprite.phase;
    if (phase) return phase;
  }
  return undefined;
}

export function withSpritePhase(tile: TileDef, phase: SpritePhase | undefined): TileDef {
  const wanted = phase && (phase.x !== 0 || phase.y !== 0) ? phase : undefined;
  const apply = (sprite: TileSprite): TileSprite => {
    if (!wanted) {
      if (!sprite.phase) return sprite;
      const { phase: _dropped, ...rest } = sprite;
      return rest;
    }
    return { ...sprite, phase: wanted };
  };
  return mapTileSprites(tile, apply);
}

function clampTileLight(def: TileDef): TileDef {
  const out = clampStateLight(def);
  if (!out.states) return out;
  return {
    ...out,
    states: Object.fromEntries(
      Object.entries(out.states).map(([k, v]) => [k, v ? clampStateLight(v) : v]),
    ) as typeof out.states,
  };
}

function normalizeTileVfx(def: TileDef): TileDef {
  return withCheckedTransitions(withCheckedParticles(clampTileLight(def)));
}

function withCheckedTransitions(def: TileDef): TileDef {
  if (def.transitions === undefined) return def;
  const { transitions: raw, ...rest } = def;
  const transitions = parseTileTransitions(raw);
  return transitions ? { ...rest, transitions } : rest;
}

function withCheckedParticles(def: TileDef): TileDef {
  if (!def.particles) return def;
  const parsed = v.safeParse(particleEmitterSchema, def.particles);
  if (!parsed.success) {
    const { particles: _malformed, ...rest } = def;
    return rest;
  }
  return { ...def, particles: parsed.output };
}

function stateSpritesOn(tile: TileDef, from: StateSprites): TileSprite[] {
  if (tile.type === "simple") {
    return from.sprite ? [from.sprite] : [];
  }
  if (isDirectional(tile)) {
    return facingKeysFor(tile)
      .map((d) => from.sprites?.[d])
      .filter((s): s is TileSprite => s != null);
  }
  if (tile.type === "variant") {
    return Object.values(from.variants ?? {}).filter((s): s is TileSprite => s != null);
  }
  if (tile.type === "scatter") {
    return (from.scatter ?? []).filter((s): s is TileSprite => s != null);
  }
  if (!from.slices) return [];
  return Object.values(from.slices).filter((s): s is TileSprite => s != null);
}

export function allTileSprites(tile: TileDef): TileSprite[] {
  const out = stateSpritesOn(tile, tile);
  for (const state of Object.values(tile.states ?? {})) {
    if (state) out.push(...stateSpritesOn(tile, state));
  }
  return out;
}

export function isAnimated(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) => s.frames.length > 1);
}

export function tileCanEmitLight(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) =>
    s.frames.some((f) => f.light && f.light.radius > 0 && f.light.intensity > 0),
  );
}

function frameLightKey(light: LightDef | undefined): string {
  return light ? `${light.radius},${light.intensity},${light.color}` : "";
}

function spriteLightVaries(sprite: TileSprite): boolean {
  if (sprite.frames.length < 2) return false;
  const first = frameLightKey(sprite.frames[0]!.light);
  return sprite.frames.some((f) => frameLightKey(f.light) !== first);
}

export function tileLightVaries(tile: TileDef): boolean {
  return allTileSprites(tile).some(spriteLightVaries);
}

export function tileEmissionPhase(tile: TileDef, timeMs: number): string {
  let phase = "";
  for (const sprite of allTileSprites(tile)) {
    if (!spriteLightVaries(sprite)) continue;
    phase += `${frameIndexAtTime(sprite.frames, timeMs)},`;
  }
  return phase;
}

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

export function cycleMs(frames: Frame[]): number {
  let total = 0;
  for (const f of frames) total += Math.max(1, f.durationMs);
  return total;
}

export function frameStartMs(frames: Frame[], index: number): number {
  let start = 0;
  const upto = Math.min(index, frames.length);
  for (let i = 0; i < upto; i++) start += Math.max(1, frames[i]!.durationMs);
  return start;
}

export function spritePhase(sprite: TileSprite): SpritePhase | undefined {
  if (!sprite.phase) return undefined;
  if (sprite.frames.length < 2) return undefined;
  if (spriteLightVaries(sprite)) return undefined;
  return sprite.phase;
}

export function cellPhaseMs(sprite: TileSprite, x: number, y: number): number {
  const phase = spritePhase(sprite);
  if (!phase) return 0;
  const count = sprite.frames.length;
  const step = (((phase.x * x + phase.y * y) % count) + count) % count;
  return frameStartMs(sprite.frames, step);
}

import {
  pickAutotileSprite,
  resolveAutotileSlice,
} from "./autotile";
import {
  facingKeysFor,
  frameAtTime,
  isDirectional,
  nearestCardinal,
  type Direction,
  type Octant,
  type Frame,
  type LightDef,
  type MapFile,
  type SpriteState,
  type StateSprites,
  type TileDef,
  type TileResolveContext,
  type TileSprite,
} from "./types";

/**
 * The state's own sprites, or nothing when it is idle or unauthored.
 *
 * `idle` is never looked up: it *is* the def's inline sprites, so asking for it
 * here would be asking `states.idle` to exist. See {@link TileDef.states}.
 */
function overrideFor(
  tile: TileDef,
  state: SpriteState | undefined,
): StateSprites | undefined {
  if (state == null || state === "idle") return undefined;
  return tile.states?.[state];
}

/**
 * Which sprite a placement draws with.
 *
 * Resolves the {@link SpriteState} first and the tile's own axis second, falling
 * back to idle at every step so a sparsely authored state is usable rather than
 * blank.
 *
 * **Facing outranks state in the fallback**, which is the one ordering here worth
 * arguing about. A deer that authors `moving` facing south only, walking east,
 * draws the *standing east* sprite rather than the walking south one: a creature
 * facing the wrong way reads as a bug, while one that forgets to animate reads as
 * art not finished yet. So a missing variant falls through to idle's same
 * direction, never to the state's other directions.
 */
export function resolveTileSprite(
  tile: TileDef,
  ctx: TileResolveContext = {},
): TileSprite | undefined {
  const override = overrideFor(tile, ctx.state);

  if (tile.type === "simple") {
    return override?.sprite ?? tile.sprite;
  }
  if (isDirectional(tile)) {
    const dir = ctx.direction ?? "s";
    // The bearing itself, then the cardinal it is nearest to, then south. The
    // middle step is what makes a half-authored eight-way tile usable and a
    // four-way tile answerable at all when something asks it for a corner: an
    // arrow authored only on the cardinals points east on its way north-east,
    // which reads as art not finished rather than as an arrow flying sideways.
    // Falling straight through to south instead would do exactly that.
    const cardinal = nearestCardinal(dir);
    return (
      override?.sprites?.[dir] ??
      tile.sprites?.[dir] ??
      override?.sprites?.[cardinal] ??
      tile.sprites?.[cardinal] ??
      tile.sprites?.s
    );
  }
  // autotile
  let slice = ctx.autotileSlice;
  if (slice == null && ctx.map != null && ctx.x != null && ctx.y != null && ctx.z != null) {
    slice = resolveAutotileSlice(ctx.map, ctx.x, ctx.y, ctx.z, tile);
  }
  if (slice == null) slice = 0;
  // This slice on the state and no other, then idle with its full slice
  // fallback. Asking `pickAutotileSprite` for the override would let *its*
  // fallback answer first, so a tile authoring `moving` for one shape would
  // wear that shape in every neighbourhood while it moved — the same mistake as
  // letting a state outrank facing, in autotile clothing.
  return override?.slices?.[slice] ?? pickAutotileSprite(tile, slice);
}

export function getFrames(
  tile: TileDef,
  ctx: TileResolveContext | Octant = {},
): Frame[] | undefined {
  const resolved =
    typeof ctx === "string"
      ? resolveTileSprite(tile, { direction: ctx })
      : resolveTileSprite(tile, ctx);
  return resolved?.frames;
}

/** Light from the active animation frame for this placement. */
export function resolveLight(
  tile: TileDef,
  ctx: TileResolveContext = {},
  timeMs = 0,
): LightDef | undefined {
  const frames = getFrames(tile, ctx);
  if (!frames?.length) return undefined;
  const frame = frameAtTime(frames, timeMs);
  const light = frame?.light;
  if (!light || !(light.radius > 0) || !(light.intensity > 0)) return undefined;
  return light;
}

/**
 * Compact fingerprint of all frame lights (editor cache invalidation).
 *
 * Spans every {@link SpriteState} for the reason `allTileSprites` does: a light
 * authored on a state the signature cannot see is a light the cache never
 * notices anybody editing.
 */
export function tileLightSignature(tile: TileDef): string {
  const parts: string[] = [];
  const pushSprite = (key: string, sprite: TileSprite | undefined) => {
    if (!sprite) return;
    for (let i = 0; i < sprite.frames.length; i++) {
      const L = sprite.frames[i].light;
      if (!L) continue;
      parts.push(`${key}@${i}:${L.radius},${L.intensity},${L.color}`);
    }
  };
  const pushState = (prefix: string, from: StateSprites) => {
    if (tile.type === "simple") {
      pushSprite(`${prefix}default`, from.sprite);
    } else if (isDirectional(tile)) {
      for (const d of facingKeysFor(tile)) {
        pushSprite(`${prefix}${d}`, from.sprites?.[d]);
      }
    } else if (from.slices) {
      for (const [k, s] of Object.entries(from.slices)) {
        pushSprite(`${prefix}${k}`, s);
      }
    }
  };

  pushState("", tile);
  for (const [state, sprites] of Object.entries(tile.states ?? {})) {
    if (sprites) pushState(`${state}/`, sprites);
  }
  return parts.join("|");
}

export type PlacementLightCtx = {
  map: MapFile;
  x: number;
  y: number;
  z: number;
  direction?: Direction;
  timeMs?: number;
};

export function resolvePlacementLight(
  tile: TileDef,
  ctx: PlacementLightCtx,
): LightDef | undefined {
  return resolveLight(
    tile,
    {
      map: ctx.map,
      x: ctx.x,
      y: ctx.y,
      z: ctx.z,
      direction: ctx.direction,
    },
    ctx.timeMs ?? 0,
  );
}

export { isDirectional };

import { pickAutotileSprite, resolveAutotileSlice } from "./autotile";
import { pickScatterSprite, resolveScatterIndex } from "./scatter";
import { pickVariantSprite, variantKeys } from "./variant";
import {
  facingKeysFor,
  frameAtTime,
  isDirectional,
  nearestCardinal,
  type Octant,
  type Frame,
  type LightDef,
  type SpriteState,
  type StateSprites,
  type TileDef,
  type TileResolveContext,
  type TileSprite,
} from "./types";

function overrideFor(tile: TileDef, state: SpriteState | undefined): StateSprites | undefined {
  if (state == null || state === "idle") return undefined;
  return tile.states?.[state];
}

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
    /**
     * Facing outranks state in this fallback: a missing variant falls
     * through to idle's same direction, never to the state's other
     * directions. Falling straight to south instead would draw a creature
     * facing the wrong way, which reads as a bug more than a missing
     * animation does.
     */
    const cardinal = nearestCardinal(dir);
    return (
      override?.sprites?.[dir] ??
      tile.sprites?.[dir] ??
      override?.sprites?.[cardinal] ??
      tile.sprites?.[cardinal] ??
      tile.sprites?.s
    );
  }
  if (tile.type === "variant") {
    /**
     * The key is settled against idle before either holder is asked, so a
     * placement that names no face draws the same one in every state.
     * Letting each holder answer "first authored" for itself would change
     * face when the tile changed state.
     */
    const key = ctx.variant ?? variantKeys(tile)[0];
    return override?.variants?.[key ?? ""] ?? pickVariantSprite(tile, key);
  }
  if (tile.type === "scatter") {
    /**
     * Counted off idle even when a state is drawing, so a placement keeps
     * its face while it moves. Counting off the override instead would
     * re-pick it the moment the state changed.
     */
    const count = tile.scatter?.length ?? 0;
    let index = ctx.scatterIndex;
    if (index == null && ctx.x != null && ctx.y != null && ctx.z != null) {
      index = resolveScatterIndex(ctx.x, ctx.y, ctx.z, tile, count);
    }
    if (index == null) index = 0;
    return override?.scatter?.[index] ?? pickScatterSprite(tile, index);
  }
  let slice = ctx.autotileSlice;
  if (slice == null && ctx.map != null && ctx.x != null && ctx.y != null && ctx.z != null) {
    slice = resolveAutotileSlice(ctx.map, ctx.x, ctx.y, ctx.z, tile);
  }
  if (slice == null) slice = 0;
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
    } else if (tile.type === "variant") {
      for (const [k, s] of Object.entries(from.variants ?? {})) {
        pushSprite(`${prefix}${k}`, s);
      }
    } else if (tile.type === "scatter") {
      from.scatter?.forEach((s, i) => pushSprite(`${prefix}${i}`, s));
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

export { isDirectional };

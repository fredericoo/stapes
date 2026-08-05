import {
  pickAutotileSprite,
  resolveAutotileSlice,
} from "./autotile";
import {
  DIRECTIONS,
  frameAtTime,
  isDirectional,
  type Direction,
  type Frame,
  type LightDef,
  type MapFile,
  type TileDef,
  type TileResolveContext,
  type TileSprite,
} from "./types";

export function resolveTileSprite(
  tile: TileDef,
  ctx: TileResolveContext = {},
): TileSprite | undefined {
  if (tile.type === "simple") {
    return tile.sprite;
  }
  if (tile.type === "directional") {
    const dir = ctx.direction ?? "s";
    return tile.sprites?.[dir] ?? tile.sprites?.s;
  }
  // autotile
  let slice = ctx.autotileSlice;
  if (slice == null && ctx.map != null && ctx.x != null && ctx.y != null && ctx.z != null) {
    slice = resolveAutotileSlice(ctx.map, ctx.x, ctx.y, ctx.z, tile.id);
  }
  if (slice == null) slice = 0;
  return pickAutotileSprite(tile, slice);
}

export function getFrames(
  tile: TileDef,
  ctx: TileResolveContext | Direction = {},
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

/** Compact fingerprint of all frame lights (editor cache invalidation). */
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
  if (tile.type === "simple") {
    pushSprite("default", tile.sprite);
  } else if (tile.type === "directional") {
    for (const d of DIRECTIONS) pushSprite(d, tile.sprites?.[d]);
  } else if (tile.slices) {
    for (const [k, s] of Object.entries(tile.slices)) pushSprite(k, s);
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

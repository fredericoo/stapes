import * as THREE from "three";
import { baseCellWorldOrigin, spriteWorldOrigin } from "../lib/geometry";
import { getFrames } from "../lib/tileResolve";
import type {
  MapFile,
  PlacedTile,
  SpriteState,
  TileDef,
  TilesetDef,
} from "../lib/types";
import { CELL_SIZE, isCellVarying } from "../lib/types";

/** A sprite's footprint in world pixels plus its slice of the atlas. */
export type SpriteQuad = {
  x: number;
  y: number;
  w: number;
  h: number;
  texture: THREE.Texture;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

export type SpriteQuadAssets = {
  tilesetById: Map<string, TilesetDef>;
  textures: Map<string, THREE.Texture>;
  /** Stand-in when a tileset is missing, so a quad is still produced. */
  fallbackTexture: THREE.Texture;
  /** Frame on screen right now, keyed by {@link animationKey}. */
  frameIndices: Map<string, number>;
};

/**
 * Autotiles and scatter tiles vary per cell; everything else varies only by what
 * the placement says — its facing, its variant — and by state. Both renderers
 * key their frame clocks this way, so overlays stay in step with the animated
 * tile they are drawn over.
 *
 * The state is part of the key because two placements of one tile in different
 * states run different frame lists — a grazing deer has one frame and a walking
 * one has four. Sharing a clock between them would index the short list with the
 * long list's position. A variant is part of it for exactly that reason one step
 * along: two holes in one map wear different faces, and a hole cut in planks has
 * no obligation to have been drawn with as many frames as a hole cut in water.
 */
export function animationKey(
  def: TileDef,
  placed: PlacedTile,
  x: number,
  y: number,
  z: number,
  state: SpriteState = "idle",
): string {
  if (isCellVarying(def)) return `${def.id}:${x},${y},${z}:${state}`;
  const face = placed.variant ?? placed.direction ?? "default";
  return `${def.id}:${face}:${state}`;
}

/**
 * World-space quad for a placed tile, resolved against the frame that is on
 * screen right now.
 */
export function spriteQuadFor(
  assets: SpriteQuadAssets,
  map: MapFile,
  cell: { x: number; y: number; z: number; elevation: number },
  placed: PlacedTile,
  def: TileDef,
  state: SpriteState = "idle",
): SpriteQuad | null {
  const { x, y, z, elevation } = cell;
  const frames = getFrames(def, {
    state,
    direction: placed.direction,
    variant: placed.variant,
    map,
    x,
    y,
    z,
  });

  let frame = frames?.[0];
  if (frames && frames.length > 1) {
    const key = animationKey(def, placed, x, y, z, state);
    frame = frames[assets.frameIndices.get(key) ?? 0] ?? frames[0];
  }
  if (!frame) return null;

  const tileset = assets.tilesetById.get(frame.sprite.tilesetId);
  const { rect } = frame.sprite;
  const tw = tileset?.width ?? CELL_SIZE;
  const th = tileset?.height ?? CELL_SIZE;
  const origin = spriteWorldOrigin(
    baseCellWorldOrigin(x, y, z, elevation),
    frame.sprite.base,
  );

  return {
    x: origin.x,
    y: origin.y,
    w: rect.w * CELL_SIZE,
    h: rect.h * CELL_SIZE,
    texture:
      (tileset && assets.textures.get(tileset.id)) || assets.fallbackTexture,
    u0: (rect.x * CELL_SIZE) / tw,
    u1: ((rect.x + rect.w) * CELL_SIZE) / tw,
    v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / th,
    v1: 1 - (rect.y * CELL_SIZE) / th,
  };
}

import * as THREE from "three";
import { baseCellWorldOrigin, spriteWorldOrigin } from "../lib/geometry";
import { getFrames } from "../lib/tileResolve";
import type { MapFile, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { CELL_SIZE } from "../lib/types";

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
 * Autotiles vary per cell; everything else varies only by facing. Both
 * renderers key their frame clocks this way, so overlays stay in step with
 * the animated tile they are drawn over.
 */
export function animationKey(
  def: TileDef,
  placed: PlacedTile,
  x: number,
  y: number,
  z: number,
): string {
  if (def.type === "autotile") return `${def.id}:${x},${y},${z}`;
  return `${def.id}:${placed.direction ?? "default"}`;
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
): SpriteQuad | null {
  const { x, y, z, elevation } = cell;
  const frames = getFrames(def, { direction: placed.direction, map, x, y, z });

  let frame = frames?.[0];
  if (frames && frames.length > 1) {
    const key = animationKey(def, placed, x, y, z);
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

/** True when `(px, py)` in world pixels falls inside the quad's rect. */
export function quadContains(
  quad: SpriteQuad,
  px: number,
  py: number,
): boolean {
  return (
    px >= quad.x &&
    px < quad.x + quad.w &&
    py >= quad.y &&
    py < quad.y + quad.h
  );
}

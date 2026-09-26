import * as THREE from "three";
import { baseCellWorldOrigin, spriteWorldOrigin } from "../lib/geometry";
import { getFrames } from "../lib/tileResolve";
import type { MapFile, PlacedTile, SpriteState, TileDef, TilesetDef } from "../lib/types";
import { CELL_SIZE, isCellVarying, spriteRect } from "../lib/types";

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
  fallbackTexture: THREE.Texture;
  frameIndices: Map<string, number>;
};

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

  const tileset = assets.tilesetById.get(def.anchor.tilesetId);
  const rect = spriteRect(def.anchor, frame.sprite);
  const tw = tileset?.width ?? CELL_SIZE;
  const th = tileset?.height ?? CELL_SIZE;
  const origin = spriteWorldOrigin(baseCellWorldOrigin(x, y, z, elevation), frame.sprite.base);

  return {
    x: origin.x,
    y: origin.y,
    w: rect.w * CELL_SIZE,
    h: rect.h * CELL_SIZE,
    texture: (tileset && assets.textures.get(tileset.id)) || assets.fallbackTexture,
    u0: (rect.x * CELL_SIZE) / tw,
    u1: ((rect.x + rect.w) * CELL_SIZE) / tw,
    v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / th,
    v1: 1 - (rect.y * CELL_SIZE) / th,
  };
}

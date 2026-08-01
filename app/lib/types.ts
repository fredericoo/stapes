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

export type TileHeight = 0 | 1 | 2 | 3 | 4;

export type VariantKey = "default" | Direction;

export type TileDef = {
  id: string;
  name: string;
  height: TileHeight;
  directional: boolean;
  /** Direction-less tiles use only "default"; directional use n/e/s/w. */
  variants: Partial<Record<VariantKey, Frame[]>>;
  /** Reserved for flammable/wet/frozen/pushable later. */
  attributes: Record<string, never>;
};

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

import type {
  SpriteAnchor,
  SpriteRef,
  StateSprites,
  TileDef,
  TileSprite,
  TilesetDef,
} from "./types";

const CELL_PX = 8;

function mapTable<T extends Partial<Record<never, TileSprite>>>(
  table: T,
  f: (sprite: TileSprite) => TileSprite,
): T {
  const out: Record<string, TileSprite> = {};
  for (const [key, sprite] of Object.entries(table)) {
    if (sprite) out[key] = f(sprite as TileSprite);
  }
  return out as T;
}

function mapSprites<T extends StateSprites>(holder: T, f: (sprite: TileSprite) => TileSprite): T {
  const out: T = { ...holder };
  if (holder.sprite) out.sprite = f(holder.sprite);
  if (holder.sprites) out.sprites = mapTable(holder.sprites, f);
  if (holder.scatter) out.scatter = holder.scatter.map(f);
  if (holder.variants) out.variants = mapTable(holder.variants, f);
  if (holder.slices) out.slices = mapTable(holder.slices, f);
  return out;
}

function blockExtent(tile: TileDef): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  const measure = (holder: StateSprites) => {
    mapSprites(holder, (sprite) => {
      for (const frame of sprite.frames) {
        const { rect } = frame.sprite;
        left = Math.min(left, rect.x);
        top = Math.min(top, rect.y);
        right = Math.max(right, rect.x + rect.w);
        bottom = Math.max(bottom, rect.y + rect.h);
      }
      return sprite;
    });
  };
  measure(tile);
  for (const override of Object.values(tile.states ?? {})) {
    if (override) measure(override);
  }
  return { left, top, right, bottom };
}

export function anchorFits(
  tile: TileDef,
  anchor: SpriteAnchor,
  tilesets: TilesetDef[],
): string | null {
  const sheet = tilesets.find((t) => t.id === anchor.tilesetId);
  if (!sheet) return "No such sheet";

  const { left, top, right, bottom } = blockExtent(tile);
  if (anchor.x + left < 0 || anchor.y + top < 0) {
    return `This tile's art would run off the top or left of ${sheet.name}`;
  }
  const cols = Math.floor(sheet.width / CELL_PX);
  const rows = Math.floor(sheet.height / CELL_PX);
  if (anchor.x + right > cols || anchor.y + bottom > rows) {
    return `This tile's art would run off the bottom or right of ${sheet.name}`;
  }
  return null;
}

export function spriteRefAt(anchor: SpriteAnchor, picked: SpriteRef): SpriteRef {
  return {
    ...picked,
    rect: {
      ...picked.rect,
      x: picked.rect.x - anchor.x,
      y: picked.rect.y - anchor.y,
    },
  };
}

export function nextFreeTileId(id: string, taken: Set<string>): string {
  const numbered = /^(.*)-(\d+)$/.exec(id);
  const base = numbered ? numbered[1]! : id;
  let n = numbered ? Number(numbered[2]!) + 1 : 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

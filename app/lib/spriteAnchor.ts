import type {
  SpriteAnchor,
  SpriteRef,
  StateSprites,
  TileDef,
  TileSprite,
  TilesetDef,
} from "./types";

const CELL_PX = 8;

/**
 * A sparse table of sprites, mapped, with its holes left as holes.
 *
 * Keyed by whatever the table was keyed by, including the numeric slice index:
 * a property written as `"12"` and one written as `12` are the same property,
 * so nothing has to convert it back.
 */
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

/**
 * Every sprite the holder carries, whichever axis it uses, run through `f`.
 *
 * Generic over the holder because {@link TileDef} *is* a {@link StateSprites}
 * with the id, the name and every behaviour flag alongside it: idle's sprites
 * live on the tile itself, and a state override is the same five fields one
 * level down. Spreading the holder keeps whatever else it was carrying.
 */
function mapSprites<T extends StateSprites>(
  holder: T,
  f: (sprite: TileSprite) => TileSprite,
): T {
  const out: T = { ...holder };
  if (holder.sprite) out.sprite = f(holder.sprite);
  if (holder.sprites) out.sprites = mapTable(holder.sprites, f);
  if (holder.scatter) out.scatter = holder.scatter.map(f);
  if (holder.variants) out.variants = mapTable(holder.variants, f);
  if (holder.slices) out.slices = mapTable(holder.slices, f);
  return out;
}

/**
 * The block of sheet this tile draws from, in cells measured from its anchor.
 *
 * Both edges, not only the far one: a rect relative to the anchor is allowed to
 * be negative. The anchor is the point the art is measured from rather than a
 * corner it is boxed into — a sprite dragged to the left of it is art the author
 * meant, and the migration only picks the corner because that is where a block
 * written absolutely happened to start.
 *
 * Empty for a tile with no art, which fits anywhere.
 */
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

/**
 * Why this anchor cannot be used for this tile's art, or null if it can.
 *
 * Refused rather than clamped: an anchor clamped back onto the sheet would move
 * the block somewhere nobody chose, and the sprites in it would all still be at
 * their old distances from each other — a character drawn from whatever happened
 * to be under the new corner.
 *
 * A sheet the anchor names but that is not in the library is refused outright,
 * because the size of it is what this function is checking against and a guess
 * would be a check that passes on nothing.
 */
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

/**
 * A rectangle picked off the sheet, as the tile stores it.
 *
 * The inverse of `spriteRect`, and the other half of the editor's picker: what
 * an author drags out is a rectangle on the picture in front of them, and what
 * the tile keeps is that rectangle measured from its anchor.
 *
 * Nothing stops the result being negative. The anchor is the point the art is
 * measured from rather than a corner it is boxed into, so a sprite picked above
 * or to the left of it is art the author meant — and {@link anchorFits} checks
 * both edges for exactly that reason.
 */
export function spriteRefAt(anchor: SpriteAnchor, picked: SpriteRef): SpriteRef {
  return {
    ...picked,
    // `base` is a cell *within* the rect, so re-measuring the rect carries it.
    rect: {
      ...picked.rect,
      x: picked.rect.x - anchor.x,
      y: picked.rect.y - anchor.y,
    },
  };
}

/**
 * A free id near `id`: `guard` becomes `guard-2`, and `guard-2` becomes
 * `guard-3`.
 *
 * Counting up from the number already on the end rather than appending `-copy`
 * to it, because the case this exists for is a row of siblings — `villager-2`,
 * `villager-3` — and `villager-copy-copy` is what appending gives you on the
 * third one.
 */
export function nextFreeTileId(id: string, taken: Set<string>): string {
  const numbered = /^(.*)-(\d+)$/.exec(id);
  const base = numbered ? numbered[1]! : id;
  let n = numbered ? Number(numbered[2]!) + 1 : 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

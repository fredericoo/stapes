import type {
  Frame,
  SpriteRef,
  StateSprites,
  TileDef,
  TileSprite,
  TilesetDef,
} from "./types";

/** How far to move a sprite on the sheet, in 8px cells. @see SpriteRef.rect */
export type CellOffset = { x: number; y: number };

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

/** Every sprite reference in the tile, idle and per-state, frame by frame. */
export function spriteRefs(tile: TileDef): SpriteRef[] {
  const out: SpriteRef[] = [];
  const collect = (holder: StateSprites) => {
    mapSprites(holder, (sprite) => {
      for (const frame of sprite.frames) out.push(frame.sprite);
      return sprite;
    });
  };
  collect(tile);
  for (const override of Object.values(tile.states ?? {})) {
    if (override) collect(override);
  }
  return out;
}

function shiftFrame(frame: Frame, by: CellOffset): Frame {
  const { rect } = frame.sprite;
  return {
    ...frame,
    sprite: {
      ...frame.sprite,
      // `base` is a cell *within* the rect, so moving the rect carries it.
      rect: { ...rect, x: rect.x + by.x, y: rect.y + by.y },
    },
  };
}

/**
 * The tile with every one of its sprites moved `by` cells on its sheet.
 *
 * The whole tile at once rather than the sprite in front of the author, because
 * the case this exists for is a character: eight facings times three states of
 * art, drawn as one block on the sheet and copied to the block beside it. Picked
 * one by one that is twenty-four drag-selects, every one of which can land a
 * cell off without saying so.
 *
 * Out-of-bounds is {@link offsetFits}' question, not this function's — a check
 * that silently declined to move some of the sprites would leave a tile whose
 * facings no longer agree with each other.
 */
export function offsetTileSprites(tile: TileDef, by: CellOffset): TileDef {
  const shift = (sprite: TileSprite): TileSprite => ({
    ...sprite,
    frames: sprite.frames.map((f) => shiftFrame(f, by)),
  });

  const moved = mapSprites(tile, shift);
  if (!tile.states) return moved;
  return {
    ...moved,
    states: Object.fromEntries(
      Object.entries(tile.states).map(([state, sprites]) => [
        state,
        sprites ? mapSprites(sprites, shift) : sprites,
      ]),
    ),
  };
}

/**
 * Why the offset cannot be applied, or null if it can.
 *
 * Refused rather than clamped: a sprite clamped back onto the sheet stops being
 * the same distance from its neighbours, and the result is a character whose
 * facings are drawn from different places. A tileset the tile names but that is
 * not in the library is skipped — the sheet's size is unknown, and a missing
 * tileset is already its own problem.
 */
export function offsetFits(
  tile: TileDef,
  by: CellOffset,
  tilesets: TilesetDef[],
): string | null {
  const byId = new Map(tilesets.map((t) => [t.id, t]));
  for (const ref of spriteRefs(tile)) {
    const x = ref.rect.x + by.x;
    const y = ref.rect.y + by.y;
    if (x < 0 || y < 0) {
      return "Offset would move a sprite off the top or left of the sheet";
    }
    const sheet = byId.get(ref.tilesetId);
    if (!sheet) continue;
    const cols = Math.floor(sheet.width / CELL_PX);
    const rows = Math.floor(sheet.height / CELL_PX);
    if (x + ref.rect.w > cols || y + ref.rect.h > rows) {
      return `Offset would move a sprite past the edge of ${sheet.name}`;
    }
  }
  return null;
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

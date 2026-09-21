/**
 * The tile builder the unit suite uses to stand something up on a board.
 *
 * Sixty-odd test files needed a `TileDef` to place, and each wrote its own
 * twelve-line factory around {@link normalizeTileDef} to get one. Thirty-seven
 * of them also carried a byte-identical `frame` constant. They agreed on every
 * default, so the copies were not saying anything different — they were the
 * same helper written again because there was nowhere to put it.
 *
 * This is not a fixture world and does not replace building one. `./fixtureTown`
 * is still the stand-in map, and a test about a particular board still builds
 * its cells by hand. What is shared here is only the shape of a tile nobody
 * cares about: the thing you place so that the cell is occupied, whose sprite
 * and name the test under it never reads.
 *
 * A test that *does* care about a tile's defaults should not use this. Pass what
 * matters — every field spreads over the defaults — or write the def out in
 * full where the point of the test is the def.
 */
import { normalizeTileDef } from "./types";
import type { TileDef } from "./types";

/**
 * One frame of a one-cell sprite, anchored at its corner.
 *
 * Every field is the least interesting value it could hold. `basic` is a real
 * tileset in `data/tilesets.json`, so a renderer test that resolves this gets a
 * sheet rather than a miss, and 200ms is long enough that a single-frame cycle
 * never advances inside a test's tick.
 *
 * Deliberately not annotated `Frame`. `tilesetId` is not on {@link SpriteRef} —
 * it belongs to the anchored form — and the copies this replaces were untyped
 * literals on their way into {@link normalizeTileDef}, which takes `unknown`.
 * Annotating it would be this helper rejecting what every one of its callers
 * has always built.
 */
export const FRAME = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

/**
 * A tile with the given id and nothing else worth reading.
 *
 * `name` follows `id` because no test asserts on both, and `height` defaults to
 * flat ground. Everything passed in spreads over the defaults, including the
 * ones above it, so `tile({ id: "wall", height: 4 })` is a wall and
 * `tile({ id: "x", variants: ... })` draws whatever it likes.
 *
 * Where a file wants a different default for every tile it builds — a `kind`, an
 * `intangible` — it wraps this rather than copying it:
 *
 * ```ts
 * const propTile = (partial: Record<string, unknown> & Pick<TileDef, "id">) =>
 *   tile({ kind: "prop", ...partial });
 * ```
 */
export function tile(partial: Record<string, unknown> & Pick<TileDef, "id">): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    ...partial,
  });
}

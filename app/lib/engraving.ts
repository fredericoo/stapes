/**
 * A name with somebody's name written into it.
 *
 * A tile def's `name` is what a kind of thing is called; a skull is the case
 * that breaks it, because what a skull is, is whose it is. So the def names
 * the shape with a hole in it, `%s's skull`, and the placement fills the hole:
 * see `./types`' {@link PlacedTile.engraved}.
 *
 * One token, one substitution, not a format string: authored names are typed
 * into the tile editor by somebody not thinking about escaping.
 */

export const ENGRAVING_TOKEN = "%s";

/**
 * Filler for a missing engraving. Cutting the token out instead would leave
 * `'s skull`.
 */
export const UNKNOWN_ENGRAVING = "Someone";

export function isEngravable(name: string): boolean {
  return name.includes(ENGRAVING_TOKEN);
}

export function engravedName(name: string, engraved?: string): string {
  if (!isEngravable(name)) return name;
  return name.replaceAll(ENGRAVING_TOKEN, engraved?.trim() || UNKNOWN_ENGRAVING);
}

/**
 * Cap on {@link PlacedTile.engraved}, in characters. A layout bound, like
 * `./types`' {@link MAX_DESCRIPTION_LENGTH}: the engraving goes inside a name,
 * and a name is drawn on one line over its square.
 */
export const MAX_ENGRAVING_LENGTH = 40;

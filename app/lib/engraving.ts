/**
 * A name with somebody's name written into it.
 *
 * A tile def's `name` is what a *kind* of thing is called, and that is the right
 * home for almost everything: every rusty sword in the world is a Rusty Sword.
 * A skull is the case that breaks it — what a skull is, is whose it is, and a
 * shelf of them all reading "Skull" is a shelf you cannot sort. So the def
 * names the shape with a hole in it, `%s's skull`, and the placement fills the
 * hole in: see `./types`' {@link PlacedTile.engraved}.
 *
 * **A substitution and not a format string.** There is one token, it takes one
 * word, and it is deliberately not `printf`: an authored name is typed into the
 * tile editor by somebody who is not thinking about escaping, and a second
 * token would be a second question about which of two things fills it.
 */

/** What an engraving replaces, wherever it appears in a name. */
export const ENGRAVING_TOKEN = "%s";

/**
 * Whose it is when nobody wrote it down.
 *
 * A name with the token cut out of it entirely reads as `'s skull`, and one with
 * the possessive cut out too is a lower-case fragment in a position that wants a
 * name. An anonymous skull is still somebody's — you just do not know whose —
 * so the honest filler is a word that says exactly that.
 */
export const UNKNOWN_ENGRAVING = "Someone";

/** Whether a tile's name has a hole in it for a name to go in. */
export function isEngravable(name: string): boolean {
  return name.includes(ENGRAVING_TOKEN);
}

/**
 * What to call this particular one.
 *
 * Total, and cheap on the overwhelming majority: a name with no token is handed
 * straight back, which is every tile in the world but the skulls.
 */
export function engravedName(name: string, engraved?: string): string {
  if (!isEngravable(name)) return name;
  return name.replaceAll(ENGRAVING_TOKEN, engraved?.trim() || UNKNOWN_ENGRAVING);
}

/**
 * Cap on {@link PlacedTile.engraved}, in characters.
 *
 * A layout bound, exactly as `./types`' {@link MAX_DESCRIPTION_LENGTH} is: the
 * engraving goes *inside* a name, and a name is drawn on one line over the
 * square it belongs to. Generous next to the two words a body is called, so
 * that authoring "The Hermit of the Eastern Wood" is possible and a paragraph
 * is not.
 */
export const MAX_ENGRAVING_LENGTH = 40;

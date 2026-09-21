/**
 * What to call somebody.
 *
 * A name is typed once, when the character is made, and never again — see
 * `../lib/characterName`, which is where the rules about it live. It travels
 * with the body: the simulation holds it on the actor, the wire carries it
 * beside the actor's id, and everything that draws a label reads it off the
 * snapshot in front of it.
 *
 * **It used to be derived, and the change is not cosmetic.** Identity was an
 * anonymous cookie, so a name was two words hashed out of the uuid ("Green
 * Fox") — the only way to make a room of serial numbers legible. Nobody chose
 * one, two people could be handed the same one, and there was nothing to
 * address a person by that would still mean them tomorrow. A typed, unique,
 * permanent name is the thing accounts were worth adding for.
 *
 * None of the above applies to a creature, which is named after its tile —
 * see {@link bodyNameFor}.
 */

import { RATING_GLYPH } from "../lib/mastery";
import { PLAYER_TILE_ID } from "./constants";
import { PVP_MARK } from "./pvp";
import type { TileDef } from "../lib/types";

/**
 * What a body with no name to give is called.
 *
 * Reached in one case that is not a bug: the offline session in `/admin/play`,
 * whose single player has no account and therefore no character row. It is
 * also what a player body would read as if the character table lost its row
 * mid-session, which is a state nothing should produce and everything should
 * survive — a blank label over a head is a body nobody can talk about.
 */
export const UNNAMED_BODY = "Nobody";

/**
 * What to call a body — which is not the same question for a person and for a
 * deer.
 *
 * Two callers now: attributing something said, and the name tag over every
 * battler's head. They want the same answer, which is the reason this is a
 * function rather than a line inside either of them.
 *
 * A person carries their name, because they typed it. A creature does not: it
 * *is* the tile, one of a handful an author wrote and named ("Deer", "Cat"),
 * and every one of them on the map is the same thing. Giving one a name of its
 * own would dress a spawn up as a personality — a stranger called Arthur and a
 * deer called Mabel, with nothing to tell you which of them can hear you.
 *
 * The body is what asks the question, not the id: `npc:` prefixes are an
 * implementation detail of how residents are keyed, and reading identity off
 * the shape of an id is how that detail becomes load-bearing.
 */
export function bodyNameFor(
  body: { tileId: string; name?: string | null },
  tilesById: Record<string, TileDef>,
): string {
  if (body.tileId === PLAYER_TILE_ID) return body.name ?? UNNAMED_BODY;
  // A tile the catalog has never heard of is a bug elsewhere — a map holding a
  // deleted tile id — and the words still have to be attributed to something.
  return tilesById[body.tileId]?.name ?? body.name ?? UNNAMED_BODY;
}

/**
 * {@link bodyNameFor}'s answer for a caller holding a list of bodies rather
 * than a session to ask.
 *
 * Both halves of the client ask this about somebody they are not drawing — the
 * look label and the interaction row both name whoever conjured the tile under
 * the pointer — and the list they have is the snapshot's. Null for a body that
 * is not in it: a caster who has left the world is nobody, which is the answer
 * `GameSession.bodyName` already gives the skull it writes.
 *
 * A scan rather than an index, because the list is a handful of actors and this
 * is asked about one tile at a time.
 */
export function bodyNameIn(
  bodies: readonly { id: string; tileId: string; name?: string | null }[],
  tilesById: Record<string, TileDef>,
): (actorId: string) => string | null {
  return (actorId) => {
    const body = bodies.find((one) => one.id === actorId);
    if (!body) return null;
    return bodyNameFor(body, tilesById);
  };
}

/**
 * What to call somebody who is *in the fighting*, which is their name and a mark.
 *
 * **Always on, unlike the ⭐.** A rating answers a question you only ask when you
 * are sizing somebody up, and this answers one you have to be able to ask at a
 * glance about everybody in the room: whether that person can be fought, and
 * whether they can fight you. A mark you had to hold a key to see would be a
 * mark nobody reads before walking into a crowd.
 *
 * Only for a body whose switch is on — see `./pvp`. Off is the quiet state and
 * the common one, and a tag for it would mark every stranger in a peaceful world
 * with a word about violence.
 */
export function fightingName(name: string, pvp: boolean): string {
  return pvp ? `${name} ${PVP_MARK}` : name;
}

/**
 * What to call a body you are *sizing up*, which is the name plus its rating.
 *
 * **Only while looking.** A rating over every head all the time turns a field of
 * creatures into a spreadsheet, and it is not what a name tag is for: a name
 * says who that is, and a rating answers a question you only ask when you are
 * deciding whether to pick a fight. Look mode is when you are asking it — which
 * is also why it is not gated on the *target* instead. Targeting is how you
 * start a fight, and a number that appears once you have committed is a number
 * that arrived too late to be any use.
 *
 * Its own function rather than a line in the renderer because it is a decision
 * about *what a label says* — and because that is the kind of decision that is
 * quietly wrong for months if the only way to check it is to walk to a rat.
 *
 * Falls back to the bare name for anything with no rating to give: a crate is
 * lookable and has no opinion about fighting.
 */
export function sizedUpName(name: string, rating: number | null, looking: boolean): string {
  if (!looking || rating === null) return name;
  return `${name} ${RATING_GLYPH}${rating}`;
}

import type { StatusDef } from "../lib/status";
import type { PlacedTile } from "../lib/types";
import { possessive } from "./blame";

/**
 * What a tile somebody conjured is to them: theirs.
 *
 * `PlacedTile.castBy` has so far been an accounting field — a flame pays the
 * arcanist who lit it, and a skull says whose fire it was. Ownership is the
 * other half of the same fact, and it has two consequences that have to agree
 * with each other, which is why both are written here rather than at the four
 * places that read them:
 *
 * - **A conjured tile is named after whoever cast it.** "Green Fox's Arcane
 *   Flame" over the same `arcane-flame` def a hearth leaves behind as plain
 *   "Arcane Flame".
 * - **It does not turn on them.** The caster walks through their own flame and
 *   nothing happens; everybody else burns.
 *
 * Neither is stored. `castBy` is an actor id and a name is derived from it at
 * the moment it is shown — see `./displayName`, which is where the reasoning
 * about that lives — so nothing about ownership goes on the wire, and a world
 * whose caster has left reads exactly as a world where a hearth lit the fire.
 */

/**
 * The name to show for a placement, with the caster's name in front of it where
 * anybody cast it.
 *
 * **Applied over an already-engraved name rather than instead of one.** They
 * answer different questions — `../lib/engraving` fills a hole an author left in
 * a name, this puts a name in front of a whole one — and a conjured skull would
 * want both.
 *
 * `nameOf` answers with null for a caster who is not on the board, and that is
 * the plain tile name again: a name that no longer belongs to anybody is not an
 * error here for exactly the reason it is not one in `PlacedTile.castBy`.
 */
export function conjuredName(
  name: string,
  placed: Pick<PlacedTile, "castBy">,
  nameOf: (actorId: string) => string | null,
): string {
  if (!placed.castBy) return name;
  return possessive(nameOf(placed.castBy), name);
}

/**
 * Whether this placement's status is one the body standing in it is spared
 * because the body conjured it.
 *
 * **Tone and not the whole block**, because a conjure is not only a weapon: an
 * author can lay down a circle that heals whoever stands in it, and a caster
 * skipping their own blessing would be this rule wearing the wrong sign. See
 * `../lib/status`'s {@link StatusDef.tone}, which exists because only the
 * author knows which way a status leans.
 *
 * **The rule the granting and the routing both read**, which is the reason it
 * is a function rather than a line inside either: `GameSession` grants what a
 * cell holds and `./pathfinding` refuses to walk through what would hurt, and a
 * pathfinder that thought a caster's own flame was a hazard would route them
 * round a tile that cannot touch them — or refuse a doorway they could walk
 * straight through.
 *
 * A body with nothing to compare against — a caller that has no walker in hand
 * — is spared nothing, which is what every one of them did before this existed.
 */
export function sparesCaster(
  placed: Pick<PlacedTile, "castBy">,
  status: StatusDef | undefined,
  who: string | undefined,
): boolean {
  if (who === undefined || placed.castBy !== who) return false;
  return status?.tone === "bad";
}

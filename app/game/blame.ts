/**
 * What hurt a body, in the words its skull is engraved with.
 *
 * ## Names, not ids
 *
 * Every other attribution in this game is an actor id resolved at the moment it
 * is spent — `StatusInstance.causedBy` is read by whatever pays experience, and
 * a caster who has left the world is simply nobody. A death record cannot work
 * that way. The snake that poisoned you is very often dead by the time the
 * poison finishes the job, and "Poisoned by" with nothing after it is a worse
 * answer than the one anybody standing there watched happen. So a blame is
 * *written* when the harm starts and carried unchanged from there.
 *
 * ## Two halves, and the second one is optional
 *
 * `source` is what did it — a weapon's name, a status's name — and every harm
 * has one. `by` is who is answerable, and plenty of harms have nobody: a hearth
 * somebody built a year ago, a berry that turned. So the line a skull carries is
 * "Bite by Snake" where there is somebody and "Burning" where there is not,
 * rather than a sentence with a hole in it.
 */

export type Blame = {
  /** What did it: a weapon's name, a status's name, a thing you drank. */
  source: string;
  /** Who or what is answerable, already named. Absent when nothing is. */
  by?: string;
};

/** The whole record as one line. */
export function blameText(blame: Blame): string {
  return blame.by ? `${blame.source} by ${blame.by}` : blame.source;
}

/**
 * One name for a thing belonging to somebody, or the thing alone.
 *
 * What makes a conjured flame read as the caster's doing — "Burning by Green
 * Fox's Arcane Flame" — while the hearth in the tavern stays "Burning by
 * Hearth". The same tile is both, which is exactly why the possessive is
 * decided here and not written into a tile's name.
 */
export function possessive(owner: string | null, thing: string): string {
  return owner ? `${owner}'s ${thing}` : thing;
}

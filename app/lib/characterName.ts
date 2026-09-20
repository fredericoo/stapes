/**
 * What a character may be called, and what it is stored as.
 *
 * Names used to be derived from the actor id — a colour and an animal out of a
 * word list, so that a room of uuids read as a room of people. Nobody chose
 * one, so nobody could be asked to type one, and two players could be handed
 * the same. Now a name is typed once, at creation, and never again: it is the
 * only thing about a character that cannot be changed, which is what makes it
 * worth recognising across a square.
 *
 * **Letters only, and at most twenty of them.** The name is drawn over a head
 * in the same face as speech, at a size fixed by the tile grid — see
 * `../render/textLabels` — so a name that is not a word is a tag nobody can
 * read at a glance, and a long one is a tag that covers the body beside it.
 * Digits and punctuation are refused rather than stripped, because a player who
 * typed `Ka1n` and was given `Kan` was not told anything.
 *
 * Shared by both halves, deliberately. The server is what enforces this — see
 * `server/characters.ts`, which normalises again before it writes — and the
 * client runs the same function so the refusal arrives while somebody is still
 * typing rather than as a failed request.
 */

/** Twenty letters. @see MIN_CHARACTER_NAME_LENGTH for the other end. */
export const MAX_CHARACTER_NAME_LENGTH = 20;

/**
 * Two, because a single letter is not a name anybody can be called across a
 * square, and because `A` and `B` would be the first two taken in a world where
 * names are unique forever.
 */
export const MIN_CHARACTER_NAME_LENGTH = 2;

/** How many characters one account may hold. @see server/characters.ts */
export const MAX_CHARACTERS_PER_ACCOUNT = 3;

const LETTERS_ONLY = /^[A-Za-z]+$/;

/**
 * The stored form of a typed name: one capital, then lower case.
 *
 * Applied rather than demanded, so `ARTHUR` and `arthur` are both a request to
 * be called `Arthur` rather than two refusals. It is also what makes the unique
 * index meaningful — two people cannot be `Arthur` and `arthur` and then spend
 * a week being mistaken for each other.
 */
export function normaliseCharacterName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Why this name cannot be used, or null if it can.
 *
 * A sentence rather than a code: both callers show it to the person who typed
 * it, and there is nothing else to do with the answer.
 *
 * Uniqueness is not checked here and cannot be — it is a question about the
 * database, and only the insert can answer it without a race. @see
 * `server/characters.ts`
 */
export function characterNameProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "A character needs a name.";
  if (!LETTERS_ONLY.test(trimmed)) return "Letters only — A to Z, nothing else.";
  if (trimmed.length < MIN_CHARACTER_NAME_LENGTH) {
    return `At least ${MIN_CHARACTER_NAME_LENGTH} letters.`;
  }
  if (trimmed.length > MAX_CHARACTER_NAME_LENGTH) {
    return `At most ${MAX_CHARACTER_NAME_LENGTH} letters.`;
  }
  return null;
}

/**
 * What to call somebody.
 *
 * Identity online is a random uuid in a cookie — 36 characters, which at the
 * pixel font's 6px per character is wider than the entire 120px view. So the
 * name drawn over an actor is a short handle derived from that id rather than
 * the id itself.
 *
 * Derived, not stored: the same actor gets the same handle on every client and
 * across reconnects, without a name ever going on the wire. When real names
 * arrive this is the one function they replace.
 */

/** Six characters: distinct enough to tell a room apart, short enough to read. */
const HANDLE_LENGTH = 6;

/** Uppercase — the font's capitals are a full 5px tall, its lowercase is 4. */
export function displayNameFor(actorId: string): string {
  const usable = actorId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (usable.length >= HANDLE_LENGTH) return usable.slice(0, HANDLE_LENGTH);
  // A short or punctuation-only id still needs something to draw, and padding
  // keeps every label the same width rather than jumping about as people join.
  return usable.padEnd(HANDLE_LENGTH, "0");
}

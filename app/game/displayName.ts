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

/**
 * Uppercase because a handle should read as a tag, not because it has to be.
 *
 * This used to be free: Silkscreen drew both cases in the same 5px band, so
 * case cost no height. NF Pixels has a real lowercase — 5 pixels of x-height
 * under a 7-pixel cap — so an uppercase handle is now genuinely two pixels
 * taller than a lowercase one would be. Still worth it: a name tag wants to
 * look unlike the sentence hanging above it, and case is what separates them
 * now that both are drawn in the same face.
 */
export function displayNameFor(actorId: string): string {
  const usable = actorId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (usable.length >= HANDLE_LENGTH) return usable.slice(0, HANDLE_LENGTH);
  // A short or punctuation-only id still needs something to draw, and padding
  // keeps every label the same width rather than jumping about as people join.
  return usable.padEnd(HANDLE_LENGTH, "0");
}

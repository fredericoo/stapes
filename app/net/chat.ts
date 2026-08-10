/**
 * What counts as a thing somebody said.
 *
 * One home for the rule because both ends need it and they must not disagree:
 * the browser caps the field so typing feels bounded, and the server applies the
 * same cap again because the field is a courtesy and the socket is the boundary.
 */

/** Characters that survive to the wire. Anything longer is the client's problem. */
export const MAX_CHAT_LENGTH = 128;

/**
 * How long a bubble stays on the board.
 *
 * Client-side: the server announces a message once and never mentions it again,
 * so nothing has to tick for five seconds on the world's behalf.
 */
export const CHAT_LIFETIME_MS = 5_000;

/**
 * How many bubbles one cell will hold at once.
 *
 * They stack upward, newest nearest the ground. A fourth does not wait its turn:
 * the oldest goes the instant it lands, because a column that keeps growing
 * would wall off the view and the thing a reader wants is the newest line.
 */
export const MAX_CHATS_PER_CELL = 3;

/**
 * Floor on the gap between two messages from one actor.
 *
 * Every accepted message costs a serialization, a fan-out and a row on disk, and
 * a socket can send as fast as it likes. Without this one client can drive all
 * three per frame.
 */
export const CHAT_MIN_INTERVAL_MS = 750;

/**
 * The raw cap, applied before anything walks the string.
 *
 * Deliberately looser than {@link MAX_CHAT_LENGTH}: a message full of characters
 * that get stripped should still be able to say something, but a client must not
 * be able to hand the sanitizer a megabyte.
 */
export const MAX_CHAT_RAW_LENGTH = 512;

/**
 * Printable ASCII — the range the font is subset to.
 *
 * The tilde is the one character in that range NF Pixels does not draw, so the
 * range stops one short of it rather than at 0x7e. The rule this keeps is worth
 * the oddity: everything that survives this function can be drawn, so a message
 * never arrives with a hole in it.
 */
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7d;

/**
 * A message as it will be drawn, or null when there is nothing left to draw.
 *
 * Characters the font cannot draw are dropped rather than the message being
 * refused. The pixel font is subset to printable ASCII —
 * `public/fonts/nf-pixels-ascii.woff2` — so anything else would occupy width and
 * draw nothing, which reads as a hole in the text rather than as a character the
 * reader is missing. Dropping also takes newlines and control characters with
 * it, so a message is always one paragraph.
 *
 * The cap is applied last, so it counts characters that will actually appear:
 * pasting emoji does not eat the budget.
 */
export function sanitizeChatText(raw: string): string | null {
  let kept = "";
  for (const char of raw.slice(0, MAX_CHAT_RAW_LENGTH)) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) continue;
    kept += char;
  }

  const collapsed = kept.replace(/ {2,}/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_CHAT_LENGTH);
}

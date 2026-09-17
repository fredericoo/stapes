/**
 * Chat limits shared by the browser and the server so the two cannot disagree:
 * the browser caps the input field, and the server applies the same cap again
 * because the socket is the boundary.
 */

/** Characters that survive to the wire. Anything longer is the client's problem. */
export const MAX_CHAT_LENGTH = 128;

/**
 * How long a bubble stays on the board. Enforced client-side: the server
 * announces a message once and never mentions it again.
 */
export const CHAT_LIFETIME_MS = 5_000;

/**
 * How many bubbles one cell holds at once. They stack upward, newest nearest
 * the ground; when a fourth lands the oldest is dropped at once, so a column
 * cannot keep growing and wall off the view.
 */
export const MAX_CHATS_PER_CELL = 3;

/**
 * Floor on the gap between two messages from one actor. Every accepted message
 * costs a serialization, a fan-out and a row on disk; without this one client
 * can drive all three per frame.
 */
export const CHAT_MIN_INTERVAL_MS = 750;

/**
 * The raw cap, applied before anything walks the string. Looser than
 * {@link MAX_CHAT_LENGTH} so a message full of stripped characters can still
 * say something, but a client cannot hand the sanitizer a megabyte.
 */
export const MAX_CHAT_RAW_LENGTH = 512;

/**
 * Printable ASCII, the range the font is subset to. It stops at 0x7d rather
 * than 0x7e because NF Pixels has no glyph for the tilde: everything that
 * survives `sanitizeChatText` can be drawn.
 */
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7d;

/**
 * A message as it will be drawn, or null when there is nothing left to draw.
 *
 * Characters the font cannot draw are dropped rather than the message being
 * refused: the pixel font is subset to printable ASCII
 * (`public/fonts/nf-pixels-ascii.woff2`), so anything else would occupy width
 * and draw nothing. Dropping also removes newlines and control characters, so
 * a message is always one paragraph.
 *
 * The cap is applied last, so it counts characters that will actually appear.
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

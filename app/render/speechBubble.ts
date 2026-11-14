import { CHAT_LIFETIME_MS } from "../net/chat";

const GLYPH_MS = 35;

/**
 * However long the line, it is all on screen by this share of its lifetime, so
 * a full-length line is still read rather than watched being typed.
 */
const TYPED_BY_SHARE_OF_LIFETIME = 0.4;

const TYPING_BUDGET_MS = CHAT_LIFETIME_MS * TYPED_BY_SHARE_OF_LIFETIME;

export function glyphIntervalMs(length: number): number {
  if (length === 0) return GLYPH_MS;
  return Math.min(GLYPH_MS, TYPING_BUDGET_MS / length);
}

/** How many characters of a line `elapsedMs` old are typed out. The first shows at once. */
export function typedLength(length: number, elapsedMs: number): number {
  const typed = Math.floor(Math.max(0, elapsedMs) / glyphIntervalMs(length)) + 1;
  return Math.min(length, typed);
}

/** How long a bubble takes to shrink away, at the very end of its newest line's lifetime. */
export const BUBBLE_CLOSE_MS = 150;

/**
 * How far into closing a bubble is, from the age of the newest line in it, or
 * undefined while it is still fully up. A new line said into a closing bubble
 * makes it undefined again, which opens the bubble back up.
 */
export function bubbleClosingMs(newestElapsedMs: number): number | undefined {
  const closingMs = newestElapsedMs - (CHAT_LIFETIME_MS - BUBBLE_CLOSE_MS);
  return closingMs < 0 ? undefined : closingMs;
}

export type TailLean = "left" | "none" | "right";

/** Pixel art for the tail under a bubble: `f` is the bubble's fill, `.` is empty. */
export const TAIL_PIXELS: Record<TailLean, { rows: readonly string[]; tipColumn: number }> = {
  none: { rows: ["fffffff", ".fffff.", "..fff..", "...f..."], tipColumn: 3 },
  right: { rows: ["fffff", ".ffff", "...ff", "....f"], tipColumn: 4 },
  left: { rows: ["fffff", "ffff.", "ff...", "f...."], tipColumn: 0 },
};

/** Bricks kept between the tail and either end of the bubble, so it never sits on a rounded corner. */
const TAIL_INSET_BRICKS = 3;

/** Within this share of the bubble's half-width from its middle, the tail points straight down. */
const STRAIGHT_SHARE = 1 / 3;

/**
 * Where the tail goes under a bubble `widthBricks` wide whose left edge is at
 * brick 0, to point at `towardBrick`: its left edge in bricks and which way it
 * leans. A speaker past either end of the bubble — pushed there by the edge of
 * the screen — gets the tail at that end, leaning out toward them.
 */
export function tailPlacement(
  widthBricks: number,
  towardBrick: number,
): { leftBrick: number; lean: TailLean } {
  const middle = widthBricks / 2;
  const offset = towardBrick - middle;
  const lean: TailLean =
    Math.abs(offset) <= middle * STRAIGHT_SHARE ? "none" : offset < 0 ? "left" : "right";
  const { rows, tipColumn } = TAIL_PIXELS[lean];
  const tailWidth = rows[0]!.length;
  const lowest = TAIL_INSET_BRICKS;
  const highest = Math.max(lowest, widthBricks - TAIL_INSET_BRICKS - tailWidth);
  const leftBrick = Math.round(towardBrick) - tipColumn;
  return { leftBrick: Math.min(highest, Math.max(lowest, leftBrick)), lean };
}

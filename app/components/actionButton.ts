/**
 * How big a control in the row under the world is, in the two sizes that row
 * comes in. Declared here rather than in each button because four of them
 * share that row — chat, the two panel toggles, the app menu — and heights
 * declared in four places drift.
 */
export type ActionButtonSize = "touch" | "compact";

/**
 * The touch size is a ceiling, not a size. Squares of 3.5rem plus their gaps
 * are wider than a small phone, so a fixed size puts the last control off the
 * edge behind a horizontal scrollbar. Instead every button takes an equal
 * share of the row and stops growing at 3.5rem.
 *
 * `flex-1` off a zero basis rather than a percentage width, so the gaps and
 * the rule between the halves are subtracted before the share is worked out:
 * chrome that is not a button cannot make the row overflow. The square comes
 * from the aspect ratio because the width is the browser's answer.
 */
export const ACTION_BUTTON_SIZE_CLASS: Record<ActionButtonSize, string> = {
  touch: "aspect-square h-auto w-full max-w-14 flex-1",
  compact: "h-9 w-9 shrink-0",
};

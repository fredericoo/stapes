/**
 * How big a control in the row under the world is, in the two sizes that row
 * comes in.
 *
 * A thumb needs a target it will not miss; a desktop toolbar beside a list of
 * rows wants to be chrome rather than the main event. Written here rather than
 * in any one of the buttons because four of them ride in that row — chat, the
 * two panel toggles, the app menu — and a row whose heights are declared in four
 * places is a row that ends up ragged.
 */
export type ActionButtonSize = "touch" | "compact";

/**
 * The touch size is a *ceiling* rather than a size. Squares of 3.5rem plus their
 * gaps want more than a small phone is wide, so a fixed size put the last
 * control off the edge and gave the page a horizontal scrollbar — which is the
 * worst of the options, because the control that ends up off screen is the one
 * nothing on screen says is there. Instead every button takes an equal share of
 * the row and stops growing at the size it always was: identical on a screen
 * with room, and evenly a little smaller on one without, with the row still
 * ending where the screen does.
 *
 * `flex-1` off a zero basis rather than a percentage width, so the gaps and the
 * rule between the halves are subtracted before the share is worked out — the
 * row cannot be made to overflow by adding chrome that is not a button. The
 * square comes from the ratio and not from a matching height, since the width
 * is now the browser's answer rather than ours.
 */
export const ACTION_BUTTON_SIZE_CLASS: Record<ActionButtonSize, string> = {
  touch: "aspect-square h-auto w-full max-w-14 flex-1",
  compact: "h-9 w-9 shrink-0",
};

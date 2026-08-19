/**
 * Where every piece of in-world text ends up, decided once all of them are known.
 *
 * A label wants three things at the same time, and cannot always have all three:
 * it wants to hang over the exact spot in the world it describes, it wants to be
 * inside the view, and it wants to be readable. The third is the one that has to
 * win — two sentences printed through each other are not two messages, they are
 * a smear — so this pass keeps the first two as close to true as it can and
 * gives up whichever of them it must.
 *
 * ## Why a pass rather than per-label rules
 *
 * The stylesheet used to hold a single offset that lifted speech clear of a name
 * tag on the same head. That works exactly as far as the case it was written for
 * and no further: it knows nothing about a second speaker standing beside the
 * first, about a look at an object someone is talking over, or about a label
 * near the edge of the square. None of those can be answered by a label on its
 * own, because the answer depends on where the *other* labels landed. So they
 * are solved together, after measuring, in screen pixels.
 *
 * ## The order is the priority
 *
 * Labels are placed one at a time and each one avoids everything already down,
 * so whoever is placed first gets what it asked for and later arrivals work
 * around it.
 *
 * - **A look goes first.** It is the one label the player asked for by pointing
 *   at something, this frame, and it answers a question they are asking right
 *   now. It never moves for anyone.
 * - **Speech comes next**, oldest first, so a new remark stacks above the ones
 *   already on screen instead of shuffling them.
 * - **Names are not in the contest at all.** A name is a tag on a body rather
 *   than something to read: it is placed where it belongs, it is allowed to be
 *   covered, and — crucially — it never pushes anything else out of the way. It
 *   is drawn behind the rest (see `.world-label--name` in `app/app.css`), so a
 *   sentence over a name reads as a sentence over a name, not as a collision.
 *
 * A health bar rides inside a name label but is placed on the anchor in its own
 * right — see {@link barLeftFor}, which is the one part of a label allowed to
 * disagree with where the rest of it ended up.
 */

export type LabelKind = "name" | "speech" | "noise" | "look";

/**
 * Gap left between two labels that would otherwise touch, in CSS pixels.
 *
 * Two of the font's own bricks at the size the world draws it. Zero would be
 * clash-free by the letter of it and still read as one paragraph; this is the
 * smallest gap that says "two messages" at a glance.
 */
const LABEL_GAP_PX = 4;

/** Breathing room kept between a label and the edge of the square. */
const VIEW_PADDING_PX = 2;

/**
 * A label asking to be placed: where it wants to be, and how big it turned out.
 *
 * Sizes are measured, never guessed — the text is a webfont in a div and may
 * have wrapped. The caller measures; this decides.
 */
export type LabelRequest = {
  /** Stable per anchor, and how the caller finds its answer again. */
  id: string;
  kind: LabelKind;
  /**
   * The point in the view the label belongs to, in CSS pixels from the top
   * left — the head, or the cell, that the text is about.
   */
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  /**
   * Gap between the anchor and the label's bottom edge. What keeps speech off
   * the name tag on the same head, which is a clash this pass tolerates and so
   * would otherwise never fix.
   */
  lift: number;
  /**
   * How wide the health bar in this label is, if it has one. Absent for labels
   * that do not. @see barLeftFor
   */
  barWidth?: number;
};

/**
 * Top left corner of a placed label, in CSS pixels from the view's top left,
 * and — for a label carrying a health bar — the left edge that bar was given.
 */
export type LabelPlacement = {
  left: number;
  top: number;
  /** Absent unless the request asked for one. @see barLeftFor */
  barLeft?: number;
};

/**
 * Answers, by label id.
 *
 * A label that is missing from the map is one there was no room for: the caller
 * hides it. Dropping the lowest-priority label is the last resort, and it is
 * the price of the promise that nothing ever overlaps — the alternative is to
 * print it on top of something and call that a placement.
 */
export type LabelLayout = Map<string, LabelPlacement>;

type Rect = { left: number; right: number; top: number; bottom: number };

/** Placed in this order, and each avoids everyone before it. @see module doc */
const PLACEMENT_ORDER: Record<LabelKind, number> = {
  look: 0,
  speech: 1,
  // After speech, because words somebody chose to type are worth more of the
  // screen than a noise the world made on its own — a crunch giving way to a
  // sentence is the right way round when the two land on one cell.
  noise: 2,
  name: 3,
};

export function layoutLabels(
  requests: LabelRequest[],
  view: { width: number; height: number },
): LabelLayout {
  const layout: LabelLayout = new Map();
  const taken: Rect[] = [];

  for (const request of byPriority(requests)) {
    const wanted = wantedRect(request, view);
    // Anchored outside the square: the thing it describes is not on screen, and
    // a label pinned to the edge would be pointing at nothing.
    if (!wanted) continue;

    const barLeft = barLeftFor(request, view);

    if (request.kind === "name") {
      layout.set(request.id, { left: wanted.left, top: wanted.top, barLeft });
      continue;
    }

    const top = clearTop(wanted, taken, view);
    if (top === null) continue;

    taken.push({
      ...wanted,
      top,
      bottom: top + request.height,
    });
    layout.set(request.id, { left: wanted.left, top, barLeft });
  }

  return layout;
}

/**
 * Sorted, without disturbing the caller's array.
 *
 * The sort is stable, so labels of one kind keep the order they were handed
 * over in — which is what makes speech oldest-first rather than shuffled.
 */
function byPriority(requests: LabelRequest[]): LabelRequest[] {
  return [...requests].sort(
    (a, b) => PLACEMENT_ORDER[a.kind] - PLACEMENT_ORDER[b.kind],
  );
}

/**
 * Where a label would go if it were the only one: centred over its anchor,
 * hanging above it, pulled inside the view.
 *
 * The pull inward is the "try to fit the screen" half of the promise and it is
 * deliberately allowed to break the "sit on the target" half — a sentence half
 * off the right edge is unreadable, while the same sentence slid left is merely
 * slightly off its mark. Rounded, because the font's bricks have to land on
 * whole pixels or the browser antialiases a pixel font.
 */
function wantedRect(
  request: LabelRequest,
  view: { width: number; height: number },
): Rect | null {
  const { anchorX, anchorY, width, height } = request;
  if (anchorX < 0 || anchorX > view.width) return null;
  if (anchorY < 0 || anchorY > view.height) return null;

  const left = clamp(
    Math.round(anchorX - width / 2),
    VIEW_PADDING_PX,
    view.width - width - VIEW_PADDING_PX,
  );
  const top = clamp(
    Math.round(anchorY - request.lift - height),
    VIEW_PADDING_PX,
    view.height - height - VIEW_PADDING_PX,
  );
  return { left, right: left + width, top, bottom: top + height };
}

/**
 * Where the health bar goes, decided on the anchor rather than on the box it
 * happens to sit in.
 *
 * The bar is a child of the name label, so left alone it would ride along with
 * whatever the text above it did — and the text is centred on a box as wide as
 * the name, then dragged inside the view. A creature at the left edge of the
 * square therefore had its bar sitting under the *middle* of a long name, a
 * whole name's width away from the thing it was reporting on: at a glance the
 * bar belonged to whatever was standing over there instead.
 *
 * So the bar is placed on the anchor directly, and pulled inside the view by its
 * own width. Every reading is one cell wide whoever it belongs to, which is why
 * this can be true where it cannot be for the name: a bar has room to stay on
 * its target long after a name has had to slide off it, and two bars on
 * neighbouring cells are two readings rather than one smear.
 */
function barLeftFor(
  request: LabelRequest,
  view: { width: number; height: number },
): number | undefined {
  const { barWidth } = request;
  if (barWidth === undefined) return undefined;
  return clamp(
    Math.round(request.anchorX - barWidth / 2),
    VIEW_PADDING_PX,
    view.width - barWidth - VIEW_PADDING_PX,
  );
}

/**
 * The nearest free height for a label, or null if there is none.
 *
 * Both directions are tried and the *shorter* move wins, because the label is
 * still trying to sit on the thing it describes and every pixel it travels is a
 * pixel of that promise spent. Preferring up outright is what a stack of
 * messages looks like it wants — but it means a label with one bubble above it
 * and clear air below climbs to the ceiling to avoid a four-pixel step down,
 * which is a worse lie about where its subject is than sitting slightly low.
 *
 * Ties go up, which is what keeps a plain column of speech growing upward:
 * stacking above and below are the same distance, and upward is where labels
 * belong.
 *
 * Only the top moves. Sliding sideways would keep more labels on screen, but it
 * also walks the text off the thing it is about — and a column of messages that
 * all sit over the speaker reads far better than a scatter that each sit
 * slightly beside their own.
 */
function clearTop(
  wanted: Rect,
  taken: Rect[],
  view: { width: number; height: number },
): number | null {
  const up = slide(wanted, taken, view, -1);
  const down = slide(wanted, taken, view, 1);
  if (up === null) return down;
  if (down === null) return up;
  return wanted.top - up <= down - wanted.top ? up : down;
}

/**
 * Step past every label in the way, one at a time, until the air is clear.
 *
 * Each step clears exactly one obstacle, so this cannot run longer than there
 * are obstacles — no iteration cap needed to make it terminate, and none that
 * could quietly cut a valid answer short.
 */
function slide(
  wanted: Rect,
  taken: Rect[],
  view: { width: number; height: number },
  direction: 1 | -1,
): number | null {
  const height = wanted.bottom - wanted.top;
  let top = wanted.top;

  for (let step = 0; step <= taken.length; step++) {
    if (!fitsVertically(top, height, view)) return null;
    const hit = taken.find((rect) => overlaps({ ...wanted, top, bottom: top + height }, rect));
    if (!hit) return top;
    top =
      direction < 0 ? hit.top - LABEL_GAP_PX - height : hit.bottom + LABEL_GAP_PX;
  }

  return null;
}

function fitsVertically(
  top: number,
  height: number,
  view: { width: number; height: number },
): boolean {
  return top >= VIEW_PADDING_PX && top + height <= view.height - VIEW_PADDING_PX;
}

/** Touching edges are not an overlap; the gap above is what keeps them apart. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/**
 * Low wins where the two bounds cross, which happens when the label is wider or
 * taller than the view itself. Nothing fits then, so it is pinned to the top
 * left of the padding and clipped by the layer — still the most of it anyone
 * can read.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

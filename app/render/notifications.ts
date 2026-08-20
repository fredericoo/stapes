/**
 * What the game has just told you, at the foot of the view.
 *
 * A third kind of text over the canvas, beside the labels hanging in the world
 * and the numbers rising off bodies — and the one that is not in the world at
 * all. A name belongs to a creature and a number belongs to a blow; a notice
 * belongs to *the player*, so it is pinned to the bottom edge of the square and
 * never to a cell. Nothing about it moves with the camera.
 *
 * ## Why it is not a component
 *
 * There is nothing to do to a notice. It cannot be dismissed, focused, hovered
 * or replied to — it appears, it is read, it goes — so the machinery a toast
 * usually comes with would all be dead weight: no role, no live region, no
 * timer to clear on unmount, no state to re-render the page with. It is drawn
 * where the rest of the game's text is drawn, by the loop that draws the game,
 * and the page has no idea it exists.
 *
 * DOM elements rather than quads in the scene, for the reason every other piece
 * of text over this canvas is — `./textLabels` has the argument in full, and it
 * comes down to the drawing buffer being stretched by a fractional amount, so
 * there is nowhere in that pipeline to put crisp 1-bit type.
 *
 * ## Two, and the newest at the bottom
 *
 * The stack is capped hard rather than queued. Notices arrive because something
 * just happened, and a line held back until a slot frees up is a line describing
 * a moment that has passed — worse than not saying it, because the player reads
 * it against whatever they are doing *now*. So a third arriving evicts the
 * oldest on the spot, and every notice lives exactly {@link NOTICE_LIFETIME_MS}
 * from the moment it appeared.
 *
 * Newest nearest the bottom edge, which is the direction the column grows from:
 * a new line pushes the previous one up by its own height, so the thing that
 * just happened is always in the same place — the eye does not have to find it.
 */

/**
 * How long a notice stays up.
 *
 * Between a noise's two seconds and a chat bubble's five, because it is between
 * them in length: a sentence takes longer to read than "crunch", and unlike
 * speech nobody is waiting to reply to it. Four seconds is comfortably enough to
 * read one line twice while a fight carries on around it, and short enough that
 * two level-ups in one kill have both cleared before the next fight starts.
 */
export const NOTICE_LIFETIME_MS = 4_000;

/**
 * How many fit on screen.
 *
 * Two. One is a line at the bottom of the view; three is a wall of text over the
 * game, and by the third the player is reading rather than playing. Two is also
 * exactly what a single kill can produce — a weapon mastery and Toughness — so
 * the common case never evicts anything.
 */
export const MAX_NOTICES = 2;

/** One line waiting to be read, with the moment it went up. */
export type Notice = {
  /** Stable per notice; the element cache is keyed on it. */
  id: string;
  text: string;
  shownAtMs: number;
};

/**
 * The lines currently up, oldest first.
 *
 * Deliberately not in `GameSession` and not on the wire. A notice is a thing
 * said to whoever is looking at this screen, so it has no business in a snapshot
 * that describes the board — and the level-up case has nothing to send anyway,
 * since it is read out of totals the client already has. @see ../game/notices
 *
 * The list stays sorted by expiry, which is what lets pruning be a walk from the
 * front: every notice has the same lifetime, and the one case that changes a
 * stamp — a repeat refreshing the newest — can only ever push the *last* entry
 * further out.
 */
export class NoticeQueue {
  private notices: Notice[] = [];
  private nextId = 0;

  /**
   * Put a line up, or refresh the one already saying it.
   *
   * The refresh is what keeps a refusal readable. "You cannot fit there" comes
   * of pressing a key, and a key gets mashed: without this, four presses would
   * fill both slots with the same sentence and evict whatever else was up. With
   * it, the line simply stays for another {@link NOTICE_LIFETIME_MS} — which is
   * also the honest reading, since the fourth press failed for the reason the
   * first one did.
   *
   * Only against the newest, not against everything live: a repeat of the
   * *older* line is a thing that happened again after something else, and it
   * belongs at the bottom where the newest goes.
   */
  push(text: string, nowMs: number) {
    this.prune(nowMs);

    const newest = this.notices.at(-1);
    if (newest && newest.text === text) {
      newest.shownAtMs = nowMs;
      return;
    }

    this.notices.push({ id: `notice-${this.nextId++}`, text, shownAtMs: nowMs });
    if (this.notices.length > MAX_NOTICES) {
      this.notices.splice(0, this.notices.length - MAX_NOTICES);
    }
  }

  /**
   * The lines still up, oldest first.
   *
   * The live array rather than a copy, on the same terms `GameSnapshot.damage`
   * hands out its own: this is read once per frame by the layer below and by
   * nothing else, and a copy per frame would allocate for the ninety-nine frames
   * in a hundred where nothing has changed.
   */
  live(nowMs: number): Notice[] {
    this.prune(nowMs);
    return this.notices;
  }

  private prune(nowMs: number) {
    let expired = 0;
    while (
      expired < this.notices.length &&
      nowMs - this.notices[expired].shownAtMs >= NOTICE_LIFETIME_MS
    ) {
      expired++;
    }
    if (expired > 0) this.notices.splice(0, expired);
  }
}

/**
 * The notice elements, kept between frames.
 *
 * Held rather than rebuilt for the reason the label and damage layers hold
 * theirs: writing text is layout. A notice's text is written once when it
 * appears and never again — and unlike a damage number, nothing about it moves
 * afterwards either, so a frame where the set is unchanged touches the DOM not
 * at all.
 *
 * The stack element is created here rather than asked for from the page, so a
 * caller that already hands over somewhere to draw world text needs no second
 * container and no second ref threaded through the viewport.
 */
export class NotificationLayer {
  private readonly stack: HTMLDivElement;
  private readonly entries = new Map<string, HTMLDivElement>();

  constructor(container: HTMLElement) {
    this.stack = document.createElement("div");
    this.stack.className = "notice-stack";
    container.appendChild(this.stack);
  }

  /**
   * Draw this frame's notices.
   *
   * Order comes free: the queue is oldest-first, elements are appended the frame
   * they first appear, and removing the oldest leaves the rest where they are.
   * So the column's document order is always the queue's order, and the column
   * flows downward — newest nearest the bottom edge.
   */
  set(notices: Notice[]) {
    const live = new Set<string>();

    for (const notice of notices) {
      live.add(notice.id);
      if (this.entries.has(notice.id)) continue;
      const element = document.createElement("div");
      element.className = "notice";
      element.textContent = notice.text;
      this.stack.appendChild(element);
      this.entries.set(notice.id, element);
    }

    for (const [id, element] of this.entries) {
      if (live.has(id)) continue;
      element.remove();
      this.entries.delete(id);
    }
  }

  dispose() {
    this.stack.remove();
    this.entries.clear();
  }
}

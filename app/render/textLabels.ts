/**
 * Text that hangs in the world but is drawn in real screen pixels.
 *
 * Names over heads and the things people say. Both are anchored to a point in
 * the world and both move with it every frame — but neither scales with it. The
 * view zooms in whole steps as the window grows, and the tile art grows with it;
 * the text stays the size it was, at whatever size the reader's screen calls
 * 16px.
 *
 * ## Why these are DOM elements and not quads in the scene
 *
 * They used to be quads. A string was rasterised into a canvas at 8px, uploaded
 * as a texture and drawn like any other sprite, which is what tied it to world
 * pixels — one texel covered one world pixel, so a 5-pixel-tall capital arrived
 * on screen five *world* pixels tall and grew with the zoom.
 *
 * Keeping the text inside the canvas but at screen scale does not work. The
 * drawing buffer is a whole multiple of the view and is then *stretched* to fill
 * the pane by a fractional amount, so a texel is never quite a screen pixel and
 * an 8px font lands ragged across 8.9 of them. There is nowhere in that pipeline
 * to put crisp text.
 *
 * The browser rasterises a webfont against real device pixels at any DPR, which
 * is exactly the thing being asked for, so the text moves out to the DOM. The
 * old code argued against this on the grounds that an element chasing a canvas
 * position is a second, slightly-late copy of the camera. It is not: positions
 * are written from inside the same rAF callback that draws the frame, so the
 * style change and the canvas paint land in the same commit. What that comment
 * was really defending was world-pixel alignment, and world-pixel alignment is
 * what is being given up on purpose.
 *
 * ## Three phases, in that order, every frame
 *
 * Elements are synced, then measured, then moved — never interleaved. Reading a
 * box back out of the DOM forces the browser to finish any layout still pending,
 * so a loop that wrote and read one label at a time would pay for that flush
 * once per label. Split, the frame pays at most once, and only on the frames
 * where somebody's words actually changed.
 *
 * Measuring at all is the price of never overlapping: how much room a sentence
 * takes is a question only the font can answer, and `./labelLayout` cannot place
 * a crowd of boxes without knowing how big the boxes are.
 */

import { CELL_SIZE } from "../lib/types";
import {
  healthBarColor,
  healthBarFillBricks,
  healthBarFillHeightBricks,
  healthBarTrackBricks,
} from "./healthBar";
import {
  type LabelKind,
  type LabelPlacement,
  layoutLabels,
} from "./labelLayout";

/**
 * One anchor's worth of text, and the world-pixel point it hangs above.
 *
 * A group rather than a single string because several messages can share a cell,
 * and they have to stack. Stacking *within* a group is the DOM's job: lines flow
 * down a column whose bottom edge is the end nearest the ground, so the last
 * line is the newest and adding another pushes the rest up by exactly its own
 * height — wrapped or not, measured by nobody. Keeping groups off each other is
 * `./labelLayout`'s job, and needs every box measured.
 */
export type WorldLabel = {
  /** Stable per anchor: identity for the element cache, not what gets drawn. */
  id: string;
  /** Also the label's rank when the view gets crowded. @see ./labelLayout */
  kind: LabelKind;
  x: number;
  y: number;
  /** Oldest first. The last entry sits closest to the anchor. */
  lines: { id: string; text: string }[];
  /**
   * A health bar under the lines, nearest the head.
   *
   * Part of the label rather than a quad in the scene, and that is what makes
   * "the bar must not overlap the name" true by construction instead of by
   * arrangement: they are two children of one column, so no amount of moving the
   * group can bring them together. It also gets the bar the crispness the text
   * has — a real border a screen pixel wide, rather than a world pixel that is
   * five of them at this zoom.
   *
   * Absent for everything that is not a battler, and present for every battler
   * — full health included, so that a bar missing always means "not a thing you
   * fight" rather than sometimes meaning "unhurt".
   *
   * Vertically it is part of the column; horizontally it is not. The layout pass
   * places it on the anchor in its own right and answers with a `barLeft`, which
   * is what keeps the reading over the creature when the name above it has been
   * dragged inside the view. @see ./labelLayout
   */
  bar?: { fraction: number };
  /**
   * Painter's-order key for labels that overlap each other, larger drawn on
   * top. Absent leaves a label wherever it happens to fall.
   *
   * A name is chrome for a body in the world, so when two of them cross, the
   * one belonging to the body in front has to be the one you can read —
   * otherwise the tag on a creature standing behind you is drawn over the tag
   * on your own. The caller decides the order (see `drawOrder` in
   * `../lib/geometry`), because it is the same question the world answers about
   * the sprites underneath and must be answered the same way.
   */
  order?: number;
  /**
   * Ink for the whole group, overriding whatever the kind's class says.
   *
   * A battler's name is tinted to match its own health, so the tag and the bar
   * under it read as one reading of one thing rather than as a yellow label that
   * happens to have a coloured strip beneath it. Absent leaves the stylesheet in
   * charge, which is what everything that is not a battler wants.
   */
  color?: string;
};

/**
 * Where a label's *anchor* lands on screen, in CSS pixels from the view's top
 * left — the point in the world the text is about, not where the text ends up.
 * What the layout pass is handed, and what it moves the label away from only as
 * far as it has to.
 *
 * Rounded, because the font's bricks have to sit on whole pixels — a half pixel
 * of offset is the browser antialiasing a pixel font, which is the one thing
 * 1-bit type cannot absorb. This is the same argument the old world-pixel
 * rounding made, one coordinate space along.
 */
export function labelScreenPosition(
  worldX: number,
  worldY: number,
  camera: { x: number; y: number },
  cssScale: number,
): { left: number; top: number } {
  return {
    left: Math.round((worldX - camera.x) * cssScale),
    top: Math.round((worldY - camera.y) * cssScale),
  };
}

/**
 * How far above its anchor a bubble hangs, in ems of its own type.
 *
 * The one clash the layout pass is told to tolerate is speech or a look sitting
 * over a name tag, so it is the one that has to be kept apart here instead. It
 * is stated in ems because it separates text from text: measured in world pixels
 * it would close up at low zoom and yawn at high, which is the same argument
 * that took this text out of the scene in the first place.
 *
 * Two, not the line and a half it was, because a name tag is no longer one line:
 * a battler's carries a health bar under it, and the pair stand about
 * one-and-two-thirds ems tall. The old figure cleared the name it was measured
 * against and would now clip the top of it.
 */
const ANCHOR_CLEARANCE_EMS = 2;

/** The bar's track; its single child is the filled part. @see app/app.css */
const BAR_CLASS = "world-label__bar";

/**
 * Bricks to an em of the label font.
 *
 * The font is ten of its own pixels tall to the em, which is what lets a brick
 * be read back off a computed font size rather than copied out of the
 * stylesheet — `--world-label-brick` is that same division, in CSS.
 */
const BRICKS_PER_EM = 10;

/**
 * Point a bar at a health reading.
 *
 * Fill width and colour only — never the track, and never structure — so this
 * can run every frame for every battler on screen without touching layout. The
 * track is the last child of the group; a group whose signature says it has a
 * bar always has one.
 */
function fillBar(
  element: HTMLDivElement,
  fraction: number,
  trackBricks: number,
) {
  const fill = element.querySelector<HTMLElement>(`.${BAR_CLASS} > div`);
  if (!fill) return;
  // In bricks, not per cent: the fill has to step on the same grid the letters
  // sit on, or the bar is drawn at a finer resolution than the text beside it.
  fill.style.width = brickLength(healthBarFillBricks(fraction, trackBricks));
  fill.style.backgroundColor = healthBarColor(fraction);
}

/**
 * Give a track its box: a cell long, and thick in proportion to that.
 *
 * Both dimensions together, because they are one shape — a length set without
 * the thickness that goes with it is the bar that looked square on a phone. This
 * is layout, unlike {@link fillBar}, so it runs only when the zoom moves.
 */
function shapeTrack(track: HTMLElement, trackBricks: number) {
  track.style.width = brickLength(trackBricks);
  track.style.height = brickLength(healthBarFillHeightBricks(trackBricks));
}

/** A length in font bricks, as CSS. @see healthBarTrackBricks */
function brickLength(bricks: number): string {
  return `calc(var(--world-label-brick) * ${bricks})`;
}

/**
 * Label ids back to front, which is the order their elements have to sit in.
 *
 * Kept apart from the layer, and pure, for the same reason the health ramp is:
 * "which of these two names is on top" is a question about two numbers, and
 * answering it by looking at a screenshot is how an order quietly stops
 * matching the world underneath it.
 *
 * A label with no `order` sorts last — drawn over everything — because that is
 * where it already was: the layer appends new elements, and nothing that
 * declines to say where it belongs has an opinion worth honouring over one that
 * does. The sort is stable, so labels that tie keep the caller's order.
 */
export function stackingOrder(
  labels: readonly { id: string; order?: number }[],
): string[] {
  return [...labels]
    .sort(
      (a, b) =>
        (a.order ?? Number.POSITIVE_INFINITY) -
        (b.order ?? Number.POSITIVE_INFINITY),
    )
    .map((label) => label.id);
}

type LabelEntry = {
  /** What the group currently holds, so an unchanged group is never re-laid. */
  signature: string;
  element: HTMLDivElement;
  /**
   * The measured box, held until something invalidates it.
   *
   * Null means "ask the browser". Text is the only thing that changes it — and
   * the width of the view, since a group wraps against a share of that.
   */
  size: {
    width: number;
    height: number;
    lift: number;
    /** Undefined for a group with no bar in it. */
    barWidth: number | undefined;
  } | null;
  /** Whether the element is drawn, so an unchanged one is never rewritten. */
  shown: boolean;
  /** Last ink written, so an unchanged colour is not restyled every frame. */
  color: string | undefined;
};

/**
 * Identity of a group's contents, cheap to compare every frame.
 *
 * Whether there is a bar counts; how full it is deliberately does not. A bar's
 * box is the same size at every reading, so a changing fraction is a width and a
 * colour on a child that already exists — folding it in here would throw the
 * group's measurement away and force a layout read on every blow landed, to
 * re-measure a box that cannot have changed.
 */
function signatureOf(label: WorldLabel): string {
  const lines = label.lines.map((line) => `${line.id} ${line.text}`).join("");
  return label.bar ? `${lines}|bar` : lines;
}

/**
 * The label elements, kept between frames.
 *
 * Rebuilt only when the text changes, which is close to never — a walking actor
 * just moves the element it already has. Text content is the expensive part
 * (layout, wrapping); position is a style write the compositor can take.
 */
export class WorldLabelLayer {
  private readonly entries = new Map<string, LabelEntry>();
  /**
   * The square's size in CSS pixels, watched rather than read per frame.
   *
   * The layout pass needs it every frame to keep labels inside the view, and
   * asking the element for it would be a layout read on every frame including
   * the still ones. It changes when the window does, so the window is what
   * tells us.
   */
  private view: { width: number; height: number };
  /** Ids in the order they are currently stacked. @see restack */
  private stacking = "";
  /**
   * The track length every bar on screen is currently drawn at, in bricks.
   *
   * One number for the whole layer rather than one per bar, because it is
   * decided by the zoom and every cell is the same size: two bars of different
   * lengths would be two scales to read at once. Zero until the first frame has
   * a scale to work it out from. @see healthBarTrackBricks
   */
  private trackBricks = 0;
  /**
   * A brick in CSS pixels, read off the layer's own type rather than copied out
   * of the stylesheet, and held because it only moves when the font size does.
   * @see BRICKS_PER_EM
   */
  private brickPx: number | null = null;
  private readonly resize: ResizeObserver | null;
  /**
   * Every held measurement is a claim about a box drawn in a particular face,
   * so a font arriving after one was taken makes it a lie — the group is the
   * same words at a different width, and `./labelLayout` centres it on the
   * width. A name tag a few pixels off its head is exactly what that looks
   * like.
   *
   * The world is normally not drawn until its font is here (`../lib/gameAssets`
   * holds the canvas out of the page until then), so this should never fire in
   * a healthy load. It is what makes that gate's timeout survivable rather than
   * permanent: a font that misses the deadline and lands a moment later still
   * gets its labels re-measured, instead of leaving them wrong for the session.
   */
  private readonly onFontsLoaded = () => {
    this.brickPx = null;
    for (const entry of this.entries.values()) entry.size = null;
  };

  constructor(private readonly container: HTMLElement) {
    this.view = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
    this.resize = this.watchSize();
    document.fonts?.addEventListener("loadingdone", this.onFontsLoaded);
  }

  /**
   * Keep the view size honest, every frame, observer or no observer.
   *
   * This used to return early whenever a ResizeObserver existed, on the grounds
   * that the observer already knew. The observer is not a thing you can bet a
   * frame on: notifications go undelivered when a callback resizes something —
   * the "ResizeObserver loop" case — and the layer has no way to find out it
   * missed one. Nothing else here ever reads the container again, so a single
   * skipped delivery left `view` stale until the *next* resize, which is a long
   * time to be wrong.
   *
   * Being wrong here is not a slightly misplaced label. `../render/labelLayout`
   * drops any label whose anchor falls outside the view, so a `view` smaller
   * than the pane really is — which is what growing the window and missing the
   * notification gives you — silently takes every name near the edge off the
   * screen, and a size still at its initial zero takes all of them.
   *
   * The read costs nothing that was not already being paid. The frame that calls
   * this has already asked the canvas for its box — `currentFit` in
   * `./GameRenderer`, once per frame, to work out the scale — so the layout is
   * read every frame either way, and a second box off a clean layout is a
   * lookup rather than a reflow. The observer stays for the job only it can do:
   * throwing away held measurements, since every group wraps against a share of
   * the width.
   */
  private syncView() {
    this.view = {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    };
  }

  /**
   * Fit every track to a cell, and only when the zoom has actually moved one.
   *
   * A track's length is layout — the layout pass places a bar on its own anchor
   * and needs to know how wide it turned out — so this runs in the sync phase,
   * before anything is measured, and writes nothing on the frames where the
   * answer has not changed. Which is almost all of them: the scale moves when
   * the window does, and the window does not move sixty times a second.
   *
   * A new length makes every held measurement a claim about a box that no longer
   * exists, so they go with it — the same reason a resize drops them.
   */
  private sizeTracks(cssScale: number) {
    const bricks = healthBarTrackBricks(CELL_SIZE * cssScale, this.brick());
    if (bricks === this.trackBricks) return;
    this.trackBricks = bricks;

    for (const entry of this.entries.values()) {
      const track = entry.element.querySelector<HTMLElement>(`.${BAR_CLASS}`);
      if (!track) continue;
      shapeTrack(track, bricks);
      entry.size = null;
    }
  }

  /**
   * A brick in CSS pixels: a tenth of the type the layer is set in.
   *
   * Derived rather than copied, so `--world-label-size` stays the one place the
   * size is written — the same argument {@link measure} makes about the height a
   * bubble hangs at. Held between frames because the answer only moves when the
   * font size does, and computing it is a style read on the container.
   */
  private brick(): number {
    if (this.brickPx !== null) return this.brickPx;
    const fontSize =
      Number.parseFloat(getComputedStyle(this.container).fontSize) || 0;
    this.brickPx = fontSize / BRICKS_PER_EM;
    return this.brickPx;
  }

  /**
   * Throw away held measurements when the pane changes shape.
   *
   * The one job the observer is actually needed for: every group wraps against a
   * share of the width, so a resize makes every held measurement a claim about a
   * box that no longer exists, and nothing else would ever notice. The view size
   * is *not* read from here — see {@link syncView} for why that would be
   * trusting a notification that is allowed to go missing.
   */
  private watchSize(): ResizeObserver | null {
    if (typeof ResizeObserver === "undefined") return null;
    const observer = new ResizeObserver(() => {
      this.brickPx = null;
      for (const entry of this.entries.values()) entry.size = null;
    });
    observer.observe(this.container);
    return observer;
  }

  /**
   * Sync, measure, place — in that order, never interleaved. @see module doc
   */
  set(
    labels: WorldLabel[],
    camera: { x: number; y: number },
    cssScale: number,
  ) {
    this.syncView();
    this.sizeTracks(cssScale);

    const live = new Set<string>();
    const entries = labels.map((label) => {
      live.add(label.id);
      const entry = this.entry(label);
      // Outside the sync/measure/place discipline on purpose: a fill width is a
      // style write on an existing child, so it cannot change the box the layout
      // pass is about to measure and cannot force a reflow to read.
      if (label.bar) {
        fillBar(entry.element, label.bar.fraction, this.trackBricks);
      }
      // Ink is a paint, never a box, so it rides alongside the fill rather than
      // counting towards the signature that would force a re-measure.
      if (entry.color !== label.color) {
        entry.element.style.color = label.color ?? "";
        entry.color = label.color;
      }
      return { label, entry };
    });
    this.prune(live);

    const requests = entries.map(({ label, entry }) => {
      const anchor = labelScreenPosition(label.x, label.y, camera, cssScale);
      return {
        id: label.id,
        kind: label.kind,
        anchorX: anchor.left,
        anchorY: anchor.top,
        ...this.measure(entry, label.kind),
      };
    });

    const layout = layoutLabels(requests, this.view);
    for (const { label, entry } of entries) {
      this.place(entry, layout.get(label.id));
    }
    this.restack(labels);
  }

  /**
   * Put the elements in painter's order, back to front.
   *
   * Order is the *document's*, not a `z-index`, and that is what keeps this from
   * fighting the stylesheet: siblings at one z-index paint in tree order, so
   * moving elements settles which name is on top while the classes go on
   * deciding that every name is under every bubble and every bubble under a
   * damage number. Writing z-indexes here would mean choosing numbers that stay
   * inside the band the stylesheet gave names, for a crowd whose size is not
   * known in advance.
   *
   * Only when the order actually changed. Two bodies cross a few times a minute
   * at most while this runs sixty times a second, and moving a node the browser
   * already has in that position is still a DOM mutation.
   */
  private restack(labels: WorldLabel[]) {
    const order = stackingOrder(labels);
    const stacking = order.join("\n");
    if (stacking === this.stacking) return;
    this.stacking = stacking;
    // Appending a node the container already holds moves it, so one pass in
    // painter's order leaves the children in exactly that order.
    for (const id of order) {
      const entry = this.entries.get(id);
      if (entry) this.container.appendChild(entry.element);
    }
  }

  /**
   * Put a label where the pass said, or take it off the screen if it said
   * nowhere.
   *
   * Hidden rather than removed: a label with no room this frame usually has room
   * the next one, and tearing the element down would throw away its measurement
   * to save nothing. `visibility` rather than `display` for the same reason —
   * the box stays measurable while it is out of sight.
   */
  private place(entry: LabelEntry, at: LabelPlacement | undefined) {
    if (!at) {
      if (entry.shown) {
        entry.element.style.visibility = "hidden";
        entry.shown = false;
      }
      return;
    }

    if (!entry.shown) {
      entry.element.style.visibility = "";
      entry.shown = true;
    }
    // Written as custom properties feeding a transform, never as `left`/`top`.
    // An absolutely positioned box gets `containingBlockWidth - left` to lay
    // out in, so a label placed near the right edge wrapped by how close it
    // was to the edge rather than by its own max-width — the same sentence
    // broke onto two lines on the right of the view and one on the left.
    // Anchored at the origin and moved by a transform, every label lays out
    // against the full width and wraps only where it is told to. The transform
    // now takes the label's *top left*: with the pass deciding placement, a
    // stylesheet that also shifted the box by -50%/-100% would be a second,
    // invisible opinion about where the text goes.
    entry.element.style.setProperty("--label-x", `${at.left}px`);
    entry.element.style.setProperty("--label-y", `${at.top}px`);
    // The bar's answer is an absolute position like the group's, but the
    // element it lands on is a child, so it is written as the distance from the
    // corner the group was put in. The bar starts at that corner —
    // `align-self: start` in the stylesheet — precisely so this stays whole
    // pixels: centred in the column it would begin at half a group width, and
    // half a pixel of offset is the browser antialiasing a 1-bit border.
    if (at.barLeft !== undefined) {
      entry.element.style.setProperty("--bar-x", `${at.barLeft - at.left}px`);
    }
  }

  /**
   * How much room this group takes, and how far it hangs above its anchor.
   *
   * The clearance is derived from the element's own computed font size rather
   * than a number copied out of the stylesheet: the size lives in one place
   * (`--world-label-size` in `app/app.css`), and this way changing it there
   * moves the bubbles with it — which is what "a line and a half" has to mean
   * to stay true.
   */
  private measure(
    entry: LabelEntry,
    kind: WorldLabel["kind"],
  ): {
    width: number;
    height: number;
    lift: number;
    barWidth: number | undefined;
  } {
    if (entry.size) return entry.size;

    const { element } = entry;
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || 0;
    const size = {
      width: element.offsetWidth,
      height: element.offsetHeight,
      // A name is the thing being cleared, so it sits on the anchor itself.
      lift: kind === "name" ? 0 : Math.round(fontSize * ANCHOR_CLEARANCE_EMS),
      // Measured rather than worked out from the track's brick count, because
      // the number the layout pass needs is the box the browser actually made:
      // bricks, borders and the rounding of a fractional em all included. It is
      // read here with the rest so it costs no extra layout flush.
      barWidth: element.querySelector<HTMLElement>(`.${BAR_CLASS}`)
        ?.offsetWidth,
    };
    entry.size = size;
    return size;
  }

  private prune(live: Set<string>) {
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      this.entries.delete(id);
    }
  }

  /** The group for this anchor, rebuilt only if its lines changed. */
  private entry(label: WorldLabel): LabelEntry {
    const signature = signatureOf(label);
    const existing = this.entries.get(label.id);
    if (existing) {
      if (existing.signature !== signature) {
        this.fill(existing.element, label);
        existing.signature = signature;
        // New words, new box — and the box is what the pass places.
        existing.size = null;
      }
      return existing;
    }

    const element = document.createElement("div");
    element.className = `world-label world-label--${label.kind}`;
    this.fill(element, label);
    // Placed before it is drawn: a new element measured this frame is laid out
    // at the origin, and showing it there for one frame is a label that blinks
    // in the corner on its way to the head it belongs to.
    element.style.visibility = "hidden";
    this.container.appendChild(element);

    const entry: LabelEntry = {
      signature,
      element,
      size: null,
      shown: false,
      color: undefined,
    };
    this.entries.set(label.id, entry);
    return entry;
  }

  /**
   * One child per line, in order, and the bar last.
   *
   * Rebuilt wholesale rather than diffed: a group holds at most a few lines, and
   * the alternative is a reconciler for something that changes when somebody
   * speaks.
   *
   * The bar goes last because the column flows downward from a bottom edge on
   * the anchor, so the final child is the one nearest the head — a name sitting
   * above the health of the thing it names, which is the order both are read in.
   */
  private fill(element: HTMLDivElement, label: WorldLabel) {
    const rows: HTMLElement[] = label.lines.map((line) => {
      const row = document.createElement("div");
      // Set as text, never as markup: this is the one string on screen that
      // came from another player.
      row.textContent = line.text;
      return row;
    });

    if (label.bar) {
      const track = document.createElement("div");
      track.className = BAR_CLASS;
      // Sized here rather than in the stylesheet because neither dimension is a
      // constant: the track is a cell wide, which is a number only the current
      // zoom knows, and its thickness is in proportion to that. Written on
      // creation, and again from {@link sizeTracks} when the zoom moves — the
      // one part of a bar that is layout rather than paint.
      shapeTrack(track, this.trackBricks);
      track.appendChild(document.createElement("div"));
      rows.push(track);
    }

    element.replaceChildren(...rows);
  }

  dispose() {
    this.resize?.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.onFontsLoaded);
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

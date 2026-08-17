import { DAMAGE_NUMBER_LIFETIME_MS } from "../game/constants";
import type { SwingOutcome } from "../game/GameSession";
import { labelScreenPosition } from "./textLabels";

/**
 * Numbers rising off whatever was just hit.
 *
 * A layer of its own rather than another kind of {@link WorldLabel}, and the
 * reason is what the two are *for*. A label is something to be read at leisure,
 * so it is measured, kept clear of its neighbours, and hidden when the view gets
 * crowded. A damage number is a receipt: it must appear exactly where the blow
 * landed, at the moment it landed, and it must never be moved aside or dropped
 * to make room for somebody's name — which is the whole of what the layout pass
 * exists to do. So this pays for none of it: no measuring, no layout, no reflow.
 *
 * They share the container and the font. That is deliberate too — the numbers
 * belong to the same world as the speech over the same heads.
 */

/**
 * How far a number climbs before it goes, in CSS pixels.
 *
 * Screen space rather than world space, so a number travels the same visible
 * distance at every zoom — at 4× a world-pixel rise would fling it off the top
 * of the view, and the drift is a readability cue rather than a thing happening
 * in the world.
 */
const RISE_PX = 22;

/** Where a number starts, relative to its anchor, so it clears the sprite. */
const START_LIFT_PX = 6;

/** One number on screen, as the layer is asked to draw it. */
export type DamageNumberView = {
  /** Stable per blow; the element cache is keyed on it. */
  id: string;
  /** World-pixel anchor — the point the number rises from. */
  x: number;
  y: number;
  /** Which of the three this was; decides the word and the colour. */
  outcome: SwingOutcome;
  /** Read only for a hit — the other two say a word instead. */
  amount: number;
  /**
   * Red for a blow the viewer took, white for everybody else's.
   *
   * Decided by the caller rather than here, because "is this me" is a question
   * about the session and this module has no idea who is looking. What is done
   * *with* the answer is this module's business, which is why a miss or a dodge
   * ignores it — see {@link classFor}.
   */
  own: boolean;
  elapsedMs: number;
};

type Entry = {
  element: HTMLDivElement;
  /** What it says, so an unchanged receipt is never rewritten. */
  text: string;
  className: string;
};

/**
 * The number elements, kept between frames.
 *
 * Held rather than rebuilt for the same reason the label layer holds its own:
 * writing text is layout, writing a transform is not. A number's text is written
 * once when it appears and never again — only its offset changes, every frame,
 * for the second or so it lives.
 */
export class DamageNumberLayer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly container: HTMLElement) {}

  /**
   * Draw this frame's numbers.
   *
   * Position is computed from the anchor and the number's own age, so a number
   * rises at the same rate whatever the frame rate is doing — and, because the
   * anchor is a fixed world point rather than the body it came off, it keeps
   * rising from where the blow landed even after that body has walked away or
   * been deleted.
   */
  set(
    numbers: DamageNumberView[],
    camera: { x: number; y: number },
    cssScale: number,
  ) {
    const live = new Set<string>();

    for (const number of numbers) {
      live.add(number.id);
      const entry = this.entry(number);
      const anchor = labelScreenPosition(number.x, number.y, camera, cssScale);
      const progress = Math.min(
        1,
        Math.max(0, number.elapsedMs / DAMAGE_NUMBER_LIFETIME_MS),
      );
      // No fade and no shrink — it simply travels and stops existing, which is
      // what keeps a small number as readable in its last frame as its first.
      const top = Math.round(anchor.top - START_LIFT_PX - RISE_PX * progress);
      entry.element.style.setProperty("--label-x", `${anchor.left}px`);
      entry.element.style.setProperty("--label-y", `${top}px`);
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      this.entries.delete(id);
    }
  }

  private entry(number: DamageNumberView): Entry {
    const text = textFor(number);
    const className = classFor(number);

    const existing = this.entries.get(number.id);
    if (existing) {
      // A receipt's own value never changes once it is on screen, so this only
      // guards against an id being reused — cheap, and the alternative is a
      // stale figure hanging there.
      if (existing.text !== text) {
        existing.element.textContent = text;
        existing.text = text;
      }
      if (existing.className !== className) {
        existing.element.className = className;
        existing.className = className;
      }
      return existing;
    }

    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    this.container.appendChild(element);

    const entry: Entry = { element, text, className };
    this.entries.set(number.id, entry);
    return entry;
  }

  dispose() {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

/**
 * What a swing that came to nothing says.
 *
 * Words rather than a symbol, because the two have to be told apart at a glance
 * and be *learnable*: "miss" is the swinger failing and "dodge" is the target
 * succeeding, and a player who cannot separate them cannot tell a weapon they
 * have no business holding from a foe they cannot catch.
 */
const NOTHING_HAPPENED: Record<Exclude<SwingOutcome, "hit">, string> = {
  miss: "miss",
  dodge: "dodge",
};

function textFor(number: DamageNumberView): string {
  if (number.outcome === "hit") return String(number.amount);
  return NOTHING_HAPPENED[number.outcome];
}

/**
 * Red for a blow you took, grey for a blow nobody took, white otherwise.
 *
 * A miss or a dodge ignores `own` deliberately: red marks hit points you cannot
 * afford to miss while reading the traffic, and a swing that took none has
 * nothing at stake whoever it happened to.
 */
function classFor(number: DamageNumberView): string {
  if (number.outcome !== "hit") return "damage-number damage-number--nothing";
  return `damage-number${number.own ? " damage-number--own" : ""}`;
}

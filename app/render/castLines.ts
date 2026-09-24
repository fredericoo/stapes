import { labelScreenPosition } from "./textLabels";

/**
 * A dotted line from somebody casting to whoever the spell will land on.
 *
 * **What it answers is "at whom"**, which the bar over a caster's head does
 * not: the bar says a spell is coming and how soon, and nothing on screen said
 * where it would go until the bolt was already in the air. The dots run from
 * caster to target, so the direction is readable on a line between two bodies
 * standing side by side.
 *
 * **Red when it is aimed at you, white otherwise** — the rule the damage
 * numbers follow, and for their reason: red marks what is about to cost you hit
 * points, and a cast at somebody else costs you nothing.
 *
 * An SVG in the label container rather than geometry in the scene, on the terms
 * the damage numbers are: a line of fixed thickness that must not be sorted
 * behind a wall, and that costs one element per cast rather than a mesh.
 * Beneath the labels, so a name reads over a line crossing it.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** One cast being aimed, as the layer is asked to draw it. */
export type CastLineView = {
  /** The caster's id, since a body casts one spell at a time. */
  id: string;
  /** World-pixel ends: the caster's body, and the target's. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /**
   * Whether the viewer is the target. Decided by the caller, on
   * `DamageNumberView.own`'s terms: this module has no idea who is looking.
   */
  atYou: boolean;
};

/** Which class a line wears, and so its colour. */
export function castLineClass(line: Pick<CastLineView, "atYou">): string {
  return line.atYou ? "cast-line cast-line--at-you" : "cast-line";
}

type Entry = { element: SVGLineElement; className: string };

/**
 * The line elements, kept between frames, on the damage layer's terms: an
 * element is made when a cast starts being aimed and only its ends move after.
 */
export class CastLineLayer {
  private readonly svg: SVGSVGElement;
  private readonly entries = new Map<string, Entry>();
  /** The last scale written, so a still zoom writes no style. */
  private cssScale = 0;

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("cast-line-layer");
    this.svg.setAttribute("aria-hidden", "true");
    // First, so every label added after it paints over it.
    container.prepend(this.svg);
  }

  set(lines: CastLineView[], camera: { x: number; y: number }, cssScale: number) {
    if (cssScale !== this.cssScale) {
      // One world pixel, in CSS pixels: the dots are drawn at the world's own
      // grain, so they scale with the sprites rather than with the text.
      this.svg.style.setProperty("--cast-line-px", `${cssScale}px`);
      this.cssScale = cssScale;
    }

    const live = new Set<string>();
    for (const line of lines) {
      live.add(line.id);
      const entry = this.entry(line);
      const from = labelScreenPosition(line.from.x, line.from.y, camera, cssScale);
      const to = labelScreenPosition(line.to.x, line.to.y, camera, cssScale);
      entry.element.setAttribute("x1", String(from.left));
      entry.element.setAttribute("y1", String(from.top));
      entry.element.setAttribute("x2", String(to.left));
      entry.element.setAttribute("y2", String(to.top));
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      this.entries.delete(id);
    }
  }

  private entry(line: CastLineView): Entry {
    const className = castLineClass(line);
    const existing = this.entries.get(line.id);
    if (existing) {
      // The target can change mid-cast, from somebody else to you or back.
      if (existing.className !== className) {
        existing.element.setAttribute("class", className);
        existing.className = className;
      }
      return existing;
    }

    const element = document.createElementNS(SVG_NS, "line");
    element.setAttribute("class", className);
    this.svg.appendChild(element);
    const entry: Entry = { element, className };
    this.entries.set(line.id, entry);
    return entry;
  }

  dispose() {
    this.svg.remove();
    this.entries.clear();
  }
}

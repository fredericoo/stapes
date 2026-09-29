import { labelScreenPosition } from "./textLabels";

const SVG_NS = "http://www.w3.org/2000/svg";

export type CastLineView = {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  atYou: boolean;
  attack?: boolean;
};

export function castLineClass(line: Pick<CastLineView, "atYou" | "attack">): string {
  const classes = ["cast-line"];
  if (line.atYou) classes.push("cast-line--at-you");
  if (line.attack) classes.push("cast-line--attack");
  return classes.join(" ");
}

type Entry = { element: SVGLineElement; className: string };

export class CastLineLayer {
  private readonly svg: SVGSVGElement;
  private readonly entries = new Map<string, Entry>();
  private cssScale = 0;

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("cast-line-layer");
    this.svg.setAttribute("aria-hidden", "true");
    container.prepend(this.svg);
  }

  set(lines: CastLineView[], camera: { x: number; y: number }, cssScale: number) {
    if (cssScale !== this.cssScale) {
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

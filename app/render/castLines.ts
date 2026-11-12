const SVG_NS = "http://www.w3.org/2000/svg";

const DOT_PERIOD_PX = 3;
const MARCH_STEP_MS = 100;

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

export function castLinePhase(nowMs: number): number {
  return Math.floor(nowMs / MARCH_STEP_MS) % DOT_PERIOD_PX;
}

/**
 * Walks the longer axis one world pixel at a time, so every dot is a whole
 * world pixel and a diagonal keeps the same dot count as its longer side.
 */
export function castLineDots(
  from: { x: number; y: number },
  to: { x: number; y: number },
  phase: number,
): { x: number; y: number }[] {
  const x0 = Math.floor(from.x);
  const y0 = Math.floor(from.y);
  const dx = Math.floor(to.x) - x0;
  const dy = Math.floor(to.y) - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const dots: { x: number; y: number }[] = [];
  for (let i = phase; i <= steps; i += DOT_PERIOD_PX) {
    const t = steps === 0 ? 0 : i / steps;
    dots.push({ x: x0 + Math.round(dx * t), y: y0 + Math.round(dy * t) });
  }
  return dots;
}

function dotsPath(dots: { x: number; y: number }[]): string {
  return dots.map((dot) => `M${dot.x} ${dot.y}h1v1h-1z`).join("");
}

type Entry = {
  group: SVGGElement;
  shadow: SVGPathElement;
  dots: SVGPathElement;
  className: string;
  path: string;
};

export class CastLineLayer {
  private readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private readonly entries = new Map<string, Entry>();
  private readonly marches: boolean;
  private transform = "";

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("cast-line-layer");
    this.svg.setAttribute("aria-hidden", "true");
    this.world = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.world);
    container.prepend(this.svg);
    this.marches = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  set(lines: CastLineView[], camera: { x: number; y: number }, cssScale: number, nowMs: number) {
    const transform = `scale(${cssScale}) translate(${-camera.x} ${-camera.y})`;
    if (transform !== this.transform) {
      this.world.setAttribute("transform", transform);
      this.transform = transform;
    }

    const phase = this.marches ? castLinePhase(nowMs) : 0;
    const live = new Set<string>();
    for (const line of lines) {
      live.add(line.id);
      const entry = this.entry(line);
      const path = dotsPath(castLineDots(line.from, line.to, phase));
      if (path === entry.path) continue;
      entry.shadow.setAttribute("d", path);
      entry.dots.setAttribute("d", path);
      entry.path = path;
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.group.remove();
      this.entries.delete(id);
    }
  }

  private entry(line: CastLineView): Entry {
    const className = castLineClass(line);
    const existing = this.entries.get(line.id);
    if (existing) {
      if (existing.className !== className) {
        existing.group.setAttribute("class", className);
        existing.className = className;
      }
      return existing;
    }

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", className);
    const shadow = document.createElementNS(SVG_NS, "path");
    shadow.setAttribute("class", "cast-line__shadow");
    shadow.setAttribute("transform", "translate(0 1)");
    const dots = document.createElementNS(SVG_NS, "path");
    group.append(shadow, dots);
    this.world.appendChild(group);
    const entry: Entry = { group, shadow, dots, className, path: "" };
    this.entries.set(line.id, entry);
    return entry;
  }

  dispose() {
    this.svg.remove();
    this.entries.clear();
  }
}

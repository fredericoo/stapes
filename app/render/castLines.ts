const SVG_NS = "http://www.w3.org/2000/svg";

const DOT_PERIOD_PX = 3;
const MARCH_STEP_MS = 100;

type Point = { x: number; y: number };

export type CastLineView = {
  id: string;
  from: Point;
  to: Point;
  /** Where the shadow of the point a fraction of the way along the line falls. */
  shadowAt: (t: number) => Point;
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

function pixelAt(from: Point, to: Point, t: number): Point {
  const x0 = Math.floor(from.x);
  const y0 = Math.floor(from.y);
  return {
    x: x0 + Math.round((Math.floor(to.x) - x0) * t),
    y: y0 + Math.round((Math.floor(to.y) - y0) * t),
  };
}

/**
 * Walks the longer axis of `from`–`to` one world pixel at a time, so every dot
 * is a whole world pixel and a diagonal keeps the same dot count as its longer
 * side. With `onto`, each dot is put where `onto` says that fraction of the
 * line lands instead, which is how a shadow keeps one dot under each dot above.
 */
export function castLineDots(
  from: Point,
  to: Point,
  phase: number,
  onto: (t: number) => Point = (t) => pixelAt(from, to, t),
): Point[] {
  const dx = Math.floor(to.x) - Math.floor(from.x);
  const dy = Math.floor(to.y) - Math.floor(from.y);
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const dots: Point[] = [];
  for (let i = phase; i <= steps; i += DOT_PERIOD_PX) {
    const at = onto(steps === 0 ? 0 : i / steps);
    dots.push({ x: Math.floor(at.x), y: Math.floor(at.y) });
  }
  return dots;
}

function dotsPath(dots: Point[]): string {
  return dots.map((dot) => `M${dot.x} ${dot.y}h1v1h-1z`).join("");
}

type Entry = {
  group: SVGGElement;
  shadow: SVGPathElement;
  dots: SVGPathElement;
  className: string;
  path: string;
  shadowPath: string;
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
      if (path !== entry.path) {
        entry.dots.setAttribute("d", path);
        entry.path = path;
      }
      const shadowPath = dotsPath(castLineDots(line.from, line.to, phase, line.shadowAt));
      if (shadowPath !== entry.shadowPath) {
        entry.shadow.setAttribute("d", shadowPath);
        entry.shadowPath = shadowPath;
      }
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
    const dots = document.createElementNS(SVG_NS, "path");
    group.append(shadow, dots);
    this.world.appendChild(group);
    const entry: Entry = { group, shadow, dots, className, path: "", shadowPath: "" };
    this.entries.set(line.id, entry);
    return entry;
  }

  dispose() {
    this.svg.remove();
    this.entries.clear();
  }
}

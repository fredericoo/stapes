/**
 * Two footprints, drawn one character per pixel with `#` filled. The black edge
 * is not drawn here: `outlined` adds it, so the art stays the shape alone.
 */
const FEET = [
  "..........",
  "......##..",
  ".....###..",
  ".....###..",
  ".##..###..",
  ".###......",
  ".###.##...",
  ".###.##...",
  "..........",
  "..##......",
  "..##......",
  "..........",
];

const CELL_PX = 2;

const INK = { fill: "#fff", edge: "#000" } as const;

/** Below and right of the pointer's tip, clear of the system arrow. */
const OFFSET_PX = { x: 14, y: 16 };

type Pixel = "fill" | "edge";

/**
 * Every empty pixel sharing a side with a filled one becomes edge. Corners are
 * left out, so a one-pixel gap between the two feet stays open.
 */
function outlined(rows: readonly string[]): (Pixel | null)[][] {
  const filled = (x: number, y: number) => rows[y]?.[x] === "#";
  return rows.map((row, y) =>
    [...row].map((_, x) => {
      if (filled(x, y)) return "fill";
      const touches = filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1);
      return touches ? "edge" : null;
    }),
  );
}

function pixelSvg(rows: readonly string[]): string {
  const w = rows[0]!.length * CELL_PX;
  const h = rows.length * CELL_PX;
  const rects: string[] = [];
  for (const [y, row] of outlined(rows).entries()) {
    for (const [x, pixel] of row.entries()) {
      if (!pixel) continue;
      rects.push(
        `<rect x="${x * CELL_PX}" y="${y * CELL_PX}" width="${CELL_PX}" height="${CELL_PX}" fill="${INK[pixel]}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

export const FEET_IMAGE = `data:image/svg+xml,${encodeURIComponent(pixelSvg(FEET))}`;

/**
 * Footprints that follow the pointer over ground a click would walk to. It sits
 * beside the system cursor rather than replacing it, and never takes a pointer
 * event, so the canvas under it still gets every move and click.
 */
export class WalkBadge {
  private el: HTMLImageElement | null = null;
  private shownAt: { x: number; y: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement;
    if (!parent) return;
    const el = document.createElement("img");
    el.src = FEET_IMAGE;
    el.alt = "";
    el.draggable = false;
    el.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "pointer-events:none",
      "image-rendering:pixelated",
      "display:none",
      "z-index:1",
    ].join(";");
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(el);
    this.el = el;
  }

  /** `point` is in the canvas's own CSS pixels, as the renderer's pointer is. */
  place(point: { x: number; y: number } | null) {
    const el = this.el;
    if (!el) return;
    const at = this.shownAt;
    if (point === null) {
      if (at !== null) el.style.display = "none";
      this.shownAt = null;
      return;
    }
    if (at && at.x === point.x && at.y === point.y) return;
    const x = this.canvas.offsetLeft + point.x + OFFSET_PX.x;
    const y = this.canvas.offsetTop + point.y + OFFSET_PX.y;
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (at === null) el.style.display = "block";
    this.shownAt = { x: point.x, y: point.y };
  }

  dispose() {
    this.el?.remove();
    this.el = null;
  }
}

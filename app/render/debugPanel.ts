/**
 * The numbers beside the debug view's rectangles.
 *
 * Plain DOM built by the renderer rather than a React component wired through
 * both play routes, for the same reason the editor's stats readout is
 * (`app/editor/EditorRenderer.ts`): this is a diagnostic that ships switched
 * off, and every prop it would add to `GameViewport` is a prop somebody has to
 * read past forever. It appends itself beside the canvas and takes itself away.
 *
 * What it says is a reading of the renderer's own state — see
 * {@link DebugReading} — so a number here and an outline on the canvas can
 * never disagree about what is built.
 *
 * **Each row is written in the colour its rectangle is drawn in.** That is the
 * whole of the legend: there is no separate key to keep in step with the
 * palette, because the row *is* the key.
 */
import type { DebugReading } from "./WorldRenderer";
import { DEBUG_COLORS } from "./debugColors";
import { VIEW_CELLS } from "./viewport";

/**
 * How often the panel is rewritten.
 *
 * Four times a second: fast enough to watch a chunk column arrive, slow enough
 * that the numbers can be read rather than blurred, and far enough from frame
 * rate that formatting a dozen strings is not itself on the frame budget.
 */
export const DEBUG_PANEL_INTERVAL_MS = 250;

/** The rows, in the order they are stacked. */
const ROWS = ["title", "play", "mesh", "light", "held", "draws"] as const;
type Row = (typeof ROWS)[number];

/** Ink per row — a CSS colour for the same value the outline is cut in. */
const ROW_INK: Record<Row, string> = {
  title: "#e8e6e1",
  play: cssColor(DEBUG_COLORS.play),
  mesh: cssColor(DEBUG_COLORS.mesh),
  light: cssColor(DEBUG_COLORS.light),
  held: cssColor(DEBUG_COLORS.held),
  draws: "rgba(232,230,225,0.6)",
};

const PANEL_STYLE = [
  "position:absolute",
  "top:6px",
  "left:6px",
  "z-index:60",
  "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
  "background:rgba(10,10,12,0.82)",
  "padding:6px 8px",
  "pointer-events:none",
  "white-space:pre",
  "border:1px solid rgba(232,230,225,0.25)",
].join(";");

export class DebugPanel {
  private rows: Map<Row, HTMLDivElement> | null = null;
  private el: HTMLDivElement | null = null;
  private lastWriteMs = 0;

  /**
   * Attach beside the canvas.
   *
   * The canvas's own parent, because that is the box the canvas fills and the
   * label layer already sits over — anything higher up is the page's furniture
   * and would put the panel next to the game rather than on it.
   */
  constructor(canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement;
    if (!parent) return;
    const el = document.createElement("div");
    el.dataset.debugPanel = "";
    el.style.cssText = PANEL_STYLE;
    const rows = new Map<Row, HTMLDivElement>();
    for (const row of ROWS) {
      const line = document.createElement("div");
      line.style.color = ROW_INK[row];
      el.appendChild(line);
      rows.set(row, line);
    }
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(el);
    this.el = el;
    this.rows = rows;
  }

  /**
   * Rewrite the panel, at most {@link DEBUG_PANEL_INTERVAL_MS} apart.
   *
   * The throttle is here rather than at the call site so the caller can hand
   * this every frame without holding a clock of its own.
   */
  update(nowMs: number, zoomOut: number, reading: DebugReading | null) {
    const rows = this.rows;
    if (!rows) return;
    if (nowMs - this.lastWriteMs < DEBUG_PANEL_INTERVAL_MS) return;
    this.lastWriteMs = nowMs;
    const text = panelRows(zoomOut, reading);
    for (const row of ROWS) rows.get(row)!.textContent = text[row];
  }

  dispose() {
    this.el?.remove();
    this.el = null;
    this.rows = null;
  }
}

/**
 * What each row says. Exported so a test can read the numbers without a DOM.
 *
 * A reach is cells past the edge of the play square, which is the comparison
 * the whole view is about: how much world is being paid for that nobody in the
 * game can see.
 */
export function panelRows(zoomOut: number, r: DebugReading | null): Record<Row, string> {
  if (!r) {
    return {
      title: `debug ×${zoomOut}   [ ] to zoom`,
      play: "play    —",
      mesh: "meshed  —",
      light: "lit     —",
      held: "sent    —",
      draws: "draws   no frame yet",
    };
  }
  return {
    title: `debug ×${zoomOut}   [ ] to zoom`,
    play: `play    ${VIEW_CELLS}×${VIEW_CELLS} cells`,
    mesh: `meshed  ${r.meshColumns} cols · ${r.meshChunks} chunks · +${r.meshReachCells}c`,
    light: `lit     ${r.lightChunks} chunks · ${r.lightStale} stale · +${r.lightReachCells}c`,
    held: `sent    ${r.heldColumns} cols${reach(r.heldReachCells)}`,
    draws: `draws   ${r.drawCalls} calls · ${r.triangles} tris`,
  };
}

/** `+79c`, or a word before the first chunks land. */
function reach(cells: number | null): string {
  return cells === null ? " · waiting" : ` · +${cells}c`;
}

/** A Three.js hex colour as the CSS the panel wears. */
function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

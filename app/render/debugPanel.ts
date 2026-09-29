import type { DebugReading } from "./WorldRenderer";
import { DEBUG_COLORS } from "./debugColors";
import { VIEW_CELLS } from "./viewport";

export const DEBUG_PANEL_INTERVAL_MS = 250;

const ROWS = ["title", "play", "mesh", "light", "held", "draws"] as const;
type Row = (typeof ROWS)[number];

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

function reach(cells: number | null): string {
  return cells === null ? " · waiting" : ` · +${cells}c`;
}

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

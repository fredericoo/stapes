import { CELL_SIZE } from "../lib/types";
import {
  healthBarColor,
  healthBarFillBricks,
  healthBarFillHeightBricks,
  healthBarTrackBricks,
} from "./healthBar";
import { type LabelKind, type LabelPlacement, layoutLabels } from "./labelLayout";

export type WorldLabel = {
  id: string;
  kind: LabelKind;
  x: number;
  y: number;
  lines: { id: string; text: string }[];
  bar?: { fraction: number };
  progress?: { fraction: number };
  order?: number;
  color?: string;
};

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

const ANCHOR_CLEARANCE_EMS = 2.75;

const BAR_CLASS = "world-label__bar";
const HEALTH_BAR_CLASS = `${BAR_CLASS}--health`;
const PROGRESS_BAR_CLASS = `${BAR_CLASS}--progress`;

const BRICKS_PER_EM = 10;

function fillBar(element: HTMLDivElement, fraction: number, trackBricks: number) {
  const fill = fillTrack(element, HEALTH_BAR_CLASS, fraction, trackBricks);
  if (fill) fill.style.backgroundColor = healthBarColor(fraction);
}

function fillTrack(
  element: HTMLDivElement,
  trackClass: string,
  fraction: number,
  trackBricks: number,
): HTMLElement | null {
  const fill = element.querySelector<HTMLElement>(`.${trackClass} > div`);
  if (!fill) return null;
  fill.style.width = brickLength(healthBarFillBricks(fraction, trackBricks));
  return fill;
}

function shapeTrack(track: HTMLElement, trackBricks: number) {
  track.style.width = brickLength(trackBricks);
  track.style.height = brickLength(healthBarFillHeightBricks(trackBricks));
}

function brickLength(bricks: number): string {
  return `calc(var(--world-label-brick) * ${bricks})`;
}

export function stackingOrder(labels: readonly { id: string; order?: number }[]): string[] {
  return [...labels]
    .sort((a, b) => (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY))
    .map((label) => label.id);
}

type LabelEntry = {
  signature: string;
  element: HTMLDivElement;
  size: {
    width: number;
    height: number;
    lift: number;
    barWidth: number | undefined;
  } | null;
  shown: boolean;
  color: string | undefined;
};

function signatureOf(label: WorldLabel): string {
  const lines = label.lines.map((line) => `${line.id}\u0000${line.text}`).join("\u0001");
  const bar = label.bar ? "|bar" : "";
  const progress = label.progress ? "|progress" : "";
  return `${lines}${bar}${progress}`;
}

export class WorldLabelLayer {
  private readonly entries = new Map<string, LabelEntry>();
  private view: { width: number; height: number };
  private stacking = "";
  private trackBricks = 0;
  private brickPx: number | null = null;
  private readonly resize: ResizeObserver | null;
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

  private syncView() {
    this.view = {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    };
  }

  private sizeTracks(cssScale: number) {
    const bricks = healthBarTrackBricks(CELL_SIZE * cssScale, this.brick());
    if (bricks === this.trackBricks) return;
    this.trackBricks = bricks;

    for (const entry of this.entries.values()) {
      const tracks = entry.element.querySelectorAll<HTMLElement>(`.${BAR_CLASS}`);
      if (tracks.length === 0) continue;
      for (const track of tracks) shapeTrack(track, bricks);
      entry.size = null;
    }
  }

  private brick(): number {
    if (this.brickPx !== null) return this.brickPx;
    const fontSize = Number.parseFloat(getComputedStyle(this.container).fontSize) || 0;
    this.brickPx = fontSize / BRICKS_PER_EM;
    return this.brickPx;
  }

  private watchSize(): ResizeObserver | null {
    if (typeof ResizeObserver === "undefined") return null;
    const observer = new ResizeObserver(() => {
      this.brickPx = null;
      for (const entry of this.entries.values()) entry.size = null;
    });
    observer.observe(this.container);
    return observer;
  }

  set(labels: WorldLabel[], camera: { x: number; y: number }, cssScale: number) {
    this.syncView();
    this.sizeTracks(cssScale);

    const live = new Set<string>();
    const entries = labels.map((label) => {
      live.add(label.id);
      const entry = this.entry(label);
      if (label.bar) {
        fillBar(entry.element, label.bar.fraction, this.trackBricks);
      }
      if (label.progress) {
        const { fraction } = label.progress;
        fillTrack(entry.element, PROGRESS_BAR_CLASS, fraction, this.trackBricks);
      }
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

  private restack(labels: WorldLabel[]) {
    const order = stackingOrder(labels);
    const stacking = order.join("\n");
    if (stacking === this.stacking) return;
    this.stacking = stacking;
    for (const id of order) {
      const entry = this.entries.get(id);
      if (entry) this.container.appendChild(entry.element);
    }
  }

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
    entry.element.style.setProperty("--label-x", `${at.left}px`);
    entry.element.style.setProperty("--label-y", `${at.top}px`);
    if (at.barLeft !== undefined) {
      entry.element.style.setProperty("--bar-x", `${at.barLeft - at.left}px`);
    }
  }

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
      lift: kind === "name" ? 0 : Math.round(fontSize * ANCHOR_CLEARANCE_EMS),
      barWidth: element.querySelector<HTMLElement>(`.${BAR_CLASS}`)?.offsetWidth,
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

  private entry(label: WorldLabel): LabelEntry {
    const signature = signatureOf(label);
    const existing = this.entries.get(label.id);
    if (existing) {
      if (existing.signature !== signature) {
        this.fill(existing.element, label);
        existing.signature = signature;
        existing.size = null;
      }
      return existing;
    }

    const element = document.createElement("div");
    element.className = `world-label world-label--${label.kind}`;
    this.fill(element, label);
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

  private fill(element: HTMLDivElement, label: WorldLabel) {
    const rows: HTMLElement[] = [];
    if (label.progress) rows.push(this.track(PROGRESS_BAR_CLASS));
    for (const line of label.lines) {
      const row = document.createElement("div");
      row.textContent = line.text;
      rows.push(row);
    }
    if (label.bar) rows.push(this.track(HEALTH_BAR_CLASS));

    element.replaceChildren(...rows);
  }

  private track(kindClass: string): HTMLElement {
    const track = document.createElement("div");
    track.className = `${BAR_CLASS} ${kindClass}`;
    shapeTrack(track, this.trackBricks);
    track.appendChild(document.createElement("div"));
    return track;
  }

  dispose() {
    this.resize?.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.onFontsLoaded);
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

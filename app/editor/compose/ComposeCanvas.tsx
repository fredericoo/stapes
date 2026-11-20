import { useEffect, useRef, useState, type ReactNode } from "react";
import { baseCellWorldOrigin } from "../../lib/geometry";
import type { MapFile, TileDef, TilesetDef } from "../../lib/types";
import { WorldRenderer } from "../../render/WorldRenderer";

export type ComposeView = { cx: number; cy: number; zoom: number };

export type Projection = {
  readonly zoom: number;
  cellToScreen(x: number, y: number, z: number): { x: number; y: number };
  clientToCell(clientX: number, clientY: number, z: number): { x: number; y: number };
};

const NOON = 12 * 60;
const ZOOMS = [0.5, 1, 2, 3, 4, 6, 8];

/** A press that moves less than this many pixels is a click, which picks, rather than a pan. */
const CLICK_SLOP = 4;

/** How far a pinch has to go before it steps to the next zoom: wheel units for a trackpad, a ratio for fingers. */
const PINCH_WHEEL_STEP = 40;
const PINCH_RATIO_STEP = 1.25;

const LINE_PX = 16;

/**
 * The view's top-left in world pixels, snapped to a whole art pixel, or to two
 * at half zoom. With the camera between art pixels every tile edge lands on
 * a fraction of a screen pixel and the renderer leaves hairline slits between
 * tiles; snapped, each art pixel is a whole number of screen pixels.
 */
function cameraOf(view: ComposeView, width: number, height: number) {
  const step = Math.max(1, 1 / view.zoom);
  const snap = (v: number) => Math.round(v / step) * step;
  return {
    left: snap(view.cx - width / view.zoom / 2),
    top: snap(view.cy - height / view.zoom / 2),
  };
}

function projection(
  view: ComposeView,
  width: number,
  height: number,
  host: () => DOMRect | undefined,
): Projection {
  const { left, top } = cameraOf(view, width, height);
  return {
    zoom: view.zoom,
    cellToScreen(x, y, z) {
      const o = baseCellWorldOrigin(x, y, z, 0);
      return { x: (o.x - left) * view.zoom, y: (o.y - top) * view.zoom };
    },
    /** Inverts `cellToScreen` through the origin of cell 0,0 on level `z`, so the level's oblique shift is undone. */
    clientToCell(clientX, clientY, z) {
      const rect = host();
      const zero = baseCellWorldOrigin(0, 0, z, 0);
      const one = baseCellWorldOrigin(1, 1, z, 0);
      const wx = (clientX - (rect?.left ?? 0)) / view.zoom + left;
      const wy = (clientY - (rect?.top ?? 0)) / view.zoom + top;
      return {
        x: Math.floor((wx - zero.x) / (one.x - zero.x)),
        y: Math.floor((wy - zero.y) / (one.y - zero.y)),
      };
    },
  };
}

/** The view one zoom step in or out, keeping the world point under `at` (offset from the middle of the view) where it is. */
function zoomedBy(view: ComposeView, steps: number, at: { x: number; y: number }): ComposeView {
  const index = ZOOMS.indexOf(view.zoom);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + steps))]!;
  if (next === view.zoom) return view;
  return {
    cx: view.cx + at.x / view.zoom - at.x / next,
    cy: view.cy + at.y / view.zoom - at.y / next,
    zoom: next,
  };
}

/**
 * The play renderer drawing a built map, with no game behind it, and a layer
 * of DOM above it for whatever the page draws in cells. Dragging or
 * scrolling pans, and a pinch steps through `ZOOMS`; the overlay gets every
 * pointer event first, so a handle in it stops a pan by stopping propagation.
 */
export function ComposeCanvas({
  map,
  tilesById,
  tilesets,
  view,
  onViewChange,
  lighting,
  overlay,
  onPick,
}: {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  view: ComposeView;
  onViewChange: (view: ComposeView) => void;
  lighting: boolean;
  overlay?: (projection: Projection) => ReactNode;
  onPick?: (cell: { x: number; y: number }) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new WorldRenderer(canvas);
    rendererRef.current = renderer;
    renderer.start();
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setAssets(tilesets, tilesById);
  }, [tilesets, tilesById]);

  useEffect(() => {
    rendererRef.current?.setLightingEnabled(lighting);
  }, [lighting]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: host.clientWidth, height: host.clientHeight }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    rendererRef.current?.setView({
      map,
      tilesById,
      camera: (() => {
        const { left, top } = cameraOf(view, size.width, size.height);
        return { x: left, y: top };
      })(),
      zoom: view.zoom,
      minutesOfDay: NOON,
    });
  }, [map, tilesById, view, size]);

  const viewRef = useRef(view);
  viewRef.current = view;

  const fromMiddle = (clientX: number, clientY: number) => {
    const rect = hostRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pinched = 0;
    /**
     * A trackpad pinch reaches the page as a wheel event with ctrlKey set, as
     * does ctrl and a mouse wheel; anything else scrolls, and scrolling pans.
     */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const current = viewRef.current;
      if (e.ctrlKey) {
        pinched += e.deltaY;
        if (Math.abs(pinched) < PINCH_WHEEL_STEP) return;
        const steps = pinched < 0 ? 1 : -1;
        pinched = 0;
        onViewChange(zoomedBy(current, steps, fromMiddle(e.clientX, e.clientY)));
        return;
      }
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : 1;
      onViewChange({
        ...current,
        cx: current.cx + (e.deltaX * unit) / current.zoom,
        cy: current.cy + (e.deltaY * unit) / current.zoom,
      });
    };
    /** Safari sends a pinch as gesture events, with the scale since the gesture began. */
    let gestureFrom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureFrom = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const { scale, clientX, clientY } = e as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      const ratio = scale / gestureFrom;
      if (ratio < PINCH_RATIO_STEP && ratio > 1 / PINCH_RATIO_STEP) return;
      gestureFrom = scale;
      onViewChange(zoomedBy(viewRef.current, ratio > 1 ? 1 : -1, fromMiddle(clientX, clientY)));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("gesturestart", onGestureStart);
    host.addEventListener("gesturechange", onGestureChange);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("gesturestart", onGestureStart);
      host.removeEventListener("gesturechange", onGestureChange);
    };
  }, [onViewChange]);

  const proj = projection(view, size.width, size.height, () =>
    hostRef.current?.getBoundingClientRect(),
  );

  /**
   * One finger or the mouse drags the map, and a press that does not move
   * picks. Two fingers pinch: each time the distance between them changes by
   * `PINCH_RATIO_STEP` the view steps a zoom about their midpoint, and moving
   * both pans.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "pan"; x: number; y: number; view: ComposeView; moved: boolean }
    | { kind: "pinch"; distance: number; mid: { x: number; y: number } }
    | null
  >(null);

  const pinchOf = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) gesture.current = { kind: "pinch", ...pinchOf() };
    else if (pointers.current.size === 1) {
      gesture.current = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        view: viewRef.current,
        moved: false,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g?.kind === "pan") {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > CLICK_SLOP) g.moved = true;
      if (!g.moved) return;
      onViewChange({
        ...g.view,
        cx: g.view.cx - (e.clientX - g.x) / g.view.zoom,
        cy: g.view.cy - (e.clientY - g.y) / g.view.zoom,
      });
    } else if (g?.kind === "pinch" && pointers.current.size === 2) {
      const now = pinchOf();
      let next = viewRef.current;
      next = {
        ...next,
        cx: next.cx - (now.mid.x - g.mid.x) / next.zoom,
        cy: next.cy - (now.mid.y - g.mid.y) / next.zoom,
      };
      const ratio = now.distance / g.distance;
      if (ratio >= PINCH_RATIO_STEP || ratio <= 1 / PINCH_RATIO_STEP) {
        next = zoomedBy(next, ratio > 1 ? 1 : -1, fromMiddle(now.mid.x, now.mid.y));
        g.distance = now.distance;
      }
      g.mid = now.mid;
      onViewChange(next);
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === "pan" && !g.moved && e.type === "pointerup") {
      onPick?.(proj.clientToCell(e.clientX, e.clientY, 0));
    }
    gesture.current = null;
  };

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-ink active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="absolute inset-0">{overlay?.(proj)}</div>
      <div
        className="absolute right-2 bottom-2 flex items-center border-2 border-ink bg-paper text-sm shadow-hard"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Zoom out"
          className="px-2 py-0.5 hover:bg-panel"
          onClick={() => onViewChange(zoomedBy(view, -1, { x: 0, y: 0 }))}
        >
          −
        </button>
        <span className="w-10 border-x-2 border-ink text-center tabular-nums">{view.zoom}×</span>
        <button
          type="button"
          aria-label="Zoom in"
          className="px-2 py-0.5 hover:bg-panel"
          onClick={() => onViewChange(zoomedBy(view, 1, { x: 0, y: 0 }))}
        >
          +
        </button>
      </div>
    </div>
  );
}

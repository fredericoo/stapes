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

function projection(
  view: ComposeView,
  width: number,
  height: number,
  host: () => DOMRect | undefined,
): Projection {
  const left = view.cx - width / view.zoom / 2;
  const top = view.cy - height / view.zoom / 2;
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

/**
 * The play renderer drawing a built map, with no game behind it, and a layer
 * of DOM above it for whatever the page draws in cells. Dragging the empty
 * map pans and the wheel steps through `ZOOMS`; the overlay gets every pointer
 * event first, so a handle in it stops a pan by stopping propagation.
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
      camera: {
        x: view.cx - size.width / view.zoom / 2,
        y: view.cy - size.height / view.zoom / 2,
      },
      zoom: view.zoom,
      minutesOfDay: NOON,
    });
  }, [map, tilesById, view, size]);

  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const current = viewRef.current;
      const at = ZOOMS.indexOf(current.zoom);
      const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + (e.deltaY < 0 ? 1 : -1)))]!;
      if (next === current.zoom) return;
      const rect = host.getBoundingClientRect();
      const dx = e.clientX - rect.left - rect.width / 2;
      const dy = e.clientY - rect.top - rect.height / 2;
      onViewChange({
        cx: current.cx + dx / current.zoom - dx / next,
        cy: current.cy + dy / current.zoom - dy / next,
        zoom: next,
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [onViewChange]);

  const proj = projection(view, size.width, size.height, () =>
    hostRef.current?.getBoundingClientRect(),
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const start = { x: e.clientX, y: e.clientY, view: viewRef.current };
    let moved = false;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      if (Math.hypot(m.clientX - start.x, m.clientY - start.y) > CLICK_SLOP) moved = true;
      if (!moved) return;
      onViewChange({
        ...start.view,
        cx: start.view.cx - (m.clientX - start.x) / start.view.zoom,
        cy: start.view.cy - (m.clientY - start.y) / start.view.zoom,
      });
    };
    const up = (u: PointerEvent) => {
      if (!moved && u.type === "pointerup") onPick?.(proj.clientToCell(u.clientX, u.clientY, 0));
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-ink active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="absolute inset-0">{overlay?.(proj)}</div>
    </div>
  );
}

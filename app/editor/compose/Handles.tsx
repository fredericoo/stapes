import type { PointerEvent as ReactPointerEvent } from "react";
import type { Bounds } from "../generator";
import type { Projection } from "./ComposeCanvas";

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

const EDGES: Exclude<Edge, "move">[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const HANDLE_PX = 10;

/**
 * Follows one pointer from press to release in cells on level `z`, reporting
 * how far it has moved since the press, at most once a frame: the pointer can
 * cross several cells between frames, and only the last needs a rebuild. The handle keeps the pointer, so a
 * drag that leaves the box still drags it, and the press never reaches the
 * canvas underneath, which would pan.
 */
function dragCells(
  e: ReactPointerEvent<HTMLElement>,
  projection: Projection,
  z: number,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const start = projection.clientToCell(e.clientX, e.clientY, z);
  let last = { dx: 0, dy: 0 };
  let frame = 0;
  const flush = () => {
    frame = 0;
    onMove(last.dx, last.dy);
  };
  const move = (m: PointerEvent) => {
    const at = projection.clientToCell(m.clientX, m.clientY, z);
    const next = { dx: at.x - start.x, dy: at.y - start.y };
    if (next.dx === last.dx && next.dy === last.dy) return;
    last = next;
    frame ||= requestAnimationFrame(flush);
  };
  const up = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function dragged(from: Bounds, edge: Edge, dx: number, dy: number): Bounds {
  if (edge === "move") {
    return {
      minX: from.minX + dx,
      maxX: from.maxX + dx,
      minY: from.minY + dy,
      maxY: from.maxY + dy,
    };
  }
  const next = { ...from };
  if (edge.includes("w")) next.minX = Math.min(from.minX + dx, from.maxX);
  if (edge.includes("e")) next.maxX = Math.max(from.maxX + dx, from.minX);
  if (edge.includes("n")) next.minY = Math.min(from.minY + dy, from.maxY);
  if (edge.includes("s")) next.maxY = Math.max(from.maxY + dy, from.minY);
  return next;
}

const CURSOR: Record<Edge, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  move: "move",
};

export function FrameHandles({
  bounds,
  z,
  projection,
  onBounds,
  onEnd,
}: {
  bounds: Bounds;
  z: number;
  projection: Projection;
  onBounds: (bounds: Bounds) => void;
  onEnd: () => void;
}) {
  const a = projection.cellToScreen(bounds.minX, bounds.minY, z);
  const b = projection.cellToScreen(bounds.maxX + 1, bounds.maxY + 1, z);
  const press = (edge: Edge) => (e: ReactPointerEvent<HTMLElement>) =>
    dragCells(e, projection, z, (dx, dy) => onBounds(dragged(bounds, edge, dx, dy)), onEnd);
  const at = (edge: Exclude<Edge, "move">) => ({
    left: edge.includes("w") ? 0 : edge.includes("e") ? "100%" : "50%",
    top: edge.includes("n") ? 0 : edge.includes("s") ? "100%" : "50%",
  });
  return (
    <div
      className="absolute border-2 border-look shadow-[0_0_0_1px_var(--color-ink)]"
      style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y, cursor: CURSOR.move }}
      onPointerDown={press("move")}
    >
      <span className="pointer-events-none absolute -top-6 left-0 bg-ink px-1 text-xs text-paper tabular-nums">
        {bounds.maxX - bounds.minX + 1}×{bounds.maxY - bounds.minY + 1}
      </span>
      {EDGES.map((edge) => (
        <span
          key={edge}
          aria-hidden="true"
          className="absolute border-2 border-ink bg-look"
          style={{
            ...at(edge),
            width: HANDLE_PX,
            height: HANDLE_PX,
            transform: "translate(-50%, -50%)",
            cursor: CURSOR[edge],
          }}
          onPointerDown={press(edge)}
        />
      ))}
    </div>
  );
}

export function PointHandle({
  cell,
  z,
  label,
  title,
  projection,
  onCell,
  onEnd,
  onRemove,
}: {
  cell: { x: number; y: number };
  z: number;
  label: string;
  title?: string;
  projection: Projection;
  onCell: (cell: { x: number; y: number }) => void;
  onEnd: () => void;
  onRemove?: () => void;
}) {
  const a = projection.cellToScreen(cell.x, cell.y, z);
  const b = projection.cellToScreen(cell.x + 1, cell.y + 1, z);
  const size = Math.max(HANDLE_PX + 4, b.x - a.x);
  return (
    <span
      title={title ?? label}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRemove?.();
      }}
      className="absolute flex items-center justify-center rounded-full border-2 border-ink bg-interact text-[10px] font-bold text-ink"
      style={{
        left: (a.x + b.x) / 2,
        top: (a.y + b.y) / 2,
        width: size,
        height: size,
        transform: "translate(-50%, -50%)",
        cursor: "grab",
      }}
      onPointerDown={(e) =>
        dragCells(e, projection, z, (dx, dy) => onCell({ x: cell.x + dx, y: cell.y + dy }), onEnd)
      }
    >
      {label.slice(0, 1)}
    </span>
  );
}

/** A "+" between two points of a route; pressing it adds a via point there, which can then be dragged. */
export function InsertHandle({
  cell,
  z,
  projection,
  onInsert,
}: {
  cell: { x: number; y: number };
  z: number;
  projection: Projection;
  onInsert: (cell: { x: number; y: number }) => void;
}) {
  const a = projection.cellToScreen(cell.x, cell.y, z);
  const b = projection.cellToScreen(cell.x + 1, cell.y + 1, z);
  return (
    <button
      type="button"
      aria-label="Add a point here"
      title="Add a point here"
      className="absolute flex items-center justify-center rounded-full border-2 border-ink bg-paper text-[10px] leading-none font-bold text-ink opacity-70 hover:opacity-100"
      style={{
        left: (a.x + b.x) / 2,
        top: (a.y + b.y) / 2,
        width: HANDLE_PX + 2,
        height: HANDLE_PX + 2,
        transform: "translate(-50%, -50%)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onInsert(cell);
      }}
    >
      +
    </button>
  );
}

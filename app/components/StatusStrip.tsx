import { useEffect, useRef, useState } from "react";
import type { ActiveStatus } from "../lib/status";
import type { TilesetDef } from "../lib/types";
import { Tooltip } from "../ui";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { SpritePreview } from "./TilePreview";

export const STATUS_ICON_SIZE_PX = TITLE_SPRITE_SIZE_PX;

export const STATUS_CELL_SIZE_PX = 24;

export const STATUS_ICON_GAP_PX = 4;

export const STATUS_BAR_HEIGHT_PX = 3;

const STATUS_BAR_GAP_PX = 1;

export function statusStripCapacity(availablePx: number): number {
  if (availablePx <= 0) return 0;
  const stride = STATUS_CELL_SIZE_PX + STATUS_ICON_GAP_PX;
  return Math.max(0, Math.floor((availablePx + STATUS_ICON_GAP_PX) / stride));
}

export function compareStatuses(a: ActiveStatus, b: ActiveStatus): number {
  if (a.tone !== b.tone) return a.tone === "bad" ? -1 : 1;
  return b.remainingMs - a.remainingMs;
}

export function splitForCapacity(
  statuses: ActiveStatus[],
  capacity: number,
): { shown: ActiveStatus[]; overflow: number } {
  if (capacity <= 0) return { shown: [], overflow: 0 };
  if (statuses.length <= capacity) return { shown: statuses, overflow: 0 };
  const shown = statuses.slice(0, capacity - 1);
  return { shown, overflow: statuses.length - shown.length };
}

export function statusFraction(status: ActiveStatus): number {
  if (!(status.fullDurationMs > 0)) return 0;
  return Math.max(0, Math.min(1, status.remainingMs / status.fullDurationMs));
}

export function StatusStrip({
  statuses,
  interactive,
  tilesets,
  className = "",
}: {
  statuses: ActiveStatus[];
  interactive: boolean;
  tilesets: TilesetDef[];
  className?: string;
}) {
  const laneRef = useRef<HTMLUListElement>(null);
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const observer = new ResizeObserver(() => setWidthPx(lane.clientWidth));
    observer.observe(lane);
    setWidthPx(lane.clientWidth);
    return () => observer.disconnect();
  }, []);

  const ordered = [...statuses].sort(compareStatuses);
  const { shown, overflow } = splitForCapacity(ordered, statusStripCapacity(widthPx));

  return (
    <ul
      ref={laneRef}
      aria-label="Effects"
      className={["flex w-full shrink-0 items-center gap-1 overflow-hidden", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        height: STATUS_CELL_SIZE_PX,
        ...(interactive ? null : { pointerEvents: "none" as const }),
      }}
    >
      {shown.map((status) => (
        <StatusCell key={status.defId} status={status} tooltip={interactive}>
          <SpritePreview sprite={status.icon} tilesets={tilesets} size={STATUS_ICON_SIZE_PX} />
          <StatusBar status={status} />
        </StatusCell>
      ))}
      {overflow > 0 ? (
        <li
          role="img"
          aria-label={`${overflow} more`}
          className="grid shrink-0 place-items-center text-[10px] font-bold tabular-nums text-paper/60"
          style={{ width: STATUS_CELL_SIZE_PX, height: STATUS_CELL_SIZE_PX }}
        >
          +{overflow}
        </li>
      ) : null}
    </ul>
  );
}

function StatusCell({
  status,
  tooltip,
  children,
}: {
  status: ActiveStatus;
  tooltip: boolean;
  children: React.ReactNode;
}) {
  const cell = (
    <li
      role="img"
      aria-label={`${status.name}. ${status.description}`}
      className="flex shrink-0 flex-col items-center justify-center"
      style={{
        width: STATUS_CELL_SIZE_PX,
        height: STATUS_CELL_SIZE_PX,
        gap: STATUS_BAR_GAP_PX,
      }}
    >
      {children}
    </li>
  );

  if (!tooltip) return cell;

  return (
    <Tooltip
      content={
        <span className="flex flex-col">
          <span className="font-bold">{status.name}</span>
          <span>{status.description}</span>
        </span>
      }
      side="bottom"
    >
      {cell}
    </Tooltip>
  );
}

function StatusBar({ status }: { status: ActiveStatus }) {
  const fraction = statusFraction(status);
  const filled = fraction > 0 ? Math.max(1, Math.round(fraction * STATUS_CELL_SIZE_PX)) : 0;

  return (
    <span
      aria-hidden="true"
      className="block shrink-0 bg-paper/20"
      style={{ width: STATUS_CELL_SIZE_PX, height: STATUS_BAR_HEIGHT_PX }}
    >
      <span
        className={`block h-full ${status.tone === "bad" ? "bg-danger" : "bg-paper/70"}`}
        style={{ width: filled }}
      />
    </span>
  );
}

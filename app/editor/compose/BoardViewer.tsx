import { IconArrowDown, IconArrowUp, IconStackBackward } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "../../components/AppShell";
import { LightingToggle } from "../../components/LightingToggle";
import { fetchBoardChunks } from "../../lib/api";
import { BoardChunks, chunksInView, type BoardOutline, type CameraRect } from "../../lib/boardView";
import { formatClock, MINUTES_PER_DAY } from "../../lib/clock";
import { baseCellWorldOrigin, levelScreenOffset } from "../../lib/geometry";
import {
  CHUNK_SIZE,
  CELL_SIZE,
  parseCoordKey,
  type TileDef,
  type TilesetDef,
} from "../../lib/types";
import { Button, Toggle, Tooltip } from "../../ui";
import { ComposeCanvas, type ComposeView } from "./ComposeCanvas";

const CHUNKS_PER_READ = 64;

/**
 * About four screens of chunks at the widest zoom. Past this the ones read
 * longest ago are dropped, so a long pan does not end with the island in the tab.
 */
const MAX_HELD_CHUNKS = 2400;

const NOON = 12 * 60;

type LinkedCell = { x: number; y: number; z: number };

/** A cell named in the address as `?x=…&y=…&level=…`, so a link can open the viewer on a place. */
function linkedCell(search: string): LinkedCell | null {
  const params = new URLSearchParams(search);
  const x = Number(params.get("x"));
  const y = Number(params.get("y"));
  const z = Number(params.get("level") ?? 0);
  if (!params.has("x") || !params.has("y")) return null;
  return [x, y, z].every(Number.isInteger) ? { x, y, z } : null;
}

/** Centred on a linked cell, or on where new players start, or on the middle of the board's chunks when it has no spawn. */
function startingView({ chunks, spawn }: BoardOutline, linked: LinkedCell | null): ComposeView {
  const cell = linked ?? spawn;
  if (cell) {
    const at = baseCellWorldOrigin(cell.x + 0.5, cell.y + 0.5, linked?.z ?? 0, 0);
    return { cx: at.x, cy: at.y, zoom: 1 };
  }
  if (chunks.length === 0) return { cx: 0, cy: 0, zoom: 1 };
  const at = chunks.map(parseCoordKey);
  const middle = (values: number[]) =>
    ((Math.min(...values) + Math.max(...values) + 1) / 2) * CHUNK_SIZE * CELL_SIZE;
  return { cx: middle(at.map((c) => c.x)), cy: middle(at.map((c) => c.y)), zoom: 1 };
}

/**
 * The world as a deployed server holds it, read a few chunks at a time round
 * the view: nothing is built in the tab, so the page opens at once whatever
 * the size of the world. It reads the board's last checkpoint, so it shows
 * what players walk, creatures and dropped things included.
 */
export function BoardViewer({
  outline,
  tilesById,
  tilesets,
}: {
  outline: BoardOutline;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
}) {
  const board = useMemo(() => new BoardChunks(outline.chunks), [outline]);
  const lowest = Math.min(0, ...outline.levels);
  const highest = Math.max(0, ...outline.levels);
  const [linked] = useState(() => linkedCell(window.location.search));
  const [view, setView] = useState(() => startingView(outline, linked));
  const [level, setLevel] = useState(linked?.z ?? 0);
  const [isolated, setIsolated] = useState(false);
  const [lighting, setLighting] = useState(false);
  const [minutesOfDay, setMinutesOfDay] = useState(NOON);
  const [camera, setCamera] = useState<CameraRect | null>(null);
  const [readCount, setReadCount] = useState(0);
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const topLevel = isolated ? level : Number.POSITIVE_INFINITY;

  const wanted = useMemo(
    () => (camera ? chunksInView(camera, level, outline.levels, topLevel) : []),
    [camera, level, outline.levels, topLevel],
  );
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const pumping = useRef(false);

  /**
   * One read at a time, always of the missing chunks nearest the middle of
   * the view as it is now, so a pan that outruns the reads skips what it left.
   */
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    setReading(true);
    try {
      for (;;) {
        const next = board.missing(wantedRef.current).slice(0, CHUNKS_PER_READ);
        if (next.length === 0) break;
        board.add(next, await fetchBoardChunks(next));
        board.trim(wantedRef.current, MAX_HELD_CHUNKS);
        setReadCount((n) => n + 1);
      }
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      pumping.current = false;
      setReading(false);
    }
  }, [board]);

  useEffect(() => {
    void pump();
  }, [wanted, pump]);

  const map = useMemo(() => board.map(topLevel), [board, readCount, topLevel]);

  const goTo = useCallback(
    (next: number) => {
      const to = Math.max(lowest, Math.min(highest, next));
      const shift = levelScreenOffset(to - level);
      setView((v) => ({ ...v, cx: v.cx + shift.x, cy: v.cy + shift.y }));
      setLevel(to);
    },
    [level, lowest, highest],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.target as HTMLElement | null)?.closest(
          "input:not([type=range]), textarea, [contenteditable]",
        )
      )
        return;
      if (e.key === "[") goTo(level - 1);
      else if (e.key === "]") goTo(level + 1);
      else if (e.key === "i") setIsolated((v) => !v);
      else if (e.key === "l") setLighting((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, level]);

  return (
    <AdminShell
      trailing={
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Tooltip content="Level down ([)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level down"
                disabled={level <= lowest}
                onClick={() => goTo(level - 1)}
              >
                <IconArrowDown size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
            <span aria-label="Level" className="w-8 text-center text-sm tabular-nums text-paper">
              {level}
            </span>
            <Tooltip content="Level up (])">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level up"
                disabled={level >= highest}
                onClick={() => goTo(level + 1)}
              >
                <IconArrowUp size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
          <Tooltip content="Isolate this level (I): leave out every level above it">
            <Toggle pressed={isolated} onPressedChange={setIsolated} ariaLabel="Isolate this level">
              <IconStackBackward size={16} stroke={2} aria-hidden="true" />
            </Toggle>
          </Tooltip>
          <LightingToggle enabled={lighting} onChange={setLighting} shortcut="L" />
          <div className={["flex items-center gap-2", lighting ? "" : "opacity-50"].join(" ")}>
            <input
              type="range"
              min={0}
              max={MINUTES_PER_DAY - 1}
              step={1}
              value={minutesOfDay}
              disabled={!lighting}
              onChange={(e) => setMinutesOfDay(Number(e.target.value))}
              aria-label="Time of day"
              aria-valuetext={formatClock(minutesOfDay)}
              className="hard-slider w-28"
            />
            <span className="w-12 text-xs tabular-nums text-paper">
              {formatClock(minutesOfDay)}
            </span>
          </div>
          <Tooltip content="This world plays the tree it was deployed with. To change its map, edit data/world.json in a checkout and deploy it.">
            <span className="text-xs text-paper/70">View only</span>
          </Tooltip>
        </div>
      }
    >
      <div className="h-full min-h-0">
        <ComposeCanvas
          map={map}
          tilesById={tilesById}
          tilesets={tilesets}
          view={view}
          onViewChange={setView}
          lighting={lighting}
          minutesOfDay={minutesOfDay}
          level={level}
          onCamera={setCamera}
          tool="pan"
          overlay={() => (
            <p className="pointer-events-none absolute bottom-2 left-2 bg-ink/80 px-2 py-1 text-xs tabular-nums text-paper">
              {failure
                ? `Could not read the board: ${failure}`
                : `${board.size} of ${outline.chunks.length} chunks read${reading ? " · reading…" : ""}`}
            </p>
          )}
        />
      </div>
    </AdminShell>
  );
}

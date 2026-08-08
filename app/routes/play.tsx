import { useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/play";
import { AppShell } from "../components/AppShell";
import { GameSession } from "../game/GameSession";
import {
  DEFAULT_PLAY_MINUTES,
  formatClock,
  MINUTES_PER_DAY,
  type MinutesOfDay,
} from "../lib/clock";
import type { Direction } from "../lib/types";
import { dataStore } from "../lib/storage.server";
import { GameRenderer } from "../render/GameRenderer";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import type { FrameStats } from "../render/frameProfile";

export async function loader({ context }: Route.LoaderArgs) {
  const store = dataStore(context);
  const [map, tiles, tilesets] = await Promise.all([
    store.readMap(),
    store.readTiles(),
    store.readTilesets(),
  ]);
  return { map, tiles, tilesets };
}

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowUp: "n",
  ArrowDown: "s",
  ArrowLeft: "w",
  ArrowRight: "e",
  KeyW: "n",
  KeyS: "s",
  KeyA: "w",
  KeyD: "e",
};

export default function PlayPage() {
  const { map, tiles, tilesets } = useLoaderData<typeof loader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(
    DEFAULT_PLAY_MINUTES,
  );
  const [clockPaused, setClockPaused] = useState(false);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const minutesRef = useRef(minutesOfDay);
  minutesRef.current = minutesOfDay;
  const pausedRef = useRef(clockPaused);
  pausedRef.current = clockPaused;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let session: GameSession;
    try {
      session = new GameSession(map, tiles);
    } catch (err) {
      console.error(err);
      return;
    }

    const renderer = new GameRenderer(canvas, session, tilesets, tiles);
    renderer.setMinutesOfDay(minutesRef.current);
    renderer.setClockPaused(pausedRef.current);
    renderer.setOnClock(setMinutesOfDay);
    renderer.setOnStats(setStats);
    rendererRef.current = renderer;
    renderer.start();

    const held: Direction[] = [];
    let faceOnly = false;
    let preferDescend = false;

    const syncInput = () => {
      session.setInput({
        directions: [...held],
        faceOnly,
        preferDescend,
      });
    };

    const syncModifiers = (e: KeyboardEvent) => {
      faceOnly = e.shiftKey;
      preferDescend = e.altKey;
      syncInput();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      syncModifiers(e);
      const dir = KEY_TO_DIR[e.code];
      if (!dir) return;
      e.preventDefault();
      if (e.repeat) return;
      const idx = held.indexOf(dir);
      if (idx >= 0) held.splice(idx, 1);
      held.push(dir);
      syncInput();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      syncModifiers(e);
      const dir = KEY_TO_DIR[e.code];
      if (dir) {
        e.preventDefault();
        const idx = held.indexOf(dir);
        if (idx >= 0) held.splice(idx, 1);
      }
      syncInput();
    };

    const onBlur = () => {
      held.length = 0;
      faceOnly = false;
      preferDescend = false;
      syncInput();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      rendererRef.current = null;
      renderer.dispose();
      setStats(null);
    };
  }, [map, tiles, tilesets]);

  useEffect(() => {
    rendererRef.current?.setClockPaused(clockPaused);
  }, [clockPaused]);

  const scrubTime = (m: MinutesOfDay) => {
    setMinutesOfDay(m);
    rendererRef.current?.setMinutesOfDay(m);
  };

  return (
    <AppShell
      trailing={
        <>
          <FrameStatsReadout stats={stats} />
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-paper/70">Time</span>
            <input
              type="range"
              min={0}
              max={MINUTES_PER_DAY - 1}
              step={1}
              value={Math.floor(minutesOfDay)}
              onChange={(e) => scrubTime(Number(e.target.value))}
              aria-label="Time of day"
              aria-valuetext={formatClock(minutesOfDay)}
              className="hard-slider w-36"
            />
            <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
              {formatClock(minutesOfDay)}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-paper">
              <input
                type="checkbox"
                checked={clockPaused}
                onChange={(e) => setClockPaused(e.target.checked)}
                className="hard-checkbox"
              />
              Pause
            </label>
          </div>
        </>
      }
    >
      <div className="relative h-full w-full bg-ink">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none"
          style={{ imageRendering: "pixelated" }}
        />
        <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-paper/70">
          Arrows / WASD move · Shift face · Option descend · Click an adjacent
          object to push or switch it
        </div>
      </div>
    </AppShell>
  );
}

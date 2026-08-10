import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/play";
import { AppShell } from "../components/AppShell";
import { GameViewport } from "../components/GameViewport";
import { GameSession } from "../game/GameSession";
import { bindKeyboard, HeldDirections } from "../game/heldDirections";
import {
  DEFAULT_PLAY_MINUTES,
  formatClock,
  MINUTES_PER_DAY,
  type MinutesOfDay,
} from "../lib/clock";
import type { Direction } from "../lib/types";
import { dataStore } from "../context";
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

export default function PlayPage() {
  const { map, tiles, tilesets } = useLoaderData<typeof loader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const pressDirection = useCallback(
    (d: Direction) => inputRef.current?.press(d),
    [],
  );
  const releaseDirection = useCallback(
    (d: Direction) => inputRef.current?.release(d),
    [],
  );
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

    const input = new HeldDirections((i) => session.setInput(i));
    inputRef.current = input;
    const unbindKeyboard = bindKeyboard(input);

    return () => {
      unbindKeyboard();
      inputRef.current = null;
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
      <GameViewport
        canvasRef={canvasRef}
        onDirectionPress={pressDirection}
        onDirectionRelease={releaseDirection}
      />
    </AppShell>
  );
}

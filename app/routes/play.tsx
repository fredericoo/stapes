import { useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { AppShell } from "../components/AppShell";
import { GameSession } from "../game/GameSession";
import type { TimeOfDay } from "../lib/lighting";
import type { Direction } from "../lib/types";
import { readMap, readTiles, readTilesets } from "../lib/fs.server";
import { GameRenderer } from "../render/GameRenderer";
import { Segmented } from "../ui";

export async function loader() {
  const [map, tiles, tilesets] = await Promise.all([
    readMap(),
    readTiles(),
    readTilesets(),
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
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>("night");
  const [fps, setFps] = useState<number | null>(null);
  const timeOfDayRef = useRef(timeOfDay);
  timeOfDayRef.current = timeOfDay;

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
    renderer.setTimeOfDay(timeOfDayRef.current);
    renderer.setOnFps(setFps);
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
      setFps(null);
    };
  }, [map, tiles, tilesets]);

  useEffect(() => {
    rendererRef.current?.setTimeOfDay(timeOfDay);
  }, [timeOfDay]);

  return (
    <AppShell
      trailing={
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-paper/70">FPS</span>
            <span
              className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper"
              aria-live="polite"
              aria-label="Frames per second"
            >
              {fps ?? "—"}
            </span>
          </div>
          <Segmented<TimeOfDay>
            value={timeOfDay}
            onChange={setTimeOfDay}
            size="sm"
            ariaLabel="Time of day"
            options={[
              { value: "day", label: "Day" },
              { value: "dusk", label: "Dusk" },
              { value: "night", label: "Night" },
            ]}
          />
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

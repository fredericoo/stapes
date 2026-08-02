import { useEffect, useRef } from "react";
import { useLoaderData } from "react-router";
import { AppShell } from "../components/AppShell";
import { GameSession } from "../game/GameSession";
import type { Direction } from "../lib/types";
import { readMap, readTiles, readTilesets } from "../lib/fs.server";
import { GameRenderer } from "../render/GameRenderer";

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
    renderer.start();

    const held: Direction[] = [];

    const syncInput = () => {
      session.setInput({ directions: [...held] });
    };

    const onKeyDown = (e: KeyboardEvent) => {
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
      const dir = KEY_TO_DIR[e.code];
      if (!dir) return;
      e.preventDefault();
      const idx = held.indexOf(dir);
      if (idx >= 0) held.splice(idx, 1);
      syncInput();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.dispose();
    };
  }, [map, tiles, tilesets]);

  return (
    <AppShell>
      <div className="relative h-full w-full bg-ink">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none"
          style={{ imageRendering: "pixelated" }}
        />
        <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-paper/70">
          Arrows / WASD to move
        </div>
      </div>
    </AppShell>
  );
}

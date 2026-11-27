import { useEffect, useRef } from "react";
import { useLoaderData } from "react-router";
import "../../components/sceneDriver";
import { fetchBootstrap } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { baseCellWorldOrigin } from "../../lib/geometry";
import { buildScene } from "../../lib/scene";
import { CELL_SIZE } from "../../lib/types";
import { tilesByIdFromList } from "../../lib/validation";
import { wadingFor } from "../../render/wadeDepth";
import { WorldRenderer } from "../../render/WorldRenderer";

export async function clientLoader() {
  await requireAdmin();
  return await fetchBootstrap();
}

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 50;

/**
 * The real `WorldRenderer` with no game behind it: nothing moves, nothing
 * thinks, and the map is whatever `window.__scene.render` is handed. It is the
 * page `bun run scene` screenshots. The renderer is never started, so its
 * animation clock is the scene's `clockMs` and every render of a scene is the
 * same picture.
 */
export default function ScenePage() {
  const { tiles, tilesets } = useLoaderData<typeof clientLoader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tilesById = tilesByIdFromList(tiles);
    const world = new WorldRenderer(canvas);
    world.setAssets(tilesets, tilesById);

    window.__scene = {
      async render(scene, options) {
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const built = buildScene(scene, tilesById);
        const origin = baseCellWorldOrigin(built.look.x, built.look.y, built.look.z, 0);
        const spanX = canvas.clientWidth / built.zoom;
        const spanY = canvas.clientHeight / built.zoom;
        world.setLightingEnabled(built.lighting);
        const view = {
          map: built.map,
          tilesById,
          camera: {
            x: origin.x + CELL_SIZE / 2 - spanX / 2,
            y: origin.y + CELL_SIZE / 2 - spanY / 2,
          },
          zoom: built.zoom,
          minutesOfDay: built.minutesOfDay,
          weather: built.weather,
          weatherAreas: built.weatherAreas,
          viewerCell: built.look,
          viewerZ: built.look.z,
          wading: wadingFor(
            built.map,
            built.bodies.map((body) => ({
              ...body,
              id: `${body.x},${body.y},${body.z}:${body.stackIndex}`,
              walk: null,
              fall: null,
              walkProgress: 0,
            })),
            tilesById,
          ),
        };
        world.setView(view);
        world.snapWeather();

        const startedAt = performance.now();
        while (!world.isSettled()) {
          if (performance.now() - startedAt > timeoutMs) {
            throw new Error(`the scene's light had not baked after ${timeoutMs} ms`);
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          /**
           * `setView` builds queued chunks only within a time budget, and the game
           * calls it every frame; a scene calls it once, so a large scene has to
           * call it again until the queue is empty.
           */
          world.setView(view);
        }
        world.setAnimClock(built.clockMs);
        world.renderOnce();
      },
    };

    return () => {
      delete window.__scene;
      world.dispose();
    };
  }, [tiles, tilesets]);

  return <canvas ref={canvasRef} className="block h-screen w-screen" />;
}

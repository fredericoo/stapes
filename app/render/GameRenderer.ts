import {
  baseCellWorldOrigin,
  PX_PER_HEIGHT,
} from "../lib/geometry";
import type { GameSession, GameSnapshot } from "../game/GameSession";
import { sceneryStack } from "../game/movement";
import { getStack, stackHeight } from "../lib/mapData";
import type { MapFile, TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { WorldRenderer } from "./WorldRenderer";

const DEFAULT_ZOOM = 4;

/**
 * Client play loop: ticks GameSession, centers camera on the player, and
 * lerps the player sprite during walks / falls.
 */
export class GameRenderer {
  private world: WorldRenderer;
  private session: GameSession;
  private tilesById: Record<string, TileDef>;
  private disposed = false;
  private raf = 0;
  private lastTime = 0;
  private running = false;

  constructor(
    canvas: HTMLCanvasElement,
    session: GameSession,
    tilesets: TilesetDef[],
    tiles: TileDef[],
  ) {
    this.session = session;
    this.tilesById = tilesByIdFromList(tiles);
    this.world = new WorldRenderer(canvas);
    this.world.setAssets(tilesets, this.tilesById);
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = () => {
      if (!this.running || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - this.lastTime);
      this.lastTime = now;
      this.session.update(dt);
      this.pushView();
      this.world.tick(dt);
      this.world.renderOnce();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.world.dispose();
  }

  private pushView() {
    const snap = this.session.getSnapshot();
    const { canvasW, canvasH } = this.world.getCameraSize();
    const zoom = DEFAULT_ZOOM;
    const viewW = Math.max(1, canvasW / zoom);
    const viewH = Math.max(1, canvasH / zoom);

    const visual = this.playerVisualWorld(snap);
    const camera = {
      x: visual.x - viewW / 2,
      y: visual.y - viewH / 2,
    };

    let entityOffset:
      | {
          x: number;
          y: number;
          z: number;
          stackIndex: number;
          ox: number;
          oy: number;
        }
      | undefined;

    if (snap.walk) {
      const from = this.cellWorldCenter(
        snap.walk.from.x,
        snap.walk.from.y,
        snap.walk.from.z,
        snap.map,
        snap.player.stackIndex,
      );
      // Painter depth as if already on top of the destination stack.
      const destStackLen = getStack(
        snap.map,
        snap.walk.to.x,
        snap.walk.to.y,
        snap.walk.to.z,
      ).length;
      entityOffset = {
        x: snap.walk.from.x,
        y: snap.walk.from.y,
        z: snap.walk.from.z,
        stackIndex: snap.player.stackIndex,
        ox: visual.x - from.x,
        oy: visual.y - from.y,
        sortAt: {
          x: snap.walk.to.x,
          y: snap.walk.to.y,
          z: snap.walk.to.z,
          stackIndex: destStackLen,
        },
      };
    } else if (snap.fall) {
      const drop = snap.fallProgress * PX_PER_HEIGHT;
      entityOffset = {
        x: snap.player.x,
        y: snap.player.y,
        z: snap.player.z,
        stackIndex: snap.player.stackIndex,
        ox: drop,
        oy: drop,
      };
    }

    this.world.setView({
      map: snap.map,
      tilesById: this.tilesById,
      camera,
      zoom,
      timeOfDay: "day",
      entityOffset,
    });
  }

  private playerVisualWorld(snap: GameSnapshot): { x: number; y: number } {
    if (snap.walk) {
      const a = this.cellWorldCenter(
        snap.walk.from.x,
        snap.walk.from.y,
        snap.walk.from.z,
        snap.map,
        snap.player.stackIndex,
      );
      const b = this.surfaceWorldCenter(
        snap.walk.to.x,
        snap.walk.to.y,
        snap.walk.to.z,
        snap.map,
      );
      const t = snap.walkProgress;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      };
    }

    const base = this.cellWorldCenter(
      snap.player.x,
      snap.player.y,
      snap.player.z,
      snap.map,
      snap.player.stackIndex,
    );
    if (snap.fall) {
      const drop = snap.fallProgress * PX_PER_HEIGHT;
      return { x: base.x + drop, y: base.y + drop };
    }
    return base;
  }

  /** Standing surface center for a cell (scenery only — no player yet). */
  private surfaceWorldCenter(
    x: number,
    y: number,
    z: number,
    map: MapFile,
  ): { x: number; y: number } {
    const elev = stackHeight(getStack(map, x, y, z), this.tilesById);
    const origin = baseCellWorldOrigin(x, y, z, elev);
    return { x: origin.x + 4, y: origin.y + 4 };
  }

  private cellWorldCenter(
    x: number,
    y: number,
    z: number,
    map: MapFile,
    stackIndex: number,
  ): { x: number; y: number } {
    const elev = stackHeight(
      sceneryStack(map, x, y, z, stackIndex),
      this.tilesById,
    );
    const origin = baseCellWorldOrigin(x, y, z, elev);
    return { x: origin.x + 4, y: origin.y + 4 };
  }
}

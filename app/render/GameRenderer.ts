import {
  baseCellWorldOrigin,
  depthStackBias,
  PX_PER_HEIGHT,
} from "../lib/geometry";
import type { GameSession, GameSnapshot } from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { sceneryStack } from "../game/movement";
import type { EmitterOverride } from "../lib/lighting";
import { getStack, stackHeight } from "../lib/mapData";
import {
  levelsAboveShouldHide,
  viewAnchorFromSnapshot,
} from "../lib/levelVisibility";
import type { MapFile, TileDef, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { type TileMotion, WorldRenderer } from "./WorldRenderer";

const DEFAULT_ZOOM = 4;

/**
 * Client play loop: ticks GameSession, centers camera on the player, and
 * lerps moving tiles during walks / falls.
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

    const anchor = viewAnchorFromSnapshot(snap);
    const hideAbove = levelsAboveShouldHide(
      snap.map,
      this.tilesById,
      anchor,
    );

    this.world.setView({
      map: snap.map,
      tilesById: this.tilesById,
      camera,
      zoom,
      timeOfDay: "night",
      tileMotions: this.tileMotionsFor(snap, visual),
      emitterOverrides: this.emitterOverridesFor(snap),
      hideLevelsAbove: hideAbove ? anchor.z : undefined,
    });
  }

  /**
   * Cell-space fractional emit positions for lit tiles mid-walk/fall —
   * same progress as sprite LERP so cast light tracks the mover.
   */
  private emitterOverridesFor(
    snap: GameSnapshot,
  ): EmitterOverride[] | undefined {
    const light = this.tilesById[PLAYER_TILE_ID]?.light;
    if (!light || !(light.radius > 0) || !(light.intensity > 0)) {
      return undefined;
    }

    if (snap.walk) {
      const { from, to } = snap.walk;
      const t = snap.walkProgress;
      return [
        {
          x: from.x,
          y: from.y,
          z: from.z,
          fx: from.x + (to.x - from.x) * t,
          fy: from.y + (to.y - from.y) * t,
          fz: from.z + (to.z - from.z) * t,
        },
      ];
    }

    if (snap.fall) {
      const visualFeet = snap.fall.feetAbs - snap.fallProgress;
      return [
        {
          x: snap.player.x,
          y: snap.player.y,
          z: snap.player.z,
          fx: snap.player.x,
          fy: snap.player.y,
          fz: visualFeet / HEIGHT_PER_LEVEL,
        },
      ];
    }

    return undefined;
  }

  /**
   * Motions for tiles currently lerping. Same path for any moving tile — today
   * only the player walks/falls. The box travels with the sprite in fractional
   * cells, which is what lets a mover be behind the wall beside it and in front
   * of the floor it is stepping onto at the same time.
   */
  private tileMotionsFor(
    snap: GameSnapshot,
    visual: { x: number; y: number },
  ): TileMotion[] | undefined {
    if (snap.walk) {
      const { from, to } = snap.walk;
      const stackIndex = snap.player.stackIndex;
      const fromCenter = this.cellWorldCenter(
        from.x,
        from.y,
        from.z,
        snap.map,
        stackIndex,
      );
      const originFoot = this.standingFootAbs(snap.map, from, stackIndex);
      const destFoot = this.surfaceFootAbs(snap.map, to.x, to.y, to.z);
      const destStackLen = getStack(snap.map, to.x, to.y, to.z).length;
      const t = snap.walkProgress;
      const foot = originFoot + (destFoot - originFoot) * t;

      return [
        {
          x: from.x,
          y: from.y,
          z: from.z,
          stackIndex,
          ox: visual.x - fromCenter.x,
          oy: visual.y - fromCenter.y,
          // Descending: also draw under the destination level so roof-cut can
          // hide the origin group without the sprite vanishing mid-lerp.
          alsoDrawAtZ: to.z < from.z ? to.z : undefined,
          box: {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
            foot,
            top: foot + this.movingTileHeight(snap.map, from, stackIndex),
            // Feet share a plane with both floors it passes over; outrank the
            // top tile of whichever stack it is standing on.
            stackBias: Math.max(
              depthStackBias(from.z, stackIndex),
              depthStackBias(to.z, destStackLen),
            ),
          },
        },
      ];
    }

    if (snap.fall) {
      const drop = snap.fallProgress * PX_PER_HEIGHT;
      const { player } = snap;
      const foot = snap.fall.feetAbs - snap.fallProgress;
      const landingZ = viewAnchorFromSnapshot(snap).z;
      return [
        {
          x: player.x,
          y: player.y,
          z: player.z,
          stackIndex: player.stackIndex,
          ox: drop,
          oy: drop,
          alsoDrawAtZ: landingZ < player.z ? landingZ : undefined,
          box: {
            x: player.x,
            y: player.y,
            foot,
            top: foot + this.movingTileHeight(snap.map, player, player.stackIndex),
            stackBias: depthStackBias(player.z, player.stackIndex),
          },
        },
      ];
    }

    return undefined;
  }

  /** Height of the tile at a stack slot — the mover is not always the player. */
  private movingTileHeight(
    map: MapFile,
    cell: { x: number; y: number; z: number },
    stackIndex: number,
  ): number {
    const placed = getStack(map, cell.x, cell.y, cell.z)[stackIndex];
    if (!placed) return 0;
    return this.tilesById[placed.tileId]?.height ?? 0;
  }

  /** Absolute foot elevation of a tile standing at a stack slot. */
  private standingFootAbs(
    map: MapFile,
    cell: { x: number; y: number; z: number },
    stackIndex: number,
  ): number {
    const elev = stackHeight(
      sceneryStack(map, cell.x, cell.y, cell.z, stackIndex),
      this.tilesById,
    );
    return cell.z * HEIGHT_PER_LEVEL + elev;
  }

  /** Absolute elevation of a cell's standing surface (scenery only). */
  private surfaceFootAbs(
    map: MapFile,
    x: number,
    y: number,
    z: number,
  ): number {
    return (
      z * HEIGHT_PER_LEVEL + stackHeight(getStack(map, x, y, z), this.tilesById)
    );
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

  /** Standing surface center for a cell (scenery only — no mover yet). */
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

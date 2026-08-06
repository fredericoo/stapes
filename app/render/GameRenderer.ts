import {
  baseCellWorldOrigin,
  depthStackBias,
  PX_PER_HEIGHT,
  screenToCoord,
} from "../lib/geometry";
import type {
  GameSession,
  GameSnapshot,
  ObjectRef,
} from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { sceneryStack } from "../game/movement";
import type { EmitterOverride } from "../lib/lighting";
import { emitterCenter } from "../lib/lighting";
import { getStack, stackHeight } from "../lib/mapData";
import {
  levelsAboveShouldHide,
  viewAnchorFromSnapshot,
} from "../lib/levelVisibility";
import type { MapFile, TileDef, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { resolveLight } from "../lib/tileResolve";
import { interactionKinds } from "../lib/interactions";
import { tilesByIdFromList } from "../lib/validation";
import {
  type OverlaySpec,
  type TileMotion,
  WorldRenderer,
} from "./WorldRenderer";
import {
  type InteractiveIndex,
  indexInteractive,
  pickInteractiveAt,
} from "./pick";

const DEFAULT_ZOOM = 4;

/** Editor selection yellow — same affordance, same colour. */
const HOVER_COLOR = 0xffcc00;
/** Matches the editor's ghost stamps. */
const DRAG_GHOST_OPACITY = 0.55;

/**
 * Land a lerped sprite on the same whole-pixel grid the static world sits on.
 *
 * Scenery is placed at integer world pixels, so a mover at a fractional offset
 * reads as sliding *between* the pixels around it — the sprite's own texels
 * stop lining up with everything else. Snapping trades perfectly smooth motion
 * for motion that steps in whole pixels, which is what pixel art expects.
 */
function snapToWholePixels(p: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * Client play loop: ticks GameSession, centers camera on the player, and
 * lerps moving tiles during walks / falls.
 */
export class GameRenderer {
  private world: WorldRenderer;
  private session: GameSession;
  private canvas: HTMLCanvasElement;
  private tilesById: Record<string, TileDef>;
  private disposed = false;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  /** Interactive placements on the player's level, rebuilt when either changes. */
  private interactive: InteractiveIndex = [];
  private interactiveKey = "";
  private indexedMap: MapFile | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    session: GameSession,
    tilesets: TilesetDef[],
    tiles: TileDef[],
  ) {
    this.session = session;
    this.canvas = canvas;
    this.tilesById = tilesByIdFromList(tiles);
    this.world = new WorldRenderer(canvas);
    this.world.setAssets(tilesets, this.tilesById);
    this.attachPointer();
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
    this.detachPointer();
    this.world.dispose();
  }

  private attachPointer() {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
  }

  private detachPointer() {
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Cell under the pointer on `z`'s ground plane. */
  private pointerCell(
    e: PointerEvent,
    z: number,
    snap: GameSnapshot,
  ): { x: number; y: number } {
    const p = this.localPoint(e);
    const camera = this.cameraFor(snap);
    return screenToCoord(p.x, p.y, DEFAULT_ZOOM, camera.x, camera.y, z);
  }

  private onPointerMove = (e: PointerEvent) => {
    const snap = this.session.getSnapshot();

    if (snap.drag) {
      // Targets are addressed on the object's own plane: you drag it off a
      // ledge rather than aiming at the level below.
      this.session.setDragPointer(
        this.pointerCell(e, snap.drag.object.z, snap),
      );
      return;
    }

    this.session.setHoveredObject(this.pickAt(e, snap));
    this.applyCursor(this.session.getSnapshot());
  };

  /** Interactive object drawn under the pointer, if any. */
  private pickAt(e: PointerEvent, snap: GameSnapshot): ObjectRef | null {
    const p = this.localPoint(e);
    return pickInteractiveAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        assets: this.world.quadAssets(),
        camera: this.cameraFor(snap),
        zoom: DEFAULT_ZOOM,
      },
      this.interactiveIndex(snap),
      p.x,
      p.y,
    );
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const snap = this.session.getSnapshot();

    // Resolved here rather than read off the last hover: touch has no hover
    // at all, and a press that outruns its move event would otherwise miss.
    const target = this.pickAt(e, snap);
    if (!target) return;
    this.session.setHoveredObject(target);
    if (!this.session.beginDrag(target)) return;

    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.session.setDragPointer(this.pointerCell(e, target.z, snap));
    this.applyCursor(this.session.getSnapshot());
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.session.isDragging()) return;
    this.session.endDrag();
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    this.applyCursor(this.session.getSnapshot());
  };

  private onPointerCancel = () => {
    this.session.cancelDrag();
  };

  private onPointerLeave = () => {
    if (this.session.isDragging()) return;
    this.session.setHoveredObject(null);
  };

  /** Interactive placements on the player's level, cached per map + level. */
  private interactiveIndex(snap: GameSnapshot): InteractiveIndex {
    const key = `${snap.player.z}`;
    if (this.indexedMap === snap.map && this.interactiveKey === key) {
      return this.interactive;
    }
    this.indexedMap = snap.map;
    this.interactiveKey = key;
    this.interactive = indexInteractive(snap.map, snap.player.z, this.tilesById);
    return this.interactive;
  }

  /**
   * Chrome for the current frame: a silhouette around the object under the
   * pointer, plus — while dragging — a ghost of it standing where it would
   * land. No ghost is the "you cannot drop here" signal; nothing is drawn on
   * an illegal cell rather than marking it.
   */
  private overlaysFor(snap: GameSnapshot): OverlaySpec[] {
    const specs: OverlaySpec[] = [];

    const outlined = snap.drag?.object ?? snap.hover;
    if (outlined) {
      specs.push({ kind: "objectOutline", ...outlined, color: HOVER_COLOR });
    }

    const target = snap.drag?.target;
    if (snap.drag && target) {
      specs.push({
        kind: "ghost",
        object: snap.drag.object,
        to: target,
        opacity: DRAG_GHOST_OPACITY,
      });
    }

    return specs;
  }

  /**
   * Grab affordance, updated from the pointer rather than the render loop.
   *
   * Only shown when a drag would actually start — an out-of-reach object still
   * outlines, but promising a grab the player cannot make is worse than saying
   * nothing. Reserved for objects whose *only* interaction is drag; once a tile
   * offers several, the pointer no longer stands for one of them.
   */
  private applyCursor(snap: GameSnapshot) {
    if (snap.drag) {
      this.setCursor("grabbing");
      return;
    }
    const hover = snap.hover;
    const grabbable =
      hover != null &&
      this.session.canGrab(hover) &&
      this.onlyInteractionIsDrag(hover, snap);
    this.setCursor(grabbable ? "grab" : "");
  }

  private setCursor(cursor: string) {
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  private onlyInteractionIsDrag(ref: ObjectRef, snap: GameSnapshot): boolean {
    const placed = getStack(snap.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    if (!def) return false;
    const kinds = interactionKinds(def);
    return kinds.length === 1 && kinds[0] === "drag";
  }

  /**
   * Top-left of the view in world pixels. Derived on demand rather than cached
   * from the last frame so pointer picking inverts the projection the player
   * is looking at, even between frames or before the first one.
   */
  private cameraFor(snap: GameSnapshot): { x: number; y: number } {
    const { canvasW, canvasH } = this.world.getCameraSize();
    const visual = this.playerVisualWorld(snap);
    return {
      x: visual.x - Math.max(1, canvasW / DEFAULT_ZOOM) / 2,
      y: visual.y - Math.max(1, canvasH / DEFAULT_ZOOM) / 2,
    };
  }

  private pushView() {
    const snap = this.session.getSnapshot();
    const zoom = DEFAULT_ZOOM;
    const visual = this.playerVisualWorld(snap);
    const camera = this.cameraFor(snap);

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
      timeOfDay: "day",
      tileMotions: this.tileMotionsFor(snap, visual),
      emitterOverrides: this.emitterOverridesFor(snap),
      hideLevelsAbove: hideAbove ? anchor.z : undefined,
    });

    this.world.setOverlays(this.overlaysFor(snap));
  }

  /**
   * Cell-space fractional emit positions for the player light.
   * Always returned when the player emits light — standing uses the tile
   * centre so the static bake can omit the player and never re-run on each step.
   */
  private emitterOverridesFor(
    snap: GameSnapshot,
  ): EmitterOverride[] | undefined {
    const playerDef = this.tilesById[PLAYER_TILE_ID];
    const light = playerDef
      ? resolveLight(playerDef, { direction: snap.player.direction })
      : undefined;
    if (!light) {
      return undefined;
    }

    const playerH = playerDef?.height ?? 0;

    if (snap.walk) {
      const { from, to } = snap.walk;
      const t = snap.walkProgress;
      const a = emitterCenter(
        from.x,
        from.y,
        from.z,
        getStack(snap.map, from.x, from.y, from.z),
        snap.player.stackIndex,
        this.tilesById,
      );
      // Destination stack does not hold the player yet — centre above its surface.
      const destAbs = this.surfaceFootAbs(snap.map, to.x, to.y, to.z);
      const b = {
        fx: to.x + 0.5,
        fy: to.y + 0.5,
        fz: (destAbs + playerH / 2) / HEIGHT_PER_LEVEL,
      };
      return [
        {
          x: from.x,
          y: from.y,
          z: from.z,
          fx: a.fx + (b.fx - a.fx) * t,
          fy: a.fy + (b.fy - a.fy) * t,
          fz: a.fz + (b.fz - a.fz) * t,
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
          fx: snap.player.x + 0.5,
          fy: snap.player.y + 0.5,
          fz: (visualFeet + playerH / 2) / HEIGHT_PER_LEVEL,
        },
      ];
    }

    const { x, y, z, stackIndex } = snap.player;
    const center = emitterCenter(
      x,
      y,
      z,
      getStack(snap.map, x, y, z),
      stackIndex,
      this.tilesById,
    );
    return [{ x, y, z, fx: center.fx, fy: center.fy, fz: center.fz }];
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
    const motions: TileMotion[] = [];
    const slide = this.slideMotion(snap);
    if (slide) motions.push(slide);

    const player = this.playerMotion(snap, visual);
    if (player) motions.push(player);

    return motions.length > 0 ? motions : undefined;
  }

  /** Motion for the player's own walk / fall lerp, if either is running. */
  private playerMotion(
    snap: GameSnapshot,
    visual: { x: number; y: number },
  ): TileMotion | null {
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

      return {
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
      };
    }

    if (snap.fall) {
      const drop = snap.fallProgress * PX_PER_HEIGHT;
      const { player } = snap;
      const foot = snap.fall.feetAbs - snap.fallProgress;
      const landingZ = viewAnchorFromSnapshot(snap).z;
      return {
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
      };
    }

    return null;
  }

  /**
   * Motion for a dragged object travelling to where it was dropped. Same lerp
   * the player walks with, so the object slides between cells and sorts against
   * its neighbours rather than jumping.
   */
  private slideMotion(snap: GameSnapshot): TileMotion | null {
    const slide = snap.slide;
    if (!slide) return null;

    const { object, from, to } = slide;
    const t = slide.progress;
    const fromCenter = this.cellWorldCenter(
      from.x,
      from.y,
      from.z,
      snap.map,
      object.stackIndex,
    );
    const toCenter = this.surfaceWorldCenter(to.x, to.y, to.z, snap.map);
    const visual = snapToWholePixels({
      x: fromCenter.x + (toCenter.x - fromCenter.x) * t,
      y: fromCenter.y + (toCenter.y - fromCenter.y) * t,
    });

    const originFoot = this.standingFootAbs(snap.map, from, object.stackIndex);
    const destFoot = this.surfaceFootAbs(snap.map, to.x, to.y, to.z);
    const foot = originFoot + (destFoot - originFoot) * t;
    const destStackLen = getStack(snap.map, to.x, to.y, to.z).length;

    return {
      x: object.x,
      y: object.y,
      z: object.z,
      stackIndex: object.stackIndex,
      ox: visual.x - fromCenter.x,
      oy: visual.y - fromCenter.y,
      alsoDrawAtZ: to.z < from.z ? to.z : undefined,
      box: {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        foot,
        top: foot + this.movingTileHeight(snap.map, from, object.stackIndex),
        stackBias: Math.max(
          depthStackBias(from.z, object.stackIndex),
          depthStackBias(to.z, destStackLen),
        ),
      },
    };
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
      return snapToWholePixels({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
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
      return snapToWholePixels({ x: base.x + drop, y: base.y + drop });
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

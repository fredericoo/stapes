import {
  baseCellWorldOrigin,
  depthStackBias,
  elevationScreenOffset,
  PX_PER_HEIGHT,
} from "../lib/geometry";
import type {
  ActorSnapshot,
  GameSnapshot,
  ObjectRef,
  PlaySession,
} from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { displayNameFor } from "../game/displayName";
import type { NameLabel } from "./nameLabels";
import { FrameProfiler, type FrameStats } from "./frameProfile";
import { fallDropPx, fallFootAbs, standingFootAbs } from "./fallAnchor";
import { sceneryStack } from "../game/movement";
import type { EmitterOverride } from "../lib/lighting";
import {
  DEFAULT_PLAY_MINUTES,
  clockAfter,
  wrapMinutes,
  type MinutesOfDay,
} from "../lib/clock";
import { emitterCenter } from "../lib/lighting";
import { getStack, stackHeight } from "../lib/mapData";
import {
  levelsAboveShouldHide,
  viewAnchorFor,
} from "../lib/levelVisibility";
import type { MapFile, TileDef, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { resolveLight } from "../lib/tileResolve";
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
import { fitViewport, VIEW_PX, type ViewportFit } from "./viewport";

/**
 * How the fixed square view maps onto this canvas right now.
 *
 * Read from the element rather than cached across frames: the pane changes with
 * the window, the on-screen controls appearing, and a phone rotating, and a
 * stale scale puts the pointer somewhere the player is not looking.
 */
function currentFit(canvas: HTMLCanvasElement): ViewportFit {
  // Square by layout, so either side answers; the smaller one keeps a
  // mis-sized pane showing the whole view rather than cropping it.
  return fitViewport(Math.min(canvas.clientWidth, canvas.clientHeight));
}

/** Editor selection yellow — same affordance, same colour. */
const HOVER_COLOR = 0xffcc00;

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
 * Client play loop: ticks a session, centers the camera on the viewer's own
 * actor, and lerps every moving actor during walks / falls.
 *
 * Typed against {@link PlaySession} rather than GameSession so the same
 * renderer can be driven by a local simulation or by a remote one fed over the
 * wire — the two differ in where the truth comes from, not in what is drawn.
 */
export class GameRenderer {
  private world: WorldRenderer;
  private session: PlaySession;
  private canvas: HTMLCanvasElement;
  private tilesById: Record<string, TileDef>;
  private minutesOfDay: number = DEFAULT_PLAY_MINUTES;
  /**
   * Last known reading of the clock and the frame time it was taken at. The
   * clock is derived from this pair every frame rather than advanced by each
   * frame's delta — see {@link clockAfter}.
   */
  private clockAnchorMinutes: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private clockAnchorAtMs = 0;
  private clockPaused = false;
  private onClock: ((minutes: MinutesOfDay) => void) | null = null;
  private onStats: ((stats: FrameStats) => void) | null = null;
  private profiler = new FrameProfiler();
  private disposed = false;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  /** Interactive placements on the viewer's level ±1, rebuilt when either changes. */
  private interactive: InteractiveIndex = [];
  private interactiveKey = "";
  private indexedMap: MapFile | null = null;
  private showNames = false;

  constructor(
    canvas: HTMLCanvasElement,
    session: PlaySession,
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

  /**
   * Set the clock. Online this is the server's reading, taken on `hello`; the
   * local rate carries it from there, so one anchor keeps every client in step
   * for as long as the tab is open.
   */
  setMinutesOfDay(m: MinutesOfDay) {
    this.minutesOfDay = wrapMinutes(m);
    this.reanchorClock(this.minutesOfDay);
    this.onClock?.(Math.floor(this.minutesOfDay));
  }

  setClockPaused(paused: boolean) {
    if (paused === this.clockPaused) return;
    // Pausing freezes the hand where it is; resuming runs on from there. Both
    // are the same move: re-anchor to what the clock reads right now.
    this.reanchorClock(this.clockNow(performance.now()));
    this.clockPaused = paused;
  }

  private reanchorClock(minutes: MinutesOfDay) {
    this.clockAnchorMinutes = minutes;
    this.clockAnchorAtMs = performance.now();
  }

  private clockNow(nowMs: number): MinutesOfDay {
    if (this.clockPaused) return this.clockAnchorMinutes;
    return clockAfter(this.clockAnchorMinutes, nowMs - this.clockAnchorAtMs);
  }

  setOnClock(cb: ((minutes: MinutesOfDay) => void) | null) {
    this.onClock = cb;
  }

  /**
   * Per-frame timings, roughly twice a second. Reports the worst frame in each
   * window as well as the median — a hitch on the frame a step commits is
   * invisible in an average but is the whole of what a player feels.
   */
  setOnStats(cb: ((stats: FrameStats) => void) | null) {
    this.onStats = cb;
    this.world.setProfiler(cb ? this.profiler : null);
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    // Time only passes while the loop runs, so the anchor starts here rather
    // than at construction — otherwise the first frame jumps the clock forward
    // by however long the page had been open.
    this.reanchorClock(this.minutesOfDay);
    const loop = () => {
      if (!this.running || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - this.lastTime);
      this.lastTime = now;
      const prev = Math.floor(this.minutesOfDay);
      this.minutesOfDay = this.clockNow(now);
      const next = Math.floor(this.minutesOfDay);
      if (next !== prev) this.onClock?.(next);
      const frameStart = performance.now();
      this.profiler.measure("sim", () => this.session.update(dt));
      // `view` nests the sync/map/light/motion phases recorded inside setView,
      // so it is their total rather than a separate slice.
      this.profiler.measure("view", () => this.pushView());
      this.profiler.measure("anim", () => this.world.tick(dt));
      // CPU cost of submitting the frame. GPU time lands after this returns and
      // is not counted — a low `draw` does not by itself mean the GPU is idle.
      this.profiler.measure("draw", () => this.world.renderOnce());
      this.profiler.frame(performance.now() - frameStart);

      const stats = this.profiler.report(now);
      if (stats) this.onStats?.(stats);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.disposed = true;
    this.onStats = null;
    this.world.setProfiler(null);
    this.onClock = null;
    this.stop();
    this.detachPointer();
    this.world.dispose();
  }

  private attachPointer() {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
  }

  private detachPointer() {
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerMove = (e: PointerEvent) => {
    this.session.setHoveredObject(this.pickAt(e, this.session.getSnapshot()));
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
        // CSS scale, not the render scale: the pointer arrives in the
        // element's own coordinates, and the buffer is stretched over it.
        zoom: currentFit(this.canvas).cssScale,
      },
      this.interactiveIndex(snap),
      p.x,
      p.y,
      (ref) => this.session.canInteract(ref),
    );
  }

  /**
   * One button for everything: a tap on an object runs whatever it offers.
   * The alternative — a modifier or a second button per interaction — is the
   * thing that made this unlearnable, and touch has neither.
   */
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;

    // Resolved here rather than read off the last hover: touch has no hover
    // at all, and a press that outruns its move event would otherwise miss.
    const target = this.pickAt(e, this.session.getSnapshot());
    if (!target) return;

    e.preventDefault();
    this.session.setHoveredObject(target);
    this.session.interact(target);
  };

  private onPointerLeave = () => {
    this.session.setHoveredObject(null);
  };

  /** Interactive placements on the viewer's level ±1, cached per map + level. */
  private interactiveIndex(snap: GameSnapshot): InteractiveIndex {
    const key = `${snap.self.z}`;
    if (this.indexedMap === snap.map && this.interactiveKey === key) {
      return this.interactive;
    }
    this.indexedMap = snap.map;
    this.interactiveKey = key;
    this.interactive = indexInteractive(
      snap.map,
      snap.self.z,
      this.tilesById,
      1,
    );
    return this.interactive;
  }

  /**
   * Chrome for the current frame: a silhouette around the object under the
   * pointer. The session only reports a hover the player can actually act on,
   * so the outline *is* the affordance — an object that will not budge simply
   * never lights up, and no second cue is needed to explain why.
   */
  private overlaysFor(snap: GameSnapshot): OverlaySpec[] {
    if (!snap.hover) return [];
    return [{ kind: "objectOutline", ...snap.hover, color: HOVER_COLOR }];
  }

  /**
   * A name over every actor's head, the viewer's own included.
   *
   * Off by default: alone in the single-player map there is nobody to tell
   * apart, and a label over the only character on screen is noise. The online
   * route turns it on.
   */
  setShowNames(show: boolean) {
    this.showNames = show;
  }

  /**
   * Anchored on the top of the head rather than on the cell.
   *
   * Height moves a tile up-*left* in this projection, 4px per unit, so a label
   * placed straight above the feet would drift off the shoulder of anything
   * tall. Taking the actor's own visual position and applying the same
   * elevation shift its sprite gets puts the name over the head of a two-unit
   * player and a ten-unit one alike — and, because that position already
   * carries the walk lerp and the fall drop, the name travels with the sprite
   * instead of chasing it.
   */
  private labelsFor(snap: GameSnapshot): NameLabel[] {
    if (!this.showNames) return [];

    const labels: NameLabel[] = [];
    for (const actor of snap.actors) {
      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.movingTileHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      labels.push({
        id: actor.id,
        text: displayNameFor(actor.id),
        x: visual.x + head.x,
        y: visual.y + head.y,
      });
    }
    return labels;
  }

  /** Same signal as the outline, for the pointer. */
  private applyCursor(snap: GameSnapshot) {
    this.setCursor(snap.hover ? "pointer" : "");
  }

  private setCursor(cursor: string) {
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  /**
   * Top-left of the view in world pixels. Derived on demand rather than cached
   * from the last frame so pointer picking inverts the projection the player
   * is looking at, even between frames or before the first one.
   *
   * The span is {@link VIEW_PX} whatever the canvas measures, so this no longer
   * asks the element how much world to show — that is the fixed view.
   */
  private cameraFor(snap: GameSnapshot): { x: number; y: number } {
    const visual = this.actorVisualWorld(snap.map, snap.self);
    const half = VIEW_PX / 2;
    return { x: visual.x - half, y: visual.y - half };
  }

  private pushView() {
    const snap = this.session.getSnapshot();
    const fit = currentFit(this.canvas);
    // The buffer is a whole multiple of the view, so the world lands on a clean
    // pixel grid and the element's stretch does the fitting.
    this.world.setBufferSize(fit.bufferPx);
    const zoom = fit.renderScale;
    const camera = this.cameraFor(snap);

    const anchor = viewAnchorFor(snap.self);
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
      minutesOfDay: this.minutesOfDay,
      tileMotions: this.tileMotionsFor(snap),
      emitterOverrides: this.emitterOverridesFor(snap),
      hideLevelsAbove: hideAbove ? anchor.z : undefined,
    });

    this.world.setOverlays(this.overlaysFor(snap));
    this.world.setLabels(this.labelsFor(snap));
    // Driven by the frame, not the pointer: walking away from an object
    // revokes the affordance without the pointer having moved at all.
    this.applyCursor(snap);
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
    if (!playerDef) return undefined;

    // One override per actor, in the snapshot's stable id order — the override
    // list is joined into a cache key downstream, so a wobbling order would
    // miss the cache every frame. Emitting only the viewer's own would leave
    // every other actor's light omitted from the bake and never painted back,
    // which is exactly the "goes dark" failure the bake omission warns about.
    const overrides: EmitterOverride[] = [];
    for (const actor of snap.actors) {
      const light = resolveLight(playerDef, { direction: actor.direction });
      if (!light) continue;
      overrides.push(this.actorEmitter(snap.map, actor, playerDef.height ?? 0));
    }
    return overrides.length > 0 ? overrides : undefined;
  }

  /**
   * Cell-space fractional emit position for one actor's light. Standing uses
   * the tile centre so the static bake can omit actors and never re-run on a
   * step.
   */
  private actorEmitter(
    map: MapFile,
    actor: ActorSnapshot,
    actorHeight: number,
  ): EmitterOverride {
    if (actor.walk) {
      const { from, to } = actor.walk;
      const t = actor.walkProgress;
      const a = emitterCenter(
        from.x,
        from.y,
        from.z,
        getStack(map, from.x, from.y, from.z),
        actor.stackIndex,
        this.tilesById,
      );
      // Destination stack does not hold the actor yet — centre above its surface.
      const destAbs = this.surfaceFootAbs(map, to.x, to.y, to.z);
      const b = {
        fx: to.x + 0.5,
        fy: to.y + 0.5,
        fz: (destAbs + actorHeight / 2) / HEIGHT_PER_LEVEL,
      };
      return {
        x: from.x,
        y: from.y,
        z: from.z,
        fx: a.fx + (b.fx - a.fx) * t,
        fy: a.fy + (b.fy - a.fy) * t,
        fz: a.fz + (b.fz - a.fz) * t,
      };
    }

    if (actor.fall) {
      const visualFeet = actor.fall.feetAbs - actor.fallProgress;
      return {
        x: actor.x,
        y: actor.y,
        z: actor.z,
        fx: actor.x + 0.5,
        fy: actor.y + 0.5,
        fz: (visualFeet + actorHeight / 2) / HEIGHT_PER_LEVEL,
      };
    }

    const { x, y, z, stackIndex } = actor;
    const center = emitterCenter(
      x,
      y,
      z,
      getStack(map, x, y, z),
      stackIndex,
      this.tilesById,
    );
    return { x, y, z, fx: center.fx, fy: center.fy, fz: center.fz };
  }

  /**
   * Motions for tiles currently lerping. Same path for any moving tile — today
   * only the player walks/falls. The box travels with the sprite in fractional
   * cells, which is what lets a mover be behind the wall beside it and in front
   * of the floor it is stepping onto at the same time.
   */
  private tileMotionsFor(snap: GameSnapshot): TileMotion[] | undefined {
    const motions: TileMotion[] = [];
    // Every actor, not just the viewer: a shove by someone across the room has
    // to animate here too, or their crate teleports.
    for (const actor of snap.actors) {
      const slide = this.slideMotion(snap.map, actor);
      if (slide) motions.push(slide);

      const own = this.actorMotion(snap.map, actor);
      if (own) motions.push(own);
    }

    return motions.length > 0 ? motions : undefined;
  }

  /** Motion for one actor's walk / fall lerp, if either is running. */
  private actorMotion(
    map: MapFile,
    actor: ActorSnapshot,
  ): TileMotion | null {
    if (actor.walk) {
      const { from, to } = actor.walk;
      const stackIndex = actor.stackIndex;
      const visual = this.actorVisualWorld(map, actor);
      const fromCenter = this.cellWorldCenter(
        from.x,
        from.y,
        from.z,
        map,
        stackIndex,
      );
      const originFoot = this.standingFootAbs(map, from, stackIndex);
      const destFoot = this.surfaceFootAbs(map, to.x, to.y, to.z);
      const destStackLen = getStack(map, to.x, to.y, to.z).length;
      const t = actor.walkProgress;
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
          top: foot + this.movingTileHeight(map, from, stackIndex),
          // Feet share a plane with both floors it passes over; outrank the
          // top tile of whichever stack it is standing on.
          stackBias: Math.max(
            depthStackBias(from.z, stackIndex),
            depthStackBias(to.z, destStackLen),
          ),
        },
      };
    }

    if (actor.fall) {
      const drop = fallDropPx(map, this.tilesById, actor);
      const foot = fallFootAbs(actor);
      const landingZ = viewAnchorFor(actor).z;
      return {
        x: actor.x,
        y: actor.y,
        z: actor.z,
        stackIndex: actor.stackIndex,
        ox: drop,
        oy: drop,
        alsoDrawAtZ: landingZ < actor.z ? landingZ : undefined,
        box: {
          x: actor.x,
          y: actor.y,
          foot,
          top: foot + this.movingTileHeight(map, actor, actor.stackIndex),
          stackBias: depthStackBias(actor.z, actor.stackIndex),
        },
      };
    }

    return null;
  }

  /**
   * Motion for a pushed object still catching up to the cell it was shoved
   * into. The push is already committed, so this is anchored at the object's
   * real slot and drags it *back* towards the cell it left — the offset decays
   * to zero rather than building up to the move. Same lerp the player walks
   * with, so the object sorts against its neighbours rather than jumping.
   */
  private slideMotion(map: MapFile, actor: ActorSnapshot): TileMotion | null {
    const slide = actor.slide;
    if (!slide) return null;

    const { object, from } = slide;
    const t = slide.progress;
    // The object has left `from`, so its old surface is that stack's top now;
    // at `object` it is in the stack, so its surface is the scenery under it.
    const fromCenter = this.surfaceWorldCenter(from.x, from.y, from.z, map);
    const toCenter = this.cellWorldCenter(
      object.x,
      object.y,
      object.z,
      map,
      object.stackIndex,
    );
    const visual = snapToWholePixels({
      x: fromCenter.x + (toCenter.x - fromCenter.x) * t,
      y: fromCenter.y + (toCenter.y - fromCenter.y) * t,
    });

    const originFoot = this.surfaceFootAbs(map, from.x, from.y, from.z);
    const destFoot = this.standingFootAbs(map, object, object.stackIndex);
    const foot = originFoot + (destFoot - originFoot) * t;
    const originStackLen = getStack(map, from.x, from.y, from.z).length;

    return {
      x: object.x,
      y: object.y,
      z: object.z,
      stackIndex: object.stackIndex,
      ox: visual.x - toCenter.x,
      oy: visual.y - toCenter.y,
      alsoDrawAtZ: from.z < object.z ? from.z : undefined,
      box: {
        x: from.x + (object.x - from.x) * t,
        y: from.y + (object.y - from.y) * t,
        foot,
        top: foot + this.movingTileHeight(map, object, object.stackIndex),
        stackBias: Math.max(
          depthStackBias(from.z, originStackLen),
          depthStackBias(object.z, object.stackIndex),
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
    return standingFootAbs(map, this.tilesById, cell, stackIndex);
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

  /**
   * Where an actor's sprite actually is this frame, in world pixels.
   *
   * Per actor rather than per frame: the camera wants this for the viewer's own
   * actor, and every moving actor wants it for their own lerp. Computing it
   * once for the camera and reusing it as everyone's offset — which is what the
   * single-player version did — silently pins every other actor to the viewer.
   */
  private actorVisualWorld(
    map: MapFile,
    actor: ActorSnapshot,
  ): { x: number; y: number } {
    if (actor.walk) {
      const a = this.cellWorldCenter(
        actor.walk.from.x,
        actor.walk.from.y,
        actor.walk.from.z,
        map,
        actor.stackIndex,
      );
      const b = this.surfaceWorldCenter(
        actor.walk.to.x,
        actor.walk.to.y,
        actor.walk.to.z,
        map,
      );
      const t = actor.walkProgress;
      return snapToWholePixels({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }

    const base = this.cellWorldCenter(
      actor.x,
      actor.y,
      actor.z,
      map,
      actor.stackIndex,
    );
    if (actor.fall) {
      const drop = fallDropPx(map, this.tilesById, actor);
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

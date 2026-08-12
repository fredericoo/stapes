import {
  baseCellWorldOrigin,
  depthStackBias,
  elevationScreenOffset,
  PX_PER_HEIGHT,
} from "../lib/geometry";
import type {
  ActorSnapshot,
  ChatBubble,
  GameSnapshot,
  ObjectRef,
  PlaySession,
} from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { displayNameFor, speakerNameFor } from "../game/displayName";
import { WorldLabelLayer, type WorldLabel } from "./textLabels";
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
import type { MapFile, PlacedTile, TileDef, TilesetDef } from "../lib/types";
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
  indexBattlers,
  indexInteractive,
  pickInteractiveAt,
  pickTileAt,
  probeSpanFor,
} from "./pick";
import { DamageNumberLayer, type DamageNumberView } from "./damageNumbers";
import { HEALTH_BAR_LIFT_PX, healthFraction } from "./healthBar";
import { fitViewport, VIEW_PX, type ViewportFit } from "./viewport";

/** Do two references point at the same slot in the same cell? */
function sameRef(a: ObjectRef | null, b: ObjectRef | null): boolean {
  if (!a || !b) return false;
  return (
    a.x === b.x && a.y === b.y && a.z === b.z && a.stackIndex === b.stackIndex
  );
}

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

/** A battler under the pointer: something that *could* be fought. */
const TARGET_HOVER_COLOR = 0xffffff;

/** The one you have actually picked. Red for the rest of the fight. */
const TARGET_COLOR = 0xff3b30;

/** Floors either side of the viewer whose damage numbers are worth drawing. */
const DAMAGE_LEVEL_SLACK = 1;

/**
 * Looking is blue, acting is yellow. Never both at once: two outlines in two
 * colours on one object asks the player to decode a legend, so entering look
 * mode takes the interaction hover off the screen entirely.
 */
const LOOK_COLOR = 0x3fa9ff;

/** Floors above and below the viewer that a look can reach, as the pick does. */
const LOOK_LEVEL_SLACK = 1;

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
  /** Battler placements on the viewer's level ±1, cached the same way. */
  private battlers: InteractiveIndex = [];
  private battlerKey = "";
  private battlerMap: MapFile | null = null;
  /**
   * The battler under the pointer, outlined in white.
   *
   * Held rather than recomputed per frame for the same reason the look pick is,
   * and refreshed on the same terms — see {@link repickTargetHover}.
   */
  private targetHover: ObjectRef | null = null;
  private targetHoverKey = "";
  private targetHoverMap: MapFile | null = null;
  private damageLayer: DamageNumberLayer | null = null;
  private showNames = false;
  /** @see setLookMode */
  private lookMode = false;
  private lookedAt: ObjectRef | null = null;
  /**
   * Where the pointer was last seen, in canvas pixels.
   *
   * Held so entering look mode can pick immediately. Shift is a key, not a
   * pointer event, so without this nothing lights up until the mouse next
   * twitches — on a still hand that reads as the mode being broken.
   */
  private lastPointer: { x: number; y: number } | null = null;
  /** Camera and map the held look pick was taken against. @see repickLook */
  private lookPickKey = "";
  private lookPickMap: MapFile | null = null;
  /** How far a sprite can reach past its own cell; see {@link probeSpanFor}. */
  private readonly probeSpan: number;
  /** @see setLightingEnabled */
  private lightingEnabled = true;
  private labelLayer: WorldLabelLayer | null = null;
  /**
   * World-pixel anchor per live message, read once and held.
   *
   * The freeze is the point: a remark belongs to the moment it was made, so it
   * must not ride later edits to the cell it was made in. See
   * {@link speechAnchor}.
   */
  private readonly speechAnchors = new Map<string, { x: number; y: number }>();

  constructor(
    canvas: HTMLCanvasElement,
    session: PlaySession,
    tilesets: TilesetDef[],
    tiles: TileDef[],
    /**
     * Where in-world text is drawn. An element over the canvas rather than
     * anything inside it — see `./textLabels` for why the text left the scene.
     * Optional so a caller that never asks for names need not supply one.
     */
    labelContainer?: HTMLElement | null,
  ) {
    this.session = session;
    this.canvas = canvas;
    this.tilesById = tilesByIdFromList(tiles);
    this.probeSpan = probeSpanFor(this.tilesById);
    this.world = new WorldRenderer(canvas);
    this.world.setAssets(tilesets, this.tilesById);
    if (labelContainer) {
      this.labelLayer = new WorldLabelLayer(labelContainer);
      this.damageLayer = new DamageNumberLayer(labelContainer);
    }
    this.attachPointer();
    this.attachKeys();
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
    this.detachKeys();
    this.labelLayer?.dispose();
    this.labelLayer = null;
    this.damageLayer?.dispose();
    this.damageLayer = null;
    this.world.dispose();
  }

  /**
   * Escape drops the target.
   *
   * On the window rather than the canvas, because a canvas cannot hold focus in
   * any way a player would recognise: they click a creature, move the mouse, and
   * press escape — and by then the pointer may be anywhere. Deliberately the
   * only key this class listens for; movement belongs to whoever owns the page.
   */
  private attachKeys() {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.onKeyDown);
  }

  private detachKeys() {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Nothing to call off, so nothing to swallow: a chat field or a dialog
    // listening for the same key must still get it.
    if (this.session.getSnapshot().targetId === null) return;
    this.session.setTarget(null);
  };

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
    this.lastPointer = this.localPoint(e);
    const snap = this.session.getSnapshot();
    if (this.lookMode) {
      this.lookedAt = this.lookAt(this.lastPointer, snap);
      return;
    }
    this.targetHover = this.battlerAt(this.lastPointer, snap);
    // A battler under the pointer takes the hover outright: only the player tile
    // is both fightable and shovable, and asking somebody to distinguish two
    // outlines on one body to find out which the click will do is worse than
    // simply not being able to push people.
    this.session.setHoveredObject(
      this.targetHover ? null : this.pickAt(e, snap),
    );
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

    const snap = this.session.getSnapshot();

    // Looking and acting cannot share a tap: a finger has no hover, so on touch
    // the mode *is* the distinction. A tap on a door while looking reads it and
    // leaves it shut.
    if (this.lookMode) {
      e.preventDefault();
      this.lastPointer = this.localPoint(e);
      this.lookedAt = this.lookAt(this.lastPointer, snap);
      return;
    }

    // Resolved here rather than read off the last hover: touch has no hover
    // at all, and a press that outruns its move event would otherwise miss.
    const point = this.localPoint(e);
    const battler = this.battlerAt(point, snap);
    if (battler) {
      e.preventDefault();
      this.targetHover = battler;
      const id = this.actorIdAt(battler, snap);
      // A cell that holds a battler tile with nobody driving it is not somebody
      // you can fight — it is scenery with hit points authored on it, which is
      // legal and simply not a target.
      if (id) this.session.setTarget(id);
      return;
    }

    const target = this.pickAt(e, snap);
    if (!target) return;

    e.preventDefault();
    this.session.setHoveredObject(target);
    this.session.interact(target);
  };

  private onPointerLeave = () => {
    this.lastPointer = null;
    this.lookedAt = null;
    // Only the *hover* goes. A target is a commitment held until it is called
    // off, killed, or walks out of view — moving the mouse away is none of
    // those, and dropping it here would make a fight unwinnable one-handed.
    this.targetHover = null;
    this.session.setHoveredObject(null);
  };

  /**
   * The battler drawn under a canvas-relative point, if any.
   *
   * Never the viewer's own body. It is a battler like everything else and the
   * index has no way to know otherwise, but the camera is centred on it — so the
   * pointer sits on top of it constantly, and an outline that lights up whenever
   * the mouse crosses the middle of the screen is noise around something the
   * session refuses to target anyway.
   */
  private battlerAt(
    point: { x: number; y: number },
    snap: GameSnapshot,
  ): ObjectRef | null {
    const found = pickInteractiveAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        assets: this.world.quadAssets(),
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas).cssScale,
      },
      this.battlerIndex(snap),
      point.x,
      point.y,
    );
    if (!found) return null;
    return this.actorIdAt(found, snap) === snap.self.id ? null : found;
  }

  /** Battler placements on the viewer's level ±1, cached per map + level. */
  private battlerIndex(snap: GameSnapshot): InteractiveIndex {
    const key = `${snap.self.z}`;
    if (this.battlerMap === snap.map && this.battlerKey === key) {
      return this.battlers;
    }
    this.battlerMap = snap.map;
    this.battlerKey = key;
    this.battlers = indexBattlers(snap.map, snap.self.z, this.tilesById, 1);
    return this.battlers;
  }

  /**
   * Who is standing at a cell reference, if it is anybody.
   *
   * Matched against the snapshot's actors rather than read off the placement's
   * `owner`, because a target has to be an *actor* — that is what the session
   * looks up when it swings, and what a health bar is drawn from. A body mid-step
   * is the wrong answer here on purpose: its actor is still recorded at the cell
   * it is walking out of, which is the same cell this pick found it in.
   */
  private actorIdAt(ref: ObjectRef, snap: GameSnapshot): string | null {
    for (const actor of snap.actors) {
      if (
        actor.x === ref.x &&
        actor.y === ref.y &&
        actor.z === ref.z &&
        actor.stackIndex === ref.stackIndex
      ) {
        return actor.id;
      }
    }
    return null;
  }

  /**
   * Enter or leave look mode: shift on a keyboard, the eye button on a touch
   * screen. Leaving clears what was being looked at; entering re-picks from
   * where the pointer already is rather than waiting for it to move.
   *
   * Touch keeps its target until the next tap — {@link onPointerLeave} never
   * fires for a finger, which is exactly the stickiness that mode wants.
   */
  setLookMode(enabled: boolean) {
    if (enabled === this.lookMode) return;
    this.lookMode = enabled;
    if (!enabled) {
      this.lookedAt = null;
      return;
    }
    // Whatever the pointer was aimed at is no longer a hover target, and the
    // yellow outline has to go with the mode that owns it.
    this.session.setHoveredObject(null);
    if (this.lastPointer) {
      this.lookedAt = this.lookAt(this.lastPointer, this.session.getSnapshot());
    }
  }

  /** Whatever tile is drawn under a point, interactive or not. */
  private lookAt(
    point: { x: number; y: number },
    snap: GameSnapshot,
  ): ObjectRef | null {
    const anchor = viewAnchorFor(snap.self);
    const hidden = levelsAboveShouldHide(snap.map, this.tilesById, anchor);
    return pickTileAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        assets: this.world.quadAssets(),
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas).cssScale,
      },
      this.probeSpan,
      point.x,
      point.y,
      snap.self.z,
      LOOK_LEVEL_SLACK,
      hidden ? anchor.z : undefined,
    );
  }

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
    if (this.lookMode) {
      const looked = this.lookTarget(snap);
      // Health bars still go up. Looking is a different question from fighting,
      // and hiding how hurt everything is the moment you read a sign would be a
      // mode taking away information rather than adding it.
      const bars = this.healthBarsFor(snap);
      if (!looked) return bars;
      return [
        { kind: "objectOutline", ...looked.ref, color: LOOK_COLOR },
        ...bars,
      ];
    }

    const specs: OverlaySpec[] = [];
    // Red first, so a hovered target that is *already* the target reads as
    // committed rather than as merely hoverable — the later spec would otherwise
    // draw its white outline over the top.
    const target = this.targetOutline(snap);
    if (target) {
      specs.push({ kind: "objectOutline", ...target, color: TARGET_COLOR });
    }
    if (this.targetHover && !sameRef(this.targetHover, target)) {
      specs.push({
        kind: "objectOutline",
        ...this.targetHover,
        color: TARGET_HOVER_COLOR,
      });
    }
    if (snap.hover) {
      specs.push({ kind: "objectOutline", ...snap.hover, color: HOVER_COLOR });
    }
    specs.push(...this.healthBarsFor(snap));
    return specs;
  }

  /** Where the actor being fought is standing right now, if they still are. */
  private targetOutline(snap: GameSnapshot): ObjectRef | null {
    if (snap.targetId === null) return null;
    const actor = snap.actors.find((a) => a.id === snap.targetId);
    if (!actor) return null;
    return {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      stackIndex: actor.stackIndex,
    };
  }

  /**
   * A bar over every battler that has taken a hit.
   *
   * Only the hurt ones, which is the one piece of judgement in here: a bar over
   * everything at full health turns a quiet field into a status readout, and the
   * information it carries — "this thing can be fought" — is already given by
   * the outline the moment you point at it.
   *
   * Anchored on the sprite's live position and lifted by its own height, exactly
   * as a name tag is, so a bar rides a walking creature instead of jumping a cell
   * behind it.
   */
  private healthBarsFor(snap: GameSnapshot): OverlaySpec[] {
    const bars: OverlaySpec[] = [];
    for (const actor of snap.actors) {
      if (actor.hp === null || actor.maxHp === null) continue;
      if (actor.hp >= actor.maxHp) continue;

      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.movingTileHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      bars.push({
        kind: "healthBar",
        id: actor.id,
        x: visual.x + head.x,
        y: visual.y + head.y - HEALTH_BAR_LIFT_PX,
        fraction: healthFraction(actor.hp, actor.maxHp),
      });
    }
    return bars;
  }

  /**
   * What is being looked at right now, resolved against the board.
   *
   * A held reference goes stale in two ways and this closes both. The
   * placement can leave — pushed, switched, erased by the editor — in which
   * case there is nothing to outline or name. And the *world can move under a
   * still pointer*: the camera follows the viewer, so walking with shift held
   * slides a different cell under a cursor that never moved. Re-picking is what
   * keeps the outline on the thing the player is actually pointing at, the same
   * argument the cursor already makes for being driven by the frame rather than
   * by pointer events.
   */
  private lookTarget(
    snap: GameSnapshot,
  ): { ref: ObjectRef; placed: PlacedTile; def: TileDef } | null {
    if (!this.lookedAt) return null;
    const stack = getStack(snap.map, this.lookedAt.x, this.lookedAt.y, this.lookedAt.z);
    const placed = stack[this.lookedAt.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    if (!placed || !def) {
      this.lookedAt = null;
      return null;
    }
    return { ref: this.lookedAt, placed, def };
  }

  /**
   * Re-pick when the world has moved under the pointer.
   *
   * Keyed on the camera and the map rather than run every frame: standing still
   * and looking at a rock costs nothing, and the probe only pays while
   * something is actually changing.
   */
  /**
   * Re-pick the battler under the pointer when the world has moved under it.
   *
   * The same argument {@link repickLook} makes, and it matters more here: the
   * camera follows the viewer, so walking past a cat slides it out from under a
   * cursor that never moved. Without this the white outline would stay stuck to
   * a cell the creature has left, and a click would target whoever wandered into
   * it. Keyed on camera and map so standing still costs nothing.
   */
  private repickTargetHover(
    snap: GameSnapshot,
    camera: { x: number; y: number },
  ) {
    if (this.lookMode || !this.lastPointer) return;
    const key = `${camera.x},${camera.y}`;
    if (key === this.targetHoverKey && snap.map === this.targetHoverMap) return;
    this.targetHoverKey = key;
    this.targetHoverMap = snap.map;
    this.targetHover = this.battlerAt(this.lastPointer, snap);
  }

  /**
   * Drop the target once it is no longer on screen.
   *
   * Two ways that happens and both are handled by the same rule: it walked out
   * of the view, or it stopped existing — killed, disconnected, or dropped to a
   * floor this client is not drawing. Checked against the drawn view rather than
   * a radius in cells, because "on my screen" is what a player actually means,
   * and the view is square and known.
   */
  private enforceTargetVisibility(
    snap: GameSnapshot,
    camera: { x: number; y: number },
  ) {
    if (snap.targetId === null) return;
    const actor = snap.actors.find((a) => a.id === snap.targetId);
    if (!actor) {
      this.session.setTarget(null);
      return;
    }
    const visual = this.actorVisualWorld(snap.map, actor);
    const outside =
      visual.x < camera.x ||
      visual.y < camera.y ||
      visual.x > camera.x + VIEW_PX ||
      visual.y > camera.y + VIEW_PX;
    if (outside) this.session.setTarget(null);
  }

  private repickLook(snap: GameSnapshot, camera: { x: number; y: number }) {
    if (!this.lookMode || !this.lastPointer) return;
    const key = `${camera.x},${camera.y}`;
    if (key === this.lookPickKey && snap.map === this.lookPickMap) return;
    this.lookPickKey = key;
    this.lookPickMap = snap.map;
    this.lookedAt = this.lookAt(this.lastPointer, snap);
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
   * Draw the world unlit. The renderer stops baking and uploading light (see
   * {@link WorldRenderer.setLightingEnabled}); this end stops producing the
   * per-actor emitter overrides that feed it, since nothing would read them.
   */
  setLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    this.world.setLightingEnabled(enabled);
  }

  /**
   * Every piece of in-world text this frame: names on heads, speech on cells.
   *
   * Both are produced here because both are anchored in world pixels and handed
   * to the same layer, which turns them into screen positions. Names are keyed
   * by actor and speech by message id, so the two can never collide in the
   * element cache.
   */
  private labelsFor(snap: GameSnapshot): WorldLabel[] {
    const labels: WorldLabel[] = [];
    this.pushNameLabels(snap, labels);
    this.pushSpeechLabels(snap, labels);
    this.pushLookLabel(snap, labels);
    return labels;
  }

  /**
   * What the thing under the pointer is, and what it says.
   *
   * Two lines at most: the tile's own name, and the placement's description
   * under it when it has one. Lines flow downward from a group whose bottom
   * edge is the anchor, so `[name, description]` puts the name on top and the
   * text directly beneath — the same stacking speech already uses, which is why
   * a look reads like a bubble rather than a tooltip.
   *
   * One id for the whole mode, because there is only ever one looked-at thing:
   * the layer then reuses a single element and refills it only when the words
   * change, rather than churning a node per cell the pointer crosses.
   *
   * The anchor is the object's cell, so a described crate mid-shove has its
   * label at the cell it has already committed to while the sprite lerps in
   * behind. Accepted for now — see plans/looking-and-signs.md.
   */
  private pushLookLabel(snap: GameSnapshot, into: WorldLabel[]) {
    if (!this.lookMode) return;
    const target = this.lookTarget(snap);
    if (!target) return;
    const { ref, placed, def } = target;

    const ground = this.cellWorldCenter(
      ref.x,
      ref.y,
      ref.z,
      snap.map,
      ref.stackIndex,
    );
    const head = elevationScreenOffset(def.height);
    const lines = [{ id: "name", text: def.name }];
    if (placed.description) {
      lines.push({ id: "description", text: placed.description });
    }

    into.push({
      id: "look",
      kind: "look",
      x: ground.x + head.x,
      y: ground.y + head.y,
      lines,
    });
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
  private pushNameLabels(snap: GameSnapshot, into: WorldLabel[]) {
    if (!this.showNames) return;

    for (const actor of snap.actors) {
      // People are named; the wildlife is not. A handle is derived from the
      // cookie behind a connection, so hanging one over a deer would be reading
      // out an internal id and calling it a name.
      if (actor.tileId !== PLAYER_TILE_ID) continue;

      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.movingTileHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      into.push({
        id: `name:${actor.id}`,
        kind: "name",
        x: visual.x + head.x,
        y: visual.y + head.y,
        lines: [{ id: actor.id, text: displayNameFor(actor.id) }],
      });
    }
  }

  /**
   * Speech, anchored to the *cell* it was said in rather than to its author.
   *
   * That is the whole difference between a bubble and a name: the name belongs
   * to a body and follows it, while the words stay where they were spoken. The
   * speaker can walk out from under their own sentence, or disconnect entirely,
   * and it hangs there for the rest of its five seconds.
   *
   * **The anchor is frozen the first frame the message is seen** and never
   * recomputed — see {@link speechAnchor}. Messages at one cell are handed over
   * as a single group so they stack; clearing the name tag on the same head is
   * the stylesheet's job, since both are fixed screen-size text and a gap
   * measured in world pixels would close at low zoom and yawn at high.
   */
  private pushSpeechLabels(snap: GameSnapshot, into: WorldLabel[]) {
    if (snap.chats.length === 0) {
      if (this.speechAnchors.size > 0) this.speechAnchors.clear();
      return;
    }

    // Grouped by cell, in the order they arrived: the map preserves insertion
    // order, so the oldest at a cell is first and ends up at the top of the
    // column with the newest resting on the ground.
    const byCell = new Map<string, WorldLabel>();
    for (const chat of snap.chats) {
      const key = `${chat.x},${chat.y},${chat.z}`;
      const group = byCell.get(key);
      const line = {
        id: chat.id,
        text: `${speakerNameFor(chat, this.tilesById)} says: ${chat.text}`,
      };
      if (group) {
        group.lines.push(line);
        continue;
      }
      const at = this.speechAnchor(chat, snap.map);
      byCell.set(key, {
        id: `speech:${key}`,
        kind: "speech",
        x: at.x,
        y: at.y,
        lines: [line],
      });
    }

    this.forgetStaleSpeechAnchors(snap);
    for (const group of byCell.values()) into.push(group);
  }

  /**
   * Where a message hangs, worked out once and then held.
   *
   * Two things are deliberate here.
   *
   * **It ignores the speaker's own body.** `sceneryStack` drops the tile at the
   * speaker's stack index, so the anchor is the ground they were standing *on*
   * rather than the top of their head. Measured the other way the bubble
   * appeared a body's height too high and then visibly dropped the moment they
   * stepped away — the position after that drop is the right one, so it is the
   * one taken from the start.
   *
   * **It is frozen.** Recomputing per frame meant the words rode whatever
   * happened to the cell afterwards: drop a crate on the spot and the sentence
   * climbed with it. A remark belongs to the moment it was made, so the height
   * is read once, at the level and elevation of that moment, and kept.
   */
  private speechAnchor(
    chat: ChatBubble,
    map: MapFile,
  ): { x: number; y: number } {
    const held = this.speechAnchors.get(chat.id);
    if (held) return held;

    const ground = this.cellWorldCenter(
      chat.x,
      chat.y,
      chat.z,
      map,
      chat.stackIndex,
    );
    const head = elevationScreenOffset(
      this.tilesById[PLAYER_TILE_ID]?.height ?? 0,
    );
    const at = { x: ground.x + head.x, y: ground.y + head.y };
    this.speechAnchors.set(chat.id, at);
    return at;
  }

  /**
   * Drop held anchors for messages that have expired.
   *
   * No size-based early-out: one message expiring as another arrives leaves the
   * count unchanged while the contents differ, and a cheap guard that is right
   * only most of the time is worse than no guard at a handful of entries.
   */
  private forgetStaleSpeechAnchors(snap: GameSnapshot) {
    if (this.speechAnchors.size === 0) return;
    const live = new Set(snap.chats.map((chat) => chat.id));
    for (const id of this.speechAnchors.keys()) {
      if (!live.has(id)) this.speechAnchors.delete(id);
    }
  }

  /**
   * Same signal as the outline, for the pointer. Looking gets `help` rather
   * than `pointer`: the object is not going to do anything if you click it, and
   * a hand that promises otherwise is the cursor lying about the mode.
   */
  private applyCursor(snap: GameSnapshot) {
    if (this.lookMode) {
      this.setCursor(this.lookedAt ? "help" : "");
      return;
    }
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
    // Before the overlay and the label read it, so both describe the same
    // frame's answer rather than the previous one's.
    this.repickLook(snap, camera);
    this.repickTargetHover(snap, camera);
    this.enforceTargetVisibility(snap, camera);

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
    // Written from inside the render loop's own rAF, so the style change and the
    // canvas paint land in the same commit — which is what stops DOM text from
    // trailing the sprite it belongs to.
    this.labelLayer?.set(this.labelsFor(snap), camera, fit.cssScale);
    this.damageLayer?.set(this.damageFor(snap), camera, fit.cssScale);
    // Driven by the frame, not the pointer: walking away from an object
    // revokes the affordance without the pointer having moved at all.
    this.applyCursor(snap);
  }

  /**
   * This frame's damage numbers, anchored where each blow landed.
   *
   * The anchor is the *cell*, not the body: a killing blow deletes its target on
   * the same tick, so a number that followed the actor would vanish exactly when
   * it mattered most. Computed fresh each frame rather than frozen the way a
   * speech anchor is — a number lives under a second and rises out of the way,
   * so it cannot outlive the ground beneath it in any way a viewer would notice.
   *
   * Filtered to the floors this client is drawing, because the wire carries every
   * blow struck anywhere in the world: without this a fight two storeys down
   * would rain numbers over the room you are standing in.
   */
  private damageFor(snap: GameSnapshot): DamageNumberView[] {
    if (snap.damage.length === 0) return [];

    const out: DamageNumberView[] = [];
    for (const hit of snap.damage) {
      if (Math.abs(hit.z - snap.self.z) > DAMAGE_LEVEL_SLACK) continue;

      const ground = this.cellWorldCenter(
        hit.x,
        hit.y,
        hit.z,
        snap.map,
        hit.stackIndex,
      );
      const head = elevationScreenOffset(
        this.movingTileHeight(snap.map, hit, hit.stackIndex),
      );
      out.push({
        id: hit.id,
        x: ground.x + head.x,
        y: ground.y + head.y,
        amount: hit.amount,
        own: hit.targetId === snap.self.id,
        elapsedMs: hit.elapsedMs,
      });
    }
    return out;
  }

  /**
   * Cell-space fractional emit positions for the player light.
   * Always returned when the player emits light — standing uses the tile
   * centre so the static bake can omit the player and never re-run on each step.
   */
  private emitterOverridesFor(
    snap: GameSnapshot,
  ): EmitterOverride[] | undefined {
    if (!this.lightingEnabled) return undefined;
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
    const t = actor.slideProgress;
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

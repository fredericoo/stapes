import {
  baseCellWorldOrigin,
  depthStackBias,
  drawOrder,
  elevationScreenOffset,
  PX_PER_HEIGHT,
} from "../lib/geometry";
import type {
  ActorSnapshot,
  ChatBubble,
  DamageNumber,
  GameSnapshot,
  ObjectRef,
  PlaySession,
} from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { bodyNameFor } from "../game/displayName";
import type { Equipment } from "../game/equipment";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import { readOpenedContainer } from "../game/openedContainer";
import {
  applyInteraction,
  interactionText,
  listInteractionOptions,
  topInteractionAt,
  type InteractionOption,
} from "../game/interactionOptions";
import { WorldLabelLayer, type WorldLabel } from "./textLabels";
import { FrameProfiler, type FrameStats } from "./frameProfile";
import { fallDropPx, fallFootAbs, standingFootAbs } from "./fallAnchor";
import { isHiddenFromCamera } from "./cameraSight";
import { labelHeadroomPx } from "./labelHeadroom";
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
import type {
  Coord,
  LightDef,
  MapFile,
  PlacedTile,
  TileDef,
  TilesetDef,
} from "../lib/types";
import { HEIGHT_PER_LEVEL, tileCanEmitLight } from "../lib/types";
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
} from "./pick";
import { DamageNumberLayer, type DamageNumberView } from "./damageNumbers";
import { healthBarColor, healthFraction } from "./healthBar";
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

/**
 * How solid a thing being dragged onto the world looks before it is let go of.
 *
 * Enough to read the sprite and tell it is not there yet. A fainter ghost reads
 * as a rendering fault on a busy floor, and a stronger one reads as a thing
 * already dropped.
 */
const DROP_GHOST_ALPHA = 0.55;

/**
 * Editor selection yellow — same affordance, same colour.
 *
 * And the same yellow the DOM wears for it: `--color-interact` in `app.css` is
 * this value, so a row lit in the list and the thing it names lit in the world
 * are one state rather than two that happen to co-occur.
 */
const HOVER_COLOR = 0xffcc00;

/** A battler under the pointer: somebody who *could* be singled out. */
const TARGET_HOVER_COLOR = 0xffffff;

/**
 * The one you have actually picked, while you are only watching them.
 *
 * The same white the hover wears, and told apart from it by the pulse rather
 * than by a third colour: a target and a body you happen to be pointing at are
 * the same *kind* of thing — somebody singled out — and the difference between
 * them is that one is a decision you have made, which is what the pulse says.
 */
const TARGET_COLOR = 0xffffff;

/**
 * The one you have picked while in attack mode. Red for the rest of the fight.
 *
 * Colour carries the mode and nothing else, which is why the pulse is on both:
 * red is not "this is your target", it is "this target is a fight", and turning
 * attack mode off leaves the outline exactly where it was in white.
 */
const ATTACK_TARGET_COLOR = 0xff3b30;

/**
 * Floors either side of the viewer whose chrome is worth drawing.
 *
 * The same slack the look pick and sight already use. Beyond it a body is
 * behind a floor or a ceiling, and chrome that reported it would be telling the
 * player about something they cannot see.
 */
const CHROME_LEVEL_SLACK = 1;

/**
 * Looking is blue, acting is yellow. Never both at once: two outlines in two
 * colours on one object asks the player to decode a legend, so entering look
 * mode takes the interaction hover off the screen entirely.
 */
const LOOK_COLOR = 0x3fa9ff;

/** Floors above and below the viewer that a look can reach, as the pick does. */
const LOOK_LEVEL_SLACK = 1;

/**
 * Ink for the name of a thing the pointer is over, outside look mode.
 *
 * The hover's own {@link HOVER_COLOR} lightened, exactly as the look label's
 * `#9ad8ff` is {@link LOOK_COLOR} lightened: the label and the outline round the
 * same object have to be the same colour, and a text weight of pure `#ffcc00` is
 * a headline rather than a caption.
 */
const HOVER_LABEL_INK = "#ffe27a";

/**
 * A reward, which is the one thing on the board you can only take once.
 *
 * `--color-reward` in `app.css` is this value, on the same terms
 * {@link HOVER_COLOR} and `--color-interact` are one colour: the row in the list
 * and the silhouette in the world are one state.
 *
 * The third colour a pointer can produce, where two was the rule for a long
 * time — and the rule was about not making the player decode a legend for
 * something they already knew. This one is different in kind: nothing about the
 * verb, the sprite or the outline says whether a chest is one you can come back
 * to, and that is exactly the thing worth knowing before you walk away from it.
 */
const REWARD_COLOR = 0xb15cff;

/** The reward outline lightened, as every other label ink here is. */
const REWARD_LABEL_INK = "#d9a9ff";

/**
 * What colour an option paints its subject, and what ink its words are in.
 *
 * Three of them — white for a body that could be singled out, purple for
 * something you can be given once, yellow for everything else you could act on.
 * A row under a finger and a sprite under a cursor are two ways of pointing at
 * one thing, so pointing either way has to look identical.
 *
 * The ink is the outline lightened, exactly as the look label's `#9ad8ff` is
 * {@link LOOK_COLOR} lightened: the words and the silhouette are one reading,
 * and a text weight of pure `#ffcc00` is a headline rather than a caption.
 */
function interactionColor(option: InteractionOption): number {
  if (option.action === "target") return TARGET_HOVER_COLOR;
  if (option.action === "reward") return REWARD_COLOR;
  return HOVER_COLOR;
}

function interactionInk(option: InteractionOption): string {
  if (option.action === "target") return "#ffffff";
  if (option.action === "reward") return REWARD_LABEL_INK;
  return HOVER_LABEL_INK;
}

/**
 * The one label the pointer puts on the world, whichever mode produced it.
 *
 * Two modes fill it — look mode names a thing, and the interaction hover says
 * what you could do to it — and they share a shape so the placement, the anchor
 * and the element cache are written once. `height` rather than the tile itself
 * because the anchor is all the caller needs: a label hangs over the top of the
 * head, and how tall the head is is the whole of the question.
 */
type PointerLabel = {
  ref: ObjectRef;
  height: number;
  lines: { id: string; text: string }[];
  /** Absent leaves the stylesheet's blue in charge, which is look mode's own. */
  color?: string;
};

/**
 * A number that changes whenever anybody's health does.
 *
 * The interaction list is rebuilt from a gate that asks whether the answer
 * *could* have moved, and every question in it — the board, the player's cell,
 * who they are fighting — is blind to a blow landing: the map has no actors in
 * it, and standing still exchanging hits changes none of the rest. This is the
 * missing question, kept to one pass over a handful of bodies so the gate stays
 * the cheap thing it is there to be.
 *
 * A rolling hash rather than a joined string because this runs every frame, and
 * positional because two creatures trading a point between them is otherwise a
 * sum that has not moved. Collisions cost nothing worse than a bar redrawn at
 * the next commit instead of the next frame.
 */
function healthSignature(actors: readonly ActorSnapshot[]): number {
  let signature = 0;
  for (const actor of actors) {
    if (actor.hp === null) continue;
    signature = (signature * 31 + actor.hp) | 0;
  }
  return signature;
}

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
  private onEquipment: ((equipment: Equipment) => void) | null = null;
  /** Identity of the last equipment handed on, so an idle frame costs a compare. */
  private equipmentSent: Equipment | null = null;
  /** Kit the interaction list was last built against. See the gate below. */
  private interactionsEquipment: Equipment | null = null;
  /**
   * Tags the interaction list was last built against.
   *
   * In the gate for the same reason the kit is, and it is the one signal that a
   * reward row going away has: taking one changes nothing on the board, so the
   * map keeps its identity and the player has not moved. Without this the chest
   * would go on offering itself until something else happened.
   */
  private interactionsTags: readonly string[] | null = null;
  private onOpenedContainer:
    | ((container: OpenedContainer | null) => void)
    | null = null;
  /** Which floor container the panel is showing, if any. */
  private openedRef: ObjectRef | null = null;
  /**
   * Which particular thing that reference was opened on.
   *
   * Learnt on the first read and checked on every one after it, so a slot that
   * comes to hold something else cannot be shown under the old panel — see
   * `readOpenedContainer`. Null until the first read.
   */
  private openedItemId: string | null = null;
  /** The placement last read for it — half of the gate below. */
  private openedPlacement: PlacedTile | null = null;
  /** Where the viewer stood when reach was last asked — the other half. */
  private openedFrom = "";
  /** Last value handed on. `undefined` means "nothing said yet". */
  private openedSent: OpenedContainer | null | undefined = undefined;
  private onInteractions:
    | ((options: InteractionOption[]) => void)
    | null = null;
  /** Board and cell the held list was derived from. @see pushInteractionOptions */
  private interactionsMap: MapFile | null = null;
  private interactionsAt = "";
  /** Health of everybody on the board when it was. @see healthSignature */
  private interactionsHealth = 0;
  /** Contents of the last list handed over, so an unchanged one is not re-sent. */
  private interactionsKey = "";
  /**
   * The list as it was last handed over, kept so a hovered row can be resolved
   * back to a *current* reference. @see listHoverOption
   */
  private interactionsSent: InteractionOption[] = [];
  /** @see setListHover */
  private listHoverId: string | null = null;
  /**
   * What is being dragged over the world right now, and where the pointer is.
   *
   * Held here rather than in React because it changes with every pixel of a
   * drag: the page hands over the thing and the point, and this loop — which is
   * already reading a snapshot every frame — decides what that means and draws
   * it. Routing a ghost through React state would re-render the page around the
   * game to move one translucent sprite.
   */
  private dropDrag:
    | { from: SlotRef; tileId: string; point: { x: number; y: number } }
    | null = null;
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
   * Which object the pointer is over — not what can be done to it.
   *
   * **The reference is held and the row is looked up every frame**, which is the
   * same trick the list hover plays and for a sharper reason. A row changes
   * under a still cursor: open the chest you are pointing at and its row is
   * renamed "Close", walk until a crate is out of reach and its row goes. Held
   * as an option, the label would go on saying "Open Chest" over an open chest
   * until the mouse twitched.
   *
   * The *pick* is still held rather than run per frame, for the reason the look
   * pick is — see {@link repickPointer}. What is cheap to redo is the lookup,
   * not the hit test.
   */
  private pointerRef: ObjectRef | null = null;
  private pointerPickKey = "";
  private pointerPickMap: MapFile | null = null;
  private damageLayer: DamageNumberLayer | null = null;
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
  /**
   * World-pixel anchor per damage number, read once and held.
   *
   * Same freeze, same reason as {@link speechAnchors}: what happened, happened
   * at a height. @see damageFor
   */
  private readonly damageAnchors = new Map<string, { x: number; y: number }>();

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
   * When there is a world on the canvas, so a page can hold its loading screen
   * up until then. The world is not painted until its tilesets are on the GPU,
   * and that lands some frames after the renderer is built — long enough that
   * swapping to an empty canvas is a visible blank between the loading screen
   * and the game.
   */
  setOnFirstFrame(cb: (() => void) | null) {
    this.world.setOnFirstFrame(cb);
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

  /**
   * What the player could act on right now, whenever that changes.
   *
   * Derived here rather than polled from outside because this is the loop that
   * already knows when the world moved, and the answer is only ever interesting
   * at the moments it changes — a list rebuilt into React state thirty times a
   * second would re-render the page for a frame nobody could tell apart from
   * the last one. See {@link pushInteractionOptions} for the two gates.
   */
  /**
   * What the viewer is carrying, whenever it changes.
   *
   * Routed through the render loop rather than read off the session by the page,
   * for the same reason the interaction list is: this loop is already reading a
   * snapshot every frame, and it is the only thing that knows when a new one
   * arrived. The gate is object identity — the session replaces the whole
   * equipment object when the server sends one and never mutates it in place —
   * so a player standing still costs one reference compare per frame.
   */
  setOnEquipment(cb: ((equipment: Equipment) => void) | null) {
    this.onEquipment = cb;
    // Dropped so the next frame reports to a fresh listener even though nothing
    // has changed, exactly as the interaction gates are.
    this.equipmentSent = null;
  }

  private pushEquipment(snap: GameSnapshot) {
    if (!this.onEquipment) return;
    if (snap.equipment === this.equipmentSent) return;
    this.equipmentSent = snap.equipment;
    this.onEquipment(snap.equipment);
  }

  /**
   * Which container on the floor the player is looking into, or null.
   *
   * The reference is held here rather than the contents, because a chest's
   * contents live on its placement and arrive through the ordinary cell patch.
   * Anything holding a copy would be a second version of what is in the box,
   * going stale the moment somebody took something out of it.
   */
  setOpenedContainer(ref: ObjectRef | null) {
    this.openedRef = ref;
    // Dropped so the next frame reports even when the reference is unchanged —
    // reopening the same chest must not be silent.
    this.openedItemId = null;
    this.openedPlacement = null;
    this.openedFrom = "";
    this.openedSent = undefined;
  }

  setOnOpenedContainer(cb: ((container: OpenedContainer | null) => void) | null) {
    this.onOpenedContainer = cb;
    this.openedPlacement = null;
    this.openedFrom = "";
    this.openedSent = undefined;
  }

  /**
   * Read the opened container off the live board, once a frame.
   *
   * **Two things can change the answer, and the gate has to admit both.** The
   * container's cell can change — somebody takes something out, or takes the
   * whole box — and the viewer can walk. Gating on the placement alone was a
   * real bug: the map is copy-on-write, so a chest nobody touches is the same
   * object for as long as it sits there, and walking out of range never
   * re-asked the question. Whether it closed depended on whether anything
   * happened to the box while you were away.
   *
   * So: the placement object, which is exactly the right granularity for "did
   * that cell change", *and* the cell the viewer is standing in, which is the
   * whole of what reach depends on. A player standing still over an open chest
   * costs one stack read, one reference compare and one string compare.
   *
   * The rule itself is `readOpenedContainer`, which is pure and tested. All this
   * does is decide when to ask and remember what it said.
   */
  private pushOpenedContainer(snap: GameSnapshot) {
    if (!this.onOpenedContainer) return;

    const ref = this.openedRef;
    if (!ref) {
      if (this.openedSent === null) return;
      this.openedSent = null;
      this.onOpenedContainer(null);
      return;
    }

    const placed = getStack(snap.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const from = `${snap.self.x},${snap.self.y},${snap.self.z}`;
    if (placed === this.openedPlacement && from === this.openedFrom) return;
    this.openedPlacement = placed ?? null;
    this.openedFrom = from;

    const read = readOpenedContainer(
      snap.map,
      this.tilesById,
      snap.self,
      ref,
      this.openedItemId,
    );
    if (read.kind === "closed") {
      // The reference is dropped rather than merely reporting null, which is
      // what makes closed stay closed: walking back into range does not reopen
      // a panel nobody asked for, and the slot cannot quietly come to hold
      // somebody else's bag under the panel that used to be a chest.
      this.openedRef = null;
      this.openedItemId = null;
    } else {
      this.openedItemId = read.itemId;
    }

    const container = read.kind === "open" ? read.container : null;
    if (container === null && this.openedSent === null) return;
    this.openedSent = container;
    this.onOpenedContainer(container);
  }

  setOnInteractions(cb: ((options: InteractionOption[]) => void) | null) {
    this.onInteractions = cb;
    // The next frame has to report to a fresh listener even if nothing has
    // moved, so both gates are dropped rather than left holding an answer the
    // new callback has never seen.
    this.interactionsMap = null;
    this.interactionsAt = "";
    this.interactionsHealth = 0;
    this.interactionsKey = "";
    this.interactionsEquipment = null;
    this.interactionsTags = null;
    this.interactionsSent = [];
  }

  /**
   * Outline what a hovered row is talking about.
   *
   * The list names things that are somewhere, and "which one is that" is a
   * question the world can answer for free — so hovering a row lights its
   * subject exactly as the cursor would if it were over the sprite instead.
   *
   * **Held by id rather than by option, and that is the whole trick.** A row's
   * subject moves: the list is rebuilt on every commit, so the reference inside
   * an option is stale 200ms later, and the element does not re-fire its enter
   * event because it is the same row. Resolving the id against the list as it
   * stands now keeps the outline on a walking deer rather than on the cell it
   * left — and drops it for nothing when the row itself goes, which is the
   * event a mouse leaving an unmounting element never reports.
   */
  setListHover(optionId: string | null) {
    this.listHoverId = optionId;
  }

  /** The hovered row's option as it stands this frame, or null. */
  private listHoverOption(): InteractionOption | null {
    if (this.listHoverId === null) return null;
    return (
      this.interactionsSent.find((o) => o.id === this.listHoverId) ?? null
    );
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
    this.onEquipment = null;
    this.onOpenedContainer = null;
    this.onInteractions = null;
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
    this.pointerRef = this.pickRefAt(this.lastPointer, snap);
  };

  /**
   * Interactive object drawn under a canvas-relative point, if any.
   *
   * Gated on *having a row* rather than on the session's own precedence. A
   * chest offers nothing that precedence knows about — opening is panel state,
   * so `canInteract` says no — and gating on it left a box that the list was
   * offering to open sitting in the world unclickable.
   */
  private pickAt(
    point: { x: number; y: number },
    snap: GameSnapshot,
  ): ObjectRef | null {
    return pickInteractiveAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        camera: this.cameraFor(snap),
        // CSS scale, not the render scale: the pointer arrives in the
        // element's own coordinates, and the buffer is stretched over it.
        zoom: currentFit(this.canvas).cssScale,
      },
      this.interactiveIndex(snap),
      point.x,
      point.y,
      (ref) => topInteractionAt(this.interactionsSent, ref) !== null,
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
    this.pointerRef = this.pickRefAt(point, snap);
    const option = this.pointerOption();
    if (!option) return;

    e.preventDefault();
    this.runOption(option);
  };

  /**
   * Do what the row under the pointer says.
   *
   * The one place a click on the world turns into an action, and it runs the
   * *same* option the outline and the label were describing — so "Open Chest"
   * opens, and there is no second precedence to disagree with the words on
   * screen.
   *
   * Opening is handled here rather than in `applyInteraction` because it never
   * reaches the session at all: a container's contents ride on its placement, so
   * looking inside is this renderer's own state and the page hears about it the
   * same way it does when a row is pressed.
   */
  private runOption(option: InteractionOption) {
    if (option.action === "open") {
      this.setOpenedContainer(option.active ? null : option.ref);
      return;
    }
    applyInteraction(this.session, option);
  }

  private onPointerLeave = () => {
    this.lastPointer = null;
    this.lookedAt = null;
    // Only the *hover* goes. A target is a commitment held until it is called
    // off, killed, or walks out of view — moving the mouse away is none of
    // those, and dropping it here would make a fight unwinnable one-handed.
    this.pointerRef = null;
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
    this.pointerRef = null;
    if (this.lastPointer) {
      this.lookedAt = this.lookAt(this.lastPointer, this.session.getSnapshot());
    }
  }

  /**
   * Show where a dragged thing would land, or stop showing it.
   *
   * Takes client coordinates because a drag is a window-level gesture — it
   * starts on a panel and crosses the canvas — and this is the one place that
   * already knows where the canvas is.
   */
  setDropGhost(
    drag: { from: SlotRef; tileId: string; clientX: number; clientY: number } | null,
  ) {
    if (!drag) {
      this.dropDrag = null;
      return;
    }
    const point = this.canvasPoint(drag.clientX, drag.clientY);
    this.dropDrag = point
      ? { from: drag.from, tileId: drag.tileId, point }
      : null;
  }

  /**
   * The cell a client point is over, or null when it is over nothing.
   *
   * Exported for the drop itself: the page owns the gesture and the session
   * call, and this owns the camera — so the page asks *where*, and does the rest
   * with the answer.
   */
  dropCellAt(clientX: number, clientY: number): Coord | null {
    const point = this.canvasPoint(clientX, clientY);
    if (!point) return null;
    const ref = this.lookAt(point, this.session.getSnapshot());
    return ref ? { x: ref.x, y: ref.y, z: ref.z } : null;
  }

  /** Client point in canvas pixels, or null when it is not over the canvas. */
  private canvasPoint(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return { x, y };
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
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas).cssScale,
      },
      point.x,
      point.y,
      snap.self.z,
      LOOK_LEVEL_SLACK,
      hidden ? anchor.z : undefined,
    );
  }

  /**
   * The ghost for whatever is being dragged, or null.
   *
   * **Nothing is drawn where the drop would be refused, and nothing says why.**
   * The absent ghost is the whole answer: a player learns the range by watching
   * it appear, which is a thing you feel out in a second, where a message
   * explaining a rule is a thing you have to read every time.
   *
   * Asked of the session rather than of `canDropAt` directly, so this goes
   * through the same door the release will — a ghost drawn from one rule and a
   * drop honoured by another is exactly the disagreement the shared affordances
   * exist to prevent.
   */
  private dropGhostSpec(snap: GameSnapshot): OverlaySpec | null {
    const drag = this.dropDrag;
    if (!drag) return null;
    const ref = this.lookAt(drag.point, snap);
    if (!ref) return null;
    const at = { x: ref.x, y: ref.y, z: ref.z };
    if (!this.session.canDrop(drag.from, at)) return null;
    return { kind: "ghost", tileId: drag.tileId, ...at, alpha: DROP_GHOST_ALPHA };
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
  private overlaysFor(
    snap: GameSnapshot,
    motions: TileMotion[],
  ): OverlaySpec[] {
    const outline = (
      ref: ObjectRef,
      color: number,
      pulse = false,
    ): OverlaySpec => ({
      kind: "objectOutline",
      ...ref,
      color,
      pulse,
      ...this.motionOffsetFor(ref, motions),
    });

    // The row under the cursor points into the world, whatever mode the canvas
    // is in: the eye governs what a tap on the *canvas* means, and a hand on the
    // list is already pointing at something explicitly.
    const listed = this.listHoverOption();

    if (this.lookMode) {
      const looked = this.lookTarget(snap);
      const specs = looked ? [outline(looked.ref, LOOK_COLOR)] : [];
      if (listed) specs.push(outline(listed.ref, interactionColor(listed)));
      return specs;
    }

    const specs: OverlaySpec[] = [];
    const ghost = this.dropGhostSpec(snap);
    if (ghost) specs.push(ghost);
    // The target first, so a hovered body that is *already* the target reads as
    // chosen rather than as merely hoverable — the later spec would otherwise
    // draw its steady outline over the pulsing one.
    const target = this.targetOutline(snap);
    if (target) {
      specs.push(
        outline(
          target,
          snap.attacking ? ATTACK_TARGET_COLOR : TARGET_COLOR,
          true,
        ),
      );
    }
    // One outline for the pointer, in the colour its own row wears — the same
    // function the list hover uses, because a row lit under a finger and a
    // sprite lit under a cursor are two ways of pointing at one thing.
    const pointed = this.pointerOption();
    if (pointed && !sameRef(pointed.ref, target)) {
      specs.push(outline(pointed.ref, interactionColor(pointed)));
    }
    // Last, so it draws over the pointer's own hover where the two land on one
    // object — and skipped on the body already targeted, for the same reason the
    // hover is: chosen outranks hoverable.
    if (listed && !sameRef(listed.ref, target)) {
      specs.push(outline(listed.ref, interactionColor(listed)));
    }
    return specs;
  }

  /**
   * The lerp offset the sprite at this slot is being drawn with, if it is
   * moving at all.
   *
   * Looked up in the very list handed to the renderer rather than recomputed, so
   * an outline and the art inside it are offset by the same number by
   * construction. A motion is keyed at the cell the map still holds the tile in
   * — a walk commits only when it lands, a slide commits at once — which is the
   * same cell every outline reference is built from, so the two always agree
   * about what to match on.
   */
  private motionOffsetFor(
    ref: ObjectRef,
    motions: TileMotion[],
  ): { ox: number; oy: number } | undefined {
    for (const motion of motions) {
      if (
        motion.x === ref.x &&
        motion.y === ref.y &&
        motion.z === ref.z &&
        motion.stackIndex === ref.stackIndex
      ) {
        return { ox: motion.ox, oy: motion.oy };
      }
    }
    return undefined;
  }

  /**
   * Is a floor one the viewer can actually see into?
   *
   * Chrome is drawn over the finished frame — a name tag and a damage number are
   * elements above the canvas, owing nothing to depth — so without asking this
   * they report bodies the world has hidden. That is exactly what went wrong when
   * every battler started being named: the second cat lives two floors up, its
   * sprite is cut away with the roof, and its name hung in the sky over an empty
   * roofline. It reads as a ghost — an invisible thing that is plainly still
   * alive, because it is: a real actor, ticking, just not on screen.
   *
   * Two rules, and both are needed. The roof-cut is the exact one: anything above
   * the ceiling is not drawn at all. The slack is the honest approximation for
   * everything below, where a body *is* drawn but the floor between you and it is
   * drawn in front — there is no cheap per-pixel answer, and one floor is the
   * distance the look pick and sight already treat as within reach.
   */
  private isVisibleLevel(
    snap: GameSnapshot,
    z: number,
    hideLevelsAbove: number | undefined,
  ): boolean {
    if (hideLevelsAbove !== undefined && z > hideLevelsAbove) return false;
    return Math.abs(z - snap.self.z) <= CHROME_LEVEL_SLACK;
  }

  /**
   * Is this body one the viewer can actually *see*?
   *
   * Asked by everything that describes a battler rather than a place: the name
   * over a head, the health under the name, and which bodies the interaction
   * list offers to target.
   *
   * **Deliberately not a question about levels, and not about reach either.**
   * Both were tried and both are wrong. A level test names a rat on the floor
   * above whose sprite is behind a ceiling, and goes silent on one standing in
   * the open a storey down that you are looking straight at. A reach test — only
   * name what you could hit — sounds principled and reads as blindness: you can
   * plainly see the thing, and the game refuses to tell you what it is until you
   * are already beside it. What a player means by "I can see it" is that its
   * sprite is on their screen, so that is the question asked: inside the drawn
   * square, and not drawn over. See {@link isHiddenFromCamera}.
   *
   * Whether you can *fight* it is a separate rule with a separate answer, and
   * the two are meant to disagree — reading a creature's health from across a
   * courtyard and being unable to touch it is the normal state of affairs.
   */
  private isVisibleBody(
    snap: GameSnapshot,
    actor: ActorSnapshot,
    camera: { x: number; y: number },
    hideLevelsAbove: number | undefined,
  ): boolean {
    // The roof-cut, which is exact — anything above it is not drawn at all.
    // Deliberately *without* {@link CHROME_LEVEL_SLACK}, which the rest of the
    // chrome still leans on: that slack exists only because there was no cheap
    // answer for a body drawn behind the floors below you, and there now is one.
    // Approximating a floor's worth of doubt on top of an exact answer would
    // only take back the cases the exact answer got right.
    if (hideLevelsAbove !== undefined && actor.z > hideLevelsAbove) return false;
    if (!this.isWithinView(snap.map, actor, camera)) return false;
    return !isHiddenFromCamera(
      snap.map,
      this.tilesById,
      actor,
      snap.self.z,
      hideLevelsAbove,
    );
  }

  /** Where the targeted actor is standing right now, if they still are. */
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
  private repickPointer(snap: GameSnapshot, camera: { x: number; y: number }) {
    if (this.lookMode || !this.lastPointer) return;
    const key = `${camera.x},${camera.y}`;
    if (key === this.pointerPickKey && snap.map === this.pointerPickMap) return;
    this.pointerPickKey = key;
    this.pointerPickMap = snap.map;
    this.pointerRef = this.pickRefAt(this.lastPointer, snap);
  }

  /**
   * Whatever is drawn under a canvas-relative point and has something to offer.
   *
   * Two picks, and a body wins where they overlap — not by a rule stated here,
   * but because a body is asked about first and the row it answers with is the
   * one the list would put first anyway. Only the player tile is both fightable
   * and shovable, and asking somebody to tell two outlines on one body apart to
   * find out which the click will do is worse than not being able to push people.
   *
   * The object pick is skipped entirely when a body answered, which is the one
   * place this saves work over asking both.
   */
  private pickRefAt(
    point: { x: number; y: number },
    snap: GameSnapshot,
  ): ObjectRef | null {
    const battler = this.battlerAt(point, snap);
    if (battler && topInteractionAt(this.interactionsSent, battler)) {
      return battler;
    }
    return this.pickAt(point, snap);
  }

  /**
   * The row for whatever the pointer is over, as it stands this frame.
   *
   * Resolved rather than remembered, so the outline, the words and the click all
   * describe the board as it is now — see {@link pointerRef}.
   */
  private pointerOption(): InteractionOption | null {
    if (!this.pointerRef) return null;
    return topInteractionAt(this.interactionsSent, this.pointerRef);
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
    if (!this.isWithinView(snap.map, actor, camera)) this.session.setTarget(null);
  }

  /**
   * Is this actor's sprite inside the drawn square?
   *
   * Measured against the view rather than a radius in cells, because "on my
   * screen" is what a player actually means, and the view is square and known.
   * Shared by the two questions that both mean exactly that: whether a target
   * is still yours to fight, and whether a body is one you could pick.
   */
  private isWithinView(
    map: MapFile,
    actor: ActorSnapshot,
    camera: { x: number; y: number },
  ): boolean {
    const visual = this.actorVisualWorld(map, actor);
    return (
      visual.x >= camera.x &&
      visual.y >= camera.y &&
      visual.x <= camera.x + VIEW_PX &&
      visual.y <= camera.y + VIEW_PX
    );
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
  private labelsFor(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    hideLevelsAbove: number | undefined,
  ): WorldLabel[] {
    const labels: WorldLabel[] = [];
    this.pushNameLabels(snap, labels, camera, hideLevelsAbove);
    this.pushSpeechLabels(snap, labels);
    this.pushNoiseLabels(snap, labels);
    this.forgetStaleAnchors(snap);
    this.pushPointerLabel(snap, labels);
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
   * **Two modes, one label.** Look mode names whatever you point at, in blue.
   * Outside it the pointer names *items* and nothing else, in the yellow of the
   * outline already round them — because a rusty sword and a hand lantern are
   * both a small thing on the floor, and which one you are about to bend down
   * for is worth knowing before you do. They cannot both appear: entering look
   * mode takes the interaction hover off the screen.
   *
   * One id for both, because there is only ever one thing under a pointer: the
   * layer reuses a single element and refills it only when the words change,
   * rather than churning a node per cell the cursor crosses.
   *
   * The anchor is the object's cell, so a described crate mid-shove has its
   * label at the cell it has already committed to while the sprite lerps in
   * behind. Accepted for now — see plans/looking-and-signs.md.
   */
  private pushPointerLabel(snap: GameSnapshot, into: WorldLabel[]) {
    const said = this.lookMode
      ? this.lookLines(snap)
      : this.pointerLines(snap);
    if (!said) return;

    const { ref, height, lines, color } = said;
    const ground = this.cellWorldCenter(
      ref.x,
      ref.y,
      ref.z,
      snap.map,
      ref.stackIndex,
    );
    const head = elevationScreenOffset(height);

    into.push({
      id: "look",
      kind: "look",
      x: ground.x + head.x,
      y: ground.y + head.y,
      lines,
      ...(color ? { color } : {}),
    });
  }

  /** What look mode says: the tile's name, and what the placement reads. */
  private lookLines(snap: GameSnapshot): PointerLabel | null {
    const target = this.lookTarget(snap);
    if (!target) return null;
    const { ref, placed, def } = target;
    const lines = [{ id: "name", text: def.name }];
    if (placed.description) {
      lines.push({ id: "description", text: placed.description });
    }
    // No colour: the stylesheet's blue is the mode's own, and look mode is the
    // only thing wearing it.
    return { ref, height: def.height, lines };
  }

  /**
   * What the pointer says outside look mode: the row it is over, as a sentence.
   *
   * "Push Box", "Pick up Rusty Sword", "Target Deer" — the verb first, because
   * the verb is what you are deciding about. A sprite on the floor is a handful
   * of pixels and a lantern and a sword are the same handful; a silhouette says
   * *that* you could do something and this says what.
   *
   * Read off the same option the outline is drawn from and the click will run,
   * so the words cannot describe an action other than the one that happens.
   */
  private pointerLines(snap: GameSnapshot): PointerLabel | null {
    const option = this.pointerOption();
    if (!option) return null;
    const def = this.tilesById[option.tileId];
    return {
      ref: option.ref,
      height: def?.height ?? 0,
      lines: [{ id: "action", text: interactionText(option) }],
      color: interactionInk(option),
    };
  }

  /**
   * A name over every battler, with its health under the name.
   *
   * **Anything that can be fought says what it is.** That used to be a mode the
   * online route turned on and a check for the player tile inside it, which drew
   * handles over people and left the wildlife anonymous — fine while a creature
   * was scenery you walked past, and wrong the moment it is something you can
   * pick a fight with. What a thing is called is what you need before you decide
   * to hit it, and "battler" is exactly the set of things that question is asked
   * about. Everything else on the map stays unlabelled, which is what keeps a
   * field of grass a field of grass.
   *
   * **And only what you can see** — see {@link isVisibleBody}. Not what you can
   * reach, and not what shares your floor: a tag hanging over a rat behind a
   * cave ceiling is a ghost, and going silent about one standing in the open a
   * storey down is blindness. Both were shipped before this and both read as
   * bugs. Being on screen is the rule, because that is what a player means.
   *
   * Naming is `bodyNameFor`'s job, which already answers it for speech: a person
   * by the handle derived from their connection, a creature by what its tile is
   * called.
   *
   * Anchored on the top of the head rather than on the cell. Height moves a tile
   * up-*left* in this projection, 4px per unit, so a label placed straight above
   * the feet would drift off the shoulder of anything tall. Taking the actor's
   * own visual position and applying the same elevation shift its sprite gets
   * puts the name over the head of a two-unit player and a ten-unit one alike —
   * and, because that position already carries the walk lerp and the fall drop,
   * the name travels with the sprite instead of chasing it.
   *
   * Then lifted clear of the drawing by {@link labelHeadroomPx}, because a
   * declared height is not where the art stops. Straight up rather than up-left
   * with the elevation: the label is being moved off the sprite, not raised in
   * the world, and only the vertical of that shift is what a bar sitting on a
   * creature's back needs.
   */
  private pushNameLabels(
    snap: GameSnapshot,
    into: WorldLabel[],
    camera: { x: number; y: number },
    hideLevelsAbove: number | undefined,
  ) {
    for (const actor of snap.actors) {
      if (actor.hp === null || actor.maxHp === null) continue;
      if (!this.isVisibleBody(snap, actor, camera, hideLevelsAbove)) continue;

      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.movingTileHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      const name = bodyNameFor(
        { actorId: actor.id, tileId: actor.tileId },
        this.tilesById,
      );
      const fraction = healthFraction(actor.hp, actor.maxHp);
      into.push({
        id: `name:${actor.id}`,
        kind: "name",
        x: visual.x + head.x,
        y: visual.y + head.y - labelHeadroomPx(height),
        lines: [{ id: actor.id, text: name }],
        // The same painter's key the world would sort these two bodies by, so a
        // tag crossing another tag is stacked the way the creatures under them
        // are. Two labels are whole boxes at one depth each, which is what
        // `drawOrder` is for — the per-pixel depth the sprites get has no
        // meaning for a box of text hanging above them both.
        order: drawOrder(
          actor.x,
          actor.y,
          standingFootAbs(snap.map, this.tilesById, actor, actor.stackIndex),
          actor.stackIndex,
        ),
        // Tinted to match its own health, so the tag and the bar under it read
        // as one reading of one thing rather than as a yellow label that happens
        // to have a coloured strip beneath it.
        color: healthBarColor(fraction),
        // Always, even at full. A bar that appeared only once a creature had
        // been hit made its *absence* carry the meaning "unhurt" — which is a
        // thing you can only read if you already know the rule, and which looks
        // identical to a battler whose bar has not been drawn yet. A full green
        // track says the same thing to somebody seeing it for the first time,
        // and it means every battler on screen is measured on the same ruler.
        bar: { fraction },
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
    // No clearing of the anchor map here, though this used to: it is shared
    // with noises now, and a frame with nothing being said still has hisses in
    // it. Both are swept together by `forgetStaleAnchors` instead.
    if (snap.chats.length === 0) return;

    // Grouped by cell, in the order they arrived: the map preserves insertion
    // order, so the oldest at a cell is first and ends up at the top of the
    // column with the newest resting on the ground.
    const byCell = new Map<string, WorldLabel>();
    for (const chat of snap.chats) {
      const key = `${chat.x},${chat.y},${chat.z}`;
      const group = byCell.get(key);
      const line = {
        id: chat.id,
        text: `${bodyNameFor(chat, this.tilesById)} says: ${chat.text}`,
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

    for (const group of byCell.values()) into.push(group);
  }

  /**
   * Noises, hung where they were made and belonging to nobody.
   *
   * The one visible difference from speech, and the whole point of the channel:
   * **no name is written**. A bubble reads "Amethyst Piranha says: crunch"
   * because somebody said it; a noise is just the word, because the room heard
   * it and there is nobody to attribute it to. What is left is the same
   * cell-anchored, frozen, stacking column speech uses — so the two cannot drift
   * apart in how they sit in the world, only in what they claim.
   */
  private pushNoiseLabels(snap: GameSnapshot, into: WorldLabel[]) {
    if (snap.noises.length === 0) return;

    const byCell = new Map<string, WorldLabel>();
    for (const noise of snap.noises) {
      const key = `${noise.x},${noise.y},${noise.z}`;
      const group = byCell.get(key);
      // The text and nothing else. No `bodyNameFor`, no "says".
      const line = { id: noise.id, text: noise.text };
      if (group) {
        group.lines.push(line);
        continue;
      }
      const at = this.speechAnchor(noise, snap.map);
      byCell.set(key, {
        id: `noise:${key}`,
        kind: "noise",
        x: at.x,
        y: at.y,
        lines: [line],
      });
    }

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
    chat: { id: string; x: number; y: number; z: number; stackIndex: number },
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
   * Drop held anchors for anything that has expired — said or merely heard.
   *
   * Both channels in one sweep, because they share the map: keeping two of them
   * would be two chances to leak, and a sweep that knew about only one would
   * delete the other's anchors every frame the other was quiet. Run once a
   * frame, after both kinds have been collected.
   *
   * No size-based early-out beyond the empty case: one message expiring as
   * another arrives leaves the count unchanged while the contents differ, and a
   * cheap guard that is right only most of the time is worse than no guard at a
   * handful of entries.
   */
  private forgetStaleAnchors(snap: GameSnapshot) {
    if (this.speechAnchors.size === 0) return;
    const live = new Set<string>();
    for (const chat of snap.chats) live.add(chat.id);
    for (const noise of snap.noises) live.add(noise.id);
    for (const id of this.speechAnchors.keys()) {
      if (!live.has(id)) this.speechAnchors.delete(id);
    }
  }

  /**
   * Same signal as the outline, for the pointer. Looking gets `help` rather
   * than `pointer`: the object is not going to do anything if you click it, and
   * a hand that promises otherwise is the cursor lying about the mode.
   */
  private applyCursor() {
    if (this.lookMode) {
      this.setCursor(this.lookedAt ? "help" : "");
      return;
    }
    this.setCursor(this.pointerOption() ? "pointer" : "");
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
    this.enforceTargetVisibility(snap, camera);

    const anchor = viewAnchorFor(snap.self);
    const hideAbove = levelsAboveShouldHide(
      snap.map,
      this.tilesById,
      anchor,
    );

    // The list is built first because the pointer is *read out of it*: what is
    // under the cursor is a row, so resolving one against last frame's list
    // would outline a deer by the row it had before it moved.
    this.pushInteractionOptions(snap, camera, hideAbove ? anchor.z : undefined);
    this.repickPointer(snap, camera);

    // Worked out once and handed to both: the sprites are drawn with these
    // offsets and the outlines have to be drawn with the same ones, so sharing
    // the list is what keeps a silhouette on the thing it belongs to rather than
    // a step behind it.
    const motions = this.tileMotionsFor(snap);

    this.world.setView({
      map: snap.map,
      tilesById: this.tilesById,
      camera,
      zoom,
      minutesOfDay: this.minutesOfDay,
      tileMotions: motions.length > 0 ? motions : undefined,
      emitterOverrides: this.emitterOverridesFor(snap),
      hideLevelsAbove: hideAbove ? anchor.z : undefined,
    });

    this.world.setOverlays(this.overlaysFor(snap, motions));
    this.pushEquipment(snap);
    this.pushOpenedContainer(snap);
    // Written from inside the render loop's own rAF, so the style change and the
    // canvas paint land in the same commit — which is what stops DOM text from
    // trailing the sprite it belongs to.
    const ceiling = hideAbove ? anchor.z : undefined;
    this.labelLayer?.set(
      this.labelsFor(snap, camera, ceiling),
      camera,
      fit.cssScale,
    );
    this.damageLayer?.set(
      this.damageFor(snap, ceiling),
      camera,
      fit.cssScale,
    );
    // Driven by the frame, not the pointer: walking away from an object
    // revokes the affordance without the pointer having moved at all.
    this.applyCursor();
  }

  /**
   * Hand the list of available interactions out, when it has actually moved.
   *
   * Two gates, and they answer different questions. The first is whether the
   * answer *could* have changed: everything in the list is a function of the
   * board, the player's cell and who they are fighting, so identity on the
   * first two and equality on the third make standing still free — which is
   * most frames. The second is whether it *did*, because the map gets a new
   * identity on every commit anywhere in the world, and somebody walking across
   * the room must not re-render this page.
   *
   * The camera is not in the first gate even though the list depends on it,
   * because it is derived from the player's own position: it slides during a
   * walk and settles where the cell says. The cost is that a body crossing the
   * edge of the view is listed at the next commit rather than the next frame,
   * which is 200ms at the one place on screen nobody is looking.
   *
   * Health *is* in the first gate, and has to be: a row carries the reading its
   * subject's bar carries, and nothing else in that gate moves when somebody
   * takes a hit. Standing still trading blows is exactly the case the list is
   * being read in, and it is the one case the position gate calls free.
   */
  private pushInteractionOptions(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    hideLevelsAbove: number | undefined,
  ) {
    if (!this.onInteractions) return;

    // Equipment is in the key because a full bag and an empty one offer
    // different rows on the same board from the same cell: pick-up is gated on
    // having somewhere to put the thing. Identity, not contents — the session
    // replaces the kit rather than mutating it, which is what makes that sound.
    // The opened box is in the key for the same reason the target is: it is a
    // state a row is *named* for, so opening one renames a row without anything
    // on the board having moved.
    const box = this.openedRef;
    const opened = box ? `${box.x},${box.y},${box.z},${box.stackIndex}` : "";
    const at = `${snap.self.x},${snap.self.y},${snap.self.z},${snap.targetId},${opened}`;
    const health = healthSignature(snap.actors);
    if (
      snap.map === this.interactionsMap &&
      at === this.interactionsAt &&
      health === this.interactionsHealth &&
      snap.equipment === this.interactionsEquipment &&
      snap.tags === this.interactionsTags
    ) {
      return;
    }
    this.interactionsEquipment = snap.equipment;
    this.interactionsTags = snap.tags;
    this.interactionsMap = snap.map;
    this.interactionsAt = at;
    this.interactionsHealth = health;

    const options = listInteractionOptions(
      snap.map,
      this.tilesById,
      snap.self,
      this.targetableActors(snap, camera, hideLevelsAbove),
      snap.targetId,
      snap.equipment,
      this.openedRef,
      snap.tags,
    );
    // Held whether or not it is handed on, because the *references* inside it go
    // stale even when the list reads the same: a walking deer keeps its row and
    // changes cell, and the hover outline follows the reference.
    this.interactionsSent = options;
    const key = options
      .map((o) => `${o.id}/${o.active}/${o.health?.hp ?? ""}`)
      .join("|");
    if (key === this.interactionsKey) return;
    this.interactionsKey = key;
    this.onInteractions(options);
  }

  /**
   * Bodies the viewer could pick a fight with: the ones they can see.
   *
   * Picking a target is pointing at somebody, so the bound is what is drawn
   * rather than what is in reach — {@link isVisibleBody}, the same rule the name
   * tags use, since a body worth naming is exactly a body worth choosing.
   * Whether a blow can actually land is the server's question and is asked at
   * the swing; a target you cannot yet reach is a target you are walking towards.
   *
   * This is also the one list every *body's* name and health reaches the UI
   * through, so the same gate is what keeps a rat behind a cave ceiling
   * anonymous — a shove at it is still offered and still says "Push Rat",
   * because that much is readable from its tile, but who it is and how hurt it
   * is are not.
   *
   * Whoever is already being fought is kept regardless: they can step onto a
   * floor the roof-cut hides, and dropping their row would leave a touch player
   * in a fight with no way out of it.
   */
  private targetableActors(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    hideLevelsAbove: number | undefined,
  ): ActorSnapshot[] {
    return snap.actors.filter(
      (actor) =>
        actor.id === snap.targetId ||
        this.isVisibleBody(snap, actor, camera, hideLevelsAbove),
    );
  }

  /**
   * This frame's damage numbers, anchored where each blow landed.
   *
   * The anchor is the *cell*, not the body: a killing blow deletes its target on
   * the same tick, so a number that followed the actor would vanish exactly when
   * it mattered most.
   *
   * **And it is frozen the first frame the number is seen**, exactly as a speech
   * anchor is. This used to be recomputed every frame, on the reasoning that a
   * number lives under a second and so could not outlive the ground beneath it.
   * That was wrong, and visibly so: the height comes from the *scenery* in the
   * cell, so stepping out of the cell you were just hit in takes your own body
   * out of that stack and the number you are still reading drops by your own
   * height. The damage happened at a height, and a receipt for it has no
   * business riding later edits to the floor it was printed over.
   *
   * Filtered to the floors this client is drawing, because the wire carries every
   * blow struck anywhere in the world: without this a fight two storeys down
   * would rain numbers over the room you are standing in.
   */
  private damageFor(
    snap: GameSnapshot,
    hideLevelsAbove: number | undefined,
  ): DamageNumberView[] {
    if (snap.damage.length === 0) return [];

    const out: DamageNumberView[] = [];
    for (const hit of snap.damage) {
      if (!this.isVisibleLevel(snap, hit.z, hideLevelsAbove)) continue;

      const at = this.damageAnchor(hit, snap.map);
      out.push({
        id: hit.id,
        x: at.x,
        y: at.y,
        amount: hit.amount,
        own: hit.targetId === snap.self.id,
        elapsedMs: hit.elapsedMs,
      });
    }
    this.forgetStaleDamageAnchors(snap);
    return out;
  }

  /**
   * Where a damage number hangs, worked out once and then held.
   *
   * Read at the height the blow landed at — the ground in that cell plus the
   * struck body's own height, so the figure comes off the head of whatever took
   * it — and then never asked again. Both halves of that matter; see
   * {@link damageFor} for what recomputing it did.
   */
  private damageAnchor(
    hit: DamageNumber,
    map: MapFile,
  ): { x: number; y: number } {
    const held = this.damageAnchors.get(hit.id);
    if (held) return held;

    const ground = this.cellWorldCenter(
      hit.x,
      hit.y,
      hit.z,
      map,
      hit.stackIndex,
    );
    const head = elevationScreenOffset(
      this.movingTileHeight(map, hit, hit.stackIndex),
    );
    const at = { x: ground.x + head.x, y: ground.y + head.y };
    this.damageAnchors.set(hit.id, at);
    return at;
  }

  /** Drop held anchors for numbers that have finished rising. */
  private forgetStaleDamageAnchors(snap: GameSnapshot) {
    if (this.damageAnchors.size === 0) return;
    const live = new Set(snap.damage.map((hit) => hit.id));
    for (const id of this.damageAnchors.keys()) {
      if (!live.has(id)) this.damageAnchors.delete(id);
    }
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
    //
    // The body asks whether the tile can *ever* emit, not what it is emitting
    // this instant: that override is a position, and the light itself is
    // resolved from the stack against the animation clock when it is painted.
    // Asking for the live frame's light would drop the override on the dark
    // half of a flicker and stop the light coming back. It is also no longer a
    // per-actor question, since facing does not change whether a tile emits.
    const bodyEmits = tileCanEmitLight(playerDef);
    const overrides: EmitterOverride[] = [];
    for (const actor of snap.actors) {
      const carried = this.carriedLightsFor(actor);
      if (!bodyEmits && !carried) continue;
      const at = this.actorEmitter(snap.map, actor, playerDef.height ?? 0);
      // The body's own light is found by reading the stack it is standing in,
      // which is what an override has always meant. What is in the bag is not in
      // any stack, so it travels on a second override at the same position — the
      // cast accumulates, and one lantern at your hip lights exactly like one
      // lantern at your hip.
      if (bodyEmits) overrides.push(at);
      if (carried) overrides.push({ ...at, lights: carried });
    }
    return overrides.length > 0 ? overrides : undefined;
  }

  /**
   * The lights this actor is carrying, or undefined for the usual case of none.
   *
   * Undefined rather than an empty array on purpose: this runs per actor per
   * frame, and almost nobody is carrying a torch. Resolving the tile ids here
   * rather than sending `LightDef`s over the wire is the same trade the whole
   * protocol makes — every client already holds the catalogue.
   *
   * Resolved against the renderer's animation clock, like every other light.
   * Carried lights are the one kind that arrives at the cast already resolved —
   * there is no cell to read them from later — so if this took frame 0 a torch
   * would flicker on the floor and burn flat the moment it went in a bag.
   */
  private carriedLightsFor(actor: ActorSnapshot): LightDef[] | undefined {
    if (actor.carriedLights.length === 0) return undefined;
    const lights: LightDef[] = [];
    for (const tileId of actor.carriedLights) {
      const def = this.tilesById[tileId];
      if (!def) continue;
      const light = resolveLight(
        def,
        { direction: actor.direction },
        this.world.animTimeMs,
      );
      if (light) lights.push(light);
    }
    return lights.length > 0 ? lights : undefined;
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
  private tileMotionsFor(snap: GameSnapshot): TileMotion[] {
    const motions: TileMotion[] = [];
    // Every actor, not just the viewer: a shove by someone across the room has
    // to animate here too, or their crate teleports.
    for (const actor of snap.actors) {
      const slide = this.slideMotion(snap.map, actor);
      if (slide) motions.push(slide);

      const own = this.actorMotion(snap.map, actor);
      if (own) motions.push(own);
    }

    // Always a list, empty or not: the caller hands it to two consumers, and one
    // of them wants to search it rather than pass it along.
    return motions;
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

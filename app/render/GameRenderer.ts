import {
  absoluteElevation,
  baseCellWorldOrigin,
  CELL_CENTRE,
  depthBox,
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
import { bodyNameFor, sizedUpName } from "../game/displayName";
import type { Equipment } from "../game/equipment";
import type { Conversation } from "../game/dialogRuntime";
import type { MasteryXp } from "../lib/mastery";
import { weaponDemandFor } from "../lib/weaponDemand";
import type { Vitals } from "../game/GameSession";
import { statusReading } from "../game/statuses";
import { type SpellButton, spellReading } from "../game/casting";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import { readOpenedContainer } from "../game/openedContainer";
import {
  applyInteraction,
  interactionText,
  listInteractionOptions,
  topInteractionAt,
  type InteractionOption,
} from "../game/interactionOptions";
import type { ExtractCooling } from "../game/extract";
import { describedNearby } from "./nearbyDescriptions";
import { WorldLabelLayer, type WorldLabel } from "./textLabels";
import { FrameProfiler, type FrameStats } from "./frameProfile";
import { fallDropPx, fallFootAbs, standingFootAbs } from "./fallAnchor";
import { slideTileMotions } from "./slideMotion";
import { projectileViews } from "./projectileMotion";
import { strikeOffset } from "./strikeMotion";
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
import { elevationAt, getStack, stackHeight } from "../lib/mapData";
import { pileTally } from "../lib/piles";
import {
  type RoofCut,
  type ViewAnchor,
  cutHides,
  roofCutFor,
  cutProbeChunks,
  sameProbeChunks,
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
import { clumpExtentAt, steppingClumpHeight } from "./depthClump";
import { resolveLight } from "../lib/tileResolve";
import { tilesByIdFromList } from "../lib/validation";
import {
  type OverlaySpec,
  type TileMotion,
  tileInstanceKey,
  WorldRenderer,
} from "./WorldRenderer";
import type { ParticleEmitterSpec } from "./particles";
import type { StatusDef } from "../lib/status";
import {
  taperAt,
  taperedGlow,
  taperedTint,
  type StatusTint,
} from "../lib/statusVfx";
import { SmoothedRemaining, taperKey } from "./statusTaper";
import { spriteStatesFor } from "./spriteState";
import {
  pickBattlerAt,
  pickInteractiveAt,
  pickTileAt,
} from "./pick";
import { DamageNumberLayer, type DamageNumberView } from "./damageNumbers";
import { NoticeQueue, NotificationLayer } from "./notifications";
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

/**
 * Floors above and below the viewer that a pick can reach.
 *
 * One constant for looking, hovering and clicking, because a thing you can name
 * and a thing you can touch have to be the same set: an object reachable by one
 * pick and not the other reads as the outline lying about what a click will do.
 */
const PICK_LEVEL_SLACK = 1;

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
  /**
   * The status catalogue, for what statuses *look* like and nothing else.
   *
   * The simulation has its own copy and reads the formulas off it; this one is
   * only ever asked for `vfx`. Held rather than reached through the session
   * because the online session is a socket with no catalogue behind it, and both
   * routes already resolve one to draw the strip with — see `routes/play`.
   *
   * Empty until {@link setStatuses}, which is the honest state for a renderer
   * built before its route has finished loading: no tint, no plume, and a world
   * that draws exactly as it did before this feature existed.
   */
  private statusDefs: Record<string, StatusDef> = {};
  /**
   * Remaining time per running status, carried between the wire's updates.
   *
   * A wind-down is drawn from what a status has left, and online that arrives
   * about once a second — see `./statusTaper`.
   */
  private readonly remaining = new SmoothedRemaining();
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
  private onConversation: ((conversation: Conversation | null) => void) | null = null;
  /** Undefined until the first push, so a closed panel still gets reported once. */
  private conversationSent: Conversation | null | undefined = undefined;
  private onVitals: ((vitals: Vitals) => void) | null = null;
  /**
   * The last vitals handed on, compared field by field rather than by identity.
   *
   * Unlike a kit, `snap.self` is rebuilt every frame, so there is no reference to
   * compare — and unlike a kit these are three small numbers, which makes
   * comparing them cheaper than the render they would otherwise trigger sixty
   * times a second.
   */
  private vitalsSent: Vitals | null = null;
  private onMasteries: ((masteryXp: MasteryXp) => void) | null = null;
  private onSpells: ((spells: SpellButton[]) => void) | null = null;
  /**
   * What the row of spell buttons last *said*, as a string.
   *
   * By reading rather than by identity, unlike the kit above and for the reason
   * the vitals below are: the answer is recomputed from scratch every frame —
   * castability depends on where two bodies are standing — so there is no
   * reference to compare. What a button can actually show is its sprite, whether
   * it is dimmed, and a countdown to the second, so that is the grain worth
   * comparing at. @see ../game/casting's `spellReading`
   */
  private spellsSent: string | null = null;
  /**
   * Identity of the last block of experience handed on.
   *
   * The same compare the kit gets, and it works for the same reason: the session
   * replaces the block rather than adding to it, so a frame on which nobody
   * landed a blow is one reference comparison.
   */
  private masteriesSent: MasteryXp | null = null;
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
  /**
   * Which resources the viewer was waiting on when the list was last built.
   *
   * In the gate on exactly the tags' terms, and it is the one signal a resource
   * row has in either direction: working a bush changes the board, but the
   * *wait* coming to an end changes nothing anybody can see — the map keeps its
   * identity, nobody has moved, and without this the row would stay hidden until
   * something else happened.
   *
   * Identity rather than contents, because the session replaces the list only
   * when the *set* changes and winds the entries in place in between — so this
   * fires when a row starts or stops waiting and never on the ticks that merely
   * advance one. See `GameSnapshot.extractCooling`.
   */
  private interactionsCooling: readonly ExtractCooling[] | null = null;
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
  private notificationLayer: NotificationLayer | null = null;
  /**
   * The lines waiting to be read at the foot of the view.
   *
   * Held whether or not there is anywhere to draw them, unlike the layer beside
   * it: the queue is where a notice's lifetime is counted, and a renderer built
   * without a text layer would otherwise silently discard the level-up that
   * happened while it was not looking.
   */
  private readonly notices = new NoticeQueue();
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
      this.notificationLayer = new NotificationLayer(labelContainer);
    }
    this.attachPointer();
    this.attachKeys();
  }

  /**
   * Set the clock. Online this is the server's reading, taken on `hello`; the
   * local rate carries it from there, so one anchor keeps every client in step
   * for as long as the tab is open.
   */
  /**
   * Hand over the status catalogue, so a poisoned body can be drawn poisoned.
   *
   * Separate from the constructor because it is not needed to draw a frame: a
   * renderer with no catalogue draws an untinted world, which is the right
   * answer while one is still loading and the right answer forever for a world
   * that authored no effects.
   */
  setStatuses(defs: Record<string, StatusDef>) {
    this.statusDefs = defs;
  }

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
   * Where the viewer is in a conversation, when it changes.
   *
   * Identity-gated on the kit's terms: the session replaces the whole object
   * on every press and never mutates one, so a player reading a line costs one
   * reference compare per frame.
   */
  setOnConversation(cb: ((conversation: Conversation | null) => void) | null) {
    this.onConversation = cb;
    this.conversationSent = undefined;
  }

  private pushConversation(snap: GameSnapshot) {
    if (!this.onConversation) return;
    if (snap.conversation === this.conversationSent) return;
    this.conversationSent = snap.conversation;
    this.onConversation(snap.conversation);
  }

  setOnVitals(cb: ((vitals: Vitals) => void) | null) {
    this.onVitals = cb;
    // Dropped so the next frame reports to a fresh listener, exactly as the kit
    // and the masteries are.
    this.vitalsSent = null;
  }

  private pushVitals(snap: GameSnapshot) {
    if (!this.onVitals) return;
    const next: Vitals = {
      hp: snap.self.hp,
      maxHp: snap.self.maxHp,
      rating: snap.self.rating,
      statuses: snap.self.statuses,
    };
    const sent = this.vitalsSent;
    if (
      sent &&
      sent.hp === next.hp &&
      sent.maxHp === next.maxHp &&
      sent.rating === next.rating &&
      // By reading rather than by identity: the status list is a fresh array on
      // every tick a status is running, so an identity check here would push a
      // new object thirty times a second and re-render the panel with it. What
      // the chrome can actually show is whole seconds, so that is the grain the
      // comparison works at — one push a second per status, and the number on
      // screen is always exact without a timer of its own.
      statusReading(sent.statuses) === statusReading(next.statuses)
    ) {
      return;
    }
    this.vitalsSent = next;
    this.onVitals(next);
  }

  setOnMasteries(cb: ((masteryXp: MasteryXp) => void) | null) {
    this.onMasteries = cb;
    // Dropped so the next frame reports to a fresh listener, exactly as the kit
    // and the interaction gates are.
    this.masteriesSent = null;
  }

  private pushMasteries(snap: GameSnapshot) {
    if (!this.onMasteries) return;
    if (snap.masteryXp === this.masteriesSent) return;
    this.masteriesSent = snap.masteryXp;
    this.onMasteries(snap.masteryXp);
  }

  /**
   * Which stones can be pressed, whenever that changes.
   *
   * Asked of the session rather than read off the snapshot, because it is not a
   * fact about the board: what a caster can do depends on their kit, their
   * target and what they have learnt, and only whichever end owns the session
   * can put those together. @see PlaySession.spells
   *
   * Routed through the render loop like the kit and the vitals, for the reason
   * they are: this loop is already reading a fresh answer every frame and is
   * the only thing that knows when one arrived.
   */
  setOnSpells(cb: ((spells: SpellButton[]) => void) | null) {
    this.onSpells = cb;
    // Dropped so the next frame reports to a fresh listener even though nothing
    // has changed, exactly as the other gates are.
    this.spellsSent = null;
  }

  private pushSpells() {
    if (!this.onSpells) return;
    const spells = this.session.spells();
    const reading = spellReading(spells);
    if (reading === this.spellsSent) return;
    this.spellsSent = reading;
    this.onSpells(spells);
  }

  /**
   * Put up anything the game has to say in words, and age what is already up.
   *
   * **Nothing is worked out here.** Every sentence is composed where the thing
   * it describes happened — a reward as it is handed over, a mastery as the
   * experience that crossed it is written — and arrives through
   * `PlaySession.drainNotices`: the session's own queue in single-player, and
   * the addressed `notice` message online. @see ../game/notices
   *
   * The level-up line used to be a diff taken here, across successive
   * `masteryXp` blocks, and it is worth knowing why it is not: reconstructing an
   * event from state meant holding a private copy of the last block, gating on
   * `hasExperience` so the empty block held before `hello` was not read as a
   * lifetime of level-ups, and being careful that a re-registered listener did
   * not replay them. All of it existed to guess at something the session knew
   * exactly. A renderer draws; it does not infer what happened.
   *
   * The layer is written every frame whether or not anything arrived, because a
   * notice also has to *leave*, and nothing else in the loop knows when its four
   * seconds are up.
   */
  private pushNotices(nowMs: number) {
    for (const text of this.session.drainNotices()) {
      this.notices.push(text, nowMs);
    }
    this.notificationLayer?.set(this.notices.live(nowMs));
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
    this.interactionsCooling = null;
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
      this.profiler.measure("view", () => this.pushView(now, dt));
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
    this.onSpells = null;
    this.onOpenedContainer = null;
    this.onInteractions = null;
    this.stop();
    this.detachPointer();
    this.detachKeys();
    this.labelLayer?.dispose();
    this.labelLayer = null;
    this.damageLayer?.dispose();
    this.damageLayer = null;
    this.notificationLayer?.dispose();
    this.notificationLayer = null;
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
      point.x,
      point.y,
      snap.self.z,
      PICK_LEVEL_SLACK,
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
   * pick has no way to know otherwise, but the camera is centred on it — so the
   * pointer sits on top of it constantly, and an outline that lights up whenever
   * the mouse crosses the middle of the screen is noise around something the
   * session refuses to target anyway.
   */
  private battlerAt(
    point: { x: number; y: number },
    snap: GameSnapshot,
  ): ObjectRef | null {
    const found = pickBattlerAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas).cssScale,
      },
      point.x,
      point.y,
      snap.self.z,
      PICK_LEVEL_SLACK,
    );
    if (!found) return null;
    return this.actorIdAt(found, snap) === snap.self.id ? null : found;
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
      PICK_LEVEL_SLACK,
      this.roofCutFor(snap),
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

  /**
   * Chrome for the current frame: a silhouette around the object under the
   * pointer. The session only reports a hover the player can actually act on,
   * so the outline *is* the affordance — an object that will not budge simply
   * never lights up, and no second cue is needed to explain why.
   */
  private overlaysFor(snap: GameSnapshot): OverlaySpec[] {
    const outline = (
      ref: ObjectRef,
      color: number,
      pulse = false,
    ): OverlaySpec => ({
      kind: "objectOutline",
      ...ref,
      color,
      pulse,
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
    at: { x: number; y: number; z: number },
    cut: RoofCut | undefined,
  ): boolean {
    if (cutHides(cut, at.x, at.y, at.z)) return false;
    return Math.abs(at.z - snap.self.z) <= CHROME_LEVEL_SLACK;
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
    cut: RoofCut | undefined,
  ): boolean {
    // The roof-cut, which is exact — anything above it is not drawn at all.
    // Deliberately *without* {@link CHROME_LEVEL_SLACK}, which the rest of the
    // chrome still leans on: that slack exists only because there was no cheap
    // answer for a body drawn behind the floors below you, and there now is one.
    // Approximating a floor's worth of doubt on top of an exact answer would
    // only take back the cases the exact answer got right.
    if (cutHides(cut, actor.x, actor.y, actor.z)) return false;
    if (!this.isWithinView(snap.map, actor, camera)) return false;
    return !isHiddenFromCamera(
      snap.map,
      this.tilesById,
      actor,
      snap.self.z,
      cut,
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
   * All of it is produced here because it is all anchored in world pixels and
   * handed to the same layer, which turns them into screen positions. Names are
   * keyed by actor, speech by message id and a read sign by its slot, so none of
   * them can collide in the element cache.
   *
   * The pointer goes in before the signs around it: the layout pass keeps the
   * order it was handed within a kind, and the thing you are actually pointing
   * at is the one that must survive a crowded view.
   */
  private labelsFor(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    cut: RoofCut | undefined,
  ): WorldLabel[] {
    const labels: WorldLabel[] = [];
    this.pushNameLabels(snap, labels, camera, cut);
    this.pushSpeechLabels(snap, labels);
    this.pushNoiseLabels(snap, labels);
    this.forgetStaleAnchors(snap);
    this.pushPointerLabel(snap, labels);
    this.pushNearbyDescriptionLabels(snap, labels);
    return labels;
  }

  /**
   * What the things you are standing among say, in the same blue a look wears.
   *
   * Same colour and same anchor as a look on purpose — it is the same fact about
   * the same placement, arrived at without being asked. What it drops is the
   * name line: see `./nearbyDescriptions`, which owns the rule for who speaks.
   *
   * A placement being looked at is skipped, because the look label is already
   * saying its words: drawn as well, the layout pass would sit one description
   * above an identical one and read as a stutter.
   */
  private pushNearbyDescriptionLabels(snap: GameSnapshot, into: WorldLabel[]) {
    for (const near of describedNearby(snap.map, this.tilesById, snap.self)) {
      if (this.lookMode && sameRef(near.ref, this.lookedAt)) continue;

      const { x, y, z, stackIndex } = near.ref;
      const ground = this.cellWorldCenter(x, y, z, snap.map, stackIndex);
      const head = elevationScreenOffset(near.height);

      into.push({
        id: `described:${x},${y},${z},${stackIndex}`,
        kind: "look",
        x: ground.x + head.x,
        y: ground.y + head.y,
        lines: [{ id: "description", text: near.text }],
      });
    }
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

  /**
   * What look mode says: the tile's name, what the placement reads, and — for a
   * weapon — what it asks of you and what you are getting out of it.
   *
   * The demand goes last because it is the only part that is not a fact about
   * the object: the name and the writing on it are the same for everybody who
   * walks past, where "Blade 20 — you have 12" is about the person doing the
   * looking. See `../lib/weaponDemand` for why it is a table of numbers rather
   * than the sentence it replaced.
   */
  private lookLines(snap: GameSnapshot): PointerLabel | null {
    const target = this.lookTarget(snap);
    if (!target) return null;
    const { ref, placed, def } = target;
    // The count on the name line, exactly where a bag square puts it — a pile of
    // berries on the floor and the same pile in your hand are one thing being
    // asked one question. See `../lib/piles`' `pileTally`.
    const tally = pileTally(placed);
    const lines = [
      { id: "name", text: tally ? `${def.name} ${tally}` : def.name },
    ];
    if (placed.description) {
      lines.push({ id: "description", text: placed.description });
    }
    for (const [index, text] of weaponDemandFor(def, snap.masteryXp).entries()) {
      lines.push({ id: `demand-${index}`, text });
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
    cut: RoofCut | undefined,
  ) {
    for (const actor of snap.actors) {
      if (actor.hp === null || actor.maxHp === null) continue;
      if (!this.isVisibleBody(snap, actor, camera, cut)) continue;

      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.bodyOwnHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      const name = bodyNameFor(
        { actorId: actor.id, tileId: actor.tileId },
        this.tilesById,
      );
      // Look mode, and not the target: a rating you only see once you have
      // committed to the fight arrived too late to be any use. Holding shift is
      // the question being asked.
      const sized = sizedUpName(name, actor.rating, this.lookMode);
      const fraction = healthFraction(actor.hp, actor.maxHp);
      into.push({
        id: `name:${actor.id}`,
        kind: "name",
        x: visual.x + head.x,
        y: visual.y + head.y - labelHeadroomPx(height),
        lines: [{ id: actor.id, text: sized }],
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
   * What the view cuts away, asked once and reused for the rest of the frame.
   *
   * **Cached on the map and the anchor, and on nothing else.** Those are the
   * only two things the answer depends on: `MapFile` is copy-on-write, so any
   * edit anywhere in the world hands us a new object and the cut is recomputed,
   * and the anchor changes when the player takes a step. Everything else that
   * moves in a frame — an arrow, a rat, the clock — cannot change which
   * structure is between the player and the sky.
   *
   * Worth caching at all because the cut is a flood fill over one building
   * rather than the old boolean probe, and three callers ask for it in a frame:
   * the pointer pick, the view push, and the labels behind it. Held on the
   * renderer rather than inside `roofCutFor` so the identity is stable, which is
   * what lets `WorldRenderer.applyRoofCut` skip a frame that changed nothing.
   */
  private cutCache: {
    map: MapFile;
    anchor: ViewAnchor;
    cut: RoofCut | undefined;
    /** The chunks the probe read, so a distant edit does not re-run it. */
    probe: readonly unknown[];
  } | null = null;

  /**
   * The frame's roof cut, re-derived only when it can have changed.
   *
   * **Keyed on the map the probe actually reads, never on the whole map.** Map
   * identity changes whenever any cell anywhere does, and a world with a couple
   * of hundred creatures in it changes on almost every tick — so a cache keyed
   * that way misses constantly and the cut is rebuilt every frame. Underground
   * that is not cheap: the seeds are the rock over your head, the fill spreads
   * 26-way through every touching cell of it, and it walks `MAX_CUT_CELLS`
   * before giving up and cutting the whole storey. Measured while walking the
   * den, that was 10.7ms of every frame — as much as the map, the light and the
   * draw together.
   *
   * `cutProbeChunks` says what the question depends on, and the comment there
   * says what it deliberately leaves out.
   */
  private roofCutFor(snap: GameSnapshot): RoofCut | undefined {
    const anchor = viewAnchorFor(snap.self);
    const cached = this.cutCache;
    const sameAnchor =
      cached !== null &&
      cached.anchor.x === anchor.x &&
      cached.anchor.y === anchor.y &&
      cached.anchor.z === anchor.z;
    if (sameAnchor && cached.map === snap.map) return cached.cut;

    const probe = cutProbeChunks(snap.map, anchor);
    if (sameAnchor && sameProbeChunks(cached.probe, probe)) {
      // Nothing the cut reads has moved. Record the map it was confirmed
      // against so the next frame takes the identity check above instead.
      this.cutCache = { ...cached, map: snap.map };
      return cached.cut;
    }

    const cut = roofCutFor(snap.map, this.tilesById, anchor);
    this.cutCache = { map: snap.map, anchor, cut, probe };
    return cut;
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

  private pushView(nowMs: number, dtMs: number) {
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

    const cut = this.roofCutFor(snap);

    // The list is built first because the pointer is *read out of it*: what is
    // under the cursor is a row, so resolving one against last frame's list
    // would outline a deer by the row it had before it moved.
    this.pushInteractionOptions(snap, camera, cut);
    this.repickPointer(snap, camera);

    const motions = this.tileMotionsFor(snap);
    const vfx = this.statusVfxFor(snap, dtMs);

    this.world.setView({
      map: snap.map,
      tilesById: this.tilesById,
      camera,
      zoom,
      minutesOfDay: this.minutesOfDay,
      tileMotions: motions.length > 0 ? motions : undefined,
      // Undefined rather than an empty list on the overwhelmingly common frame
      // where nothing is in the air, so the renderer can skip the pass outright
      // — the same shape `tileMotions` above takes, and `spriteStates` below.
      projectiles:
        snap.projectiles.length > 0
          ? projectileViews(snap.projectiles)
          : undefined,
      spriteStates: spriteStatesFor(snap.actors),
      emitterOverrides: this.emitterOverridesFor(snap),
      spriteTints: vfx.tints,
      particleEmitters: vfx.emitters,
      roofCut: cut,
    });

    this.world.setOverlays(this.overlaysFor(snap));
    this.pushEquipment(snap);
    this.pushConversation(snap);
    this.pushMasteries(snap);
    this.pushSpells();
    this.pushNotices(nowMs);
    this.pushVitals(snap);
    this.pushOpenedContainer(snap);
    // Written from inside the render loop's own rAF, so the style change and the
    // canvas paint land in the same commit — which is what stops DOM text from
    // trailing the sprite it belongs to.
    this.labelLayer?.set(
      this.labelsFor(snap, camera, cut),
      camera,
      fit.cssScale,
    );
    this.damageLayer?.set(this.damageFor(snap, cut), camera, fit.cssScale);
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
    cut: RoofCut | undefined,
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
    // The stance is in the key for the same reason the target and the opened box
    // are: it is a state a row is *named* for — "Target Rat" against "Attack
    // Rat" — so drawing a sword renames a row without anything on the board
    // having moved.
    // The conversation is in the key for the reason the target is: the Talk
    // row reads as lit while its body is the one you are talking to.
    const talking = snap.conversation?.npcId ?? "";
    const at = `${snap.self.x},${snap.self.y},${snap.self.z},${snap.targetId},${opened},${snap.attacking},${talking}`;
    const health = healthSignature(snap.actors);
    if (
      snap.map === this.interactionsMap &&
      at === this.interactionsAt &&
      health === this.interactionsHealth &&
      snap.equipment === this.interactionsEquipment &&
      snap.tags === this.interactionsTags &&
      snap.extractCooling === this.interactionsCooling
    ) {
      return;
    }
    this.interactionsEquipment = snap.equipment;
    this.interactionsTags = snap.tags;
    this.interactionsCooling = snap.extractCooling;
    this.interactionsMap = snap.map;
    this.interactionsAt = at;
    this.interactionsHealth = health;

    const options = listInteractionOptions(
      snap.map,
      this.tilesById,
      snap.self,
      this.targetableActors(snap, camera, cut),
      snap.targetId,
      snap.equipment,
      this.openedRef,
      snap.tags,
      snap.attacking,
      // Built here rather than carried on the snapshot, because a lookup is a
      // shape only the rules want: the session replaces the *list* wholesale so
      // that its identity can be the change signal, and this is the one place
      // that turns one into the other — on the frames the gate above let
      // through, which is twice a pull rather than sixty times a second. The
      // entries are shared rather than copied, so a wait wound in place is
      // wound here too.
      new Map(snap.extractCooling.map((entry) => [entry.key, entry])),
      snap.conversation,
    );
    // Held whether or not it is handed on, because the *references* inside it go
    // stale even when the list reads the same: a walking deer keeps its row and
    // changes cell, and the hover outline follows the reference.
    this.interactionsSent = options;
    // **Everything the row draws, and the label is part of that.** The key is
    // what decides whether React hears about the new list at all, so anything
    // visible that is missing from it is a change that silently never arrives:
    // drawing a sword renames a body's row without moving anything on the board,
    // so an id-and-health key would have recomputed the right words and then
    // refused to hand them over.
    const key = options
      .map(
        (o) =>
          // The *presence* of a wait and never how much is left, which is the
          // one thing in a row that moves continuously. Included because a row
          // going grey is a visible change nothing else in this key would
          // catch; excluded as a number because the remainder changes every
          // frame, and a key that carried it would hand React a new list thirty
          // times a second to redraw a bar that CSS is already animating.
          `${o.id}/${o.label}/${o.active}/${o.health?.hp ?? ""}/${o.blocked?.kind ?? ""}`,
      )
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
    cut: RoofCut | undefined,
  ): ActorSnapshot[] {
    return snap.actors.filter(
      (actor) =>
        actor.id === snap.targetId ||
        this.isVisibleBody(snap, actor, camera, cut),
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
    cut: RoofCut | undefined,
  ): DamageNumberView[] {
    if (snap.damage.length === 0) return [];

    const out: DamageNumberView[] = [];
    for (const hit of snap.damage) {
      if (!this.isVisibleLevel(snap, hit, cut)) continue;

      const at = this.damageAnchor(hit, snap.map);
      out.push({
        id: hit.id,
        x: at.x,
        y: at.y,
        outcome: hit.outcome,
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
      this.bodyOwnHeight(map, hit, hit.stackIndex),
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
  /**
   * What every body on the board is wearing and emitting this frame.
   *
   * Both halves come out of one sweep because they are read off the same list —
   * a body's statuses — and separating them would mean resolving every status
   * def twice per actor per frame for no gain.
   *
   * Returns undefined for each half that is empty, which is the shape
   * {@link WorldView.tileMotions} takes and for the same reason: a world where
   * nobody is under anything is the overwhelmingly common one, and it should
   * cost the renderer a null check rather than an empty map.
   */
  private statusVfxFor(
    snap: GameSnapshot,
    dtMs: number,
  ): {
    tints: ReadonlyMap<string, StatusTint> | undefined;
    emitters: ParticleEmitterSpec[] | undefined;
  } {
    let tints: Map<string, StatusTint> | undefined;
    let emitters: ParticleEmitterSpec[] | undefined;
    this.remaining.beginFrame(dtMs);

    for (const actor of snap.actors) {
      if (actor.statuses.length === 0) continue;

      let strongest: StatusTint | null = null;

      for (const instance of actor.statuses) {
        const vfx = this.statusDefs[instance.defId]?.vfx;
        if (!vfx) continue;

        const taper = taperAt(
          this.remaining.read(
            taperKey(actor.id, instance.defId),
            instance.remainingMs,
          ),
          vfx.taperMs,
        );

        // Two statuses that both colour a body cannot both be worn — a tint is
        // one uniform — so the loudest wins. Not a blend: mixing purple poison
        // with amber burn gives a brown nobody authored, and "the worse thing
        // showing" is the reading a player can act on.
        //
        // Compared *after* the taper, so a status that is nearly over stops
        // outranking one that has just landed.
        if (vfx.tint) {
          const worn = taperedTint(vfx.tint, taper);
          if (!strongest || worn.strength > strongest.strength) strongest = worn;
        }
        if (!vfx.particles) continue;
        (emitters ??= []).push(
          this.emitterFor(snap, actor, instance.defId, vfx.particles, taper),
        );
      }

      if (strongest) {
        (tints ??= new Map()).set(
          tileInstanceKey({
            x: actor.x,
            y: actor.y,
            z: actor.z,
            stackIndex: actor.stackIndex,
          }),
          strongest,
        );
      }
    }

    this.remaining.endFrame();
    return { tints, emitters };
  }

  /**
   * One plume over one body.
   *
   * **Anchored to the cell, not to the sprite.** A body mid-step is drawn a
   * fraction of a cell from where the map says it is, and a plume that chased
   * that offset would drag its whole column of already-airborne sparks sideways
   * with it. Leaving it on the cell means a walking creature lays a trail of
   * what it is doing, which is both cheaper and a better reading.
   *
   * The draw order is the rule stated in `./particles`: a two-high tile standing
   * on top of this body's stack. That puts the plume in front of the body at
   * every pixel they share, and behind whatever is genuinely nearer.
   */
  private emitterFor(
    snap: GameSnapshot,
    actor: ActorSnapshot,
    defId: string,
    particles: NonNullable<StatusDef["vfx"]["particles"]>,
    taper: number,
  ): ParticleEmitterSpec {
    const stack = getStack(snap.map, actor.x, actor.y, actor.z);
    const foot = absoluteElevation(
      actor.z,
      elevationAt(stack, actor.stackIndex, this.tilesById),
    );
    const bodyHeight = this.tilesById[actor.tileId]?.height ?? HEIGHT_PER_LEVEL;
    const top = foot + bodyHeight;
    return {
      // Per body per status, so one creature can burn and be poisoned at once
      // and neither plume inherits the other's particles.
      id: `${actor.id}:${defId}`,
      config: particles,
      cx: actor.x + CELL_CENTRE,
      cy: actor.y + CELL_CENTRE,
      footElev: foot,
      z: actor.z,
      box: depthBox(actor.x, actor.y, top, top + HEIGHT_PER_LEVEL),
      stackBias: depthStackBias(actor.z, actor.stackIndex + 1),
      taper,
    };
  }

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
      const fromStatuses = this.statusLightsFor(actor);
      if (!bodyEmits && !carried && !fromStatuses) continue;
      const at = this.actorEmitter(snap.map, actor, playerDef.height ?? 0);
      // The body's own light is found by reading the stack it is standing in,
      // which is what an override has always meant. What is in the bag is not in
      // any stack, so it travels on a second override at the same position — the
      // cast accumulates, and one lantern at your hip lights exactly like one
      // lantern at your hip.
      if (bodyEmits) overrides.push(at);
      if (carried) overrides.push({ ...at, lights: carried });
      // A third emitter at the same position rather than a merge, on the terms
      // the carried one is: the cast accumulates, and there is no blending rule
      // to invent between a lantern in your hand and the fire on your back.
      if (fromStatuses) overrides.push({ ...at, lights: fromStatuses });
    }
    return overrides.length > 0 ? overrides : undefined;
  }

  /**
   * The lights this body is casting because of what is running on it.
   *
   * Undefined rather than an empty array for the usual case of none, on the
   * terms {@link carriedLightsFor} is: this runs per actor per frame and almost
   * nobody is under anything.
   *
   * **This is the same door a torch goes through, and that is the whole reason
   * it is cheap.** An override is already painted for every actor every frame,
   * and the overlay is add-only — so a status light costs one more `LightDef` in
   * a list that is already being walked, and nothing about the *static* bake
   * changes. What it must not become is a flicker: `emitterOverridesKey` has the
   * lights in it, so a light that changed per frame would miss the overlay cache
   * every frame and rebake. A status light is therefore steady by construction —
   * see `StatusVfx.light`, which has no phase to vary.
   */
  private statusLightsFor(actor: ActorSnapshot): LightDef[] | undefined {
    if (actor.statuses.length === 0) return undefined;
    let lights: LightDef[] | undefined;
    for (const instance of actor.statuses) {
      const vfx = this.statusDefs[instance.defId]?.vfx;
      if (!vfx?.light) continue;
      // Read rather than written: `statusVfxFor` already carried every clock
      // forward this frame, and aging them twice would run a taper at double
      // speed. A status with no plume and no tint was still read there.
      const taper = taperAt(
        this.remaining.read(
          taperKey(actor.id, instance.defId),
          instance.remainingMs,
        ),
        vfx.taperMs,
      );
      (lights ??= []).push(taperedGlow(vfx.light, taper));
    }
    return lights;
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
      motions.push(...this.slideMotions(snap.map, actor));

      const own = this.actorMotion(snap.map, actor);
      if (own) motions.push(own);
    }

    // Always a list, empty or not: the caller hands it to two consumers, and one
    // of them wants to search it rather than pass it along.
    return motions;
  }

  /**
   * Motion for one actor's walk / fall lerp, or for the lean of a blow — and for
   * both at once, since a body can swing while it walks.
   *
   * One motion, never two: a motion is keyed by the slot it moves, so a second
   * one for the same body would be two meshes claiming one placement. The strike
   * therefore rides *on* whatever the body is already doing, which is also what
   * it looks like — a creature that lunges mid-step leans out of its own stride.
   *
   * **The lean moves the sprite and not the depth box.** The striker has not
   * left its cell — the simulation has it standing exactly where it stood — and
   * a box that travelled half a cell into the target would put the two bodies on
   * the boundary where their sort order flips, for 150ms, every swing.
   */
  private actorMotion(
    map: MapFile,
    actor: ActorSnapshot,
  ): TileMotion | null {
    const lean = actor.strike
      ? strikeOffset(actor.strike, actor.strikeProgress)
      : null;

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
      const destStack = getStack(map, to.x, to.y, to.z);
      const destStackLen = destStack.length;
      const def = this.tilesById[actor.tileId];
      const t = actor.walkProgress;
      const foot = originFoot + (destFoot - originFoot) * t;

      return {
        x: from.x,
        y: from.y,
        z: from.z,
        stackIndex,
        ox: visual.x - fromCenter.x + (lean?.ox ?? 0),
        oy: visual.y - fromCenter.y + (lean?.oy ?? 0),
        // Descending: also draw under the destination level so roof-cut can
        // hide the origin group without the sprite vanishing mid-lerp.
        alsoDrawAtZ: to.z < from.z ? to.z : undefined,
        box: {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          foot,
          // Halfway, not on commit — see `./depthClump`. The sprite is
          // over the destination long before the step lands there.
          top:
            foot +
            steppingClumpHeight(
              { stack: getStack(map, from.x, from.y, from.z), stackIndex },
              { stack: destStack, arriving: def },
              t,
              this.tilesById,
            ),
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
        ox: drop + (lean?.ox ?? 0),
        oy: drop + (lean?.oy ?? 0),
        alsoDrawAtZ: landingZ < actor.z ? landingZ : undefined,
        box: {
          x: actor.x,
          y: actor.y,
          foot,
          top: foot + this.clumpHeight(map, actor, actor.stackIndex),
          stackBias: depthStackBias(actor.z, actor.stackIndex),
        },
      };
    }

    if (lean) {
      // Standing and swinging: the box is exactly where the body is, which is
      // the whole of what this motion is for — an offset sprite over an
      // unchanged placement.
      const foot = this.standingFootAbs(map, actor, actor.stackIndex);
      return {
        x: actor.x,
        y: actor.y,
        z: actor.z,
        stackIndex: actor.stackIndex,
        ox: lean.ox,
        oy: lean.oy,
        box: {
          x: actor.x,
          y: actor.y,
          foot,
          top: foot + this.clumpHeight(map, actor, actor.stackIndex),
          stackBias: depthStackBias(actor.z, actor.stackIndex),
        },
      };
    }

    return null;
  }

  /**
   * Motions for a shoved column still catching up to the cell it was pushed
   * into. One per travelling tile. @see slideTileMotions
   */
  private slideMotions(map: MapFile, actor: ActorSnapshot): TileMotion[] {
    if (!actor.slide) return [];
    return slideTileMotions(
      map,
      this.tilesById,
      actor.slide,
      actor.slideProgress,
    );
  }

  /** Height of the tile at a stack slot — the mover is not always the player. */
  private clumpHeight(
    map: MapFile,
    cell: { x: number; y: number; z: number },
    stackIndex: number,
  ): number {
    const stack = getStack(map, cell.x, cell.y, cell.z);
    if (!stack[stackIndex]) return 0;
    const extent = clumpExtentAt(stack, stackIndex, this.tilesById);
    return extent.top - extent.foot;
  }

  /**
   * How tall the body itself is — never its clump.
   *
   * What hangs over a head belongs to the head, and a clump is a fact about
   * *sorting* and nothing else. Reading the clump here put a person's health bar
   * up at the top of the open door they were standing in, which is a bar that
   * has stopped reporting on the person.
   */
  private bodyOwnHeight(
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

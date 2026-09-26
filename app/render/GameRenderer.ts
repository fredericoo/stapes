import {
  absoluteElevation,
  baseCellWorldOrigin,
  CELL_CENTRE,
  depthBox,
  depthStackBias,
  drawOrder,
  elevationScreenOffset,
} from "../lib/geometry";
import type {
  ActorSnapshot,
  DamageNumber,
  GameSnapshot,
  ObjectRef,
  PlaySession,
} from "../game/GameSession";
import { PLAYER_TILE_ID } from "../game/constants";
import { bodyNameFor, bodyNameIn, fightingName, sizedUpName } from "../game/displayName";
import type { Equipment } from "../game/equipment";
import type { Conversation } from "../game/dialogRuntime";
import type { MasteryXp } from "../lib/mastery";
import { weaponDemandFor } from "../lib/weaponDemand";
import { sameAttributes } from "../game/attributes";
import type { Vitals } from "../game/GameSession";
import type { AfflictedPlacement } from "../game/endure";
import { statusReading } from "../game/statuses";
import { type SpellButton, spellReading } from "../game/casting";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import { readOpenedContainer } from "../game/openedContainer";
import { offeredRecipes, type CraftingWindow } from "../game/craft";
import {
  applyInteraction,
  interactionText,
  listInteractionOptions,
  topInteractionAt,
  type InteractionOption,
} from "../game/interactionOptions";
import type { Extraction } from "../game/extract";
import { type Progress, progressFraction } from "../game/progress";
import { inscribedNearby } from "./nearbyInscriptions";
import { WorldLabelLayer, type WorldLabel } from "./textLabels";
import { FrameProfiler, type FrameStats } from "./frameProfile";
import { fallDropPx, fallFootAbs, standingFootAbs } from "./fallAnchor";
import { slideTileMotions } from "./slideMotion";
import { type AimAt, flightEmitter, flightLight, projectileViews } from "./projectileMotion";
import { strikeOffset } from "./strikeMotion";
import { wadingFor } from "./wadeDepth";
import { isCellVisible } from "./cameraSight";
import { labelHeadroomPx } from "./labelHeadroom";
import { sceneryStack } from "../game/movement";
import {
  bindAttackKey,
  bindLookKey,
  isTypingTarget,
  type HeldDirections,
} from "../game/heldDirections";
import { WalkTo, type WalkView } from "../game/walkTo";
import type { EmitterOverride } from "../lib/lighting";
import { DEFAULT_PLAY_MINUTES, clockAfter, wrapMinutes, type MinutesOfDay } from "../lib/clock";
import { emitterCenter } from "../lib/lighting";
import { DWELL_MS } from "../lib/useDwell";
import { elevationAt, getStack, stackHeight } from "../lib/mapData";
import { conjuredName } from "../game/conjured";
import { engravedName } from "../lib/engraving";
import { pileTally } from "../lib/piles";
import {
  type RoofCut,
  type ViewAnchor,
  roofCutFor,
  cutProbeChunks,
  sameProbeChunks,
  viewAnchorFor,
} from "../lib/levelVisibility";
import type { Coord, LightDef, MapFile, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, tileCanEmitLight } from "../lib/types";
import { clumpExtentAt, steppingClumpHeight } from "./depthClump";
import { resolveLight } from "../lib/tileResolve";
import { tilesByIdFromList } from "../lib/validation";
import { type OverlaySpec, type TileMotion, tileInstanceKey, WorldRenderer } from "./WorldRenderer";
import type { ParticleEmitterSpec } from "./particles";
import type { StatusDef } from "../lib/status";
import { taperAt, taperedGlow, taperedTint, type StatusTint } from "../lib/statusVfx";
import { SmoothedRemaining, taperKey } from "./statusTaper";
import { spriteStatesFor } from "./spriteState";
import { pickBodyAt, pickInteractiveAt, pickTileAt } from "./pick";
import { rangedWeaponReaches } from "../game/combat";
import { CastLineLayer, type CastLineView } from "./castLines";
import { DamageNumberLayer, type DamageNumberView } from "./damageNumbers";
import { ScreenShake, SHAKE_DURATION_MS, shakeAmplitude } from "./screenShake";
import { NoticeQueue, NotificationLayer } from "./notifications";
import { healthBarColor, healthFraction } from "./healthBar";
import { fitViewport, VIEW_PX, type ViewportFit } from "./viewport";
import { clampZoomOut, debugSpanPx, DEBUG_ZOOM_OUT, playSquareOrigin } from "./debugView";
import { DebugPanel } from "./debugPanel";

function sameRef(a: ObjectRef | null, b: ObjectRef | null): boolean {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z && a.stackIndex === b.stackIndex;
}

function currentFit(canvas: HTMLCanvasElement, spanPx: number): ViewportFit {
  return fitViewport(Math.min(canvas.clientWidth, canvas.clientHeight), spanPx);
}

const DROP_GHOST_ALPHA = 0.55;

const HOVER_COLOR = 0xffcc00;

const TARGET_HOVER_COLOR = 0xffffff;

const TARGET_COLOR = 0xffffff;

const ATTACK_TARGET_COLOR = 0xff3b30;

const ATTACK_LABEL_INK = "#ff9b94";

const LOOK_COLOR = 0x3fa9ff;

const LOOK_HOLD_MS = DWELL_MS;

const LOOK_HOLD_SLOP_PX = 10;

const PICK_LEVEL_SLACK = 1;

const HOVER_LABEL_INK = "#ffe27a";

const REWARD_COLOR = 0xb15cff;

const REWARD_LABEL_INK = "#d9a9ff";

function interactionColor(option: InteractionOption): number {
  if (option.action === "attack") return ATTACK_TARGET_COLOR;
  if (option.action === "target") return TARGET_HOVER_COLOR;
  if (option.action === "reward") return REWARD_COLOR;
  return HOVER_COLOR;
}

function interactionInk(option: InteractionOption): string {
  if (option.action === "attack") return ATTACK_LABEL_INK;
  if (option.action === "target") return "#ffffff";
  if (option.action === "reward") return REWARD_LABEL_INK;
  return HOVER_LABEL_INK;
}

type PointerLabel = {
  ref: ObjectRef;
  height: number;
  lines: { id: string; text: string }[];
  color?: string;
};

/**
 * A rolling hash rather than a sum: a sum would miss two creatures trading a
 * point between them, since the total is unchanged. `| 0` keeps it a plain
 * int32 so this stays cheap to compare every frame.
 */
function healthSignature(actors: readonly ActorSnapshot[]): number {
  let signature = 0;
  for (const actor of actors) {
    if (actor.hp === null) continue;
    signature = (signature * 31 + actor.hp) | 0;
  }
  return signature;
}

/** Rounds a moving sprite to whole world pixels so its texels line up with the static scenery. */
function snapToWholePixels(p: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export class GameRenderer {
  private world: WorldRenderer;
  private session: PlaySession;
  private canvas: HTMLCanvasElement;
  private tilesById: Record<string, TileDef>;
  private bodyEmitsCache = new WeakMap<TileDef, boolean>();
  private statusDefs: Record<string, StatusDef> = {};
  private readonly remaining = new SmoothedRemaining();
  private minutesOfDay: number = DEFAULT_PLAY_MINUTES;
  private clockAnchorMinutes: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private clockAnchorAtMs = 0;
  private clockPaused = false;
  private onClock: ((minutes: MinutesOfDay) => void) | null = null;
  private onStats: ((stats: FrameStats) => void) | null = null;
  private onEquipment: ((equipment: Equipment) => void) | null = null;
  private equipmentSent: Equipment | null = null;
  private onConversation: ((conversation: Conversation | null) => void) | null = null;
  private conversationSent: Conversation | null | undefined = undefined;
  private onVitals: ((vitals: Vitals) => void) | null = null;
  private vitalsSent: Vitals | null = null;
  private onMasteries: ((masteryXp: MasteryXp) => void) | null = null;
  private onSpells: ((spells: SpellButton[]) => void) | null = null;
  private spellsSent: string | null = null;
  private masteriesSent: MasteryXp | null = null;
  private interactionsEquipment: Equipment | null = null;
  private interactionsTags: readonly string[] | null = null;
  private interactionsSpawnAt: Coord | null = null;
  private interactionsExtracting: Extraction | null = null;
  private interactionsNextBlow: Progress | null = null;
  private onOpenedContainer: ((container: OpenedContainer | null) => void) | null = null;
  private openedRef: ObjectRef | null = null;
  private openedItemId: string | null = null;
  private openedPlacement: PlacedTile | null = null;
  private openedFrom = "";
  private openedSent: OpenedContainer | null | undefined = undefined;
  private onCrafting: ((window: CraftingWindow | null) => void) | null = null;
  private craftingRef: ObjectRef | null = null;
  private craftingMap: MapFile | null = null;
  private craftingFrom = "";
  private craftingEquipment: Equipment | null = null;
  private craftingSent: string | null | undefined = undefined;
  private onInteractions: ((options: InteractionOption[]) => void) | null = null;
  private interactionsMap: MapFile | null = null;
  private interactionsAt = "";
  private interactionsHealth = 0;
  private interactionsKey = "";
  private interactionsSent: InteractionOption[] = [];
  private listHoverId: string | null = null;
  private dropDrag: { from: SlotRef; tileId: string; point: { x: number; y: number } } | null =
    null;
  private profiler = new FrameProfiler();
  private disposed = false;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  private pointerRef: ObjectRef | null = null;
  private pointerPickKey = "";
  private pointerPickMap: MapFile | null = null;
  private damageLayer: DamageNumberLayer | null = null;
  private readonly shake = new ScreenShake();
  private readonly shakenBy = new Set<string>();
  private readonly shakeEnabled =
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private castLineLayer: CastLineLayer | null = null;
  private notificationLayer: NotificationLayer | null = null;
  private readonly notices = new NoticeQueue();
  private walkTo: WalkTo | null = null;
  private lookMode = false;
  private lookKeyHeld = false;
  private touchLooking = false;
  private lookHold: ReturnType<typeof setTimeout> | null = null;
  private touchDownAt: { x: number; y: number } | null = null;
  private touchId: number | null = null;
  private unbindLookKey: (() => void) | null = null;
  private unbindAttackKey: (() => void) | null = null;
  private lookedAt: ObjectRef | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private lookPickKey = "";
  private lookPickMap: MapFile | null = null;
  private lightingEnabled = true;
  private labelLayer: WorldLabelLayer | null = null;
  private debugZoomOut: number | null = null;
  private debugPanel: DebugPanel | null = null;
  private readonly speechAnchors = new Map<string, { x: number; y: number }>();
  private readonly damageAnchors = new Map<string, { x: number; y: number }>();

  constructor(
    canvas: HTMLCanvasElement,
    session: PlaySession,
    tilesets: TilesetDef[],
    tiles: TileDef[],
    labelContainer?: HTMLElement | null,
  ) {
    this.session = session;
    this.canvas = canvas;
    this.tilesById = tilesByIdFromList(tiles);
    this.world = new WorldRenderer(canvas);
    this.world.setAssets(tilesets, this.tilesById);
    if (labelContainer) {
      this.labelLayer = new WorldLabelLayer(labelContainer);
      this.castLineLayer = new CastLineLayer(labelContainer);
      this.damageLayer = new DamageNumberLayer(labelContainer);
      this.notificationLayer = new NotificationLayer(labelContainer);
    }
    this.attachPointer();
    this.attachKeys();
  }

  setStatuses(defs: Record<string, StatusDef>) {
    this.statusDefs = defs;
  }

  setDirections(directions: HeldDirections) {
    this.walkTo = new WalkTo(directions);
  }

  setMinutesOfDay(m: MinutesOfDay) {
    this.minutesOfDay = wrapMinutes(m);
    this.reanchorClock(this.minutesOfDay);
    this.onClock?.(Math.floor(this.minutesOfDay));
  }

  setClockPaused(paused: boolean) {
    if (paused === this.clockPaused) return;
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

  setOnNextFrame(cb: (() => void) | null) {
    this.world.setOnNextFrame(cb);
  }

  setOnStats(cb: ((stats: FrameStats) => void) | null) {
    this.onStats = cb;
    this.world.setProfiler(cb ? this.profiler : null);
  }

  setOnEquipment(cb: ((equipment: Equipment) => void) | null) {
    this.onEquipment = cb;
    this.equipmentSent = null;
  }

  private pushEquipment(snap: GameSnapshot) {
    if (!this.onEquipment) return;
    if (snap.equipment === this.equipmentSent) return;
    this.equipmentSent = snap.equipment;
    this.onEquipment(snap.equipment);
  }

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
    this.vitalsSent = null;
  }

  private pushVitals(snap: GameSnapshot) {
    if (!this.onVitals) return;
    const next: Vitals = {
      hp: snap.self.hp,
      maxHp: snap.self.maxHp,
      rating: snap.self.rating,
      statuses: snap.self.statuses,
      attributes: snap.attributes,
      pvp: snap.pvp,
    };
    const sent = this.vitalsSent;
    if (
      sent &&
      sent.hp === next.hp &&
      sent.maxHp === next.maxHp &&
      sent.rating === next.rating &&
      sameAttributes(sent.attributes, next.attributes) &&
      sent.pvp.on === next.pvp.on &&
      sent.pvp.changeable === next.pvp.changeable &&
      statusReading(sent.statuses) === statusReading(next.statuses)
    ) {
      return;
    }
    this.vitalsSent = next;
    this.onVitals(next);
  }

  setOnMasteries(cb: ((masteryXp: MasteryXp) => void) | null) {
    this.onMasteries = cb;
    this.masteriesSent = null;
  }

  private pushMasteries(snap: GameSnapshot) {
    if (!this.onMasteries) return;
    if (snap.masteryXp === this.masteriesSent) return;
    this.masteriesSent = snap.masteryXp;
    this.onMasteries(snap.masteryXp);
  }

  setOnSpells(cb: ((spells: SpellButton[]) => void) | null) {
    this.onSpells = cb;
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

  private pushNotices(nowMs: number) {
    for (const text of this.session.drainNotices()) {
      this.notices.push(text, nowMs);
    }
    for (const text of this.walkTo?.drainNotices() ?? []) {
      this.notices.push(text, nowMs);
    }
    this.notificationLayer?.set(this.notices.live(nowMs));
  }

  private stepWalkTo(snap: GameSnapshot, camera: { x: number; y: number }) {
    const walkTo = this.walkTo;
    if (!walkTo?.walking) return;
    const view = this.walkView(snap, camera);
    if (!view) {
      walkTo.cancel();
      return;
    }
    walkTo.tick(view);
  }

  setFollow(actorId: string | null) {
    const walkTo = this.walkTo;
    if (!walkTo) return;
    const snap = this.session.getSnapshot();
    const view = this.walkView(snap, this.cameraFor(snap));
    if (!view) return;
    walkTo.follow(actorId, view);
  }

  setOpenedContainer(ref: ObjectRef | null) {
    this.openedRef = ref;
    this.openedItemId = null;
    this.openedPlacement = null;
    this.openedFrom = "";
    this.openedSent = undefined;
  }

  setCrafting(ref: ObjectRef | null) {
    this.craftingRef = ref;
    this.craftingMap = null;
    this.craftingSent = undefined;
  }

  setOnCrafting(cb: ((window: CraftingWindow | null) => void) | null) {
    this.onCrafting = cb;
    this.craftingMap = null;
    this.craftingSent = undefined;
  }

  private pushCrafting(snap: GameSnapshot) {
    if (!this.onCrafting) return;

    const ref = this.craftingRef;
    if (!ref) {
      if (this.craftingSent === null) return;
      this.craftingSent = null;
      this.onCrafting(null);
      return;
    }

    const from = `${snap.self.x},${snap.self.y},${snap.self.z}`;
    if (
      snap.map === this.craftingMap &&
      from === this.craftingFrom &&
      snap.equipment === this.craftingEquipment
    ) {
      return;
    }
    this.craftingMap = snap.map;
    this.craftingFrom = from;
    this.craftingEquipment = snap.equipment;

    const offered = offeredRecipes(snap.map, this.tilesById, snap.self, snap.equipment, ref);
    const tileId = getStack(snap.map, ref.x, ref.y, ref.z)[ref.stackIndex]?.tileId;
    if (!offered || !tileId) {
      this.craftingRef = null;
      this.craftingSent = null;
      this.onCrafting(null);
      return;
    }

    const key = `${ref.x},${ref.y},${ref.z},${ref.stackIndex}:${offered.recipes.map((r) => r.index).join(",")}`;
    if (key === this.craftingSent) return;
    this.craftingSent = key;
    this.onCrafting({ ref, tileId, craft: offered.craft, recipes: offered.recipes });
  }

  setOnOpenedContainer(cb: ((container: OpenedContainer | null) => void) | null) {
    this.onOpenedContainer = cb;
    this.openedPlacement = null;
    this.openedFrom = "";
    this.openedSent = undefined;
  }

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

    const read = readOpenedContainer(snap.map, this.tilesById, snap.self, ref, this.openedItemId);
    if (read.kind === "closed") {
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
    this.interactionsMap = null;
    this.interactionsAt = "";
    this.interactionsHealth = 0;
    this.interactionsKey = "";
    this.interactionsEquipment = null;
    this.interactionsTags = null;
    this.interactionsExtracting = null;
    this.interactionsNextBlow = null;
    this.interactionsSent = [];
  }

  setListHover(optionId: string | null) {
    this.listHoverId = optionId;
  }

  private listHoverOption(): InteractionOption | null {
    if (this.listHoverId === null) return null;
    return this.listOption(this.listHoverId);
  }

  listOption(optionId: string): InteractionOption | null {
    return this.interactionsSent.find((o) => o.id === optionId) ?? null;
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
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
      this.profiler.measure("view", () => this.pushView(now, dt));
      this.profiler.measure("anim", () => this.world.tick(dt));
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
    this.onCrafting = null;
    this.onInteractions = null;
    this.stop();
    this.detachPointer();
    this.detachKeys();
    this.walkTo?.cancel();
    this.walkTo = null;
    this.cancelLookHold();
    this.labelLayer?.dispose();
    this.labelLayer = null;
    this.damageLayer?.dispose();
    this.damageLayer = null;
    this.castLineLayer?.dispose();
    this.castLineLayer = null;
    this.notificationLayer?.dispose();
    this.notificationLayer = null;
    this.debugPanel?.dispose();
    this.debugPanel = null;
    this.world.dispose();
  }

  private attachKeys() {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.onKeyDown);
    this.unbindLookKey = bindLookKey((held) => {
      this.lookKeyHeld = held;
      this.applyLooking();
    });
    this.unbindAttackKey = bindAttackKey(() => this.toggleSwing());
  }

  private detachKeys() {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this.onKeyDown);
    this.unbindLookKey?.();
    this.unbindLookKey = null;
    this.unbindAttackKey?.();
    this.unbindAttackKey = null;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === "[" || e.key === "]") && !isTypingTarget(e.target)) {
      this.stepDebugZoom(e.key === "]" ? 1 : -1);
      return;
    }
    if (e.key !== "Escape") return;
    if (this.session.getSnapshot().targetId === null) return;
    this.session.setTarget(null);
    this.session.setAttackMode(false);
  };

  private toggleSwing() {
    const snap = this.session.getSnapshot();
    if (snap.targetId === null) return;
    this.session.setAttackMode(!snap.attacking);
  }

  private attachPointer() {
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
  }

  private detachPointer() {
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerMove = (e: PointerEvent) => {
    this.lastPointer = this.localPoint(e);
    if (this.lookHold !== null && this.touchDownAt && e.pointerId === this.touchId) {
      const dx = this.lastPointer.x - this.touchDownAt.x;
      const dy = this.lastPointer.y - this.touchDownAt.y;
      if (dx * dx + dy * dy > LOOK_HOLD_SLOP_PX * LOOK_HOLD_SLOP_PX) {
        this.cancelLookHold();
      }
    }
    const snap = this.session.getSnapshot();
    if (this.lookMode) {
      this.lookedAt = this.lookAt(this.lastPointer, snap);
      return;
    }
    this.pointerRef = this.pickRefAt(this.lastPointer, snap);
  };

  private fightAt(point: { x: number; y: number }, snap: GameSnapshot) {
    this.pointerRef = this.pickRefAt(point, snap);
    if (!this.pointerRef) return;
    const ref = this.pointerRef;
    const fight = this.interactionsSent.find(
      (option) => option.action === "attack" && sameRef(option.ref, ref),
    );
    if (fight) applyInteraction(this.session, fight, this);
  }

  private pickAt(point: { x: number; y: number }, snap: GameSnapshot): ObjectRef | null {
    return pickInteractiveAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas, this.spanPx()).cssScale,
      },
      point.x,
      point.y,
      snap.self.z,
      PICK_LEVEL_SLACK,
      (ref) => topInteractionAt(this.interactionsSent, ref) !== null,
    );
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;

    const point = this.localPoint(e);
    this.lastPointer = point;

    if (e.pointerType === "touch") {
      if (this.touchId !== null) return;
      this.touchId = e.pointerId;
      this.touchDownAt = point;
      this.canvas.setPointerCapture(e.pointerId);
      this.lookHold = setTimeout(() => {
        this.lookHold = null;
        this.touchLooking = true;
        this.applyLooking();
      }, LOOK_HOLD_MS);
      return;
    }

    if (e.button === 2) {
      e.preventDefault();
      if (!this.lookMode) this.fightAt(point, this.session.getSnapshot());
      return;
    }

    this.act(point, e);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    if (e.pointerId !== this.touchId) return;
    this.touchId = null;
    this.touchDownAt = null;
    if (this.endLookHold()) return;
    if (e.button !== 0) return;
    const point = this.localPoint(e);
    this.lastPointer = point;
    this.act(point, e);
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.touchId) return;
    this.touchId = null;
    this.touchDownAt = null;
    this.endLookHold();
  };

  private act(point: { x: number; y: number }, e: PointerEvent) {
    const snap = this.session.getSnapshot();

    if (this.lookMode) {
      e.preventDefault();
      this.lookedAt = this.lookAt(point, snap);
      return;
    }

    this.pointerRef = this.pickRefAt(point, snap);
    const option = this.pointerOption();
    if (option) {
      e.preventDefault();
      this.runOption(option);
      return;
    }

    /**
     * Deliberately without `preventDefault`, unlike the branches above: in
     * Chrome, cancelling a pointerdown suppresses the compatibility mousedown
     * it would otherwise fire, which would take focus off a chat field the
     * player just typed into.
     */
    this.walkToPointer(point, snap);
  }

  private cancelLookHold() {
    if (this.lookHold === null) return;
    clearTimeout(this.lookHold);
    this.lookHold = null;
  }

  private endLookHold(): boolean {
    this.cancelLookHold();
    if (!this.touchLooking) return false;
    this.touchLooking = false;
    this.applyLooking();
    return true;
  }

  private walkToPointer(point: { x: number; y: number }, snap: GameSnapshot) {
    const walkTo = this.walkTo;
    if (!walkTo) return;
    const ref = this.lookAt(point, snap);
    if (!ref) return;
    const view = this.walkView(snap, this.cameraFor(snap));
    if (!view) return;
    walkTo.start(ref, view);
  }

  private walkView(snap: GameSnapshot, camera: { x: number; y: number }): WalkView | null {
    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) return null;
    const self = snap.self;
    const standing = getStack(snap.map, self.x, self.y, self.z)[self.stackIndex];
    if (standing?.tileId !== PLAYER_TILE_ID) return null;
    return {
      map: snap.map,
      who: self.id,
      at: { x: self.x, y: self.y, z: self.z, stackIndex: self.stackIndex },
      stepping: self.walk ? self.walk.to : null,
      def,
      tilesById: this.tilesById,
      statusDefs: this.statusDefs,
      bodyAt: (actorId) => {
        const actor = snap.actors.find((a) => a.id === actorId);
        if (!actor) return null;
        if (!this.isWithinView(snap.map, actor, camera)) return null;
        return { x: actor.x, y: actor.y, z: actor.z };
      },
    };
  }

  private runOption(option: InteractionOption) {
    if (option.action === "open") {
      this.setOpenedContainer(option.active ? null : option.ref);
      return;
    }
    applyInteraction(this.session, option, this);
  }

  private onPointerLeave = () => {
    this.lastPointer = null;
    this.lookedAt = null;
    this.pointerRef = null;
  };

  private bodyAt(point: { x: number; y: number }, snap: GameSnapshot): ObjectRef | null {
    const found = pickBodyAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas, this.spanPx()).cssScale,
      },
      point.x,
      point.y,
      snap.self.z,
      PICK_LEVEL_SLACK,
    );
    if (!found) return null;
    return this.actorIdAt(found, snap) === snap.self.id ? null : found;
  }

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

  private applyLooking() {
    const enabled = this.lookKeyHeld || this.touchLooking;
    if (enabled === this.lookMode) return;
    this.lookMode = enabled;
    if (!enabled) {
      this.lookedAt = null;
      return;
    }
    this.pointerRef = null;
    if (this.lastPointer) {
      this.lookedAt = this.lookAt(this.lastPointer, this.session.getSnapshot());
    }
  }

  setDropGhost(drag: { from: SlotRef; tileId: string; clientX: number; clientY: number } | null) {
    if (!drag) {
      this.dropDrag = null;
      return;
    }
    const point = this.canvasPoint(drag.clientX, drag.clientY);
    this.dropDrag = point ? { from: drag.from, tileId: drag.tileId, point } : null;
  }

  dropCellAt(clientX: number, clientY: number): Coord | null {
    const point = this.canvasPoint(clientX, clientY);
    if (!point) return null;
    const ref = this.lookAt(point, this.session.getSnapshot());
    return ref ? { x: ref.x, y: ref.y, z: ref.z } : null;
  }

  private canvasPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return { x, y };
  }

  private lookAt(point: { x: number; y: number }, snap: GameSnapshot): ObjectRef | null {
    return pickTileAt(
      {
        map: snap.map,
        tilesById: this.tilesById,
        camera: this.cameraFor(snap),
        zoom: currentFit(this.canvas, this.spanPx()).cssScale,
      },
      point.x,
      point.y,
      snap.self.z,
      PICK_LEVEL_SLACK,
      this.roofCutFor(snap),
    );
  }

  private dropGhostSpec(snap: GameSnapshot): OverlaySpec | null {
    const drag = this.dropDrag;
    if (!drag) return null;
    const ref = this.lookAt(drag.point, snap);
    if (!ref) return null;
    const at = { x: ref.x, y: ref.y, z: ref.z };
    if (!this.session.canDrop(drag.from, at)) return null;
    return { kind: "ghost", tileId: drag.tileId, ...at, alpha: DROP_GHOST_ALPHA };
  }

  private overlaysFor(snap: GameSnapshot): OverlaySpec[] {
    const outline = (ref: ObjectRef, color: number, pulse = false): OverlaySpec => ({
      kind: "objectOutline",
      ...ref,
      color,
      pulse,
    });

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
    const target = this.targetOutline(snap);
    if (target) {
      specs.push(outline(target, snap.attacking ? ATTACK_TARGET_COLOR : TARGET_COLOR, true));
    }
    const pointed = this.pointerOption();
    if (pointed && !sameRef(pointed.ref, target)) {
      specs.push(outline(pointed.ref, interactionColor(pointed)));
    }
    if (listed && !sameRef(listed.ref, target)) {
      specs.push(outline(listed.ref, interactionColor(listed)));
    }
    return specs;
  }

  private isVisibleCell(
    snap: GameSnapshot,
    at: { x: number; y: number; z: number },
    cut: RoofCut | undefined,
  ): boolean {
    return isCellVisible(snap.map, this.tilesById, at, snap.self.z, cut);
  }

  private isVisibleBody(
    snap: GameSnapshot,
    actor: ActorSnapshot,
    camera: { x: number; y: number },
    cut: RoofCut | undefined,
  ): boolean {
    if (!this.isVisibleCell(snap, actor, cut)) return false;
    return this.isWithinView(snap.map, actor, camera);
  }

  private isInDarkness(snap: GameSnapshot, actor: ActorSnapshot): boolean {
    return actor.id !== snap.self.id && this.world.isCellPitchBlack(actor.x, actor.y, actor.z);
  }

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

  private repickPointer(snap: GameSnapshot, camera: { x: number; y: number }) {
    if (this.lookMode || !this.lastPointer) return;
    const key = `${camera.x},${camera.y}`;
    if (key === this.pointerPickKey && snap.map === this.pointerPickMap) return;
    this.pointerPickKey = key;
    this.pointerPickMap = snap.map;
    this.pointerRef = this.pickRefAt(this.lastPointer, snap);
  }

  private pickRefAt(point: { x: number; y: number }, snap: GameSnapshot): ObjectRef | null {
    const body = this.bodyAt(point, snap);
    if (body && topInteractionAt(this.interactionsSent, body)) return body;
    return this.pickAt(point, snap);
  }

  private pointerOption(): InteractionOption | null {
    if (!this.pointerRef) return null;
    return topInteractionAt(this.interactionsSent, this.pointerRef);
  }

  private enforceTargetVisibility(snap: GameSnapshot, camera: { x: number; y: number }) {
    if (snap.targetId === null) return;
    const actor = snap.actors.find((a) => a.id === snap.targetId);
    if (!actor) {
      this.session.setTarget(null);
      return;
    }
    if (!this.isWithinView(snap.map, actor, camera)) this.session.setTarget(null);
  }

  private isWithinView(
    map: MapFile,
    actor: ActorSnapshot,
    camera: { x: number; y: number },
  ): boolean {
    const visual = this.actorVisualWorld(map, actor);
    const square = this.playSquareFor(camera);
    return (
      visual.x >= square.x &&
      visual.y >= square.y &&
      visual.x <= square.x + VIEW_PX &&
      visual.y <= square.y + VIEW_PX
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

  setDebugView(on: boolean) {
    const zoomOut = on ? DEBUG_ZOOM_OUT : null;
    if (zoomOut === this.debugZoomOut) return;
    this.debugZoomOut = zoomOut;
    this.world.setDebugView(on);
    if (on) {
      this.debugPanel ??= new DebugPanel(this.canvas);
    } else {
      this.debugPanel?.dispose();
      this.debugPanel = null;
    }
  }

  private spanPx(): number {
    return this.debugZoomOut === null ? VIEW_PX : debugSpanPx(this.debugZoomOut);
  }

  private stepDebugZoom(by: number) {
    if (this.debugZoomOut === null) return;
    const next = clampZoomOut(this.debugZoomOut + by);
    if (next === this.debugZoomOut) return;
    this.debugZoomOut = next;
  }

  setLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    this.world.setLightingEnabled(enabled);
  }

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
    this.pushNearbyInscriptionLabels(snap, labels);
    return labels;
  }

  private pushNearbyInscriptionLabels(snap: GameSnapshot, into: WorldLabel[]) {
    for (const near of inscribedNearby(snap.map, this.tilesById, snap.self)) {
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

  private pushPointerLabel(snap: GameSnapshot, into: WorldLabel[]) {
    const said = this.lookMode ? this.lookLines(snap) : this.pointerLines();
    if (!said) return;

    const { ref, height, lines, color } = said;
    const ground = this.cellWorldCenter(ref.x, ref.y, ref.z, snap.map, ref.stackIndex);
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

  private lookLines(snap: GameSnapshot): PointerLabel | null {
    const target = this.lookTarget(snap);
    if (!target) return null;
    const { ref, placed, def } = target;
    const tally = pileTally(placed);
    const name = conjuredName(
      engravedName(def.name, placed.engraved),
      placed,
      bodyNameIn(snap.actors, this.tilesById),
    );
    const lines = [{ id: "name", text: tally ? `${name} ${tally}` : name }];
    if (placed.inscription) {
      lines.push({ id: "inscription", text: placed.inscription });
    }
    if (placed.description) {
      lines.push({ id: "description", text: placed.description });
    }
    for (const [index, text] of weaponDemandFor(def, snap.masteryXp).entries()) {
      lines.push({ id: `demand-${index}`, text });
    }
    return { ref, height: def.height, lines };
  }

  private pointerLines(): PointerLabel | null {
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

  private pushNameLabels(
    snap: GameSnapshot,
    into: WorldLabel[],
    camera: { x: number; y: number },
    cut: RoofCut | undefined,
  ) {
    for (const actor of snap.actors) {
      if (actor.hp === null || actor.maxHp === null) continue;
      if (!this.isVisibleBody(snap, actor, camera, cut)) continue;
      if (this.isInDarkness(snap, actor)) continue;

      const visual = this.actorVisualWorld(snap.map, actor);
      const height = this.bodyOwnHeight(snap.map, actor, actor.stackIndex);
      const head = elevationScreenOffset(height);
      const name = fightingName(bodyNameFor(actor, this.tilesById), actor.pvp);
      const sized = sizedUpName(name, actor.rating, this.lookMode);
      const fraction = healthFraction(actor.hp, actor.maxHp);
      into.push({
        id: `name:${actor.id}`,
        kind: "name",
        x: visual.x + head.x,
        y: visual.y + head.y - labelHeadroomPx(height),
        lines: [{ id: actor.id, text: sized }],
        order: drawOrder(
          actor.x,
          actor.y,
          standingFootAbs(snap.map, this.tilesById, actor, actor.stackIndex),
          actor.stackIndex,
        ),
        color: healthBarColor(fraction),
        bar: { fraction },
        progress: actor.casting
          ? { fraction: progressFraction(actor.casting) }
          : actor.extracting
            ? { fraction: progressFraction(actor.extracting) }
            : undefined,
      });
    }
  }

  private pushSpeechLabels(snap: GameSnapshot, into: WorldLabel[]) {
    if (snap.chats.length === 0) return;

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

  private pushNoiseLabels(snap: GameSnapshot, into: WorldLabel[]) {
    if (snap.noises.length === 0) return;

    const byCell = new Map<string, WorldLabel>();
    for (const noise of snap.noises) {
      const key = `${noise.x},${noise.y},${noise.z}`;
      const group = byCell.get(key);
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

  private speechAnchor(
    chat: { id: string; x: number; y: number; z: number; stackIndex: number },
    map: MapFile,
  ): { x: number; y: number } {
    const held = this.speechAnchors.get(chat.id);
    if (held) return held;

    const ground = this.cellWorldCenter(chat.x, chat.y, chat.z, map, chat.stackIndex);
    const head = elevationScreenOffset(this.tilesById[PLAYER_TILE_ID]?.height ?? 0);
    const at = { x: ground.x + head.x, y: ground.y + head.y };
    this.speechAnchors.set(chat.id, at);
    return at;
  }

  private forgetStaleAnchors(snap: GameSnapshot) {
    if (this.speechAnchors.size === 0) return;
    const live = new Set<string>();
    for (const chat of snap.chats) live.add(chat.id);
    for (const noise of snap.noises) live.add(noise.id);
    for (const id of this.speechAnchors.keys()) {
      if (!live.has(id)) this.speechAnchors.delete(id);
    }
  }

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

  private cutCache: {
    map: MapFile;
    anchor: ViewAnchor;
    cut: RoofCut | undefined;
    probe: readonly unknown[];
  } | null = null;

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
      this.cutCache = { ...cached, map: snap.map };
      return cached.cut;
    }

    const cut = roofCutFor(snap.map, this.tilesById, anchor);
    this.cutCache = { map: snap.map, anchor, cut, probe };
    return cut;
  }

  private cameraFor(snap: GameSnapshot): { x: number; y: number } {
    const visual = this.actorVisualWorld(snap.map, snap.self);
    const half = this.spanPx() / 2;
    return { x: visual.x - half, y: visual.y - half };
  }

  private shakenCamera(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    nowMs: number,
  ): { x: number; y: number } {
    if (!this.shakeEnabled) return camera;

    for (const hit of snap.damage) {
      if (hit.outcome !== "hit" || hit.targetId !== snap.self.id) continue;
      if (this.shakenBy.has(hit.id)) continue;
      this.shakenBy.add(hit.id);
      if (hit.elapsedMs < SHAKE_DURATION_MS) {
        this.shake.hit(shakeAmplitude(hit.amount, snap.self.maxHp), nowMs);
      }
    }
    if (this.shakenBy.size > 0) {
      const live = new Set(snap.damage.map((hit) => hit.id));
      for (const id of this.shakenBy) if (!live.has(id)) this.shakenBy.delete(id);
    }

    const offset = this.shake.offset(nowMs);
    if (offset.x === 0 && offset.y === 0) return camera;
    return { x: camera.x + offset.x, y: camera.y + offset.y };
  }

  private playSquareFor(camera: { x: number; y: number }): {
    x: number;
    y: number;
  } {
    if (this.debugZoomOut === null) return camera;
    return playSquareOrigin(camera, this.debugZoomOut);
  }

  private pushView(nowMs: number, dtMs: number) {
    const snap = this.session.getSnapshot();
    const fit = currentFit(this.canvas, this.spanPx());
    this.world.setBufferSize(fit.bufferPx);
    const zoom = fit.renderScale;
    const camera = this.cameraFor(snap);
    const drawn = this.shakenCamera(snap, camera, nowMs);
    this.repickLook(snap, camera);
    this.enforceTargetVisibility(snap, camera);

    const cut = this.roofCutFor(snap);

    this.pushInteractionOptions(snap, camera, cut);
    this.repickPointer(snap, camera);

    const motions = this.tileMotionsFor(snap);
    const vfx = this.statusVfxFor(snap, dtMs);
    const transitions = this.session.takeTransitions();

    this.world.setView({
      map: snap.map,
      tilesById: this.tilesById,
      camera: drawn,
      zoom,
      minutesOfDay: this.minutesOfDay,
      tileMotions: motions.length > 0 ? motions : undefined,
      projectiles:
        snap.projectiles.length > 0
          ? projectileViews(snap.projectiles, this.tilesById, this.aimAt(snap))
          : undefined,
      spriteStates: spriteStatesFor(snap.actors),
      emitterOverrides: this.withFlightLights(snap, this.emitterOverridesFor(snap)),
      spriteTints: vfx.tints,
      wading: wadingFor(snap.map, snap.actors, this.tilesById),
      particleEmitters: this.withFlightEffects(snap, vfx.emitters),
      roofCut: cut,
      viewerZ: snap.self.z,
      transitions: transitions.length > 0 ? transitions : undefined,
      playSquare:
        this.debugZoomOut === null ? undefined : { ...this.playSquareFor(camera), sizePx: VIEW_PX },
    });

    this.world.setOverlays(this.overlaysFor(snap));
    this.pushEquipment(snap);
    this.pushConversation(snap);
    this.pushMasteries(snap);
    this.pushSpells();
    this.stepWalkTo(snap, camera);
    this.pushNotices(nowMs);
    this.pushVitals(snap);
    this.pushOpenedContainer(snap);
    this.pushCrafting(snap);
    this.labelLayer?.set(this.labelsFor(snap, camera, cut), drawn, fit.cssScale);
    this.damageLayer?.set(this.damageFor(snap, cut), drawn, fit.cssScale);
    this.castLineLayer?.set(this.castLinesFor(snap, cut), drawn, fit.cssScale);
    this.applyCursor();
    this.debugPanel?.update(nowMs, this.debugZoomOut ?? 1, this.world.debugReading());
  }

  private pushInteractionOptions(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    cut: RoofCut | undefined,
  ) {
    if (!this.onInteractions) return;

    const box = this.openedRef;
    const opened = box ? `${box.x},${box.y},${box.z},${box.stackIndex}` : "";
    const talking = snap.conversation?.npcId ?? "";
    const following = this.walkTo?.followingId ?? "";
    const craftingAt = this.craftingRef;
    const crafting = craftingAt
      ? `${craftingAt.x},${craftingAt.y},${craftingAt.z},${craftingAt.stackIndex}`
      : "";
    const unlisted = this.unlistedInDarkness(snap);
    const dark = unlisted.map((a) => a.id).join(" ");
    const at = `${snap.self.x},${snap.self.y},${snap.self.z},${snap.targetId},${opened},${snap.attacking},${talking},${following},${crafting},${dark}`;
    const health = healthSignature(snap.actors);
    if (
      snap.map === this.interactionsMap &&
      at === this.interactionsAt &&
      health === this.interactionsHealth &&
      snap.equipment === this.interactionsEquipment &&
      snap.tags === this.interactionsTags &&
      snap.spawnAt === this.interactionsSpawnAt &&
      snap.extracting === this.interactionsExtracting &&
      snap.nextBlow === this.interactionsNextBlow
    ) {
      return;
    }
    const waitChanged = snap.nextBlow !== this.interactionsNextBlow;
    this.interactionsNextBlow = snap.nextBlow;
    this.interactionsEquipment = snap.equipment;
    this.interactionsTags = snap.tags;
    this.interactionsSpawnAt = snap.spawnAt;
    this.interactionsExtracting = snap.extracting;
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
      snap.spawnAt,
      snap.attacking,
      snap.extracting,
      snap.conversation,
      this.walkTo?.followingId ?? null,
      this.interactionsSent,
      snap.nextBlow,
      this.craftingRef,
    ).filter((option) => !unlisted.some((a) => sameRef(option.ref, a)));
    this.interactionsSent = options;
    const key = options
      .map((o) => `${o.id}/${o.label}/${o.active}/${o.health?.hp ?? ""}/${o.blocked?.kind ?? ""}`)
      .join("|");
    if (key === this.interactionsKey && !waitChanged) return;
    this.interactionsKey = key;
    this.onInteractions(options);
  }

  private targetableActors(
    snap: GameSnapshot,
    camera: { x: number; y: number },
    cut: RoofCut | undefined,
  ): ActorSnapshot[] {
    const following = this.walkTo?.followingId;
    return snap.actors.filter(
      (actor) =>
        actor.id === snap.targetId ||
        actor.id === following ||
        (this.isVisibleBody(snap, actor, camera, cut) && !this.isInDarkness(snap, actor)),
    );
  }

  private unlistedInDarkness(snap: GameSnapshot): ActorSnapshot[] {
    const following = this.walkTo?.followingId;
    return snap.actors.filter(
      (actor) =>
        actor.id !== snap.targetId && actor.id !== following && this.isInDarkness(snap, actor),
    );
  }

  private damageFor(snap: GameSnapshot, cut: RoofCut | undefined): DamageNumberView[] {
    if (snap.damage.length === 0) return [];

    const out: DamageNumberView[] = [];
    for (const hit of snap.damage) {
      if (!this.isVisibleCell(snap, hit, cut)) continue;

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

  private castLinesFor(snap: GameSnapshot, cut: RoofCut | undefined): CastLineView[] {
    const out: CastLineView[] = [];
    for (const caster of snap.actors) {
      const targetId = caster.casting?.targetId;
      if (!targetId || targetId === caster.id) continue;
      const target = snap.actors.find((a) => a.id === targetId);
      if (!target) continue;
      if (!this.isVisibleCell(snap, caster, cut) || !this.isVisibleCell(snap, target, cut)) {
        continue;
      }
      out.push({
        id: caster.id,
        from: this.bodyMiddle(snap.map, caster),
        to: this.bodyMiddle(snap.map, target),
        atYou: target.id === snap.self.id,
      });
    }
    const attack = this.attackLineFor(snap, cut);
    if (attack) out.push(attack);
    return out;
  }

  private attackLineFor(snap: GameSnapshot, cut: RoofCut | undefined): CastLineView | null {
    const self = snap.self;
    if (!snap.attacking || !snap.nextBlow || !snap.targetId || snap.targetId === self.id) {
      return null;
    }
    if (self.casting?.targetId) return null;
    const target = snap.actors.find((a) => a.id === snap.targetId);
    if (!target) return null;
    if (!rangedWeaponReaches(snap.map, this.tilesById, snap.equipment, self, target)) return null;
    if (!this.isVisibleCell(snap, self, cut) || !this.isVisibleCell(snap, target, cut)) {
      return null;
    }
    return {
      id: `attack:${self.id}`,
      from: this.bodyMiddle(snap.map, self),
      to: this.bodyMiddle(snap.map, target),
      atYou: false,
      attack: true,
    };
  }

  private bodyMiddle(map: MapFile, actor: ActorSnapshot): { x: number; y: number } {
    const visual = this.actorVisualWorld(map, actor);
    const lift = elevationScreenOffset(this.bodyOwnHeight(map, actor, actor.stackIndex) / 2);
    return { x: visual.x + lift.x, y: visual.y + lift.y };
  }

  private damageAnchor(hit: DamageNumber, map: MapFile): { x: number; y: number } {
    const held = this.damageAnchors.get(hit.id);
    if (held) return held;

    const ground = this.cellWorldCenter(hit.x, hit.y, hit.z, map, hit.stackIndex);
    const head = elevationScreenOffset(this.bodyOwnHeight(map, hit, hit.stackIndex));
    const at = { x: ground.x + head.x, y: ground.y + head.y };
    this.damageAnchors.set(hit.id, at);
    return at;
  }

  private forgetStaleDamageAnchors(snap: GameSnapshot) {
    if (this.damageAnchors.size === 0) return;
    const live = new Set(snap.damage.map((hit) => hit.id));
    for (const id of this.damageAnchors.keys()) {
      if (!live.has(id)) this.damageAnchors.delete(id);
    }
  }

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
          this.remaining.read(taperKey(actor.id, instance.defId), instance.remainingMs),
          vfx.taperMs,
        );

        if (vfx.tint) {
          const worn = taperedTint(vfx.tint, taper);
          if (!strongest || worn.strength > strongest.strength) strongest = worn;
        }
        if (!vfx.particles) continue;
        (emitters ??= []).push(this.emitterFor(snap, actor, instance.defId, vfx.particles, taper));
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

    for (const placement of snap.afflicted) {
      for (const defId of placement.defIds) {
        const particles = this.statusDefs[defId]?.vfx?.particles;
        if (!particles) continue;
        const spec = this.groundEmitterFor(snap, placement, defId, particles);
        if (spec) (emitters ??= []).push(spec);
      }
    }

    this.remaining.endFrame();
    return { tints, emitters };
  }

  private groundEmitterFor(
    snap: GameSnapshot,
    placement: AfflictedPlacement,
    defId: string,
    particles: NonNullable<StatusDef["vfx"]["particles"]>,
  ): ParticleEmitterSpec | null {
    const { x, y, z, tileId } = placement;
    const stack = getStack(snap.map, x, y, z);
    const stackIndex = stack.findIndex((placed) => placed.tileId === tileId);
    if (stackIndex < 0) return null;

    const foot = absoluteElevation(z, elevationAt(stack, stackIndex, this.tilesById));
    const top = foot + (this.tilesById[tileId]?.height ?? 0);
    return {
      id: `${x},${y},${z}:${tileId}:${defId}`,
      config: particles,
      cx: x + CELL_CENTRE,
      cy: y + CELL_CENTRE,
      footElev: top,
      z,
      box: depthBox(x, y, top, top + HEIGHT_PER_LEVEL),
      stackBias: depthStackBias(z, stackIndex + 1),
      taper: 1,
    };
  }

  private emitterFor(
    snap: GameSnapshot,
    actor: ActorSnapshot,
    defId: string,
    particles: NonNullable<StatusDef["vfx"]["particles"]>,
    taper: number,
  ): ParticleEmitterSpec {
    const stack = getStack(snap.map, actor.x, actor.y, actor.z);
    const foot = absoluteElevation(actor.z, elevationAt(stack, actor.stackIndex, this.tilesById));
    const bodyHeight = this.tilesById[actor.tileId]?.height ?? HEIGHT_PER_LEVEL;
    const top = foot + bodyHeight;
    return {
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

  private withFlightEffects(
    snap: GameSnapshot,
    emitters: ParticleEmitterSpec[] | undefined,
  ): ParticleEmitterSpec[] | undefined {
    if (snap.flightEffects.length === 0) return emitters;
    let out = emitters;
    for (const effect of snap.flightEffects) {
      const spec = flightEmitter(effect);
      if (spec) (out ??= []).push(spec);
    }
    return out;
  }

  private emitterOverridesFor(snap: GameSnapshot): EmitterOverride[] | undefined {
    if (!this.lightingEnabled) return undefined;

    const overrides: EmitterOverride[] = [];
    for (const actor of snap.actors) {
      const body = this.tilesById[actor.tileId];
      if (!body) continue;
      const bodyEmits = this.bodyEmitsLight(body);
      const carried = this.carriedLightsFor(actor);
      const fromStatuses = this.statusLightsFor(actor);
      if (!bodyEmits && !carried && !fromStatuses) continue;
      const at = this.actorEmitter(snap.map, actor, body.height ?? 0);
      if (bodyEmits) overrides.push(at);
      if (carried) overrides.push({ ...at, lights: carried });
      if (fromStatuses) overrides.push({ ...at, lights: fromStatuses });
    }
    return overrides.length > 0 ? overrides : undefined;
  }

  private withFlightLights(
    snap: GameSnapshot,
    base: EmitterOverride[] | undefined,
  ): EmitterOverride[] | undefined {
    if (!this.lightingEnabled || snap.projectiles.length === 0) return base;
    const aimAt = this.aimAt(snap);
    let out: EmitterOverride[] | undefined;
    for (const flight of snap.projectiles) {
      const light = flightLight(flight, this.tilesById[flight.tileId], aimAt);
      if (!light) continue;
      out ??= [...(base ?? [])];
      out.push(light);
    }
    return out ?? base;
  }

  private statusLightsFor(actor: ActorSnapshot): LightDef[] | undefined {
    if (actor.statuses.length === 0) return undefined;
    let lights: LightDef[] | undefined;
    for (const instance of actor.statuses) {
      const vfx = this.statusDefs[instance.defId]?.vfx;
      if (!vfx?.light) continue;
      const taper = taperAt(
        this.remaining.read(taperKey(actor.id, instance.defId), instance.remainingMs),
        vfx.taperMs,
      );
      (lights ??= []).push(taperedGlow(vfx.light, taper));
    }
    return lights;
  }

  private bodyEmitsLight(body: TileDef): boolean {
    let emits = this.bodyEmitsCache.get(body);
    if (emits === undefined) {
      emits = tileCanEmitLight(body);
      this.bodyEmitsCache.set(body, emits);
    }
    return emits;
  }

  private carriedLightsFor(actor: ActorSnapshot): LightDef[] | undefined {
    if (actor.carriedLights.length === 0) return undefined;
    const lights: LightDef[] = [];
    for (const tileId of actor.carriedLights) {
      const def = this.tilesById[tileId];
      if (!def) continue;
      const light = resolveLight(def, { direction: actor.direction }, this.world.animTimeMs);
      if (light) lights.push(light);
    }
    return lights.length > 0 ? lights : undefined;
  }

  private aimAt(snap: GameSnapshot): AimAt {
    return (targetId) => {
      const actor = snap.actors.find((a) => a.id === targetId);
      if (!actor) return undefined;
      const height = this.tilesById[actor.tileId]?.height ?? HEIGHT_PER_LEVEL;
      const at = this.actorEmitter(snap.map, actor, height);
      return {
        x: at.fx - CELL_CENTRE,
        y: at.fy - CELL_CENTRE,
        elevAbs: at.fz * HEIGHT_PER_LEVEL,
      };
    };
  }

  private actorEmitter(map: MapFile, actor: ActorSnapshot, actorHeight: number): EmitterOverride {
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
    const center = emitterCenter(x, y, z, getStack(map, x, y, z), stackIndex, this.tilesById);
    return { x, y, z, fx: center.fx, fy: center.fy, fz: center.fz };
  }

  private tileMotionsFor(snap: GameSnapshot): TileMotion[] {
    const motions: TileMotion[] = [];
    for (const actor of snap.actors) {
      motions.push(...this.slideMotions(snap.map, actor));

      const own = this.actorMotion(snap.map, actor);
      if (own) motions.push(own);
    }

    return motions;
  }

  private actorMotion(map: MapFile, actor: ActorSnapshot): TileMotion | null {
    const lean = actor.strike ? strikeOffset(actor.strike, actor.strikeProgress) : null;

    if (actor.walk) {
      const { from, to } = actor.walk;
      const stackIndex = actor.stackIndex;
      const visual = this.actorVisualWorld(map, actor);
      const fromCenter = this.cellWorldCenter(from.x, from.y, from.z, map, stackIndex);
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
        alsoDrawAtZ: to.z < from.z ? to.z : undefined,
        box: {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          foot,
          top:
            foot +
            steppingClumpHeight(
              { stack: getStack(map, from.x, from.y, from.z), stackIndex },
              { stack: destStack, arriving: def },
              t,
              this.tilesById,
            ),
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

  private slideMotions(map: MapFile, actor: ActorSnapshot): TileMotion[] {
    if (!actor.slide) return [];
    return slideTileMotions(map, this.tilesById, actor.slide, actor.slideProgress);
  }

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

  private bodyOwnHeight(
    map: MapFile,
    cell: { x: number; y: number; z: number },
    stackIndex: number,
  ): number {
    const placed = getStack(map, cell.x, cell.y, cell.z)[stackIndex];
    if (!placed) return 0;
    return this.tilesById[placed.tileId]?.height ?? 0;
  }

  private standingFootAbs(
    map: MapFile,
    cell: { x: number; y: number; z: number },
    stackIndex: number,
  ): number {
    return standingFootAbs(map, this.tilesById, cell, stackIndex);
  }

  private surfaceFootAbs(map: MapFile, x: number, y: number, z: number): number {
    return z * HEIGHT_PER_LEVEL + stackHeight(getStack(map, x, y, z), this.tilesById);
  }

  private actorVisualWorld(map: MapFile, actor: ActorSnapshot): { x: number; y: number } {
    if (actor.walk) {
      const a = this.cellWorldCenter(
        actor.walk.from.x,
        actor.walk.from.y,
        actor.walk.from.z,
        map,
        actor.stackIndex,
      );
      const b = this.surfaceWorldCenter(actor.walk.to.x, actor.walk.to.y, actor.walk.to.z, map);
      const t = actor.walkProgress;
      return snapToWholePixels({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }

    const base = this.cellWorldCenter(actor.x, actor.y, actor.z, map, actor.stackIndex);
    if (actor.fall) {
      const drop = fallDropPx(map, this.tilesById, actor);
      return snapToWholePixels({ x: base.x + drop, y: base.y + drop });
    }
    return base;
  }

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
    const elev = stackHeight(sceneryStack(map, x, y, z, stackIndex), this.tilesById);
    const origin = baseCellWorldOrigin(x, y, z, elev);
    return { x: origin.x + 4, y: origin.y + 4 };
  }
}

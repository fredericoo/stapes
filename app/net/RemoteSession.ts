import {
  DAMAGE_NUMBER_LIFETIME_MS,
  FALL_MS_PER_HEIGHT,
  NOISE_LIFETIME_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  STRIKE_DURATION_MS,
  WALK_DURATION_MS,
} from "../game/constants";
import {
  incapacitated,
  inCombat,
  UNKNOWN_REMAINING_MS,
  type StatusInstance,
  walkSpeedPercentFrom,
} from "../game/statuses";
import { combatantOf, type Combatant, mayHarm } from "../game/pvp";
import {
  ageEffects,
  ageFlights,
  beginEffect,
  type FlightEffect,
  flightDurationMs,
  type ProjectileFlight,
} from "../game/projectile";
import { resolveProjectile } from "../lib/projectile";

import {
  MAX_HELD_TRANSITIONS,
  MAX_TRANSITION_MS,
  type HeldTransition,
  type TileTransitionNote,
} from "../lib/tileTransition";
import type { StrikeState } from "../game/strike";
import { actorDirection, actorStillAt, locateActor, type ActorLocation } from "../game/actors";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import {
  canConsumeFrom,
  canTalkFrom,
  canDropAt,
  canEquipFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSwitchFrom,
  canAddStatusFrom,
  canRemoveStatusFrom,
  canSetSpawnFrom,
  canTeleportFrom,
  type ObjectRef,
} from "../game/affordances";
import { canBeginExtract, type Extraction, type ExtractionProgress } from "../game/extract";
import { type Progress, windProgress } from "../game/progress";
import { gravityPullOn } from "../game/gravity";
import { type Equipment, emptyEquipment } from "../game/equipment";
import { type Attributes, attributesOf } from "../game/attributes";
import {
  castability,
  castableSpells,
  type CastContext,
  type CasterPoint,
  type CastPoint,
  type CastProgress,
  type CastSlot,
  type SpellButton,
} from "../game/casting";
import { castRefusalNotice } from "../game/notices";
import { masteriesFromXp, type MasteryXp } from "../lib/mastery";
import { type NaturalSpell, resolveBattler } from "../lib/battler";
import type { StatusDef } from "../lib/status";
import { canMoveItem, itemInSlot, type SlotRef } from "../game/itemMoves";
import type { ConsumeSource } from "../game/itemUse";
import { canCraftFrom } from "../game/craft";
import { resolveConsumable } from "../lib/item";
import { moveEntity, setEntityDirection } from "../game/mapMutations";
import { chooseStep } from "../game/stepping";
import type {
  ActorSnapshot,
  ChatBubble,
  DamageNumber,
  FallState,
  NoiseEmission,
  GameInput,
  GameSnapshot,
  PlaySession,
  WalkState,
} from "../game/GameSession";
import { groundWalkSpeedPercent, standingAbs, walkDurationMsFor } from "../game/movement";
import { STRIKE_RECOVERY_STEPS, strikeRecoveryMs } from "../game/combat";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import {
  absoluteStandingElevation,
  chunkifyMap,
  emptyMap,
  getStack,
  isPlayerBody,
  setStacks,
} from "../lib/mapData";
import type { Coord, Direction, FlatMapFile, MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { CHAT_LIFETIME_MS, MAX_CHAT_LENGTH, MAX_CHATS_PER_CELL } from "./chat";
import { MAX_COMMAND_LENGTH, isCommand } from "../game/commands";
import { SOCKET_OPEN, type ClientSocket } from "./socket";
import {
  parseServerMessage,
  type CellPatch,
  type ClientMessage,
  type CarriedLightsPatch,
  type AfflictedPatch,
  type StatusIdsPatch,
  type PvpPatch,
  type CastingPatch,
  type ExtractionPatch,
  type HpPatch,
  type NamePatch,
  type MotionEvent,
  MAX_STEPS_AHEAD,
} from "./protocol";

type LiveChat = ChatBubble & { elapsedMs: number };

type RemoteMotion = {
  walk: WalkState | null;
  fall: FallState | null;
  slide: {
    object: ObjectRef;
    from: { x: number; y: number; z: number };
    count: number;
    elapsedMs: number;
  } | null;
  strike: StrikeState | null;
  lastSeen: (Coord & { stackIndex: number }) | null;
};

type PredictedStep = {
  seq: number;
  to: Coord;
  direction: Direction;
  landed: boolean;
  waitedMs: number;
  durationMs: number;
};

const MAX_PREDICTED_STEPS = MAX_STEPS_AHEAD;

export const STEP_CONFIRM_GRACE_MS = 2_000;

export class RemoteSession implements PlaySession {
  private serverMap: MapFile = emptyMap();
  private map: MapFile = emptyMap();
  private readonly tilesById: Record<string, TileDef>;
  private selfId = "";
  private serverMinutesOfDay: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private readonly motions = new Map<string, RemoteMotion>();
  private pending: PredictedStep[] = [];
  private nextStepSeq = 0;
  private held: GameInput = { directions: [] };
  private facing: Direction | null = null;
  private attackRecoveryMs = 0;
  private serverSeen: ActorLocation | null = null;
  private chats: LiveChat[] = [];
  private nextChatId = 0;
  private noises: NoiseEmission[] = [];
  private readonly hps = new Map<string, { hp: number; maxHp: number; rating: number }>();
  private readonly names = new Map<string, string>();
  private readonly carriedLights = new Map<string, string[]>();
  private readonly statusesById = new Map<string, StatusInstance[]>();
  private readonly extractionsById = new Map<string, ExtractionProgress>();
  private readonly pvpOn = new Set<string>();
  private readonly castingsById = new Map<string, CastProgress>();
  private equipment: Equipment = emptyEquipment();
  private spellCooldowns: Readonly<Record<string, number>> = {};
  private pendingNotices: string[] = [];
  private tags: readonly string[] = NO_TAGS;
  private spawnAt: Coord | null = null;
  private conversation: Conversation | null = null;
  private extracting: Extraction | null = null;
  private nextBlow: Progress | null = null;
  private masteryXp: MasteryXp = {};
  private damage: DamageNumber[] = [];
  private projectiles: ProjectileFlight[] = [];
  private flightEffects: FlightEffect[] = [];
  private transitions: Array<{ note: TileTransitionNote; heardAtMs: number }> = [];
  private targetId: string | null = null;
  private attacking = false;
  private lastSelf: ActorSnapshot | null = null;
  private ready = false;
  private onReady: (() => void) | null = null;
  private dead = false;
  private onDead: ((dead: boolean) => void) | null = null;
  private onRestarting: (() => void) | null = null;
  private onOutdated: ((serverVersion: number) => void) | null = null;
  private players: number | null = null;
  private onPlayers: ((count: number | null) => void) | null = null;
  private hidden = false;
  private onHidden: ((hidden: boolean) => void) | null = null;
  private onClockSet: ((minutes: MinutesOfDay) => void) | null = null;

  constructor(
    private readonly socket: ClientSocket,
    tiles: TileDef[],
    private readonly statusDefs: Record<string, StatusDef> = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tilesById = tilesByIdFromList(tiles);
    socket.addEventListener("message", this.onMessage);
  }

  setOnReady(cb: (() => void) | null) {
    this.onReady = cb;
    if (this.ready) cb?.();
  }

  isReady(): boolean {
    return this.ready;
  }

  setOnRestarting(cb: (() => void) | null) {
    this.onRestarting = cb;
  }

  setOnOutdated(cb: ((serverVersion: number) => void) | null) {
    this.onOutdated = cb;
  }

  setOnDead(cb: ((dead: boolean) => void) | null) {
    this.onDead = cb;
    cb?.(this.dead);
  }

  isDead(): boolean {
    return this.dead;
  }

  rebirth() {
    if (!this.dead) return;
    this.send({ type: "rebirth" });
  }

  setOnPlayers(cb: ((count: number | null) => void) | null) {
    this.onPlayers = cb;
    if (this.ready) cb?.(this.players);
  }

  playerCount(): number | null {
    return this.players;
  }

  setOnHidden(cb: ((hidden: boolean) => void) | null) {
    this.onHidden = cb;
    cb?.(this.hidden);
  }

  setHidden(enabled: boolean) {
    this.send({ type: "hidden", enabled });
  }

  private setHiddenState(hidden: boolean) {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.onHidden?.(hidden);
  }

  private setDead(dead: boolean) {
    if (dead === this.dead) return;
    this.dead = dead;
    this.onDead?.(dead);
  }

  private setPlayers(count: number | null) {
    if (count === this.players) return;
    this.players = count;
    this.onPlayers?.(count);
  }

  minutesOfDay(): MinutesOfDay {
    return this.serverMinutesOfDay;
  }

  setOnClockSet(cb: ((minutes: MinutesOfDay) => void) | null) {
    this.onClockSet = cb;
  }

  private setClock(minutes: MinutesOfDay) {
    this.serverMinutesOfDay = minutes;
    this.onClockSet?.(minutes);
  }

  dispose() {
    this.socket.removeEventListener("message", this.onMessage);
  }

  private onMessage = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (!message) return;

    if (message.type === "serverRestarting") {
      this.onRestarting?.();
      return;
    }

    if (message.type === "keepalive") {
      return;
    }

    if (message.type === "outdated") {
      this.onOutdated?.(message.serverVersion);
      return;
    }

    if (message.type === "clock") {
      this.setClock(message.minutesOfDay);
      return;
    }

    if (message.type === "players") {
      this.setPlayers(message.playerCount);
      return;
    }

    if (message.type === "hello") {
      this.selfId = message.selfId;
      this.setClock(message.minutesOfDay);
      this.serverMap = chunkifyMap(message.map as FlatMapFile);
      this.map = this.serverMap;
      this.pending = [];
      this.attackRecoveryMs = 0;
      this.facing = null;
      this.serverSeen = null;
      this.lastSelf = null;
      this.motions.clear();
      this.chats = [];
      this.damage = [];
      this.projectiles = [];
      this.flightEffects = [];
      this.transitions = [];
      this.targetId = null;
      if (this.attacking) this.send({ type: "attackMode", enabled: true });
      this.hps.clear();
      this.carriedLights.clear();
      this.statusesById.clear();
      this.pvpOn.clear();
      this.extractionsById.clear();
      this.castingsById.clear();
      this.equipment = message.equipment;
      this.spellCooldowns = {};
      this.tags = message.tags;
      this.spawnAt = message.spawnAt;
      this.setExtracting(message.extracting);
      this.nextBlow = message.nextBlow ? { ...message.nextBlow } : null;
      this.masteryXp = message.masteryXp;
      this.statuses = message.statuses.map((patch) => ({
        defId: patch.defId,
        remainingMs: patch.remainingMs,
        durationMs: patch.durationMs,
        sinceEffectMs: 0,
      }));
      for (const id of message.actorIds) this.motions.set(id, emptyMotion());
      this.names.clear();
      this.applyNames(message.names);
      this.applyHps(message.hps);
      this.applyCarriedLights(message.carriedLights);
      this.applyStatusIds(message.statusIds);
      this.applyPvp(message.pvp);
      this.applyExtractions(message.extractions);
      this.applyCastings(message.castings);
      this.resetAfflicted(message.afflicted);
      this.setPlayers(message.playerCount ?? null);
      this.setDead(false);
      this.ready = true;
      this.onReady?.();
      return;
    }

    if (message.type === "chat") {
      this.chats.push({
        id: `chat-${this.nextChatId++}`,
        actorId: message.actorId,
        tileId: message.tileId,
        name: message.name,
        text: message.text,
        x: message.x,
        y: message.y,
        z: message.z,
        stackIndex: message.stackIndex,
        elapsedMs: 0,
      });
      this.evictOldestAtCell(message);
      return;
    }

    if (message.type === "noise") {
      this.noises.push({
        id: message.id,
        text: message.text,
        x: message.x,
        y: message.y,
        z: message.z,
        stackIndex: message.stackIndex,
        elapsedMs: 0,
      });
      return;
    }

    if (message.type === "stepRejected") {
      this.rollBackFrom(message.seq);
      return;
    }

    if (message.type === "tags") {
      this.tags = message.tags;
      return;
    }

    if (message.type === "spawnPoint") {
      this.spawnAt = message.at;
      return;
    }

    if (message.type === "conversation") {
      this.conversation = message.conversation;
      return;
    }

    if (message.type === "extracting") {
      this.setExtracting(message.extracting);
      return;
    }

    if (message.type === "nextBlow") {
      this.nextBlow = message.nextBlow ? { ...message.nextBlow } : null;
      return;
    }

    if (message.type === "notice") {
      this.pendingNotices.push(message.text);
      return;
    }

    if (message.type === "hidden") {
      this.setHiddenState(message.on);
      return;
    }

    if (message.type === "masteries") {
      this.masteryXp = message.masteryXp;
      return;
    }

    if (message.type === "died") {
      this.equipment = message.equipment;
      this.spellCooldowns = {};
      this.held = { directions: [] };
      this.pending = [];
      this.attackRecoveryMs = 0;
      this.statuses = NO_STATUSES;
      this.setDead(true);
      return;
    }

    if (message.type === "equipment") {
      this.equipment = message.equipment;
      this.spellCooldowns = message.spellCooldowns;
      return;
    }

    if (message.type === "statuses") {
      this.statuses = message.statuses.map((patch) => ({
        defId: patch.defId,
        remainingMs: patch.remainingMs,
        durationMs: patch.durationMs,
        sinceEffectMs: 0,
      }));
      return;
    }

    const leaving = this.applyCells(message.cells);
    this.applyNames(message.names);
    this.applyHps(message.hps);
    this.applyCarriedLights(message.carriedLights);
    this.applyStatusIds(message.statusIds);
    this.applyPvp(message.pvp);
    this.applyExtractions(message.extractions);
    this.applyCastings(message.castings);
    for (const event of message.events) this.applyEvent(event);
    this.forgetDeparted(leaving);
    this.rebuildPredicted();
  };

  private setExtracting(extracting: Extraction | null) {
    this.extracting = extracting ? { ...extracting } : null;
  }

  private statuses: readonly StatusInstance[] = NO_STATUSES;

  private applyNames(patches: NamePatch[]) {
    for (const patch of patches) this.names.set(patch.actorId, patch.name);
  }

  private applyHps(hps: HpPatch[]) {
    for (const patch of hps) {
      this.hps.set(patch.actorId, {
        hp: patch.hp,
        maxHp: patch.maxHp,
        rating: patch.rating,
      });
    }
  }

  private applyCarriedLights(patches: CarriedLightsPatch[]) {
    for (const patch of patches) {
      this.carriedLights.set(patch.actorId, patch.tileIds);
    }
  }

  private readonly afflictedByCell = new Map<string, AfflictedPatch[]>();
  private afflicted: AfflictedPatch[] = [];

  private resetAfflicted(burning: AfflictedPatch[]) {
    this.afflictedByCell.clear();
    for (const one of burning) {
      const key = `${one.x},${one.y},${one.z}`;
      const entries = this.afflictedByCell.get(key);
      if (entries) entries.push(one);
      else this.afflictedByCell.set(key, [one]);
    }
    this.afflicted = [...this.afflictedByCell.values()].flat();
  }

  private applyAfflicted(cells: CellPatch[]) {
    let changed = false;
    for (const cell of cells) {
      const key = `${cell.x},${cell.y},${cell.z}`;
      if (cell.afflicted?.length) {
        const { x, y, z } = cell;
        this.afflictedByCell.set(
          key,
          cell.afflicted.map((one) => ({ x, y, z, ...one })),
        );
        changed = true;
      } else if (this.afflictedByCell.delete(key)) {
        changed = true;
      }
    }
    if (changed) this.afflicted = [...this.afflictedByCell.values()].flat();
  }

  private applyStatusIds(patches: StatusIdsPatch[]) {
    for (const patch of patches) {
      this.statusesById.set(
        patch.actorId,
        patch.defIds.map((defId) => ({
          defId,
          remainingMs: UNKNOWN_REMAINING_MS,
          durationMs: UNKNOWN_REMAINING_MS,
          sinceEffectMs: 0,
        })),
      );
    }
  }

  private applyPvp(patches: PvpPatch[]) {
    for (const patch of patches) {
      if (patch.on) this.pvpOn.add(patch.actorId);
      else this.pvpOn.delete(patch.actorId);
    }
  }

  private applyExtractions(patches: ExtractionPatch[]) {
    for (const patch of patches) {
      if (patch.progress) {
        this.extractionsById.set(patch.actorId, { ...patch.progress });
      } else {
        this.extractionsById.delete(patch.actorId);
      }
    }
  }

  private applyCastings(patches: CastingPatch[]) {
    for (const patch of patches) {
      if (patch.progress) {
        this.castingsById.set(patch.actorId, { ...patch.progress });
      } else {
        this.castingsById.delete(patch.actorId);
      }
    }
  }

  /**
   * Read off `serverMap`, not `map`. Events are applied after the frame's
   * cells and before `rebuildPredicted`, so at this point `map` is still the
   * previous frame's board.
   */
  private walkDurationAt(actorId: string, at: { x: number; y: number; z: number }): number {
    const stack = getStack(this.serverMap, at.x, at.y, at.z);
    const stackIndex = stack.findIndex((placed) => placed.owner === actorId);
    const def = stackIndex < 0 ? undefined : this.tilesById[stack[stackIndex]!.tileId];
    if (!def) return WALK_DURATION_MS;
    return walkDurationMsFor(
      def,
      this.walkSpeedPercentOf(actorId) +
        groundWalkSpeedPercent(this.serverMap, { ...at, stackIndex }, this.tilesById),
    );
  }

  private attributesOf(self: ActorSnapshot): Attributes | null {
    if (self.maxHp === null) return null;
    const bodyDef = this.tilesById[self.tileId];
    const authored = bodyDef ? resolveBattler(bodyDef) : null;
    if (!bodyDef || !authored) return null;
    return attributesOf({
      body: { ...authored, masteries: masteriesFromXp(this.masteryXp) },
      bodyDef,
      equipment: this.equipment,
      tilesById: this.tilesById,
      statuses: this.statuses,
      statusDefs: this.statusDefs,
      hp: self.hp,
    });
  }

  private incapacitated(): boolean {
    return incapacitated(this.statuses, this.statusDefs);
  }

  private walkSpeedPercentOf(actorId: string): number {
    const statuses =
      actorId === this.selfId ? this.statuses : (this.statusesById.get(actorId) ?? NO_STATUSES);
    return walkSpeedPercentFrom(statuses, this.statusDefs);
  }

  private applyCells(cells: CellPatch[]): readonly string[] {
    if (cells.length === 0) return NO_OWNERS;
    this.applyAfflicted(cells);
    const leaving = this.ownersLeaving(cells);
    this.serverMap = setStacks(this.serverMap, cells);
    return leaving;
  }

  private ownersLeaving(cells: CellPatch[]): readonly string[] {
    const left = new Set<string>();
    for (const cell of cells) {
      for (const placed of getStack(this.serverMap, cell.x, cell.y, cell.z)) {
        if (placed.owner && placed.owner !== this.selfId) left.add(placed.owner);
      }
    }
    if (left.size === 0) return NO_OWNERS;
    for (const cell of cells) {
      for (const placed of cell.stack) {
        if (placed.owner) left.delete(placed.owner);
      }
    }
    return left.size === 0 ? NO_OWNERS : [...left];
  }

  private forgetDeparted(leaving: readonly string[]) {
    for (const id of leaving) {
      if (!this.motions.has(id)) continue;
      if (locateActor(this.serverMap, id)) continue;
      this.forgetActor(id);
    }
  }

  private forgetActor(id: string) {
    this.motions.delete(id);
    this.hps.delete(id);
    this.carriedLights.delete(id);
    this.statusesById.delete(id);
    this.pvpOn.delete(id);
    this.extractionsById.delete(id);
    this.castingsById.delete(id);
    if (this.targetId === id) this.targetId = null;
  }

  private applyEvent(event: MotionEvent) {
    if (event.kind === "joined") return;
    if (event.kind === "left") {
      this.forgetActor(event.actorId);
      return;
    }

    if (event.kind === "spawned") {
      if (!this.motions.has(event.actorId)) {
        const motion = emptyMotion();
        motion.lastSeen = event.at;
        this.motions.set(event.actorId, motion);
      }
      return;
    }

    if (event.kind === "despawned") {
      this.forgetActor(event.actorId);
      return;
    }

    if (event.kind === "damage") {
      this.damage.push({
        id: event.id,
        targetId: event.targetId,
        outcome: event.outcome,
        amount: event.amount,
        x: event.x,
        y: event.y,
        z: event.z,
        stackIndex: event.stackIndex,
        elapsedMs: 0,
      });
      return;
    }

    if (event.kind === "projectileFired") {
      const def = this.tilesById[event.tileId];
      const flies = resolveProjectile(def);
      if (!flies) return;
      const flight: ProjectileFlight = {
        id: event.id,
        tileId: event.tileId,
        from: event.from,
        to: event.to,
        ...(event.targetId ? { targetId: event.targetId } : {}),
        durationMs: flightDurationMs(event.from, event.to, flies),
        elapsedMs: 0,
        hit: event.hit,
      };
      this.projectiles.push(flight);
      beginEffect(flight, "appear", flight.from, def, this.flightEffects);
      return;
    }

    if (event.kind === "teleported") {
      this.motions.set(event.actorId, emptyMotion());
      if (event.actorId === this.selfId) this.abandonPrediction();
      return;
    }

    if (event.kind === "strikeStarted") {
      const striking = this.motions.get(event.actorId) ?? emptyMotion();
      this.motions.set(event.actorId, striking);
      striking.strike = {
        kind: event.strike,
        dx: event.dx,
        dy: event.dy,
        dElev: event.dElev,
        elapsedMs: 0,
      };
      return;
    }

    if (event.kind === "tileTransition") {
      const { kind: _kind, ...note } = event;
      this.holdTransition(note);
      return;
    }

    if (event.kind === "swung") {
      if (event.actorId !== this.selfId) return;
      const def = this.tilesById[PLAYER_TILE_ID];
      this.attackRecoveryMs = def
        ? strikeRecoveryMs(def)
        : WALK_DURATION_MS * STRIKE_RECOVERY_STEPS;
      this.facing = null;
      return;
    }

    if (event.actorId === this.selfId) {
      if (event.kind === "walkStarted" && this.pending.length > 0) return;
      this.abandonPrediction();
    }

    const motion = this.motions.get(event.actorId) ?? emptyMotion();
    this.motions.set(event.actorId, motion);

    if (event.kind === "walkStarted") {
      motion.walk = {
        from: event.from,
        to: event.to,
        direction: event.direction,
        elapsedMs: 0,
        durationMs: this.walkDurationAt(event.actorId, event.from),
      };
    } else if (event.kind === "fallStarted") {
      motion.fall = {
        feetAbs: event.feetAbs,
        landingAbs: event.landingAbs,
        elapsedMs: 0,
      };
    } else {
      motion.slide = {
        object: event.object,
        from: event.from,
        count: event.count,
        elapsedMs: 0,
      };
    }
  }

  update(dtMs: number) {
    for (const [id, motion] of this.motions) {
      if (motion.walk) {
        motion.walk.elapsedMs = this.isPredicting(id)
          ? motion.walk.elapsedMs + dtMs
          : Math.min(motion.walk.durationMs, motion.walk.elapsedMs + dtMs);
      }
      const fall = motion.fall;
      if (fall && fall.feetAbs > fall.landingAbs) {
        fall.elapsedMs += dtMs;
        while (fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
          fall.elapsedMs -= FALL_MS_PER_HEIGHT;
          const nextFeet = fall.feetAbs - 1;
          if (nextFeet <= fall.landingAbs) {
            fall.feetAbs = fall.landingAbs;
            fall.elapsedMs = 0;
            break;
          }
          fall.feetAbs = nextFeet;
        }
      }
      if (motion.slide) {
        motion.slide.elapsedMs += dtMs;
        if (motion.slide.elapsedMs >= PUSH_STEP_MS) motion.slide = null;
      }
      if (motion.strike) {
        motion.strike.elapsedMs += dtMs;
        if (motion.strike.elapsedMs >= STRIKE_DURATION_MS) motion.strike = null;
      }
    }

    if (this.attackRecoveryMs > 0) {
      this.attackRecoveryMs = Math.max(0, this.attackRecoveryMs - dtMs);
    }
    this.windBars(dtMs);
    this.agePendingSteps(dtMs);
    this.advancePrediction();
    this.expireChats(dtMs);
    this.expireNoises(dtMs);
    this.expireDamage(dtMs);
    this.expireProjectiles(dtMs);
  }

  takeTransitions(): HeldTransition[] {
    const at = this.now();
    const taken: HeldTransition[] = [];
    for (const held of this.transitions) {
      const ageMs = at - held.heardAtMs;
      if (ageMs < MAX_TRANSITION_MS) taken.push({ note: held.note, ageMs });
    }
    this.transitions = [];
    return taken;
  }

  private holdTransition(note: TileTransitionNote) {
    const at = this.now();
    this.transitions = this.transitions.filter((held) => at - held.heardAtMs < MAX_TRANSITION_MS);
    this.transitions.push({ note, heardAtMs: at });
    if (this.transitions.length > MAX_HELD_TRANSITIONS) this.transitions.shift();
  }

  private windBars(dtMs: number) {
    if (this.extracting) windProgress(this.extracting, dtMs);
    if (this.nextBlow) windProgress(this.nextBlow, dtMs);
    for (const running of this.extractionsById.values()) {
      windProgress(running, dtMs);
    }
    for (const casting of this.castingsById.values()) {
      windProgress(casting, dtMs);
    }
  }

  private expireProjectiles(dtMs: number) {
    if (this.projectiles.length > 0) {
      this.projectiles = ageFlights(this.projectiles, dtMs, this.tilesById, this.flightEffects);
    }
    if (this.flightEffects.length > 0) {
      this.flightEffects = ageEffects(this.flightEffects, dtMs);
    }
  }

  private expireDamage(dtMs: number) {
    if (this.damage.length === 0) return;
    let expired = false;
    for (const number of this.damage) {
      number.elapsedMs += dtMs;
      if (number.elapsedMs >= DAMAGE_NUMBER_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.damage = this.damage.filter((number) => number.elapsedMs < DAMAGE_NUMBER_LIFETIME_MS);
    }
  }

  private advancePrediction() {
    for (let taken = 0; taken < MAX_PREDICTED_STEPS; taken++) {
      const carryMs = this.landPredictedStep();
      this.predictStep(carryMs ?? 0);
      if (carryMs === null) return;
    }
  }

  private isPredicting(id: string): boolean {
    if (id !== this.selfId) return false;
    const last = this.pending[this.pending.length - 1];
    return last ? !last.landed : false;
  }

  private agePendingSteps(dtMs: number) {
    const oldest = this.pending[0];
    if (!oldest) return;
    oldest.waitedMs += dtMs;
    if (oldest.waitedMs >= oldest.durationMs + STEP_CONFIRM_GRACE_MS) {
      this.abandonPrediction();
    }
  }

  private landPredictedStep(): number | null {
    const motion = this.motions.get(this.selfId);
    const walk = motion?.walk;
    if (!motion || !walk || walk.elapsedMs < walk.durationMs) return null;

    const step = this.pending.find((pending) => !pending.landed);
    if (!step) return null;

    const at = locateActor(this.map, this.selfId, motion.lastSeen ?? undefined);
    if (!at) return null;

    const carryMs = walk.elapsedMs - walk.durationMs;

    this.map = moveEntity(this.map, at, step.to, step.direction, this.tilesById);
    step.landed = true;
    motion.walk = null;
    const stack = getStack(this.map, step.to.x, step.to.y, step.to.z);
    motion.lastSeen = { ...step.to, stackIndex: stack.length - 1 };
    return carryMs;
  }

  private predictStep(elapsedMs = 0) {
    if (this.held.directions.length === 0) return;

    const motion = this.motions.get(this.selfId);
    if (!motion || motion.walk || motion.fall || motion.slide) return;
    if (this.pending.length >= MAX_PREDICTED_STEPS) return;

    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) return;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return;

    if (gravityPullOn(this.map, loc, def, this.tilesById).kind === "fall") {
      return;
    }

    if (this.incapacitated()) return;

    const choice = chooseStep(this.map, loc, this.held, def, this.tilesById, (to) =>
      this.destinationTaken(to),
    );
    if (!choice) return;

    if (this.attackRecoveryMs > 0) return;

    this.face(loc, choice.facing);
    if (!choice.step) return;
    if (this.castingsById.get(this.selfId)) return;

    const seq = this.nextStepSeq++;
    const durationMs = walkDurationMsFor(
      def,
      this.walkSpeedPercentOf(this.selfId) + groundWalkSpeedPercent(this.map, loc, this.tilesById),
    );
    motion.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs,
      durationMs,
    };
    this.pending.push({
      seq,
      to: choice.step.to,
      direction: choice.step.direction,
      landed: false,
      waitedMs: 0,
      durationMs,
    });
    this.send({
      type: "step",
      seq,
      direction: choice.step.direction,
      preferDescend: Boolean(this.held.preferDescend),
    });
  }

  private face(loc: Coord & { stackIndex: number }, direction: Direction) {
    this.map = setEntityDirection(this.map, loc.x, loc.y, loc.z, loc.stackIndex, direction);
    if (this.facing === direction) return;
    this.facing = direction;
    this.send({ type: "face", direction });
  }

  private destinationTaken(to: Coord): boolean {
    for (const [id, motion] of this.motions) {
      if (id === this.selfId) continue;
      const other = motion.walk?.to;
      if (!other || other.x !== to.x || other.y !== to.y || other.z !== to.z) {
        continue;
      }
      const loc = this.locate(id, motion);
      if (loc && isPlayerBody(loc.placed)) continue;
      return true;
    }
    return false;
  }

  private rebuildPredicted() {
    const at = locateActor(this.serverMap, this.selfId, this.serverSeen ?? undefined);
    this.serverSeen = at;

    if (!at) {
      this.pending = [];
      this.map = this.serverMap;
      return;
    }

    this.dropConfirmedSteps(at);

    let map = this.serverMap;
    let loc: Coord & { stackIndex: number } = at;
    for (const step of this.pending) {
      if (!step.landed) break;
      if (!actorStillAt(map, this.selfId, loc)) {
        this.abandonPrediction();
        return;
      }
      map = moveEntity(map, loc, step.to, step.direction, this.tilesById);
      const stack = getStack(map, step.to.x, step.to.y, step.to.z);
      loc = { ...step.to, stackIndex: stack.length - 1 };
    }

    if (this.facing) {
      map = setEntityDirection(map, loc.x, loc.y, loc.z, loc.stackIndex, this.facing);
    }
    this.map = map;
  }

  private dropConfirmedSteps(at: Coord) {
    while (this.pending.length > 0) {
      const step = this.pending[0]!;
      if (step.to.x !== at.x || step.to.y !== at.y || step.to.z !== at.z) return;
      this.pending.shift();
      if (!step.landed) {
        const motion = this.motions.get(this.selfId);
        if (motion) motion.walk = null;
      }
    }
  }

  private rollBackFrom(seq: number) {
    const at = this.pending.findIndex((step) => step.seq === seq);
    if (at < 0) return;
    this.pending.length = at;
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.rebuildPredicted();
  }

  private abandonPrediction() {
    if (this.pending.length === 0) return;
    this.pending = [];
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.map = this.serverMap;
  }

  private evictOldestAtCell(at: { x: number; y: number; z: number }) {
    const here = this.chats.filter((chat) => chat.x === at.x && chat.y === at.y && chat.z === at.z);
    if (here.length <= MAX_CHATS_PER_CELL) return;
    const doomed = new Set(here.slice(0, here.length - MAX_CHATS_PER_CELL));
    this.chats = this.chats.filter((chat) => !doomed.has(chat));
  }

  private expireChats(dtMs: number) {
    if (this.chats.length === 0) return;
    let expired = false;
    for (const chat of this.chats) {
      chat.elapsedMs += dtMs;
      if (chat.elapsedMs >= CHAT_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.chats = this.chats.filter((chat) => chat.elapsedMs < CHAT_LIFETIME_MS);
    }
  }

  private expireNoises(dtMs: number) {
    if (this.noises.length === 0) return;
    let expired = false;
    for (const noise of this.noises) {
      noise.elapsedMs += dtMs;
      if (noise.elapsedMs >= NOISE_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.noises = this.noises.filter((noise) => noise.elapsedMs < NOISE_LIFETIME_MS);
    }
  }

  say(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (isCommand(trimmed)) {
      this.send({ type: "command", text: trimmed.slice(0, MAX_COMMAND_LENGTH) });
      return;
    }
    this.send({ type: "say", text: trimmed.slice(0, MAX_CHAT_LENGTH) });
  }

  getMap(): MapFile {
    return this.map;
  }

  private locate(id: string, motion: RemoteMotion): ActorLocation | null {
    const found = locateActor(this.map, id, motion.lastSeen ?? undefined);
    motion.lastSeen = found;
    if (found) {
      this.releaseArrivedWalk(motion, found);
      this.releaseLandedFall(motion, found);
    }
    return found;
  }

  private releaseArrivedWalk(motion: RemoteMotion, at: ActorLocation) {
    const from = motion.walk?.from;
    if (!from) return;
    if (at.x !== from.x || at.y !== from.y || at.z !== from.z) {
      motion.walk = null;
    }
  }

  private releaseLandedFall(motion: RemoteMotion, at: ActorLocation) {
    const fall = motion.fall;
    if (!fall || fall.feetAbs > fall.landingAbs) return;
    const footAbs = standingAbs(this.map, at.x, at.y, at.z, at.stackIndex, this.tilesById);
    if (footAbs <= fall.landingAbs) motion.fall = null;
  }

  private actorSnapshot(id: string, motion: RemoteMotion): ActorSnapshot | null {
    const loc = this.locate(id, motion);
    if (!loc) return null;

    const health = this.hps.get(id);

    return {
      id,
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: motion.walk,
      fall: motion.fall,
      walkProgress: motion.walk ? Math.min(1, motion.walk.elapsedMs / motion.walk.durationMs) : 0,
      fallProgress: motion.fall ? motion.fall.elapsedMs / FALL_MS_PER_HEIGHT : 0,
      slide: motion.slide,
      slideProgress: motion.slide ? Math.min(1, motion.slide.elapsedMs / PUSH_STEP_MS) : 0,
      strike: motion.strike,
      strikeProgress: motion.strike ? Math.min(1, motion.strike.elapsedMs / STRIKE_DURATION_MS) : 0,
      name: this.names.get(id) ?? null,
      hp: health?.hp ?? null,
      maxHp: health?.maxHp ?? null,
      rating: health?.rating ?? null,
      statuses: id === this.selfId ? this.statuses : (this.statusesById.get(id) ?? NO_STATUSES),
      carriedLights: this.carriedLights.get(id) ?? NO_CARRIED_LIGHTS,
      extracting: id === this.selfId ? this.extracting : (this.extractionsById.get(id) ?? null),
      casting: this.castingsById.get(id) ?? null,
      pvp: this.pvpOn.has(id),
      hidden: false,
    };
  }

  getSnapshot(): GameSnapshot {
    const actors: ActorSnapshot[] = [];
    let self: ActorSnapshot | null = null;
    for (const [id, motion] of this.motions) {
      const snapshot = this.actorSnapshot(id, motion);
      if (!snapshot) continue;
      actors.push(snapshot);
      if (id === this.selfId) self = snapshot;
    }
    if (self) this.lastSelf = self;
    const mine = self ?? this.lastSelf ?? offscreenActor(this.selfId);

    return {
      map: this.map,
      self: mine,
      actors,
      targetId: this.targetId,
      attacking: this.attacking,
      equipment: this.equipment,
      tags: this.tags,
      spawnAt: this.spawnAt,
      conversation: this.conversation,
      extracting: this.extracting,
      nextBlow: this.nextBlow,
      masteryXp: this.masteryXp,
      attributes: this.attributesOf(mine),
      pvp: { on: mine.pvp, changeable: this.canSetPvp() },
      chats: this.chats,
      noises: this.noises,
      afflicted: this.afflicted,
      damage: this.damage,
      projectiles: this.projectiles,
      flightEffects: this.flightEffects,
    };
  }

  drainNotices(): string[] {
    if (this.pendingNotices.length === 0) return [];
    const said = this.pendingNotices;
    this.pendingNotices = [];
    return said;
  }

  setTarget(actorId: string | null) {
    if (actorId === this.targetId) return;
    this.targetId = actorId;
    this.send({ type: "target", actorId });
  }

  setAttackMode(enabled: boolean) {
    if (enabled === this.attacking) return;
    this.attacking = enabled;
    this.send({ type: "attackMode", enabled });
  }

  setPvp(enabled: boolean): boolean {
    if (!this.canSetPvp()) return false;
    this.send({ type: "pvp", enabled });
    return true;
  }

  private canSetPvp(): boolean {
    return !inCombat(this.statuses);
  }

  spells(): SpellButton[] {
    const context = this.castContext();
    return context ? castableSpells(context) : [];
  }

  cast(slot: CastSlot): boolean {
    const context = this.castContext();
    if (!context) return false;

    const verdict = castability(context, slot);
    if (!verdict.ok) {
      const notice = castRefusalNotice(verdict.reason);
      if (notice) this.pendingNotices.push(notice);
      return false;
    }

    this.send({ type: "cast", slot });
    return true;
  }

  cancelCast(): boolean {
    if (!this.castingsById.get(this.selfId)) return false;
    this.send({ type: "cancelCast" });
    return true;
  }

  private naturalSpells(tileId: string): readonly NaturalSpell[] {
    const def = this.tilesById[tileId];
    return (def ? resolveBattler(def)?.spells : null) ?? NO_SPELLS;
  }

  private castContext(): CastContext | null {
    const motion = this.motions.get(this.selfId);
    if (!motion) return null;
    const from = this.locate(this.selfId, motion);
    if (!from) return null;

    const targetMotion = this.targetId ? this.motions.get(this.targetId) : undefined;
    const to = this.targetId && targetMotion ? this.locate(this.targetId, targetMotion) : null;

    return {
      map: this.map,
      tilesById: this.tilesById,
      equipment: this.equipment,
      masteries: masteriesFromXp(this.masteryXp),
      caster: this.casterPoint(from, motion.walk?.to ?? null),
      casting: this.castingsById.get(this.selfId) ?? null,
      spells: this.naturalSpells(from.placed.tileId),
      spellCooldownsMs: this.spellCooldowns,
      target: to ? this.castPoint(to) : null,
      mayHarmTarget:
        to && this.targetId
          ? mayHarm(this.combatant(this.selfId, from), this.combatant(this.targetId, to))
          : true,
      incapacitated: this.incapacitated(),
    };
  }

  private casterPoint(from: ActorLocation, walkingTo: Coord | null): CasterPoint {
    const facing = actorDirection(from);
    const tileId = from.placed.tileId;
    if (!walkingTo) return { ...this.castPoint(from), facing, tileId };

    const { x, y, z } = walkingTo;
    const stack = getStack(this.map, x, y, z);
    return {
      x,
      y,
      z,
      stackIndex: stack.length,
      elevAbs: absoluteStandingElevation(z, stack, this.tilesById),
      facing,
      tileId,
    };
  }

  private combatant(id: string, loc: ActorLocation): Combatant {
    return combatantOf({
      id,
      tileId: loc.placed.tileId,
      pvp: this.pvpOn.has(id),
    });
  }

  private castPoint(loc: ActorLocation): CastPoint {
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      elevAbs: absoluteStandingElevation(loc.z, stack.slice(0, loc.stackIndex), this.tilesById),
    };
  }

  canInteract(ref: ObjectRef): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    return (
      canRewardFrom(this.map, this.tilesById, loc, ref, this.equipment, this.tags) ||
      this.canTeleport(loc, ref) ||
      canSwitchFrom(this.map, this.tilesById, loc, ref) ||
      canAddStatusFrom(this.map, this.tilesById, loc, ref) ||
      canRemoveStatusFrom(this.map, this.tilesById, loc, ref) ||
      canSetSpawnFrom(this.map, this.tilesById, loc, ref) ||
      canBeginExtract(this.map, this.tilesById, loc, this.equipment, ref, this.extracting) ||
      canEquipFrom(this.map, this.tilesById, loc, ref, this.equipment) ||
      canPickUpFrom(this.map, this.tilesById, loc, ref, this.equipment) ||
      canPushFrom(this.map, this.tilesById, loc, ref)
    );
  }

  private canTeleport(loc: ActorLocation, ref: ObjectRef): boolean {
    const travellerDef = this.tilesById[loc.placed.tileId];
    if (!travellerDef) return false;
    return canTeleportFrom(this.map, this.tilesById, loc, ref, travellerDef);
  }

  interact(ref: ObjectRef): boolean {
    if (!this.canInteract(ref)) return false;
    this.send({ type: "interact", ref });
    return true;
  }

  pickUp(ref: ObjectRef): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canPickUpFrom(this.map, this.tilesById, loc, ref, this.equipment)) {
      return false;
    }
    this.send({ type: "pickUp", ref });
    return true;
  }

  equip(ref: ObjectRef): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canEquipFrom(this.map, this.tilesById, loc, ref, this.equipment)) {
      return false;
    }
    this.send({ type: "equip", ref });
    return true;
  }

  consume(from: ConsumeSource): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;

    if (from.kind === "floor") {
      if (motion.walk || motion.fall || motion.slide) return false;
      if (this.pending.length > 0) return false;
      if (!canConsumeFrom(this.map, this.tilesById, loc, from.ref)) return false;
    } else {
      const instance = itemInSlot(this.map, this.tilesById, loc, this.equipment, from.slot);
      const def = instance && this.tilesById[instance.tileId];
      if (!def || !resolveConsumable(def)) return false;
    }

    this.send({ type: "consume", from });
    return true;
  }

  talk(action: TalkAction): boolean {
    if (action.kind !== "close" && this.incapacitated()) return false;
    if (action.kind === "open") {
      const motion = this.motions.get(this.selfId);
      const loc = motion && this.locate(this.selfId, motion);
      if (!loc) return false;
      if (!canTalkFrom(this.map, this.tilesById, loc, action.ref)) return false;
    } else if (!this.conversation) {
      return false;
    }
    this.send({ type: "talk", action });
    return true;
  }

  craft(ref: ObjectRef, recipe: number): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    if (motion.walk || motion.fall || motion.slide) return false;
    if (this.pending.length > 0) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    if (!canCraftFrom(this.map, this.tilesById, loc, this.equipment, ref, recipe)) {
      return false;
    }

    this.send({ type: "craft", ref, recipe });
    return true;
  }

  canMoveItem(from: SlotRef, to: SlotRef): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    const loc = motion && this.locate(this.selfId, motion);
    if (!loc) return false;
    return canMoveItem(this.map, this.tilesById, loc, this.equipment, from, to);
  }

  moveItem(from: SlotRef, to: SlotRef): boolean {
    if (!this.canMoveItem(from, to)) return false;
    this.send({ type: "moveItem", from, to });
    return true;
  }

  canDrop(from: SlotRef, to: Coord): boolean {
    if (this.incapacitated()) return false;
    const motion = this.motions.get(this.selfId);
    const loc = motion && this.locate(this.selfId, motion);
    if (!loc) return false;
    const instance = itemInSlot(this.map, this.tilesById, loc, this.equipment, from);
    const def = instance && this.tilesById[instance.tileId];
    if (!def) return false;
    return canDropAt(this.map, this.tilesById, loc, to, def);
  }

  drop(from: SlotRef, to: Coord): boolean {
    if (!this.canDrop(from, to)) return false;
    this.send({ type: "drop", from, to });
    return true;
  }

  setInput(input: GameInput) {
    if (this.dead) return;
    this.held = {
      directions: [...input.directions],
      faceOnly: input.faceOnly,
      preferDescend: input.preferDescend,
    };
    this.predictStep();
  }

  private send(message: ClientMessage) {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(payload: string) {
    if (this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(payload);
  }
}

const NO_CARRIED_LIGHTS: string[] = [];

const NO_TAGS: readonly string[] = [];

const NO_STATUSES: readonly StatusInstance[] = [];

const NO_SPELLS: readonly NaturalSpell[] = [];

const NO_OWNERS: readonly string[] = [];

function emptyMotion(): RemoteMotion {
  return { walk: null, fall: null, slide: null, strike: null, lastSeen: null };
}

function offscreenActor(id: string): ActorSnapshot {
  return {
    id,
    name: null,
    tileId: PLAYER_TILE_ID,
    x: 0,
    y: 0,
    z: 0,
    stackIndex: 0,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
    slideProgress: 0,
    strike: null,
    strikeProgress: 0,
    hp: null,
    maxHp: null,
    rating: null,
    statuses: NO_STATUSES,
    carriedLights: NO_CARRIED_LIGHTS,
    extracting: null,
    casting: null,
    pvp: false,
    hidden: false,
  };
}

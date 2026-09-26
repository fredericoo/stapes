import {
  MAX_HELD_TRANSITIONS,
  transitionOf,
  type HeldTransition,
  type TileTransitionNote,
  type TransitionSide,
} from "../lib/tileTransition";
import {
  absoluteStandingElevation,
  appendTile,
  chunkIndexOf,
  chunkKeyAt,
  chunkKeyFor,
  getStack,
  isPlayerBody,
  removeTileAt,
  replaceStack,
  tileIdsInChunk,
  walkableElevInStack,
} from "../lib/mapData";
import type { ExtractInteraction } from "../lib/interactions";
import {
  resolveAddStatus,
  resolveRemoveStatus,
  resolveExtract,
  resolveSetSpawn,
  resolveSwitch,
  resolveTeleport,
} from "../lib/interactions";
import {
  type ArcaneStoneItem,
  type CharmItem,
  type ConsumableItem,
  isItem,
  isRanged,
  NO_ELEMENTS,
  type StatusGrant,
  type StoneEffect,
  UNNAMED_SPELL,
  UNNAMED_WEAPON,
  type Reach,
  type WeaponStatus,
  resolveConsumable,
  resolveCharm,
} from "../lib/item";
import { appendItem, peelOne, pourInto, stackWithItem, stow } from "../lib/piles";
import type { ChunkCells, Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  isDirectional,
  levelKey,
  resolveActor,
} from "../lib/types";
import { canPlace, canReplaceStack, fitsAtElevation, tilesByIdFromList } from "../lib/validation";
import {
  actorDirection,
  adoptAuthoredPlayer,
  adoptBodyAt,
  DEFAULT_FACING,
  listResidentBodies,
  residentHome,
  residentOwnerId,
  actorStillAt,
  despawnActor,
  findActorAnywhere,
  listActorOwners,
  locateActor,
  removeAuthoredPlayer,
  spawnActor,
  spawnPoint,
  type ActorLocation,
} from "./actors";
import {
  canAddStatusFrom,
  canRemoveStatusFrom,
  canConsumeFrom,
  canEquipFrom,
  canSetSpawnFrom,
  canTalkFrom,
  dropDestinationAt,
  canPickUpFrom,
  pickUpDestination,
  canPushFrom,
  canRewardFrom,
  canSwitchFrom,
  canTeleportFrom,
  equipSlotFrom,
  interactiveDefAt,
  reachableAddStatusAt,
  reachableRemoveStatusAt,
  reachableRewardAt,
  reachableSetSpawnAt,
  reachableTeleportAt,
  rewardFits,
  teleportFits,
  pushDirectionFrom,
  pushTargetFrom,
  type DropDestination,
  type ObjectRef,
} from "./affordances";
import {
  castRefusalNotice,
  commandRefusalNotice,
  craftNotice,
  extractNotice,
  masteryNotice,
  otherMasteryNotice,
  healthNotice,
  noRoomToLeaveNotice,
  rewardNotice,
  spawnMarkNotice,
  spawnMarkUnchangedNotice,
  statusAcquiredNotice,
  otherStatusNotice,
  statusesClearedNotice,
  tileNotice,
  timeNotice,
} from "./notices";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import { leaveResidue } from "./residue";
import { type Blame, causeOfDeath, possessive } from "./blame";
import { conjuredName, sparesStander } from "./conjured";
import { type Combatant, mayHarm } from "./pvp";
import {
  GOTO_COMMAND,
  HEALTH_COMMAND,
  MOVE_COMMAND,
  MASTERY_COMMAND,
  parseCommand,
  resolveCell,
  STATUS_COMMAND,
  TILE_COMMAND,
  TIME_COMMAND,
  type Command,
  type CommandRefusal,
  type HealthCommand,
  type MasteryCommand,
  type StatusCommand,
  type TileCommand,
  type TimeCommand,
} from "./commands";
import { findEntryCell } from "./entry";
import {
  BRAIN_ATTENTION_FLOOR_CELLS,
  BRAIN_DOZE_BUDGET,
  BRAIN_ROUND_TICKS,
  BRAIN_TURNS_PER_TICK_MIN,
  BRAIN_TICK_MS,
  DAMAGE_NUMBER_LIFETIME_MS,
  FALL_MS_PER_HEIGHT,
  NOISE_LIFETIME_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  STRIKE_DURATION_MS,
  TICK_MS,
} from "./constants";
import {
  type BattlerDef,
  type NaturalSpell,
  DEFAULT_BATTLER,
  resolveBattler,
  type FightingStats,
  spellPower,
} from "../lib/battler";
import {
  experienceMultiplier,
  masteryMultiplier,
  hasExperience,
  levelForXp,
  MASTERIES,
  type Mastery,
  type Masteries,
  masteriesFromXp,
  type MasteryXp,
  rating,
  spellElements,
  xpForLevel,
  xpFromMasteries,
} from "../lib/mastery";
import { type Element, effectiveness, NEUTRAL } from "../lib/element";
import {
  ASSAILANT_GRACE_MS,
  type AttackOutcome,
  swingIntervalMs,
  swingWindupMs,
  WINDUP_LAPSE_MS,
  canReach,
  reachPointAt,
  damageAfterDefence,
  damageFraction,
  inflictedBy,
  cappedToHealth,
  rollAttack,
  strikeRecoveryMs,
  underPressure,
} from "./combat";
import type { Equipment, Hand } from "./equipment";
import {
  bodyElements,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  HANDS,
  fightsWithAHand,
  handToSwing,
  otherHand,
  spilled,
  stoneLocked,
  weaponInHand,
  weaponSwungBy,
} from "./equipment";
import {
  CAST_SQUARES,
  castability,
  castableSpells,
  castDurationMs,
  COOLDOWN_STEP_MS,
  type CastContext,
  type CasterPoint,
  type CastPoint,
  type CastProgress,
  type CastSlot,
  conjureLanding,
  coolingNotice,
  naturalSlot,
  needsTarget,
  spellIn,
  type SpellButton,
} from "./casting";
import { type Progress, windProgress } from "./progress";
import { type Attributes, attributesOf } from "./attributes";
import { equipmentForBody } from "./battlerKit";
import {
  attackerEarnings,
  casterEarnings,
  defenderEarnings,
  defensiveDecay,
  DEFENSIVE_RECOVERY_MS,
  practiceEarnings,
} from "./experience";
import { mintItemIds } from "./itemIds";
import { dodgeAway, outranksSwing, swingToward, type StrikeState } from "./strike";
import { planDistanceSq, type ReachPoint } from "./distance";
import {
  ageEffects,
  ageFlights,
  beginEffect,
  type FlightEffect,
  flightDurationMs,
  flightElevation,
  type FlightPoint,
  type ProjectileFlight,
} from "./projectile";
import { pushedColumn } from "./push";
import { isSpawnFilled, type RespawnOutcome, type SpawnPoint } from "./respawn";
import {
  applyItemMove,
  canMoveItem,
  capacityOf,
  clearSlot,
  isBodySlot,
  itemInSlot,
  peelSlot,
  stashInContainer,
  type ItemMoveResult,
  type SlotRef,
} from "./itemMoves";
import type { ItemInstance } from "../lib/itemInstance";
import { instanceFromPlacement, mintItemId, placementFromInstance } from "../lib/itemInstance";
import {
  cellForFeetAbs,
  cellHasLooseGravity,
  findLooseGravityCells,
  gravityPullOn,
  settleGravity,
} from "./gravity";
import {
  moveColumn,
  moveEntity,
  placeEntityOnSurface,
  removeEntity,
  setEntityDirection,
} from "./mapMutations";
import {
  canWalk,
  DIR_DELTA,
  groundWalkSpeedPercent,
  listStandingSurfaces,
  standingAbs,
  surfacesInClimbBand,
  wadesAt,
  walkDurationMsFor,
} from "./movement";
import { dropLanding, findPath, findRefuge, unsafeToStepOn, wadesIn } from "./pathfinding";
import { brainReach, resolveBrain } from "../lib/brain";
import { resolveDialog } from "../lib/dialog";
import {
  acceptTrade,
  cancelTrade,
  chooseOption,
  openConversation,
  type Conversation,
  type DialogEffectDef,
  type PartnerView,
  type TalkAction,
} from "./dialogRuntime";
import { planTrade } from "./trade";
import { bodyNameFor } from "./displayName";
import {
  initialMemory,
  stepBrain,
  type BrainMemory,
  type FoundThing,
  type SightLevels,
  type StandOff,
  type Sound,
  type Utterance,
  type WalkGoal,
  type WalkOrderState,
} from "./brainRuntime";
import type { ConsumeSource } from "./itemUse";
import { canCraftFrom, craftableRecipe, runCraft } from "./craft";
import type { Extraction, ExtractionProgress } from "./extract";
import {
  canBeginExtract,
  clearExtractReservations,
  extractKey,
  placementAfterPull,
  reachableExtractAt,
  rollExtract,
  stowExtracted,
  withReservation,
  withoutReservations,
} from "./extract";
import { hasLineOfSight } from "./sight";
import { Rng } from "./rng";
import { chooseStep, type StepRequest } from "./stepping";
import { cellHasPlate, cellKey, findPlateCells, settlePlates } from "./pressurePlates";
import { cellIsWired, findWiredCells, settleSignals, type ExtraEmitter } from "./signals";
import type { ItemDecay, PlacementDecay } from "./decay";
import { DecayIndex, applyDecay, applyItemDecay, findDecayCells } from "./decay";
import {
  EndureIndex,
  type AfflictedPlacement,
  afflictionsFrom,
  applyConsumed,
  cellAfflicts,
  findAfflictCells,
  spreadShares,
  sufferersIn,
  type Consumed,
} from "./endure";
import { COMBAT_STATUS, COMBAT_STATUS_ID, type StatusDef } from "../lib/status";
import { projectileEffect, resolveProjectile } from "../lib/projectile";
import {
  advanceStatuses,
  applyStatus,
  endOnDamage,
  enterCombat,
  incapacitated,
  inCombat,
  NO_STATUSES,
  type StatusInstance,
  statusReading,
  walkSpeedPercentFrom,
  withStatusModifiers,
} from "./statuses";
import { sanitizeChatText } from "../net/chat";

export type { ObjectRef } from "./affordances";

export type WalkState = {
  from: Coord;
  to: Coord;
  direction: Direction;
  elapsedMs: number;
  durationMs: number;
};

export type FallState = {
  feetAbs: number;
  landingAbs: number;
  elapsedMs: number;
};

export type GameInput = {
  directions: Direction[];
  faceOnly?: boolean;
  preferDescend?: boolean;
};

export type SlideSnapshot = {
  object: ObjectRef;
  from: Coord;
  count: number;
};

export type ActorPosition = Coord & { direction: Direction };

export type ActorSnapshot = {
  id: string;
  name: string | null;
  tileId: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
  direction: Direction;
  walk: WalkState | null;
  fall: FallState | null;
  walkProgress: number;
  fallProgress: number;
  slide: SlideSnapshot | null;
  slideProgress: number;
  strike: StrikeState | null;
  strikeProgress: number;
  hp: number | null;
  statuses: readonly StatusInstance[];
  maxHp: number | null;
  rating: number | null;
  carriedLights: string[];
  extracting: ExtractionProgress | null;
  casting: CastProgress | null;
  pvp: boolean;
  hidden: boolean;
};

export type NoiseEmission = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
  elapsedMs: number;
};

export type SwingOutcome = "hit" | "miss" | "heal";

export const SWING_OUTCOMES: SwingOutcome[] = ["hit", "miss", "heal"];

export type DamageNumber = {
  id: string;
  targetId: string;
  outcome: SwingOutcome;
  amount: number;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
  elapsedMs: number;
};

export type ChatBubble = {
  id: string;
  actorId: string;
  tileId: string;
  name: string | null;
  text: string;
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

export type GameSnapshot = {
  map: MapFile;
  self: ActorSnapshot;
  actors: ActorSnapshot[];
  targetId: string | null;
  attacking: boolean;
  damage: DamageNumber[];
  projectiles: ProjectileFlight[];
  flightEffects: FlightEffect[];
  equipment: Equipment;
  tags: readonly string[];
  spawnAt: Coord | null;
  conversation: Conversation | null;
  extracting: Extraction | null;
  nextBlow: Progress | null;
  masteryXp: MasteryXp;
  attributes: Attributes | null;
  pvp: { on: boolean; changeable: boolean };
  chats: ChatBubble[];
  noises: NoiseEmission[];
  afflicted: readonly AfflictedPlacement[];
};

export type Vitals = {
  hp: number | null;
  maxHp: number | null;
  rating: number | null;
  statuses: readonly StatusInstance[];
  attributes: Attributes | null;
  pvp: { on: boolean; changeable: boolean };
};

export const NO_VITALS: Vitals = {
  hp: null,
  maxHp: null,
  rating: null,
  statuses: [],
  attributes: null,
  pvp: { on: false, changeable: false },
};

export const LOCAL_ACTOR_ID = "local";

const NO_SPELLS: readonly NaturalSpell[] = [];

const EMPTY_ATTACKERS: readonly string[] = [];

const EMPTY_SOUNDS: readonly Sound[] = [];

const NO_TAGS: readonly string[] = [];

const NO_ACTORS: readonly string[] = [];

function soundsHeardBy(sounds: readonly Sound[], actorId: string): readonly Sound[] {
  if (sounds.length === 0) return EMPTY_SOUNDS;
  return sounds.filter((sound) => sound.sourceId !== actorId);
}

function facingToward(from: Coord, to: Coord): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

function walkKey(cell: Coord): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

export interface PlaySession {
  update(dtMs: number): void;
  getSnapshot(): GameSnapshot;
  takeTransitions(): HeldTransition[];
  getMap(): MapFile;
  setTarget(actorId: string | null): void;
  setAttackMode(enabled: boolean): void;
  setPvp(enabled: boolean): boolean;
  spells(): SpellButton[];
  cast(slot: CastSlot): boolean;
  cancelCast(): boolean;
  canInteract(ref: ObjectRef): boolean;
  interact(ref: ObjectRef): boolean;
  pickUp(ref: ObjectRef): boolean;
  equip(ref: ObjectRef): boolean;
  consume(from: ConsumeSource): boolean;
  craft(ref: ObjectRef, recipe: number): boolean;
  talk(action: TalkAction): boolean;
  canMoveItem(from: SlotRef, to: SlotRef): boolean;
  moveItem(from: SlotRef, to: SlotRef): boolean;
  canDrop(from: SlotRef, to: Coord): boolean;
  drop(from: SlotRef, to: Coord): boolean;
  drainNotices(): string[];
}

type SlideState = {
  object: ObjectRef;
  from: Coord;
  count: number;
  elapsedMs: number;
};

type PlanCoord = { x: number; y: number };

type Eaten = { consumable: ConsumableItem; name: string };

type ExtractionRun = {
  progress: Extraction;
  ref: ObjectRef;
  tileId: string;
  from: Coord;
};

type CastingRun = {
  progress: CastProgress;
  itemId: string | null;
  uninterruptible: boolean;
  aimed: boolean;
};

function castTargetOf(actor: { targetId: string | null }, aimed: boolean): string | undefined {
  return aimed ? (actor.targetId ?? undefined) : undefined;
}

const CAST_INTERRUPTED_NOTICE = "Your cast is broken";

const EXTRACT_INTERRUPTED_NOTICE = "You are interrupted";

type StatusGrantOutcome = "acquired" | "refreshed" | "refused";

type HealthMove = { kind: "harm" | "mend"; amount: number };

type BrainRound = {
  turns: { actor: ActorRuntime; tickMs: number }[];
  next: number;
  perTick: number;
  sounds: readonly Sound[];
  heard: readonly Utterance[];
  hurt: ReadonlyMap<string, string[]>;
  minutesOfDay: MinutesOfDay;
};
type BlowInFlight = {
  remainingMs: number;
  land: () => void;
};

type ActorRuntime = {
  readonly id: string;
  readonly name: string | null;
  readonly resident: boolean;
  equipment: Equipment;
  carriedLights: string[];
  tags: readonly string[];
  masteryXp: MasteryXp | null;
  extraction: ExtractionRun | null;
  casting: CastingRun | null;
  earnedBody: { authored: BattlerDef; body: BattlerDef } | null;
  nextHand: Hand;
  defensiveDecay: Map<string, { payouts: number; idleMs: number }> | null;
  assailants: Map<string, number> | null;
  brain: BrainMemory | null;
  charmClock: { itemId: string; elapsedMs: number } | null;
  brainDeferredMs: number;
  walkOrder: {
    goal: WalkGoal;
    allowDrops: boolean | undefined;
    arrive: "beside" | "on";
  } | null;
  refuge: Coord | null;
  brainAttentive: boolean;
  conversation: Conversation | null;
  home: Coord | null;
  spawnMark: Coord | null;
  hp: number | null;
  statuses: readonly StatusInstance[];
  standingStatusMs: number;
  attackCooldownMs: number;
  windup: {
    targetId: string;
    msLeft: number;
    sinceSeenMs: number;
    inReach: boolean;
  } | null;
  nextBlow: Progress | null;
  attackRecoveryMs: number;
  spellCooldownMs: Record<string, number>;
  targetId: string | null;
  attacking: boolean;
  pvp: boolean;
  hidden: boolean;
  input: GameInput;
  walk: WalkState | null;
  fall: FallState | null;
  slide: SlideState | null;
  strike: StrikeState | null;
  memo: {
    map: MapFile;
    loc: ActorLocation;
    levelKey: string;
    chunkKey: string;
    chunk: ChunkCells | undefined;
  } | null;
};

/**
 * Slack for comparing accumulated ticks against a step size. `TICK_MS` is
 * 1000/30, which is not exactly representable, so thirty ticks of it sum to
 * 1000.0000000000005, and a plain comparison against the round number would
 * read a step late about half the time.
 */
const COOLDOWN_EPSILON_MS = 1e-6;

const STANDING_STATUS_EVERY_MS = 1000;

const SELF_SPELL_MULTIPLIER = 1;

const ARCANE_BLOW: Pick<FightingStats, "mastery"> = { mastery: "arcane" };

const NOTHING_INFLICTED: readonly WeaponStatus[] = [];

function cooledEquipment(equipment: Equipment, spentMs: number): Equipment {
  let next: Equipment | null = null;
  for (const square of CAST_SQUARES) {
    const held = equipment[square];
    if (!held?.cooldownMs) continue;
    const remaining = held.cooldownMs - spentMs;
    next ??= { ...equipment };
    if (remaining > 0) {
      next[square] = { ...held, cooldownMs: remaining };
    } else {
      const { cooldownMs: _spent, ...ready } = held;
      next[square] = ready;
    }
  }
  return next ?? equipment;
}

export type Death = {
  id: string;
  equipment: Equipment;
  masteryXp: MasteryXp | null;
  tags: readonly string[];
};

export class GameSession implements PlaySession {
  private map: MapFile;
  private readonly tilesById: Record<string, TileDef>;
  private readonly actors = new Map<string, ActorRuntime>();
  private readonly walkingInto = new Map<string, ActorRuntime[]>();
  private tileIndex: Map<string, string[]> | null = null;
  private readonly spawnAt: Coord & { stackIndex: number };
  private readonly equipmentChanged = new Set<string>();
  private readonly conversationChanged = new Set<string>();
  private readonly tagsChanged = new Set<string>();
  private readonly extractionChanged = new Set<string>();
  private readonly masteriesChanged = new Set<string>();
  private pendingClockSet: MinutesOfDay | null = null;
  private readonly clock: () => MinutesOfDay;
  private readonly plateCells = new Map<string, Coord>();
  private readonly wiredCells = new Map<string, Coord>();
  private readonly looseGravityCells = new Map<string, Coord>();
  private readonly decay: DecayIndex;
  private readonly afflictCells = new Map<string, Coord>();
  private readonly endure: EndureIndex;
  private readonly statusDefs: Record<string, StatusDef>;
  private readonly statusesChanged = new Set<string>();
  private readonly statusReadings = new Map<string, string>();
  private settledMap: MapFile | null = null;
  private accumulatorMs = 0;
  private stoneClockMs = 0;
  private readonly rng: Rng;
  private brainAccumulatorMs = 0;
  private dozeCursor = 0;
  private pendingSpeech: ChatBubble[] = [];
  private nextSpeechId = 0;
  private pendingHeard: Utterance[] = [];
  private pendingHurt = new Map<string, string[]>();
  private pendingSound: Sound[] = [];
  private brainRound: BrainRound | null = null;
  private pendingDamage: DamageNumber[] = [];
  private liveDamage: DamageNumber[] = [];
  private pendingProjectiles: ProjectileFlight[] = [];
  private pendingTransitions: TileTransitionNote[] = [];
  private nextTransitionId = 0;
  private heldForViewer: TileTransitionNote[] = [];
  private liveProjectiles: ProjectileFlight[] = [];
  private liveFlightEffects: FlightEffect[] = [];
  private nextProjectileId = 0;
  private blowsInFlight: BlowInFlight[] = [];
  private readonly pendingNotices: { actorId: string; text: string }[] = [];
  private nextDamageId = 0;
  private pendingNoise: NoiseEmission[] = [];
  private pendingTeleports: string[] = [];
  private pendingSwings: string[] = [];
  private liveNoise: NoiseEmission[] = [];
  private nextNoiseId = 0;
  private pendingDeaths: Death[] = [];
  private pendingSpawnMarks: { actorId: string; at: Coord }[] = [];
  private settledEmitters = "";

  constructor(
    map: MapFile,
    tiles: TileDef[],
    {
      actorIds = [LOCAL_ACTOR_ID],
      names = {},
      spawnAt,
      seed,
      statuses: statusDefs = {},
      clock = () => DEFAULT_PLAY_MINUTES,
    }: {
      actorIds?: readonly string[];
      names?: Readonly<Record<string, string>>;
      spawnAt?: Coord & { stackIndex: number };
      seed?: number;
      statuses?: Record<string, StatusDef>;
      clock?: () => MinutesOfDay;
    } = {},
  ) {
    this.clock = clock;
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    this.statusDefs = { ...statusDefs, [COMBAT_STATUS_ID]: COMBAT_STATUS };
    this.rng = new Rng(seed);
    this.decay = new DecayIndex(this.rng);
    this.endure = new EndureIndex(this.rng);

    if (spawnAt) {
      this.spawnAt = spawnAt;
      for (const id of actorIds) this.spawn(id, { name: names[id] ?? null });
    } else {
      this.spawnAt = spawnPoint(this.map);
      const [first, ...rest] = actorIds;
      if (first === undefined) {
        this.map = removeAuthoredPlayer(this.map);
      } else {
        this.map = adoptAuthoredPlayer(this.map, first);
        this.addActor(first, {
          bodyTileId: PLAYER_TILE_ID,
          name: names[first] ?? null,
        });
      }
      for (const id of rest) this.spawn(id, { name: names[id] ?? null });
    }

    this.adoptResidents();

    this.map = mintItemIds(this.map, this.tilesById);

    this.map = clearExtractReservations(this.map);

    for (const cell of findPlateCells(this.map, this.tilesById)) {
      this.plateCells.set(cellKey(cell), cell);
    }
    for (const cell of findWiredCells(this.map)) {
      this.wiredCells.set(cellKey(cell), cell);
    }
    for (const cell of findLooseGravityCells(this.map, this.tilesById)) {
      this.looseGravityCells.set(cellKey(cell), cell);
    }
    for (const cell of findAfflictCells(this.map, this.tilesById)) {
      this.afflictCells.set(cellKey(cell), cell);
    }
    for (const cell of findDecayCells(this.map, this.tilesById)) {
      this.decay.armCell(this.map, cell, this.tilesById);
    }
    this.settleBoardNow();
  }

  private adoptResidents() {
    for (const body of listResidentBodies(this.map, this.tilesById)) {
      const owner = body.placed.owner ?? residentOwnerId(body);
      if (!body.placed.owner) {
        this.map = adoptBodyAt(this.map, body, owner);
      }
      if (!this.actors.has(owner)) {
        this.addResident(owner, body.placed.tileId, body);
      }
    }
  }

  /**
   * An actor with no remembered cell is found by sweeping the whole board, so
   * a world that adopts thousands of creatures would sweep it once for each.
   */
  private addResident(id: string, bodyTileId: string, body: Coord & { stackIndex: number }) {
    const actor = this.addActor(id, { resident: true, bodyTileId });
    const at = actorStillAt(this.map, id, body);
    if (at) this.remember(actor, at);
  }

  private addActor(
    id: string,
    opts: {
      resident?: boolean;
      name?: string | null;
      bodyTileId?: string;
      carrying?: Equipment;
      tagged?: readonly string[];
      earned?: MasteryXp;
      statuses?: readonly StatusInstance[];
      hp?: number;
      spawnAt?: Coord;
      pvp?: boolean;
      hidden?: boolean;
    } = {},
  ): ActorRuntime {
    const resident = opts.resident === true;
    const equipment =
      opts.carrying ?? (opts.bodyTileId ? this.rollKit(opts.bodyTileId) : emptyEquipment());
    this.decay.armEquipment(equipment, this.tilesById);
    const actor: ActorRuntime = {
      id,
      name: opts.name ?? null,
      resident,
      equipment,
      charmClock: null,
      carriedLights: carriedLightTileIds(equipment, this.tilesById),
      tags: opts.tagged ?? NO_TAGS,
      masteryXp: resident || !hasExperience(opts.earned) ? null : opts.earned,
      earnedBody: null,
      defensiveDecay: null,
      assailants: null,
      brain: null,
      brainDeferredMs: 0,
      walkOrder: null,
      refuge: null,
      brainAttentive: false,
      conversation: null,
      home: residentHome(id),
      spawnMark: opts.spawnAt ?? null,
      hp: opts.hp === undefined ? null : Math.max(1, opts.hp),
      statuses: resident ? NO_STATUSES : (opts.statuses ?? NO_STATUSES),
      standingStatusMs: 0,
      attackCooldownMs: 0,
      attackRecoveryMs: 0,
      windup: null,
      nextBlow: null,
      spellCooldownMs: {},
      extraction: null,
      casting: null,
      targetId: null,
      attacking: false,
      pvp: opts.pvp ?? false,
      hidden: !resident && opts.hidden === true,
      input: { directions: [] },
      walk: null,
      fall: null,
      slide: null,
      strike: null,
      memo: null,
      nextHand: HANDS[0],
    };
    this.actors.set(id, actor);
    this.forgetTileIndex();
    return actor;
  }

  private rollKit(bodyTileId: string): Equipment {
    return equipmentForBody(bodyTileId, this.tilesById, () => this.rng.next());
  }

  startingKit(): Equipment {
    return this.rollKit(PLAYER_TILE_ID);
  }

  private forgetTileIndex() {
    this.tileIndex = null;
  }

  spawn(
    id: string,
    restored: {
      name?: string | null;
      at?: Coord & { direction?: Direction };
      carrying?: Equipment;
      tagged?: readonly string[];
      earned?: MasteryXp;
      statuses?: readonly StatusInstance[];
      hp?: number;
      spawnAt?: Coord;
      pvp?: boolean;
      hidden?: boolean;
    } = {},
    { announce = true }: { announce?: boolean } = {},
  ) {
    if (this.actors.has(id)) return;
    const { at } = restored;
    let where: (Coord & { stackIndex: number }) | null = findActorAnywhere(this.map, id);
    if (!where) {
      const cell = at ? findEntryCell(this.map, this.tilesById, at, this.spawnAt) : this.spawnAt;
      const stackIndex = getStack(this.map, cell.x, cell.y, cell.z).length;
      this.map = spawnActor(this.map, id, cell, at?.direction);
      if (announce && !restored.hidden) {
        this.noteTransition("appear", PLAYER_TILE_ID, cell, stackIndex);
      }
      where = { x: cell.x, y: cell.y, z: cell.z, stackIndex };
    }
    this.addActor(id, { ...restored, bodyTileId: PLAYER_TILE_ID });
    const actor = this.actors.get(id)!;
    const placed = actorStillAt(this.map, id, where);
    if (placed) this.remember(actor, placed);
  }

  actorPosition(id: string): ActorPosition | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      direction: actorDirection(loc),
    };
  }

  reapAbsentActors(present: Iterable<string>) {
    const live = new Set(present);
    const residents = new Set(
      listResidentBodies(this.map, this.tilesById)
        .map((body) => body.placed.owner)
        .filter((owner): owner is string => owner != null),
    );
    for (const owner of listActorOwners(this.map)) {
      if (live.has(owner) || residents.has(owner)) continue;
      this.map = despawnActor(this.map, owner);
    }
  }

  despawn(id: string) {
    this.statusReadings.delete(id);
    this.statusesChanged.delete(id);
    const leaving = this.actors.get(id);
    if (!leaving) return;
    this.cancelExtraction(leaving);
    this.cancelCasting(leaving);
    this.forgetWalk(leaving);
    this.actors.delete(id);
    const loc = this.tryLocate(leaving);
    this.forgetTileIndex();
    if (loc && !leaving.hidden) {
      this.noteTransition("disappear", loc.placed.tileId, loc, loc.stackIndex);
    }
    this.map = loc
      ? removeTileAt(this.map, loc.x, loc.y, loc.z, loc.stackIndex)
      : despawnActor(this.map, id);
  }

  respawnAt(point: SpawnPoint): RespawnOutcome {
    if (isSpawnFilled(this.map, point)) return { kind: "done" };
    const def = this.tilesById[point.placed.tileId];
    if (!def) return { kind: "done" };
    const { x, y, z } = point.cell;
    if (!canPlace(this.map, x, y, z, def, this.tilesById).ok) {
      return { kind: "blocked" };
    }

    const itemId = isItem(def) ? mintItemId() : undefined;
    const stackIndex = getStack(this.map, x, y, z).length;
    this.map = appendTile(this.map, x, y, z, {
      ...point.placed,
      ...(itemId ? { itemId } : {}),
      ...(point.ownerId ? { owner: point.ownerId } : {}),
    });
    this.map = mintItemIds(this.map, this.tilesById);
    this.noteTransition("appear", def.id, point.cell, stackIndex);
    if (point.ownerId && !this.actors.has(point.ownerId)) {
      this.addResident(point.ownerId, point.placed.tileId, { x, y, z, stackIndex });
    }
    this.reindexCells([point.cell]);
    return { kind: "done", ...(itemId ? { itemId } : {}) };
  }

  actorIds(): string[] {
    return [...this.actors.keys()];
  }

  hasActor(id: string): boolean {
    return this.actors.has(id);
  }

  isResident(id: string): boolean {
    return this.actors.get(id)?.resident === true;
  }

  equipmentOf(id: string): Equipment | null {
    return this.actors.get(id)?.equipment ?? null;
  }

  spellCooldownsOf(id: string): Readonly<Record<string, number>> | null {
    return this.actors.get(id)?.spellCooldownMs ?? null;
  }

  tagsOf(id: string): readonly string[] | null {
    return this.actors.get(id)?.tags ?? null;
  }

  extractionOf(id: string): Extraction | null {
    return this.actors.get(id)?.extraction?.progress ?? null;
  }

  nextBlowOf(id: string): Progress | null {
    return this.actors.get(id)?.nextBlow ?? null;
  }

  masteryXpOf(id: string): MasteryXp | null {
    return this.actors.get(id)?.masteryXp ?? null;
  }

  getSpawnPoint(): Coord & { stackIndex: number } {
    return this.spawnAt;
  }

  getSeed(): number {
    return this.rng.save();
  }

  private actor(id: string): ActorRuntime {
    const actor = this.actors.get(id);
    if (!actor) throw new Error(`No actor "${id}" in this session`);
    return actor;
  }

  private reindexCells(cells: Iterable<Coord>) {
    for (const cell of cells) {
      const key = cellKey(cell);
      this.decay.armCell(this.map, cell, this.tilesById);
      if (cellHasPlate(this.map, cell, this.tilesById)) {
        this.plateCells.set(key, cell);
      } else {
        this.plateCells.delete(key);
      }
      if (cellIsWired(this.map, cell)) {
        this.wiredCells.set(key, cell);
      } else {
        this.wiredCells.delete(key);
      }
      if (cellHasLooseGravity(this.map, cell, this.tilesById)) {
        this.looseGravityCells.set(key, cell);
      } else {
        this.looseGravityCells.delete(key);
      }
      if (cellAfflicts(this.map, cell, this.tilesById)) {
        this.afflictCells.set(key, cell);
      } else {
        this.afflictCells.delete(key);
      }
    }
  }

  private settleBoardNow() {
    const before = this.map;
    const emitters = this.actorEmitters();
    const emitterSig = this.emitterSignature(emitters);
    if (before === this.settledMap && emitterSig === this.settledEmitters) return;
    this.settledMap = before;
    this.settledEmitters = emitterSig;

    if (this.looseGravityCells.size > 0) {
      const { map, changed } = settleGravity(
        this.map,
        this.looseGravityCells.values(),
        this.tilesById,
      );
      this.map = map;
      this.reindexCells(changed);
    }

    if (this.plateCells.size > 0) {
      const { map, changed } = settlePlates(this.map, this.plateCells.values(), this.tilesById);
      this.map = map;
      this.reindexCells(changed);
    }

    if (this.wiredCells.size > 0) {
      const { map, changed } = settleSignals(
        this.map,
        this.wiredCells.values(),
        this.tilesById,
        emitters,
      );
      this.map = map;
      this.reindexCells(changed);
    }
  }

  private tryLocate(actor: ActorRuntime): ActorLocation | null {
    const memo = actor.memo;
    if (memo?.map === this.map) return memo.loc;
    if (memo?.chunk && this.map.levels[memo.levelKey]?.[memo.chunkKey] === memo.chunk) {
      memo.map = this.map;
      return memo.loc;
    }

    const loc = locateActor(this.map, actor.id, memo?.loc);
    if (loc) this.remember(actor, loc);
    return loc;
  }

  private remember(actor: ActorRuntime, loc: ActorLocation) {
    const zk = levelKey(loc.z);
    const ck = chunkKeyFor(loc.x, loc.y);
    actor.memo = {
      map: this.map,
      loc,
      levelKey: zk,
      chunkKey: ck,
      chunk: this.map.levels[zk]?.[ck],
    };
  }

  private locate(actor: ActorRuntime): ActorLocation {
    const loc = this.tryLocate(actor);
    if (!loc) throw new Error(`Actor "${actor.id}" is not on the map`);
    return loc;
  }

  private reachPointOf(loc: ActorLocation) {
    return reachPointAt(this.map, this.tilesById, loc);
  }

  private flightPointOf(loc: ActorLocation): FlightPoint {
    const point = this.reachPointOf(loc);
    const body = this.tilesById[loc.placed.tileId];
    return {
      x: point.x,
      y: point.y,
      elevAbs: flightElevation(point.elevAbs, body?.height ?? HEIGHT_PER_LEVEL),
    };
  }

  setInput(input: GameInput, id: string = LOCAL_ACTOR_ID) {
    this.actor(id).input = input;
  }

  update(dtMs: number) {
    this.accumulatorMs += dtMs;
    const maxCatchUp = TICK_MS * 10;
    if (this.accumulatorMs > maxCatchUp) this.accumulatorMs = maxCatchUp;

    while (this.accumulatorMs >= TICK_MS) {
      this.accumulatorMs -= TICK_MS;
      this.tick(TICK_MS);
    }
  }

  /**
   * Actors move in insertion order, and that order is load-bearing: two
   * actors stepping into the same cell on the same tick resolve by it, so a
   * stable order is what makes a tick reproducible rather than dependent on
   * which message happened to arrive first.
   */
  tick(tickMs: number = TICK_MS) {
    this.pendingSpeech = [];
    this.pendingDamage = [];
    this.pendingNoise = [];
    this.pendingProjectiles = [];
    this.pendingTransitions = [];
    this.pendingTeleports = [];
    this.pendingSwings = [];
    this.ageDamageNumbers(tickMs);
    this.ageNoises(tickMs);
    this.ageProjectiles(tickMs);

    this.tickStatuses(tickMs);

    this.advanceCooldowns(tickMs);
    this.tickStrikes(tickMs);
    this.landArrivedBlows(tickMs);
    this.recoverDefensiveDecay(tickMs);
    this.forgetSpentAssailants(tickMs);
    this.advanceStoneCooldowns(tickMs);
    this.tickCharms(tickMs);

    this.tickConversations();
    this.tickBrains(tickMs);

    this.runAutoAttacks();

    for (const actor of this.actors.values()) {
      this.tickSlide(actor, tickMs);
      this.tickMotion(actor, tickMs);
    }
    this.tickStandingStatuses(tickMs);
    this.decay.advance(tickMs);
    this.applyDueDecay();
    this.tickAfflictions(tickMs);
    this.applyWornThrough(tickMs);

    this.advanceExtractions(tickMs);
    this.advanceCastings(tickMs);

    this.settleBoardNow();
  }

  private applyDueDecay() {
    const due = this.decay.takeDue();
    if (due.length === 0) return;

    const placements = due.filter((entry): entry is PlacementDecay => entry.kind === "placement");
    const items = due.filter((entry): entry is ItemDecay => entry.kind === "item");

    const turned = applyDecay(this.map, placements, this.tilesById);
    this.map = turned.map;
    const changed = turned.changed;
    for (const swap of turned.turned) {
      this.noteTransition("disappear", swap.tileId, swap.cell, swap.fromIndex);
      if (swap.into) {
        this.noteTransition("appear", swap.into.tileId, swap.cell, swap.into.stackIndex);
      }
    }

    if (items.length > 0) {
      const rotted = applyItemDecay(
        this.map,
        this.actors.values(),
        items,
        this.tilesById,
        mintItemId,
      );
      this.map = rotted.map;
      changed.push(...rotted.changed);
      for (const [actorId, equipment] of rotted.equipment) {
        this.setEquipment(this.actor(actorId), equipment);
      }
    }

    this.reindexCells(changed);
  }

  private tickAfflictions(tickMs: number) {
    if (this.afflictCells.size === 0) return;
    for (const cell of this.afflictCells.values()) {
      const held = new Set<string>();
      for (const source of afflictionsFrom(this.map, cell, this.tilesById)) {
        if (held.has(source.statusId)) continue;
        held.add(source.statusId);
        const def = this.statusDefs[source.statusId];
        if (!def) continue;
        for (const sufferer of sufferersIn(this.map, cell, source.statusId, this.tilesById)) {
          this.endure.hold(
            cell,
            sufferer.tileId,
            sufferer.endure,
            def,
            tickMs,
            STANDING_STATUS_EVERY_MS,
            source.causedBy,
            source.elements,
          );
        }
      }
    }
  }

  /**
   * The order is load-bearing in one place: the shares a finished status
   * passes on are worked out against the map as it was before the swap. A
   * stack of two burning things needs the first one still counted when the
   * second one's share is divided, or turning one first changes what the
   * other divides by.
   */
  private applyWornThrough(tickMs: number) {
    const consumed = this.endure.advance(tickMs, this.statusDefs);
    if (consumed.length === 0) return;

    for (const one of consumed) this.spreadFrom(one);

    const turned = applyConsumed(this.map, consumed, this.tilesById);
    this.map = turned.map;
    this.reindexCells(turned.changed);
  }

  private spreadFrom(consumed: Consumed) {
    const def = this.statusDefs[consumed.statusId];
    if (!def) return;
    for (const { cell, shareMs } of spreadShares(this.map, consumed, this.tilesById)) {
      for (const sufferer of sufferersIn(this.map, cell, consumed.statusId, this.tilesById)) {
        this.endure.afflict(
          cell,
          sufferer.tileId,
          sufferer.endure,
          def,
          { fromMs: shareMs, toMs: shareMs },
          consumed.causedBy,
          consumed.elements,
        );
      }
    }
  }

  private observed(): boolean {
    for (const actor of this.actors.values()) {
      if (!actor.resident) return true;
    }
    return false;
  }

  private tickBrains(tickMs: number) {
    if (!this.observed()) {
      this.pendingHeard = [];
      this.pendingHurt.clear();
      this.pendingSound = [];
      this.brainRound = null;
      return;
    }

    this.brainAccumulatorMs += tickMs;
    if (this.brainAccumulatorMs >= BRAIN_TICK_MS) {
      this.brainAccumulatorMs -= BRAIN_TICK_MS;
      if (this.brainRound) this.takeBrainTurns(this.brainRound, Infinity);
      this.brainRound = this.planBrainRound();
    }
    if (this.brainRound) this.takeBrainTurns(this.brainRound, this.brainRound.perTick);
  }

  private planBrainRound(): BrainRound {
    const round: BrainRound = {
      turns: [],
      next: 0,
      perTick: 0,
      sounds: this.pendingSound,
      heard: this.pendingHeard,
      hurt: this.pendingHurt,
      minutesOfDay: this.clock(),
    };
    this.pendingSound = [];
    this.pendingHeard = [];
    this.pendingHurt = new Map();

    const players = this.playerPlans();
    const dozing: ActorRuntime[] = [];
    for (const actor of this.actors.values()) {
      if (!actor.resident) continue;
      actor.brainAttentive = this.attentive(actor, players, round.hurt);
      if (actor.brainAttentive) {
        round.turns.push({ actor, tickMs: BRAIN_TICK_MS + actor.brainDeferredMs });
        actor.brainDeferredMs = 0;
      } else {
        dozing.push(actor);
      }
    }
    this.planDozing(dozing, round);

    round.perTick = Math.max(
      BRAIN_TURNS_PER_TICK_MIN,
      Math.ceil(round.turns.length / BRAIN_ROUND_TICKS),
    );
    return round;
  }

  private takeBrainTurns(round: BrainRound, count: number) {
    const stop = Math.min(round.turns.length, round.next + count);
    for (; round.next < stop; round.next++) {
      const { actor, tickMs } = round.turns[round.next]!;
      if (this.actors.get(actor.id) !== actor) continue;
      this.tickOneBrain(actor, round, tickMs);
    }
    if (round.next >= round.turns.length && this.brainRound === round) this.brainRound = null;
  }

  hear(speakerId: string, text: string) {
    if (this.isConcealed(speakerId)) return;
    this.pendingHeard.push({ speakerId, text });
  }

  talk(action: TalkAction, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    if (action.kind !== "close" && this.incapacitated(actor)) return false;
    if (action.kind === "open") return this.openTalk(actor, action.ref);
    if (action.kind === "close") return this.setConversation(actor, null);

    const current = actor.conversation;
    if (!current) return false;
    const dialog = this.dialogOf(current.npcId);
    if (!dialog) return this.setConversation(actor, null);

    const view = this.partnerViewFor(actor);
    const next =
      action.kind === "cancel"
        ? cancelTrade(dialog, current, view)
        : action.kind === "trade"
          ? acceptTrade(dialog, current, action.amount, view)
          : chooseOption(dialog, current, action.index, view);
    if (!next) return false;
    return this.setConversation(actor, next);
  }

  private openTalk(actor: ActorRuntime, ref: ObjectRef): boolean {
    const loc = this.tryLocate(actor);
    if (!loc || !canTalkFrom(this.map, this.tilesById, loc, ref)) return false;
    const npc = this.npcAt(ref);
    const dialog = npc && resolveDialog(this.defFor(npc));
    if (!npc || !dialog || this.incapacitated(npc)) return false;
    const view = this.partnerViewFor(actor);
    const body = { id: npc.id, tileId: this.defFor(npc).id };
    return this.setConversation(actor, openConversation(dialog, body, view));
  }

  private npcAt(ref: ObjectRef): ActorRuntime | null {
    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    if (!placed?.owner) return null;
    return this.actors.get(placed.owner) ?? null;
  }

  private dialogOf(npcId: string) {
    const npc = this.actors.get(npcId);
    return npc ? resolveDialog(this.defFor(npc)) : null;
  }

  private setConversation(actor: ActorRuntime, next: Conversation | null): boolean {
    if (actor.conversation === next) return false;
    actor.conversation = next;
    this.conversationChanged.add(actor.id);
    return true;
  }

  private tickConversations() {
    for (const actor of this.actors.values()) {
      const current = actor.conversation;
      if (!current) continue;
      const npc = this.actors.get(current.npcId);
      const bothAct = !this.incapacitated(actor) && !(npc && this.incapacitated(npc));
      if (bothAct && this.withinTalkReach(actor, current.npcId)) continue;
      this.setConversation(actor, null);
    }
  }

  private withinTalkReach(actor: ActorRuntime, npcId: string): boolean {
    const npc = this.actors.get(npcId);
    if (!npc) return false;
    const mine = this.tryLocate(actor);
    const theirs = this.tryLocate(npc);
    if (!mine || !theirs) return false;
    return canTalkFrom(this.map, this.tilesById, mine, theirs);
  }

  private anyoneTalkingTo(npcId: string): boolean {
    for (const actor of this.actors.values()) {
      if (actor.conversation?.npcId === npcId) return true;
    }
    return false;
  }

  conversationOf(id: string): Conversation | null {
    return this.actors.get(id)?.conversation ?? null;
  }

  drainConversationChanges(): string[] {
    if (this.conversationChanged.size === 0) return [];
    const changed = [...this.conversationChanged];
    this.conversationChanged.clear();
    return changed;
  }

  private partnerViewFor(partner: ActorRuntime): PartnerView {
    return {
      name: () => this.bodyName(partner.id),
      attempt: (effects) => this.attemptDialogEffects(partner.id, effects),
    };
  }

  private attemptDialogEffects(actorId: string, effects: readonly DialogEffectDef[]): boolean {
    const partner = this.actors.get(actorId);
    if (!partner) return false;

    let kit = partner.equipment;
    for (const effect of effects) {
      if (effect.effect === "add_status" && !this.statusDefs[effect.statusId]) {
        return false;
      }
      if (effect.effect !== "trade") continue;
      const next = planTrade(this.tilesById, kit, effect.take, effect.give, mintItemId);
      if (!next) return false;
      kit = next;
    }

    if (kit !== partner.equipment) this.setEquipment(partner, kit);
    for (const effect of effects) this.applyDialogEffect(partner, effect);
    return true;
  }

  private applyDialogEffect(partner: ActorRuntime, effect: DialogEffectDef) {
    if (effect.effect === "add_status") {
      this.grantStatus(partner, { id: effect.statusId });
      return;
    }
    if (effect.effect === "remove_status") {
      this.clearStatus(partner, effect.statusId);
      return;
    }
    if (effect.effect === "tag" && !partner.tags.includes(effect.tag)) {
      this.setTags(partner, [...partner.tags, effect.tag]);
    }
  }

  private clearStatus(actor: ActorRuntime, statusId: string) {
    if (!actor.statuses.some((s) => s.defId === statusId)) return;
    actor.statuses = actor.statuses.filter((s) => s.defId !== statusId);
    this.noteStatusReading(actor);
  }

  private endStatusesOnDamage(actor: ActorRuntime) {
    const statuses = endOnDamage(actor.statuses, this.statusDefs);
    if (statuses === actor.statuses) return;
    actor.statuses = statuses;
    this.noteStatusReading(actor);
  }

  private incapacitated(actor: ActorRuntime): boolean {
    return incapacitated(actor.statuses, this.statusDefs);
  }

  private canSeeFrom(actor: ActorRuntime, loc: ActorLocation, at: Coord): boolean {
    return hasLineOfSight(
      this.map,
      this.tilesById,
      { x: loc.x, y: loc.y, z: loc.z },
      at,
      this.defFor(actor).height,
    );
  }

  private planDozing(dozing: readonly ActorRuntime[], round: BrainRound) {
    if (dozing.length === 0) return;
    const turns = Math.min(BRAIN_DOZE_BUDGET, dozing.length);
    const start = this.dozeCursor % dozing.length;
    for (let i = 0; i < dozing.length; i++) {
      const actor = dozing[(start + i) % dozing.length]!;
      if (i < turns) {
        round.turns.push({ actor, tickMs: BRAIN_TICK_MS + actor.brainDeferredMs });
        actor.brainDeferredMs = 0;
      } else {
        actor.brainDeferredMs += BRAIN_TICK_MS;
      }
    }
    this.dozeCursor = start + turns;
  }

  private attentive(
    actor: ActorRuntime,
    players: readonly PlanCoord[],
    hurt: ReadonlyMap<string, string[]>,
  ): boolean {
    if (hurt.has(actor.id)) return true;
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    const reach = Math.max(BRAIN_ATTENTION_FLOOR_CELLS, this.reachOf(this.defFor(actor)));
    for (const player of players) {
      if (Math.abs(player.x - loc.x) <= reach && Math.abs(player.y - loc.y) <= reach) {
        return true;
      }
    }
    return false;
  }

  private reachOf(def: TileDef): number {
    const brain = resolveBrain(def);
    return brain ? brainReach(brain) : 0;
  }

  private playerPlans(): PlanCoord[] {
    const out: PlanCoord[] = [];
    for (const actor of this.actors.values()) {
      if (actor.resident) continue;
      const loc = this.tryLocate(actor);
      if (loc) out.push({ x: loc.x, y: loc.y });
    }
    return out;
  }

  private tickOneBrain(actor: ActorRuntime, round: BrainRound, tickMs: number) {
    const loc = this.tryLocate(actor);
    if (!loc) return;
    if (this.incapacitated(actor)) {
      actor.walkOrder = null;
      return;
    }

    const brain = resolveBrain(this.defFor(actor));
    if (!brain) return;

    actor.brain ??= initialMemory(brain);
    actor.walkOrder = null;
    const sight = this.battlerOf(actor)?.sight ?? DEFAULT_BATTLER.sight;
    const thingsFound = new Map<string, FoundThing | null>();
    const reach = brainReach(brain);
    stepBrain(brain, actor.brain, tickMs, {
      busy: !this.idle(actor),
      rng: this.rng,
      self: { x: loc.x, y: loc.y, z: loc.z },
      home: actor.home,
      nearestOnTile: (tileIds) => this.nearestOnTile(actor.id, loc, tileIds),
      nearestThing: (tileIds) => {
        const key = tileIds.join("+");
        const known = thingsFound.get(key);
        if (known !== undefined) return known;
        const found = this.nearestThing(loc, new Set(tileIds), reach, sight);
        thingsFound.set(key, found);
        return found;
      },
      thingStillThere: (at, tileId) => this.thingStillThere(at, tileId),
      positionOf: (id) => (this.isConcealed(id) ? null : this.actorCell(id)),
      wouldDrop: (direction) => this.stepLeavesGround(loc, direction),
      wouldStepIntoHazard: (direction) => this.stepLandsInHazard(actor, loc, direction),
      step: (direction) => this.applyStepRequest(actor, { directions: [direction] }),
      walkTo: (goal, allowDrops) => this.setWalkOrder(actor, goal, allowDrops),
      fleeFrom: (threat, allowDrops) => this.setFleeOrder(actor, loc, threat, allowDrops),
      say: (text) => this.recordSpeech(actor, loc, text),
      noise: (text) => this.recordNoise(actor.id, loc, text),
      canSee: (at) => this.canSeeFrom(actor, loc, at),
      talking: () => this.anyoneTalkingTo(actor.id),
      sight,
      heard: () => round.heard,
      heardNoise: () => soundsHeardBy(round.sounds, actor.id),
      hurtBy: () => this.visibleAttackers(round.hurt.get(actor.id)),
      attack: (id) => this.tryAttack(actor, id),
      cast: (spell, targetId) => this.castForBrain(actor, spell, targetId),
      extract: (at, tileId) => this.extractForBrain(actor, at, tileId),
      consume: (tileId) => this.consumeForBrain(actor, tileId),
      consumeOn: (at, tileId) => this.consumeOnGround(actor, at, tileId),
      carrying: (tileId) => this.carryingInBag(actor, tileId),
      hasStatus: (id, atLeastMs) => this.hasStatus(actor, id, atLeastMs),
      standOff: (id) => this.standOff(actor, id),
      health: () => this.healthShare(actor),
      minutesOfDay: round.minutesOfDay,
      nameOf: (id) => this.bodyName(id),
    });
  }

  private bodyName(id: string): string | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    return bodyNameFor({ tileId: loc.placed.tileId, name: actor.name }, this.tilesById);
  }

  private recordSpeech(actor: ActorRuntime, loc: ActorLocation, raw: string) {
    const text = sanitizeChatText(raw);
    if (!text) return;
    this.pendingSpeech.push({
      id: `say-${this.nextSpeechId++}`,
      actorId: actor.id,
      tileId: loc.placed.tileId,
      name: actor.name,
      text,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
  }

  private recordNoise(sourceId: string, loc: ActorLocation, raw: string) {
    if (this.isConcealed(sourceId)) return;
    const text = sanitizeChatText(raw);
    if (!text) return;
    const noise: NoiseEmission = {
      id: `noise-${this.nextNoiseId++}`,
      text,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      elapsedMs: 0,
    };
    this.pendingNoise.push(noise);
    this.liveNoise.push(noise);
    this.pendingSound.push({ sourceId, text });
  }

  private ageNoises(tickMs: number) {
    if (this.liveNoise.length === 0) return;
    let expired = false;
    for (const noise of this.liveNoise) {
      noise.elapsedMs += tickMs;
      if (noise.elapsedMs >= NOISE_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.liveNoise = this.liveNoise.filter((noise) => noise.elapsedMs < NOISE_LIFETIME_MS);
    }
  }

  drainNoise(): NoiseEmission[] {
    const made = this.pendingNoise;
    this.pendingNoise = [];
    return made;
  }

  drainSpeech(): ChatBubble[] {
    const said = this.pendingSpeech;
    this.pendingSpeech = [];
    return said;
  }

  drainDamage(): DamageNumber[] {
    const dealt = this.pendingDamage;
    this.pendingDamage = [];
    return dealt;
  }

  drainProjectiles(): ProjectileFlight[] {
    const loosed = this.pendingProjectiles;
    this.pendingProjectiles = [];
    return loosed;
  }

  drainTransitions(): TileTransitionNote[] {
    const happened = this.pendingTransitions;
    this.pendingTransitions = [];
    return happened;
  }

  takeTransitions(): HeldTransition[] {
    const taken = this.heldForViewer.map((note) => ({ note, ageMs: 0 }));
    this.heldForViewer = [];
    return taken;
  }

  private noteTransition(side: TransitionSide, tileId: string, cell: Coord, stackIndex: number) {
    if (!transitionOf(this.tilesById[tileId], side)) return;
    const note: TileTransitionNote = {
      id: `transition-${this.nextTransitionId++}`,
      side,
      tileId,
      x: cell.x,
      y: cell.y,
      z: cell.z,
      stackIndex,
    };
    this.pendingTransitions.push(note);
    this.heldForViewer.push(note);
    if (this.heldForViewer.length > MAX_HELD_TRANSITIONS) {
      this.heldForViewer.shift();
    }
  }

  private strikeBody(targetId: string, projectileTileId: string | null | undefined) {
    if (!projectileTileId) return;
    if (!projectileEffect(this.tilesById[projectileTileId], "hit")) return;
    const target = this.actors.get(targetId);
    const loc = target ? this.tryLocate(target) : null;
    if (!loc) return;

    const note: TileTransitionNote = {
      id: `transition-${this.nextTransitionId++}`,
      side: "appear",
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      struckBy: projectileTileId,
    };
    this.pendingTransitions.push(note);
    this.heldForViewer.push(note);
    if (this.heldForViewer.length > MAX_HELD_TRANSITIONS) {
      this.heldForViewer.shift();
    }
  }

  drainTeleports(): string[] {
    const travelled = this.pendingTeleports;
    this.pendingTeleports = [];
    return travelled;
  }

  drainSwings(): string[] {
    const swung = this.pendingSwings;
    this.pendingSwings = [];
    return swung;
  }

  drainDeaths(): Death[] {
    const died = this.pendingDeaths;
    this.pendingDeaths = [];
    return died;
  }

  drainSpawnMarks(): { actorId: string; at: Coord }[] {
    const moved = this.pendingSpawnMarks;
    this.pendingSpawnMarks = [];
    return moved;
  }

  private advanceCooldowns(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.attackCooldownMs > 0) {
        actor.attackCooldownMs = Math.max(0, actor.attackCooldownMs - tickMs);
      }
      if (actor.attackRecoveryMs > 0) {
        actor.attackRecoveryMs = Math.max(0, actor.attackRecoveryMs - tickMs);
      }
      if (actor.nextBlow) windProgress(actor.nextBlow, tickMs);
      const windup = actor.windup;
      if (!windup) continue;
      windup.sinceSeenMs += tickMs;
      if (windup.sinceSeenMs > WINDUP_LAPSE_MS) {
        this.disengage(actor);
        continue;
      }
      if (windup.inReach && windup.msLeft > 0) {
        windup.msLeft = Math.max(0, windup.msLeft - tickMs);
      }
    }
  }

  private advanceExtractions(tickMs: number) {
    for (const actor of this.actors.values()) {
      this.advanceExtraction(actor, tickMs);
    }
  }

  private advanceExtraction(actor: ActorRuntime, tickMs: number) {
    const run = actor.extraction;
    if (!run) return;

    if (!this.holdsExtraction(actor, run)) {
      this.cancelExtraction(actor, EXTRACT_INTERRUPTED_NOTICE);
      return;
    }

    run.progress.remainingMs -= tickMs;
    if (run.progress.remainingMs > 0) return;
    run.progress.remainingMs = 0;
    this.finishExtraction(actor, run);
  }

  private holdsExtraction(actor: ActorRuntime, run: ExtractionRun): boolean {
    if (!this.readyToAct(actor)) return false;
    const at = this.actorCell(actor.id);
    if (!at || at.x !== run.from.x || at.y !== run.from.y || at.z !== run.from.z) {
      return false;
    }
    const stack = getStack(this.map, run.ref.x, run.ref.y, run.ref.z);
    const placed = stack[run.ref.stackIndex];
    if (!placed || placed.tileId !== run.tileId) return false;
    return reachableExtractAt(this.map, this.tilesById, this.locate(actor), run.ref) != null;
  }

  private cancelExtraction(actor: ActorRuntime, notice?: string) {
    const run = actor.extraction;
    if (!run) return;
    this.releaseReservation(run);
    this.setExtraction(actor, null);
    if (notice) this.say(actor.id, notice);
  }

  private releaseReservation(run: ExtractionRun) {
    const { ref } = run;
    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    if (!placed || placed.tileId !== run.tileId) return;
    const next = stack.map((current, i) =>
      i === ref.stackIndex ? withReservation(current, -1) : current,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
  }

  private setExtraction(actor: ActorRuntime, run: ExtractionRun | null) {
    actor.extraction = run;
    this.extractionChanged.add(actor.id);
  }

  private advanceStoneCooldowns(tickMs: number) {
    this.stoneClockMs += tickMs;
    if (this.stoneClockMs + COOLDOWN_EPSILON_MS < COOLDOWN_STEP_MS) return;

    const steps = Math.floor((this.stoneClockMs + COOLDOWN_EPSILON_MS) / COOLDOWN_STEP_MS);
    this.stoneClockMs -= steps * COOLDOWN_STEP_MS;
    const spent = steps * COOLDOWN_STEP_MS;

    for (const actor of this.actors.values()) {
      this.coolSpells(actor, spent);
      const next = cooledEquipment(actor.equipment, spent);
      if (next === actor.equipment) continue;
      this.setEquipment(actor, next);
    }
  }

  private coolSpells(actor: ActorRuntime, spentMs: number) {
    let changed = false;
    for (const name of Object.keys(actor.spellCooldownMs)) {
      const remaining = (actor.spellCooldownMs[name] ?? 0) - spentMs;
      if (remaining > 0) actor.spellCooldownMs[name] = remaining;
      else delete actor.spellCooldownMs[name];
      changed = true;
    }
    if (changed) this.equipmentChanged.add(actor.id);
  }

  private tickCharms(tickMs: number) {
    for (const actor of this.actors.values()) {
      const charm = this.wornCharm(actor);
      if (!charm) {
        actor.charmClock = null;
        continue;
      }

      const clock =
        actor.charmClock?.itemId === charm.itemId
          ? actor.charmClock
          : { itemId: charm.itemId, elapsedMs: 0 };
      actor.charmClock = clock;

      clock.elapsedMs += tickMs;
      if (clock.elapsedMs < charm.item.everyMs) continue;
      /**
       * Subtracted rather than zeroed, so a long-run cadence stays honest on
       * a tick that does not divide the interval evenly. Bounded by one
       * interval, so a world resumed after an hour does not pay out an
       * hour's worth of healing in one frame.
       */
      clock.elapsedMs = Math.min(charm.item.everyMs, clock.elapsedMs - charm.item.everyMs);
      this.spendCharm(actor, charm.item);
    }
  }

  private wornCharm(actor: ActorRuntime): { itemId: string; item: CharmItem } | null {
    const held = actor.equipment.charm;
    if (!held) return null;
    const def = this.tilesById[held.tileId];
    const item = def ? resolveCharm(def) : null;
    return item ? { itemId: held.id, item } : null;
  }

  private spendCharm(actor: ActorRuntime, charm: CharmItem) {
    if (charm.hp) this.applyHealing(actor, charm.hp);
    for (const grant of charm.statuses ?? []) {
      this.grantStatus(actor, grant, undefined, NO_ELEMENTS);
    }
  }

  private tickStrikes(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (!actor.strike) continue;
      actor.strike.elapsedMs += tickMs;
      if (actor.strike.elapsedMs >= STRIKE_DURATION_MS) actor.strike = null;
    }
  }

  private runAutoAttacks() {
    for (const actor of this.actors.values()) {
      const targetId = actor.targetId;
      if (targetId === null) continue;
      if (!this.actors.has(targetId)) {
        actor.targetId = null;
        continue;
      }
      if (!actor.attacking) continue;
      this.tryAttack(actor, targetId);
    }
  }

  private disengage(actor: ActorRuntime) {
    actor.windup = null;
    actor.nextBlow = null;
  }

  private outOfReach(actor: ActorRuntime, targetId: string) {
    const windup = actor.windup;
    if (windup?.targetId !== targetId) {
      this.disengage(actor);
      return;
    }
    windup.inReach = false;
    windup.sinceSeenMs = 0;
    actor.nextBlow = null;
  }

  private tryAttack(attacker: ActorRuntime, targetId: string): boolean {
    if (targetId === attacker.id) return false;
    if (this.incapacitated(attacker)) {
      this.disengage(attacker);
      return false;
    }

    const target = this.actors.get(targetId);
    if (!target) return false;

    if (!this.mayHarm(attacker, target)) {
      this.disengage(attacker);
      return false;
    }

    const from = this.tryLocate(attacker);
    const to = this.tryLocate(target);
    if (!from || !to) return false;
    const fromPoint = this.reachPointOf(from);
    const toPoint = this.reachPointOf(to);

    const hand = handToSwing(attacker.equipment, this.tilesById, attacker.nextHand, (weapon) =>
      canReach(this.map, this.tilesById, fromPoint, toPoint, weapon.reach),
    );
    if (hand === null && fightsWithAHand(attacker.equipment, this.tilesById)) {
      this.outOfReach(attacker, targetId);
      return false;
    }

    const attackerStats = this.battlerOf(attacker, hand);
    const targetStats = this.battlerOf(target);
    if (!attackerStats || !targetStats) return false;

    if (
      hand === null &&
      !canReach(this.map, this.tilesById, fromPoint, toPoint, attackerStats.reach)
    ) {
      this.outOfReach(attacker, targetId);
      return false;
    }

    const interval = swingIntervalMs(attackerStats);

    const armed = attacker.windup?.targetId === targetId;
    const returning = armed && !attacker.windup!.inReach;
    if (!armed) {
      attacker.windup = {
        targetId,
        msLeft: swingWindupMs(attackerStats),
        sinceSeenMs: 0,
        inReach: true,
      };
    }
    const windup = attacker.windup!;
    windup.inReach = true;
    windup.sinceSeenMs = 0;
    if (!armed || returning) {
      /**
       * The longer of the two waits, not the windup alone: a body that turns
       * on the target beside the one it just killed is in reach immediately
       * and still owes the rest of its cooldown, and reading only the windup
       * would promise a blow that is not coming.
       */
      attacker.nextBlow = {
        remainingMs: Math.max(windup.msLeft, attacker.attackCooldownMs),
        durationMs: interval,
      };
    }
    if (windup.msLeft > 0) return false;

    if (attacker.attackCooldownMs > 0) return false;

    attacker.attackCooldownMs = interval;
    windup.msLeft = swingWindupMs(attackerStats);
    attacker.nextBlow = { remainingMs: interval, durationMs: interval };

    const swung = hand;
    attacker.nextHand = swung ? otherHand(swung) : attacker.nextHand;

    attacker.attackRecoveryMs = strikeRecoveryMs(this.defFor(attacker));
    this.pendingSwings.push(attacker.id);
    this.flagCombat(attacker);
    this.flagCombat(target);

    if (!outranksSwing(attacker.strike)) {
      attacker.strike = swingToward(fromPoint, toPoint, isRanged(attackerStats));
    }

    this.turnToward(attacker, from, to);

    const assailants = this.noteAssailant(target, attacker.id, interval);
    const rolled = rollAttack(attackerStats, underPressure(targetStats, assailants), this.rng);
    const flightMs = this.fireProjectile(
      attackerStats.projectile,
      from,
      to,
      !rolled.missed && !rolled.dodged,
    );

    const blame = this.blameForSwing(attacker, swung);
    const attackerId = attacker.id;
    const struckId = target.id;
    const targetMaxHp = targetStats.maxHp;
    const projectile = attackerStats.projectile;
    this.queueBlow(flightMs, () =>
      this.landSwing({
        attackerId,
        targetId: struckId,
        rolled,
        swung,
        targetMaxHp,
        blame,
        fromPoint,
        toPoint,
        projectile,
      }),
    );
    return true;
  }

  private landSwing(blow: {
    attackerId: string;
    targetId: string;
    rolled: AttackOutcome;
    swung: Hand | null;
    targetMaxHp: number;
    blame: Blame;
    fromPoint: ReachPoint;
    toPoint: ReachPoint;
    projectile: string | null | undefined;
  }): void {
    const target = this.actors.get(blow.targetId);
    if (!target) return;

    if (!blow.rolled.missed && !blow.rolled.dodged) {
      this.strikeBody(blow.targetId, blow.projectile);
    }

    const outcome = cappedToHealth(blow.rolled, this.hpOf(target) ?? 0);

    this.notePendingHurt(target.id, blow.attackerId);

    const attacker = this.actors.get(blow.attackerId);
    if (attacker) {
      this.awardExperience(attacker, target, outcome, blow.swung, blow.targetMaxHp);
    }

    if (outcome.missed) {
      this.floatSwing(target, "miss", 0);
      return;
    }
    if (outcome.dodged) {
      target.strike = dodgeAway(blow.toPoint, blow.fromPoint);
      return;
    }

    this.applyDamage(target, outcome.damage, blow.blame);
    if (outcome.inflicted.length > 0 && (this.hpOf(target) ?? 0) > 0) {
      for (const grant of outcome.inflicted) {
        this.grantStatus(target, grant, undefined, undefined, {
          source: this.statusName(grant.id),
          ...(blow.blame.by ? { by: blow.blame.by } : {}),
        });
      }
    }
  }

  private fireProjectile(
    tileId: string | null | undefined,
    fromBody: ActorLocation,
    toBody: ActorLocation,
    connected: boolean,
  ): number {
    if (!tileId) return 0;
    const def = this.tilesById[tileId];
    const flies = resolveProjectile(def);
    if (!flies) return 0;

    const from = this.flightPointOf(fromBody);
    const to = this.flightPointOf(toBody);

    const flight: ProjectileFlight = {
      id: `shot-${this.nextProjectileId++}`,
      tileId,
      from: { x: from.x, y: from.y, elevAbs: from.elevAbs },
      to: { x: to.x, y: to.y, elevAbs: to.elevAbs },
      ...(toBody.placed.owner ? { targetId: toBody.placed.owner } : {}),
      durationMs: flightDurationMs(from, to, flies),
      elapsedMs: 0,
      hit: connected,
    };
    this.pendingProjectiles.push(flight);
    this.liveProjectiles.push(flight);
    beginEffect(flight, "appear", flight.from, def, this.liveFlightEffects);
    return flight.durationMs;
  }

  private floatSwing(target: ActorRuntime, outcome: SwingOutcome, amount: number) {
    const loc = this.tryLocate(target);
    if (!loc) return;

    const number: DamageNumber = {
      id: `hit-${this.nextDamageId++}`,
      targetId: target.id,
      outcome,
      amount,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      elapsedMs: 0,
    };
    this.pendingDamage.push(number);
    this.liveDamage.push(number);
  }

  private awardExperience(
    attacker: ActorRuntime,
    target: ActorRuntime,
    outcome: AttackOutcome,
    swung: Hand | null,
    targetMaxHp: number,
  ) {
    if (outcome.missed) return;
    if (attacker.resident && target.resident) return;

    const attackerRating = this.ratingOf(attacker);
    const targetRating = this.ratingOf(target);
    if (attackerRating === null || targetRating === null) return;

    if (!attacker.resident) {
      const body = this.bodyOf(attacker);
      if (body) {
        this.grantExperience(
          attacker,
          attackerEarnings(
            outcome,
            weaponInHand(body, attacker.equipment, this.tilesById, swung),
            (mastery) => masteryMultiplier(targetRating, body.masteries, mastery),
          ),
        );
      }
    }

    const defensive = experienceMultiplier(attackerRating, targetRating);
    if (!target.resident && defensive > 0) {
      this.grantExperience(
        target,
        defenderEarnings(
          outcome,
          defensive,
          this.spendDefensiveDecay(target, attacker.id),
          targetMaxHp,
        ),
      );
    }
  }

  private awardCausedDamage(
    victim: ActorRuntime,
    causedBy: string | undefined,
    damage: number,
    elements: readonly Element[],
  ) {
    if (!causedBy || causedBy === victim.id || damage <= 0) return;
    const caster = this.actors.get(causedBy);
    if (!caster || caster.resident) return;

    const casterRating = this.ratingOf(caster);
    const victimRating = this.ratingOf(victim);
    if (casterRating === null || victimRating === null) return;

    this.grantCasting(caster, damage, elements, (mastery) =>
      masteryMultiplier(victimRating, this.bodyOf(caster)?.masteries ?? {}, mastery),
    );
  }

  private grantCasting(
    caster: ActorRuntime,
    amount: number,
    elements: readonly Element[],
    multiplierFor: (mastery: Mastery) => number,
  ) {
    const body = this.bodyOf(caster);
    if (!body) return;
    this.grantExperience(caster, casterEarnings(amount, elements, multiplierFor));
  }

  private grantExperience(actor: ActorRuntime, earned: MasteryXp) {
    const xp = actor.masteryXp;
    if (!xp) return;

    let moved: MasteryXp | null = null;
    let crossed: Mastery[] | null = null;
    for (const mastery of MASTERIES) {
      const amount = earned[mastery];
      if (!amount) continue;
      moved ??= { ...xp };
      const before = moved[mastery] ?? 0;
      const after = before + amount;
      moved[mastery] = after;
      if (levelForXp(after) > levelForXp(before)) (crossed ??= []).push(mastery);
    }
    if (!moved) return;

    actor.masteryXp = moved;
    actor.earnedBody = null;
    this.masteriesChanged.add(actor.id);
    for (const mastery of crossed ?? []) {
      this.say(actor.id, masteryNotice(mastery, levelForXp(moved[mastery] ?? 0)));
    }
  }

  private spendDefensiveDecay(target: ActorRuntime, attackerId: string): number {
    const decayed = (target.defensiveDecay ??= new Map());
    const seen = decayed.get(attackerId);
    if (!seen) {
      decayed.set(attackerId, { payouts: 1, idleMs: 0 });
      return defensiveDecay(0);
    }
    seen.idleMs = 0;
    const worth = defensiveDecay(seen.payouts);
    seen.payouts++;
    return worth;
  }

  private recoverDefensiveDecay(tickMs: number) {
    for (const actor of this.actors.values()) {
      const decayed = actor.defensiveDecay;
      if (!decayed) continue;
      for (const [attackerId, seen] of decayed) {
        seen.idleMs += tickMs;
        if (seen.idleMs < DEFENSIVE_RECOVERY_MS) continue;
        seen.idleMs -= DEFENSIVE_RECOVERY_MS;
        seen.payouts--;
        if (seen.payouts <= 0) decayed.delete(attackerId);
      }
      if (decayed.size === 0) actor.defensiveDecay = null;
    }
  }

  private noteAssailant(target: ActorRuntime, attackerId: string, swingMs: number): number {
    const onMe = (target.assailants ??= new Map());
    onMe.set(attackerId, swingMs + ASSAILANT_GRACE_MS);
    return onMe.size;
  }

  private forgetSpentAssailants(tickMs: number) {
    for (const actor of this.actors.values()) {
      const onMe = actor.assailants;
      if (!onMe) continue;
      for (const [attackerId, remainingMs] of onMe) {
        const left = remainingMs - tickMs;
        if (left > 0) onMe.set(attackerId, left);
        else onMe.delete(attackerId);
      }
      if (onMe.size === 0) actor.assailants = null;
    }
  }

  private flagCombat(actor: ActorRuntime) {
    actor.statuses = enterCombat(actor.statuses);
    this.noteStatusReading(actor);
  }

  inCombat(id: string): boolean {
    const actor = this.actors.get(id);
    return actor ? inCombat(actor.statuses) : false;
  }

  standIdle(id: string) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.input = { directions: [] };
    actor.attacking = false;
    this.cancelCasting(actor);
  }

  private notePendingHurt(targetId: string, attackerId: string) {
    const attackers = this.pendingHurt.get(targetId);
    if (attackers) attackers.push(attackerId);
    else this.pendingHurt.set(targetId, [attackerId]);
  }

  private applyDamage(target: ActorRuntime, amount: number, blame?: Blame) {
    const before = this.hpOf(target);
    if (before === null) return;

    if (amount > 0) this.cancelExtraction(target, EXTRACT_INTERRUPTED_NOTICE);
    if (amount > 0 && target.casting && !target.casting.uninterruptible) {
      this.cancelCasting(target, CAST_INTERRUPTED_NOTICE);
    }
    if (amount > 0) this.flagCombat(target);
    if (amount > 0) this.endStatusesOnDamage(target);

    this.floatSwing(target, "hit", amount);

    const after = before - amount;
    target.hp = Math.max(0, after);
    if (target.hp === 0) this.kill(target, blame);
  }

  private applyHealing(target: ActorRuntime, amount: number): number {
    if (amount <= 0) return 0;
    const stats = this.battlerOf(target);
    const before = this.hpOf(target);
    if (!stats || before === null) return 0;

    const restored = Math.min(amount, stats.maxHp - before);
    if (restored <= 0) return 0;

    target.hp = before + restored;
    this.floatSwing(target, "heal", restored);
    return restored;
  }

  private kill(target: ActorRuntime, blame?: Blame) {
    const loc = this.tryLocate(target);
    this.cancelExtraction(target);
    this.cancelCasting(target);

    this.forgetWalk(target);
    this.actors.delete(target.id);
    this.forgetTileIndex();
    if (loc && !target.hidden) {
      this.noteTransition("disappear", loc.placed.tileId, loc, loc.stackIndex);
    }
    this.map = loc
      ? removeTileAt(this.map, loc.x, loc.y, loc.z, loc.stackIndex)
      : despawnActor(this.map, target.id);
    this.pendingHurt.delete(target.id);
    for (const actor of this.actors.values()) {
      if (actor.targetId === target.id) actor.targetId = null;
      actor.assailants?.delete(target.id);
    }

    const equipment = loc ? this.dropKit(target.equipment, loc) : target.equipment;

    if (loc) this.dropRemains(target, loc, blame);

    this.pendingDeaths.push({
      id: target.id,
      equipment,
      masteryXp: target.masteryXp,
      tags: target.tags,
    });

    if (loc) this.reindexCells([{ x: loc.x, y: loc.y, z: loc.z }]);
  }

  private dropKit(equipment: Equipment, at: Coord): Equipment {
    const carried = spilled(equipment, this.tilesById);
    if (carried.length === 0) return equipment;

    const dropped = this.dropOnFloor(at, carried.map(placementFromInstance));
    return dropped ? emptyEquipment() : equipment;
  }

  private dropOnFloor(at: Coord, placements: PlacedTile[]): boolean {
    const stack = getStack(this.map, at.x, at.y, at.z);
    if (walkableElevInStack(stack, this.tilesById) == null) return false;
    const room = canReplaceStack(
      this.map,
      at.x,
      at.y,
      at.z,
      [...stack, ...placements],
      this.tilesById,
    );
    if (!room.ok) return false;

    for (const placed of placements) {
      this.map = appendItem(this.map, at.x, at.y, at.z, placed, this.tilesById);
    }
    return true;
  }

  private dropRemains(target: ActorRuntime, at: ActorLocation, blame?: Blame) {
    const def = this.tilesById[at.placed.tileId];
    const remains = def ? resolveBattler(def)?.remains : undefined;
    if (!remains || !this.tilesById[remains]) return;

    this.dropOnFloor(at, [
      {
        tileId: remains,
        itemId: mintItemId(),
        engraved: bodyNameFor({ tileId: at.placed.tileId, name: target.name }, this.tilesById),
        ...(blame ? { description: causeOfDeath(blame) } : {}),
      },
    ]);
  }

  private ageProjectiles(tickMs: number) {
    if (this.liveProjectiles.length > 0) {
      this.liveProjectiles = ageFlights(
        this.liveProjectiles,
        tickMs,
        this.tilesById,
        this.liveFlightEffects,
      );
    }
    if (this.liveFlightEffects.length > 0) {
      this.liveFlightEffects = ageEffects(this.liveFlightEffects, tickMs);
    }
  }

  private queueBlow(delayMs: number, land: () => void) {
    if (delayMs <= 0) {
      land();
      return;
    }
    this.blowsInFlight.push({ remainingMs: delayMs, land });
  }

  private landArrivedBlows(tickMs: number) {
    if (this.blowsInFlight.length === 0) return;
    const waiting: BlowInFlight[] = [];
    const arrived: BlowInFlight[] = [];
    for (const blow of this.blowsInFlight) {
      blow.remainingMs -= tickMs;
      (blow.remainingMs <= 0 ? arrived : waiting).push(blow);
    }
    /**
     * Swapped before anything lands rather than after, so a blow that kills
     * somebody cannot be walked over twice by a re-entrant tick.
     */
    this.blowsInFlight = waiting;
    for (const blow of arrived) blow.land();
  }

  private ageDamageNumbers(tickMs: number) {
    if (this.liveDamage.length === 0) return;
    let expired = false;
    for (const number of this.liveDamage) {
      number.elapsedMs += tickMs;
      if (number.elapsedMs >= DAMAGE_NUMBER_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.liveDamage = this.liveDamage.filter(
        (number) => number.elapsedMs < DAMAGE_NUMBER_LIFETIME_MS,
      );
    }
  }

  private battlerOf(
    actor: ActorRuntime,
    hand: Hand | null = this.handOf(actor),
  ): FightingStats | null {
    const base = this.baseBattlerOf(actor, hand);
    if (!base) return null;
    /**
     * The stored figure rather than {@link hpOf}, which reads this function
     * and would recurse. Statuses that read HP see the raw number for this
     * reason: the clamp exists so a lowered maximum cannot leave somebody
     * overfull, not to change what they have.
     */
    return withStatusModifiers(base, actor.statuses, this.statusDefs, actor.hp ?? base.maxHp);
  }

  private baseBattlerOf(
    actor: ActorRuntime,
    hand: Hand | null = this.handOf(actor),
  ): FightingStats | null {
    const body = this.bodyOf(actor);
    if (!body) return null;
    return effectiveBattler(body, actor.equipment, this.tilesById, hand);
  }

  private attributesOf(actor: ActorRuntime): Attributes | null {
    const body = this.bodyOf(actor);
    const loc = this.tryLocate(actor);
    const bodyDef = loc ? this.tilesById[loc.placed.tileId] : undefined;
    if (!body || !bodyDef) return null;
    return attributesOf({
      body,
      bodyDef,
      equipment: actor.equipment,
      tilesById: this.tilesById,
      statuses: actor.statuses,
      statusDefs: this.statusDefs,
      hp: actor.hp,
    });
  }

  private handOf(actor: ActorRuntime): Hand | null {
    return handToSwing(actor.equipment, this.tilesById, actor.nextHand);
  }

  private statusName(id: string): string {
    return this.statusDefs[id]?.name ?? id;
  }

  private blameForSwing(attacker: ActorRuntime, hand: Hand | null): Blame {
    const by = this.bodyName(attacker.id) ?? undefined;
    const held = hand ? attacker.equipment[hand] : null;
    if (held) {
      return {
        source: this.tilesById[held.tileId]?.name ?? held.tileId,
        ...(by ? { by } : {}),
      };
    }
    const natural = resolveBattler(this.defFor(attacker))?.naturalWeapon;
    return {
      source: natural?.name?.trim() || UNNAMED_WEAPON,
      ...(by ? { by } : {}),
    };
  }

  private grantStatus(
    actor: ActorRuntime,
    grant: StatusGrant,
    causedBy?: string,
    elements?: readonly Element[],
    blame?: Blame,
  ): StatusGrantOutcome {
    const def = this.statusDefs[grant.id];
    if (!def) return "refused";
    if (resolveBattler(this.defFor(actor))?.immuneTo?.includes(grant.id)) {
      return "refused";
    }
    if (def.tone === "bad" && causedBy !== undefined) {
      const causer = this.actors.get(causedBy);
      if (causer && !this.mayHarm(causer, actor)) return "refused";
    }
    const already = actor.statuses.some((instance) => instance.defId === def.id);
    const range =
      grant.fromMs === undefined || grant.toMs === undefined
        ? def
        : { fromMs: grant.fromMs, toMs: grant.toMs };
    actor.statuses = applyStatus(actor.statuses, def, this.rng, range, causedBy, elements, blame);
    if (!already) this.say(actor.id, statusAcquiredNotice(def.name));
    this.noteStatusReading(actor);
    return already ? "refreshed" : "acquired";
  }

  private noteStatusReading(actor: ActorRuntime) {
    const reading = statusReading(actor.statuses);
    if (this.statusReadings.get(actor.id) === reading) return;
    this.statusReadings.set(actor.id, reading);
    this.statusesChanged.add(actor.id);
  }

  private tickStatuses(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.statuses.length === 0) continue;

      const base = this.baseBattlerOf(actor);
      if (!base) continue;

      const { statuses, hpChanges } = advanceStatuses(
        actor.statuses,
        tickMs,
        {
          hp:
            this.hpOf(
              actor,
              withStatusModifiers(base, actor.statuses, this.statusDefs, actor.hp ?? base.maxHp),
            ) ?? base.maxHp,
          maxHp: base.maxHp,
          statuses: actor.statuses,
        },
        this.statusDefs,
      );
      actor.statuses = statuses;
      this.noteStatusReading(actor);

      for (const change of hpChanges) {
        if (change.amount < 0) {
          const damage = this.elementalDamage(actor, -change.amount, change.elements);
          this.applyDamage(actor, damage, change.blame);
          this.awardCausedDamage(actor, change.causedBy, damage, change.elements ?? NO_ELEMENTS);
          const causer = change.causedBy ? this.actors.get(change.causedBy) : undefined;
          if (causer && damage > 0) this.flagCombat(causer);
          if (actor.hp === 0) break;
          continue;
        }
        if (change.amount === 0) continue;
        this.applyHealing(actor, change.amount);
      }
    }
  }

  private elementalDamage(
    victim: ActorRuntime,
    damage: number,
    elements: readonly Element[] | undefined,
  ): number {
    if (!elements?.length || damage <= 0) return damage;
    const body = this.bodyOf(victim);
    if (!body) return damage;

    const multiplier = effectiveness(
      elements,
      bodyElements(body, victim.equipment, this.tilesById),
    );
    if (multiplier === NEUTRAL) return damage;
    return Math.max(1, Math.round(damage * multiplier));
  }

  private castContextFor(actor: ActorRuntime): CastContext | null {
    const from = this.tryLocate(actor);
    if (!from) return null;

    const targetActor = actor.targetId ? this.actors.get(actor.targetId) : undefined;
    const to = targetActor ? this.tryLocate(targetActor) : null;

    const body = this.bodyOf(actor);
    return {
      map: this.map,
      tilesById: this.tilesById,
      equipment: actor.equipment,
      masteries: body?.masteries ?? {},
      caster: this.casterPointOf(actor, from),
      casting: actor.casting?.progress ?? null,
      spells: this.spellsOf(actor),
      spellCooldownsMs: actor.spellCooldownMs,
      target: to ? this.castPointOf(to) : null,
      mayHarmTarget: targetActor ? this.mayHarm(actor, targetActor) : true,
      incapacitated: this.incapacitated(actor),
    };
  }

  private spellsOf(actor: ActorRuntime): readonly NaturalSpell[] {
    return resolveBattler(this.defFor(actor))?.spells ?? NO_SPELLS;
  }

  private castPointOf(loc: ActorLocation): CastPoint {
    return { ...this.reachPointOf(loc), stackIndex: loc.stackIndex };
  }

  private casterPointOf(actor: ActorRuntime, from: ActorLocation): CasterPoint {
    const facing = actorDirection(from);
    const tileId = from.placed.tileId;
    const to = actor.walk?.to;
    if (!to) return { ...this.castPointOf(from), facing, tileId };

    const stack = getStack(this.map, to.x, to.y, to.z);
    return {
      x: to.x,
      y: to.y,
      z: to.z,
      stackIndex: stack.length,
      elevAbs: absoluteStandingElevation(to.z, stack, this.tilesById),
      facing,
      tileId,
    };
  }

  spells(id: string = LOCAL_ACTOR_ID): SpellButton[] {
    const actor = this.actors.get(id);
    const context = actor ? this.castContextFor(actor) : null;
    return context ? castableSpells(context) : [];
  }

  cast(slot: CastSlot, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;

    const context = this.castContextFor(actor);
    if (!context) return false;

    const stone = spellIn(context, slot);
    if (!stone) return false;
    const held = slot.from === "square" ? actor.equipment[slot.square] : null;
    if (slot.from === "square" && !held) return false;

    const verdict = castability(context, slot);
    if (!verdict.ok) {
      const notice = castRefusalNotice(verdict.reason);
      if (notice) this.say(id, notice);
      return false;
    }

    const durationMs = castDurationMs(stone, context.masteries);
    if (durationMs <= 0) {
      this.resolveCast(actor, slot, stone, context);
      return true;
    }

    this.cancelExtraction(actor);
    const aimed = needsTarget(stone);
    const targetId = castTargetOf(actor, aimed);
    actor.casting = {
      itemId: held?.id ?? null,
      uninterruptible: stone.uninterruptible === true,
      aimed,
      progress: { remainingMs: durationMs, durationMs, slot, ...(targetId ? { targetId } : {}) },
    };
    return true;
  }

  cancelCast(id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor?.casting) return false;
    this.cancelCasting(actor);
    return true;
  }

  private advanceCastings(tickMs: number) {
    for (const actor of this.actors.values()) {
      this.advanceCasting(actor, tickMs);
    }
  }

  private advanceCasting(actor: ActorRuntime, tickMs: number) {
    const run = actor.casting;
    if (!run) return;
    if (this.incapacitated(actor)) {
      this.cancelCasting(actor, CAST_INTERRUPTED_NOTICE);
      return;
    }

    const targetId = castTargetOf(actor, run.aimed);
    if (run.progress.targetId !== targetId) {
      const { targetId: _was, ...rest } = run.progress;
      run.progress = targetId ? { ...rest, targetId } : rest;
    }

    run.progress.remainingMs -= tickMs;
    if (run.progress.remainingMs > 0) return;
    run.progress.remainingMs = 0;
    this.finishCasting(actor, run);
  }

  private finishCasting(actor: ActorRuntime, run: CastingRun) {
    actor.casting = null;

    const slot = run.progress.slot;
    if (slot.from === "square") {
      const held = actor.equipment[slot.square];
      if (!held || held.id !== run.itemId) return;
    }

    const context = this.castContextFor(actor);
    if (!context) return;
    const stone = spellIn(context, slot);
    if (!stone) return;
    if (!castability(context, slot).ok) return;

    this.resolveCast(actor, slot, stone, context);
  }

  private resolveCast(
    actor: ActorRuntime,
    slot: CastSlot,
    stone: ArcaneStoneItem,
    context: CastContext,
  ) {
    const elements = spellElements(stone.requirements);

    this.spendCooldown(actor, slot, stone);
    this.grantExperience(actor, practiceEarnings(elements));

    if (stone.effect.kind === "bolt") {
      this.castBolt(actor, slot, stone, stone.effect, elements);
    } else this.castConjure(actor, context, stone.effect.tileId, elements);

    this.recordCastSound(actor, stone);
  }

  private spellName(actor: ActorRuntime, slot: CastSlot): string {
    if (slot.from === "natural") return slot.name;
    const held = actor.equipment[slot.square];
    if (!held) return UNNAMED_SPELL;
    return this.tilesById[held.tileId]?.name ?? held.tileId;
  }

  private recordCastSound(actor: ActorRuntime, stone: ArcaneStoneItem) {
    if (!stone.sound?.trim()) return;
    const loc = this.tryLocate(actor);
    if (!loc) return;
    this.recordNoise(actor.id, loc, stone.sound);
  }

  private cancelCasting(actor: ActorRuntime, notice?: string) {
    if (!actor.casting) return;
    actor.casting = null;
    if (notice) this.say(actor.id, notice);
  }

  private spendCooldown(actor: ActorRuntime, slot: CastSlot, stone: ArcaneStoneItem) {
    if (slot.from === "natural") {
      actor.spellCooldownMs[slot.name] = stone.cooldownMs;
      this.equipmentChanged.add(actor.id);
      return;
    }
    const held = actor.equipment[slot.square];
    if (!held) return;
    this.setEquipment(actor, {
      ...actor.equipment,
      [slot.square]: { ...held, cooldownMs: stone.cooldownMs },
    });
  }

  private castBolt(
    actor: ActorRuntime,
    slot: CastSlot,
    stone: ArcaneStoneItem,
    effect: Extract<StoneEffect, { kind: "bolt" }>,
    elements: readonly Element[],
  ) {
    const onTarget = effect.on === "target";
    const subject = onTarget
      ? actor.targetId
        ? this.actors.get(actor.targetId)
        : undefined
      : actor;
    if (!subject) return;

    const atSomebodyElse = subject !== actor;

    const stats = this.battlerOf(subject);
    const before = this.hpOf(subject);
    if (!stats || before === null) return;

    const body = this.bodyOf(actor);
    if (!body) return;

    let flightMs = 0;
    if (atSomebodyElse) {
      flightMs = this.fireBolt(effect.projectile, actor, subject);
      const at = this.tryLocate(actor);
      const on = this.tryLocate(subject);
      if (at && on) this.turnToward(actor, at, on);
    }

    const spell = this.spellName(actor, slot);
    const caster = this.bodyName(actor.id);

    const move = this.rollHealthMove(subject, stone, effect, elements, {
      stats,
      masteries: body.masteries,
    });
    const grants = this.boltInflicts(effect.statuses);

    if (atSomebodyElse && move?.kind === "harm") {
      this.flagCombat(actor);
      this.flagCombat(subject);
    }

    const casterId = actor.id;
    const subjectId = subject.id;
    const projectile = effect.projectile;
    this.queueBlow(flightMs, () =>
      this.landBolt({
        casterId,
        subjectId,
        atSomebodyElse,
        projectile,
        move,
        grants,
        elements,
        spell,
        caster,
        blame: { source: spell, ...(caster ? { by: caster } : {}) },
      }),
    );
  }

  private landBolt(bolt: {
    casterId: string;
    subjectId: string;
    atSomebodyElse: boolean;
    projectile: string | null | undefined;
    move: HealthMove | null;
    grants: readonly StatusGrant[];
    elements: readonly Element[];
    spell: string;
    caster: string | null;
    blame: Blame;
  }): void {
    const subject = this.actors.get(bolt.subjectId);
    if (!subject) return;
    const actor = this.actors.get(bolt.casterId);

    if (bolt.atSomebodyElse) this.notePendingHurt(subject.id, bolt.casterId);

    this.strikeBody(bolt.subjectId, bolt.projectile);

    const harmless = bolt.move?.kind === "harm" && actor && !this.mayHarm(actor, subject);
    if (bolt.move && !harmless) {
      this.applyHealthMove(bolt.move, subject, actor, bolt);
    }

    if ((this.hpOf(subject) ?? 0) <= 0) return;
    for (const grant of bolt.grants) {
      this.grantStatus(subject, grant, bolt.casterId, bolt.elements, {
        source: this.statusName(grant.id),
        by: possessive(bolt.caster, bolt.spell),
      });
    }
  }

  private rollHealthMove(
    subject: ActorRuntime,
    stone: ArcaneStoneItem,
    effect: Extract<StoneEffect, { kind: "bolt" }>,
    elements: readonly Element[],
    context: { stats: FightingStats; masteries: Masteries },
  ): HealthMove | null {
    if (!effect.damage) return null;

    const power = spellPower(effect.damage, stone.requirements, context.masteries);
    const roll: [number, number] = [this.rng.next(), this.rng.next()];
    const guardRoll = this.rng.next();
    const rolled = Math.round(power * damageFraction(effect.variance ?? 0, roll));

    if (rolled <= 0) return { kind: "mend", amount: -rolled };

    const through = damageAfterDefence(rolled, context.stats, ARCANE_BLOW, guardRoll);
    return {
      kind: "harm",
      amount: this.elementalDamage(subject, through, elements),
    };
  }

  private applyHealthMove(
    move: HealthMove,
    subject: ActorRuntime,
    actor: ActorRuntime | undefined,
    context: {
      atSomebodyElse: boolean;
      elements: readonly Element[];
      blame: Blame;
    },
  ) {
    if (move.kind === "harm") {
      /**
       * Trimmed to what the subject has left: a body with three points can
       * only lose three, and this is also what experience is paid on —
       * without the trim, a caster finishing off a nearly-dead body would be
       * paid for hit points that were never there.
       */
      const dealt = Math.min(move.amount, this.hpOf(subject) ?? 0);
      if (dealt <= 0) return;
      this.applyDamage(subject, dealt, context.blame);
      if (context.atSomebodyElse && actor) {
        this.awardCastDamage(actor, subject, dealt, context.elements);
      }
      return;
    }

    const restored = this.applyHealing(subject, move.amount);
    if (restored <= 0 || !actor) return;
    this.grantCasting(actor, restored, context.elements, () => SELF_SPELL_MULTIPLIER);
  }

  private boltInflicts(statuses: readonly WeaponStatus[] | undefined): readonly StatusGrant[] {
    if (!statuses?.length) return NOTHING_INFLICTED;
    return inflictedBy(
      statuses,
      statuses.map(() => this.rng.next()),
    );
  }

  private awardCastDamage(
    caster: ActorRuntime,
    victim: ActorRuntime,
    damage: number,
    elements: readonly Element[],
  ) {
    if (caster.resident) return;
    const body = this.bodyOf(caster);
    const victimRating = this.ratingOf(victim);
    if (!body || victimRating === null) return;

    this.grantCasting(caster, damage, elements, (mastery) =>
      masteryMultiplier(victimRating, body.masteries, mastery),
    );
  }

  private fireBolt(
    projectileTileId: string | undefined,
    from: ActorRuntime,
    to: ActorRuntime,
  ): number {
    if (!projectileTileId) return 0;
    const start = this.tryLocate(from);
    const end = this.tryLocate(to);
    if (!start || !end) return 0;
    return this.fireProjectile(projectileTileId, start, end, true);
  }

  private castConjure(
    actor: ActorRuntime,
    context: CastContext,
    tileId: string,
    elements: readonly Element[],
  ) {
    const def = this.tilesById[tileId];
    if (!def) return;

    const where = conjureLanding(context, tileId);
    if (!where) return;
    const at = where.at;

    const casting = this.tryLocate(actor);
    if (casting) this.turnToward(actor, casting, at);

    const placed: PlacedTile = {
      tileId: def.id,
      ...(isDirectional(def) ? { direction: DEFAULT_FACING } : {}),
      ...(isItem(def) ? { itemId: mintItemId() } : {}),
      castBy: actor.id,
      ...(elements.length ? { castElements: [...elements] } : {}),
    };
    const stack = getStack(this.map, at.x, at.y, at.z);
    const next = [...stack];
    const stackIndex = where.under ?? next.length;
    next.splice(stackIndex, 0, placed);
    this.map = replaceStack(this.map, at.x, at.y, at.z, next);
    this.noteTransition("appear", def.id, at, stackIndex);
    this.reindexCells([at]);
    this.settleBoardNow();

    const stood =
      where.under != null && actor.targetId ? this.actors.get(actor.targetId) : undefined;
    if (stood) this.statusOnArrival(stood);
  }

  statusesOf(id: string): readonly StatusInstance[] | null {
    return this.actors.get(id)?.statuses ?? null;
  }

  statusPatchesOf(id: string): { defId: string; remainingMs: number; durationMs: number }[] | null {
    const statuses = this.actors.get(id)?.statuses;
    if (!statuses) return null;
    return statuses.map(({ defId, remainingMs, durationMs }) => ({
      defId,
      remainingMs,
      durationMs,
    }));
  }

  storedHpOf(id: string): number | null {
    const actor = this.actors.get(id);
    if (!actor || actor.hp === null) return null;
    const stats = this.battlerOf(actor);
    if (!stats || actor.hp >= stats.maxHp) return null;
    return actor.hp;
  }

  private bodyOf(actor: ActorRuntime): BattlerDef | null {
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    const def = this.tilesById[loc.placed.tileId];
    const authored = def ? resolveBattler(def) : null;
    if (!authored || actor.resident) return authored;

    const memo = actor.earnedBody;
    if (memo?.authored === authored) return memo.body;

    actor.masteryXp ??= xpFromMasteries(authored.masteries);
    const body = { ...authored, masteries: masteriesFromXp(actor.masteryXp) };
    actor.earnedBody = { authored, body };
    return body;
  }

  private ratingOf(actor: ActorRuntime): number | null {
    const body = this.bodyOf(actor);
    return body ? rating(body.masteries) : null;
  }

  private hpOf(
    actor: ActorRuntime,
    stats: FightingStats | null = this.battlerOf(actor),
  ): number | null {
    if (!stats) return null;
    actor.hp ??= stats.maxHp;
    /**
     * Clamped on read rather than on write, so lowering a tile's maximum in
     * the editor cannot leave a creature standing there overfull.
     */
    return Math.min(actor.hp, stats.maxHp);
  }

  setTarget(actorId: string | null, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.targetId = actorId === actor.id ? null : actorId;
  }

  setAttackMode(enabled: boolean, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.attacking = enabled;
  }

  setPvp(enabled: boolean, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    if (!this.canSetPvp(id)) return false;
    actor.pvp = enabled;
    return true;
  }

  canSetPvp(id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    if (actor.resident) return false;
    return !inCombat(actor.statuses);
  }

  pvpOf(id: string): boolean {
    return this.actors.get(id)?.pvp ?? false;
  }

  setHidden(enabled: boolean, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor || actor.resident) return false;
    if (actor.hidden === enabled) return true;
    const loc = this.tryLocate(actor);
    if (loc) {
      this.noteTransition(enabled ? "disappear" : "appear", loc.placed.tileId, loc, loc.stackIndex);
    }
    actor.hidden = enabled;
    return true;
  }

  hiddenOf(id: string): boolean {
    return this.actors.get(id)?.hidden ?? false;
  }

  private isConcealed(id: string): boolean {
    return this.actors.get(id)?.hidden === true;
  }

  private visibleAttackers(attackers: readonly string[] | undefined): readonly string[] {
    if (!attackers) return EMPTY_ATTACKERS;
    if (!attackers.some((id) => this.isConcealed(id))) return attackers;
    return attackers.filter((id) => !this.isConcealed(id));
  }

  private combatantOf(actor: ActorRuntime): Combatant {
    return { id: actor.id, resident: actor.resident, pvp: actor.pvp };
  }

  private mayHarm(from: ActorRuntime, to: ActorRuntime): boolean {
    return mayHarm(this.combatantOf(from), this.combatantOf(to));
  }

  private actorEmitters(): ExtraEmitter[] {
    const out: ExtraEmitter[] = [];
    for (const actor of this.actors.values()) {
      const state = actor.brain?.state;
      if (state === undefined) continue;
      const emit = resolveBrain(this.defFor(actor))?.states[state]?.emit;
      if (emit) out.push({ channel: emit.channel, value: emit.value });
    }
    return out;
  }

  private emitterSignature(emitters: ExtraEmitter[]): string {
    return emitters.map((e) => `${e.channel}=${e.value}`).join(",");
  }

  private stepLeavesGround(loc: ActorLocation, direction: Direction): boolean {
    const { dx, dy } = DIR_DELTA[direction];
    const fromAbs = standingAbs(this.map, loc.x, loc.y, loc.z, loc.stackIndex, this.tilesById);
    return (
      surfacesInClimbBand(
        this.map,
        { x: loc.x, y: loc.y, abs: fromAbs },
        loc.x + dx,
        loc.y + dy,
        this.tilesById,
      ).length === 0
    );
  }

  private stepLandsInHazard(
    actor: ActorRuntime,
    loc: ActorLocation,
    direction: Direction,
  ): boolean {
    const def = this.defFor(actor);
    const check = canWalk(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      direction,
      def,
      this.tilesById,
    );
    if (!check.ok) return false;

    const landing = this.stepLandingCell(loc, direction, def, check.to);
    if (!landing) return false;
    if (unsafeToStepOn(this.map, landing, this.tilesById, this.statusDefs, actor.id)) {
      return true;
    }
    if (def.swims) return false;
    return !wadesAt(this.map, loc, this.tilesById) && wadesIn(this.map, landing, this.tilesById);
  }

  private stepLandingCell(
    loc: ActorLocation,
    direction: Direction,
    def: TileDef,
    walkedInto: Coord,
  ): Coord | null {
    if (!this.stepLeavesGround(loc, direction)) return walkedInto;
    const { dx, dy } = DIR_DELTA[direction];
    return dropLanding(
      this.map,
      loc.x + dx,
      loc.y + dy,
      standingAbs(this.map, loc.x, loc.y, loc.z, loc.stackIndex, this.tilesById),
      def,
      this.tilesById,
    );
  }

  private routeStep(
    actor: ActorRuntime,
    loc: ActorLocation,
    at: Coord,
    allowDrops: boolean | undefined,
    arrive: "beside" | "on" = "beside",
  ): Direction | "arrived" | null {
    const self = { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex };
    const def = this.defFor(actor);
    const found = findPath(
      this.map,
      { at: self, self, who: actor.id },
      at,
      def,
      this.tilesById,
      this.statusDefs,
      { drops: allowDrops ? "anywhere" : "never", arrive, avoidWade: !def.swims },
    );
    if (!found.ok) return null;
    return found.route[0]?.direction ?? "arrived";
  }

  private setWalkOrder(
    actor: ActorRuntime,
    goal: WalkGoal,
    allowDrops: boolean | undefined,
  ): WalkOrderState {
    actor.walkOrder = { goal, allowDrops, arrive: "beside" };
    if (!this.idle(actor)) return "walking";
    return this.driveWalkOrder(actor);
  }

  private driveWalkOrder(actor: ActorRuntime): WalkOrderState {
    const order = actor.walkOrder;
    if (!order) return "blocked";

    const at = this.walkGoalCell(order.goal);
    const loc = this.tryLocate(actor);
    if (!at || !loc) {
      actor.walkOrder = null;
      return "blocked";
    }

    const direction = this.routeStep(actor, loc, at, order.allowDrops, order.arrive);
    if (direction === null || direction === "arrived") {
      actor.walkOrder = null;
      return direction === "arrived" ? "arrived" : "blocked";
    }

    if (!this.applyStepRequest(actor, { directions: [direction] })) {
      actor.walkOrder = null;
      return "blocked";
    }
    return "walking";
  }

  private setFleeOrder(
    actor: ActorRuntime,
    loc: ActorLocation,
    threat: Coord,
    allowDrops: boolean | undefined,
  ): WalkOrderState {
    const here = { x: loc.x, y: loc.y, z: loc.z };
    if (!this.stillWorthRunningTo(actor.refuge, here, threat)) {
      actor.refuge = this.findRefugeFor(actor, loc, threat, allowDrops);
    }
    if (!actor.refuge) return "blocked";

    actor.walkOrder = {
      goal: { of: "cell", at: actor.refuge },
      allowDrops,
      arrive: "on",
    };
    if (!this.idle(actor)) return "walking";
    const state = this.driveWalkOrder(actor);
    if (state !== "walking") actor.refuge = null;
    return state === "arrived" ? "walking" : state;
  }

  private stillWorthRunningTo(refuge: Coord | null, here: Coord, threat: Coord): boolean {
    if (!refuge) return false;
    if (refuge.x === here.x && refuge.y === here.y && refuge.z === here.z) {
      return false;
    }
    return this.stepsApart(refuge, threat) > this.stepsApart(here, threat);
  }

  private stepsApart(a: Coord, b: Coord): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  private findRefugeFor(
    actor: ActorRuntime,
    loc: ActorLocation,
    threat: Coord,
    allowDrops: boolean | undefined,
  ): Coord | null {
    const self = { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex };
    const def = this.defFor(actor);
    const found = findRefuge(
      this.map,
      { at: self, self, who: actor.id },
      threat,
      def,
      this.tilesById,
      this.statusDefs,
      {
        drops: allowDrops ? "anywhere" : "never",
        seenFrom: (cell) => hasLineOfSight(this.map, this.tilesById, threat, cell, def.height),
        avoidWade: !def.swims,
      },
    );
    /**
     * An empty route means the body has nowhere better than where it
     * stands, on the same terms `findRefuge` uses elsewhere for arrived —
     * not a failure, so it is folded into the same null return as one.
     */
    if (!found.ok || found.route.length === 0) return null;
    return found.route[found.route.length - 1]!.to;
  }

  private walkGoalCell(goal: WalkGoal): Coord | null {
    if (goal.of === "cell") return goal.at;
    return this.isConcealed(goal.id) ? null : this.actorCell(goal.id);
  }

  private nearestOnTile(selfId: string, from: Coord, tileIds: readonly string[]): string | null {
    let best: string | null = null;
    let bestSteps = Infinity;
    for (const tileId of tileIds) {
      for (const id of this.actorsOnTile(tileId)) {
        if (id === selfId) continue;
        const actor = this.actors.get(id);
        if (!actor || actor.hidden) continue;
        const loc = this.tryLocate(actor);
        /**
         * The tile is re-checked against the board rather than taken from
         * the index. Positions are read live here — the index only says who
         * is worth asking about — so an entry that has gone stale costs a
         * lookup instead of naming the wrong body.
         */
        if (!loc || loc.placed.tileId !== tileId) continue;
        const steps = Math.abs(loc.x - from.x) + Math.abs(loc.y - from.y);
        if (steps < bestSteps) {
          bestSteps = steps;
          best = actor.id;
        }
      }
    }
    return best;
  }

  /**
   * Insertion order is inherited from `actors` and is load-bearing: two
   * bodies exactly as far away must resolve the same way on every run, or a
   * seeded world stops being reproducible.
   */
  private actorsOnTile(tileId: string): readonly string[] {
    this.tileIndex ??= this.buildTileIndex();
    return this.tileIndex.get(tileId) ?? NO_ACTORS;
  }

  private nearestThing(
    from: Coord,
    tileIds: ReadonlySet<string>,
    cells: number,
    sight: SightLevels,
  ): FoundThing | null {
    const mayHold = this.chunksHolding(from, tileIds, cells, sight);
    if (!mayHold) return null;
    for (let ring = 0; ring <= cells; ring++) {
      const found = this.thingInRing(from, tileIds, ring, sight, mayHold);
      if (found) return found;
    }
    return null;
  }

  private chunksHolding(
    from: Coord,
    tileIds: ReadonlySet<string>,
    cells: number,
    sight: SightLevels,
  ): ((x: number, y: number, z: number) => boolean) | null {
    const cx0 = chunkIndexOf(from.x - cells);
    const cy0 = chunkIndexOf(from.y - cells);
    const width = chunkIndexOf(from.x + cells) - cx0 + 1;
    const height = chunkIndexOf(from.y + cells) - cy0 + 1;
    const z0 = Math.max(MIN_LEVEL, from.z - sight.down);
    const z1 = Math.min(MAX_LEVEL, from.z + sight.up);
    if (z1 < z0) return null;
    const holds = new Uint8Array((z1 - z0 + 1) * width * height);
    let any = false;
    for (let z = z0; z <= z1; z++) {
      const level = this.map.levels[levelKey(z)];
      if (!level) continue;
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          const chunk = level[chunkKeyAt(cx0 + cx, cy0 + cy)];
          if (!chunk) continue;
          const present = tileIdsInChunk(chunk);
          for (const id of tileIds) {
            if (!present.has(id)) continue;
            holds[((z - z0) * height + cy) * width + cx] = 1;
            any = true;
            break;
          }
        }
      }
    }
    if (!any) return null;
    return (x, y, z) =>
      holds[((z - z0) * height + (chunkIndexOf(y) - cy0)) * width + (chunkIndexOf(x) - cx0)] === 1;
  }

  private thingInRing(
    from: Coord,
    tileIds: ReadonlySet<string>,
    ring: number,
    sight: SightLevels,
    mayHold: (x: number, y: number, z: number) => boolean,
  ): FoundThing | null {
    for (let dx = -ring; dx <= ring; dx++) {
      const dy = ring - Math.abs(dx);
      for (const y of dy === 0 ? [from.y] : [from.y - dy, from.y + dy]) {
        const found = this.thingInColumn(from.x + dx, y, from.z, tileIds, sight, mayHold);
        if (found) return found;
      }
    }
    return null;
  }

  private thingInColumn(
    x: number,
    y: number,
    fromZ: number,
    tileIds: ReadonlySet<string>,
    sight: SightLevels,
    mayHold: (x: number, y: number, z: number) => boolean,
  ): FoundThing | null {
    for (let dz = -sight.down; dz <= sight.up; dz++) {
      const z = fromZ + dz;
      if (z < MIN_LEVEL || z > MAX_LEVEL) continue;
      if (!mayHold(x, y, z)) continue;
      for (const placed of getStack(this.map, x, y, z)) {
        if (tileIds.has(placed.tileId)) {
          return { at: { x, y, z }, tileId: placed.tileId };
        }
      }
    }
    return null;
  }

  private extractForBrain(actor: ActorRuntime, at: Coord, tileId: string): boolean {
    const run = actor.extraction;
    if (
      run &&
      run.tileId === tileId &&
      run.ref.x === at.x &&
      run.ref.y === at.y &&
      run.ref.z === at.z
    ) {
      return true;
    }
    const stackIndex = getStack(this.map, at.x, at.y, at.z).findIndex(
      (placed) => placed.tileId === tileId,
    );
    if (stackIndex < 0) return false;
    return this.extract({ ...at, stackIndex }, actor.id);
  }

  private consumeForBrain(actor: ActorRuntime, tileId: string | undefined): boolean {
    const index = this.edibleInBag(actor, tileId);
    if (index === null) return false;
    return this.consume({ kind: "slot", slot: { kind: "contents", index } }, actor.id);
  }

  private consumeOnGround(actor: ActorRuntime, at: Coord, tileId: string): boolean {
    const stackIndex = getStack(this.map, at.x, at.y, at.z).findIndex(
      (placed) => placed.tileId === tileId,
    );
    if (stackIndex < 0) return false;
    return this.consume({ kind: "floor", ref: { ...at, stackIndex } }, actor.id);
  }

  private walkDurationOf(actor: ActorRuntime, from: ActorLocation): number {
    return walkDurationMsFor(
      this.defFor(actor),
      walkSpeedPercentFrom(actor.statuses, this.statusDefs) +
        groundWalkSpeedPercent(this.map, from, this.tilesById),
    );
  }

  private hasStatus(actor: ActorRuntime, id: string, atLeastMs: number | undefined): boolean {
    return actor.statuses.some(
      (instance) =>
        instance.defId === id && (atLeastMs === undefined || instance.remainingMs >= atLeastMs),
    );
  }

  private castForBrain(
    actor: ActorRuntime,
    position: number,
    targetId?: string | null,
  ): "cast" | "casting" | "no" {
    const stone = this.spellsOf(actor)[position - 1];
    if (stone === undefined) return "no";
    const spell = stone.name;

    const running = actor.casting?.progress.slot;
    if (running?.from === "natural" && running.name === spell) return "casting";

    if (needsTarget(stone)) {
      if (targetId === undefined && stone.effect.kind !== "conjure") return "no";
      actor.targetId = targetId ?? null;
    }
    if (!this.cast(naturalSlot(spell), actor.id)) return "no";
    return actor.casting ? "casting" : "cast";
  }

  private standOff(actor: ActorRuntime, targetId: string): StandOff | null {
    const target = this.actors.get(targetId);
    if (!target) return null;
    const from = this.tryLocate(actor);
    const to = this.tryLocate(target);
    if (!from || !to) return null;
    const reach = this.strikingReach(actor);
    if (!reach) return null;

    const fromPoint = this.reachPointOf(from);
    const toPoint = this.reachPointOf(to);
    const min = reach.min ?? 0;
    if (planDistanceSq(fromPoint, toPoint) < min * min) return "too_close";
    return canReach(this.map, this.tilesById, fromPoint, toPoint, reach)
      ? "in_position"
      : "too_far";
  }

  private strikingReach(actor: ActorRuntime): Reach | null {
    for (const hand of HANDS) {
      const weapon = weaponSwungBy(actor.equipment, this.tilesById, hand);
      if (weapon) return weapon.reach;
    }
    return this.battlerOf(actor)?.reach ?? null;
  }

  private healthShare(actor: ActorRuntime): number | null {
    const stats = this.battlerOf(actor);
    const hp = this.hpOf(actor);
    if (!stats || hp === null || stats.maxHp <= 0) return null;
    return Math.min(1, hp / stats.maxHp);
  }

  private edibleInBag(actor: ActorRuntime, tileId: string | undefined): number | null {
    const contents = actor.equipment.bag?.contents ?? [];
    for (const [index, instance] of contents.entries()) {
      if (tileId !== undefined && instance.tileId !== tileId) continue;
      const def = this.tilesById[instance.tileId];
      if (def && resolveConsumable(def)) return index;
    }
    return null;
  }

  private carryingInBag(actor: ActorRuntime, tileId: string | undefined): boolean {
    const contents = actor.equipment.bag?.contents ?? [];
    if (tileId === undefined) return contents.length > 0;
    return contents.some((instance) => instance.tileId === tileId);
  }

  private thingStillThere(at: Coord, tileId: string): boolean {
    return getStack(this.map, at.x, at.y, at.z).some((placed) => placed.tileId === tileId);
  }

  private buildTileIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const actor of this.actors.values()) {
      const loc = this.tryLocate(actor);
      if (!loc) continue;
      const on = index.get(loc.placed.tileId);
      if (on) on.push(actor.id);
      else index.set(loc.placed.tileId, [actor.id]);
    }
    return index;
  }

  private actorCell(id: string): Coord | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    return loc ? { x: loc.x, y: loc.y, z: loc.z } : null;
  }

  private idle(actor: ActorRuntime): boolean {
    return !actor.slide && !actor.walk && !actor.fall;
  }

  private readyToAct(actor: ActorRuntime): boolean {
    return this.idle(actor) && !this.incapacitated(actor);
  }

  canPush(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canPushFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  push(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const loc = this.locate(actor);
    const to = pushTargetFrom(this.map, this.tilesById, loc, ref);
    const direction = pushDirectionFrom(loc, ref);
    if (!to || !direction) return false;

    this.map = setEntityDirection(this.map, loc.x, loc.y, loc.z, loc.stackIndex, direction);

    const from = { x: ref.x, y: ref.y, z: ref.z };
    const shovedOwner = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex]?.owner;
    const count = pushedColumn(this.map, ref).length;
    const landed = getStack(this.map, to.x, to.y, to.z).length;
    this.map = moveColumn(this.map, ref, count, to, undefined);

    actor.slide = {
      object: { ...to, stackIndex: landed },
      from,
      count,
      elapsedMs: 0,
    };
    this.reindexCells([from, to]);

    const shoved = shovedOwner ? this.actors.get(shovedOwner) : undefined;
    if (shoved) this.arriveIn(shoved);
    return true;
  }

  canPickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canPickUpFrom(this.map, this.tilesById, this.locate(actor), ref, actor.equipment);
  }

  pickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const destination = pickUpDestination(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
    );
    if (!destination) return false;

    if (destination.kind === "slot") {
      const instance = this.takeFromBoard(ref);
      if (!instance) return false;
      this.setEquipment(actor, {
        ...actor.equipment,
        [destination.slot]: instance,
      });
      return true;
    }

    const bag = actor.equipment.bag;
    if (!bag) return false;

    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const taking = placed && instanceFromPlacement(placed);
    if (!taking) return false;
    const contents = stow(
      bag.contents ?? [],
      taking,
      capacityOf(bag, this.tilesById),
      this.tilesById,
    );
    if (!contents) return false;

    if (!this.takeFromBoard(ref)) return false;
    this.setEquipment(actor, { ...actor.equipment, bag: { ...bag, contents } });
    return true;
  }

  canEquip(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canEquipFrom(this.map, this.tilesById, this.locate(actor), ref, actor.equipment);
  }

  equip(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const slot = equipSlotFrom(this.map, this.tilesById, this.locate(actor), ref, actor.equipment);
    if (!slot) return false;

    const instance = this.takeFromBoard(ref);
    if (!instance) return false;

    this.setEquipment(actor, { ...actor.equipment, [slot]: instance });
    return true;
  }

  private takeFromBoard(ref: ObjectRef): ItemInstance | null {
    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const instance = placed && instanceFromPlacement(placed);
    if (!instance) return null;

    this.map = removeTileAt(this.map, ref.x, ref.y, ref.z, ref.stackIndex);
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return instance;
  }

  consume(from: ConsumeSource, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor || this.incapacitated(actor)) return false;
    if (this.hpOf(actor) === null) return false;

    const eaten =
      from.kind === "floor"
        ? this.consumeFromFloor(actor, from.ref)
        : this.consumeFromSlot(actor, from.slot);
    if (!eaten) return false;
    const { consumable } = eaten;

    this.recordConsumeSound(actor, consumable);

    const grants = consumable.statuses ?? [];
    const rolls = grants.map(() => this.rng.next());
    for (const grant of inflictedBy(grants, rolls)) {
      this.grantStatus(actor, grant, undefined, undefined, {
        source: this.statusName(grant.id),
        by: eaten.name,
      });
    }

    if (consumable.hp < 0) {
      this.applyDamage(actor, -consumable.hp, { source: eaten.name });
    } else if (consumable.hp > 0) {
      this.applyHealing(actor, consumable.hp);
    }
    return true;
  }

  private recordConsumeSound(actor: ActorRuntime, consumable: ConsumableItem) {
    if (!consumable.sound?.trim()) return;
    const loc = this.tryLocate(actor);
    if (!loc) return;
    this.recordNoise(actor.id, loc, consumable.sound);
  }

  private consumeFromFloor(actor: ActorRuntime, ref: ObjectRef): Eaten | null {
    if (!this.readyToAct(actor)) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    if (!canConsumeFrom(this.map, this.tilesById, loc, ref)) return null;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    if (!consumable || !placed || !def) return null;

    const left = peelOne(placed);
    const spent = left
      ? stack.map((held, i) => (i === ref.stackIndex ? left : held))
      : stack.filter((_, i) => i !== ref.stackIndex);
    const next = this.cellAfterLeaving(actor, ref, spent, consumable);
    if (!next) return null;
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return { consumable, name: def.name };
  }

  private cellAfterLeaving(
    actor: ActorRuntime,
    ref: ObjectRef,
    spent: PlacedTile[],
    consumable: ConsumableItem,
  ): PlacedTile[] | null {
    const residue = this.residueOf(consumable);
    if (!residue) return spent;
    const next = stackWithItem(spent, placementFromInstance(residue), this.tilesById);
    const room = canReplaceStack(this.map, ref.x, ref.y, ref.z, next, this.tilesById);
    if (room.ok) return next;
    this.say(actor.id, noRoomToLeaveNotice(this.tilesById[residue.tileId]!.name));
    return null;
  }

  private leaveBehind(
    actor: ActorRuntime,
    loc: ActorLocation,
    emptied: ItemMoveResult,
    from: SlotRef,
    consumable: ConsumableItem,
  ): ItemMoveResult | null {
    const residue = this.residueOf(consumable);
    if (!residue) return emptied;
    const landed = leaveResidue(emptied.map, this.tilesById, loc, emptied.equipment, from, residue);
    if (landed) return landed;
    this.say(actor.id, noRoomToLeaveNotice(this.tilesById[residue.tileId]!.name));
    return null;
  }

  private residueOf(consumable: ConsumableItem): ItemInstance | null {
    const tileId = consumable.leaves;
    if (!tileId || !this.tilesById[tileId]) return null;
    return { id: mintItemId(), tileId };
  }

  private consumeFromSlot(actor: ActorRuntime, slot: SlotRef): Eaten | null {
    const loc = this.tryLocate(actor);
    if (!loc) return null;

    const instance = itemInSlot(this.map, this.tilesById, loc, actor.equipment, slot);
    const def = instance && this.tilesById[instance.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    if (!consumable || !def) return null;

    const emptied = peelSlot(this.map, this.tilesById, loc, actor.equipment, slot);
    if (!emptied) return null;
    const landed = this.leaveBehind(actor, loc, emptied, slot, consumable);
    if (!landed) return null;

    this.map = landed.map;
    if (landed.equipment !== actor.equipment) {
      this.setEquipment(actor, landed.equipment);
    }
    return { consumable, name: def.name };
  }

  canMoveItem(from: SlotRef, to: SlotRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor || this.incapacitated(actor)) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    return canMoveItem(this.map, this.tilesById, loc, actor.equipment, from, to);
  }

  moveItem(from: SlotRef, to: SlotRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor || this.incapacitated(actor)) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;

    if (this.noteCoolingRefusal(actor, loc, from)) return false;
    if (isBodySlot(to) && this.noteCoolingRefusal(actor, loc, to)) return false;

    const moved = applyItemMove(this.map, this.tilesById, loc, actor.equipment, from, to);
    if (!moved) return false;

    this.map = moved.map;
    if (moved.equipment !== actor.equipment) {
      this.setEquipment(actor, moved.equipment);
    }
    return true;
  }

  canDrop(from: SlotRef, to: Coord, id: string = LOCAL_ACTOR_ID): boolean {
    return this.dropCandidate(from, to, id) != null;
  }

  private noteCoolingRefusal(actor: ActorRuntime, loc: ActorLocation, from: SlotRef): boolean {
    const instance = itemInSlot(this.map, this.tilesById, loc, actor.equipment, from);
    if (!instance || !stoneLocked(instance, this.tilesById)) return false;
    const def = this.tilesById[instance.tileId];
    this.say(actor.id, coolingNotice(instance.inscription?.trim() || def?.name || instance.tileId));
    return true;
  }

  private dropCandidate(
    from: SlotRef,
    to: Coord,
    id: string,
  ): {
    actor: ActorRuntime;
    instance: ItemInstance;
    destination: DropDestination;
  } | null {
    const actor = this.actors.get(id);
    if (!actor || this.incapacitated(actor)) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;

    const instance = itemInSlot(this.map, this.tilesById, loc, actor.equipment, from);
    if (!instance) return null;

    const def = this.tilesById[instance.tileId];
    if (!def) return null;
    if (stoneLocked(instance, this.tilesById)) return null;
    const destination = dropDestinationAt(this.map, this.tilesById, loc, to, def);
    if (!destination) return null;
    return { actor, instance, destination };
  }

  drop(from: SlotRef, to: Coord, id: string = LOCAL_ACTOR_ID): boolean {
    const thrower = this.actors.get(id);
    const at = thrower ? this.tryLocate(thrower) : null;
    if (thrower && at && this.noteCoolingRefusal(thrower, at, from)) return false;

    const candidate = this.dropCandidate(from, to, id);
    if (!candidate) return false;
    const { actor, instance, destination } = candidate;

    const emptied = clearSlot(this.map, this.tilesById, this.locate(actor), actor.equipment, from);
    if (!emptied) return false;

    const landed =
      destination.kind === "contents"
        ? stashInContainer(emptied.map, this.tilesById, destination.ref, instance)
        : appendItem(
            emptied.map,
            to.x,
            to.y,
            to.z,
            placementFromInstance(instance),
            this.tilesById,
          );
    if (!landed) return false;

    this.map = landed;
    if (emptied.equipment !== actor.equipment) {
      this.setEquipment(actor, emptied.equipment);
    }

    if (destination.kind === "contents") return true;

    this.reindexCells([to]);
    this.settleBoardNow();
    return true;
  }

  private setEquipment(actor: ActorRuntime, next: Equipment) {
    actor.equipment = next;
    actor.carriedLights = carriedLightTileIds(next, this.tilesById);
    this.decay.armEquipment(next, this.tilesById);
    this.equipmentChanged.add(actor.id);
  }

  drainEquipmentChanges(): string[] {
    if (this.equipmentChanged.size === 0) return [];
    const changed = [...this.equipmentChanged];
    this.equipmentChanged.clear();
    return changed;
  }

  drainTagChanges(): string[] {
    if (this.tagsChanged.size === 0) return [];
    const changed = [...this.tagsChanged];
    this.tagsChanged.clear();
    return changed;
  }

  drainExtractionChanges(): string[] {
    if (this.extractionChanged.size === 0) return [];
    const changed = [...this.extractionChanged];
    this.extractionChanged.clear();
    return changed;
  }

  drainMasteryChanges(): string[] {
    if (this.masteriesChanged.size === 0) return [];
    const changed = [...this.masteriesChanged];
    this.masteriesChanged.clear();
    return changed;
  }

  drainStatusChanges(): string[] {
    if (this.statusesChanged.size === 0) return [];
    const changed = [...this.statusesChanged];
    this.statusesChanged.clear();
    return changed;
  }

  drainClockSet(): MinutesOfDay | null {
    const minutes = this.pendingClockSet;
    this.pendingClockSet = null;
    return minutes;
  }

  canTakeReward(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canRewardFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
      actor.tags,
    );
  }

  takeReward(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const loc = this.locate(actor);
    const reward = reachableRewardAt(this.map, this.tilesById, loc, ref);
    if (!reward) return false;
    if (actor.tags.includes(reward.tag)) return false;
    if (!rewardFits(reward, this.tilesById, actor.equipment)) return false;

    const giverDef = this.tilesById[getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex].tileId];
    if (!giverDef) return false;

    const bag = actor.equipment.bag!;
    const given = reward.itemTileIds.map((tileId) => ({
      id: mintItemId(),
      tileId,
    }));
    this.setEquipment(actor, {
      ...actor.equipment,
      bag: { ...bag, contents: [...(bag.contents ?? []), ...given] },
    });
    this.setTags(actor, [...actor.tags, reward.tag]);
    this.say(actor.id, rewardNotice(reward, giverDef, this.tilesById));
    return true;
  }

  canCraft(ref: ObjectRef, recipe: number, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canCraftFrom(this.map, this.tilesById, this.locate(actor), actor.equipment, ref, recipe);
  }

  craft(ref: ObjectRef, recipe: number, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const at = this.locate(actor);
    const chosen = craftableRecipe(this.map, this.tilesById, at, actor.equipment, ref, recipe);
    if (!chosen) return false;

    const random = () => this.rng.next();
    const result = runCraft(this.tilesById, actor.equipment, chosen.recipe, random, mintItemId);
    if (!result) return false;

    this.setEquipment(actor, result.equipment);
    const crafterTileId = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex]?.tileId;
    const crafterDef = crafterTileId ? this.tilesById[crafterTileId] : undefined;
    if (crafterDef) {
      this.say(actor.id, craftNotice(chosen.craft, crafterDef, result.made, this.tilesById));
    }
    return true;
  }

  canExtract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canBeginExtract(
      this.map,
      this.tilesById,
      this.locate(actor),
      actor.equipment,
      ref,
      actor.extraction?.progress ?? null,
    );
  }

  extract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.canExtract(ref, id)) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    if (!placed) return false;
    const def = this.tilesById[placed.tileId];
    const extract = def && resolveExtract(def);
    if (!def || !extract) return false;

    const at = this.actorCell(actor.id);
    if (!at) return false;

    this.cancelExtraction(actor);
    this.cancelCasting(actor);

    const run: ExtractionRun = {
      ref,
      tileId: placed.tileId,
      from: at,
      progress: {
        key: extractKey(ref, placed.tileId),
        remainingMs: extract.durationMs,
        durationMs: extract.durationMs,
      },
    };

    if (extract.durationMs <= 0) return this.finishExtraction(actor, run);

    this.reserve(run);
    this.setExtraction(actor, run);
    return true;
  }

  private reserve(run: ExtractionRun) {
    const { ref } = run;
    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const next = stack.map((current, i) =>
      i === ref.stackIndex ? withReservation(current, 1) : current,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
  }

  private finishExtraction(actor: ActorRuntime, run: ExtractionRun): boolean {
    const stack = getStack(this.map, run.ref.x, run.ref.y, run.ref.z);
    const placed = stack[run.ref.stackIndex];
    if (!placed || placed.tileId !== run.tileId) return false;
    const def = this.tilesById[placed.tileId];
    const extract = def && resolveExtract(def);
    if (!def || !extract) return false;

    const yielded = rollExtract(extract, () => this.rng.next());
    if (!this.spendPull(run.ref, stack, placed, extract)) return false;
    if (yielded.length > 0) this.giveExtracted(actor, yielded);
    if (actor.extraction === run) this.setExtraction(actor, null);

    this.say(actor.id, extractNotice(extract, def, yielded, this.tilesById));
    return true;
  }

  private spendPull(
    ref: ObjectRef,
    stack: readonly PlacedTile[],
    placed: PlacedTile,
    extract: ExtractInteraction,
  ): boolean {
    const after = placementAfterPull(placed, extract);
    if (!after && extract.tileId && !this.tilesById[extract.tileId]) return false;

    const next: PlacedTile[] = [];
    for (let i = 0; i < stack.length; i++) {
      const current = stack[i]!;
      if (i !== ref.stackIndex) {
        next.push(current);
        continue;
      }
      if (after) {
        next.push(after);
        continue;
      }
      if (!extract.tileId) continue;
      const { extractsLeft: _spent, ...rest } = withoutReservations(current);
      next.push({ ...rest, tileId: extract.tileId });
    }

    if (!canReplaceStack(this.map, ref.x, ref.y, ref.z, next, this.tilesById).ok) {
      return false;
    }
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  private giveExtracted(actor: ActorRuntime, tileIds: readonly string[]) {
    const bag = actor.equipment.bag;
    if (!bag) return;
    const contents = stowExtracted(bag, tileIds, this.tilesById, mintItemId);
    if (!contents) return;
    this.setEquipment(actor, {
      ...actor.equipment,
      bag: { ...bag, contents },
    });
  }

  runCommand(raw: string, id: string = LOCAL_ACTOR_ID) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      this.say(id, commandRefusalNotice(parsed.refusal));
      return;
    }

    const refusal = this.runParsedCommand(parsed.command, id);
    if (refusal) this.say(id, commandRefusalNotice(refusal));
  }

  refuseCommand(id: string = LOCAL_ACTOR_ID) {
    this.say(id, commandRefusalNotice({ kind: "notAdmin" }));
  }

  private runParsedCommand(command: Command, id: string): CommandRefusal | null {
    switch (command.name) {
      case MASTERY_COMMAND:
        return this.runMasteryCommand(command, id);
      case TILE_COMMAND:
        return this.runTileCommand(command, id);
      case STATUS_COMMAND:
        return this.runStatusCommand(command, id);
      case HEALTH_COMMAND:
        return this.runHealthCommand(command, id);
      case GOTO_COMMAND:
        return this.runGotoCommand(command, id);
      case MOVE_COMMAND:
        return this.runMoveCommand(command, id);
      case TIME_COMMAND:
        return this.runTimeCommand(command, id);
    }
  }

  private runTimeCommand(command: TimeCommand, id: string): null {
    this.pendingClockSet = command.minutes;
    this.say(id, timeNotice(command.minutes));
    return null;
  }

  private canStandIn(actor: ActorRuntime, to: Coord): boolean {
    const def = this.defFor(actor);
    const surface = listStandingSurfaces(this.map, to.x, to.y, this.tilesById).find(
      (candidate) => candidate.z === to.z,
    );
    if (!surface) return false;
    return fitsAtElevation(this.map, to.x, to.y, surface.abs, def, this.tilesById).ok;
  }

  private runGotoCommand(
    command: Extract<Command, { name: typeof GOTO_COMMAND }>,
    id: string,
  ): CommandRefusal | null {
    const actor = this.actors.get(id);
    const loc = actor ? this.tryLocate(actor) : null;
    if (!actor || !loc) return { kind: "nowhereToPlace" };

    return this.putBodyAt(actor, loc, {
      x: command.at.x,
      y: command.at.y,
      z: command.at.z ?? loc.z,
    });
  }

  private runMoveCommand(
    command: Extract<Command, { name: typeof MOVE_COMMAND }>,
    id: string,
  ): CommandRefusal | null {
    const actor = this.actors.get(id);
    const loc = actor ? this.tryLocate(actor) : null;
    if (!actor || !loc) return { kind: "nowhereToPlace" };

    return this.putBodyAt(actor, loc, {
      x: loc.x + command.by.x,
      y: loc.y + command.by.y,
      z: loc.z + command.by.z,
    });
  }

  private putBodyAt(actor: ActorRuntime, loc: ActorLocation, to: Coord): CommandRefusal | null {
    if (to.x === loc.x && to.y === loc.y && to.z === loc.z) return null;
    if (!this.canStandIn(actor, to)) return { kind: "noRoom", at: to };

    this.moveThrough(actor, to);
    this.statusOnArrival(actor);
    this.settleBoardNow();
    return null;
  }

  private runMasteryCommand(command: MasteryCommand, id: string): CommandRefusal | null {
    const { mastery, level, target } = command;
    const targetId = target ?? id;
    const actor = this.actors.get(targetId);
    if (!actor) return { kind: "noSuchTarget", typed: targetId };

    if (!this.setMastery(actor, mastery, level)) {
      return {
        kind: "unteachableTarget",
        name: this.bodyName(targetId) ?? targetId,
      };
    }

    this.say(actor.id, masteryNotice(mastery, level));
    if (actor.id !== id) {
      this.say(id, otherMasteryNotice(this.bodyName(actor.id) ?? actor.id, mastery, level));
    }
    return null;
  }

  private runTileCommand(command: TileCommand, id: string): CommandRefusal | null {
    const actor = this.actors.get(id);
    const from = actor ? this.tryLocate(actor) : null;
    if (!from) return { kind: "nowhereToPlace" };

    const def = this.tilesById[command.tileId];
    if (!def) return { kind: "unknownTile", typed: command.tileId };
    if (def.id === PLAYER_TILE_ID) {
      return { kind: "spawnMarkerTile", typed: command.tileId };
    }

    const at = resolveCell(command.at, from);
    const underfoot = at.x === from.x && at.y === from.y && at.z === from.z;

    let candidate = this.map;
    const owners: string[] = [];
    let formed: number[] = [];
    for (let placement = 0; placement < command.count; placement++) {
      if (!canPlace(candidate, at.x, at.y, at.z, def, this.tilesById).ok) {
        return { kind: "noRoom", at };
      }

      const stack = getStack(candidate, at.x, at.y, at.z);
      const stackIndex = underfoot ? from.stackIndex : stack.length;
      const placed: PlacedTile = {
        tileId: def.id,
        ...(isDirectional(def) ? { direction: DEFAULT_FACING } : {}),
        ...(isItem(def) ? { itemId: mintItemId() } : {}),
        ...(resolveActor(def)
          ? { owner: this.summonedOwnerId({ ...at, stackIndex }, new Set(owners)) }
          : {}),
      };

      const poured = pourInto(stack, placed, this.tilesById);
      const next = poured ?? [...stack];
      if (!poured) {
        next.splice(stackIndex, 0, placed);
        formed = slotsAfterInsert(formed, stackIndex);
      }
      candidate = replaceStack(candidate, at.x, at.y, at.z, next);

      if (placed.owner) owners.push(placed.owner);
    }

    this.map = candidate;
    const summoned = getStack(this.map, at.x, at.y, at.z);
    for (const owner of owners) {
      const stackIndex = summoned.findIndex((placed) => placed.owner === owner);
      this.addResident(owner, def.id, { ...at, stackIndex });
    }
    for (const stackIndex of formed) {
      this.noteTransition("appear", def.id, at, stackIndex);
    }
    this.reindexCells([at]);
    this.settleBoardNow();
    this.say(id, tileNotice(def.name, at, command.count));
    return null;
  }

  private summonedOwnerId(
    at: Coord & { stackIndex: number },
    alsoTaken: ReadonlySet<string> = new Set(),
  ): string {
    const home = residentOwnerId(at);
    return this.actors.has(home) || alsoTaken.has(home) ? `${home},${crypto.randomUUID()}` : home;
  }

  private runStatusCommand(command: StatusCommand, authorId: string): CommandRefusal | null {
    const targetId = command.target ?? authorId;
    const actor = this.actors.get(targetId);
    if (!actor) return { kind: "noSuchTarget", typed: targetId };

    const { statusId } = command;
    if (statusId === null) {
      actor.statuses = [];
      this.noteStatusReading(actor);
      this.say(authorId, statusesClearedNotice());
      return null;
    }

    const def = this.statusDefs[statusId];
    if (!def) {
      return {
        kind: "unknownStatus",
        typed: statusId,
        known: Object.keys(this.statusDefs),
      };
    }

    const outcome = this.grantStatus(actor, { id: def.id });
    if (outcome === "refused") {
      return {
        kind: "immuneTarget",
        name: this.bodyName(targetId) ?? targetId,
        status: def.name,
      };
    }
    if (targetId !== authorId) {
      this.say(authorId, otherStatusNotice(this.bodyName(targetId) ?? targetId, def.name));
    } else if (outcome === "refreshed") {
      this.say(authorId, statusAcquiredNotice(def.name));
    }
    return null;
  }

  private runHealthCommand(command: HealthCommand, authorId: string): CommandRefusal | null {
    const targetId = command.target ?? authorId;
    const actor = this.actors.get(targetId);
    if (!actor) return { kind: "noSuchTarget", typed: targetId };

    const change = command.health;
    const stats = this.battlerOf(actor);
    const before = this.hpOf(actor);
    if (!stats || before === null) {
      return {
        kind: "unharmableTarget",
        name: this.bodyName(actor.id) ?? actor.id,
      };
    }

    const target =
      change.kind === "set"
        ? Math.min(stats.maxHp, Math.max(0, change.hp))
        : Math.min(stats.maxHp, Math.max(0, before + change.by));
    const delta = target - before;

    if (delta < 0) {
      this.applyDamage(actor, -delta);
    } else if (delta > 0) {
      this.applyHealing(actor, delta);
    }

    this.say(authorId, healthNotice(this.hpOf(actor) ?? 0, stats.maxHp));
    return null;
  }

  private setMastery(actor: ActorRuntime, mastery: Mastery, level: number): boolean {
    this.bodyOf(actor);
    const xp = actor.masteryXp;
    if (!xp) return false;

    actor.masteryXp = { ...xp, [mastery]: xpForLevel(level) };
    actor.earnedBody = null;
    this.masteriesChanged.add(actor.id);
    return true;
  }

  private say(actorId: string, text: string) {
    if (this.actors.get(actorId)?.resident) return;
    this.pendingNotices.push({ actorId, text });
  }

  drainNotices(id: string = LOCAL_ACTOR_ID): string[] {
    if (this.pendingNotices.length === 0) return [];
    const mine: string[] = [];
    for (let i = this.pendingNotices.length - 1; i >= 0; i--) {
      if (this.pendingNotices[i].actorId !== id) continue;
      mine.unshift(this.pendingNotices[i].text);
      this.pendingNotices.splice(i, 1);
    }
    return mine;
  }

  private setTags(actor: ActorRuntime, next: readonly string[]) {
    actor.tags = next;
    this.tagsChanged.add(actor.id);
  }

  canSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canSwitchFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  activateSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    if (!this.canSwitch(ref, id)) return false;
    const loc = this.locate(this.actor(id));
    const def = interactiveDefAt(this.map, this.tilesById, loc, ref);
    const sw = def && resolveSwitch(def);
    if (!def || !sw) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const next = stack.map((placed, i) =>
      i === ref.stackIndex ? { ...placed, tileId: sw.targetTileId } : placed,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  canTeleport(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    return canTeleportFrom(this.map, this.tilesById, this.locate(actor), ref, this.defFor(actor));
  }

  activateTeleport(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;

    const loc = this.locate(actor);
    const teleport = reachableTeleportAt(this.map, this.tilesById, loc, ref);
    if (!teleport) return false;
    const def = this.defFor(actor);
    if (!teleportFits(this.map, this.tilesById, def, teleport.to)) return false;

    this.moveThrough(actor, teleport.to);
    return true;
  }

  canAddStatus(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (this.hpOf(actor) === null) return false;
    return canAddStatusFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  activateAddStatus(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (this.hpOf(actor) === null) return false;

    const loc = this.locate(actor);
    const addStatus = reachableAddStatusAt(this.map, this.tilesById, loc, ref);
    if (!addStatus) return false;

    this.grantStatus(actor, { id: addStatus.statusId });
    return true;
  }

  canRemoveStatus(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (this.hpOf(actor) === null) return false;
    return canRemoveStatusFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  activateRemoveStatus(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (this.hpOf(actor) === null) return false;

    const loc = this.locate(actor);
    const removeStatus = reachableRemoveStatusAt(this.map, this.tilesById, loc, ref);
    if (!removeStatus) return false;

    this.clearStatus(actor, removeStatus.statusId);
    return true;
  }

  canSetSpawn(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (actor.resident) return false;
    return canSetSpawnFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  activateSetSpawn(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.readyToAct(actor)) return false;
    if (actor.resident) return false;

    const loc = this.locate(actor);
    if (!reachableSetSpawnAt(this.map, this.tilesById, loc, ref)) return false;

    if (!this.markSpawn(actor, ref)) {
      this.say(actor.id, spawnMarkUnchangedNotice());
    }
    return true;
  }

  private markSpawn(actor: ActorRuntime, at: Coord): boolean {
    const cell = { x: at.x, y: at.y, z: at.z };
    const mark = actor.spawnMark;
    if (mark && mark.x === cell.x && mark.y === cell.y && mark.z === cell.z) {
      return false;
    }
    actor.spawnMark = cell;
    this.pendingSpawnMarks.push({ actorId: actor.id, at: cell });
    this.say(actor.id, spawnMarkNotice());
    return true;
  }

  private spawnMarkOnArrival(actor: ActorRuntime) {
    if (actor.resident) return;

    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);

    for (let i = stack.length - 1; i >= 0; i--) {
      if (i >= loc.stackIndex) continue;
      const placed = stack[i]!;
      const def = this.tilesById[placed.tileId];
      const setSpawn = def ? resolveSetSpawn(def) : null;
      if (!setSpawn || setSpawn.trigger !== "step") continue;
      this.markSpawn(actor, { x: loc.x, y: loc.y, z: loc.z });
      return;
    }
  }

  private statusOnArrival(actor: ActorRuntime) {
    actor.standingStatusMs = 0;
    this.clearStandingStatus(actor);
    this.grantStandingStatus(actor);
  }

  private clearStandingStatus(actor: ActorRuntime) {
    if (actor.statuses.length === 0) return;

    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);

    for (let i = 0; i < loc.stackIndex && i < stack.length; i++) {
      const def = this.tilesById[stack[i]!.tileId];
      const removeStatus = def ? resolveRemoveStatus(def) : null;
      if (!removeStatus || removeStatus.trigger !== "step") continue;
      this.clearStatus(actor, removeStatus.statusId);
    }
  }

  private grantStandingStatus(actor: ActorRuntime) {
    if (this.hpOf(actor) === null) return;

    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);

    for (let i = stack.length - 1; i >= 0; i--) {
      if (i >= loc.stackIndex) continue;
      const placed = stack[i]!;
      const def = this.tilesById[placed.tileId];
      const addStatus = def ? resolveAddStatus(def) : null;
      if (!addStatus || addStatus.trigger !== "step") continue;
      const status = this.statusDefs[addStatus.statusId];
      const spared = sparesStander(placed, status, actor.id, (castBy) => {
        const caster = this.actors.get(castBy);
        return caster ? this.mayHarm(caster, actor) : true;
      });
      if (spared) continue;
      this.grantStatus(actor, { id: addStatus.statusId }, placed.castBy, placed.castElements, {
        source: this.statusName(addStatus.statusId),
        by: conjuredName(def?.name ?? placed.tileId, placed, (id) => this.bodyName(id)),
      });
      return;
    }
  }

  private tickStandingStatuses(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.fall) continue;
      actor.standingStatusMs += tickMs;
      const stoodMs = actor.standingStatusMs + COOLDOWN_EPSILON_MS;
      if (stoodMs < STANDING_STATUS_EVERY_MS) continue;
      actor.standingStatusMs -= STANDING_STATUS_EVERY_MS;
      this.clearStandingStatus(actor);
      this.grantStandingStatus(actor);
    }
  }

  private moveThrough(actor: ActorRuntime, to: Coord) {
    const loc = this.locate(actor);
    this.forgetWalk(actor);
    actor.walk = null;
    actor.fall = null;
    actor.slide = null;

    this.map = moveEntity(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      to,
      undefined,
      this.tilesById,
    );
    this.reindexCells([{ x: loc.x, y: loc.y, z: loc.z }, to]);
    this.pendingTeleports.push(actor.id);
  }

  private teleportOnArrival(actor: ActorRuntime) {
    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    const def = this.defFor(actor);

    for (let i = stack.length - 1; i >= 0; i--) {
      if (i >= loc.stackIndex) continue;
      const placed = stack[i]!;
      const teleport = resolveTeleport(placed, this.tilesById[placed.tileId], loc);
      if (!teleport || teleport.trigger !== "step") continue;
      if (!teleportFits(this.map, this.tilesById, def, teleport.to)) return;
      this.moveThrough(actor, teleport.to);
      return;
    }
  }

  interact(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const acted =
      this.takeReward(ref, id) ||
      this.activateTeleport(ref, id) ||
      this.activateSwitch(ref, id) ||
      this.activateAddStatus(ref, id) ||
      this.activateRemoveStatus(ref, id) ||
      this.activateSetSpawn(ref, id) ||
      this.extract(ref, id) ||
      this.equip(ref, id) ||
      this.pickUp(ref, id) ||
      this.push(ref, id);
    if (acted) this.settleBoardNow();
    return acted;
  }

  canInteract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    return (
      this.canTakeReward(ref, id) ||
      this.canTeleport(ref, id) ||
      this.canSwitch(ref, id) ||
      this.canAddStatus(ref, id) ||
      this.canRemoveStatus(ref, id) ||
      this.canSetSpawn(ref, id) ||
      this.canExtract(ref, id) ||
      this.canEquip(ref, id) ||
      this.canPickUp(ref, id) ||
      this.canPush(ref, id)
    );
  }

  private tickSlide(actor: ActorRuntime, tickMs: number) {
    if (!actor.slide) return;
    actor.slide.elapsedMs += tickMs;
    if (actor.slide.elapsedMs >= PUSH_STEP_MS) actor.slide = null;
  }

  private tickMotion(actor: ActorRuntime, tickMs: number) {
    const from = this.locate(actor);
    this.advanceMotion(actor, tickMs);
    if (actor.fall) return;

    const to = this.locate(actor);
    if (to.x === from.x && to.y === from.y && to.z === from.z) return;
    this.arriveIn(actor);
  }

  private arriveIn(actor: ActorRuntime) {
    this.statusOnArrival(actor);
    this.spawnMarkOnArrival(actor);
    this.teleportOnArrival(actor);
  }

  private advanceMotion(actor: ActorRuntime, tickMs: number) {
    if (actor.fall) {
      this.tickFall(actor, tickMs);
      return;
    }

    if (actor.walk) {
      actor.walk.elapsedMs += tickMs;
      if (actor.walk.elapsedMs >= actor.walk.durationMs) {
        this.commitWalk(actor);
      } else {
        return;
      }
    }

    this.maybeStartFall(actor);
    if (actor.fall) return;

    this.maybeStartWalk(actor);
  }

  private actorSnapshot(actor: ActorRuntime): ActorSnapshot {
    const loc = this.locate(actor);
    const visualExtra = this.accumulatorMs;
    const hpUnset = actor.hp == null;
    const stats = this.battlerOf(actor);
    return {
      id: actor.id,
      name: actor.name,
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: actor.walk,
      fall: actor.fall,
      walkProgress: actor.walk
        ? Math.min(1, (actor.walk.elapsedMs + visualExtra) / actor.walk.durationMs)
        : 0,
      /**
       * Unclamped, unlike the walk above: a fall is a run of height units
       * rather than one lerp, and the tick that commits a unit lands after
       * the unit's time is up, so a value past 1 is exactly what the next
       * step will confirm. Clamping here froze the sprite for a tick at
       * every boundary and then made it lurch.
       */
      fallProgress: actor.fall ? (actor.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT : 0,
      slide: actor.slide,
      slideProgress: actor.slide
        ? Math.min(1, (actor.slide.elapsedMs + visualExtra) / PUSH_STEP_MS)
        : 0,
      strike: actor.strike,
      strikeProgress: actor.strike
        ? Math.min(1, (actor.strike.elapsedMs + visualExtra) / STRIKE_DURATION_MS)
        : 0,
      hp: this.hpOf(actor, stats),
      maxHp: (hpUnset ? this.battlerOf(actor) : stats)?.maxHp ?? null,
      rating: this.ratingOf(actor),
      statuses: actor.statuses,
      carriedLights: actor.carriedLights,
      extracting: actor.extraction?.progress ?? null,
      casting: actor.casting?.progress ?? null,
      pvp: actor.pvp,
      hidden: actor.hidden,
    };
  }

  actorSnapshots(): ActorSnapshot[] {
    return [...this.actors.values()].map((a) => this.actorSnapshot(a));
  }

  actorSnapshotsWhere(keep: (id: string, at: Coord) => boolean): ActorSnapshot[] {
    const out: ActorSnapshot[] = [];
    for (const actor of this.actors.values()) {
      const loc = this.tryLocate(actor);
      if (loc && keep(actor.id, loc)) out.push(this.actorSnapshot(actor));
    }
    return out;
  }

  afflictedPlacements(): AfflictedPlacement[] {
    return this.endure.afflictedPlacements();
  }

  getSnapshot(id: string = LOCAL_ACTOR_ID): GameSnapshot {
    const self = this.actor(id);
    const actors = this.actorSnapshots();
    const mine = actors.find((a) => a.id === self.id)!;
    return {
      map: this.map,
      self: mine,
      actors,
      targetId: self.targetId,
      attacking: self.attacking,
      equipment: self.equipment,
      tags: self.tags,
      spawnAt: self.spawnMark,
      conversation: self.conversation,
      extracting: this.extractionOf(self.id),
      nextBlow: this.nextBlowOf(self.id),
      masteryXp: self.masteryXp ?? {},
      attributes: this.attributesOf(self),
      pvp: { on: self.pvp, changeable: this.canSetPvp(self.id) },
      chats: [],
      noises: this.liveNoise,
      afflicted: this.afflictedPlacements(),
      damage: this.liveDamage,
      projectiles: this.liveProjectiles,
      flightEffects: this.liveFlightEffects,
    };
  }

  isAtRest(): boolean {
    if (this.pendingHeard.length > 0) return false;
    if (this.pendingHurt.size > 0) return false;
    if (this.pendingSound.length > 0) return false;
    if (this.brainRound) return false;
    if (this.decay.pending()) return false;
    if (this.endure.pending()) return false;
    if (this.liveProjectiles.length > 0) return false;
    if (this.liveFlightEffects.length > 0) return false;
    if (this.blowsInFlight.length > 0) return false;
    if (this.anyStoneCooling()) return false;

    let observed = false;
    let thinking = false;
    for (const actor of this.actors.values()) {
      if (actor.walk || actor.fall || actor.slide || actor.strike) return false;
      if (actor.attackRecoveryMs > 0) return false;
      if (actor.extraction) return false;
      if (actor.casting) return false;
      if (actor.input.directions.length > 0) return false;
      if (actor.attacking && actor.targetId !== null) return false;
      if (!actor.resident && inCombat(actor.statuses)) return false;

      if (!actor.resident) {
        observed = true;
      } else if (!thinking) {
        thinking = this.thinks(actor);
      }
    }

    if (observed && thinking) return false;

    return this.map === this.settledMap;
  }

  private anyStoneCooling(): boolean {
    for (const actor of this.actors.values()) {
      for (const square of CAST_SQUARES) {
        if (actor.equipment[square]?.cooldownMs) return true;
      }
      for (const name in actor.spellCooldownMs) {
        if (actor.spellCooldownMs[name]) return true;
      }
    }
    return false;
  }

  private thinks(actor: ActorRuntime): boolean {
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    const def = this.tilesById[loc.placed.tileId];
    return def != null && resolveBrain(def) !== null;
  }

  getMap(): MapFile {
    return this.map;
  }

  private defFor(actor: ActorRuntime): TileDef {
    const { placed } = this.locate(actor);
    const def = this.tilesById[placed.tileId];
    if (!def) throw new Error(`Missing tile def "${placed.tileId}"`);
    return def;
  }

  private commitWalk(actor: ActorRuntime) {
    const w = actor.walk;
    if (!w) return;
    const loc = this.locate(actor);
    this.map = moveEntity(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      w.to,
      w.direction,
      this.tilesById,
    );
    this.forgetWalk(actor);
    actor.walk = null;
  }

  private destinationTaken(cell: Coord, except: ActorRuntime): boolean {
    const walkers = this.walkingInto.get(walkKey(cell));
    if (walkers === undefined) return false;
    const throughPlayers = this.defFor(except).id === PLAYER_TILE_ID;
    for (const other of walkers) {
      if (other === except) continue;
      const to = other.walk?.to;
      if (!to || to.x !== cell.x || to.y !== cell.y || to.z !== cell.z) continue;
      if (this.actors.get(other.id) !== other) continue;
      if (throughPlayers && isPlayerBody(this.locate(other).placed)) continue;
      return true;
    }
    return false;
  }

  private forgetWalk(actor: ActorRuntime) {
    const to = actor.walk?.to;
    if (!to) return;
    const key = walkKey(to);
    const walkers = this.walkingInto.get(key);
    if (walkers === undefined) return;
    const at = walkers.indexOf(actor);
    if (at >= 0) walkers.splice(at, 1);
    if (walkers.length === 0) this.walkingInto.delete(key);
  }

  private maybeStartWalk(actor: ActorRuntime) {
    this.applyStepRequest(actor, actor.input);
    if (actor.walk || !actor.walkOrder || !actor.brainAttentive) return;
    this.driveWalkOrder(actor);
  }

  private applyStepRequest(actor: ActorRuntime, request: StepRequest): boolean {
    if (request.directions.length === 0) return false;
    if (this.incapacitated(actor)) return false;
    const loc = this.locate(actor);
    const choice = chooseStep(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      request,
      this.defFor(actor),
      this.tilesById,
      (to) => this.destinationTaken(to, actor),
    );
    if (!choice) return false;

    if (actor.attackRecoveryMs > 0) return false;

    this.turnActor(actor, loc, choice.facing);

    if (!choice.step) return false;
    if (actor.casting) return false;

    this.forgetWalk(actor);
    actor.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs: 0,
      durationMs: this.walkDurationOf(actor, loc),
    };
    const key = walkKey(choice.step.to);
    const walkers = this.walkingInto.get(key);
    if (walkers === undefined) this.walkingInto.set(key, [actor]);
    else walkers.push(actor);
    return true;
  }

  requestStep(
    id: string,
    direction: Direction,
    opts?: { preferDescend?: boolean },
  ): "started" | "later" | "refused" {
    const actor = this.actor(id);
    if (actor.fall || actor.slide) return "refused";
    if (actor.walk) return "later";
    if (actor.attackRecoveryMs > 0) return "later";

    const started = this.applyStepRequest(actor, {
      directions: [direction],
      preferDescend: opts?.preferDescend,
    });
    return started ? "started" : "refused";
  }

  faceActor(id: string, direction: Direction) {
    const actor = this.actor(id);
    if (actor.attackRecoveryMs > 0) return;
    if (this.incapacitated(actor)) return;
    this.turnActor(actor, this.locate(actor), direction);
  }

  private turnToward(actor: ActorRuntime, from: ActorLocation, to: Coord) {
    const facing = facingToward(from, to);
    if (facing) this.turnActor(actor, from, facing);
  }

  private turnActor(actor: ActorRuntime, loc: ActorLocation, direction: Direction) {
    if (actor.walk) actor.walk.direction = direction;
    this.map = setEntityDirection(this.map, loc.x, loc.y, loc.z, loc.stackIndex, direction);
  }

  private maybeStartFall(actor: ActorRuntime) {
    const loc = this.locate(actor);
    const pull = gravityPullOn(this.map, loc, this.defFor(actor), this.tilesById);
    if (pull.kind === "stand") return;
    if (pull.kind === "settle") {
      this.land(actor, pull.landingAbs);
      return;
    }
    actor.fall = {
      feetAbs: pull.feetAbs,
      landingAbs: pull.landingAbs,
      elapsedMs: 0,
    };
  }

  private tickFall(actor: ActorRuntime, tickMs: number) {
    if (!actor.fall) return;
    actor.fall.elapsedMs += tickMs;

    while (actor.fall && actor.fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
      actor.fall.elapsedMs -= FALL_MS_PER_HEIGHT;
      this.stepFallOneHeight(actor);
    }
  }

  private stepFallOneHeight(actor: ActorRuntime) {
    if (!actor.fall) return;

    const nextFeet = actor.fall.feetAbs - 1;
    if (nextFeet <= actor.fall.landingAbs) {
      this.land(actor, actor.fall.landingAbs);
      return;
    }

    actor.fall.feetAbs = nextFeet;
    this.relocateActorToFeet(actor, nextFeet);
  }

  private land(actor: ActorRuntime, landingAbs: number) {
    actor.fall = null;
    this.commitLandAt(actor, landingAbs);
  }

  private commitLandAt(actor: ActorRuntime, landingAbs: number) {
    const loc = this.locate(actor);
    const { z: targetZ } = cellForFeetAbs(landingAbs);
    const placed = { ...loc.placed };

    const next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    for (const zTry of [targetZ, targetZ - 1, loc.z]) {
      if (zTry < MIN_LEVEL) continue;
      const stack = getStack(next, loc.x, loc.y, zTry);
      if (stack.length === 0) continue;
      const top = absoluteStandingElevation(zTry, stack, this.tilesById);
      if (top === landingAbs) {
        this.map = placeEntityOnSurface(next, loc.x, loc.y, zTry, placed, this.tilesById);
        return;
      }
    }

    this.map = appendTile(next, loc.x, loc.y, targetZ, placed);
  }

  private relocateActorToFeet(actor: ActorRuntime, feetAbs: number) {
    const loc = this.locate(actor);
    const { z: newZ } = cellForFeetAbs(feetAbs);
    if (newZ === loc.z) return;

    const placed = { ...loc.placed };
    let next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    const destStack = getStack(next, loc.x, loc.y, newZ);
    const destTop = absoluteStandingElevation(newZ, destStack, this.tilesById);
    if (destStack.length > 0 && destTop === feetAbs) {
      next = placeEntityOnSurface(next, loc.x, loc.y, newZ, placed, this.tilesById);
    } else {
      next = appendTile(next, loc.x, loc.y, newZ, placed);
    }
    this.map = next;
  }
}

function slotsAfterInsert(slots: readonly number[], at: number): number[] {
  return [...slots.map((slot) => (slot >= at ? slot + 1 : slot)), at];
}

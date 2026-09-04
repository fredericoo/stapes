import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isPlayerBody,
  isWalkableSurfaceAt,
  removeTileAt,
  replaceStack,
} from "../lib/mapData";
import type { ExtractInteraction } from "../lib/interactions";
import {
  resolveAddStatus,
  resolveExtract,
  resolveSwitch,
  resolveTeleport,
} from "../lib/interactions";
import {
  type ArcaneStoneItem,
  type ConsumableItem,
  isItem,
  isRanged,
  NO_ELEMENTS,
  type ProjectileDef,
  type StatusGrant,
  type StoneEffect,
  type WeaponStatus,
  resolveConsumable,
  resolveStone,
} from "../lib/item";
import {
  appendItem,
  countOf,
  peelOne,
  pourInto,
  stackWithItem,
  stow,
  withCount,
} from "../lib/piles";
import type {
  Coord,
  Direction,
  MapFile,
  PlacedTile,
  TileDef,
} from "../lib/types";
import { MIN_LEVEL, isDirectional, resolveActor } from "../lib/types";
import {
  canPlace,
  canReplaceStack,
  tilesByIdFromList,
} from "../lib/validation";
import {
  actorDirection,
  adoptAuthoredPlayer,
  adoptBodyAt,
  DEFAULT_FACING,
  listResidentBodies,
  residentHome,
  residentOwnerId,
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
  canConsumeFrom,
  canEquipFrom,
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
  reachableRewardAt,
  reachableTeleportAt,
  rewardFits,
  teleportFits,
  pushDirectionFrom,
  pushTargetFrom,
  type DropDestination,
  type ObjectRef,
} from "./affordances";
import {
  commandRefusalNotice,
  extractNotice,
  masteryNotice,
  otherMasteryNotice,
  healthNotice,
  noRoomToLeaveNotice,
  rewardNotice,
  statusesClearedNotice,
  statusGrantedNotice,
  tileNotice,
} from "./notices";
import { leaveResidue } from "./residue";
import {
  HEALTH_COMMAND,
  MASTERY_COMMAND,
  parseCommand,
  resolveCell,
  STATUS_COMMAND,
  TILE_COMMAND,
  type Command,
  type CommandRefusal,
  type HealthCommand,
  type MasteryCommand,
  type StatusCommand,
  type TileCommand,
} from "./commands";
import { findEntryCell } from "./entry";
import {
  BRAIN_TICK_MS,
  DAMAGE_NUMBER_LIFETIME_MS,
  FALL_MS_PER_HEIGHT,
  NOISE_LIFETIME_MS,
  MAX_CLIMB_HEIGHT,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  STRIKE_DURATION_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import {
  type BattlerDef,
  DEFAULT_BATTLER,
  resolveBattler,
  type FightingStats,
  spellPower,
} from "../lib/battler";
import {
  experienceMultiplier,
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
  canReach,
  damageAfterDefence,
  damageFraction,
  inflictedBy,
  rollAttack,
  underPressure,
} from "./combat";
import type { Equipment, Hand } from "./equipment";
import {
  bodyElements,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  HANDS,
  handToSwing,
  otherHand,
  stoneIn,
  stoneLocked,
  weaponInHand,
  wornInstances,
} from "./equipment";
import {
  automaticFires,
  CAST_SQUARES,
  castability,
  castableStones,
  type CastContext,
  type CastPoint,
  type CastSquare,
  coolingNotice,
  type SpellButton,
} from "./casting";
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
import {
  dodgeAway,
  outranksSwing,
  swingToward,
  type StrikeState,
} from "./strike";
import type { ReachPoint } from "./distance";
import {
  flightDurationMs,
  type ProjectileFlight,
} from "./projectile";
import { pushedColumn } from "./push";
import {
  isSpawnFilled,
  type RespawnOutcome,
  type SpawnPoint,
} from "./respawn";
import {
  applyItemMove,
  canMoveItem,
  capacityOf,
  clearSlot,
  itemInSlot,
  peelSlot,
  stashInContainer,
  type ItemMoveResult,
  type SlotRef,
} from "./itemMoves";
import type { ItemInstance } from "../lib/itemInstance";
import {
  instanceFromPlacement,
  mintItemId,
  placementFromInstance,
} from "../lib/itemInstance";
import {
  cellForFeetAbs,
  cellHasLooseGravity,
  findLandingAbs,
  findLooseGravityCells,
  findWalkableLandingAbs,
  isSupported,
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
  destCellAfterStep,
  DIR_DELTA,
  resolveWalkDurationMs,
  standingAbs,
  surfacesInClimbBand,
} from "./movement";
import { findPath } from "./pathfinding";
import { resolveBrain } from "../lib/brain";
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
  type Sound,
  type Utterance,
} from "./brainRuntime";
import type { ConsumeSource } from "./itemUse";
import { canTransmuteFrom, planTransmute, runTransmute } from "./transmute";
import type { CoolingResources, ExtractCooling } from "./extract";
import {
  canWorkNow,
  extractKey,
  placementAfterPull,
  rollExtract,
  stowExtracted,
} from "./extract";
import { hasLineOfSight } from "./sight";
import { Rng } from "./rng";
import { chooseStep, type StepRequest } from "./stepping";
import {
  cellHasPlate,
  cellKey,
  findPlateCells,
  settlePlates,
} from "./pressurePlates";
import {
  cellIsWired,
  findWiredCells,
  settleSignals,
  type ExtraEmitter,
} from "./signals";
import type { ItemDecay, PlacementDecay } from "./decay";
import {
  DecayIndex,
  applyDecay,
  applyItemDecay,
  findDecayCells,
} from "./decay";
import type { StatusDef } from "../lib/status";
import {
  advanceStatuses,
  applyStatus,
  NO_STATUSES,
  type StatusInstance,
  statusReading,
  withStatusModifiers,
} from "./statuses";
import { sanitizeChatText } from "../net/chat";

export type { ObjectRef } from "./affordances";

export type WalkState = {
  from: Coord;
  to: Coord;
  direction: Direction;
  elapsedMs: number;
  /**
   * How long this particular step takes — the walker's own pace, not a shared
   * constant. Carried on the motion rather than looked up while it runs, so a
   * step keeps the speed it began at even if the body under it is swapped.
   */
  durationMs: number;
};

export type FallState = {
  feetAbs: number;
  landingAbs: number;
  elapsedMs: number;
};

export type GameInput = {
  /** Held movement directions; latest pressed wins when several are held. */
  directions: Direction[];
  /** Shift: update facing only, do not walk. */
  faceOnly?: boolean;
  /** Option/Alt: prefer lowest surface in climb band. */
  preferDescend?: boolean;
};

/**
 * A pushed object whose sprite is still catching up to where it already is.
 *
 * Deliberately without its progress, which travels beside it as
 * {@link ActorSnapshot.slideProgress}. A snapshot carrying its own progress has
 * to be a fresh object every tick, and the game server announces motion by
 * *identity* — so a rebuilt one reads as a brand new slide every tick, and the
 * client restarts its lerp on each of the six announcements one push produced.
 * Walking and falling hand over their live state for exactly this reason; this
 * is the same discipline, learned late.
 */
export type SlideSnapshot = {
  /**
   * The lowest of the shoved placements, at its committed cell — the move is
   * already in the map.
   */
  object: ObjectRef;
  from: Coord;
  /**
   * How many placements are travelling, {@link object} included.
   *
   * A shove takes the column above the object with it, and the riders sit
   * directly on top of it at the destination — so the whole group is
   * `object.stackIndex` through `object.stackIndex + count - 1`, and a count is
   * all it takes to name them. Sent rather than re-derived because the client
   * cannot tell which of the tiles now stacked at that cell arrived with this
   * shove and which were already there.
   */
  count: number;
};

/**
 * Where an actor is, small enough to keep.
 *
 * Deliberately not an {@link ActorSnapshot}: this is what survives a
 * disconnection, so it holds only what is still true when nobody is driving —
 * a cell and a facing, no motion and no stack index. The index would be a lie
 * the moment anything else is placed in that cell.
 */
export type ActorPosition = Coord & { direction: Direction };

/** One actor as a viewer sees it. */
export type ActorSnapshot = {
  id: string;
  /**
   * The tile this actor's body is. Carried because an actor is no longer
   * necessarily a person: chrome meant for players — a name over the head,
   * above all — has to be able to tell a visitor from a deer, and the body is
   * the honest way to ask.
   */
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
  /**
   * The lean of a blow this body is part-way through, or null for the usual
   * case of a body not swinging at anything. @see `./strike`
   */
  strike: StrikeState | null;
  strikeProgress: number;
  /**
   * Hit points right now, or null for a body with none — a crate, a sign, a
   * creature nobody has given stats to.
   *
   * Null rather than zero for "not a battler", because zero is a real and very
   * different answer: it means dead, and a body that hits zero is off the board
   * on the same tick. Anything drawing a health bar keys off the null.
   */
  hp: number | null;
  /**
   * What is running on this body. Empty for almost everybody almost always.
   *
   * On the snapshot rather than only on the runtime because the viewer's own
   * chrome reads it off here, exactly as the kit and the ⭐ are read — and by
   * reference, since the list is replaced wholesale rather than mutated.
   */
  statuses: readonly StatusInstance[];
  /** What {@link hp} is measured against; null exactly when `hp` is. */
  maxHp: number | null;
  /**
   * How good at fighting this body is — its ⭐ — or null exactly when `hp` is.
   *
   * **Broadcast, unlike everything else about a body's competence.** What a
   * player is carrying is theirs alone because nobody else's frame can show it;
   * a ⭐ is the opposite — sizing something up before swinging at it is the whole
   * point of the number, and a rat whose difficulty you can only discover by
   * losing to it is a rat nobody can make a decision about.
   *
   * The same figure the reward curve divides by. Two numbers here would be a
   * player shown one game and playing another.
   */
  rating: number | null;
  /**
   * The tiles of the lit things this actor is carrying.
   *
   * The one part of a kit everybody can see, and therefore the one part that is
   * broadcast: a torch in your bag lights the room for the people in it. The
   * rest of what you are carrying is yours alone — see {@link GameSnapshot.equipment}.
   *
   * Tile ids rather than resolved lights, because every client already holds the
   * catalogue. Empty for almost everybody, which is the case the renderer is
   * built around.
   */
  carriedLights: string[];
};

/**
 * A number floating off somebody who was just hit.
 *
 * Kept alive with its own clock rather than fired and forgotten, for the same
 * reason a chat bubble is: it has to outlive the tick that produced it, and
 * often outlives the body it came off — a killing blow deletes its target
 * immediately, and the number is the only thing left saying what happened.
 *
 * Which is why the cell travels rather than the actor id alone. By the time this
 * is drawn there may be nobody by that name to ask where they were standing.
 */
/**
 * A noise something made, and where it was made.
 *
 * **Not speech, and deliberately not shaped like it.** A noise carries no
 * speaker and no body: nothing here can name who made it, because naming is the
 * thing that would turn "crunch" into "Amethyst Piranha says: crunch". A snake's
 * hiss and a bitten apple are the same kind of event — a sound the room heard —
 * and neither is a sentence anybody uttered.
 *
 * Pinned to a cell like a bubble, and aged like a damage number: it is a thing
 * that happened at a place, not a thing a body is carrying around.
 */
export type NoiseEmission = {
  /** Distinct per noise, so two in one tick are two labels. */
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  /** Where the maker stood in that cell's stack, so it starts at them. */
  stackIndex: number;
  elapsedMs: number;
};

/**
 * What a swing came to, as the thing floating off the body says it.
 *
 * **A dodge is not in here, and used to be.** It was a third word, and the three
 * were genuinely three different facts — but a dodge is the only one of them
 * that the body it happened to can *act out*, and it now does: the defender hops
 * half a tile out of the way. See `./strike`. A word as well would be the same
 * event told twice, and the weaker telling would be the one drawing the eye
 * away from the bodies.
 *
 * A miss keeps its word for the reason it never had a movement: it is the
 * *attacker* failing, the defender did nothing, and there is no body whose
 * motion could say so.
 */
export type SwingOutcome = "hit" | "miss";

/**
 * The same two, as values.
 *
 * A union alone cannot be validated at a boundary, and the wire is a boundary —
 * see `../net/protocol`, where the schema forgetting this field made every blow
 * online draw nothing.
 */
export const SWING_OUTCOMES: SwingOutcome[] = ["hit", "miss"];

/**
 * A receipt floating off whatever was just swung at.
 *
 * Named for the case it started as and now carries all three: this is the
 * channel for "something happened to this body on this tick", and a miss is
 * exactly that even though nothing came off. Keeping one channel is what makes
 * the three read as one language on screen; a second mechanism for the two
 * bloodless outcomes would drift in placement and lifetime from the numbers they
 * are meant to sit beside.
 */
export type DamageNumber = {
  /** Distinct per blow, so two hits on one tick are two numbers. */
  id: string;
  /** Who took it. Compared against the viewer's own id to colour the number. */
  targetId: string;
  outcome: SwingOutcome;
  /** Zero for anything but a hit, where the word carries the meaning instead. */
  amount: number;
  x: number;
  y: number;
  z: number;
  /** Where the target stood in that cell's stack, so the number starts at them. */
  stackIndex: number;
  elapsedMs: number;
};

/**
 * Something somebody said, and where it is hanging.
 *
 * Pinned to a cell rather than to its author: the coordinate is the one it was
 * said in, and it stays there while the speaker walks away or disconnects.
 */
export type ChatBubble = {
  /** Distinct per message, so two lines from one actor are two bubbles. */
  id: string;
  actorId: string;
  /**
   * The body the speaker was in when they said it, which is what decides how
   * they are named: a person by the handle derived from their id, a creature by
   * what its tile is called.
   *
   * Carried on the bubble rather than looked up when it is drawn, because the
   * bubble outlives its author — the deer that yelped can wander off, and the
   * editor can replace the map underneath it, and the words are still hanging
   * there for the rest of their five seconds.
   */
  tileId: string;
  text: string;
  x: number;
  y: number;
  z: number;
  /**
   * Where the speaker stood in that cell's stack. Carried so the bubble can
   * hang over the ground *beneath* them rather than over their own head.
   */
  stackIndex: number;
};

export type GameSnapshot = {
  map: MapFile;
  /**
   * How much of the map this snapshot's owner holds, when that is not all of it.
   *
   * A local session holds the whole board and leaves this absent; a client
   * scoped to what it can reach sets it, so the light bake stops reading the
   * empty space past its boundary as open sky. @see `../net/interest`
   */
  knownRegion?: { x0: number; y0: number; x1: number; y1: number };
  /**
   * The viewer's own actor. Camera and roof-cut follow this one and only this
   * one — they are affordances for whoever is looking, not properties of the
   * board.
   */
  self: ActorSnapshot;
  /** Every actor on the board, self included, in stable id order. */
  actors: ActorSnapshot[];
  /**
   * Who the viewer has picked a fight with, or null.
   *
   * The viewer's own, and that is the point: a target is an affordance for
   * whoever is looking, not a property of the board. It is
   * what the auto-attack swings at *while {@link attacking}*, and it survives
   * until they clear it, walk out of sight of it, or it dies.
   */
  targetId: string | null;
  /**
   * Whether the viewer is in attack mode — see {@link ActorRuntime.attacking}.
   *
   * Read off the session rather than held by the page that flips it, because the
   * outline colour in the world and the state of the button are two readings of
   * one fact, and a fight that carried on after the button said otherwise would
   * be the client and the server disagreeing about something the player can see.
   */
  attacking: boolean;
  /**
   * Damage still floating, oldest first.
   *
   * Present in every session, unlike {@link chats}: a blow landing is something
   * the local simulation very much does have to say, and `/play` shows numbers
   * exactly as the online client does.
   */
  damage: DamageNumber[];
  /**
   * Arrows still in the air, oldest first.
   *
   * Beside {@link damage} rather than inside it, and the split is the same one
   * the whole protocol is built on: a number is what a blow *came to* and an
   * arrow is what it *looked like*. They are not one event told twice — a melee
   * blow floats a number and no arrow, and a shot that killed its target floats
   * a number over a body that is no longer there while the arrow carries on to
   * where it used to be.
   *
   * Present in every session, on exactly the terms {@link damage} is: a bow
   * fired in `/play` puts an arrow in the air with nobody to broadcast it to.
   */
  projectiles: ProjectileFlight[];
  /**
   * What the viewer is carrying.
   *
   * The viewer's own, like {@link targetId}, and for a stronger reason than it:
   * nobody else's inventory is drawn. There is no
   * paperdoll — a sword changes no sprite — so broadcasting everyone's kit to
   * everyone would be paying fan-out for something no frame can show.
   *
   * The day a carried torch lights the room, that is *not* what changes this:
   * light needs a per-actor projection of the equipment
   * (`carriedLightTileIds`), not the equipment itself.
   */
  equipment: Equipment;
  /**
   * What the viewer has been marked with — see {@link RewardInteraction.tag}.
   *
   * Theirs alone, on exactly the terms {@link equipment} is: a tag decides what
   * *this* player is still owed, and nobody else's chest rows are drawn.
   *
   * Replaced wholesale rather than appended to, so identity is the change
   * signal — the same contract the kit has, and what lets the renderer gate the
   * interaction list on it without walking the list.
   */
  tags: readonly string[];
  /**
   * Where the viewer is in a conversation, or null when no panel is open.
   *
   * Theirs alone, on exactly the terms {@link tags} is, and replaced wholesale
   * so identity is the change signal. @see ./dialogRuntime
   */
  conversation: Conversation | null;
  /**
   * Which resources the viewer may not work just yet — see `./extract`'s
   * `extractKey`, which is how each one is named.
   *
   * Theirs alone on exactly the terms {@link tags} is, and the pairing with the
   * shared half is the whole of what makes a resource a resource: how much is
   * left in a bush is on the board where everybody sees it, and how long *you*
   * must wait before pulling at it again is here.
   *
   * Each entry carries how much of the wait is left *and* how long the whole
   * wait is, which is what lets a row draw the bar under it rather than merely
   * go quiet. See `./extract`'s {@link ExtractCooling}.
   *
   * Replaced wholesale when the *set* changes and wound in place in between, so
   * identity is the change signal — the same contract the kit and the tags
   * have, and what lets the renderer gate the interaction list on it without
   * walking the list or rebuilding it every tick.
   */
  extractCooling: readonly ExtractCooling[];
  /**
   * What the viewer has learnt, as raw experience.
   *
   * Theirs alone on exactly the terms {@link equipment} is — what you are good
   * at is yours, the same as what is in your bag — and beside it rather than on
   * {@link self} for that reason: {@link ActorSnapshot} is what everybody sees
   * of everybody, and only the ⭐ belongs there.
   *
   * The experience rather than the levels, because the levels are derivable from
   * it and the part-way-there is not — see `../lib/mastery`'s
   * `progressToNextLevel`.
   */
  masteryXp: MasteryXp;
  /**
   * Speech still on screen, on this viewer's level only.
   *
   * Always present rather than optional so the renderer's contract stays total;
   * the local simulation has nobody to talk to and returns an empty list.
   */
  chats: ChatBubble[];
  /**
   * Noises still hanging in the air, on this viewer's level only.
   *
   * Unlike {@link chats} this *is* filled in by the local simulation: a noise
   * needs no second person to have made it, so a single-player world hears
   * every hiss and crunch in it. @see NoiseEmission
   */
  noises: NoiseEmission[];
};

/**
 * What a player needs to know about their own body, in numbers.
 *
 * A projection of {@link ActorSnapshot} rather than the thing itself, because
 * what a stats panel wants is the three readings and not a position on a board.
 * Null on every field for a body with no stats at all, which is the same answer
 * `hp` has always given.
 */
export type Vitals = {
  hp: number | null;
  maxHp: number | null;
  rating: number | null;
  /**
   * What is running on this body, in the order the session holds it.
   *
   * Here rather than on its own callback because it answers the same question
   * the other three do — *what state is my body in* — and because the panel and
   * the strip that draw it are the two things already reading this. The instances
   * only; joining them to the catalogue is `../lib/status`'s `activeStatuses`,
   * and it happens in the route that has the catalogue.
   */
  statuses: readonly StatusInstance[];
};

/** The id the single local actor takes when nobody names one. */
export const LOCAL_ACTOR_ID = "local";

/**
 * Shared empty list for the overwhelmingly common "nobody hit me" answer, so
 * asking costs a map lookup rather than an allocation per creature per tick.
 */
const EMPTY_ATTACKERS: readonly string[] = [];

/**
 * Shared empty list for the overwhelmingly common silent tick, on the same terms
 * {@link EMPTY_ATTACKERS} is shared: a world where nothing made a sound should
 * not allocate one array per creature to say so.
 */
const EMPTY_SOUNDS: readonly Sound[] = [];

/**
 * Shared empty list for everybody who has taken no reward yet — which is every
 * creature in the world for ever, and every player until the first chest.
 *
 * Shared safely because the array is never appended to: taking a reward replaces
 * it, on the same terms a kit is replaced, so there is no way for one actor's
 * tag to appear on another.
 */
const NO_TAGS: readonly string[] = [];

/** Shared empty answer for the great majority of actors, who owe no waits. */
const NO_COOLING: CoolingResources = { get: () => undefined };

/**
 * The same emptiness as a list, for the snapshot.
 *
 * A second constant rather than one derived from the other, because the
 * *identity* is the point: every actor who owes nothing shares this one array,
 * so a snapshot from a quiet frame is the same answer as the one before it and
 * nothing downstream rebuilds.
 */
const NO_COOLING_LIST: readonly ExtractCooling[] = [];

/** Shared empty list for a tile nobody in the world is standing on. */
const NO_ACTORS: readonly string[] = [];

/**
 * Everything in a round of sounds that this body could have heard — which is
 * everything but its own.
 *
 * Excluding itself here rather than in the brain, for the reason
 * `nearestOnTile` excludes itself there: the runtime has no notion of which body
 * it is running, and giving it one to solve this would widen the narrowest
 * interface in the simulation. It is also the rule that keeps a state which
 * howls on entry from howling forever at itself.
 */
function soundsHeardBy(
  sounds: readonly Sound[],
  actorId: string,
): readonly Sound[] {
  if (sounds.length === 0) return EMPTY_SOUNDS;
  return sounds.filter((sound) => sound.sourceId !== actorId);
}

/**
 * Which way to turn to face a neighbouring cell.
 *
 * The dominant axis wins, so a diagonal foe is faced along whichever side of the
 * square is longer — and a tie, which is every true diagonal, resolves
 * north/south. Null only when the two are in the same cell, which nothing solid
 * can be.
 */
function facingToward(from: Coord, to: Coord): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

/**
 * What the renderer needs from whatever is driving it.
 *
 * {@link GameSession} implements this by simulating locally; the online client
 * implements it by applying patches from the server and interpolating between
 * them. The renderer draws a snapshot and reports a pointer either way — it has
 * no stake in where the truth came from, which is the whole reason this is an
 * interface rather than a concrete class.
 *
 * The methods without an actor argument are the viewer's own: there is exactly
 * one pointer and one camera per client.
 */
export interface PlaySession {
  update(dtMs: number): void;
  getSnapshot(): GameSnapshot;
  getMap(): MapFile;
  /**
   * Point at somebody, or at nobody with null.
   *
   * The client decides *who*, because choosing a target is pointing at something
   * on a screen; this side decides *whether and how often* a blow lands, because
   * that is the board's business and a client cannot be trusted with its own
   * attack speed. A target on its own is only a target — see
   * {@link setAttackMode}.
   */
  setTarget(actorId: string | null): void;
  /** Swing at the target, or merely keep it. @see GameSnapshot.attacking */
  setAttackMode(enabled: boolean): void;
  /**
   * Every arcane stone this body could press, in square order, with why each
   * can or cannot be cast right now.
   *
   * On the interface rather than on the snapshot, and the reason is the same one
   * that keeps `drainNotices` off it: a snapshot is what the *board* looks like,
   * and this is a question about a body's kit, its target and the levels it has
   * earned — three things only whichever end owns the session can put together.
   * Both ends answer it with the same pure function, so the buttons a browser
   * draws and the casts a server honours cannot disagree. @see ./casting
   *
   * Empty for the overwhelming majority of bodies, which is what makes the row
   * of buttons absent rather than empty for anybody who has never picked a stone
   * up.
   */
  spells(): SpellButton[];
  /**
   * Cast the stone in this square, or refuse.
   *
   * **The square, never an id**, on the same grounds every other slot reference
   * in this game names a square: a client naming an instance would be naming
   * something the far end has to go looking for. Server-authoritative with no
   * prediction, exactly as attacking is — a browser says "cast the stone in my
   * off hand" and is told what came of it by the equipment message that follows.
   *
   * False for every refusal and no reason with it, on `moveItem`'s terms: the
   * client asked {@link spells} before it offered the button, so a cast arriving
   * that cannot be honoured is a race or a client making things up.
   */
  cast(square: CastSquare): boolean;
  canInteract(ref: ObjectRef): boolean;
  interact(ref: ObjectRef): boolean;
  /**
   * Take the thing at this slot — into your bag, or into a free hand.
   *
   * On the interface rather than left to {@link interact}, because the list
   * offers pick-up as its own row and a row that named one action and ran
   * whatever `interact` happened to choose would be lying about what a tap
   * does.
   */
  pickUp(ref: ObjectRef): boolean;
  /**
   * Put the thing at this slot on — into the hand or the back it belongs in.
   *
   * A separate verb from {@link pickUp} rather than a destination inside it,
   * because the list says "Wield" and means it. It is also the row that works
   * with no bag at all.
   */
  equip(ref: ObjectRef): boolean;
  /**
   * Eat or drink a consumable, from a slot in your kit or off the floor.
   *
   * On the interface for the reason {@link pickUp} is: both the inventory tap
   * and the "Eat" row name the act, and a row that named one action and ran
   * whatever `interact` happened to choose would be lying about what a tap
   * does.
   */
  consume(from: ConsumeSource): boolean;
  /**
   * Spend one carried thing at a transmuter, and take back what it makes.
   *
   * On the interface for the reason {@link pickUp} is, and one step further: a
   * transmuter may offer several recipes on one placement, so there is no `ref`
   * a bare {@link interact} could disambiguate. The index is the position in
   * the tile's authored list — see `./transmute`.
   */
  transmute(ref: ObjectRef, recipe: number): boolean;
  /**
   * Talk to a body, press one of its buttons, go back, or close the panel.
   *
   * On the interface because a conversation is a per-viewer fact the panel
   * drives, and the two implementations differ only in where the buttons are
   * answered: the local session decides, the remote one asks and is told by
   * the `conversation` message that follows. @see ./dialogRuntime
   */
  talk(action: TalkAction): boolean;
  /**
   * Take one pull out of a resource — mine a crystal, pick a bush.
   *
   * **Not on the interface**, unlike {@link pickUp} and {@link transmute}, and
   * the omission is the design: a resource is reached by a plain tap, so
   * {@link interact} routes it and there is no second entry point that could
   * disagree with the precedence about what a tap does. A transmuter needs its
   * own verb because one placement offers several recipes and a `ref` cannot say
   * which; a bush offers exactly one thing, which is the bush.
   */
  /**
   * Would this move be honoured right now?
   *
   * Asked by whatever is drawing the drag, so a slot lights up only where the
   * thing would actually land. Same function the move itself runs, which is what
   * stops the interface offering something a drop would refuse.
   */
  canMoveItem(from: SlotRef, to: SlotRef): boolean;
  /** Move a carried thing from one slot to another. @see canMoveItem */
  moveItem(from: SlotRef, to: SlotRef): boolean;
  /**
   * Would this thing land on this cell?
   *
   * Asked once per pointer move while a drag is over the world, so the ghost
   * under the cursor is drawn only where the drop would be honoured — the same
   * rule the server re-runs, which is what stops the ghost promising something a
   * release would refuse.
   */
  canDrop(from: SlotRef, to: Coord): boolean;
  /** Put a carried thing down on the board. @see canDrop */
  drop(from: SlotRef, to: Coord): boolean;
  /**
   * Sentences the game has for the viewer, taken away as they are read.
   *
   * A drain rather than state, because a notice is an *event*: it happened once,
   * it is said once, and nothing on either side has any use for it afterwards.
   * The two implementations differ only in where the sentence was composed — the
   * local session writes its own, and the remote one repeats what the server
   * addressed to it. @see ../render/notifications
   *
   * Deliberately not on the snapshot beside `damage`. A snapshot describes the
   * board and may be taken freely; this empties something, and a getter that
   * emptied a queue would lose a line to anybody who looked twice.
   */
  drainNotices(): string[];
}

/**
 * The tail of a push. The object lands in the map the instant it is shoved, so
 * everything that queries the board — walking into the cell it vacated above
 * all — sees the truth immediately; this is the animation catching up. Holding
 * the commit back would not remove the halfway state, only hide it from the
 * map, where every collision check is looking.
 */
type SlideState = {
  /** The lowest of the shoved placements, at its new home. */
  object: ObjectRef;
  from: Coord;
  /** How many placements travelled. @see SlideSnapshot.count */
  count: number;
  elapsedMs: number;
};

/**
 * Everything that belongs to one actor rather than to the board.
 *
 * The board's own state — the map, plate and wire indexes, what has settled —
 * stays on the session: a plate does not care which actor stepped on it.
 */
type ActorRuntime = {
  readonly id: string;
  /**
   * Lives in the map rather than on a socket, so nothing outside will ever
   * drive it. Recorded when the actor is created because that is the only
   * moment the distinction is free — after that it would mean asking the board
   * what kind of body this is, once per creature per tick.
   */
  readonly resident: boolean;
  /**
   * What this actor is wearing and carrying. See `./equipment`.
   *
   * On the runtime rather than on the placement, on exactly the terms {@link hp}
   * is: a placement field would broadcast itself through cell patches, and every
   * equip would dirty the light chunks and level geometry around the player for
   * a change nothing in the world can see.
   *
   * Unlike `hp` and `brain` this is *not* something a fresh runtime can rebuild
   * from the tile — it is the only state here that a world owes continuity for,
   * because what somebody is carrying came from somewhere.
   */
  equipment: Equipment;
  /**
   * The tiles of the lit things in that kit, kept in step with it.
   *
   * Derived, and cached here rather than computed where it is read, because it
   * is read *every frame per actor* and changes only when somebody equips
   * something. Walking a bag looking for lanterns sixty times a second to find
   * the same empty list would be the whole cost of a feature almost nobody is
   * using at any moment.
   *
   * The one rule: it is written only beside {@link GameSession.setEquipment}, so
   * there is no way to change a kit without this following.
   */
  carriedLights: string[];
  /**
   * What this actor has been marked with by the rewards they have taken.
   *
   * Beside {@link equipment} rather than folded into it, and the pairing is the
   * point: they are the two halves of what a reward does — the items go in the
   * bag, the tag goes here — and the one thing that must never happen is one
   * landing without the other. Both are written in the same call and made
   * durable in the same storage batch for that reason.
   *
   * The other state a world genuinely owes continuity for. Hit points and brains
   * are rebuilt from the tile on every load; a tag cannot be, because what it
   * records is that something already happened.
   *
   * Read-only and replaced wholesale, so a snapshot holding the previous array
   * cannot be quietly rewritten under whoever is drawing from it.
   */
  tags: readonly string[];
  /**
   * What this actor has earned towards each mastery, or null for a body that
   * does not earn.
   *
   * **The third thing a world genuinely owes continuity for**, beside
   * {@link equipment} and {@link tags} and written in the same storage batch.
   * Hit points and brains are rebuilt from the tile on every load; experience
   * cannot be, because what it records is that something already happened.
   *
   * Null on a {@link resident} for ever: a rat does not get better at biting,
   * and a creature's masteries are read straight off the tile. Null on a player
   * only until somebody first asks — the numbers are seeded from the authored
   * block the moment there is a body to read one from, on exactly the terms
   * {@link hp} is filled in. See {@link GameSession.bodyOf}.
   *
   * Replaced wholesale rather than mutated, on exactly the terms
   * {@link equipment} and {@link tags} are: the block goes out on the snapshot,
   * and identity is what tells whoever is drawing it that something moved. A
   * block edited in place would be the same object on every frame and a bar that
   * never advanced. One small allocation per landed blow is the price, and it is
   * paid on a tick that is already broadcasting a damage number.
   */
  masteryXp: MasteryXp | null;
  /**
   * How long this actor must wait before working each resource again, by
   * `./extract`'s `extractKey`.
   *
   * **The per-player half of an extract, and the reason a shared resource paces
   * right.** The pulls left in a bush are the world's and live on the placement;
   * this is one person's opinion of that same bush, so somebody walking up
   * behind them finds it full.
   *
   * **Not durable**, like {@link hp} and unlike {@link tags} — and the line
   * between those two is exactly the one this falls on. A tag records that
   * something *happened* and can never be rebuilt; a wait records that something
   * happened *recently*, and a world that has been unloaded long enough to lose
   * it has been unloaded for longer than any cooldown worth authoring. Coming
   * back to find a bush ready is the right failure.
   *
   * Null until this actor first works something, so the great majority of
   * actors — every deer in the world — never allocate one. Entries are struck
   * off as they expire rather than left at zero, because the map's *size* is
   * what {@link GameSession.extractCoolingOf} reports and a spent entry would be
   * a row hidden for ever.
   */
  extractCooldowns: Map<string, ExtractCooling> | null;
  /**
   * The same entries as a list, for the snapshot and the wire.
   *
   * **The very same objects**, not copies: winding a wait mutates the entry both
   * of these hold, so a tick costs no allocation and leaves this array's
   * identity alone. That identity is what tells the renderer its interaction
   * rows are stale — a fresh array per tick would rebuild the whole list thirty
   * times a second for a set that changes twice a pull — and it is the same
   * hand-over-by-reference a `walk` or a `strike` already travels on.
   *
   * The one rule, {@link carriedLights}': written only beside
   * {@link extractCooldowns}, in {@link GameSession.setExtractCooldowns}, so
   * there is no way to change one without the other following.
   */
  extractCooling: readonly ExtractCooling[];
  /**
   * The authored body with this actor's earned masteries in it, keyed on the
   * authored block it was built from.
   *
   * The same staleness discipline as {@link memo}: `resolveBattler` memoises on
   * def identity, so holding the block this was derived from is an exact check.
   * Dropped whenever experience is granted, which is the only other thing that
   * can move it.
   *
   * Worth memoising because {@link GameSession.battlerOf} is asked once per body
   * per swing *and* once per body per frame by whatever draws health bars, and
   * reading seven levels out of seven square roots at that rate is a cost with
   * nothing to show for it.
   */
  earnedBody: { authored: BattlerDef; body: BattlerDef } | null;
  /**
   * Whose turn it is, when this body has a weapon in each hand.
   *
   * **The whole of ambidexterity's state, and it is one word.** A body with two
   * weapons alternates between them, so something has to remember which one is
   * next; everything else about the rotation is a pure function of what is being
   * held — see `./equipment`'s {@link handToSwing}, which honours this only if
   * that hand still has something to swing.
   *
   * That fallback is what keeps this a hand rather than a history. Dropping the
   * sword you were about to use swings the other one; picking a second one up
   * joins the rotation wherever it happens to be; a body with one weapon swings
   * it every turn whatever this says. So nothing that moves an item has to reach
   * in and correct it, which is the failure mode a counter or an index would
   * have had — one that could be left pointing at an empty fist.
   *
   * **Not durable**, like {@link hp} and {@link brain} rather than like the kit
   * itself: which fist somebody was about to use is the state of a fight, and a
   * fight does not survive the world being unloaded. Coming back mid-rotation on
   * the other hand costs one blow of a weapon you were going to swing anyway.
   * It never crosses the wire either — the client is *told* its cooldown rather
   * than working it out, so there is no prediction here to keep in step.
   */
  nextHand: Hand;
  /**
   * How many defensive payouts each attacker has already been worth, and how
   * long since the last one.
   *
   * **Not durable, and deliberately so** — it is rebuilt like {@link hp} and
   * {@link brain} rather than owed continuity. What it records is the state of a
   * fight, and a fight does not survive the world being unloaded.
   *
   * Null until this body is first hit by anything, so the great majority of
   * actors never allocate one.
   */
  defensiveDecay: Map<string, { payouts: number; idleMs: number }> | null;
  /**
   * Who is currently swinging at this body, and how long each of them has left
   * before they stop counting.
   *
   * The whole of "how outnumbered am I" — `../game/combat`'s `underPressure`
   * reads nothing but the size of this. **Kept per defender rather than derived
   * on demand**, because the honest question is who is *attacking* you, and
   * there is nothing on the board to derive that from: a creature's target lives
   * inside its brain's memory as a bound slot, and a body standing next to you
   * minding its own business is not an assailant. A swing is the only thing that
   * says for certain, so a swing is what writes here.
   *
   * The value is milliseconds left, wound down by the tick loop exactly as
   * {@link defensiveDecay} is — the same reason too: a timestamp compared later
   * would disagree with the rest of the session about how long a second is, and
   * a world nobody is ticking would quietly empty while it slept.
   *
   * **Not durable**, like {@link hp} and {@link defensiveDecay}: it is the state
   * of a fight, and a fight does not survive the world being unloaded. Null until
   * something first swings at this body, so the great majority of actors never
   * allocate one.
   */
  assailants: Map<string, number> | null;
  /**
   * Where this creature is in its state machine, or null for a body with no
   * brain — every player, and any creature whose authored brain did not parse.
   * Built on first use rather than at adoption, which is what makes "brain
   * state resets on load" free: a fresh runtime has no memory to restore.
   */
  brain: BrainMemory | null;
  /**
   * Who this body is talking to and where in their dialog it is, or null.
   *
   * The *player's* state, not the NPC's — see `./dialogRuntime`'s
   * `Conversation` — which is what lets any number of people talk to one
   * salesman at once. Never checkpointed, on the brain memory's terms: a
   * conversation is a state of play, and a world coming back from a save
   * starts every one afresh. Ended by the session the tick its partner is out
   * of talking reach.
   */
  conversation: Conversation | null;
  /**
   * The cell this body was authored on, or null for one nobody authored.
   *
   * What the brain's `home` selector reads, and the only piece of a creature's
   * bearings that is *not* rebuilt from the world each load: it is decoded from
   * the actor's own name, which was minted from the authored placement the first
   * time the map was seen and has ridden on that placement through every
   * checkpoint since. @see residentHome
   *
   * Resolved here rather than per tick because it can never change: a body does
   * not get a second birthplace, and re-deriving one every brain tick would be a
   * string parse per creature per turn for an answer that was already settled.
   *
   * Null for every player, who has a spawn point rather than a home — see
   * `GameServer`'s `spawn:` rows, which are a different fact about a different
   * kind of body.
   */
  home: Coord | null;
  /**
   * Hit points, or null for a body that has never had any read.
   *
   * Filled on first use rather than at creation, which is what makes it free:
   * the stats live on the tile the actor *is*, and at creation the body may not
   * be on the board yet. Null therefore means "ask the tile", and a body with no
   * battler block leaves it null forever. See {@link GameSession.hpOf}.
   *
   * Deliberately absent from the checkpoint, exactly like {@link brain}: a world
   * nobody is looking at owes no continuity, and the alternative is a saved
   * number that has to survive somebody editing the tile's max.
   */
  hp: number | null;
  /**
   * What is running on this body right now. See `./statuses`.
   *
   * **Durable, unlike {@link hp} used to be and unlike {@link brain}.** What a
   * status records is a rule currently being applied to somebody, and the whole
   * point of it is that logging off neither cancels it nor advances it — so it
   * rides in the same storage batch as the kit and the tags. That is also why hit
   * points became durable beside it: a heal-over-time undone by a reconnect is
   * not an effect.
   *
   * Replaced wholesale rather than mutated, on the terms {@link tags} and
   * {@link masteryXp} are — the list goes out on a snapshot and identity is what
   * says something moved.
   */
  statuses: readonly StatusInstance[];
  /** Milliseconds until this body may swing again. See `./combat`. */
  attackCooldownMs: number;
  /**
   * Milliseconds until this body may take a step again, having just swung.
   *
   * **Its own clock rather than a second reading of {@link attackCooldownMs},
   * because the two answer to different things.** How often you may swing
   * belongs to the weapon, through {@link FightingStats.spd}. How long a blow
   * plants you belongs to the *body* and to nothing it is holding — which is
   * the whole point of it: a fight where the nimble could swing and keep
   * walking was a fight decided by who was willing to hold a movement key down,
   * and a plant that scaled with a stat would be one more thing to train out of
   * the way.
   *
   * Exactly one of this body's steps, read off the tile it is — see
   * {@link resolveWalkDurationMs}. Not a constant of its own, and that is what
   * makes it fair rather than merely fixed: a blow costs a creature one step of
   * *its* walking, so something authored to move slowly is not punished twice
   * for it.
   *
   * Only the *start* of a step is gated. A walk already in flight when the blow
   * goes out finishes it — a body cannot be stopped mid-cell without leaving it
   * standing between two of them.
   */
  attackRecoveryMs: number;
  /** Who this actor is set on, for a body driven by somebody pointing at things. */
  targetId: string | null;
  /**
   * Whether a target is somebody to fight or merely somebody being watched.
   *
   * Off by default, and the two halves of what used to be one decision:
   * {@link targetId} says *who*, this says *whether to swing*. Pointing at
   * something is how a player asks about it — a name tag, a health bar, a row in
   * the list — and before this the only way to look at a creature that closely
   * was to start a fight with it.
   *
   * Per actor rather than per session because it arrives on a socket like every
   * other thing a player asks for, and a brain never sets it: a creature's
   * aggression is its brain's `attack` action, which goes straight to
   * {@link GameSession.tryAttack} and never through a standing target.
   */
  attacking: boolean;
  input: GameInput;
  walk: WalkState | null;
  fall: FallState | null;
  slide: SlideState | null;
  /**
   * The lean of a blow this body is still part-way through. @see `./strike`
   *
   * Beside the three motions rather than folded into the cooldown, because it is
   * a different kind of clock: the cooldown is when this body may swing again
   * and it outlives the strike several times over at any ordinary speed.
   */
  strike: StrikeState | null;
  /**
   * Location memo, keyed on the map object it was read from.
   *
   * Map mutation is persistent, so object identity is an exact staleness check:
   * this recomputes once per edit and never returns a stale answer.
   */
  memo: { map: MapFile; loc: ActorLocation } | null;
};

/**
 * How much of a stone's cooldown is wound off at a time, and the slack allowed
 * when comparing accumulated ticks against it.
 *
 * A second, because a second is what a countdown can show — see
 * {@link GameSession.advanceStoneCooldowns} for why the truth is kept at the
 * same grain the drawing is. The epsilon is the same accumulated-float slack
 * `./statuses` absorbs: `TICK_MS` is 1000/30 and is not representable, so thirty
 * ticks of it come to 1000.0000000000005 and an honest comparison against a
 * thousand would be a step late about half the time.
 */
const COOLDOWN_STEP_MS = 1000;
const COOLDOWN_EPSILON_MS = 1e-6;

/**
 * What a mend is worth, before the learning rate.
 *
 * Flat, where a blow is scaled by how far above or below you the other body is.
 * Mending is not an exchange with anybody: scaling it by whoever you happen to
 * be pointing at would make bandaging yourself worth more against a troll and
 * nothing at all against a rat, and neither of those is a fact about the
 * bandaging.
 *
 * **Paid at this rate whoever the mend landed on**, now that a bolt can be
 * pointed at somebody else. A caster who has mended a troll has mended
 * somebody rather than beaten them, so there is still no second body in the
 * exchange for a Rating to weigh — which is the same argument, one step wider
 * than it used to have to be.
 */
const SELF_SPELL_MULTIPLIER = 1;

/**
 * What kind of blow a bolt counts as, for the armour it has to get through.
 *
 * **Arcane, because that is the mastery a stone answers to** — see
 * `../lib/mastery`, where the rename collapsed "the mastery a staff swings by"
 * and "how good you are at magic" into one number precisely so that this
 * question would have one answer. A breastplate authored with an arcane
 * resistance is warded against magic, and this is what makes it so.
 *
 * The elements deliberately do *not* appear here. What an element is worth
 * against a body is the wheel's question and is asked one step later, on the
 * damage that got through — see {@link elementalDamage}. Keying resistance off
 * them as well would let one piece of armour answer the same blow twice.
 *
 * Shaped as the sliver of a `FightingStats` that `damageAfterDefence` actually
 * reads, and frozen at module scope, so a cast allocates nothing to say the one
 * thing that is true of every cast in the world.
 */
const ARCANE_BLOW: Pick<FightingStats, "mastery"> = { mastery: "arcane" };

/**
 * What a bolt with no statuses authored leaves behind, shared on the terms
 * `NO_ELEMENTS` is: one frozen empty list rather than one per cast.
 */
const NOTHING_INFLICTED: readonly WeaponStatus[] = [];

/**
 * The same kit with every cooling stone `spent` milliseconds nearer ready, or
 * the very same object when nothing in it was cooling.
 *
 * **Identity is the answer**, which is what makes this free for the
 * overwhelming majority of bodies: nobody is carrying a stone, so the walk finds
 * nothing, allocates nothing, and the caller does not touch the kit at all. It
 * is the same contract `withStatusModifiers` keeps for a body under nothing.
 *
 * The three squares a stone can be in and no others — see `./casting`'s
 * {@link CAST_SQUARES}. A cooldown left over on something in a bag is not
 * counting down, and should not be: a stone in a bag is a stone nobody is
 * carrying, and the lock is what stops one getting there mid-cooldown in the
 * first place.
 */
function cooledEquipment(equipment: Equipment, spentMs: number): Equipment {
  let next: Equipment | null = null;
  for (const square of CAST_SQUARES) {
    const held = equipment[square];
    if (!held?.cooldownMs) continue;
    const remaining = held.cooldownMs - spentMs;
    next ??= { ...equipment };
    // Dropped rather than written as zero, so "ready" is the absence of a
    // cooldown everywhere — the same thing an instance that has never been cast
    // says, and one fewer state for anything reading this to tell apart.
    if (remaining > 0) {
      next[square] = { ...held, cooldownMs: remaining };
    } else {
      const { cooldownMs: _spent, ...ready } = held;
      next[square] = ready;
    }
  }
  return next ?? equipment;
}

/**
 * A body the world has just taken off the board.
 *
 * More than an id, because by the time anybody asks these questions the runtime
 * that could answer them is gone: {@link GameSession.kill} deletes it, and the
 * one moment a dead player's cell and kit exist is the moment that destroys
 * them. The server writes them down from here — see `GameServer.noteDeaths`,
 * which is what makes a death survive a reload.
 */
export type Death = {
  id: string;
  /**
   * What the body still owns once the floor has taken what it could: empty when
   * the kit landed as loot, and the whole kit when the cell refused it.
   *
   * One field rather than a "did it drop" flag, because the two facts have to
   * agree and this is the shape in which they cannot disagree — whatever is not
   * on the board is here, and the server writes exactly this.
   */
  equipment: Equipment;
  /**
   * What it had learned and what it had been marked with, on the same terms the
   * kit is here: a fight's last blows and a chest opened on the way in are
   * earned facts, and the runtime that held them is about to stop existing.
   */
  masteryXp: MasteryXp | null;
  tags: readonly string[];
};

/**
 * Authoritative play session. Mutates an in-memory map; no DOM / renderer.
 *
 * Holds any number of actors. `/play` runs exactly one and never names it; the
 * game server spawns one per connection.
 */
export class GameSession implements PlaySession {
  private map: MapFile;
  private readonly tilesById: Record<string, TileDef>;
  /** Insertion-ordered, which is what makes {@link tick} deterministic. */
  private readonly actors = new Map<string, ActorRuntime>();
  /**
   * Who is standing on each tile, so {@link nearestOnTile} answers from the
   * handful of bodies that could possibly match rather than from every actor
   * alive.
   *
   * **This is what stops brains being quadratic.** A `nearest` selector is
   * asked fresh every brain tick — that is the whole point of it, and
   * `app/lib/brain.ts` says so — so a world of five hundred creatures each
   * looking for the nearest player was walking five hundred actors five hundred
   * times, five times a second, to find the two people in it.
   *
   * Sound because an actor's tile is fixed for as long as they exist. A body is
   * placed once and adopted rather than rewritten, and decay explicitly refuses
   * to transform anything carrying an owner — so the only events that can move
   * an entry here are the ones that add or remove an actor, which is why
   * {@link forgetTileIndex} hangs off exactly those. Rebuilt lazily rather than
   * maintained in place: spawning reads the board to find the new body anyway,
   * and a world where nobody joins or dies builds this once and keeps it for
   * ever.
   *
   * Never trusted on its own — see the tile check in {@link nearestOnTile}. An
   * index that is over-inclusive is a wasted comparison; treating it as the
   * final word would make any drift a wrong answer instead.
   */
  private tileIndex: Map<string, string[]> | null = null;
  private readonly spawnAt: Coord & { stackIndex: number };
  /**
   * Cells holding a pressure plate, so settling reads a handful of columns
   * instead of the whole board every tick. Kept true by
   * {@link reindexCells} at the few sites that can relocate a plate; a stale
   * extra entry only costs a wasted stack read, a missing one is a dead plate.
   */
  /**
   * Actors whose kit has changed and whose owner has not been told yet.
   *
   * Ids rather than the kits themselves: by the time this is drained the
   * equipment on the runtime is the current one, and holding a copy here would
   * be a second version of the truth going stale between the tick that changed
   * it and the flush that sends it.
   */
  private readonly equipmentChanged = new Set<string>();
  private readonly conversationChanged = new Set<string>();
  /** Actors whose tags have changed and whose owner has not been told yet. */
  private readonly tagsChanged = new Set<string>();
  /**
   * Actors whose set of cooling resources has changed and whose owner has not
   * been told yet.
   *
   * A fourth queue beside the kit, the tags and the experience, and not folded
   * into any of them for the reason they are not folded into each other: it
   * moves on a different event at a different rate, and sharing a queue would
   * put a whole inventory on the wire every time a bush came ready.
   */
  private readonly extractCoolingChanged = new Set<string>();
  /**
   * Actors whose experience has moved and whose owner has not been told yet.
   *
   * The busiest of the three queues by a long way — roughly one entry per landed
   * blow — which is exactly why it is a queue rather than a message: a fight is
   * several swings a second between them, and the set collapses all of it into
   * one send on the next flush.
   */
  private readonly masteriesChanged = new Set<string>();
  private readonly plateCells = new Map<string, Coord>();
  /**
   * Cells holding a placement wired to a signal channel — emitters and
   * receivers alike, since reading a channel means finding both. Same index
   * discipline as {@link plateCells}.
   */
  private readonly wiredCells = new Map<string, Coord>();
  /**
   * Cells holding a gravity body no runtime drives — a crate, a barrel. The
   * settle pass drops these; an actor animates its own fall and is excluded by
   * its owner. Same index discipline as {@link plateCells}.
   */
  private readonly looseGravityCells = new Map<string, Coord>();
  /**
   * Placements counting down to becoming something else, or to nothing.
   *
   * Its own object rather than another cell index beside the three above,
   * because it is the one that carries a *clock*: the others answer "which
   * cells are worth re-reading" and this one also answers "when". Same index
   * discipline all the same — {@link reindexCells} is what arms it, so any new
   * site that places a tile has to reindex the cell or that tile never ages.
   *
   * Assigned in the constructor rather than here, because it draws its lifetimes
   * from {@link rng} and a field initialiser would run before that exists.
   */
  private readonly decay: DecayIndex;
  /**
   * The status catalogue, as authored. Keyed by id and never mutated.
   *
   * Handed in beside the tiles because it is the same kind of thing — authored
   * content the session reads and never writes — and an empty one is a world
   * where nothing has statuses, which is exactly what every test that does not
   * care about them wants.
   */
  private readonly statusDefs: Record<string, StatusDef>;
  /**
   * Whose statuses have moved in a way anybody could see, waiting to be
   * announced.
   *
   * A fourth queue beside the kit, the tags and the experience, and it earns one
   * for a reason none of those had: those three change when somebody *does*
   * something, and this changes on its own, every tick, for as long as anything
   * is running. So the queue is filled from a **reading** rather than from the
   * fact of a change — see `./statuses`'s `statusReading` — which is what turns
   * thirty announcements a second into about one.
   */
  private readonly statusesChanged = new Set<string>();
  /**
   * What each actor's statuses last read as, so the queue above can tell a
   * change worth announcing from a countdown ticking inside the same second.
   *
   * Cleared with the actor, or it would grow with everybody who has ever
   * connected.
   */
  private readonly statusReadings = new Map<string, string>();
  /** Map identity the last settle pass read. See {@link settleBoardNow}. */
  private settledMap: MapFile | null = null;
  private accumulatorMs = 0;
  /**
   * Simulated milliseconds banked towards the next second of stone cooldown.
   *
   * On the session rather than per actor because every stone in the world cools
   * at the same rate: one clock, drained a whole step at a time, keeps every
   * cooldown in the world in phase and costs one addition per tick.
   * @see advanceStoneCooldowns
   */
  private stoneClockMs = 0;
  /**
   * The world's dice, shared by every brain in it.
   *
   * One stream rather than one per creature, which makes actor order part of
   * what makes a world reproducible — the same order that already decides who
   * wins a contested cell.
   */
  private readonly rng: Rng;
  /** Time into the current round of decisions. See {@link BRAIN_TICK_MS}. */
  private brainAccumulatorMs = 0;
  /**
   * Who has not thought yet this round, in the order they will.
   *
   * **A round is still a round; it is the work that is spread out.** Every
   * creature thinks once per {@link BRAIN_TICK_MS} as it always did, but they
   * no longer all think on the same tick: the queue is filled when a round
   * opens and drained a slice at a time across it, so the cost of deciding is
   * paid evenly instead of arriving as one spike every six ticks.
   *
   * That spike was not a simulation problem — 154 animals thinking at once
   * measured ~11ms of a 33ms tick, which fits. It was that all of them *moved*
   * at once, and a hundred-odd cells changing in one frame is far past what the
   * renderer's incremental path will diff (`MAX_INCREMENTAL_CELLS`), so every
   * one of those frames rebuilt whole levels of merged geometry. Spreading the
   * decisions spreads the edits, and the renderer stays on the cheap path.
   *
   * Ids rather than actors, so somebody who leaves mid-round is skipped rather
   * than thought for; somebody who joins mid-round waits for the next one.
   */
  private brainQueue: string[] = [];
  /** How far into {@link brainQueue} this round has got. */
  private brainQueueAt = 0;
  /**
   * What creatures said this tick, waiting to be broadcast.
   *
   * Emptied at the top of every tick and refilled by whatever brains say during
   * it, so it only ever holds the current tick's speech. The server drains it
   * after the tick and turns each line into the same chat a player sends; a
   * session running with no wire — offline `/play` — simply never drains it, and
   * the per-tick reset keeps that from leaking. Speech stays an online-only
   * thing, as {@link getSnapshot} already declares.
   */
  private pendingSpeech: ChatBubble[] = [];
  /** Ticks up per line, so two things said in one tick are two bubbles. */
  private nextSpeechId = 0;
  /**
   * What has been said *to* the world since the brains last had a turn.
   *
   * The mirror of {@link pendingSpeech}, and the reason it is a separate list
   * rather than the same one: that holds what creatures said and empties every
   * tick on its way to the wire, while this holds what people said and empties
   * on the slower brain clock, because a brain that ticks once per six ticks
   * would otherwise miss five sixths of everything shouted at it.
   *
   * Held only until the next round of decisions. An utterance is an event, not a
   * state of the world: a creature hears a thing said once, and a word left
   * lying here would be heard again by whoever ticks next.
   */
  private pendingHeard: Utterance[] = [];
  /**
   * Who has hit whom since the brains last had a turn, as `target -> attackers`.
   *
   * The exact counterpart of {@link pendingHeard}, cleared on the same slower
   * clock and for the same reason: a brain gets one chance to notice a blow, and
   * a blow left lying here would be noticed again by whoever ticks next. Indexed
   * by target because that is the only question ever asked of it — "was I hit,
   * and by whom" — and a flat list would mean every creature walking every blow
   * struck anywhere in the world.
   */
  private pendingHurt = new Map<string, string[]>();
  /**
   * Every sound made since the brains last had a turn, oldest first.
   *
   * The third of the same family as {@link pendingHeard} and
   * {@link pendingHurt}, on the same slower clock and emptied for the same
   * reason: a noise is an event, and one left lying here would be heard again by
   * whoever ticks next.
   *
   * **Handed over at the top of the pass rather than cleared at the bottom**,
   * which is the one way it differs from those two, and the difference is about
   * where the events come from. A word is said by a player and a blow is usually
   * thrown by one, so both are already on the page before any brain wakes up. A
   * sound is overwhelmingly made by a *brain*, on its way into a state — so
   * clearing at the bottom would mean a creature ticking before the howler heard
   * the howl and one ticking after did not, and which of those you are is the
   * order of a Map. Taking the batch first costs one brain tick of delay and
   * buys the whole pack hearing the same thing. @see tickBrains
   *
   * Not {@link pendingNoise}, which looks like it and is not. That one empties
   * every tick on its way to the wire, so a brain ticking once per six ticks
   * would miss five sixths of everything the world made a sound about — the
   * exact reason speech needed a second list too. This one also carries who made
   * the sound, which the wire deliberately does not. @see NoiseEmission
   */
  private pendingSound: Sound[] = [];
  /**
   * What this round's brains are deciding against, taken when it opened.
   *
   * The three `pending` lists above are what has happened *since*; these are
   * the round's own copy. Taking one is what keeps one word reaching every ear
   * at once now that a round is drained across several ticks: without it a
   * shout landing halfway through would be heard by the creatures that had not
   * thought yet and missed by the ones that had, and which of those you are is
   * the order of a Map.
   *
   * {@link pendingSound} was already handed over exactly this way, for exactly
   * that reason, back when the whole round was one loop and the only thing that
   * could land inside it was a noise a brain made. The other two join it now
   * that a player can speak or swing in the middle of a round. The rule has not
   * changed — it applies to more of them.
   */
  private roundHeard: Utterance[] = [];
  private roundHurt = new Map<string, string[]>();
  private roundSounds: Sound[] = [];
  /**
   * Damage dealt this tick, waiting to be broadcast. Drained by the server
   * exactly as {@link pendingSpeech} is, and emptied at the top of every tick so
   * a session with no wire cannot accumulate it.
   */
  private pendingDamage: DamageNumber[] = [];
  /**
   * Damage still on screen, aged down by the tick loop.
   *
   * Separate from {@link pendingDamage} because the two answer different
   * questions: that one is "what happened in the last tick", which the wire
   * wants once, and this is "what a viewer should still be able to see", which
   * outlives it by a couple of seconds. Both are fed by the same blow.
   */
  private liveDamage: DamageNumber[] = [];
  /**
   * Shots loosed this tick, waiting to be broadcast. Drained by the server
   * exactly as {@link pendingDamage} is, and emptied at the top of every tick so
   * a session with no wire cannot accumulate it.
   */
  private pendingProjectiles: ProjectileFlight[] = [];
  /**
   * Arrows still in the air, aged down by the tick loop.
   *
   * The same pair {@link pendingDamage} and {@link liveDamage} make, for the
   * same reason: one answers "what happened in the last tick" and the other
   * "what a viewer should still be able to see". A flight outlives its tick by
   * however long it takes to arrive.
   */
  private liveProjectiles: ProjectileFlight[] = [];
  /** Ticks up per shot, so two arrows in one tick are two flights. */
  private nextProjectileId = 0;
  /**
   * Sentences waiting to be told to the people they are about.
   *
   * Addressed rather than broadcast, and that is what makes it a list of pairs
   * rather than a list of lines: "you open the chest" is true of exactly one
   * body in the room, and everybody else watching would be told about a chest
   * they can still open themselves.
   *
   * A line queued for somebody who has just disconnected waits here until they
   * come back and drain it, which is the right answer rather than a leak: they
   * *did* take the reward, and being told on the next visit is still being told.
   * Ids are stable per player, so the wait ends.
   */
  private readonly pendingNotices: { actorId: string; text: string }[] = [];
  /** Ticks up per blow, so two hits in one tick are two numbers. */
  private nextDamageId = 0;
  /**
   * Noises made this tick, waiting to be broadcast. Drained by the server
   * exactly as {@link pendingDamage} is.
   */
  private pendingNoise: NoiseEmission[] = [];
  /**
   * Whoever went through a teleport this tick, by id.
   *
   * Queued rather than diffed, on the same terms a blow is: a trip leaves no
   * lasting state to compare two readings of — the body is simply somewhere
   * else, which the cell patches already say. What the ids carry is the one
   * thing the board cannot: that a client's guess about this body is void.
   */
  private pendingTeleports: string[] = [];
  /**
   * Everybody who threw a blow this tick.
   *
   * Ids alone, because the only thing anybody does with one is start a clock
   * whose length the receiver can already work out — a body's recovery is a
   * body's walk, and both sides read that off the tile. @see drainSwings
   */
  private pendingSwings: string[] = [];
  /**
   * Noises still on screen, aged down by the tick loop.
   *
   * The pair works the way damage's does rather than the way speech's does, and
   * the difference is the point: speech is broadcast and forgotten by the
   * session, so it never appears offline, while a noise is world-legible the
   * way a damage number is and a single-player world has every right to hear
   * one. A snake hissing in `/play` is the case that settles it.
   */
  private liveNoise: NoiseEmission[] = [];
  /** Ticks up per noise, so two in one tick are two labels. */
  private nextNoiseId = 0;
  /**
   * Who died this tick, waiting to be noticed.
   *
   * The session cannot act on a death beyond removing the body and putting what
   * it carried on the floor — whether the connection behind it is kept out of
   * the world afterwards is the server's question, and this is how it hears
   * about one. Drained like speech and damage; a session with no wire never
   * asks.
   */
  private pendingDeaths: Death[] = [];
  /**
   * The creature-driven emitters the last settle pass saw, as a signature.
   *
   * A brain entering or leaving a state that holds a channel changes nothing on
   * the map — the body has not moved — so the map-identity skip in
   * {@link settleBoardNow} would sail straight past it and the door would never
   * hear. This is the other half of that skip: when the minds driving the wires
   * change, the pass runs even though the board looks untouched.
   */
  private settledEmitters = "";

  /**
   * The world and its content are positional because there is no world without
   * them; everything else is optional and lives in one object. It used to be
   * four trailing positionals, and by the time statuses needed one the calls
   * that wanted only the last of them were writing `undefined` three times.
   */
  constructor(
    map: MapFile,
    tiles: TileDef[],
    {
      actorIds = [LOCAL_ACTOR_ID],
      spawnAt,
      seed,
      statuses: statusDefs = {},
    }: {
      /**
       * Actors to start with. The default adopts the authored `player` tile as
       * a single local actor, which is what `/play` wants; pass an empty array
       * to open an empty world and {@link spawn} into it.
       */
      actorIds?: readonly string[];
      /**
       * Where actors enter. Omit for an authored map, and it is read from the
       * `player` tile, which is then consumed — adopted by the first actor or
       * removed. **Required when resuming a map that has already been run**,
       * because that map no longer has a marker to read: it was consumed the
       * first time. Rediscovering it is impossible, so it has to be carried
       * alongside.
       */
      spawnAt?: Coord & { stackIndex: number };
      /**
       * Where the world's dice start. Carried in the checkpoint for the same
       * reason `spawnAt` is — resuming from the opening seed would replay the
       * wander the world had already played. Omit for a fresh world.
       */
      seed?: number;
      /**
       * The status catalogue, keyed by id — see `../lib/status`. Omit for a
       * world where nothing has statuses, which is every test not about them.
       */
      statuses?: Record<string, StatusDef>;
    } = {},
  ) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    this.statusDefs = statusDefs;
    this.rng = new Rng(seed);
    this.decay = new DecayIndex(this.rng);

    if (spawnAt) {
      this.spawnAt = spawnAt;
      for (const id of actorIds) this.spawn(id);
    } else {
      this.spawnAt = spawnPoint(this.map);
      // The first actor adopts the authored tile rather than spawning beside
      // it, so a single-actor session is the map it was handed, tagged — the
      // tile keeps its slot in the stack, and with it the elevation it stands
      // at.
      const [first, ...rest] = actorIds;
      if (first === undefined) {
        this.map = removeAuthoredPlayer(this.map);
      } else {
        this.map = adoptAuthoredPlayer(this.map, first);
        this.addActor(first, { bodyTileId: PLAYER_TILE_ID });
      }
      for (const id of rest) this.spawn(id);
    }

    // After the connecting actors, and before anything reads the board: a
    // resident is on the map whether or not anybody is here to see it.
    this.adoptResidents();

    // Before anything can pick one up, and idempotent against a resumed world
    // whose items were minted the last time it loaded.
    this.map = mintItemIds(this.map, this.tilesById);

    for (const cell of findPlateCells(this.map, this.tilesById)) {
      this.plateCells.set(cellKey(cell), cell);
    }
    for (const cell of findWiredCells(this.map)) {
      this.wiredCells.set(cellKey(cell), cell);
    }
    for (const cell of findLooseGravityCells(this.map, this.tilesById)) {
      this.looseGravityCells.set(cellKey(cell), cell);
    }
    // Authored decay starts counting from the moment the world opens, which is
    // also how a resumed one recovers: the deadlines were never checkpointed,
    // so whatever is on the board gets a fresh lifetime rather than none.
    for (const cell of findDecayCells(this.map, this.tilesById)) {
      this.decay.armCell(this.map, cell, this.tilesById);
    }
    // An authored map opens in the state its load implies — a boulder already
    // sitting on a plate means that plate starts pressed, not pressed one tick
    // after the player first sees it, and the door that plate drives starts
    // open.
    this.settleBoardNow();
  }

  /**
   * Give every body that lives in the map an actor to drive it.
   *
   * Placing the tile is the whole of putting an NPC in the world — there is no
   * spawner and nothing to author beyond the placement itself. Idempotent
   * against a resumed world: a body that already carries an owner keeps it and
   * only gains its runtime back, because re-minting would hand the same
   * creature a second identity and leave the first one on the board forever.
   *
   * The locations are read once, up front, and stayed reliable while the loop
   * rewrites the map: adoption only ever writes an owner onto a placement, so
   * nothing moves out from under the scan.
   */
  private adoptResidents() {
    for (const body of listResidentBodies(this.map, this.tilesById)) {
      const owner = body.placed.owner ?? residentOwnerId(body);
      if (!body.placed.owner) {
        this.map = adoptBodyAt(this.map, body, owner);
      }
      if (!this.actors.has(owner)) {
        this.addActor(owner, { resident: true, bodyTileId: body.placed.tileId });
      }
    }
  }

  private addActor(
    id: string,
    opts: {
      resident?: boolean;
      /**
       * The tile of the body this actor is being seated in, which is what its
       * kit is rolled from — see {@link rollKit}. Omit only where there is
       * genuinely no body to name, which is nowhere today.
       */
      bodyTileId?: string;
      carrying?: Equipment;
      tagged?: readonly string[];
      earned?: MasteryXp;
      statuses?: readonly StatusInstance[];
      hp?: number;
    } = {},
  ): ActorRuntime {
    const resident = opts.resident === true;
    // **Everybody gets a kit, and it comes from the body they are in.** It used
    // to be "people get a starting bag, creatures get nothing", on the grounds
    // that a backpack per deer is a bag to seat, checkpoint and diff for
    // nothing. What changed is that a creature's kit is now something an author
    // asked for — a rat with meat on it is why you fight a rat — so the cost is
    // being paid for a reason, and only where a kit was actually authored.
    //
    // A returning player brings their own, already checked against the tiles
    // this world has now — see `restoredEquipment`. It is not merged with the
    // rolled one: coming back with a bag *and* a fresh one is a bag from
    // nowhere, once per reconnect.
    const equipment =
      opts.carrying ??
      (opts.bodyTileId ? this.rollKit(opts.bodyTileId) : emptyEquipment());
    // The kit's first and only arming that does not go through
    // {@link setEquipment}: a returning player's berries have been ripening in
    // storage as far as they know, and start their lifetime again here.
    this.decay.armEquipment(equipment, this.tilesById);
    const actor: ActorRuntime = {
      id,
      resident,
      equipment,
      carriedLights: carriedLightTileIds(equipment, this.tilesById),
      // Not checked against the world the way a kit is. A kit names things that
      // have to still exist; a tag names something that *happened*, and a reward
      // whose tile the author has since deleted is still a chest this player
      // opened. Forgetting it would hand them the next version of it twice.
      tags: opts.tagged ?? NO_TAGS,
      // Seeded lazily rather than here, for the reason `hp` is: the authored
      // masteries live on the body, and at this moment the actor may have no
      // body on the board to read one from. A returning player brings theirs.
      //
      // Checked rather than trusted, and `hasExperience` says why: an empty
      // block is not a body with nothing learnt, it is one nobody has asked
      // about — and passing it through would defeat the seeding below and hand
      // somebody a body with half the hit points and no evasion.
      masteryXp: resident || !hasExperience(opts.earned) ? null : opts.earned,
      earnedBody: null,
      defensiveDecay: null,
      assailants: null,
      brain: null,
      conversation: null,
      home: residentHome(id),
      // Restored where a returning player had any, and null otherwise — null
      // still means "ask the tile", which is what a fresh body and every
      // creature in the world wants. A stored zero would be a corpse, so it
      // floors at one: nothing should ever write one, because a death takes the
      // actor off the board rather than leaving it at nothing, and this is a
      // path whose whole job is bringing somebody back.
      hp: opts.hp === undefined ? null : Math.max(1, opts.hp),
      // Whatever was still running when they left, frozen for exactly as long as
      // they were away. A resident is handed nothing: its statuses are rebuilt
      // from the tile like its brain, since a world nobody is looking at owes no
      // continuity and a key per creature would spend the storage ceiling on
      // remembering that a deer is uninjured.
      statuses: resident ? NO_STATUSES : (opts.statuses ?? NO_STATUSES),
      attackCooldownMs: 0,
      attackRecoveryMs: 0,
      extractCooldowns: null,
      extractCooling: NO_COOLING_LIST,
      targetId: null,
      attacking: false,
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

  /**
   * What a body of this kind is born carrying, rolled on the world's dice.
   *
   * The dice are the session's rather than `Math.random()` for the reason every
   * other draw here uses them: two worlds on one seed have to agree about what
   * the wolf was carrying as well as about which way it walked. It is also what
   * makes a kit assertable in a test without reaching for a mock.
   */
  private rollKit(bodyTileId: string): Equipment {
    return equipmentForBody(bodyTileId, this.tilesById, () => this.rng.next());
  }

  /**
   * The kit the world hands somebody it has never met — and hands them again
   * after a death, since as far as their pockets are concerned that is what
   * they now are.
   *
   * Exposed because the server writes that second one down: a death deletes the
   * runtime that would otherwise have rolled it. See `GameServer.saveActors`.
   */
  startingKit(): Equipment {
    return this.rollKit(PLAYER_TILE_ID);
  }

  /**
   * Drop the tile index, to be rebuilt on the next question that needs it.
   *
   * Called from the three places that add or remove an actor, and from nowhere
   * else — see {@link tileIndex} for why that is the complete list.
   */
  private forgetTileIndex() {
    this.tileIndex = null;
  }

  /**
   * Put an actor on the board.
   *
   * Idempotent against the *map*, not just the actor table: a resumed world
   * already holds the tiles of everyone who was standing in it, and minting a
   * second body for them would leave one behind forever — `despawn` only ever
   * removes one. So an actor who already has a tile is re-seated on it, keeping
   * where they were rather than being sent back to spawn.
   *
   * No reindex: an actor tile is never a plate and never wired, so which cells
   * carry those is unchanged. Arriving on a plate still presses it — the map
   * identity changed, so the next {@link settleBoardNow} will not skip.
   *
   * Everything a returning player brings back with them is one object, because
   * that is what it is: six facts about the same person, restored together or
   * not at all. Omit it entirely for somebody the world has never met.
   */
  spawn(
    id: string,
    restored: {
      /**
       * Where this actor was standing the last time anyone saw them. Consulted
       * only when they have no tile on the board — a body already in the map is
       * more recent than any memory of one — and honoured only if it still has
       * room for them; see {@link findEntryCell}.
       */
      at?: Coord & { direction?: Direction };
      /**
       * What they had on them, already checked against this world's tiles — see
       * `restoredEquipment`. Omit for somebody new, who gets the starting kit.
       */
      carrying?: Equipment;
      /** Which rewards they have taken. Omit and they are owed all of them. */
      tagged?: readonly string[];
      /**
       * What they have learnt. Omit for somebody new, whose masteries are seeded
       * from the authored block on the body they arrive in.
       */
      earned?: MasteryXp;
      /** What was still running on them, frozen for as long as they were away. */
      statuses?: readonly StatusInstance[];
      /** What health they were on. Omit for a body that comes back full. */
      hp?: number;
    } = {},
  ) {
    if (this.actors.has(id)) return;
    const { at } = restored;
    if (!findActorAnywhere(this.map, id)) {
      const cell = at
        ? findEntryCell(this.map, this.tilesById, at, this.spawnAt)
        : this.spawnAt;
      this.map = spawnActor(this.map, id, cell, at?.direction);
    }
    this.addActor(id, { ...restored, bodyTileId: PLAYER_TILE_ID });
  }

  /**
   * Where an actor is standing right now, and which way they are facing.
   *
   * Null rather than a throw when nobody by that name is on the board: both
   * callers are persistence and cleanup, and neither has anything useful to do
   * with an exception.
   */
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

  /**
   * Remove the bodies of actors nobody is driving.
   *
   * A world resumed from a checkpoint carries whoever was standing in it, and
   * some of those connections are gone — they died while the object was
   * evicted, so no close ever ran for them. Called with the set that is
   * genuinely connected.
   */
  reapAbsentActors(present: Iterable<string>) {
    const live = new Set(present);
    // Residents are nobody's connection, so they are absent from every list of
    // who is connected — reaping on that alone would clear the world of its
    // wildlife on the first wake after an eviction. Read off the board rather
    // than tracked beside it, and by the same rule adoption uses, so the two
    // cannot come to disagree about what a resident is.
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

  /**
   * Take an actor off the board. Their tile goes with them, and a plate they
   * were holding down releases on the next tick by the same identity check.
   */
  despawn(id: string) {
    // Before the delete, or the reading is left behind for somebody who is no
    // longer here — and a returning actor would then be compared against what
    // they were under last time and told nothing.
    this.statusReadings.delete(id);
    this.statusesChanged.delete(id);
    if (!this.actors.delete(id)) return;
    this.forgetTileIndex();
    this.map = despawnActor(this.map, id);
  }

  /**
   * Grow back what was authored at a spawn point, if it is still owed.
   *
   * Done means this deadline is spent — the point is filled, something grew,
   * or nothing ever will — and the server can drop it. One call grows one
   * placement, so a point authored with several identical objects refills one
   * per window: the growth itself changes the cell, and the server's
   * changed-cell sweep is what notices the count is still short and arms the
   * next.
   *
   * A tile that has left the catalogue reads as settled, not as a retry: no
   * amount of waiting authors it back, and the registry is rebuilt from the
   * catalogue on the next save anyway.
   *
   * See {@link RespawnOutcome} for what the two answers oblige the caller to.
   */
  respawnAt(point: SpawnPoint): RespawnOutcome {
    if (isSpawnFilled(this.map, point)) return { kind: "done" };
    const def = this.tilesById[point.placed.tileId];
    if (!def) return { kind: "done" };
    const { x, y, z } = point.cell;
    if (!canPlace(this.map, x, y, z, def, this.tilesById).ok) {
      return { kind: "blocked" };
    }

    // A respawned item is a new item — the authored placement carries no ids
    // (see `authoredPlacement`). Minted here rather than left to the sweep
    // below because the id is half the answer: a point that knows which thing
    // it grew can tell that thing going stale where it stands from somebody
    // carrying it off, and one that knows only a tile id cannot.
    const itemId = isItem(def) ? mintItemId() : undefined;
    this.map = appendTile(this.map, x, y, z, {
      ...point.placed,
      ...(itemId ? { itemId } : {}),
      ...(point.ownerId ? { owner: point.ownerId } : {}),
    });
    // Still swept, for what the placement is *holding*: a respawned chest
    // arrives full of anonymous contents, which need identities of their own.
    this.map = mintItemIds(this.map, this.tilesById);
    // A body that grew back rolls its kit again, on the same terms its hit
    // points are rebuilt from the tile: what respawned is a new creature, not
    // the one that died holding what it was holding.
    if (point.ownerId && !this.actors.has(point.ownerId)) {
      this.addActor(point.ownerId, {
        resident: true,
        bodyTileId: point.placed.tileId,
      });
    }
    // What grew back may be a plate's load, a wire's emitter or a decaying
    // tile, so the cell's indexes are rebuilt exactly as they are after a kill.
    this.reindexCells([point.cell]);
    return { kind: "done", ...(itemId ? { itemId } : {}) };
  }

  actorIds(): string[] {
    return [...this.actors.keys()];
  }

  /**
   * Whether this session still has a body for an id.
   *
   * Exists because a caller holding an id across a tick cannot assume it is
   * still there: a death removes the runtime, and so does a world being
   * replaced. Everything else that reaches for an actor throws when it is gone,
   * which is right for the paths that genuinely require one — this is for the
   * paths that are asking.
   */
  hasActor(id: string): boolean {
    return this.actors.has(id);
  }

  /**
   * Whether this actor is a body the world owns rather than one a person drives.
   *
   * The distinction the server needs is "where does this actor come back from".
   * A resident is on the board — adopted out of the map when a session opens —
   * so the checkpointed board already says where it is. A player is not: their
   * tile is consumed at spawn and their position is only recoverable from what
   * was written down about them. See `GameServer.saveActors`, which is the one
   * caller and writes a position row for the second kind only.
   *
   * False for nobody by that name, on the same grounds the accessors above
   * return null: an actor who is not here is not a resident of anywhere.
   */
  isResident(id: string): boolean {
    return this.actors.get(id)?.resident === true;
  }

  /**
   * What one actor is carrying, or null when nobody by that name is here.
   *
   * Null rather than an empty kit, because the two mean different things to the
   * server: an actor with nothing is somebody to send an empty inventory to,
   * and an actor who has died or never joined is somebody to send nothing at
   * all. Only the server asks — a local viewer reads theirs off the snapshot.
   */
  equipmentOf(id: string): Equipment | null {
    return this.actors.get(id)?.equipment ?? null;
  }

  /**
   * Which rewards one actor has already taken, or null for nobody by that name.
   *
   * Null rather than an empty list on the same grounds {@link equipmentOf}
   * returns it: "here and owed everything" and "not here at all" are different
   * answers to the server, and only one of them is worth writing down.
   */
  tagsOf(id: string): readonly string[] | null {
    return this.actors.get(id)?.tags ?? null;
  }

  /**
   * Which resources one actor may not work just yet, as `./extract` keys.
   *
   * The cached projection rather than a fresh read of the map, on
   * {@link ActorRuntime.extractCooling}'s terms: this is on the snapshot, so it
   * is asked every frame and its identity is what tells the renderer anything
   * moved.
   *
   * Empty for nobody by that name, which {@link equipmentOf} and {@link tagsOf}
   * distinguish and this does not: what a stranger may not do is the same list
   * as what somebody with nothing cooling may not do, and there is nothing a
   * caller could usefully do with the difference.
   */
  extractCoolingOf(id: string): readonly ExtractCooling[] {
    return this.actors.get(id)?.extractCooling ?? NO_COOLING_LIST;
  }

  /**
   * What one actor has learnt, or null for a body that does not learn.
   *
   * Null covers three cases the server treats alike — nobody by that name, a
   * creature, and a player nothing has yet asked about — because all three come
   * to the same thing when the question is "is there anything here worth writing
   * down".
   *
   * The live object rather than a copy, on the same terms {@link equipmentOf}
   * hands back the live kit. Whoever makes it durable copies it on the way out.
   */
  masteryXpOf(id: string): MasteryXp | null {
    return this.actors.get(id)?.masteryXp ?? null;
  }

  /**
   * How good at fighting one actor is — their ⭐ — or null for a body with no
   * stats at all.
   *
   * Public because the server persists nothing derived and shows plenty: this is
   * the number beside a name on inspect, and it must be the same number the
   * reward curve divides by or the player is being shown a different game from
   * the one they are playing.
   */
  ratingIn(id: string): number | null {
    const actor = this.actors.get(id);
    return actor ? this.ratingOf(actor) : null;
  }

  /**
   * Where actors enter. Must be carried alongside any map this session is
   * checkpointed into — see the constructor.
   */
  getSpawnPoint(): Coord & { stackIndex: number } {
    return this.spawnAt;
  }

  /**
   * The dice as they stand, to be handed back to the constructor on resume.
   *
   * Must be checkpointed alongside the map: restoring a world from the seed it
   * opened with would replay the wander it had already played, which is the one
   * thing a fresh draw exists to avoid.
   */
  getSeed(): number {
    return this.rng.save();
  }

  private actor(id: string): ActorRuntime {
    const actor = this.actors.get(id);
    if (!actor) throw new Error(`No actor "${id}" in this session`);
    return actor;
  }

  /** Keep every cell index true for cells whose stack just changed. */
  private reindexCells(cells: Iterable<Coord>) {
    for (const cell of cells) {
      const key = cellKey(cell);
      // Before the membership checks, and additive rather than a set/delete
      // pair like the rest: the index holds a deadline, not a fact about the
      // board, and the ones already in it are the ones that must not be reset.
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
    }
  }

  /**
   * Bring the board in line with itself: unsupported bodies drop, then plates
   * follow what now rests on them, then receivers follow the channels those
   * plates drive.
   *
   * Gravity first, and all in the same tick, so a crate whose floor was pulled
   * lands and presses its plate — and opens the door that plate drives — on the
   * frame the floor goes rather than a tick later, one settle bleeding into the
   * next.
   *
   * The skip is on map identity, not a dirty flag: the map is copy-on-write, so
   * an unchanged map cannot have changed a plate's load or a channel's value.
   * The identity recorded is the one read *before* the pass, which is what lets
   * a swap that shifts another plate's load — or drives another channel —
   * settle on the next tick rather than being mistaken for a board at rest.
   */
  private settleBoardNow() {
    const before = this.map;
    const emitters = this.actorEmitters();
    const emitterSig = this.emitterSignature(emitters);
    // Two ways the board can owe a pass: the map changed, or a mind driving a
    // wire did. The second leaves no trace on the map, so it needs its own say.
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
      const { map, changed } = settlePlates(
        this.map,
        this.plateCells.values(),
        this.tilesById,
      );
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

  /**
   * Where an actor is, without sweeping the map unless they actually moved.
   *
   * A single tick can rewrite the map several times — commit a step, then
   * settle a plate under it — and every rewrite makes the memo stale. Nearly
   * all of those edits leave the actor exactly where they were, so confirming
   * the one cell is enough; only a real relocation costs more.
   */
  private tryLocate(actor: ActorRuntime): ActorLocation | null {
    const memo = actor.memo;
    if (memo?.map === this.map) return memo.loc;

    const loc = locateActor(this.map, actor.id, memo?.loc);
    if (loc) actor.memo = { map: this.map, loc };
    return loc;
  }

  private locate(actor: ActorRuntime): ActorLocation {
    const loc = this.tryLocate(actor);
    if (!loc) throw new Error(`Actor "${actor.id}" is not on the map`);
    return loc;
  }

  /**
   * Where a body is, in the terms reach is measured in.
   *
   * The elevation is the surface it is *standing on* — everything under it in
   * its own stack, plus its level — which is the whole reason reach does not
   * simply read `z`. A rat on a crate is half a level nearer your fist than a
   * rat beside it, and on the board those two are the same cell and the same
   * floor. `z` rides along because line of sight still walks in levels.
   */
  private reachPointOf(loc: ActorLocation) {
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    return {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      elevAbs: absoluteStandingElevation(
        loc.z,
        stack.slice(0, loc.stackIndex),
        this.tilesById,
      ),
    };
  }

  setInput(input: GameInput, id: string = LOCAL_ACTOR_ID) {
    this.actor(id).input = input;
  }

  /** Advance by real-time `dtMs`, running fixed ticks. */
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
   * Single fixed tick.
   *
   * Actors move in insertion order, and that order is load-bearing: two actors
   * stepping into the same cell on the same tick resolve by it, so a stable
   * order is what makes a tick reproducible rather than dependent on which
   * message happened to arrive first.
   */
  tick(tickMs: number = TICK_MS) {
    // Last tick's speech has been broadcast or discarded; this tick starts with
    // an empty page, so anything left undrained cannot pile up.
    this.pendingSpeech = [];
    this.pendingDamage = [];
    this.pendingNoise = [];
    this.pendingProjectiles = [];
    this.pendingTeleports = [];
    this.pendingSwings = [];
    this.ageDamageNumbers(tickMs);
    this.ageNoises(tickMs);
    this.ageProjectiles(tickMs);

    // Before the cooldowns and before anything swings, because a status is the
    // one thing here that can change the numbers the rest of the tick is fought
    // with — and because a poison that kills on this tick should take its bearer
    // off the board before they get a swing out of it.
    this.tickStatuses(tickMs);

    // Before anything swings, so a body whose cooldown expires on this tick can
    // spend it on this tick — whether the swing comes from a brain below or from
    // somebody's target above.
    this.advanceCooldowns(tickMs);
    // Beside them, and before the swings for the same reason: a lean that is up
    // this tick has to be gone before a body is given the chance to start
    // another one.
    this.tickStrikes(tickMs);
    // Beside the cooldowns, because it is the same kind of thing: a countdown
    // somebody spent by swinging, winding back down while they do not.
    this.recoverDefensiveDecay(tickMs);
    // And beside that, for the same reason it sits here: a body that stopped
    // swinging has to fall out of the crowd it was part of before anybody rolls
    // against a guard the crowd is no longer pressing on.
    this.forgetSpentAssailants(tickMs);
    // And beside those, before anything is cast: a stone whose last second runs
    // out on this tick is ready on this tick, whether the press comes from a
    // player below or from a charm that fires on its own.
    this.advanceStoneCooldowns(tickMs);
    // After they have been wound down, so a charm that came ready this instant
    // fires this instant rather than a tick late.
    this.fireAutomaticStones();

    // Before the bodies move, so a decision taken now starts its walk on this
    // tick rather than the next.
    // Before the brains, so a partner who walked off this tick is gone by the
    // time a `talking` condition asks.
    this.tickConversations();
    this.tickBrains(tickMs);

    // After the brains, so a creature that decided to close the distance this
    // tick is not also hit by a player's auto-attack before it has moved.
    this.runAutoAttacks();

    for (const actor of this.actors.values()) {
      // Independent of the actor: a shoved object keeps travelling whatever
      // they do next.
      this.tickSlide(actor, tickMs);
      this.tickMotion(actor, tickMs);
    }
    // Before the settle, so a body that rots away this tick drops whatever was
    // resting on it and releases whatever plate it held on the same frame,
    // rather than one settle bleeding into the next.
    this.decay.advance(tickMs);
    this.applyDueDecay();

    // Last, and once for the whole board: plates and channels answer to the
    // board the tick leaves behind, not to any particular actor having caused
    // it. Running this per actor would settle the same plates N times.
    this.settleBoardNow();
  }

  /**
   * Turn everything whose time is up, and re-arm what it turned into.
   *
   * The two halves are applied apart because they are addressed apart: a
   * placement is turned where it stands, and a thing is turned wherever it has
   * got to — see `./decay`. Both feed one reindex, and the kits one
   * {@link setEquipment} each, which is what starts the next leg of a chain:
   * blood to a stain to nothing, a berry to a rotten one to nothing, with no
   * chain to author beyond each tile naming the next.
   */
  private applyDueDecay() {
    const due = this.decay.takeDue();
    if (due.length === 0) return;

    const placements = due.filter(
      (entry): entry is PlacementDecay => entry.kind === "placement",
    );
    const items = due.filter(
      (entry): entry is ItemDecay => entry.kind === "item",
    );

    const turned = applyDecay(this.map, placements, this.tilesById);
    this.map = turned.map;
    const changed = turned.changed;

    // Only when something carried is actually due: this pass walks the whole
    // board looking for the things it names, and a tick where only blood dried
    // has no reason to pay for that.
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

  /**
   * Is anybody here to see it?
   *
   * Brains run only while somebody is connected, and this is the whole test:
   * every actor is either somebody's connection or lives in the map, so "a
   * non-resident exists" is "a player is present" without the session needing
   * to know a socket from a hole in the ground.
   */
  private observed(): boolean {
    for (const actor of this.actors.values()) {
      if (!actor.resident) return true;
    }
    return false;
  }

  /**
   * Let every brain decide, at its own slower cadence.
   *
   * Frozen while nobody is connected, and that is a cost decision rather than a
   * fiction about the world: the tick loop keeps a Durable Object out of
   * hibernation, so a single deer on a five-second timer would hold an empty
   * world awake forever, for nobody. What freezes is *deciding* — a body
   * already mid-step finishes it, because `isAtRest` waits on motion and a step
   * abandoned halfway would checkpoint a creature between two cells, which the
   * whole simulation is written to make impossible.
   *
   * The accumulator is drained rather than reset, so the phase of the brain
   * clock survives a quiet spell instead of restarting on the next join.
   */
  private tickBrains(tickMs: number) {
    if (!this.observed()) {
      // Nobody here to have said it, and nobody left to hear it. Dropping the
      // page rather than keeping it is what stops a word shouted on the way out
      // of the door from greeting the next person to walk in.
      this.pendingHeard = [];
      this.pendingHurt.clear();
      this.pendingSound = [];
      this.endBrainRound();
      return;
    }

    this.brainAccumulatorMs += tickMs;
    if (this.brainAccumulatorMs >= BRAIN_TICK_MS) {
      this.brainAccumulatorMs -= BRAIN_TICK_MS;
      this.openBrainRound();
    }
    this.drainBrainQueue(tickMs);
  }

  /**
   * Open a round: everybody due to think, and what they are deciding against.
   *
   * Opening on the beat whether or not the last round drained is deliberate. A
   * round that overran had more creatures in it than the tick rate could carry,
   * and this round is the one that matters — carrying the stragglers over would
   * have a creature think twice in a row and let the backlog grow without
   * bound. What is dropped is one turn for whoever was at the end of the queue,
   * and the world already treats a missed turn as a thing that happens.
   */
  private openBrainRound() {
    this.roundHeard = this.pendingHeard;
    this.pendingHeard = [];
    this.roundHurt = this.pendingHurt;
    this.pendingHurt = new Map();
    this.roundSounds = this.pendingSound;
    this.pendingSound = [];

    this.brainQueue = [];
    this.brainQueueAt = 0;
    for (const actor of this.actors.values()) {
      if (actor.resident) this.brainQueue.push(actor.id);
    }
  }

  /**
   * Think for a slice of the queue, sized so the round finishes on the beat.
   *
   * What is left over the ticks that are left, recomputed every tick, so it
   * self-corrects: a long frame takes a bigger bite, and a single `tick`
   * spanning a whole round takes the lot — which is what keeps a test that
   * ticks one {@link BRAIN_TICK_MS} seeing every creature decide, exactly as it
   * did when the round was one loop.
   *
   * The queue is walked with a cursor rather than shifted, because shifting a
   * hundred and fifty ids six times a round is the sort of quadratic nobody
   * notices until the map is big enough to feel it — which is the bug this
   * whole change exists to answer.
   */
  private drainBrainQueue(tickMs: number) {
    if (this.brainQueueAt >= this.brainQueue.length) return;

    const remainingMs = Math.max(0, BRAIN_TICK_MS - this.brainAccumulatorMs);
    const ticksLeft = Math.max(1, Math.ceil(remainingMs / Math.max(1, tickMs)));
    const left = this.brainQueue.length - this.brainQueueAt;
    const slice = Math.ceil(left / ticksLeft);

    const end = Math.min(this.brainQueue.length, this.brainQueueAt + slice);
    for (; this.brainQueueAt < end; this.brainQueueAt++) {
      const actor = this.actors.get(this.brainQueue[this.brainQueueAt]!);
      // Gone since the round opened, or no longer somebody the world drives.
      if (!actor?.resident) continue;
      this.tickOneBrain(actor, this.roundSounds);
    }

    if (this.brainQueueAt >= this.brainQueue.length) this.endBrainRound();
  }

  /**
   * The round is spent: every brain in it has had its one chance at what
   * happened.
   *
   * Clearing at all is what keeps these events rather than standing facts about
   * the world — a blow left lying here would be noticed again by whoever thinks
   * next, and a creature would react to it forever.
   */
  private endBrainRound() {
    this.brainQueue = [];
    this.brainQueueAt = 0;
    this.roundHeard = [];
    this.roundHurt.clear();
    this.roundSounds = [];
  }

  /**
   * Somebody said something out loud, for any brain near enough to notice.
   *
   * The server's to call, on the same message it broadcasts as chat — this is
   * the simulation's copy of it, and the only reason the simulation gets one.
   * Words that no creature is listening for cost a push and a clear.
   *
   * Deliberately not called for {@link recordSpeech}: creatures do not hear each
   * other *speak*. They do hear each other's noises, which is a different
   * channel and a deliberate difference — a hiss is a sound the room heard and
   * every animal in it is entitled to react, while an NPC's line is addressed to
   * somebody and putting it in every brain's ear would have a shopkeeper's
   * greeting summon a wolf. @see recordNoise
   */
  hear(speakerId: string, text: string) {
    this.pendingHeard.push({ speakerId, text });
  }

  /**
   * Talk to a body, press a choice, take or refuse a trade, or close the
   * panel — the player's side of a conversation.
   *
   * Every verb re-asks what the client already checked, on the terms every
   * other message is: reach for an `open`, and for a press that there is a
   * conversation and a button at that position. A press on a stale panel —
   * the def reloaded, the button gone — is refused rather than guessed at,
   * and the client learns what is there from the next `conversation`.
   *
   * True when the conversation changed, which is what the wire sends on.
   */
  talk(action: TalkAction, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    if (action.kind === "open") return this.openTalk(actor, action.ref);
    if (action.kind === "close") return this.setConversation(actor, null);

    const current = actor.conversation;
    if (!current) return false;
    const dialog = this.dialogOf(current.npcId);
    // The NPC is gone or has stopped being one that talks: the panel closes
    // rather than answering out of a def that no longer exists.
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

  /** Could this actor open a conversation with the body at this slot? */
  canTalk(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    const loc = actor && this.tryLocate(actor);
    if (!loc) return false;
    return canTalkFrom(this.map, this.tilesById, loc, ref) && this.npcAt(ref) != null;
  }

  private openTalk(actor: ActorRuntime, ref: ObjectRef): boolean {
    const loc = this.tryLocate(actor);
    if (!loc || !canTalkFrom(this.map, this.tilesById, loc, ref)) return false;
    const npc = this.npcAt(ref);
    const dialog = npc && resolveDialog(this.defFor(npc));
    if (!npc || !dialog) return false;
    const view = this.partnerViewFor(actor);
    const body = { id: npc.id, tileId: this.defFor(npc).id };
    return this.setConversation(actor, openConversation(dialog, body, view));
  }

  /**
   * The body standing at this slot, if it is one the runtime drives.
   *
   * Read off the placement's owner rather than searched for, because a
   * placement's owner *is* the actor's id — see `adoptResidents`.
   */
  private npcAt(ref: ObjectRef): ActorRuntime | null {
    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    if (!placed?.owner) return null;
    return this.actors.get(placed.owner) ?? null;
  }

  private dialogOf(npcId: string) {
    const npc = this.actors.get(npcId);
    return npc ? resolveDialog(this.defFor(npc)) : null;
  }

  /**
   * Replace an actor's conversation and note the change for the wire.
   *
   * Replaced wholesale rather than mutated, on the kit's terms: the object
   * goes out on a snapshot and identity is what tells whoever is drawing it
   * that something moved. Closing an already closed one is not a change.
   */
  private setConversation(actor: ActorRuntime, next: Conversation | null): boolean {
    if (actor.conversation === next) return false;
    actor.conversation = next;
    this.conversationChanged.add(actor.id);
    return true;
  }

  /**
   * End every conversation whose partner has walked out of talking reach, or
   * whose NPC has gone.
   *
   * Every tick rather than on the brain's cadence, so a panel closes the
   * moment the player has left rather than a few steps later — and silently,
   * because walking away is its own goodbye.
   */
  private tickConversations() {
    for (const actor of this.actors.values()) {
      const current = actor.conversation;
      if (!current) continue;
      if (this.withinTalkReach(actor, current.npcId)) continue;
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

  /** Is anybody talking to this body? What the brain's `talking` reads. */
  private anyoneTalkingTo(npcId: string): boolean {
    for (const actor of this.actors.values()) {
      if (actor.conversation?.npcId === npcId) return true;
    }
    return false;
  }

  /** One actor's conversation, for the socket that is theirs. */
  conversationOf(id: string): Conversation | null {
    return this.actors.get(id)?.conversation ?? null;
  }

  /**
   * Whose conversation has changed since last asked, and forget.
   *
   * Its own queue beside the kit's and the tags', on the same argument: the
   * server sends each of these to one socket, and a conversation that
   * changed is one whose owner needs the whole of it again.
   */
  drainConversationChanges(): string[] {
    if (this.conversationChanged.size === 0) return [];
    const changed = [...this.conversationChanged];
    this.conversationChanged.clear();
    return changed;
  }

  /**
   * What a press may ask of this partner. Every answer is a rule that lives
   * elsewhere — `./trade`, the tag list, the status list — asked here so the
   * dialog step never holds a kit.
   */
  private partnerViewFor(partner: ActorRuntime): PartnerView {
    return {
      name: () => this.bodyName(partner.id),
      attempt: (effects) => this.attemptDialogEffects(partner.id, effects),
    };
  }

  /**
   * Run an option's effects on the partner, all or none.
   *
   * Planned in full before anything is written: every trade is worked out
   * against the kit the one before it leaves, and a status has to be one the
   * catalogue holds. Only then does the kit change, once, and the statuses and
   * tags land beside it — so an option that both takes payment and grants a
   * status cannot take the payment and fail the status.
   *
   * A status nobody authored refuses here where a potion's grant is skipped
   * silently, because a drink still did something — it was spent — and an
   * option whose whole point was the status did nothing at all. Saying `else`
   * is the honest reading.
   */
  private attemptDialogEffects(
    actorId: string,
    effects: readonly DialogEffectDef[],
  ): boolean {
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

  /** The non-kit half of an effect, once the whole list is known to run. */
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

  /**
   * Take one status off a body, if it is under it.
   *
   * Replaced wholesale on the terms `applyStatus` replaces, so the list going
   * out on a snapshot changes identity; noted for the same reason a grant is.
   */
  private clearStatus(actor: ActorRuntime, statusId: string) {
    if (!actor.statuses.some((s) => s.defId === statusId)) return;
    actor.statuses = actor.statuses.filter((s) => s.defId !== statusId);
    this.noteStatusReading(actor);
  }

  /**
   * Can this body see that cell? Its own height decides what it sees over, so
   * a person clears the crates a rat has to walk around. Shared by the brain
   * and the dialog, so the two never disagree about a wall.
   */
  private canSeeFrom(actor: ActorRuntime, loc: ActorLocation, at: Coord): boolean {
    return hasLineOfSight(
      this.map,
      this.tilesById,
      { x: loc.x, y: loc.y, z: loc.z },
      at,
      this.defFor(actor).height,
    );
  }

  private tickOneBrain(actor: ActorRuntime, sounds: readonly Sound[]) {
    // A body with no brain, or one whose authored brain did not hold together,
    // simply stands there. Resolving is memoised on def identity, so asking
    // every tick costs a map lookup rather than a parse.
    const brain = resolveBrain(this.defFor(actor));
    if (!brain) return;

    const loc = this.locate(actor);
    actor.brain ??= initialMemory(brain);
    stepBrain(brain, actor.brain, BRAIN_TICK_MS, {
      busy: !this.idle(actor),
      rng: this.rng,
      self: { x: loc.x, y: loc.y, z: loc.z },
      home: actor.home,
      nearestOnTile: (tileId) => this.nearestOnTile(actor.id, loc, tileId),
      positionOf: (id) => this.actorCell(id),
      wouldDrop: (direction) => this.stepLeavesGround(loc, direction),
      step: (direction) =>
        this.applyStepRequest(actor, { directions: [direction] }),
      routeTo: (at, allowDrops) => this.routeStep(actor, loc, at, allowDrops),
      say: (text) => this.recordSpeech(actor, loc, text),
      noise: (text) => this.recordNoise(actor.id, loc, text),
      canSee: (at) => this.canSeeFrom(actor, loc, at),
      talking: () => this.anyoneTalkingTo(actor.id),
      // A creature with no stat block minds its own floor, which is what every
      // creature did before this was authorable.
      sight: this.battlerOf(actor)?.sight ?? DEFAULT_BATTLER.sight,
      heard: () => this.roundHeard,
      heardNoise: () => soundsHeardBy(sounds, actor.id),
      hurtBy: () => this.roundHurt.get(actor.id) ?? EMPTY_ATTACKERS,
      attack: (id) => this.tryAttack(actor, id),
      nameOf: (id) => this.bodyName(id),
    });
  }

  /**
   * What a creature calls somebody it is talking about.
   *
   * `bodyNameFor`'s answer and nobody else's, which is the point of routing it
   * here rather than deriving a name inside the brain: the words in a bubble and
   * the label over the head they are about have to agree, and the moment there
   * are two ways to name a body they will not.
   *
   * Null once they are gone — off the board, or never here. A line naming
   * somebody who left still has to be a sentence, so what to say instead is the
   * brain's decision and not this one's.
   */
  private bodyName(id: string): string | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    return bodyNameFor(
      { actorId: id, tileId: loc.placed.tileId },
      this.tilesById,
    );
  }

  /**
   * Note something a creature said, at the cell it said it in.
   *
   * Sanitised here, once, on the same terms a player's message is — so an NPC
   * cannot say anything a person could not, and the bubble a viewer sees is the
   * bubble the rules allow. A line that survives to nothing is simply not
   * recorded; an authored `!` always will.
   *
   * Pinned to the cell and the stack slot, like every bubble, so it hangs over
   * the ground the creature stands on rather than over its own head.
   */
  private recordSpeech(actor: ActorRuntime, loc: ActorLocation, raw: string) {
    const text = sanitizeChatText(raw);
    if (!text) return;
    this.pendingSpeech.push({
      id: `say-${this.nextSpeechId++}`,
      actorId: actor.id,
      tileId: loc.placed.tileId,
      text,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
  }

  /**
   * Note a noise something made, at the cell it was made in.
   *
   * Sanitised on exactly the terms speech is — a noise is drawn text, and text
   * that cannot be drawn is a hole rather than a character somebody is missing.
   * A line that survives to nothing is simply not recorded.
   *
   * Pushed to both lists at once, the way a blow is: the pending one is what the
   * wire wants once, and the live one is what a viewer should still be able to
   * see two seconds from now. That second list is what makes a noise audible in
   * a single-player world, where speech never has been.
   */
  private recordNoise(sourceId: string, loc: ActorLocation, raw: string) {
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
    // A third list, and the only one that knows who made the sound. Nothing
    // drawn is told — that is the whole of what keeps a crunch from arriving as
    // "Amethyst Piranha says: crunch" — but a creature going to look for it
    // needs somebody to walk towards. @see Sound
    this.pendingSound.push({ sourceId, text });
  }

  /** Age the noises out, on the tick clock like every other timer. */
  private ageNoises(tickMs: number) {
    if (this.liveNoise.length === 0) return;
    let expired = false;
    for (const noise of this.liveNoise) {
      noise.elapsedMs += tickMs;
      if (noise.elapsedMs >= NOISE_LIFETIME_MS) expired = true;
    }
    if (expired) {
      this.liveNoise = this.liveNoise.filter(
        (noise) => noise.elapsedMs < NOISE_LIFETIME_MS,
      );
    }
  }

  /**
   * Every noise made this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick} and alongside
   * {@link drainSpeech}. Unlike speech, not draining it is harmless beyond the
   * wire: the live list is what a local viewer reads, and it ages out on its
   * own.
   */
  drainNoise(): NoiseEmission[] {
    const made = this.pendingNoise;
    this.pendingNoise = [];
    return made;
  }

  /**
   * Everything a creature said this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}: it broadcasts each line to
   * the level it was said on, exactly as a player's chat. Nobody else calls it,
   * and the next tick would clear the list regardless — draining is how the
   * speech reaches a wire, not how it is kept from piling up.
   */
  drainSpeech(): ChatBubble[] {
    const said = this.pendingSpeech;
    this.pendingSpeech = [];
    return said;
  }

  /**
   * Everything that took a blow this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}, exactly as
   * {@link drainSpeech} is. A session with no wire — offline `/play` — never
   * drains it, and the per-tick reset keeps that from leaking; the numbers a
   * local viewer sees come from {@link getSnapshot} instead.
   */
  drainDamage(): DamageNumber[] {
    const dealt = this.pendingDamage;
    this.pendingDamage = [];
    return dealt;
  }

  /**
   * Every shot loosed this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}, exactly as
   * {@link drainDamage} is. An offline `/play` never drains it and reads
   * {@link liveProjectiles} through {@link getSnapshot} instead — the same split
   * damage numbers are under.
   */
  drainProjectiles(): ProjectileFlight[] {
    const loosed = this.pendingProjectiles;
    this.pendingProjectiles = [];
    return loosed;
  }

  /**
   * Everybody who went through a teleport this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}, exactly as
   * {@link drainDamage} is — and an offline `/play` never does, which costs
   * nothing: the local viewer reads the board directly and has no prediction to
   * invalidate.
   */
  drainTeleports(): string[] {
    const travelled = this.pendingTeleports;
    this.pendingTeleports = [];
    return travelled;
  }

  /**
   * Everybody who threw a blow this tick, handed over and forgotten.
   *
   * The server's to call, right after {@link tick}, exactly as
   * {@link drainTeleports} is — and an offline `/play` never does, which costs
   * nothing: the local simulation *is* the thing holding the recovery, so there
   * is no second guess anywhere for this to correct.
   *
   * Not recoverable from two readings of anything, which is why it is drained
   * rather than diffed: a recovery is a number winding down, and a body that
   * swung again a tick before the last one expired looks identical from
   * outside to one that never did.
   */
  drainSwings(): string[] {
    const swung = this.pendingSwings;
    this.pendingSwings = [];
    return swung;
  }

  /**
   * Everybody whose body ran out of hit points this tick, handed over once.
   *
   * Not cleared by the next tick, unlike speech and damage: a death is the one
   * thing here the caller *must* not miss — a server that dropped one would put
   * the actor back on the board at the next wake, undoing it, and would never
   * hear what the body was carrying when it stopped existing.
   */
  drainDeaths(): Death[] {
    const died = this.pendingDeaths;
    this.pendingDeaths = [];
    return died;
  }

  /**
   * Wind every cooldown down towards its next swing, and every recovery down
   * towards its next step.
   *
   * The two together because they are the same kind of clock started by the
   * same act — see {@link ActorRuntime.attackRecoveryMs} for why they are not
   * the same number.
   */
  private advanceCooldowns(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.attackCooldownMs > 0) {
        actor.attackCooldownMs = Math.max(0, actor.attackCooldownMs - tickMs);
      }
      if (actor.attackRecoveryMs > 0) {
        actor.attackRecoveryMs = Math.max(0, actor.attackRecoveryMs - tickMs);
      }
      this.advanceExtractCooldowns(actor, tickMs);
    }
  }

  /**
   * Wind one actor's resource waits down, and strike off the ones that are up.
   *
   * Beside the swing cooldowns because it is the same kind of clock — a wait
   * started by an act, wound by the tick, read to decide whether the act may
   * happen again — and folded into the same pass so a tick walks the actors
   * once.
   *
   * **Only the start and the end are announced.** The winding itself is silent,
   * because the entries are wound *in place* and everybody downstream is
   * already holding them — see {@link ExtractCooling}. A message goes out when
   * a wait begins and one when it ends, and nothing in between; the bar drawn
   * under the row fills on its own from the two numbers it was given.
   *
   * The great majority of actors hold no map at all and pay one null check.
   */
  private advanceExtractCooldowns(actor: ActorRuntime, tickMs: number) {
    const cooldowns = actor.extractCooldowns;
    if (!cooldowns) return;
    let expired = false;
    for (const [key, entry] of cooldowns) {
      entry.remainingMs -= tickMs;
      if (entry.remainingMs > 0) continue;
      // Floored rather than left negative: whatever draws the wait reads this
      // as a fraction of the whole, and a frame of an over-full bar between the
      // last tick and the rebuild below is a frame of nonsense.
      entry.remainingMs = 0;
      cooldowns.delete(key);
      expired = true;
    }
    if (expired) this.setExtractCooldowns(actor, cooldowns);
  }

  /**
   * Hold an actor's waits, and keep the list beside them true.
   *
   * The one place either is written, on the terms {@link setEquipment} is the
   * one place a kit is: the map is what the rules ask and the array is what the
   * snapshot and the wire carry, and a change to one without the other would be
   * a row that never comes back or one offered on a resource still counting.
   *
   * The array holds **the map's own entries**, so this runs on the two events
   * that change the *set* and never on the ticks in between.
   *
   * An emptied map is dropped rather than kept, so a player who worked one bush
   * an hour ago is back to costing one null check on every tick.
   */
  private setExtractCooldowns(
    actor: ActorRuntime,
    cooldowns: Map<string, ExtractCooling>,
  ) {
    const empty = cooldowns.size === 0;
    actor.extractCooldowns = empty ? null : cooldowns;
    actor.extractCooling = empty ? NO_COOLING_LIST : [...cooldowns.values()];
    this.extractCoolingChanged.add(actor.id);
  }

  /**
   * Wind every stone that is cooling down by whatever whole seconds have passed.
   *
   * **In whole seconds rather than per tick**, and that is a decision worth the
   * paragraph. A cooldown lives on an {@link ItemInstance}, so winding one means
   * replacing the kit that holds it — and the kit's *identity* is what tells the
   * renderer its panel is stale and what tells the server there is an equipment
   * message to send. Wound thirty times a second, a single cooling stone would
   * re-render the page and put a whole inventory on the wire thirty times a
   * second, for ever, for a number nothing on screen can show that finely.
   *
   * A second is the grain a countdown is drawn at — the same grain a status lane
   * is compared at, for the same reason — so it is the grain the truth is kept
   * at too. What it costs is that a cooldown which is not a whole number of
   * seconds finishes up to a second late; every stone worth authoring is, and
   * the schema's floor is a second.
   *
   * The accumulator is **drained rather than reset**, on the terms a status's
   * cadence is: `update` runs up to ten ticks in one call, and a stone owes every
   * second of that catch-up rather than the last one.
   */
  private advanceStoneCooldowns(tickMs: number) {
    this.stoneClockMs += tickMs;
    if (this.stoneClockMs + COOLDOWN_EPSILON_MS < COOLDOWN_STEP_MS) return;

    // Whole steps only; whatever is left over rides on to the next tick, so the
    // clock never drifts against the loop.
    const steps = Math.floor(
      (this.stoneClockMs + COOLDOWN_EPSILON_MS) / COOLDOWN_STEP_MS,
    );
    this.stoneClockMs -= steps * COOLDOWN_STEP_MS;
    const spent = steps * COOLDOWN_STEP_MS;

    for (const actor of this.actors.values()) {
      const next = cooledEquipment(actor.equipment, spent);
      // The same object back whenever nothing was cooling, which is almost every
      // body almost always: no allocation, no message, no re-render.
      if (next === actor.equipment) continue;
      this.setEquipment(actor, next);
    }
  }

  /**
   * Let every charm that fires on its own do so, for whoever is wearing one.
   *
   * The charm square alone, because {@link handAccepts} refuses an automatic
   * stone a hand: a hand is a thing you act with, and one that acted by itself
   * would be a body casting spells nobody asked it to.
   *
   * Everything about *whether* is asked by the same two pure functions a pressed
   * cast goes through — `castability` for whether it is allowed, `automaticFires`
   * for whether the moment is right — so a passive and a button are the same act
   * with a different finger on it. @see ./casting
   */
  private fireAutomaticStones() {
    for (const actor of this.actors.values()) {
      const held = actor.equipment.charm;
      if (!held || held.cooldownMs) continue;
      const def = this.tilesById[held.tileId];
      const stone = def ? resolveStone(def) : null;
      if (!stone?.automatic) continue;

      const stats = this.battlerOf(actor);
      const hp = this.hpOf(actor);
      if (!stats || hp === null) continue;
      if (
        !automaticFires(stone, {
          hp,
          maxHp: stats.maxHp,
          statusIds: actor.statuses.map((instance) => instance.defId),
        })
      ) {
        continue;
      }
      this.cast("charm", actor.id);
    }
  }

  /**
   * Age every lean, and drop the ones that are home.
   *
   * Beside {@link advanceCooldowns} and before anything swings, which is what
   * lets a strike started on this tick begin at zero rather than a tick in — the
   * body's own motions are ticked at the bottom of the tick, and a strike put
   * there would lose its first frame to the swing that created it.
   */
  private tickStrikes(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (!actor.strike) continue;
      actor.strike.elapsedMs += tickMs;
      // Nothing to commit — the body never left the cell it is standing in, so
      // dropping the state is the whole of "recovered".
      if (actor.strike.elapsedMs >= STRIKE_DURATION_MS) actor.strike = null;
    }
  }

  /**
   * Swing for everybody in attack mode who has picked a fight and is standing
   * close enough.
   *
   * Auto rather than per click, because {@link FightingStats.spd} is what decides
   * how often a body swings. A client that had to ask for each blow would be
   * asking for permission it is going to be refused most of the time, and a
   * client that asked *faster* would gain nothing — which is precisely the
   * property worth having on a wire anybody can write to.
   *
   * Failing quietly is the whole behaviour here: out of reach, on cooldown, or
   * aimed at something with no hit points all simply do not swing. Only a target
   * that has left the world is worth clearing, because a slot pointing at
   * nobody would keep this looking them up forever — and that clearing happens
   * whether or not anybody is swinging, since a target outlives the mode.
   */
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

  /**
   * One body swings at another, if every reason not to is absent.
   *
   * The single path from "somebody wants to attack" to a blow, whether the
   * wanting came from a brain's `attack` action or from a player's standing
   * target. Returning false rather than throwing at each refusal is what lets
   * the brain's priority list fall through — see the `attack` action.
   */
  private tryAttack(attacker: ActorRuntime, targetId: string): boolean {
    if (attacker.attackCooldownMs > 0) return false;
    if (targetId === attacker.id) return false;

    const target = this.actors.get(targetId);
    if (!target) return false;

    // Both ends have to be battlers, and reading it off the body is what makes
    // "attack anything, fail graciously" true: swinging at a crate is a lookup
    // that comes back null, not a special case anybody had to write.
    const attackerStats = this.battlerOf(attacker);
    const targetStats = this.battlerOf(target);
    if (!attackerStats || !targetStats) return false;

    const from = this.tryLocate(attacker);
    const to = this.tryLocate(target);
    if (!from || !to) return false;
    const fromPoint = this.reachPointOf(from);
    const toPoint = this.reachPointOf(to);
    // The weapon's own reach, not a constant and not the body's: a bow and a
    // fist ask the same question with different numbers, and the number belongs
    // to whatever is being swung. `canReach` is also where the wall costs
    // something — a target picked through a window stays picked, and the shot
    // simply does not go.
    if (
      !canReach(this.map, this.tilesById, fromPoint, toPoint, attackerStats.reach)
    ) {
      return false;
    }

    // Spent whether or not the blow connects: the swing happened, and a dodge
    // that cost the attacker nothing would let a fast creature flail for free.
    // The interval is this hand's own — a dagger's turn is a dagger's wait, so a
    // body alternating a dagger and an axe keeps an uneven rhythm rather than
    // averaging into one that belongs to neither.
    const interval = swingIntervalMs(attackerStats);
    attacker.attackCooldownMs = interval;

    // Read before the rotation moves and carried down, rather than asked again
    // where the experience is settled: that would be the *next* hand's weapon
    // teaching the wielder, and a body alternating a blade and a hammer would
    // spend the whole fight training the wrong mastery.
    const swung = this.handOf(attacker);
    // Advanced on the swing rather than on the blow landing, on exactly the
    // terms the cooldown above is spent: a hand that has taken its turn has
    // taken it, and a miss that let you swing the same weapon again would make
    // the better one of two worth flailing with.
    attacker.nextHand = swung ? otherHand(swung) : attacker.nextHand;

    // And the body is planted for exactly one of its own steps, on the same
    // terms and for the balance the cooldown alone could not buy: see
    // {@link ActorRuntime.attackRecoveryMs}. Announced as well as stored,
    // because the one client that predicts its own footwork has to refuse the
    // same steps this side is about to — a browser that walked through its
    // recovery would spend the whole fight being told to walk back.
    attacker.attackRecoveryMs = resolveWalkDurationMs(this.defFor(attacker));
    this.pendingSwings.push(attacker.id);

    // Thrown before the dice, and on the same grounds the cooldown is spent
    // before them: what the lean says is *this body swung at that one*, which is
    // true of a miss, a dodge and a blow that armour ate. A strike a player only
    // saw on the blows that landed would be a fight where half the traffic came
    // from nowhere. Null past arm's length — see `./strike`.
    //
    // Unless this body has just got out of somebody else's way, which is the one
    // thing that outranks its own swing. @see outranksSwing
    if (!outranksSwing(attacker.strike)) {
      attacker.strike = swingToward(
        fromPoint,
        toPoint,
        isRanged(attackerStats),
      );
    }

    // Beside the lean rather than instead of it, and on the same terms: the two
    // are the same announcement — *this body attacked that one* — made by
    // whichever half of the pair the weapon has. Loosed before the dice, so a
    // shot that misses is a shot somebody saw taken; an arrow that only appeared
    // on the blows that landed would be a fight where half the traffic came from
    // nowhere.
    this.fireProjectile(attackerStats.projectile, fromPoint, toPoint);

    // Turning into the blow, so a creature that fights while cornered is facing
    // what it is fighting. Free when it already is — `setEntityDirection` guards
    // the no-op, which matters because this runs on every swing.
    const facing = facingToward(from, to);
    if (facing) {
      this.map = setEntityDirection(
        this.map,
        from.x,
        from.y,
        from.z,
        from.stackIndex,
        facing,
      );
    }

    // Counted before the dice and including this swing, so the body throwing it
    // is one of the ones bearing down on the target: a lone attacker is an
    // assailant of one and `underPressure` hands the stats straight back. Its own
    // interval is what buys it a place in the count — see `ASSAILANT_GRACE_MS`.
    const assailants = this.noteAssailant(target, attacker.id, interval);
    const outcome = rollAttack(
      attackerStats,
      underPressure(targetStats, assailants),
      this.rng,
    );
    // Noted even on a dodge: what a creature reacts to is being swung at, and a
    // cat that only fought back when a blow landed would stand there being
    // missed. Before the damage, so a killing blow still tells the room.
    this.notePendingHurt(target.id, attacker.id);
    // Before the damage too, so the killing blow pays for itself — a body that
    // has already left the board has no experience to be given.
    this.awardExperience(attacker, target, outcome, swung);

    if (outcome.missed) {
      this.floatSwing(target, "miss", 0);
      return true;
    }
    if (outcome.dodged) {
      // The whole of what a dodge says now. No receipt floats: the hop is the
      // account, and a word beside it would be the same event told twice.
      target.strike = dodgeAway(toPoint, fromPoint);
      return true;
    }

    this.applyDamage(target, outcome.damage);
    // After the damage, and only for a body still standing: a status is a
    // condition you are *in*, and a corpse is not in one. Putting venom on
    // something the same blow killed would queue an announcement about a body
    // that has already left the board.
    if (outcome.inflicted.length > 0 && (this.hpOf(target) ?? 0) > 0) {
      for (const grant of outcome.inflicted) this.grantStatus(target, grant);
    }
    return true;
  }

  /**
   * Put a projectile in the air, if there is one to put there.
   *
   * Silently nothing for a melee weapon and for a bolt that simply arrives,
   * which between them are the overwhelming majority and are not a special case
   * anybody had to write: `projectile` is absent, so there is nothing to loose.
   * That is the same shape the lean above has in reverse, and between them every
   * weapon says exactly one thing about itself.
   *
   * **The block is passed in rather than read off a `FightingStats`**, which is
   * what lets a spell use this at all: a bolt has a projectile and no fighting
   * stats to hang it on — it is not swung, and resolving one for a caster would
   * be inventing a weapon nobody is holding. What is in the air owes nothing to
   * what threw it, which was already this module's own note.
   *
   * The flight is queued twice for the reason a damage number is — see
   * {@link pendingDamage} and {@link liveDamage}. One list is "what happened in
   * the last tick", which the wire drains once; the other is "what a viewer
   * should still be able to see", which outlives it by the length of the flight.
   */
  private fireProjectile(
    projectile: ProjectileDef | null | undefined,
    from: ReachPoint,
    to: ReachPoint,
  ) {
    if (!projectile) return;

    const flight: ProjectileFlight = {
      id: `shot-${this.nextProjectileId++}`,
      tileId: projectile.tileId,
      // Copied rather than handed over, because both ends are `reachPointOf`
      // results measured against a board that is about to move: the arrow owes
      // nothing to where either body ends up while it is in the air.
      from: { x: from.x, y: from.y, elevAbs: from.elevAbs },
      to: { x: to.x, y: to.y, elevAbs: to.elevAbs },
      durationMs: flightDurationMs(from, to, projectile),
      elapsedMs: 0,
    };
    this.pendingProjectiles.push(flight);
    this.liveProjectiles.push(flight);
  }

  /**
   * Float a receipt off a body for one swing, whatever the swing came to.
   *
   * The cell travels with it rather than the actor id alone, because by the time
   * anything draws this the body may be gone — a killing blow deletes its target
   * on the same tick, and the number is the only thing left saying what
   * happened.
   *
   * Silently does nothing for a body that cannot be located, which is the honest
   * answer: a receipt has to hang somewhere, and there is nowhere to hang it.
   */
  private floatSwing(
    target: ActorRuntime,
    outcome: SwingOutcome,
    amount: number,
  ) {
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

  /**
   * Pay both sides of one swing whatever it taught them.
   *
   * **Scaled by how the two bodies compare, and each side sees its own ratio.**
   * The rat learns nothing from a player it could never beat and the player
   * learns nearly nothing from the rat, from one and the same blow — which is
   * the whole of what makes the world a ladder rather than a place to grind the
   * first thing you meet.
   *
   * Silent for a creature on either side. Only a player has experience to be
   * given, and asking that question here rather than inside the arithmetic keeps
   * `./experience` a set of pure functions about a swing.
   */
  private awardExperience(
    attacker: ActorRuntime,
    target: ActorRuntime,
    outcome: AttackOutcome,
    /**
     * The hand that actually threw this blow, or null for bare hands.
     *
     * Passed in rather than read here, because the rotation has already moved on
     * by the time this runs — see {@link tryAttack}. What a swing teaches is a
     * fact about the weapon that swung.
     */
    swung: Hand | null,
  ) {
    // A miss pays nobody, so there is nothing to work out. Worth the early
    // return rather than falling through the two arithmetics below to zero:
    // this runs on every swing in the world.
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
            body.masteries,
            experienceMultiplier(targetRating, attackerRating),
          ),
        );
      }
    }

    // The multiplier before the decay, and the early return is the point: a rat
    // gnawing somebody far above it pays nothing whatever the decay says, and
    // spending a payout on it would charge that player for a blow they were
    // never going to be paid for.
    const defensive = experienceMultiplier(attackerRating, targetRating);
    if (!target.resident && defensive > 0) {
      this.grantExperience(
        target,
        defenderEarnings(
          outcome,
          defensive,
          this.spendDefensiveDecay(target, attacker.id),
        ),
      );
    }
  }

  /**
   * Pay the arcanist whose spell dealt this damage, if a spell dealt it.
   *
   * **The whole of how a conjured flame earns its caster experience** — story by
   * story the longest thread in the feature, and it comes down to this: a stone
   * conjures a tile, the tile puts a status on whoever walks into it, the status
   * remembers who is answerable, and this is where that memory is spent.
   *
   * Three refusals, and each is a rule rather than a guard:
   *
   * - **Nobody is answerable.** Every burn, poison and rot in the world that
   *   nobody cast behaves exactly as it did before any of this existed.
   * - **The caster is the victim.** Setting yourself on fire teaches you
   *   nothing, or training would be a thing you do to yourself in a corner.
   * - **The caster has left the world.** A name that no longer belongs to
   *   anybody is out of date rather than corrupt, on the terms every other stale
   *   id in this game is honoured.
   *
   * The stone is not consulted, because there may not be one any more: by the
   * time a flame burns somebody the caster may have put the stone down, swapped
   * it, or died holding it. What is being paid for is the damage, so the rate is
   * the plain one — a caster who has outgrown their own fire is a refinement
   * with nowhere to read the requirement from.
   */
  private awardCausedDamage(
    victim: ActorRuntime,
    causedBy: string | undefined,
    damage: number,
    /**
     * What the spell was made of, so the elements it is made of are paid too.
     *
     * Off the status rather than off the stone, because there may be no stone
     * left to ask — @see `./statuses`'s {@link StatusInstance.elements}.
     */
    elements: readonly Element[],
  ) {
    if (!causedBy || causedBy === victim.id || damage <= 0) return;
    const caster = this.actors.get(causedBy);
    if (!caster || caster.resident) return;

    const casterRating = this.ratingOf(caster);
    const victimRating = this.ratingOf(victim);
    if (casterRating === null || victimRating === null) return;

    this.grantCasting(
      caster,
      damage,
      undefined,
      elements,
      experienceMultiplier(victimRating, casterRating),
    );

  }

  /**
   * Pay a caster for what one spell came to, in the masteries casting trains.
   *
   * One door for all three ways a spell can be worth something — damage it dealt
   * on the spot, health it actually restored, and damage something it conjured
   * dealt later — so the scale and the learning rate cannot come to differ
   * between them. @see `./experience`'s `casterEarnings`
   *
   * The stone is optional because the indirect case has none to offer; a spell
   * with no requirement to read teaches at the full rate, which is what
   * `learningRate` means by a requirement of zero. The elements travel
   * separately for that same reason — they survive the stone.
   */
  private grantCasting(
    caster: ActorRuntime,
    amount: number,
    stone: ArcaneStoneItem | undefined,
    elements: readonly Element[],
    multiplier: number,
  ) {
    const body = this.bodyOf(caster);
    if (!body) return;
    this.grantExperience(
      caster,
      casterEarnings(
        amount,
        stone?.requirements,
        elements,
        body.masteries,
        multiplier,
      ),
    );
  }

  /**
   * Add experience to a body, and forget whatever was derived from the old
   * figures.
   *
   * The single place experience is written, which is what makes the memo above
   * safe: there is no way to move a mastery without the body built from it being
   * dropped in the same statement.
   */
  private grantExperience(actor: ActorRuntime, earned: MasteryXp) {
    const xp = actor.masteryXp;
    if (!xp) return;

    // Copied lazily, so a swing that taught nothing costs no allocation — which
    // is most of them, once a player has outgrown what they are fighting.
    let moved: MasteryXp | null = null;
    // Crossings are collected rather than said as they are found, so nothing is
    // announced until the whole block is known to be going in — see below.
    let crossed: Mastery[] | null = null;
    for (const mastery of MASTERIES) {
      const amount = earned[mastery];
      if (!amount) continue;
      moved ??= { ...xp };
      const before = moved[mastery] ?? 0;
      const after = before + amount;
      moved[mastery] = after;
      // Read here rather than diffed later: this is the one place both totals
      // for one mastery exist at once, and earning is the only thing that moves
      // one. A body *seeded* with masteries never comes through here, which is
      // why announcing at the source needs no baseline to be quiet about.
      if (levelForXp(after) > levelForXp(before)) (crossed ??= []).push(mastery);
    }
    if (!moved) return;

    actor.masteryXp = moved;
    actor.earnedBody = null;
    this.masteriesChanged.add(actor.id);
    // After the write, on the same rule the reward's line follows: a sentence is
    // a receipt, and a receipt printed ahead of the thing it receipts is a lie
    // waiting for an early return to be added above it.
    for (const mastery of crossed ?? []) {
      this.say(actor.id, masteryNotice(mastery, levelForXp(moved[mastery] ?? 0)));
    }
  }

  /**
   * What the next defensive payout from this attacker is worth, counting it as
   * taken.
   *
   * Per attacker rather than per victim, because the thing being paced is one
   * body farming another: a fight against something new starts at full rate
   * however long you have just spent being chewed on by a rat.
   */
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

  /**
   * Forgive one payout for every stretch an attacker has left a body alone, and
   * forget them entirely once they are square.
   *
   * Aged on the tick clock like every other timer here rather than stamped with
   * a time and compared later, so it agrees with the rest of the session about
   * how long a second is — and so a world nobody is ticking does not quietly
   * recover while it sleeps.
   */
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

  /**
   * Count this body among the ones swinging at that one, and say how many that
   * now is.
   *
   * The window is the attacker's own swing interval plus the grace on top, set
   * afresh on every blow — so anything that keeps swinging keeps its place in the
   * count, and anything that wanders off loses it one interval later without
   * anybody having to notice it left. @see ASSAILANT_GRACE_MS
   *
   * Returns the size rather than the map, because the size is the only thing the
   * rule wants and handing out the map is handing out something a caller can
   * quietly hold past the tick it was true in.
   */
  private noteAssailant(
    target: ActorRuntime,
    attackerId: string,
    swingMs: number,
  ): number {
    const onMe = (target.assailants ??= new Map());
    onMe.set(attackerId, swingMs + ASSAILANT_GRACE_MS);
    return onMe.size;
  }

  /**
   * Drop everything that has gone quiet for longer than it had left, and forget
   * the map entirely once nobody is on this body.
   *
   * Wound down on the tick clock rather than stamped and compared, exactly as
   * {@link recoverDefensiveDecay} is and for the same reasons.
   */
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

  /** Remember who hit whom, for the brains' next round of decisions. */
  private notePendingHurt(targetId: string, attackerId: string) {
    const attackers = this.pendingHurt.get(targetId);
    if (attackers) attackers.push(attackerId);
    else this.pendingHurt.set(targetId, [attackerId]);
  }

  /**
   * Take hit points off a body, and take the body off the board if that empties
   * it.
   *
   * The number is recorded before the death, and carries the cell rather than
   * relying on the actor still being findable: by the time anything draws it,
   * the body it came off may be gone.
   */
  private applyDamage(target: ActorRuntime, amount: number) {
    const before = this.hpOf(target);
    if (before === null) return;

    this.floatSwing(target, "hit", amount);

    const after = before - amount;
    target.hp = Math.max(0, after);
    if (target.hp === 0) this.kill(target);
  }

  /**
   * Take a body off the board for good, and leave what it was carrying where it
   * fell.
   *
   * The tile goes and so does the runtime, which for a player is exactly the
   * intent: with no actor by that name the server ignores everything their
   * socket sends, so a dead player sits there connected and can do nothing —
   * which is what the death screen is drawn over. The one thing that gets past
   * that gate is the request for a body back; see `GameServer.rebirth`. There
   * is still no automatic respawn: coming back is something they ask for.
   *
   * **The kit does not go with the runtime.** It is dropped onto the corpse's
   * cell first, so a sword somebody picked up a moment ago is still a sword in
   * the world — findable, and theirs again if they walk back for it. The
   * alternative is not "death costs you your things", it is the world quietly
   * being one sword lighter, which nothing in it can ever put right.
   *
   * Everyone aiming at them is released here rather than discovering it later,
   * so nothing is left swinging at a slot that can never be filled again.
   */
  private kill(target: ActorRuntime) {
    // Before the body comes off the board, which is what makes it unfindable.
    const loc = this.tryLocate(target);

    this.actors.delete(target.id);
    this.forgetTileIndex();
    this.map = despawnActor(this.map, target.id);
    this.pendingHurt.delete(target.id);
    for (const actor of this.actors.values()) {
      if (actor.targetId === target.id) actor.targetId = null;
      // A corpse presses on nobody's guard. It would time out on its own within
      // the grace, and waiting for that would mean the last swing of a fight you
      // just won was still fought outnumbered.
      actor.assailants?.delete(target.id);
    }

    // After the despawn, so the pile lands in the room the corpse just made
    // rather than being refused for the volume the body was still taking up.
    const equipment = loc
      ? this.dropKit(target.equipment, loc)
      : target.equipment;

    this.pendingDeaths.push({
      id: target.id,
      equipment,
      masteryXp: target.masteryXp,
      tags: target.tags,
    });

    // The cell they were standing in has lost a body and gained a pile, both of
    // which are real changes to what rests on a plate and to what is holding a
    // crate up.
    if (loc) this.reindexCells([{ x: loc.x, y: loc.y, z: loc.z }]);
  }

  /**
   * Put a whole kit on the floor of one cell, and say what is left of it.
   *
   * All or nothing, unlike a player's {@link drop}, which places one thing and
   * can be told no. A half-dropped kit would leave the server with no single
   * true answer to "what does this body still own" — some of it on the board,
   * some of it owed — and the two halves are written to different keys, so a
   * disagreement between them is an item existing twice or not at all. Refusing
   * the whole pile keeps the kit intact instead: nothing reached the floor, so
   * the dead still own all of it and come back carrying it.
   *
   * In practice the cell has just lost a body and every carried thing is
   * height-less, so the refusal is a guard rather than a path — but it is the
   * guard that lets the caller trust what comes back.
   *
   * No settle here: the tick runs one pass over the whole board after everything
   * that moved it, and a kit dropped over a hole falls into it there, by exactly
   * the rule a shoved crate follows.
   */
  private dropKit(equipment: Equipment, at: Coord): Equipment {
    const carried = wornInstances(equipment);
    if (carried.length === 0) return equipment;

    const placements = carried.map(placementFromInstance);
    const stack = getStack(this.map, at.x, at.y, at.z);
    const room = canReplaceStack(
      this.map,
      at.x,
      at.y,
      at.z,
      [...stack, ...placements],
      this.tilesById,
    );
    if (!room.ok) return equipment;

    for (const placed of placements) {
      // Pouring, like every other way an item reaches a cell: a body that dies
      // holding food where food is already lying leaves one pile behind. The
      // room check above is unaffected — a pour adds no placement at all, so it
      // asks for strictly more room than what actually happens needs.
      this.map = appendItem(this.map, at.x, at.y, at.z, placed, this.tilesById);
    }
    return emptyEquipment();
  }

  /**
   * Age the arrows out, on the tick clock like every other timer.
   *
   * A flight that has arrived is simply dropped: there is nothing to commit
   * because there was never anything to commit — the blow it depicts was settled
   * on the tick it was loosed. @see `./projectile`
   */
  private ageProjectiles(tickMs: number) {
    if (this.liveProjectiles.length === 0) return;
    let arrived = false;
    for (const flight of this.liveProjectiles) {
      flight.elapsedMs += tickMs;
      if (flight.elapsedMs >= flight.durationMs) arrived = true;
    }
    if (arrived) {
      this.liveProjectiles = this.liveProjectiles.filter(
        (flight) => flight.elapsedMs < flight.durationMs,
      );
    }
  }

  /** Age the floating numbers out, on the tick clock like every other timer. */
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

  /**
   * The stat block of whatever body this actor is in, equipment counted, or
   * null for a body with no stats at all.
   *
   * **The single place stats are answered**, which is what makes a weapon apply
   * everywhere without anything else having to remember to ask: the swing reads
   * it, the cooldown reads it, and the health bar's maximum reads it. A second
   * caller of `resolveBattler` would be a body that fights with its sword and
   * one that does not, depending on who asked.
   */
  private battlerOf(actor: ActorRuntime): FightingStats | null {
    const base = this.baseBattlerOf(actor);
    if (!base) return null;
    return withStatusModifiers(
      base,
      actor.statuses,
      this.statusDefs,
      // The stored figure rather than {@link hpOf}, which reads *this* function
      // and would loop. Statuses that read `HP` therefore see the raw number,
      // which is what a formula wants anyway: the clamp exists so a lowered
      // maximum cannot leave somebody overfull, not to change what they have.
      actor.hp ?? base.maxHp,
    );
  }

  /**
   * The same block **before any status has touched it**.
   *
   * Split out because it is what a status formula's `MAX_HP` has to read: a
   * status that raises maximum health and heals a share of it would otherwise
   * compound against itself once a second, and each of those readings would be a
   * fraction of the last. See `../lib/formula`.
   *
   * It is also the only honest input to `withStatusModifiers`, which sums deltas
   * onto a base — folding statuses into their own input would apply them twice.
   */
  private baseBattlerOf(actor: ActorRuntime): FightingStats | null {
    const body = this.bodyOf(actor);
    if (!body) return null;
    return effectiveBattler(
      body,
      actor.equipment,
      this.tilesById,
      this.handOf(actor),
    );
  }

  /**
   * Which hand this body is about to swing with, or null for one swinging what
   * it was born with.
   *
   * **A read and never a write**, which is what lets {@link battlerOf} stay
   * something a health bar can ask sixty times a second: the rotation only
   * advances where a swing is actually spent, in {@link tryAttack}. A body being
   * *looked at* is not taking turns.
   */
  private handOf(actor: ActorRuntime): Hand | null {
    return handToSwing(actor.equipment, this.tilesById, actor.nextHand);
  }

  /**
   * Put a status on somebody, by id.
   *
   * An id the catalogue does not hold is skipped, in the same breath a reward
   * naming a missing tile is left alone: renamed content should read as an effect
   * that did not happen, not as a world that will not start.
   *
   * The dice are the world's own — see `./statuses`.
   */
  private grantStatus(
    actor: ActorRuntime,
    grant: StatusGrant,
    /**
     * Who is answerable for it, when anybody is.
     *
     * Absent for a berry, a bite and every hearth in the world, which is nearly
     * every call — see `./statuses`'s {@link StatusInstance.causedBy}, which is
     * where "no cause behaves exactly as it always did" is written down.
     */
    causedBy?: string,
    /**
     * What the spell doing it is made of, when a spell is doing it.
     *
     * Absent on every call but the two that come from a cast, which is what
     * keeps a berry, a bite and a hearth neutral on the wheel — see
     * `./statuses`'s {@link StatusInstance.elements}.
     */
    elements?: readonly Element[],
  ) {
    const def = this.statusDefs[grant.id];
    if (!def) return;
    // The item's range where it states one, and the status's own otherwise —
    // see `../lib/item`'s `StatusGrant`. Both ends or neither, so this
    // cannot end up ordering one source's floor against another's ceiling.
    const range =
      grant.fromMs === undefined || grant.toMs === undefined
        ? def
        : { fromMs: grant.fromMs, toMs: grant.toMs };
    actor.statuses = applyStatus(
      actor.statuses,
      def,
      this.rng,
      range,
      causedBy,
      elements,
    );
    // Noted here as well as on the tick, because eating happens *between* ticks
    // and the world may be asleep when it does — the same reason the kit is
    // flushed wherever it can change rather than only on the loop.
    this.noteStatusReading(actor);
  }

  /**
   * Queue an announcement if what this actor's statuses say has changed.
   *
   * Idempotent, and cheap on the overwhelmingly common path: a body under
   * nothing reads as the empty string, which is what it read as last time.
   */
  private noteStatusReading(actor: ActorRuntime) {
    const reading = statusReading(actor.statuses);
    if (this.statusReadings.get(actor.id) === reading) return;
    this.statusReadings.set(actor.id, reading);
    this.statusesChanged.add(actor.id);
  }

  /**
   * Advance everything running on everybody, and pay out whatever came due.
   *
   * In the tick's own order rather than folded into another pass, because what it
   * does is neither motion nor a fight: a status can heal, harm, kill, and change
   * the numbers the swing three lines further down is fought with.
   *
   * **The two directions leave by different doors**, and that is the whole reason
   * `./statuses` hands back signed figures rather than a net. A harm goes through
   * {@link applyDamage} so it shows its number, tells the brains and can kill —
   * a death by poison and a death by blows must not be two codepaths to keep
   * alive. A heal clamps at the maximum, exactly as a consumable's does.
   */
  private tickStatuses(tickMs: number) {
    for (const actor of this.actors.values()) {
      if (actor.statuses.length === 0) continue;

      const base = this.baseBattlerOf(actor);
      if (!base) continue;

      const { statuses, hpChanges } = advanceStatuses(
        actor.statuses,
        tickMs,
        { hp: this.hpOf(actor) ?? base.maxHp, maxHp: base.maxHp },
        this.statusDefs,
      );
      actor.statuses = statuses;
      this.noteStatusReading(actor);

      for (const change of hpChanges) {
        if (change.amount < 0) {
          const damage = this.elementalDamage(
            actor,
            -change.amount,
            change.elements,
          );
          this.applyDamage(actor, damage);
          // Paid before the death check below, on the same terms a killing blow
          // pays for itself: the arcanist who lit the fire earns from the last
          // point of damage it did, and a body that has already left the board
          // has nobody to pay. Paid on what the wheel made of it rather than on
          // what the formula said, so a caster who picked the right element is
          // paid for having picked it.
          this.awardCausedDamage(
            actor,
            change.causedBy,
            damage,
            change.elements ?? NO_ELEMENTS,
          );
          // A body that has just died is off the board, and everything after
          // this would be arithmetic on a corpse.
          if (actor.hp === 0) break;
          continue;
        }
        if (change.amount === 0) continue;
        const stats = this.battlerOf(actor);
        const before = this.hpOf(actor);
        if (stats && before !== null) {
          actor.hp = Math.min(stats.maxHp, before + change.amount);
        }
      }
    }
  }

  /**
   * What a spell's damage comes to against this particular body.
   *
   * **The one place the elemental wheel turns**, and it turns on damage rather
   * than on anything else a spell can do: a mend has no second body to be good
   * against, and a status's *duration* is a clock rather than a force. What the
   * wheel changes is how hard the fire actually bites.
   *
   * Both sides come from where they were authored — the spell's elements were
   * read off its requirements, whether they arrived here on a status, on a
   * conjured placement or straight off the bolt that was just thrown, and the
   * body's are what its battler says it is plus whatever it has on.
   * @see `../lib/element`'s `effectiveness` for the arithmetic, and
   * `./equipment`'s `bodyElements` for the two halves and why neither of them is
   * read off a mastery.
   *
   * `bodyOf` is asked for the battler, and **only its authored `elements` are
   * read** — the block it hands back differs from the authored one in its
   * masteries alone, and masteries have no say here by design. A body that has
   * spent a year throwing fire is not made of fire.
   *
   * **Never less than one point.** A resisted spell should land softly, not
   * become a spell that visibly does nothing — a floating `0` over a target
   * reads as a bug, and a burn that takes nothing off would never kill anything
   * however long it ran.
   *
   * Returns the damage untouched for the overwhelming majority: an elementless
   * status, a body attuned to nothing, or a matchup neither side wins. That path
   * costs one length check and no lookup, which matters because it is every
   * poison and every hearth in the world, every tick.
   */
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

  /**
   * What a cast is decided against, for one body, right now.
   *
   * Assembled here because this is the one place that knows where everybody is
   * standing and what everybody has earned; decided in `./casting`, which knows
   * none of that and is the same function the browser runs. Null for a body that
   * is not on the board — a corpse casts nothing.
   */
  private castContextFor(actor: ActorRuntime): CastContext | null {
    const from = this.tryLocate(actor);
    if (!from) return null;

    // The target is honoured only if it is still somebody: a slot pointing at a
    // body that has died reads as no target at all, which is the same answer
    // `runAutoAttacks` gives before it clears the slot.
    const targetActor = actor.targetId
      ? this.actors.get(actor.targetId)
      : undefined;
    const to = targetActor ? this.tryLocate(targetActor) : null;

    const body = this.bodyOf(actor);
    return {
      map: this.map,
      tilesById: this.tilesById,
      equipment: actor.equipment,
      // The *earned* body's masteries, so a level crossed a moment ago is a
      // level a stone can be cast on — see {@link bodyOf}, which is where
      // experience becomes levels.
      masteries: body?.masteries ?? {},
      caster: this.reachPointOf(from) as CastPoint,
      target: to ? (this.reachPointOf(to) as CastPoint) : null,
    };
  }

  /**
   * Every stone this body could press, with why each can or cannot be cast.
   *
   * @see PlaySession.spells — the interface says why this is not on the
   * snapshot. Empty for a body that is not on the board, which is the same
   * answer it gives for a body carrying nothing.
   */
  spells(id: string = LOCAL_ACTOR_ID): SpellButton[] {
    const actor = this.actors.get(id);
    const context = actor ? this.castContextFor(actor) : null;
    return context ? castableStones(context) : [];
  }

  /**
   * Press the stone in this square.
   *
   * **The cooldown is spent before anything is resolved**, on exactly the terms
   * a swing's is spent before the dice are rolled: a spell that missed, healed
   * nothing or landed on a cell that would not take it has still been cast, and
   * a cost that depended on the outcome would make pressing at the wrong moment
   * free. The only things that cost nothing are the refusals `castability`
   * names, which are the ones the button was dimmed for.
   *
   * Nothing here is predicted by a client. A browser sends "cast the stone in
   * this square" and finds out what came of it from the equipment message and
   * the patches that follow, which is the same arrangement attacking is under.
   */
  cast(square: CastSquare, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;

    const context = this.castContextFor(actor);
    if (!context) return false;

    const stone = stoneIn(actor.equipment, this.tilesById, square);
    if (!stone) return false;
    if (!castability(context, square).ok) return false;

    // What the spell is made of, read once at the top and handed to whichever
    // arm runs: the elements decide what the cast trains and what it is worth
    // against whoever it lands on, and re-deriving them per arm would be three
    // places for the answer to drift. @see `../lib/mastery`'s `spellElements`
    const elements = spellElements(stone.requirements);

    // Before the effect, so nothing below can return early out of paying for it.
    this.spendCooldown(actor, square, stone);
    // And beside the cooldown rather than after the effect, on exactly the same
    // grounds: what casting teaches you for its own sake is owed for the cast,
    // not for what came of it. A light that lands on nobody is still a spell you
    // threw. @see `./experience`'s `practiceEarnings`
    this.grantExperience(actor, practiceEarnings(elements));

    if (stone.effect.kind === "bolt") {
      this.castBolt(actor, square, stone, stone.effect, elements);
    } else this.castConjure(actor, square, stone.effect.tileId, elements);

    return true;
  }

  /**
   * Put this stone on its cooldown, wherever it is being cast from.
   *
   * Through {@link setEquipment} rather than by writing the instance, because a
   * cooldown is a change to the kit like any other: it has to reach the owner's
   * screen so the button dims, and it has to be written down so a reconnection
   * does not clear it.
   */
  private spendCooldown(
    actor: ActorRuntime,
    square: CastSquare,
    stone: ArcaneStoneItem,
  ) {
    const held = actor.equipment[square];
    if (!held) return;
    this.setEquipment(actor, {
      ...actor.equipment,
      [square]: { ...held, cooldownMs: stone.cooldownMs },
    });
  }

  /**
   * Land a bolt: move health, leave what it leaves, on the caster or on whatever
   * they are pointing at.
   *
   * **One arm for every spell that touches a body**, which is the whole of what
   * folding the old `status` arm into this one bought — see `../lib/item`'s
   * {@link StoneEffect}. Two halves, both optional, and a stone that does both
   * is a brand: it burns, and it sets you alight.
   *
   * **Harming and mending are one number with a sign.** What differs between the
   * two directions is not the arithmetic but who has a say in it, and the split
   * is exactly three things: armour, the elemental wheel, and the ceiling. A
   * blow has to get through what the subject is wearing and is weighed on the
   * wheel; a mend is stopped by neither, and stops at a full health bar instead.
   * Nobody has ever worn armour against being healed.
   *
   * **No accuracy and no dodge, unlike a swing.** A cast is not aimed — you
   * spent the cooldown and the stone answered — so the two failures a swing can
   * have are absent here by design, and what is left of the dice is the variance
   * band. That makes a bolt the reliable half of an arcanist's damage and a
   * swing the frequent half, which is the trade the profession is built on: one
   * press every two minutes cannot also be a coin toss.
   *
   * The order is the order it happens in, and each step is somebody's say:
   * mastery, then the dice, then the subject's armour, then the wheel, then
   * whatever the bolt leaves behind.
   */
  private castBolt(
    actor: ActorRuntime,
    square: CastSquare,
    stone: ArcaneStoneItem,
    effect: Extract<StoneEffect, { kind: "bolt" }>,
    elements: readonly Element[],
  ) {
    // Read here rather than passed down, because what a cast *does* and what a
    // cast is allowed to do are two questions, and `./casting`'s `needsTarget`
    // owns only the second. A charm reaches nobody but its wearer whatever the
    // effect says.
    const onTarget = square !== "charm" && effect.on === "target";
    const subject = onTarget
      ? (actor.targetId ? this.actors.get(actor.targetId) : undefined)
      : actor;
    if (!subject) return;

    // Asked once and read three times below — whether anything flies, and
    // whether the blow pays. A stone pointed at somebody who turns out to be
    // yourself is a spell cast on yourself, whatever the effect said.
    const atSomebodyElse = subject !== actor;

    const stats = this.battlerOf(subject);
    const before = this.hpOf(subject);
    // Nothing a bolt does is visible on something that cannot be hurt, which is
    // `activateAddStatus`'s own argument and was the old status arm's too.
    if (!stats || before === null) return;

    const body = this.bodyOf(actor);
    if (!body) return;

    // Loosed before anything lands, on the terms an arrow is: a shot somebody
    // saw taken, whatever came of it. Never at yourself — a flight from a body
    // to itself is a frame of art sitting on somebody's head.
    if (atSomebodyElse) this.fireBolt(effect.projectile, actor, subject);

    this.moveHealth(actor, subject, stone, effect, elements, {
      atSomebodyElse,
      stats,
      before,
      masteries: body.masteries,
    });

    // **After the health and only onto a body still standing**, which is the
    // rule a weapon's statuses are already under: a status is a condition you
    // are *in*, and a corpse is not in one. The caster is recorded as the cause,
    // so damage the status does later pays them — including on themselves, where
    // the payout is refused for being self-inflicted rather than by never being
    // recorded. @see awardCausedDamage
    if ((this.hpOf(subject) ?? 0) <= 0) return;
    for (const grant of this.boltInflicts(effect.statuses)) {
      this.grantStatus(subject, grant, actor.id, elements);
    }
  }

  /**
   * The half of a bolt that moves a health bar, or nothing for one that does
   * not.
   *
   * Split out of {@link castBolt} because it is the half with two directions and
   * four steps in it, and leaving it inline put the status grant below three
   * branches deep — where the one thing that has to be obvious is that a status
   * lands whichever way the health went, and whether it went at all.
   *
   * Silent for a bolt with no damage authored, which is every pure ward and
   * every pure curse. It still draws no dice: a spell that moves no health has
   * no band to roll inside, and drawing one would make the world's dice depend
   * on how a stone happened to be written.
   */
  private moveHealth(
    actor: ActorRuntime,
    subject: ActorRuntime,
    stone: ArcaneStoneItem,
    effect: Extract<StoneEffect, { kind: "bolt" }>,
    elements: readonly Element[],
    context: {
      atSomebodyElse: boolean;
      stats: FightingStats;
      before: number;
      masteries: Masteries;
    },
  ) {
    if (!effect.damage) return;

    // What the stone is worth in *these* hands, off Arcane and off the elements
    // the stone asks for. @see `../lib/battler`'s {@link spellPower}
    const power = spellPower(effect.damage, stone.requirements, context.masteries);
    // The one thing left of a swing's dice. Drawn whichever way the bolt runs and
    // before either branch, so the world's dice advance by exactly as much for a
    // mend as for a harm — the same property `rollAttack` protects by taking all
    // its draws up front.
    const roll: [number, number] = [this.rng.next(), this.rng.next()];
    const rolled = Math.round(
      power * damageFraction(effect.variance ?? 0, roll),
    );

    if (rolled > 0) {
      // Armour first and the wheel second, which is the order a conjured flame's
      // burn already goes through: what the fire is worth against this body is
      // decided after what got through the mail. Read as an arcane blow, because
      // that is what it is — a stone answers to Arcane, so a breastplate warded
      // against magic turns one aside. @see `./combat`'s `defenceAgainst`
      const through = damageAfterDefence(rolled, context.stats, ARCANE_BLOW);
      const dealt = this.elementalDamage(subject, through, elements);
      if (dealt <= 0) return;
      this.applyDamage(subject, dealt);
      // Damage to yourself pays nothing, which is the rule `awardCausedDamage`
      // states and the reason training is not something you do in a corner. Paid
      // on what the wheel made of the blow rather than on what the formula said,
      // so picking the right element is worth picking.
      if (context.atSomebodyElse) {
        this.awardCastDamage(actor, subject, stone, dealt, elements);
      }
      return;
    }

    // **Clamped at a full health bar, and paid for what was actually restored.**
    // That is the whole of "pressing a mend at full health teaches you nothing":
    // a body two points down gets two points and two points' worth of experience
    // out of a stone that says ten.
    const restored = Math.min(
      -rolled,
      Math.max(0, context.stats.maxHp - context.before),
    );
    if (restored <= 0) return;
    subject.hp = context.before + restored;
    // **The wheel never touches a mend**, and the multiplier is flat for the
    // same reason: what `experienceMultiplier` weighs is how far above or below
    // you the other body is, and mending is not an exchange with anybody. A
    // caster who has mended a troll has mended somebody, not beaten them.
    this.grantCasting(actor, restored, stone, elements, SELF_SPELL_MULTIPLIER);
  }

  /**
   * Which of a bolt's statuses took, drawn once apiece.
   *
   * Through `./combat`'s {@link inflictedBy}, which is the same question a
   * weapon's list is put through and answers it the same way: against the
   * authored percentage directly, never through the band a contest lives in. An
   * author who writes 100 means a brand that always burns.
   *
   * The draws are taken here rather than up in {@link castBolt} because they are
   * only ever read here — unlike a swing, where they are taken before the miss
   * is decided so that the world's dice advance by the same amount whatever
   * happened. A cast cannot miss, so there is no early return to protect.
   */
  private boltInflicts(
    statuses: readonly WeaponStatus[] | undefined,
  ): readonly StatusGrant[] {
    if (!statuses?.length) return NOTHING_INFLICTED;
    return inflictedBy(
      statuses,
      statuses.map(() => this.rng.next()),
    );
  }

  /**
   * Pay an arcanist for damage one of their own casts just did.
   *
   * The direct twin of {@link awardCausedDamage}, which pays for damage done
   * *later* by something they conjured, and it differs in exactly one thing: the
   * stone is still in their hand, so the learning rate has a requirement to read
   * and a caster who has outgrown their stone is paid less for it. Nobody can
   * say that about a flame burning somebody two minutes after it was lit.
   *
   * Silent for a creature, which is where every payout in this game stops: only
   * a player has experience to be given.
   */
  private awardCastDamage(
    caster: ActorRuntime,
    victim: ActorRuntime,
    stone: ArcaneStoneItem,
    damage: number,
    elements: readonly Element[],
  ) {
    if (caster.resident) return;
    const casterRating = this.ratingOf(caster);
    const victimRating = this.ratingOf(victim);
    if (casterRating === null || victimRating === null) return;

    this.grantCasting(
      caster,
      damage,
      stone,
      elements,
      experienceMultiplier(victimRating, casterRating),
    );
  }

  /**
   * Put a bolt's projectile in the air between two bodies, if it has one.
   *
   * The one thing a spell's flight has to work out that a bow's does not: where
   * the two ends *are*. A swing already holds both points, having measured the
   * reach between them a moment earlier; a cast has two actors and has to locate
   * them. A body that cannot be located throws nothing, which is the honest
   * answer — a flight has to start and end somewhere.
   */
  private fireBolt(
    projectile: ProjectileDef | undefined,
    from: ActorRuntime,
    to: ActorRuntime,
  ) {
    if (!projectile) return;
    const start = this.tryLocate(from);
    const end = this.tryLocate(to);
    if (!start || !end) return;
    this.fireProjectile(
      projectile,
      this.reachPointOf(start),
      this.reachPointOf(end),
    );
  }


  /**
   * Put a conjured tile on the board — at the target's cell, or in front of the
   * caster.
   *
   * **The one place a spell touches a cell, and the player never picks it.**
   * With a target it lands on them, which is what makes a stone of flame a thing
   * you aim the way you aim a bow; with nobody targeted it lands on the cell the
   * caster is facing, which is what makes it a thing you can lay down in a
   * doorway.
   *
   * A cell that will not take the tile — a wall, a full stack, the edge of the
   * world — is a cast that placed nothing, and the cooldown has already been
   * spent. That is the same bargain a swing that misses is under, and it is why
   * the placement is checked with `canPlace` rather than forced.
   *
   * The placement remembers who cast it, which is the whole reason a flame can
   * pay the arcanist who lit it. @see `../lib/types`'s `PlacedTile.castBy`
   */
  private castConjure(
    actor: ActorRuntime,
    square: CastSquare,
    tileId: string,
    elements: readonly Element[],
  ) {
    const def = this.tilesById[tileId];
    if (!def) return;

    const where = this.conjureCell(actor, square);
    if (!where) return;
    const at = where.at;
    if (!canPlace(this.map, at.x, at.y, at.z, def, this.tilesById).ok) return;

    const placed: PlacedTile = {
      tileId: def.id,
      // The editor's rule for an armed tile, so a conjured lamp faces the way a
      // stamped one does — the same line `/tile` places under.
      ...(isDirectional(def) ? { direction: DEFAULT_FACING } : {}),
      ...(isItem(def) ? { itemId: mintItemId() } : {}),
      castBy: actor.id,
      // Beside the caster and for the same journey: the status this tile puts
      // on whoever steps in it carries both on, so the burn knows who owes for
      // it and which wheel it turns on. Omitted when the spell was made of
      // nothing, so an elementless conjure leaves an ordinary flame behind.
      ...(elements.length ? { castElements: [...elements] } : {}),
    };
    const stack = getStack(this.map, at.x, at.y, at.z);
    const next = [...stack];
    // **Under a body that is already standing there, and on top otherwise.** The
    // same rule `/tile` places underfoot by, and the reason it matters here is
    // that a flame is a thing you are *standing in*: what a tile does to a body
    // is read off the stack below it, so a flame conjured on top of somebody
    // would be a flame nobody is in. A body who walks in afterwards arrives
    // above it either way, so both arrivals read the same.
    next.splice(where.under ?? next.length, 0, placed);
    this.map = replaceStack(this.map, at.x, at.y, at.z, next);
    // What arrived may be a plate, may be wired, and is very likely subject to
    // gravity — the same three indexes a summoned tile rebuilds, and the one
    // that arms its decay. A conjured tile with no lifetime authored on it is a
    // permanent one, which is the author's decision and not this function's.
    this.reindexCells([at]);
    this.settleBoardNow();

    // **A floor that appears under you is the same event as walking onto one.**
    // Without this a flame conjured at a target who is standing still does
    // nothing at all until they happen to move, which would make an aimed spell
    // useless against exactly the thing it is aimed at. The rule is the tile's
    // own either way — `statusOnArrival` reads the stack below the body and
    // honours whatever it finds, caster included.
    const stood = where.under != null && actor.targetId
      ? this.actors.get(actor.targetId)
      : undefined;
    if (stood) this.statusOnArrival(stood);
  }

  /**
   * Where a conjure lands: on the target, or on the cell the caster is facing.
   *
   * A charm never reaches for a target — see `./casting`'s `needsTarget` — so a
   * conjuring charm always lays its tile in front of its wearer, which is the
   * only reading of "a charm acts on its holder" a tile can have.
   *
   * The cell in front is resolved through the same `destCellAfterStep` a walk
   * uses, so a flame laid at the top of a ramp lands on the ramp rather than
   * inside the floor beneath it.
   */
  private conjureCell(
    actor: ActorRuntime,
    square: CastSquare,
  ): { at: Coord; under?: number } | null {
    const from = this.tryLocate(actor);
    if (!from) return null;

    const target =
      square !== "charm" && actor.targetId
        ? this.actors.get(actor.targetId)
        : undefined;
    const to = target ? this.tryLocate(target) : null;
    // Beneath the target's own placement, so what lands is a thing they are
    // standing in rather than a thing balanced on their head.
    if (to) {
      return { at: { x: to.x, y: to.y, z: to.z }, under: to.stackIndex };
    }

    const facing = actorDirection(from);
    const { dx, dy } = DIR_DELTA[facing];
    return {
      at: destCellAfterStep(
        from.z,
        from.x + dx,
        from.y + dy,
        this.map,
        this.tilesById,
      ),
    };
  }

  /** What is running on this actor, for the chrome and for the checkpoint. */
  statusesOf(id: string): readonly StatusInstance[] | null {
    return this.actors.get(id)?.statuses ?? null;
  }

  /**
   * The same list in the shape the wire carries, or null for nobody by that
   * name.
   *
   * The cadence accumulator is dropped rather than sent: it is bookkeeping about
   * when the next payout is due, and no client pays anything out.
   */
  statusPatchesOf(
    id: string,
  ): { defId: string; remainingMs: number; durationMs: number }[] | null {
    const statuses = this.actors.get(id)?.statuses;
    if (!statuses) return null;
    return statuses.map(({ defId, remainingMs, durationMs }) => ({
      defId,
      remainingMs,
      durationMs,
    }));
  }

  /**
   * Hit points as they stand, for whoever is making them durable.
   *
   * Null where the body has none, and where it has never been asked — an actor
   * whose `hp` is still null is one at full health by construction, and saving
   * that would spend a storage key on the tile saying it again next load.
   */
  storedHpOf(id: string): number | null {
    const actor = this.actors.get(id);
    if (!actor || actor.hp === null) return null;
    const stats = this.battlerOf(actor);
    if (!stats || actor.hp >= stats.maxHp) return null;
    return actor.hp;
  }

  /**
   * The body this actor actually fights in: the one authored on their tile, with
   * whatever they have learnt in place of the authored masteries.
   *
   * **The two halves of a body come from different places and this is where they
   * meet.** Everything about a body that is a fact rather than a competence — its
   * reach, how far it bothers to look, what it bites with — is the tile's and is
   * fixed. What it is *good at* belongs to whoever is in it, which for a player
   * is something they earned and for a rat is something an author decided.
   *
   * A resident is handed the authored block untouched, which is the whole of why
   * a creature never improves: there is no runtime number to improve.
   */
  private bodyOf(actor: ActorRuntime): BattlerDef | null {
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    const def = this.tilesById[loc.placed.tileId];
    const authored = def ? resolveBattler(def) : null;
    if (!authored || actor.resident) return authored;

    const memo = actor.earnedBody;
    if (memo?.authored === authored) return memo.body;

    // The one moment a fresh player's experience exists: the authored block
    // becomes the experience that produces it, and from here on the masteries
    // are derived from that alone. See `xpFromMasteries` for why a starting
    // point rather than a floor.
    actor.masteryXp ??= xpFromMasteries(authored.masteries);
    const body = { ...authored, masteries: masteriesFromXp(actor.masteryXp) };
    actor.earnedBody = { authored, body };
    return body;
  }

  /**
   * How good at fighting this body is, all in — its ⭐.
   *
   * **Raw masteries, never equipment.** If a sword counted, taking it off would
   * lower your Rating, raise the ratio every reward is scaled by, and make
   * fighting naked the optimal way to play. Reading it off the same derived
   * block the fight uses is what keeps that true without anybody having to
   * remember it.
   */
  private ratingOf(actor: ActorRuntime): number | null {
    const body = this.bodyOf(actor);
    return body ? rating(body.masteries) : null;
  }

  /**
   * Hit points as they stand, filling them in from the tile the first time
   * anybody asks.
   *
   * Lazy because that is the only way it can be cheap *and* right: the stats
   * live on the body, a body can be swapped underneath an actor, and at the
   * moment an actor is created it may have no body at all. Null means the body
   * has none to give.
   */
  private hpOf(actor: ActorRuntime): number | null {
    const stats = this.battlerOf(actor);
    if (!stats) return null;
    actor.hp ??= stats.maxHp;
    // Clamped on read rather than on edit, so lowering a tile's maximum in the
    // editor cannot leave a creature standing there overfull.
    return Math.min(actor.hp, stats.maxHp);
  }

  /**
   * Point an actor at somebody, or at nobody.
   *
   * Nothing is validated here beyond the id being a string: whether the target
   * can actually be hit is decided every time a swing is attempted, and it has
   * to be, because reach changes as both parties walk. A target that is merely
   * out of range is a target being kept, not a bad one.
   */
  setTarget(actorId: string | null, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.targetId = actorId === actor.id ? null : actorId;
  }

  /**
   * Turn swinging on or off, leaving whoever is targeted targeted.
   *
   * The other half of {@link setTarget}, and separate from it because the two
   * are separate decisions a player makes at different moments: they pick who
   * they are interested in by pointing at them, and they decide whether they are
   * fighting by flipping a mode that outlives any one target. Toggling it off
   * mid-fight is how you back out of one without losing sight of what you were
   * backing out of.
   */
  setAttackMode(enabled: boolean, id: string = LOCAL_ACTOR_ID) {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.attacking = enabled;
  }

  /**
   * The channels creatures are holding open right now, one entry per emitting
   * mind. Read straight off each brain's current state, so a creature that has
   * moved on is simply not among them and the wire it was driving falls quiet.
   */
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

  /**
   * The emitting minds as one string, for the {@link settleBoardNow} skip.
   *
   * Insertion order, which is already what makes a tick reproducible, so the
   * same set of held channels always renders the same signature and an unchanged
   * mind never looks like a changed one.
   */
  private emitterSignature(emitters: ExtraEmitter[]): string {
    return emitters.map((e) => `${e.channel}=${e.value}`).join(",");
  }

  /**
   * Would a step this way land on nothing?
   *
   * The same band `canWalk` measures against, asked separately rather than
   * folded into it: the board deliberately permits walking into open air so
   * gravity can pull an actor through a steeper drop, and that rule is shared
   * with the client's own prediction. Changing it for creatures would put the
   * two out of step over the one thing they must agree on. So the caution lives
   * out here, where a brain can choose it per action.
   */
  private stepLeavesGround(loc: ActorLocation, direction: Direction): boolean {
    const { dx, dy } = DIR_DELTA[direction];
    const fromAbs = standingAbs(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      this.tilesById,
    );
    return (
      surfacesInClimbBand(
        this.map,
        loc.x + dx,
        loc.y + dy,
        fromAbs,
        this.tilesById,
      ).length === 0
    );
  }

  /**
   * Which way a creature should set off to end up beside `at`.
   *
   * The session's half of the brain's route-finding, and it is thin on purpose:
   * the search is a pure question about a board (`./pathfinding`) and this is
   * only the place that happens to hold one. It hands back the first leg and
   * throws the rest away — see {@link stepAlongRoute} for why a route is not
   * worth keeping between two decisions.
   *
   * `"arrived"` and null are kept apart all the way out here rather than
   * collapsed to "no step", because the two are different facts about the world
   * and the brain reads them differently: one creature is standing next to what
   * it wanted, and the other cannot get there at all.
   */
  private routeStep(
    actor: ActorRuntime,
    loc: ActorLocation,
    at: Coord,
    allowDrops: boolean | undefined,
  ): Direction | "arrived" | null {
    const path = findPath(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      at,
      this.defFor(actor),
      this.tilesById,
      { allowDrops },
    );
    if (path === null) return null;
    return path[0]?.direction ?? "arrived";
  }

  /**
   * Whichever other body standing on `tileId` is fewest steps away, or null when
   * there is none.
   *
   * The tile is the whole test, which is what lets one selector cover every
   * relationship a creature has: `player` is the person it hunts, its own tile is
   * a flock, and some third tile is a leader it follows. Nothing here knows which
   * of those an author meant, and it does not need to.
   *
   * Asking for `player` is asking for a connected person, because the player tile
   * is the one thing a resident can never be wearing — {@link listResidentBodies}
   * skips it, and a connection is the only way a body comes to have it.
   *
   * Self is excluded, without which a creature asking for its own tile would
   * answer itself and follow itself in circles. Ties break on insertion order,
   * the same order that already decides who wins a contested cell, which keeps
   * the answer reproducible rather than dependent on a map sweep's traversal.
   */
  private nearestOnTile(
    selfId: string,
    from: Coord,
    tileId: string,
  ): string | null {
    let best: string | null = null;
    let bestSteps = Infinity;
    for (const id of this.actorsOnTile(tileId)) {
      if (id === selfId) continue;
      const actor = this.actors.get(id);
      if (!actor) continue;
      const loc = this.tryLocate(actor);
      // The tile is re-checked against the board rather than taken from the
      // index. Positions are read live here — the index only ever says who is
      // worth asking about — so an entry that has gone stale costs a lookup
      // instead of naming the wrong body.
      if (!loc || loc.placed.tileId !== tileId) continue;
      const steps = Math.abs(loc.x - from.x) + Math.abs(loc.y - from.y);
      if (steps < bestSteps) {
        bestSteps = steps;
        best = actor.id;
      }
    }
    return best;
  }

  /**
   * Everybody standing on a named tile, in the order they joined the world.
   *
   * Insertion order is inherited from {@link actors} and is load-bearing for the
   * same reason it is there: two bodies exactly as far away must resolve the
   * same way on every run, or a seeded world stops being reproducible.
   */
  private actorsOnTile(tileId: string): readonly string[] {
    this.tileIndex ??= this.buildTileIndex();
    return this.tileIndex.get(tileId) ?? NO_ACTORS;
  }

  private buildTileIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const actor of this.actors.values()) {
      const loc = this.tryLocate(actor);
      // No body on the board, so nothing to be nearest to. They will be indexed
      // whenever the next spawn or death rebuilds this.
      if (!loc) continue;
      const on = index.get(loc.placed.tileId);
      if (on) on.push(actor.id);
      else index.set(loc.placed.tileId, [actor.id]);
    }
    return index;
  }

  /**
   * Where an actor is standing, or null once they are off the board.
   *
   * Public because the wire asks it: what a client is sent is scoped to what
   * its body can reach, which is a question about one actor's cell rather than
   * about the snapshot of every actor in the world. @see `../net/interest`
   */
  actorCell(id: string): Coord | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    return loc ? { x: loc.x, y: loc.y, z: loc.z } : null;
  }

  /**
   * Hands free? Own motion owns the map until it settles; a slide no longer
   * does, but is still held against the actor so pushes cannot be machine-
   * gunned out faster than the object can be seen leaving.
   */
  private idle(actor: ActorRuntime): boolean {
    return !actor.slide && !actor.walk && !actor.fall;
  }

  canPush(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canPushFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  /**
   * Shove the object one cell directly away from the actor. Returns false
   * when the push is illegal — a blocked push is a no-op, not an error state.
   */
  push(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const loc = this.locate(actor);
    const to = pushTargetFrom(this.map, this.tilesById, loc, ref);
    const direction = pushDirectionFrom(loc, ref);
    if (!to || !direction) return false;

    // The shove is what turns the actor, so facing lands before the motion.
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );

    const from = { x: ref.x, y: ref.y, z: ref.z };
    // Who was shoved, if it was a somebody rather than a something. Read before
    // the write, because afterwards the slot named by `ref` holds whatever the
    // column left behind.
    const shovedOwner = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex]
      ?.owner;
    // Whatever is stacked on the shoved object rides with it, in one write —
    // see `moveColumn`, and `pushDestination` for the room the column needs.
    const count = pushedColumn(this.map, ref).length;
    const landed = getStack(this.map, to.x, to.y, to.z).length;
    this.map = moveColumn(this.map, ref, count, to, undefined);

    // A column lands on top of the destination stack, in order, so the object
    // the player named is the lowest of the `count` slots that just appeared.
    actor.slide = {
      object: { ...to, stackIndex: landed },
      from,
      count,
      elapsedMs: 0,
    };
    // The object itself may be a plate, so both ends of the shove are suspect.
    this.reindexCells([from, to]);

    // **A shove is the fourth way a body reaches a new cell**, and the only one
    // that is somebody else's doing. {@link tickMotion} finds the other three by
    // comparing the cell either side of a tick, which cannot see this one: the
    // shove commits to the map the instant it happens, so by the shoved body's
    // next tick it has always already been where it now is. Without this, a
    // person pushed into a flame stands in it unburned until they walk.
    const shoved = shovedOwner ? this.actors.get(shovedOwner) : undefined;
    if (shoved) this.arriveIn(shoved);
    return true;
  }

  canPickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canPickUpFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
    );
  }

  /**
   * Take the thing off the board and put it away — in the bag, or failing that
   * in a free hand. @see pickUpDestination
   *
   * The placement becomes an instance and the map loses it, which is the whole
   * operation — see {@link takeFromBoard}.
   *
   * Returns false when the pickup is illegal, on the same terms a blocked push
   * does: a refusal is a no-op, not an error state.
   */
  pickUp(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

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

    // Where it lands is worked out **while the thing is still on the board**, so
    // a pour that turns out not to fit leaves the pile where it is. Taking the
    // placement off first and then discovering there is nowhere to put it would
    // be a pickup that deletes what it picked up, and the one thing standing
    // between those two orderings is this read.
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
    if (!this.idle(actor)) return false;
    return canEquipFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
    );
  }

  /**
   * Put the thing on, straight off the floor.
   *
   * The same trip a pickup makes and a different destination: a sword goes into
   * the hand rather than into a bag, which is what lets somebody carrying
   * nothing at all arm themselves. Which slot is the tile's own answer — see
   * `equipSlotOf` — and it has to be empty, so this never puts down what you are
   * already holding.
   *
   * Returns false when the equip is illegal, on the same terms a pickup does.
   */
  equip(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const slot = equipSlotFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
    );
    if (!slot) return false;

    const instance = this.takeFromBoard(ref);
    if (!instance) return false;

    this.setEquipment(actor, { ...actor.equipment, [slot]: instance });
    return true;
  }

  /**
   * Lift a placement off the board and hand back what it became.
   *
   * The one crossing of the line for anything entering a kit, shared by
   * {@link pickUp} and {@link equip} because it is the same trip whichever slot
   * the thing is headed for: a container comes up with its `contents` intact
   * because those ride on the placement, so nothing here has to know a bag from
   * a sword.
   *
   * Null when there is nothing there or the placement has no identity — an item
   * with no id means something skipped the minting pass, and better a pickup
   * that does nothing than one that puts an anonymous thing in a kit and loses
   * track of it forever. Nothing is removed in that case.
   */
  private takeFromBoard(ref: ObjectRef): ItemInstance | null {
    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const instance = placed && instanceFromPlacement(placed);
    if (!instance) return null;

    this.map = removeTileAt(this.map, ref.x, ref.y, ref.z, ref.stackIndex);
    // The cell has one fewer thing in it, which is a real change to what rests
    // on a plate and to what was holding a crate up.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return instance;
  }

  /**
   * Use a consumable up: the thing is destroyed and its `hp` lands on the
   * eater.
   *
   * The two sources cross different lines and are validated on their own
   * terms. A floor consume is a board action — reach, cover and idleness, the
   * gates a pickup runs — and takes a placement off the map without it ever
   * entering a kit. A slot consume is a kit action, gated the way a move is
   * (not on idleness: refusing to let a walking player drink would be a rule
   * with nothing behind it), and reach for a ground container slot is re-asked
   * inside `itemInSlot`.
   *
   * The eater must have hit points to change, asked *before* anything is
   * destroyed: a body with none — a session with no battler tile — refuses
   * rather than wasting the item on nothing.
   */
  consume(from: ConsumeSource, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    if (this.hpOf(actor) === null) return false;

    const consumable =
      from.kind === "floor"
        ? this.consumeFromFloor(actor, from.ref)
        : this.consumeFromSlot(actor, from.slot);
    if (!consumable) return false;

    // Before the hit points land, on exactly the terms `notePendingHurt` is
    // noted before its damage: a fatal drink still tells the room, because by
    // the time the number has been applied the body may be off the board and
    // there is nowhere left to hang a bubble.
    this.recordConsumeSound(actor, consumable);

    // Before the hit points move, so a consumable that both grants something and
    // kills you has already handed it over — and after the sound, on the same
    // grounds: by the time a fatal number has landed there is no body left to
    // hang anything on.
    for (const grant of consumable.statuses ?? []) {
      this.grantStatus(actor, grant);
    }

    if (consumable.hp < 0) {
      // Through the damage path rather than a bare subtraction, so a poison
      // apple shows its number, tells the brains, and can kill — a death by
      // poison and a death by blows must not be two codepaths to keep alive.
      this.applyDamage(actor, -consumable.hp);
    } else if (consumable.hp > 0) {
      const stats = this.battlerOf(actor);
      const before = this.hpOf(actor);
      if (stats && before !== null) {
        actor.hp = Math.min(stats.maxHp, before + consumable.hp);
      }
    }
    return true;
  }

  /**
   * Make the noise a consumable makes, where it was used.
   *
   * A noise rather than speech, and that is the whole distinction the channel
   * exists for: biting an apple is not the eater *saying* anything, so it must
   * not arrive attributed to them. See {@link NoiseEmission}.
   *
   * A crunch *does* set off every brain in earshot listening for one, which is
   * the point rather than a side effect: eating in the woods is a thing a wolf
   * gets to notice. It goes out through {@link recordNoise} and never through
   * {@link hear} — the eater is not saying anything, and the two channels stay
   * apart all the way down.
   */
  private recordConsumeSound(actor: ActorRuntime, consumable: ConsumableItem) {
    if (!consumable.sound?.trim()) return;
    // Re-located rather than taken from the consume: a floor meal has already
    // rewritten the cell it came out of, and a stale slot index would hang the
    // noise on nothing.
    const loc = this.tryLocate(actor);
    if (!loc) return;
    this.recordNoise(actor.id, loc, consumable.sound);
  }

  /** Take a consumable placement off the board. Null when refused. */
  private consumeFromFloor(
    actor: ActorRuntime,
    ref: ObjectRef,
  ): ConsumableItem | null {
    if (!this.idle(actor)) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;
    if (!canConsumeFrom(this.map, this.tilesById, loc, ref)) return null;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    if (!consumable || !placed) return null;

    // One berry out of the pile, not the pile. Eating is the one act that takes
    // an *amount* rather than a thing — see `../lib/piles`'s `peelOne` — and a
    // meal that swallowed a heap of twelve would be the game deciding a number
    // nobody was offered.
    const left = peelOne(placed);
    const spent = left
      ? stack.map((held, i) => (i === ref.stackIndex ? left : held))
      : stack.filter((_, i) => i !== ref.stackIndex);
    const next = this.cellAfterLeaving(actor, ref, spent, consumable);
    if (!next) return null;
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    // The same reindex a pickup owes, for the same plates and the same
    // unsupported crates. Owed even for a pile that merely got smaller: a pile
    // adds no height, so nothing about the cell can have changed — but the
    // reindex is a stack read, and a cheap one is worth more than a rule about
    // when it may be skipped.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return consumable;
  }

  /**
   * A cell's stack with what a floor drink leaves behind on it, or null when
   * the cell cannot hold it.
   *
   * On the floor rather than in the drinker's kit, because that is where the
   * potion was: a bottle drunk where it lies is left where it lay, exactly as a
   * meal eaten off the floor never enters the bag. Poured, like every other way
   * an item reaches a cell, so a second bottle joins the first. The room check
   * is `canReplaceStack`'s, the same one a body dying holding things asks, and
   * a refusal is said out loud on {@link leaveBehind}'s terms.
   */
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

  /**
   * The board and kit with what a slot drink leaves behind somewhere on the
   * body, or null — said out loud — when there is nowhere.
   *
   * Asked with the drink already gone, which is what makes the ordinary case
   * free: the square the last potion vacated is the square its bottle lands in.
   * See `./residue` for the order the places are tried in.
   */
  private leaveBehind(
    actor: ActorRuntime,
    loc: ActorLocation,
    emptied: ItemMoveResult,
    from: SlotRef,
    consumable: ConsumableItem,
  ): ItemMoveResult | null {
    const residue = this.residueOf(consumable);
    if (!residue) return emptied;
    const landed = leaveResidue(
      emptied.map,
      this.tilesById,
      loc,
      emptied.equipment,
      from,
      residue,
    );
    if (landed) return landed;
    this.say(actor.id, noRoomToLeaveNotice(this.tilesById[residue.tileId]!.name));
    return null;
  }

  /**
   * What this consumable leaves behind, minted, or null for one that leaves
   * nothing.
   *
   * A tile the catalogue no longer holds reads as leaving nothing, on the terms
   * a status nobody authored does: renamed content is an effect that did not
   * happen, not a drink that cannot be drunk. Minted before it is known to fit,
   * because an id is random and one that lands nowhere costs nothing.
   */
  private residueOf(consumable: ConsumableItem): ItemInstance | null {
    const tileId = consumable.leaves;
    if (!tileId || !this.tilesById[tileId]) return null;
    return { id: mintItemId(), tileId };
  }

  /** Take a consumable out of a slot and destroy it. Null when refused. */
  private consumeFromSlot(
    actor: ActorRuntime,
    slot: SlotRef,
  ): ConsumableItem | null {
    const loc = this.tryLocate(actor);
    if (!loc) return null;

    const instance = itemInSlot(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      slot,
    );
    const def = instance && this.tilesById[instance.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    if (!consumable) return null;

    // One off the pile, where `drop` takes the whole of it: the two verbs are
    // the two ways something leaves a slot, and `peelSlot` falls through to
    // `clearSlot` for the last one anyway.
    const emptied = peelSlot(this.map, this.tilesById, loc, actor.equipment, slot);
    if (!emptied) return null;
    // Before anything is written, so a drink with nowhere to leave its bottle
    // leaves the potion exactly where it was.
    const landed = this.leaveBehind(actor, loc, emptied, slot, consumable);
    if (!landed) return null;

    this.map = landed.map;
    // Only when it actually changed, exactly as a move does: eating out of a
    // chest is the chest's placement changing and nobody's kit.
    if (landed.equipment !== actor.equipment) {
      this.setEquipment(actor, landed.equipment);
    }
    return consumable;
  }

  canMoveItem(
    from: SlotRef,
    to: SlotRef,
    id: string = LOCAL_ACTOR_ID,
  ): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    return canMoveItem(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
      to,
    );
  }

  /**
   * Move one carried thing from one slot to another.
   *
   * Equipping, unequipping, looting a chest and stashing something into one are
   * all this, read four ways — see `./itemMoves`, which owns every rule the move
   * has to satisfy and is asked the same question by the client before it offers
   * the drag.
   *
   * Not gated on {@link idle}, unlike a push or a pickup. Those two move the
   * *board* and are held against the actor so they cannot be machine-gunned out
   * faster than the result can be seen; this rearranges what somebody is
   * carrying, and refusing to let a walking player put a sword in their hand
   * would be a rule with nothing behind it. Reach for a ground endpoint is
   * re-asked here regardless, against the cell the actor has committed to.
   *
   * No settle pass: a container's contents are not physics. Rewriting them
   * changes what a placement *holds* and never its tile, so nothing rests
   * differently on a plate and no wire has changed value — and the map identity
   * has moved anyway, so the next tick's pass will not skip.
   */
  moveItem(from: SlotRef, to: SlotRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    const loc = this.tryLocate(actor);
    if (!loc) return false;

    // Said out loud before the move is tried, and the *only* refusal in this
    // module that says anything. Every other one is a drag the interface never
    // offered — see `./itemMoves`, which returns null without a reason on
    // exactly those grounds — where this is a square a player can plainly see
    // something in and plainly cannot empty. Silence there reads as the panel
    // being broken rather than as a rule.
    if (this.noteCoolingRefusal(actor, loc, from)) return false;

    const moved = applyItemMove(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
      to,
    );
    if (!moved) return false;

    this.map = moved.map;
    // Only when it actually changed: `setEquipment` is what tells the owner's
    // socket, and a loot from one chest into another is nobody's kit changing.
    if (moved.equipment !== actor.equipment) {
      this.setEquipment(actor, moved.equipment);
    }
    return true;
  }

  canDrop(
    from: SlotRef,
    to: Coord,
    id: string = LOCAL_ACTOR_ID,
  ): boolean {
    return this.dropCandidate(from, to, id) != null;
  }

  /**
   * Tell this body why the thing in that square will not come out of it, if the
   * reason is that it is cooling.
   *
   * True when it said something, so the caller can stop — which makes the call
   * site read as "refused, and they have been told". False is the overwhelmingly
   * common answer and costs one slot read.
   *
   * The stone is named rather than the square, because what is refusing is the
   * thing rather than the place: put it in the other hand and it would refuse
   * from there too.
   */
  private noteCoolingRefusal(
    actor: ActorRuntime,
    loc: ActorLocation,
    from: SlotRef,
  ): boolean {
    const instance = itemInSlot(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
    );
    if (!instance || !stoneLocked(instance, this.tilesById)) return false;
    const def = this.tilesById[instance.tileId];
    this.say(
      actor.id,
      coolingNotice(
        instance.description?.trim() || def?.name || instance.tileId,
      ),
    );
    return true;
  }

  /**
   * What a drop would put down, and whether it may go there.
   *
   * One question rather than two, for the reason `pickUpDestination` is: the
   * caller that says yes is the caller that then has to write the placement, and
   * finding the instance a second time is how the two come to disagree.
   */
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
    if (!actor) return null;
    const loc = this.tryLocate(actor);
    if (!loc) return null;

    const instance = itemInSlot(
      this.map,
      this.tilesById,
      loc,
      actor.equipment,
      from,
    );
    if (!instance) return null;

    const def = this.tilesById[instance.tileId];
    if (!def) return null;
    // A stone that is still cooling stays where it is, on the floor's terms as
    // well as the kit's — see `./equipment`'s `stoneLocked`. The move rules
    // refuse the same thing for the same reason, and both have to: putting a
    // cooling stone down and picking it up again would clear the cooldown, which
    // is the exploit the lock exists for.
    if (stoneLocked(instance, this.tilesById)) return null;
    const destination = dropDestinationAt(this.map, this.tilesById, loc, to, def);
    if (!destination) return null;
    return { actor, instance, destination };
  }

  /**
   * Put a carried thing down on the board.
   *
   * The exact inverse of {@link pickUp}, and it shares that trip's conversion
   * pair: an instance becomes a placement, contents and all, so a bag put on the
   * floor is still full and a chest looted half-empty stays half-empty. Nothing
   * here knows a bag from a sword.
   *
   * Landing on *top* of the target stack rather than at a chosen height, and
   * then settling: a thing dropped over a hole falls into it, which is the same
   * rule a shoved crate follows and needs no special case here.
   */
  drop(from: SlotRef, to: Coord, id: string = LOCAL_ACTOR_ID): boolean {
    const thrower = this.actors.get(id);
    const at = thrower ? this.tryLocate(thrower) : null;
    // Ahead of the candidate, which refuses a cooling stone silently: a throw
    // that goes nowhere owes the same sentence a drag that goes nowhere does.
    if (thrower && at && this.noteCoolingRefusal(thrower, at, from)) return false;

    const candidate = this.dropCandidate(from, to, id);
    if (!candidate) return false;
    const { actor, instance, destination } = candidate;

    const emptied = clearSlot(
      this.map,
      this.tilesById,
      this.locate(actor),
      actor.equipment,
      from,
    );
    if (!emptied) return false;

    // The board first and the kit second, so there is no order in which the
    // thing can leave a slot without arriving somewhere.
    const landed =
      destination.kind === "contents"
        ? stashInContainer(
            emptied.map,
            this.tilesById,
            destination.ref,
            instance,
          )
        : // Through the pouring append, so a pile of berries thrown at a cell
          // that already has berries in it lands as more of that pile rather
          // than beside it. See `../lib/piles`'s `appendItem`.
          appendItem(
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

    // Caught by the box it was thrown at, and then it is not on the board at
    // all: no placement appeared, nothing rests differently on a plate, and no
    // wire changed value — the same reasoning `moveItem` settles nothing under.
    if (destination.kind === "contents") return true;

    // The thing that just landed may be a plate, may be wired, and is almost
    // certainly subject to gravity — and the cell it came *out of*, for a drop
    // taken from a container on the floor, has changed too.
    this.reindexCells([to]);
    this.settleBoardNow();
    return true;
  }

  /**
   * Put a whole new kit on an actor.
   *
   * **Replaces rather than mutates, and that is load-bearing.** The renderer
   * hands equipment to React only when the object identity changes — see
   * `GameRenderer.setOnEquipment` — so a kit edited in place would leave the
   * panels showing what the player was carrying a moment ago, with nothing to
   * correct it. Every change goes through here for that reason.
   */
  private setEquipment(actor: ActorRuntime, next: Equipment) {
    actor.equipment = next;
    // Re-derived here and nowhere else. It is the one moment the answer can have
    // changed, and doing it beside the assignment is what makes "the cache
    // cannot go stale" a fact about this function rather than a discipline
    // spread over every caller.
    actor.carriedLights = carriedLightTileIds(next, this.tilesById);
    // The kit's `reindexCells`, and here for the same reason: this is the one
    // place a kit is written, so a thing that arrives in one starts counting
    // down without every equip, stash and loot having to remember to say so.
    // Additive, so nothing already ripening is set back by being moved.
    this.decay.armEquipment(next, this.tilesById);
    this.equipmentChanged.add(actor.id);
  }

  /**
   * Whose kit has changed since the last time anybody asked, and clears the
   * list.
   *
   * Drained rather than read, because there is exactly one consumer: the server
   * turning it into a message per socket. A second reader would silently get an
   * empty answer, which is the right shape here — this is a queue of things to
   * announce, not a record of what happened.
   */
  drainEquipmentChanges(): string[] {
    if (this.equipmentChanged.size === 0) return [];
    const changed = [...this.equipmentChanged];
    this.equipmentChanged.clear();
    return changed;
  }

  /**
   * Whose tags have changed since anybody last asked, and clears the list.
   *
   * Its own queue rather than a flag on the equipment one, even though today
   * every tag arrives beside a kit. They are two facts with two messages, and a
   * reward that handed over nothing — a tag for having spoken to somebody — is
   * the obvious next thing to author.
   */
  drainTagChanges(): string[] {
    if (this.tagsChanged.size === 0) return [];
    const changed = [...this.tagsChanged];
    this.tagsChanged.clear();
    return changed;
  }

  /**
   * Whose cooling resources have changed since anybody last asked, and clears
   * the list.
   *
   * Its own queue beside the other three, on {@link drainTagChanges}' argument:
   * a wait starts when somebody works a bush and ends on a tick nothing else
   * happened, which is a different event at a different rate from a kit change.
   */
  drainExtractCoolingChanges(): string[] {
    if (this.extractCoolingChanged.size === 0) return [];
    const changed = [...this.extractCoolingChanged];
    this.extractCoolingChanged.clear();
    return changed;
  }

  /**
   * Whose experience has moved since anybody last asked, and clears the list.
   *
   * A third queue beside the other two, and not folded into either: a kit
   * changes when somebody moves an item and this changes when somebody lands a
   * blow, which are different events at wildly different rates. Sharing a queue
   * would send an inventory on every swing.
   */
  drainMasteryChanges(): string[] {
    if (this.masteriesChanged.size === 0) return [];
    const changed = [...this.masteriesChanged];
    this.masteriesChanged.clear();
    return changed;
  }

  /**
   * Whose statuses have changed in a way worth telling them about.
   *
   * A fourth queue, and the only one that is filled by the passage of time
   * rather than by somebody doing something — see {@link statusesChanged} for
   * why that makes the *reading* the thing being compared.
   */
  drainStatusChanges(): string[] {
    if (this.statusesChanged.size === 0) return [];
    const changed = [...this.statusesChanged];
    this.statusesChanged.clear();
    return changed;
  }

  canTakeReward(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canRewardFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      actor.equipment,
      actor.tags,
    );
  }

  /**
   * Hand this actor the reward, and mark them with its tag.
   *
   * **The board is not touched.** Nothing is taken off the map and nothing swaps
   * — the chest is still a chest, still full for the next person, and the cell
   * patch that would have announced an edit is never sent. The whole of what
   * happened lives on the taker, which is what "once per player" means in a
   * world several people are standing in.
   *
   * Every item is minted fresh ({@link mintItemId}), so two players who open the
   * same chest come away with two distinct swords. An authored reward is a
   * recipe, not an object being moved.
   *
   * The kit and the tag are written together and never conditionally: a reward
   * whose items landed without its tag is one the player can take again, which
   * is an item with no ceiling on how many exist.
   */
  takeReward(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const loc = this.locate(actor);
    const reward = reachableRewardAt(this.map, this.tilesById, loc, ref);
    if (!reward) return false;
    if (actor.tags.includes(reward.tag)) return false;
    if (!rewardFits(reward, this.tilesById, actor.equipment)) return false;

    // Read before anything is written, because the notice names the giver and
    // `reachableRewardAt` has already proved the slot holds one.
    const giverDef =
      this.tilesById[getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex].tileId];
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
    // After the two writes, never before: the sentence says what the player now
    // has, and a line queued ahead of a throw would be a receipt for a reward
    // that never landed. Composed here rather than on the way out because this
    // is the last place holding the giver *and* what it gave — by the time
    // anything drains this, the ref is a coordinate and the reward is gone.
    this.say(actor.id, rewardNotice(reward, giverDef, this.tilesById));
    return true;
  }

  canTransmute(
    ref: ObjectRef,
    recipe: number,
    id: string = LOCAL_ACTOR_ID,
  ): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canTransmuteFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      actor.equipment,
      ref,
      recipe,
    );
  }

  /**
   * Spend one carried thing at a transmuter and take back what it makes.
   *
   * **The board is not touched**, on exactly a reward's terms and for a related
   * reason: the fire has to still be a fire for the next person, so there is no
   * cell patch to send and `settleBoardNow` has nothing to settle. What changes
   * is one kit, which travels as an `equipment` message.
   *
   * Unlike a reward it leaves **no tag and no mark of any kind**, because there
   * is nothing to stop: a fire cooks the second steak too, and what limits it is
   * having something to spend. That is the whole difference between "once per
   * player" and "as often as you can pay for it".
   *
   * Gated on {@link idle} like every other board-side act. It is a kit change,
   * but it is one you reach out and do to something in the world, and a player
   * mid-stride is not standing next to it yet.
   */
  transmute(
    ref: ObjectRef,
    recipe: number,
    id: string = LOCAL_ACTOR_ID,
  ): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

    const plan = planTransmute(
      this.map,
      this.tilesById,
      this.locate(actor),
      actor.equipment,
      ref,
      recipe,
    );
    if (!plan) return false;

    this.setEquipment(actor, runTransmute(plan, mintItemId));
    return true;
  }

  /**
   * The resources this actor may not work yet, as a set the rules can ask.
   *
   * Read off the live map rather than copied, because nothing here holds it
   * past the question — and `Map` is already a set of its keys, so a
   * `ReadonlySet` view of it costs nothing.
   */
  private coolingFor(actor: ActorRuntime): CoolingResources {
    return actor.extractCooldowns ?? NO_COOLING;
  }

  canExtract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canWorkNow(
      this.map,
      this.tilesById,
      this.locate(actor),
      actor.equipment,
      ref,
      this.coolingFor(actor),
    );
  }

  /**
   * Take one pull out of a resource. Returns false when it is not on offer.
   *
   * **Three things move and they are three different owners' state**, which is
   * what makes this the only interaction in the session that writes to all of
   * the board, the kit and a private clock in one act:
   *
   * - the placement loses a pull, and turns into whatever the author named once
   *   it has none. That is a cell patch, so everybody sees the vein run out.
   * - the kit gains whatever came up, minted fresh on a reward's terms: two
   *   people working one bush come away with two distinct berries.
   * - this player starts waiting on this placement, which nobody else can see
   *   and which is why the bush is still full for the next person.
   *
   * **The dice are the world's and are thrown exactly once**, here, on the
   * server. `canExtract` above deliberately does not roll — see
   * `./extract`'s `extractFits`, which asks for room enough for the *best*
   * possible pull so that offering the row costs no draws and cannot change
   * what the next creature in the world rolls.
   *
   * **The wait is charged whatever came up.** A crystal that yields nothing on
   * a bad roll has still been chipped at: the durability went into the swing
   * rather than into what came out of it, and a pull that cost nothing when it
   * gave nothing would be a free re-roll.
   *
   * Gated on {@link idle} like every other board-side act.
   */
  extract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.canExtract(ref, id)) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    const placed = stack[ref.stackIndex];
    if (!placed) return false;
    const def = this.tilesById[placed.tileId];
    const extract = def && resolveExtract(def);
    if (!def || !extract) return false;

    // Before the board moves, because the key names the tile that is being
    // worked and the next line may turn it into a different one.
    const key = extractKey(ref, placed.tileId);
    const yielded = rollExtract(extract, () => this.rng.next());

    if (!this.spendPull(ref, stack, placed, extract)) return false;
    if (yielded.length > 0) this.giveExtracted(actor, yielded);
    if (extract.cooldownMs > 0) this.startExtractCooldown(actor, key, extract);

    // After the board and the kit, never before: the sentence says what the
    // player now has, and this is the last place holding both the thing worked
    // and what came out of it.
    this.say(actor.id, extractNotice(extract, def, yielded, this.tilesById));
    return true;
  }

  /**
   * Take one pull off the placement, turning it into whatever the author named
   * once it has none. Returns false when the swap could not be made.
   *
   * The refusal is `canReplaceStack`'s, and it is the same one a decay and a
   * plate make: whatever a spent resource becomes has to fit under what has been
   * stacked on it in the meantime. Refused rather than forced, and refused
   * *before* anything is handed over — a pull that could not change the board
   * has not happened, so nothing is minted and no wait is charged.
   */
  private spendPull(
    ref: ObjectRef,
    stack: readonly PlacedTile[],
    placed: PlacedTile,
    extract: ExtractInteraction,
  ): boolean {
    const after = placementAfterPull(placed, extract);
    // A target that does not exist leaves the resource standing, on
    // `decayedStack`'s terms: a typo in `tiles.json` should read as a pull that
    // never happened rather than as content quietly deleting itself. A *blank*
    // target is the authored way to say "and then it is gone", and is not this.
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
      // Spent. The count goes with the tile it was counting — whatever this
      // becomes has a durability of its own or none at all, and a number left
      // behind would be the old resource's answer worn by a new tile.
      if (!extract.tileId) continue;
      const { extractsLeft: _spent, ...rest } = current;
      next.push({ ...rest, tileId: extract.tileId });
    }

    if (!canReplaceStack(this.map, ref.x, ref.y, ref.z, next, this.tilesById).ok) {
      return false;
    }
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    // The tile worked into may be a plate — or may have been one.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  /**
   * Put what came up in the bag.
   *
   * The bag and only the bag, unlike a recipe's results, which spill to
   * whichever square is free — and the difference is that a recipe is *paid
   * for* out of a particular slot, so it has somewhere obvious to put the
   * change. A pull comes out of the world and belongs where everything else you
   * are merely carrying goes.
   *
   * **Through the same function that decided the row could be offered**, which
   * is what lets a pull pour into a pile rather than demanding an empty square
   * per berry. A run that worked the arrangement out again could work it out
   * differently from the check — the trap `landingsFor` is documented as being
   * in — so there is one answer and both halves ask for it.
   *
   * A null here is a race rather than an oversight: the kit moved between the
   * check and the run. Nothing is minted and nothing is given, and the pull has
   * already been paid for on the board — which is the safe direction, since the
   * alternative is inventing somewhere to put things.
   */
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

  /** Start this actor waiting on this placement. */
  private startExtractCooldown(
    actor: ActorRuntime,
    key: string,
    extract: ExtractInteraction,
  ) {
    const cooldowns =
      actor.extractCooldowns ?? new Map<string, ExtractCooling>();
    cooldowns.set(key, {
      key,
      remainingMs: extract.cooldownMs,
      durationMs: extract.cooldownMs,
    });
    this.setExtractCooldowns(actor, cooldowns);
  }

  /**
   * Carry out something somebody typed, or tell them why it did not happen.
   *
   * **The command's one entry point, and the only place the world is changed by
   * words.** Everything ahead of it is grammar (`./commands`) and everything
   * behind it is prose (`./notices`); what is left is the questions only a
   * session can answer — is there a body by that name, does it learn, does the
   * catalogue hold that tile, and is there room for it.
   *
   * **Nobody is checked.** Any player may set any mastery on anybody and call
   * anything into the world, which is deliberate and temporary; see the note at
   * the top of `./commands`. When that changes, this is the method that grows
   * the gate — one place, ahead of the work, because a command is a request
   * until something acts on it.
   */
  runCommand(raw: string, id: string = LOCAL_ACTOR_ID) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      this.say(id, commandRefusalNotice(parsed.refusal));
      return;
    }

    // Each command answers with a refusal or with nothing, and the sentence is
    // said in one place. The alternative — every arm saying its own — is how a
    // command comes to refuse silently: the return is the only thing that
    // reminds you there was something left to tell them.
    const refusal = this.runParsedCommand(parsed.command, id);
    if (refusal) this.say(id, commandRefusalNotice(refusal));
  }

  /** One arm per verb, each answering with a refusal or with nothing. */
  private runParsedCommand(
    command: Command,
    id: string,
  ): CommandRefusal | null {
    switch (command.name) {
      case MASTERY_COMMAND:
        return this.runMasteryCommand(command, id);
      case TILE_COMMAND:
        return this.runTileCommand(command, id);
      case STATUS_COMMAND:
        return this.runStatusCommand(command, id);
      case HEALTH_COMMAND:
        return this.runHealthCommand(command, id);
    }
  }

  /**
   * Put one mastery on one body, whoever asked.
   *
   * The target hears what *their* mastery now reads and the author hears what
   * they did, which are two sentences because they are two facts. When they are
   * the same person only the first is said: being told twice that you set your
   * own blade to 10 reads as a bug.
   *
   * One quiet edge, and it is `hasExperience`'s rather than this method's:
   * zeroing every mastery leaves a block that reads as *absent* on the next
   * load, so the body seeds itself from its tile again. Nothing worth closing
   * here — the gate exists to stop a genuinely empty block sticking, and an
   * admin command is not the reason to weaken it.
   */
  private runMasteryCommand(
    command: MasteryCommand,
    id: string,
  ): CommandRefusal | null {
    const { mastery, level, target } = command;
    const targetId = target ?? id;
    const actor = this.actors.get(targetId);
    if (!actor) return { kind: "noSuchTarget", typed: targetId };

    if (!this.setMastery(actor, mastery, level)) {
      return {
        kind: "unteachableTarget",
        // Their tile's name for a creature and their handle for a person,
        // through the one function that decides what a body is called.
        name: this.bodyName(targetId) ?? targetId,
      };
    }

    this.say(actor.id, masteryNotice(mastery, level));
    if (actor.id !== id) {
      this.say(
        id,
        otherMasteryNotice(this.bodyName(actor.id) ?? actor.id, mastery, level),
      );
    }
    return null;
  }

  /**
   * Call a tile into the world, wherever the summoner pointed.
   *
   * **Any tile in the catalogue, on the same terms the editor places one.**
   * `canPlace` is the editor's own fit check and it is asked here for the
   * reason it is asked there — a stack that would overflow two levels is not a
   * thing the world can hold, and a command that wrote one anyway would leave a
   * cell no renderer or gravity pass agrees about.
   *
   * **A cell of your own lands underfoot, not overhead.** Typing `/tile apple`
   * while standing somewhere means an apple at your feet; appending it to the
   * top of your stack — the obvious reading of "put it here" — balances it on
   * your head instead, riding you around the map. The same rule holds however
   * the cell was named, so `+0 +0 +0` and no coordinates at all do not quietly
   * differ. Somebody *else's* stack is not special-cased: an admin dropping a
   * crate on a rat asked for exactly that.
   *
   * A summoned body is adopted here rather than left to the load-time sweep,
   * which is the same trade `respawnAt` makes: placing the tile is the whole of
   * putting a creature in the world, and the sweep only exists because an
   * authored map arrives with its residents already on the board.
   */
  private runTileCommand(
    command: TileCommand,
    id: string,
  ): CommandRefusal | null {
    const actor = this.actors.get(id);
    const from = actor ? this.tryLocate(actor) : null;
    // Refused even for three absolute coordinates, which need no origin: a
    // command is something a body in the world does, and there is no body here.
    if (!from) return { kind: "nowhereToPlace" };

    const def = this.tilesById[command.tileId];
    if (!def) return { kind: "unknownTile", typed: command.tileId };
    // A map is allowed exactly one — see `requireSinglePlayer`, which throws
    // rather than choosing — so a second one is a world that cannot be opened
    // again. The one tile worth refusing, and refused ahead of the fit check so
    // the answer does not depend on where you were standing.
    if (def.id === PLAYER_TILE_ID) {
      return { kind: "spawnMarkerTile", typed: command.tileId };
    }

    const at = resolveCell(command.at, from);
    if (!canPlace(this.map, at.x, at.y, at.z, def, this.tilesById).ok) {
      return { kind: "noRoom", at };
    }

    const stack = getStack(this.map, at.x, at.y, at.z);
    const underfoot = at.x === from.x && at.y === from.y && at.z === from.z;
    const stackIndex = underfoot ? from.stackIndex : stack.length;
    const placed: PlacedTile = {
      tileId: def.id,
      // The editor's rule for an armed tile, so a lamp post summoned into the
      // world faces the way one stamped into it does.
      ...(isDirectional(def) ? { direction: DEFAULT_FACING } : {}),
      // A summoned item is a new item, on the terms a respawned one is: minted
      // here rather than left to the load sweep, because nothing between now
      // and the next load would give it one.
      ...(isItem(def) ? { itemId: mintItemId() } : {}),
      ...(resolveActor(def)
        ? { owner: this.summonedOwnerId({ ...at, stackIndex }) }
        : {}),
    };

    // Poured into a pile already in that cell where one will take it, exactly as
    // a drop is: `/tile berry` onto a berry is two berries in that tile, not a
    // second placement of one. A command puts a thing in the world, and once it
    // is there it should be the thing the world would have had if somebody had
    // walked over and put it down. See `../lib/piles`.
    //
    // A pour makes no placement, so the room `canPlace` asked for above is more
    // than it needs, and the slot `stackIndex` names is left alone.
    const poured = pourInto(stack, placed, this.tilesById);
    const next = poured ?? [...stack];
    if (!poured) next.splice(stackIndex, 0, placed);
    this.map = replaceStack(this.map, at.x, at.y, at.z, next);

    if (placed.owner) {
      this.addActor(placed.owner, { resident: true, bodyTileId: def.id });
    }
    // What arrived may be a plate, may be wired, and is very likely subject to
    // gravity — the same three indexes a respawn rebuilds, for the same reason.
    this.reindexCells([at]);
    this.settleBoardNow();
    this.say(id, tileNotice(def.name, at));
    return null;
  }

  /**
   * A name for a body somebody summoned.
   *
   * The authored scheme first ({@link residentOwnerId}), so a called creature
   * knows the cell it was called into as its home in exactly the way a placed
   * one does — that name *is* the cell and slot, and it is the whole of how a
   * brain answers "where do I belong".
   *
   * Which is also why it can collide: the name stops describing where a body
   * *is* the moment it walks off, leaving its slot free to be named a second
   * time. Two bodies under one owner is the one shape nothing recovers from —
   * `despawn` removes a single tile, so the other stands there forever, driven
   * by a runtime that has been replaced out from under it. So a taken name
   * falls back to a unique one, and the body wearing it is simply homeless:
   * `residentHome` answers "nowhere" for any name it did not mint, which is
   * already a case brains handle.
   */
  private summonedOwnerId(at: Coord & { stackIndex: number }): string {
    const home = residentOwnerId(at);
    return this.actors.has(home) ? `${home},${crypto.randomUUID()}` : home;
  }

  /**
   * Put a status on a body by hand, or take everything off it.
   *
   * **A debugging door, and the only way to see an effect without earning it.**
   * Every other route to a status is a thing that happens to you — eating,
   * stepping into a flame, being bitten — which is right for a game and useless
   * for tuning what one looks like: nobody wants to walk a rat into a fire
   * forty times to judge a colour ramp. It goes through {@link grantStatus}
   * rather than writing the list itself, so what an author sees here is a real
   * application with a real rolled duration and not a special case that could
   * drift from one.
   *
   * The catalogue is checked here rather than in the parser for the reason
   * `noSuchTarget` is: it is the world's, and the parser has never seen it.
   */
  private runStatusCommand(
    command: StatusCommand,
    authorId: string,
  ): CommandRefusal | null {
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

    this.grantStatus(actor, { id: def.id });
    // Said to whoever typed it rather than to the body it landed on: this is a
    // debugging acknowledgement, not something that happened in the world, and
    // a deer announcing that it is on fire because somebody set it on fire from
    // a console is a bubble the room should not see.
    this.say(authorId, statusGrantedNotice(def.name));
    return null;
  }

  /**
   * Move a body's hit points by hand.
   *
   * **A set is turned into a shift and then there is one path**, because the
   * alternative is two places that decide what reaching zero means — and the one
   * that forgot would leave a body standing at nothing. So this works out the
   * difference, and hands it to the same two doors everything else uses: harm
   * through {@link applyDamage}, so it shows its number, tells the brains and
   * can kill; a heal clamped at the maximum, which is the only thing a heal has
   * ever been allowed to do.
   *
   * A set above the maximum is the maximum rather than a refusal. "Full health"
   * is what somebody typing a big number meant, and making them look the ceiling
   * up first would be a worse debugging tool.
   */
  private runHealthCommand(
    command: HealthCommand,
    authorId: string,
  ): CommandRefusal | null {
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
      actor.hp = before + delta;
    }

    // Read back rather than computed, because a fatal blow takes the body off
    // the board and `hpOf` is the only thing that knows that happened.
    this.say(authorId, healthNotice(this.hpOf(actor) ?? 0, stats.maxHp));
    return null;
  }

  /**
   * Put one mastery exactly where it was asked for, or refuse the body.
   *
   * The experience is written rather than the level, because the level is
   * *derived* — see `../lib/mastery` — and a second place that stored one would
   * be a second answer to what a body is good at.
   *
   * **{@link bodyOf} is called first for its side effect**, which is the one
   * thing in here that is not obvious. A player who has never been in a fight
   * has no experience block at all: it is seeded from the authored tile the
   * first time anybody asks for their body. Writing one mastery into a missing
   * block would either be dropped or invent a body with six zeroes in it, so the
   * seeding has to have happened before the write lands on top of it.
   *
   * False for a body that does not learn — a creature's masteries are authored
   * and it has no runtime block to write to, which is exactly what the null here
   * means. @see ActorRuntime.masteryXp
   */
  private setMastery(
    actor: ActorRuntime,
    mastery: Mastery,
    level: number,
  ): boolean {
    this.bodyOf(actor);
    const xp = actor.masteryXp;
    if (!xp) return false;

    // Replaced rather than mutated, and the derived body dropped, on exactly the
    // terms `grantExperience` does both: identity is what tells a bar it moved,
    // and a memo built from the old figures would outlive them.
    actor.masteryXp = { ...xp, [mastery]: xpForLevel(level) };
    actor.earnedBody = null;
    this.masteriesChanged.add(actor.id);
    return true;
  }

  /**
   * Queue a sentence for one body's owner.
   *
   * Private and deliberately narrow: everything that puts a line in front of a
   * player goes through here, so there is one place to look when asking what the
   * game is capable of saying. @see ./notices
   */
  private say(actorId: string, text: string) {
    this.pendingNotices.push({ actorId, text });
  }

  /**
   * Take away everything queued for one body's owner.
   *
   * The id defaults to the local player, which is what makes this the
   * {@link PlaySession} face of the queue; the worker passes real ids and drains
   * one socket's worth at a time. Splicing rather than filtering because the
   * list is nearly always empty and never long — a reward is once per player per
   * chest, for ever.
   */
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

  /**
   * Mark an actor, replacing the list rather than pushing onto it.
   *
   * Same contract {@link setEquipment} keeps and for the same reason: the array
   * identity is what tells a renderer its rows are stale, and a list appended to
   * in place would leave an emptied chest still offering itself.
   */
  private setTags(actor: ActorRuntime, next: readonly string[]) {
    actor.tags = next;
    this.tagsChanged.add(actor.id);
  }

  canSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canSwitchFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  /** Replace the object with its switch target. Returns false when blocked. */
  activateSwitch(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    if (!this.canSwitch(ref, id)) return false;
    const loc = this.locate(this.actor(id));
    const def = interactiveDefAt(this.map, this.tilesById, loc, ref);
    const sw = def && resolveSwitch(def);
    if (!def || !sw) return false;

    const stack = getStack(this.map, ref.x, ref.y, ref.z);
    // Only the tile id changes. The slot's own state — facing, signal channel,
    // owner — belongs to the placement, not to whichever tile is filling it.
    const next = stack.map((placed, i) =>
      i === ref.stackIndex ? { ...placed, tileId: sw.targetTileId } : placed,
    );
    this.map = replaceStack(this.map, ref.x, ref.y, ref.z, next);
    // The tile switched into may be a plate — or may have been one.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return true;
  }

  canTeleport(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    return canTeleportFrom(
      this.map,
      this.tilesById,
      this.locate(actor),
      ref,
      this.defFor(actor),
    );
  }

  /**
   * Send this actor through. Returns false when the trip is not on offer.
   *
   * The pressed half only — a `step` teleport never arrives here, because there
   * is no press to route. See {@link teleportOnArrival}, which fires those, and
   * {@link moveThrough}, which both ends share so a portal you walk onto and one
   * you push cannot land you differently.
   */
  activateTeleport(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;

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
    if (!this.idle(actor)) return false;
    if (this.hpOf(actor) === null) return false;
    return canAddStatusFrom(this.map, this.tilesById, this.locate(actor), ref);
  }

  /**
   * Put the authored condition on whoever pressed this. Returns false when the
   * gesture is not on offer.
   *
   * The pressed half only — a `step` one never arrives here, because there is no
   * press to route. See {@link statusOnArrival}, which fires those.
   *
   * **Only a body with hit points takes it**, which is the one refusal this has
   * that the board cannot answer: every effect a status has is arithmetic on hit
   * points or on the stats a fight is fought with, so a crate left burning would
   * be a countdown nobody could see and a row that visibly did nothing. That
   * makes it the same rule `tickStatuses` already runs on — a bearer with no
   * battler is skipped — asked one step earlier so the row is never offered.
   */
  activateAddStatus(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const actor = this.actor(id);
    if (!this.idle(actor)) return false;
    if (this.hpOf(actor) === null) return false;

    const loc = this.locate(actor);
    const addStatus = reachableAddStatusAt(this.map, this.tilesById, loc, ref);
    if (!addStatus) return false;

    this.grantStatus(actor, { id: addStatus.statusId });
    return true;
  }

  /**
   * Take on whatever this actor has just arrived on top of.
   *
   * The `step` trigger, and the twin of {@link teleportOnArrival} in every way
   * that matters: asked once per tick per actor whose cell changed, asked of
   * every actor rather than only of players, and read top down so a pad with a
   * rug over it can be buried by its author.
   *
   * **Before the teleport, and that is the order that makes a trapdoor of fire
   * work**: it burns you where you landed and *then* takes you elsewhere. The
   * other way round the flame would be a tile the traveller was never on.
   *
   * A body with no hit points is left alone, on {@link activateAddStatus}'s own
   * argument: nothing a status does is visible on something that cannot be hurt.
   */
  private statusOnArrival(actor: ActorRuntime) {
    if (this.hpOf(actor) === null) return;

    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);

    for (let i = stack.length - 1; i >= 0; i--) {
      // Their own body, and anything riding above it. Neither is the floor they
      // stepped onto.
      if (i >= loc.stackIndex) continue;
      const placed = stack[i]!;
      const def = this.tilesById[placed.tileId];
      const addStatus = def ? resolveAddStatus(def) : null;
      if (!addStatus || addStatus.trigger !== "step") continue;
      // Whoever conjured the tile, if anybody did — which is what makes a flame
      // an arcanist lit pay them when somebody walks into it, and leaves every
      // hearth in the world attributed to nobody exactly as it was.
      this.grantStatus(
        actor,
        { id: addStatus.statusId },
        placed.castBy,
        placed.castElements,
      );
      return;
    }
  }

  /**
   * Put a body down at the far end of a teleport, whatever set it off.
   *
   * **Motion is dropped, not carried.** A walk half-drawn out of the cell you
   * just left would commit from the wrong end of the map, and a fall would go on
   * measuring a column that is no longer under anybody — so whatever this actor
   * thought it was doing is void, exactly as it is for a client whose prediction
   * this cancels. Facing survives, because it is the one part of the trip the
   * traveller decided.
   *
   * Falling from the far end is left to the next tick's {@link maybeStartFall},
   * for the reason `findEntryCell` gives about an arriving player: this decides
   * where somebody lands, not where they end up.
   *
   * The id is queued rather than the trip: nothing on the wire needs to know
   * where a teleport went, because the cell patches carry that already. What a
   * client cannot work out from the board is that the body it has been drawing
   * a step for is no longer the body's business — see the `teleported` event in
   * `../net/protocol`.
   */
  private moveThrough(actor: ActorRuntime, to: Coord) {
    const loc = this.locate(actor);
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

  /**
   * Go through whatever this actor has just arrived on top of.
   *
   * The `step` trigger, and the only one that is not a press. Asked once per
   * tick per actor whose cell changed, which is what keeps a pair of portals
   * pointed at each other from being a loop: arriving *by* teleport is not
   * arriving *by* step, so the far end does not fire on the tick it catches you.
   *
   * Every actor, not only players. A deer that wanders onto a pad goes through
   * it, on the same terms gravity and pressure plates already treat a body as a
   * body — the alternative is a test for what drives one, which nothing else in
   * the simulation has.
   *
   * The whole stack, top down: a pad with a rug thrown over it is still a pad,
   * and the topmost answer wins so an author can bury one under another. Bounded
   * by construction — one cell, and a stack is a handful of tiles.
   */
  private teleportOnArrival(actor: ActorRuntime) {
    const loc = this.locate(actor);
    const stack = getStack(this.map, loc.x, loc.y, loc.z);
    const def = this.defFor(actor);

    for (let i = stack.length - 1; i >= 0; i--) {
      // Their own body, and anything riding above it. Neither is the floor they
      // stepped onto.
      if (i >= loc.stackIndex) continue;
      const placed = stack[i]!;
      const teleport = resolveTeleport(placed, this.tilesById[placed.tileId], loc);
      if (!teleport || teleport.trigger !== "step") continue;
      if (!teleportFits(this.map, this.tilesById, def, teleport.to)) return;
      this.moveThrough(actor, teleport.to);
      return;
    }
  }

  /**
   * The one thing a tap on this object does. Everything an actor can do to
   * an object lives behind a single button, so the tile's own capabilities
   * pick the action rather than the input device — switch wins when authored,
   * push is the fallback. Returns false when nothing happened.
   *
   * Settles before returning, because this is the one edit that happens
   * *between* ticks: input arrives whenever it arrives, while everything else
   * that moves the board does so inside {@link tick}, which settles at the end.
   * Movement therefore reads the board at the top of a tick as already
   * answered-for, and an unsettled edit sitting there is a lie it will act on.
   *
   * A wired door is where that bites. Tapping one is allowed — a door may want
   * to be both tappable and overruled by its channel — but the tap used to
   * leave it open for the rest of the frame, which was long enough for a held
   * direction to start a step through a doorway the channel was about to shut.
   * The step is authorised once and committed later regardless, so the player
   * ended up through a locked door, or standing on top of it. Closed → tap →
   * open → channel disagrees → closed now happens with nothing in between.
   */
  interact(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    const acted =
      this.takeReward(ref, id) ||
      // Above the switch, and below the reward, on the reward's own argument:
      // this is the one of the three that takes the player somewhere else, so a
      // door authored to both open and lead through would otherwise spend the
      // tap on its hinge and leave them standing where they were.
      this.activateTeleport(ref, id) ||
      this.activateSwitch(ref, id) ||
      // Below the switch, because a brazier authored to both light a room and
      // burn the hand that lit it should light the room: the half of the tap the
      // player can see is the half they were aiming at.
      this.activateAddStatus(ref, id) ||
      // Below every authored swap and above everything to do with carrying,
      // which is where an explicit authored act belongs. It can never actually
      // compete with one of them: a tile that both opened a door and could be
      // mined is not a thing anybody has authored, and if they did, the hinge is
      // the half the player can see.
      this.extract(ref, id) ||
      this.equip(ref, id) ||
      this.pickUp(ref, id) ||
      this.push(ref, id);
    if (acted) this.settleBoardNow();
    return acted;
  }

  /** Is there anything a tap on this object would do right now? */
  canInteract(ref: ObjectRef, id: string = LOCAL_ACTOR_ID): boolean {
    return (
      this.canTakeReward(ref, id) ||
      this.canTeleport(ref, id) ||
      this.canSwitch(ref, id) ||
      this.canAddStatus(ref, id) ||
      this.canExtract(ref, id) ||
      this.canEquip(ref, id) ||
      this.canPickUp(ref, id) ||
      this.canPush(ref, id)
    );
  }

  private tickSlide(actor: ActorRuntime, tickMs: number) {
    if (!actor.slide) return;
    actor.slide.elapsedMs += tickMs;
    // Nothing to commit — the sprite has simply arrived where the map already
    // put it, so dropping the state is the whole of "landing".
    if (actor.slide.elapsedMs >= PUSH_STEP_MS) actor.slide = null;
  }

  /**
   * One actor's own motion for one tick — walking, falling, or starting to —
   * and then whatever the cell they ended it in does to them.
   *
   * The arrival check is here, around the whole of motion, rather than at the
   * end of the walk that usually causes it. A body reaches a new cell three
   * ways — it walks there, it falls there, or it slides off a ledge and does
   * both — and a `step` teleport that only answered to the first would be a pad
   * you could drop onto without going through. Comparing the cell either side of
   * the tick is one rule for all three, and it is what keeps a body still in
   * mid-air out of it: they have not arrived anywhere yet.
   */
  private tickMotion(actor: ActorRuntime, tickMs: number) {
    const from = this.locate(actor);
    this.advanceMotion(actor, tickMs);
    if (actor.fall) return;

    const to = this.locate(actor);
    if (to.x === from.x && to.y === from.y && to.z === from.z) return;
    this.arriveIn(actor);
  }

  /**
   * Whatever the cell an actor has just reached does to them.
   *
   * The two `step` triggers, in the order {@link statusOnArrival} argues for:
   * the floor burns you and then takes you elsewhere, so a trapdoor of fire is
   * a tile the traveller was in rather than one they were never on.
   *
   * A pair rather than two calls at each site, because "arriving" is one event
   * with two consequences and a caller that ran half of it would be a cell that
   * half works — see {@link push}, which is the caller that is not motion.
   */
  private arriveIn(actor: ActorRuntime) {
    this.statusOnArrival(actor);
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
    // Include leftover accumulator so 60fps+ renders interpolate between 30Hz ticks.
    const visualExtra = this.accumulatorMs;
    return {
      id: actor.id,
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
      // Unclamped, unlike the walk: a fall is a run of height units rather than
      // one lerp, and the tick that commits a unit lands after the unit's time
      // is up. Clamping there froze the sprite for a tick at every boundary and
      // then lurched it. Past 1 is exactly what the next step will confirm.
      fallProgress: actor.fall
        ? (actor.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT
        : 0,
      // Handed over by reference, exactly as `walk` and `fall` are: it is
      // mutated in place as it advances, so the same slide across two ticks is
      // the same object and the server can tell a continuing push from a new one.
      slide: actor.slide,
      slideProgress: actor.slide
        ? Math.min(1, (actor.slide.elapsedMs + visualExtra) / PUSH_STEP_MS)
        : 0,
      // By reference and clamped, on the same terms as the slide above.
      strike: actor.strike,
      strikeProgress: actor.strike
        ? Math.min(1, (actor.strike.elapsedMs + visualExtra) / STRIKE_DURATION_MS)
        : 0,
      hp: this.hpOf(actor),
      maxHp: this.battlerOf(actor)?.maxHp ?? null,
      rating: this.ratingOf(actor),
      // By reference, like the kit below: `advanceStatuses` replaces the list
      // wholesale, so the same array across two ticks is the same answer.
      statuses: actor.statuses,
      // By reference, like `walk` and `fall`: it is replaced wholesale whenever
      // a kit changes, so the same array across two ticks is the same answer and
      // nothing downstream has to copy it to be safe.
      carriedLights: actor.carriedLights,
    };
  }

  /**
   * Every actor, with no viewpoint. What the server broadcasts — it is not
   * looking at the world from anywhere.
   */
  actorSnapshots(): ActorSnapshot[] {
    return [...this.actors.values()].map((a) => this.actorSnapshot(a));
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
      conversation: self.conversation,
      extractCooling: this.extractCoolingOf(self.id),
      // Seeded by the line above rather than here: `actorSnapshots` asks every
      // body for its stats, which is what fills a fresh player's experience in
      // from their tile. The fallback is for the body that has none to give.
      masteryXp: self.masteryXp ?? {},
      // Nobody to talk to: the local simulation has no wire and no other actors
      // worth naming, so speech is a thing only the online client carries.
      chats: [],
      // Unlike speech, which needs somebody to have said it to somebody: a
      // noise is a thing that happened, and a world with one player in it still
      // has snakes in it.
      noises: this.liveNoise,
      damage: this.liveDamage,
      // By reference, and aged in place: the renderer reads the elapsed time off
      // the same object the tick loop is winding forward, exactly as a walk or a
      // strike is handed over live.
      projectiles: this.liveProjectiles,
    };
  }

  /**
   * Nothing is moving and nobody is asking to move.
   *
   * The server ticks only while this is false, so an idle world costs nothing
   * and its Durable Object can hibernate with sockets still open. The board
   * clause is the settle convergence condition rather than a flag: a pass that
   * changed something leaves `map !== settledMap`, so the world keeps ticking
   * until plates and channels agree with each other.
   */
  isAtRest(): boolean {
    // Something has been said that no brain has had a turn to hear. Resting on
    // it would stop the clock that was going to deliver it — and unlike a
    // wander, which merely happens later, this one never happens at all: the
    // next tick clears the page. A world with nothing else to do stays awake
    // for one brain tick and settles again.
    if (this.pendingHeard.length > 0) return false;
    // A blow nobody has had a turn to notice, on exactly the same grounds: the
    // next brain tick is what delivers it, and stopping the clock now would drop
    // it entirely rather than merely delay it.
    if (this.pendingHurt.size > 0) return false;
    // A sound nobody has had a turn to hear, on exactly those grounds again.
    if (this.pendingSound.length > 0) return false;
    // A round of decisions part-way through being taken. The three clauses
    // above are about events waiting for a round; this is a round waiting for
    // the ticks that carry it, and stopping the clock now would leave whoever
    // is still in the queue having never had their turn at all.
    if (this.brainQueueAt < this.brainQueue.length) return false;
    // Something is counting down, and this loop is the only clock it has. The
    // world therefore stays awake for as long as the longest lifetime on the
    // board — which is the price of decay being simulated rather than read off
    // the wall, and why a lifetime is authored in seconds. Blood keeps a world
    // ticking for half a minute after the last blow; a tile authored to decay
    // in an hour would keep it ticking for an hour.
    if (this.decay.pending()) return false;
    // An arrow in the air is a clock this loop owns, on exactly the terms a lean
    // is one below. Falling asleep under it would strand the thing mid-flight
    // for as long as nobody moved — and unlike a lean, which is over in 150ms,
    // a slow projectile authored across a courtyard is a visible second of
    // somebody's screen. The cost is bounded by what an author wrote, which is
    // the same bargain decay lifetimes are under.
    if (this.liveProjectiles.length > 0) return false;
    // A stone counting down is a clock this loop is the only thing winding, on
    // exactly the terms decay is: falling asleep on one would leave a caster
    // waiting for a cooldown that only resumes the next time somebody moves,
    // which is the same bug "reconnecting resets it" was avoided to prevent,
    // arrived at from the other side. Bounded by what an author wrote, which is
    // the same bargain a lifetime is under.
    if (this.anyStoneCooling()) return false;

    let observed = false;
    let thinking = false;
    for (const actor of this.actors.values()) {
      if (actor.walk || actor.fall || actor.slide || actor.strike) return false;
      // A recovery is a clock this loop is the only thing winding, exactly as a
      // lean is. Falling asleep under one would plant a body until the next
      // time somebody happened to move — and unlike the lean beside it, this
      // one is holding a *step* the player has already asked for.
      if (actor.attackRecoveryMs > 0) return false;
      // A resource wait is a clock this loop is the only thing winding, on
      // exactly a cooling stone's terms: falling asleep on one would leave the
      // row disabled and the bar under it frozen until somebody happened to
      // move, which is the same freeze the stone clause exists to prevent.
      // Bounded by what an author wrote, like every other clock in here.
      if (actor.extractCooldowns) return false;
      if (actor.input.directions.length > 0) return false;
      // Somebody standing still next to the thing they are fighting is not an
      // idle world: the next swing is on a cooldown that only this loop winds
      // down, so resting here would end the fight by falling asleep in it.
      //
      // Gated on attack mode, and that gate is what keeps targeting free: a
      // target held with the mode off produces no blows and no cooldowns, so a
      // player standing there watching a deer must not hold the world awake for
      // as long as they keep it in sight.
      if (actor.attacking && actor.targetId !== null) return false;

      if (!actor.resident) {
        observed = true;
      } else if (!thinking) {
        thinking = this.thinks(actor);
      }
    }

    // A creature counting down to its next move is pending work, even with
    // nothing on the board moving. Without this the loop stops the moment a
    // player stands still, which freezes the very timer that would have started
    // the next wander — stand still and the wildlife stops existing. Gated on
    // somebody being here, so an empty world is still free: that is the whole
    // bargain, and it is why brains freeze rather than run on an alarm.
    if (observed && thinking) return false;

    return this.map === this.settledMap;
  }

  /**
   * Is anybody in the world carrying a stone that has not finished cooling?
   *
   * Walked rather than counted, because a count would be a second piece of state
   * that every equip, drop, death and cast had to remember to keep in step — and
   * because there are three squares per body and the answer is almost always
   * found on the first one that is empty.
   */
  private anyStoneCooling(): boolean {
    for (const actor of this.actors.values()) {
      for (const square of CAST_SQUARES) {
        if (actor.equipment[square]?.cooldownMs) return true;
      }
    }
    return false;
  }

  /** Does this actor have a brain that is going to want a turn? */
  private thinks(actor: ActorRuntime): boolean {
    const loc = this.tryLocate(actor);
    if (!loc) return false;
    const def = this.tilesById[loc.placed.tileId];
    return def != null && resolveBrain(def) !== null;
  }

  getMap(): MapFile {
    return this.map;
  }

  /**
   * The tile an actor *is*, which is what every rule about their motion has to
   * be asked against.
   *
   * This was the player's def for everybody, which was true for exactly as long
   * as every actor was a person. A deer is a different height, may climb
   * differently, and need not answer to gravity at all — reading the def off
   * the body means none of that is a special case, and a new creature is a tile
   * rather than a branch.
   *
   * Read through the location memo rather than stored on the runtime, because
   * the body can be swapped underneath an actor and a copy would go stale.
   */
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
    actor.walk = null;
  }

  /**
   * Is another actor already walking into this cell?
   *
   * A walk commits to the map only when it lands, so for the whole step the
   * destination still reads as empty to everyone else. Two actors pressing the
   * same direction on the same tick therefore both pass {@link canWalk} and
   * both arrive, ending up inside one another — the map cannot answer this
   * question because the answer is not in the map yet.
   *
   * Reserving the destination rather than committing the move up front keeps
   * the existing rule that a step is only real once it lands, which the whole
   * of gravity and plate settling is written against.
   *
   * **A reservation is exactly as strong as the arrival it stands in for.** Two
   * people may end a step in one cell, so a person walking there reserves it
   * against creatures and against nobody else — refusing on their behalf would
   * put the cell-sharing rule back in force for one step in every two, which
   * reads as a doorway that intermittently refuses you. Everything else reserves
   * against everybody. @see ../lib/validation's `FitOpts`
   */
  private destinationTaken(cell: Coord, except: ActorRuntime): boolean {
    const throughPlayers = this.defFor(except).id === PLAYER_TILE_ID;
    for (const other of this.actors.values()) {
      if (other === except) continue;
      const to = other.walk?.to;
      if (!to || to.x !== cell.x || to.y !== cell.y || to.z !== cell.z) continue;
      if (throughPlayers && isPlayerBody(this.locate(other).placed)) continue;
      return true;
    }
    return false;
  }

  private maybeStartWalk(actor: ActorRuntime) {
    this.applyStepRequest(actor, actor.input);
  }

  /**
   * Turn, and walk if the board allows it. The one path from "what is being
   * asked for" to "what the actor does", whether the asking is a held key in
   * `/play` or a step a networked client has already predicted.
   */
  private applyStepRequest(
    actor: ActorRuntime,
    request: StepRequest,
  ): boolean {
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

    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      choice.facing,
    );

    if (!choice.step) return false;
    // After the turn, not before it. A body planted by its own blow can still
    // face where it wants to go — what a swing costs is the *step*, and
    // refusing the turn as well would make a fought corner impossible to aim
    // out of. It is also the same split `chooseStep` already draws.
    if (actor.attackRecoveryMs > 0) return false;

    actor.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs: 0,
      durationMs: resolveWalkDurationMs(this.defFor(actor)),
    };
    return true;
  }

  /**
   * Take one step, because a client says it has already taken it.
   *
   * The other way in besides held input, and the one online play uses. A
   * browser predicting its own movement decides *when* a step happens — that is
   * the whole point, since waiting for this object to decide is the latency
   * being removed — and this re-runs the same rule against the authoritative
   * board to decide whether it is allowed to have happened.
   *
   * Deciding when does not mean deciding how fast: a step is only taken while
   * the actor is free, so a client sending a thousand of these walks at exactly
   * the same pace as one sending the honest four per second.
   *
   * `"later"` is the answer for an actor still finishing a walk, and it is not a
   * refusal — the client is half a round trip ahead by design, so its next
   * intent routinely arrives a few milliseconds before this side is done with
   * the last one. The caller holds it and asks again. A fall or a slide *is* a
   * refusal: those are motion the client did not predict, so whatever it thought
   * it was doing is already void.
   */
  requestStep(
    id: string,
    direction: Direction,
    opts?: { preferDescend?: boolean },
  ): "started" | "later" | "refused" {
    const actor = this.actor(id);
    if (actor.fall || actor.slide) return "refused";
    if (actor.walk) return "later";
    // `"later"` on the same grounds a walk is, and not a refusal: a recovery is
    // a wait, so the step the client drew is one it is going to get. Rejecting
    // it would drag the body back to where it swung from, which is the one
    // thing the client would then have to *animate* — a correction for
    // something neither side disagrees about.
    if (actor.attackRecoveryMs > 0) return "later";

    const started = this.applyStepRequest(actor, {
      directions: [direction],
      preferDescend: opts?.preferDescend,
    });
    return started ? "started" : "refused";
  }

  /** Turn an actor on the spot, without asking them to go anywhere. */
  faceActor(id: string, direction: Direction) {
    const actor = this.actor(id);
    const loc = this.locate(actor);
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );
  }

  private maybeStartFall(actor: ActorRuntime) {
    if (!this.defFor(actor).affectedByGravity) return;

    const loc = this.locate(actor);
    if (
      isSupported(this.map, loc.x, loc.y, loc.z, loc.stackIndex, this.tilesById)
    ) {
      return;
    }

    const feetAbs = standingAbs(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      this.tilesById,
    );
    const landing = findLandingAbs(this.map, loc.x, loc.y, feetAbs, this.tilesById, {
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
    if (landing == null || landing >= feetAbs) return;

    // Drops within climb height are step-downs (same as same-level height
    // change) — snap onto the surface instead of playing a fall.
    if (feetAbs - landing <= MAX_CLIMB_HEIGHT) {
      this.land(actor, landing);
      return;
    }

    actor.fall = { feetAbs, landingAbs: landing, elapsedMs: 0 };
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
    const loc = this.locate(actor);
    const exclude = { z: loc.z, stackIndex: loc.stackIndex };

    if (
      !isWalkableSurfaceAt(
        this.map,
        loc.x,
        loc.y,
        landingAbs,
        this.tilesById,
        exclude,
      )
    ) {
      this.commitLandAt(actor, landingAbs);
      const after = this.locate(actor);
      const facing = actorDirection(after);
      const slide = canWalk(
        this.map,
        { x: after.x, y: after.y, z: after.z, stackIndex: after.stackIndex },
        facing,
        this.defFor(actor),
        this.tilesById,
      );
      if (slide.ok) {
        actor.walk = {
          from: { x: after.x, y: after.y, z: after.z },
          to: slide.to,
          direction: facing,
          elapsedMs: 0,
          durationMs: resolveWalkDurationMs(this.defFor(actor)),
        };
        return;
      }

      const nextWalkable = findWalkableLandingAbs(
        this.map,
        after.x,
        after.y,
        landingAbs,
        this.tilesById,
        { z: after.z, stackIndex: after.stackIndex },
      );
      if (nextWalkable != null && nextWalkable < landingAbs) {
        const feetAbs = standingAbs(
          this.map,
          after.x,
          after.y,
          after.z,
          after.stackIndex,
          this.tilesById,
        );
        if (feetAbs - nextWalkable <= MAX_CLIMB_HEIGHT) {
          this.commitLandAt(actor, nextWalkable);
          return;
        }
        actor.fall = { feetAbs, landingAbs: nextWalkable, elapsedMs: 0 };
        return;
      }
      return;
    }

    this.commitLandAt(actor, landingAbs);
  }

  private commitLandAt(actor: ActorRuntime, landingAbs: number) {
    const loc = this.locate(actor);
    const { z: targetZ } = cellForFeetAbs(landingAbs);
    const placed = { ...loc.placed };

    const next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    // Prefer attaching onto scenery whose top matches the landing.
    for (const zTry of [targetZ, targetZ - 1, loc.z]) {
      if (zTry < MIN_LEVEL) continue;
      const stack = getStack(next, loc.x, loc.y, zTry);
      if (stack.length === 0) continue;
      const top = absoluteStandingElevation(zTry, stack, this.tilesById);
      if (top === landingAbs) {
        this.map = placeEntityOnSurface(
          next,
          loc.x,
          loc.y,
          zTry,
          placed,
          this.tilesById,
        );
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
      next = placeEntityOnSurface(
        next,
        loc.x,
        loc.y,
        newZ,
        placed,
        this.tilesById,
      );
    } else {
      next = appendTile(next, loc.x, loc.y, newZ, placed);
    }
    this.map = next;
  }
}

import {
  absoluteStandingElevation,
  appendTile,
  getStack,
  isWalkableSurfaceAt,
  removeTileAt,
  replaceStack,
} from "../lib/mapData";
import {
  resolveAddStatus,
  resolveSwitch,
  resolveTeleport,
} from "../lib/interactions";
import {
  type ConsumableItem,
  isItem,
  isRanged,
  type StatusGrant,
  resolveConsumable,
} from "../lib/item";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { MIN_LEVEL } from "../lib/types";
import {
  canPlace,
  canReplaceStack,
  tilesByIdFromList,
} from "../lib/validation";
import {
  actorDirection,
  adoptAuthoredPlayer,
  adoptBodyAt,
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
  masteryNotice,
  otherMasteryNotice,
  rewardNotice,
} from "./notices";
import { parseCommand } from "./commands";
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
} from "../lib/battler";
import {
  experienceMultiplier,
  hasExperience,
  levelForXp,
  MASTERIES,
  type Mastery,
  masteriesFromXp,
  type MasteryXp,
  rating,
  xpForLevel,
  xpFromMasteries,
} from "../lib/mastery";
import {
  type AttackOutcome,
  swingIntervalMs,
  canReach,
  rollAttack,
} from "./combat";
import type { Equipment } from "./equipment";
import {
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  weaponInHand,
  wornInstances,
} from "./equipment";
import { equipmentForBody } from "./battlerKit";
import {
  attackerEarnings,
  defenderEarnings,
  defensiveDecay,
  DEFENSIVE_RECOVERY_MS,
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
  clearSlot,
  itemInSlot,
  stashInContainer,
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
  DIR_DELTA,
  resolveWalkDurationMs,
  standingAbs,
  surfacesInClimbBand,
} from "./movement";
import { findPath } from "./pathfinding";
import { resolveBrain } from "../lib/brain";
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
   * Where this creature is in its state machine, or null for a body with no
   * brain — every player, and any creature whose authored brain did not parse.
   * Built on first use rather than at adoption, which is what makes "brain
   * state resets on load" free: a fresh runtime has no memory to restore.
   */
  brain: BrainMemory | null;
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
  /** Actors whose tags have changed and whose owner has not been told yet. */
  private readonly tagsChanged = new Set<string>();
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
   * The world's dice, shared by every brain in it.
   *
   * One stream rather than one per creature, which makes actor order part of
   * what makes a world reproducible — the same order that already decides who
   * wins a contested cell.
   */
  private readonly rng: Rng;
  /** Time towards the next round of decisions. See {@link BRAIN_TICK_MS}. */
  private brainAccumulatorMs = 0;
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
      brain: null,
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
      targetId: null,
      attacking: false,
      input: { directions: [] },
      walk: null,
      fall: null,
      slide: null,
      strike: null,
      memo: null,
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

    // Before the bodies move, so a decision taken now starts its walk on this
    // tick rather than the next.
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
      return;
    }

    this.brainAccumulatorMs += tickMs;
    if (this.brainAccumulatorMs < BRAIN_TICK_MS) return;
    this.brainAccumulatorMs -= BRAIN_TICK_MS;

    // Taken before anybody decides anything, so a howl made during this pass is
    // next pass's business for every ear alike. @see pendingSound
    const sounds = this.pendingSound;
    this.pendingSound = [];

    for (const actor of this.actors.values()) {
      if (!actor.resident) continue;
      this.tickOneBrain(actor, sounds);
    }

    // Every brain has now had its one chance at this round of speech. Clearing
    // after the whole pass rather than per creature is what makes one word
    // reach every ear at once — and clearing at all is what keeps it an event
    // instead of a standing fact about the world.
    this.pendingHeard = [];
    // And its one chance to notice being hit, on the same terms: a blow is an
    // event, so a creature that was struck reacts once rather than reacting
    // forever to a fact that never goes away.
    this.pendingHurt.clear();
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
      canSee: (at) =>
        hasLineOfSight(
          this.map,
          this.tilesById,
          { x: loc.x, y: loc.y, z: loc.z },
          at,
          // Its own body's height, so what it can see over falls out of how tall
          // it is drawn: a person clears the crates a rat has to walk around.
          this.defFor(actor).height,
        ),
      // A creature with no stat block minds its own floor, which is what every
      // creature did before this was authorable.
      sight: this.battlerOf(actor)?.sight ?? DEFAULT_BATTLER.sight,
      heard: () => this.pendingHeard,
      heardNoise: () => soundsHeardBy(sounds, actor.id),
      hurtBy: () => this.pendingHurt.get(actor.id) ?? EMPTY_ATTACKERS,
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
    attacker.attackCooldownMs = swingIntervalMs(attackerStats);

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
    this.fireProjectile(attackerStats, fromPoint, toPoint);

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

    const outcome = rollAttack(attackerStats, targetStats, this.rng);
    // Noted even on a dodge: what a creature reacts to is being swung at, and a
    // cat that only fought back when a blow landed would stand there being
    // missed. Before the damage, so a killing blow still tells the room.
    this.notePendingHurt(target.id, attacker.id);
    // Before the damage too, so the killing blow pays for itself — a body that
    // has already left the board has no experience to be given.
    this.awardExperience(attacker, target, outcome);

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
   * Put this weapon's projectile in the air, if it has one.
   *
   * Silently nothing for a melee weapon, which is the overwhelming majority and
   * is not a special case anybody had to write: `projectile` is absent, so there
   * is nothing to loose. That is the same shape the lean above has in reverse,
   * and between them every weapon says exactly one thing about itself.
   *
   * The flight is queued twice for the reason a damage number is — see
   * {@link pendingDamage} and {@link liveDamage}. One list is "what happened in
   * the last tick", which the wire drains once; the other is "what a viewer
   * should still be able to see", which outlives it by the length of the flight.
   */
  private fireProjectile(
    attacker: FightingStats,
    from: ReachPoint,
    to: ReachPoint,
  ) {
    const projectile = attacker.projectile;
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
            weaponInHand(body, attacker.equipment, this.tilesById),
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
      this.map = appendTile(this.map, at.x, at.y, at.z, placed);
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
    return effectiveBattler(body, actor.equipment, this.tilesById);
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
  private grantStatus(actor: ActorRuntime, grant: StatusGrant) {
    const def = this.statusDefs[grant.id];
    if (!def) return;
    // The item's range where it states one, and the status's own otherwise —
    // see `../lib/item`'s `StatusGrant`. Both ends or neither, so this
    // cannot end up ordering one source's floor against another's ceiling.
    const range =
      grant.fromMs === undefined || grant.toMs === undefined
        ? def
        : { fromMs: grant.fromMs, toMs: grant.toMs };
    actor.statuses = applyStatus(actor.statuses, def, this.rng, range);
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
        if (change < 0) {
          this.applyDamage(actor, -change);
          // A body that has just died is off the board, and everything after
          // this would be arithmetic on a corpse.
          if (actor.hp === 0) break;
          continue;
        }
        if (change === 0) continue;
        const stats = this.battlerOf(actor);
        const before = this.hpOf(actor);
        if (stats && before !== null) {
          actor.hp = Math.min(stats.maxHp, before + change);
        }
      }
    }
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

  /** Where an actor is standing, or null once they are off the board. */
  private actorCell(id: string): Coord | null {
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

    const bag = actor.equipment.bag;
    if (destination.kind === "contents" && !bag) return false;

    const instance = this.takeFromBoard(ref);
    if (!instance) return false;

    this.setEquipment(
      actor,
      destination.kind === "contents"
        ? {
            ...actor.equipment,
            bag: { ...bag!, contents: [...(bag!.contents ?? []), instance] },
          }
        : { ...actor.equipment, [destination.slot]: instance },
    );
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

    const placed = getStack(this.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    if (!consumable) return null;

    this.map = removeTileAt(this.map, ref.x, ref.y, ref.z, ref.stackIndex);
    // The cell has one fewer thing in it — the same reindex a pickup owes, for
    // the same plates and the same unsupported crates.
    this.reindexCells([{ x: ref.x, y: ref.y, z: ref.z }]);
    return consumable;
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

    const emptied = clearSlot(this.map, this.tilesById, loc, actor.equipment, slot);
    if (!emptied) return null;

    this.map = emptied.map;
    // Only when it actually changed, exactly as a move does: eating out of a
    // chest is the chest's placement changing and nobody's kit.
    if (emptied.equipment !== actor.equipment) {
      this.setEquipment(actor, emptied.equipment);
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
        ? stashInContainer(emptied.map, destination.ref, instance)
        : appendTile(
            emptied.map,
            to.x,
            to.y,
            to.z,
            placementFromInstance(instance),
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
   * Carry out something somebody typed, or tell them why it did not happen.
   *
   * **The command's one entry point, and the only place the world is changed by
   * words.** Everything ahead of it is grammar (`./commands`) and everything
   * behind it is prose (`./notices`); what is left here is the two questions
   * only a session can answer — is there a body by that name, and does it learn.
   *
   * **Nobody is checked.** Any player may set any mastery on anybody, which is
   * deliberate and temporary; see the note at the top of `./commands`. When that
   * changes, this is the method that grows the gate — one place, ahead of the
   * work, because a command is a request until something acts on it.
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
  runCommand(raw: string, id: string = LOCAL_ACTOR_ID) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      this.say(id, commandRefusalNotice(parsed.refusal));
      return;
    }

    const { mastery, level, target } = parsed.command;
    const targetId = target ?? id;
    const actor = this.actors.get(targetId);
    if (!actor) {
      this.say(
        id,
        commandRefusalNotice({ kind: "noSuchTarget", typed: targetId }),
      );
      return;
    }

    if (!this.setMastery(actor, mastery, level)) {
      this.say(
        id,
        commandRefusalNotice({
          kind: "unteachableTarget",
          // Their tile's name for a creature and their handle for a person,
          // through the one function that decides what a body is called.
          name: this.bodyName(targetId) ?? targetId,
        }),
      );
      return;
    }

    this.say(actor.id, masteryNotice(mastery, level));
    if (actor.id === id) return;
    this.say(
      id,
      otherMasteryNotice(this.bodyName(actor.id) ?? actor.id, mastery, level),
    );
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
      this.grantStatus(actor, { id: addStatus.statusId });
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

    let observed = false;
    let thinking = false;
    for (const actor of this.actors.values()) {
      if (actor.walk || actor.fall || actor.slide || actor.strike) return false;
      // A recovery is a clock this loop is the only thing winding, exactly as a
      // lean is. Falling asleep under one would plant a body until the next
      // time somebody happened to move — and unlike the lean beside it, this
      // one is holding a *step* the player has already asked for.
      if (actor.attackRecoveryMs > 0) return false;
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
   */
  private destinationTaken(cell: Coord, except: ActorRuntime): boolean {
    for (const other of this.actors.values()) {
      if (other === except) continue;
      const to = other.walk?.to;
      if (to && to.x === cell.x && to.y === cell.y && to.z === cell.z) {
        return true;
      }
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

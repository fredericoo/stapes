import * as v from "valibot";
import type { BattlerDef } from "./battler";
import type { BrainDef } from "./brain";
import type { ItemDef } from "./item";
import { itemForSave, MAX_CONTAINER_SIZE, resolveItem } from "./item";
import type { PlacedTile, TileDef } from "./types";
import { HEIGHT_PER_LEVEL, resolveActor } from "./types";

/**
 * How far up a pushed object can step. Descent is deliberately absent —
 * going down is physics: any step down is legal, and whether the object then
 * falls is already answered by {@link TileDef.affectedByGravity}.
 */
export type ClimbAbility = "none" | "half" | "full";

export const CLIMB_ABILITIES: ClimbAbility[] = ["none", "half", "full"];

/** Max upward step in absolute height units, per ability. */
export const CLIMB_HEIGHT_UNITS: Record<ClimbAbility, number> = {
  none: 0,
  half: HEIGHT_PER_LEVEL / 2,
  full: HEIGHT_PER_LEVEL,
};

/**
 * The player shoves this object one cell directly away from themselves. There
 * is no distance to author: a push is always exactly one cell, which is what
 * makes it legible without a pointer — you stand somewhere and the direction
 * follows from where you are.
 */
export type PushInteraction = {
  /** Max upward step. Descent is unconstrained — gravity resolves it. */
  climb: ClimbAbility;
  /** When non-empty, the object may only come to rest on these tile ids. */
  moveOnTileIds: string[];
};

/**
 * Replace this placement with another tile when the player activates it.
 * Author the reverse on the target for a toggle (e.g. door open ↔ closed).
 */
export type SwitchInteraction = {
  targetTileId: string;
  /**
   * What doing it is called — "Open", "Close", "Light", "Pull".
   *
   * Authored per tile because only the author knows: the two halves of a door
   * are the same mechanism pointing at each other, and nothing derivable from
   * the tiles says which one opens and which one shuts. Everything else the
   * player can do has one honest verb ("Push", "Attack") that belongs to the
   * *interaction*; a switch is the one whose verb belongs to the tile.
   *
   * Optional, and blank is legal: `data/tiles.json` predates the field, and a
   * switch with nothing written here is still a switch. Whatever offers the
   * action falls back to naming the kind.
   */
  actionName?: string;
};

/**
 * Become another tile — or stop existing — once this one has been on the board
 * long enough.
 *
 * A {@link SwitchInteraction} whose input is time rather than a tap, and the
 * same one-way swap: blood dries to a stain because the blood tile says so, and
 * the stain fades because the stain tile says so in turn. Nothing here counts
 * down twice.
 *
 * The clock is the session's, not the wall's, and the deadline is held beside
 * the map rather than written onto the placement — see `../game/decay` for why
 * both of those matter.
 */
export type DecayInteraction = {
  /**
   * Tile this becomes when its time is up. **Blank removes the placement**,
   * which is the common case: there is no `air` tile to name, and a splash of
   * blood that has finished drying is simply not there any more.
   *
   * Unlike every other block in here a blank target is therefore meaningful
   * rather than malformed, so {@link afterMs} is what says whether a tile
   * decays at all.
   */
  tileId: string;
  /**
   * Shortest a placement of this tile can last, in milliseconds of simulated
   * time.
   *
   * Simulated rather than real: it advances with the tick loop, so a world
   * nobody is in does not quietly age. It is also what a decaying tile costs —
   * pending decay keeps the world ticking (see `GameSession.isAtRest`), so this
   * is a few seconds for blood, not an hour for a monument.
   */
  fromMs: number;
  /**
   * Longest it can last. A lifetime is drawn from the range once, when the
   * placement is first seen, and never redrawn.
   *
   * A range rather than a number because the motivating case spawns in bursts:
   * every splash of blood from one fight would otherwise be placed within a few
   * ticks of its neighbours and vanish with them, and a floor that clears itself
   * all at once reads as a bug rather than as drying. Equal ends are legal and
   * mean exactly what a single lifetime meant.
   *
   * Must be at least {@link fromMs}. An inverted range is malformed rather than
   * silently swapped, on the same terms as every other block here: it reads as
   * "does not decay".
   */
  toMs: number;
};

/**
 * Come back once a placement of this tile is gone — the mirror of
 * {@link DecayInteraction}, with the arrow reversed: decay counts down while a
 * placement exists, respawn counts down while one is missing.
 *
 * Configured on the tile def, tracked per authored placement: each spot this
 * tile was placed at in the editor is its own spawn point, and each comes back
 * on its own clock. A creature is tracked by the identity it was adopted under
 * (see `../game/actors.residentOwnerId`), so one that wandered off is still
 * alive wherever it stands; an object is tracked by its authored cell, so one
 * carried away reads as gone and grows back — taking the sword is what makes
 * the sword worth authoring a respawn on.
 *
 * Unlike decay this clock is the wall's, not the session's: the deadline is
 * held by the server and survives the world going quiet, so a world nobody
 * visited for an hour comes back repopulated rather than owing an hour of
 * ticking. See `workers/GameServer` for the machinery.
 */
export type RespawnInteraction = {
  /** Shortest a spawn point can sit empty, in wall-clock milliseconds. */
  fromMs: number;
  /**
   * Longest it can sit empty. The wait is drawn from the range once per
   * disappearance. A range for the same reason decay's lifetime is one: a camp
   * cleared in one fight coming back all on the same second reads as a bug
   * rather than as the world recovering. Equal ends are legal.
   *
   * Must be at least {@link fromMs}; an inverted range reads as "does not
   * respawn", on the same terms as every other malformed block here.
   */
  toMs: number;
};

/** How a plate's authored {@link PressurePlateInteraction.height} reads its load. */
export type PlateComparison = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export const PLATE_COMPARISONS: PlateComparison[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
];

const COMPARATORS: Record<
  PlateComparison,
  (load: number, height: number) => boolean
> = {
  eq: (load, height) => load === height,
  neq: (load, height) => load !== height,
  gt: (load, height) => load > height,
  gte: (load, height) => load >= height,
  lt: (load, height) => load < height,
  lte: (load, height) => load <= height,
};

/**
 * A plate that watches what is stacked on top of it and swaps itself out the
 * moment the comparison holds. Unlike push and switch this is not something
 * the player aims at — the board pressing on it is the whole input.
 *
 * One plate is only half a mechanism: the swap is one-way, and the behaviour
 * comes from what the target tile does in turn. Two plates pointing at each
 * other (`gte 1` → pressed, `lte 0` → unpressed) follow their load; a target
 * with no plate of its own stays pressed forever.
 */
export type PressurePlateInteraction = {
  /** Tile this becomes while the comparison holds. */
  tileId: string;
  /** How {@link height} is compared against the load resting on the plate. */
  type: PlateComparison;
  /**
   * Load to compare against, in height units — a half-height crate is 1 and a
   * full level is {@link HEIGHT_PER_LEVEL}. Flat and intangible tiles weigh
   * nothing, so `gte 1` reads as "something solid is standing here".
   */
  height: number;
};

/** The two states a signal channel can be in. */
export type SignalValue = "on" | "off";

export const SIGNAL_VALUES: SignalValue[] = ["on", "off"];

/**
 * While this tile is placed on a wired cell, it drives that cell's channel to
 * {@link value}.
 *
 * The tile def *is* the state — `torch_lit` emits on, `torch_unlit` emits off
 * — so nothing here says when to switch. That stays with whatever already
 * moves the tile between its two forms: a {@link SwitchInteraction} the player
 * taps, or a {@link PressurePlateInteraction} the board presses.
 *
 * Which channel is not authored here either. A tile def is placed many times
 * over and each copy answers to a different wire, so the channel lives on the
 * placement ({@link PlacedTile.channel}).
 */
export type EmitInteraction = {
  value: SignalValue;
};

/** How a receiver reads a channel driven by more than one emitter. */
export type SignalMode = "any" | "all";

export const SIGNAL_MODES: SignalMode[] = ["any", "all"];

/**
 * Swap this tile out for another while its cell's channel reads {@link when}.
 *
 * Deliberately the same shape as {@link PressurePlateInteraction} — a
 * condition and the tile to become — because it is the same mechanism with a
 * different sensor, and one authored half is likewise only half of it: a door
 * that opens on `on` needs its open form to close on `off`, or it opens once
 * and stays open.
 */
export type ReceiveInteraction = {
  /** Tile this becomes while the channel matches. */
  tileId: string;
  /** Channel reading that triggers the swap. */
  when: SignalValue;
  /** With several emitters on the channel: any of them on, or all of them. */
  mode: SignalMode;
};

/**
 * This tile hands things over — a chest you open, a person you receive from.
 *
 * **The block is a marker, and almost everything about the reward is on the
 * placement** ({@link PlacedTile.rewardTag} and
 * {@link PlacedTile.rewardTileIds}). Exactly the split {@link EmitInteraction}
 * makes: the tile is the kind of thing, the slot is which particular one. One
 * `quest-chest` tile can furnish a whole map, and the three chests in a dungeon
 * differ by what is written on their placements rather than by being three tile
 * defs that happen to look alike.
 *
 * **The tile never changes, and that is the whole design.** Every other authored
 * swap in this file — switch, plate, receive — edits the board, which is what
 * makes it the same for everybody looking at it. "Once per player" cannot be
 * that: the chest has to still be there for the next person who walks in. So
 * what a reward changes is the *taker* ({@link ActorRuntime.tags}), exactly as
 * hit points and equipment are per-actor state that no cell patch carries, and
 * a chest somebody has emptied looks untouched to the room.
 *
 * **One tag, granted and gating.** Taking it writes the placement's tag onto the
 * player, and holding that tag is what stops them taking it — one field rather
 * than a granted/blocking pair, so a reward cannot be authored repeatable by
 * accident. Two placements sharing a tag are therefore a *choice*: give the left
 * chest and the right chest both `chest-42` and opening either closes the other.
 */
export type RewardInteraction = {
  /**
   * What taking it is called — "Open" on a chest, "Receive" from a person.
   *
   * The one field that genuinely belongs to the tile rather than to the slot: it
   * describes the *gesture*, which is a property of what the thing is. Every
   * chest cut from one tile is opened; what is inside them differs.
   *
   * Authored for the same reason {@link SwitchInteraction.actionName} is —
   * nothing derivable from a tile that hands over a sword says whether you are
   * prising it out of a box or being given it. Optional, and blank reads as
   * "Take".
   */
  actionName?: string;
};

/**
 * A reward as it is actually offered: the tile's half and the slot's half, read
 * together.
 *
 * Nothing consumes the two separately, because neither is a reward on its own —
 * a chest tile with nothing written on this placement gives nothing, and a tag
 * on a placement of a tile that is not a giver is a note nobody reads. So the
 * halves are joined once, in {@link resolveReward}, and everything downstream
 * takes this.
 */
export type PlacedReward = {
  actionName?: string;
  tag: string;
  itemTileIds: string[];
};

/**
 * Most items one placement may hand over.
 *
 * The largest bag there is, because the taker needs room for *all* of them at
 * once — see `rewardFits`. A reward authored bigger than any container in the
 * game is not a generous reward, it is one nobody can ever take.
 */
export const MAX_REWARD_ITEMS = MAX_CONTAINER_SIZE;

/** Ways a placed object can behave in play. Grows over time. */
export type TileInteractions = {
  /**
   * What drives this body when nobody is connected to it. Only meaningful on a
   * tile marked {@link TileDef.actor}; see `./brain`, which owns the shape and
   * the parsing — it is large enough to be its own module rather than another
   * block in here.
   */
  brain?: BrainDef;
  /**
   * Hit points and the numbers that spend them. See `./battler`, which owns the
   * shape and the parsing.
   *
   * Independent of {@link brain} and of {@link TileDef.actor}: hit points are a
   * property of a body, not of what drives one. The player is a battler with no
   * brain, a deer is a battler with one, and a crate could be a battler with
   * neither.
   *
   * Read only on a tile whose {@link TileDef.kind} is `battler` — see
   * `resolveBattler`.
   */
  battler?: BattlerDef;
  /**
   * What it takes to be carried. See `./item`, which owns the shape and the
   * parsing.
   *
   * Mutually exclusive with {@link battler}, unlike every other pair in here,
   * and the exclusivity is stated by {@link TileDef.kind} rather than by this
   * block's presence: both resolvers refuse a tile whose kind is not theirs, so
   * a stale block is inert rather than in charge.
   */
  item?: ItemDef;
  push?: PushInteraction;
  switch?: SwitchInteraction;
  reward?: RewardInteraction;
  decay?: DecayInteraction;
  respawn?: RespawnInteraction;
  pressurePlate?: PressurePlateInteraction;
  emit?: EmitInteraction;
  receive?: ReceiveInteraction;
};

export const DEFAULT_SWITCH: SwitchInteraction = {
  targetTileId: "",
  actionName: "",
};

export const DEFAULT_REWARD: RewardInteraction = {
  actionName: "",
};

/**
 * Long enough to read as an aftermath rather than a glitch, short enough that a
 * fight's worth of blood is gone before the next one starts — and spread wide
 * enough that a burst of it does not clear in one frame.
 */
const DEFAULT_DECAY_FROM_MS = 20_000;
const DEFAULT_DECAY_TO_MS = 40_000;

export const DEFAULT_DECAY: DecayInteraction = {
  tileId: "",
  fromMs: DEFAULT_DECAY_FROM_MS,
  toMs: DEFAULT_DECAY_TO_MS,
};

/**
 * Long enough that clearing a spot feels like it happened, short enough that a
 * player who came back for the creature does not find the world permanently
 * poorer — and spread so a cleared camp trickles back rather than reappearing
 * in one frame.
 */
const DEFAULT_RESPAWN_FROM_MS = 30_000;
const DEFAULT_RESPAWN_TO_MS = 60_000;

export const DEFAULT_RESPAWN: RespawnInteraction = {
  fromMs: DEFAULT_RESPAWN_FROM_MS,
  toMs: DEFAULT_RESPAWN_TO_MS,
};

export const DEFAULT_PUSH: PushInteraction = {
  climb: "half",
  moveOnTileIds: [],
};

export const DEFAULT_PRESSURE_PLATE: PressurePlateInteraction = {
  tileId: "",
  type: "gte",
  height: 1,
};

export const DEFAULT_EMIT: EmitInteraction = {
  value: "on",
};

export const DEFAULT_RECEIVE: ReceiveInteraction = {
  tileId: "",
  when: "on",
  mode: "any",
};

/** Does the load resting on this plate satisfy its authored comparison? */
export function plateTriggers(
  plate: PressurePlateInteraction,
  load: number,
): boolean {
  return COMPARATORS[plate.type](load, plate.height);
}

const pushSchema = v.object({
  climb: v.picklist(CLIMB_ABILITIES),
  moveOnTileIds: v.array(v.string()),
});

/**
 * Parsed push config per tile def. `data/tiles.json` is hand-editable, so the
 * shape is validated rather than trusted; a malformed block reads as "not
 * pushable" instead of throwing mid-frame.
 *
 * Memoised on def identity — {@link isInteractive} runs over every candidate
 * tile on each pointer move.
 */
const pushCache = new WeakMap<TileDef, PushInteraction | null>();

export function resolvePush(def: TileDef): PushInteraction | null {
  const cached = pushCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.push;
  const parsed = raw == null ? null : v.safeParse(pushSchema, raw);
  const push = parsed?.success ? parsed.output : null;
  pushCache.set(def, push);
  return push;
}

const switchSchema = v.object({
  targetTileId: v.pipe(v.string(), v.minLength(1)),
  // Optional rather than required: every switch authored before this field
  // existed is still a valid switch, and a stricter schema would silently
  // demote all of them to "not switchable".
  actionName: v.optional(v.string()),
});

const switchCache = new WeakMap<TileDef, SwitchInteraction | null>();

/**
 * Parsed switch config per tile def. Same trust model as {@link resolvePush}:
 * malformed or empty target → not switchable.
 */
export function resolveSwitch(def: TileDef): SwitchInteraction | null {
  const cached = switchCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.switch;
  const parsed = raw == null ? null : v.safeParse(switchSchema, raw);
  const sw = parsed?.success ? parsed.output : null;
  switchCache.set(def, sw);
  return sw;
}

const rewardSchema = v.object({
  actionName: v.optional(v.string()),
});

const rewardCache = new WeakMap<TileDef, RewardInteraction | null>();

/**
 * Parsed reward config for a tile def — whether this tile is a giver at all,
 * and what the gesture is called.
 *
 * Same trust model as {@link resolvePush}: malformed → not a giver. An *empty*
 * block is entirely valid and is the common case, because the block's presence
 * is the whole statement; what is given is on the placement.
 */
export function resolveRewardDef(def: TileDef): RewardInteraction | null {
  const cached = rewardCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.reward;
  const parsed = raw == null ? null : v.safeParse(rewardSchema, raw);
  const reward = parsed?.success ? parsed.output : null;
  rewardCache.set(def, reward);
  return reward;
}

/**
 * What one placement of a giver tile actually hands over, or null when it hands
 * over nothing.
 *
 * Both halves are required and neither is repairable. A tagless reward could be
 * taken for ever, which is the one thing this exists to prevent; an empty one
 * offers a verb that does nothing. Either way the answer is null, which reads
 * downstream as "there is no reward here" — the same shape a malformed switch
 * takes, and it means a half-authored chest is scenery rather than a trap.
 *
 * Parsed rather than trusted, like every other block: `data/map.json` is
 * hand-editable, so these two fields arrive from a file somebody typed.
 *
 * Memoised on placement identity, on the same grounds the def resolvers are
 * memoised on def identity: the map is copy-on-write, so a placement object is
 * stable until that cell is edited, and this is asked per reachable cell on
 * every pointer move.
 */
const placedRewardCache = new WeakMap<PlacedTile, PlacedReward | null>();

export function resolveReward(
  placed: PlacedTile,
  def: TileDef | undefined,
): PlacedReward | null {
  const cached = placedRewardCache.get(placed);
  if (cached !== undefined) return cached;

  const reward = def ? readPlacedReward(placed, def) : null;
  placedRewardCache.set(placed, reward);
  return reward;
}

const placedRewardSchema = v.object({
  rewardTag: v.pipe(v.string(), v.trim(), v.minLength(1)),
  rewardTileIds: v.pipe(
    v.array(v.string()),
    v.minLength(1),
    v.maxLength(MAX_REWARD_ITEMS),
  ),
});

function readPlacedReward(
  placed: PlacedTile,
  def: TileDef,
): PlacedReward | null {
  const gesture = resolveRewardDef(def);
  if (!gesture) return null;
  const parsed = v.safeParse(placedRewardSchema, placed);
  if (!parsed.success) return null;
  return {
    ...gesture,
    tag: parsed.output.rewardTag,
    itemTileIds: parsed.output.rewardTileIds,
  };
}

const decaySchema = v.pipe(
  v.object({
    // Permissive where every other target is `minLength(1)`, because blank is
    // this block's "remove me" and refusing it would make vanishing
    // unauthorable.
    tileId: v.string(),
    // The real gate. A tile with no positive lifetime does not decay, so a
    // half-authored block is inert rather than a placement that disappears on
    // the first tick.
    fromMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
    toMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  // Checked rather than repaired by swapping the two, because a range nobody
  // meant should read as the inert block it is — silently reversing it would
  // make a typo into a behaviour, and the editor keeps the pair ordered so
  // nothing authored through it can land here.
  v.check((d) => d.toMs >= d.fromMs, "decay toMs must be at least fromMs"),
);

const decayCache = new WeakMap<TileDef, DecayInteraction | null>();

/**
 * Parsed decay config per tile def. Same trust model as {@link resolvePush}:
 * malformed, or with no lifetime to count down, → does not decay.
 */
export function resolveDecay(def: TileDef): DecayInteraction | null {
  const cached = decayCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.decay;
  const parsed = raw == null ? null : v.safeParse(decaySchema, raw);
  const decay = parsed?.success ? parsed.output : null;
  decayCache.set(def, decay);
  return decay;
}

const respawnSchema = v.pipe(
  v.object({
    // The same gate decay's lifetime is behind: no positive wait means no
    // respawn, so a half-authored block is inert rather than a spawn point
    // that refills the instant it empties.
    fromMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
    toMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.check((r) => r.toMs >= r.fromMs, "respawn toMs must be at least fromMs"),
);

const respawnCache = new WeakMap<TileDef, RespawnInteraction | null>();

/**
 * Parsed respawn config per tile def. Same trust model as {@link resolvePush}:
 * malformed, or with no wait to count down, → does not respawn.
 */
export function resolveRespawn(def: TileDef): RespawnInteraction | null {
  const cached = respawnCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.respawn;
  const parsed = raw == null ? null : v.safeParse(respawnSchema, raw);
  const respawn = parsed?.success ? parsed.output : null;
  respawnCache.set(def, respawn);
  return respawn;
}

const pressurePlateSchema = v.object({
  tileId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(PLATE_COMPARISONS),
  height: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const pressurePlateCache = new WeakMap<
  TileDef,
  PressurePlateInteraction | null
>();

/**
 * Parsed pressure plate config per tile def. Same trust model as
 * {@link resolvePush}: malformed or targetless → not a plate.
 */
export function resolvePressurePlate(
  def: TileDef,
): PressurePlateInteraction | null {
  const cached = pressurePlateCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.pressurePlate;
  const parsed = raw == null ? null : v.safeParse(pressurePlateSchema, raw);
  const plate = parsed?.success ? parsed.output : null;
  pressurePlateCache.set(def, plate);
  return plate;
}

const emitSchema = v.object({
  value: v.picklist(SIGNAL_VALUES),
});

const emitCache = new WeakMap<TileDef, EmitInteraction | null>();

/**
 * Parsed emit config per tile def. Same trust model as {@link resolvePush}:
 * malformed → does not drive anything.
 */
export function resolveEmit(def: TileDef): EmitInteraction | null {
  const cached = emitCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.emit;
  const parsed = raw == null ? null : v.safeParse(emitSchema, raw);
  const emit = parsed?.success ? parsed.output : null;
  emitCache.set(def, emit);
  return emit;
}

const receiveSchema = v.object({
  tileId: v.pipe(v.string(), v.minLength(1)),
  when: v.picklist(SIGNAL_VALUES),
  mode: v.picklist(SIGNAL_MODES),
});

const receiveCache = new WeakMap<TileDef, ReceiveInteraction | null>();

/**
 * Parsed receive config per tile def. Same trust model as {@link resolvePush}:
 * malformed or targetless → does not follow anything.
 */
export function resolveReceive(def: TileDef): ReceiveInteraction | null {
  const cached = receiveCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.receive;
  const parsed = raw == null ? null : v.safeParse(receiveSchema, raw);
  const receive = parsed?.success ? parsed.output : null;
  receiveCache.set(def, receive);
  return receive;
}

/** Does the channel reading satisfy this receiver's authored condition? */
export function receiveTriggers(
  receive: ReceiveInteraction,
  powered: boolean,
): boolean {
  return powered === (receive.when === "on");
}

/**
 * Kinds of interaction a tile offers the player, in the order the single
 * interact button tries them.
 *
 * Reward comes first, ahead of even a switch, because it is the only one of
 * these that can happen to a given player *once*. A chest authored to both hand
 * over its contents and swing open would otherwise spend its one chance on the
 * hinge. And it falls through cleanly: a reward already taken is not on offer at
 * all, so the second tap on that chest is the switch, with nothing here having
 * to know it is the second.
 *
 * Switch comes next: it is an explicit authored swap, and an author who put
 * one on a tile meant it to be what happens. Pick-up comes after, because
 * lifting a thing is a better guess at what somebody wants from a sword on the
 * floor than shoving it further away. Push is last, the fallback "just move it"
 * behaviour that anything can fall through to.
 *
 * Three things are deliberately *not* here. Pressure plates and decay, because
 * nothing about either answers to a tap — listing one would outline a floor
 * tile the player cannot act on. And `open`, because opening a container is not
 * something the server does: its contents are already on the client, riding on
 * the placement, so looking inside is local panel state. It is an
 * `InteractionAction` without being one of these, exactly as `target` is.
 */
export type InteractionKind = "reward" | "switch" | "pickUp" | "push";

/** Every player-activated interaction on this tile, in a stable order. */
export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  // The def's half only. Whether *this placement* actually gives anything is a
  // question about a slot, and `interactionKinds` is asked about tiles — see
  // `resolveReward`, which is what the affordances ask.
  if (resolveRewardDef(def)) kinds.push("reward");
  if (resolveSwitch(def)) kinds.push("switch");
  if (resolveItem(def)) kinds.push("pickUp");
  if (resolvePush(def)) kinds.push("push");
  return kinds;
}

/**
 * Can this tile ever change cell during play?
 *
 * Derived rather than declared, because every way a tile can move is already
 * stated: gravity makes it fall, a push interaction makes it shovable. A flag
 * beside those would be a third thing to keep in sync, and the first tile
 * authored without it would be the one that breaks.
 *
 * Two subsystems key off this and both want the same answer. The renderer keeps
 * mobile tiles out of the merged geometry batch, so a step repositions one mesh
 * instead of rebuilding a floor. The light cache keeps them out of the static
 * bake, so a step does not dirty the chunks around it. Both used to ask "is
 * this the player", which was true, cheap, and wrong the moment a second thing
 * moved.
 *
 * Deliberately a property of the tile, not of whether it happens to be moving
 * this frame. A boulder at rest is still mobile: classifying per frame would
 * mean shuffling it between the batch and its own mesh every time it started
 * and stopped, and that rebuild is exactly the cost being removed.
 *
 * A body is mobile by definition, and saying so explicitly rather than leaning
 * on its gravity is what keeps a hovering one out of the trap: baked into the
 * floor geometry, and smearing across it the moment it moved.
 */
export function isMobileTile(def: TileDef): boolean {
  return (
    def.affectedByGravity === true ||
    resolveActor(def) ||
    resolvePush(def) !== null
  );
}

/** Whether the player can do anything at all with this tile. */
export function isInteractive(def: TileDef): boolean {
  return interactionKinds(def).length > 0;
}

/**
 * Whether this tile does anything in play — passive behaviour included. Use
 * over {@link isInteractive} when the question is "is this tile inert?" rather
 * than "can the player act on it?".
 */
export function hasAnyInteraction(
  interactions: TileInteractions | undefined,
): boolean {
  return Boolean(
    interactions?.brain ||
      interactions?.battler ||
      interactions?.item ||
      interactions?.push ||
      interactions?.switch ||
      interactions?.reward ||
      interactions?.decay ||
      interactions?.respawn ||
      interactions?.pressurePlate ||
      interactions?.emit ||
      interactions?.receive,
  );
}

/** Persist interactions; omit the field entirely when nothing is enabled. */
export function interactionsForSave(
  interactions: TileInteractions | undefined,
): TileInteractions | undefined {
  const push = interactions?.push;
  const sw = interactions?.switch;
  const plate = interactions?.pressurePlate;
  const savedPush = push
    ? {
        climb: push.climb,
        moveOnTileIds: [...push.moveOnTileIds].sort(),
      }
    : undefined;
  // A blank verb is dropped rather than written as `""`: the file is
  // hand-edited, and an empty string that means "no name" is a second way of
  // saying what an absent key already says.
  const switchActionName = sw?.actionName?.trim();
  const savedSwitch = sw?.targetTileId.trim()
    ? {
        targetTileId: sw.targetTileId.trim(),
        ...(switchActionName ? { actionName: switchActionName } : {}),
      }
    : undefined;
  const savedPlate = plate?.tileId.trim()
    ? { tileId: plate.tileId.trim(), type: plate.type, height: plate.height }
    : undefined;
  // Kept even when it is empty, unlike every other block here, because an empty
  // one is the whole point: `reward: {}` says "this tile is a giver", and what
  // it gives is written on each placement. Dropping it for having no fields set
  // would un-author the tile.
  const reward = interactions?.reward;
  const rewardActionName = reward?.actionName?.trim();
  const savedReward = reward
    ? { ...(rewardActionName ? { actionName: rewardActionName } : {}) }
    : undefined;
  // Gated on the lifetime rather than on the target, unlike every other block
  // here: a blank target is how a tile says it vanishes, and dropping the block
  // for it would silently un-author exactly the case blood is.
  const decay = interactions?.decay;
  const decayFromMs = decay ? Math.round(decay.fromMs) : 0;
  const decayToMs = decay ? Math.round(decay.toMs) : 0;
  const savedDecay =
    decayFromMs > 0 && decayToMs >= decayFromMs
      ? {
          tileId: decay!.tileId.trim(),
          fromMs: decayFromMs,
          toMs: decayToMs,
        }
      : undefined;
  // Same gate as decay's, minus the target it does not have: a respawn with no
  // positive wait was never authored, whatever else is in the block.
  const respawn = interactions?.respawn;
  const respawnFromMs = respawn ? Math.round(respawn.fromMs) : 0;
  const respawnToMs = respawn ? Math.round(respawn.toMs) : 0;
  const savedRespawn =
    respawnFromMs > 0 && respawnToMs >= respawnFromMs
      ? { fromMs: respawnFromMs, toMs: respawnToMs }
      : undefined;
  const emit = interactions?.emit;
  const receive = interactions?.receive;
  const savedEmit = emit ? { value: emit.value } : undefined;
  const savedReceive = receive?.tileId.trim()
    ? {
        tileId: receive.tileId.trim(),
        when: receive.when,
        mode: receive.mode,
      }
    : undefined;
  // Passed through rather than rebuilt field by field, unlike everything else
  // here: there is no brain editor yet, so the only way one survives a trip
  // through the tile dialog is untouched. Rebuilding it would also mean this
  // function knowing the whole state-machine shape, which is `./brain`'s job.
  const savedBrain = interactions?.brain;
  // Rebuilt field by field, unlike the brain: the shape is a short list of
  // stats and naming them here is what keeps a stray key an editor draft
  // carried in from ever reaching the file.
  //
  // Every field the resolver knows about has to appear, and that is the standing
  // cost of the approach: a stat added to `BattlerDef` and forgotten here is
  // silently dropped the next time anybody saves the tile. `sight` is copied
  // rather than spread so the saved file never shares a reference with the
  // draft the editor is still holding.
  const battler = interactions?.battler;
  const savedBattler = battler
    ? {
        maxHp: battler.maxHp,
        atk: battler.atk,
        def: battler.def,
        acc: battler.acc,
        flee: battler.flee,
        spd: battler.spd,
        range: battler.range,
        sight: { up: battler.sight.up, down: battler.sight.down },
      }
    : undefined;
  // Rebuilt field by field too, by the module that owns the union's arms —
  // switching a weapon to a container and back leaves the draft carrying both
  // sets of fields, and only `itemForSave` knows which ones belong.
  const savedItem = itemForSave(interactions?.item);
  if (
    !savedBrain &&
    !savedBattler &&
    !savedItem &&
    !savedPush &&
    !savedSwitch &&
    !savedReward &&
    !savedDecay &&
    !savedRespawn &&
    !savedPlate &&
    !savedEmit &&
    !savedReceive
  ) {
    return undefined;
  }
  return {
    ...(savedBrain ? { brain: savedBrain } : {}),
    ...(savedBattler ? { battler: savedBattler } : {}),
    ...(savedItem ? { item: savedItem } : {}),
    ...(savedPush ? { push: savedPush } : {}),
    ...(savedSwitch ? { switch: savedSwitch } : {}),
    ...(savedReward ? { reward: savedReward } : {}),
    ...(savedDecay ? { decay: savedDecay } : {}),
    ...(savedRespawn ? { respawn: savedRespawn } : {}),
    ...(savedPlate ? { pressurePlate: savedPlate } : {}),
    ...(savedEmit ? { emit: savedEmit } : {}),
    ...(savedReceive ? { receive: savedReceive } : {}),
  };
}

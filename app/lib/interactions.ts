import * as v from "valibot";
import type { BattlerDef } from "./battler";
import type { BrainDef } from "./brain";
import type { ItemDef } from "./item";
import { itemForSave, resolveItem } from "./item";
import type { TileDef } from "./types";
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
  decay?: DecayInteraction;
  pressurePlate?: PressurePlateInteraction;
  emit?: EmitInteraction;
  receive?: ReceiveInteraction;
};

export const DEFAULT_SWITCH: SwitchInteraction = {
  targetTileId: "",
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
 * Switch comes first: it is an explicit authored swap, and an author who put
 * one on a tile meant it to be what happens. Pick-up comes next, because
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
export type InteractionKind = "switch" | "pickUp" | "push";

/** Every player-activated interaction on this tile, in a stable order. */
export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
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
      interactions?.decay ||
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
  // Rebuilt field by field, unlike the brain: the shape is six numbers and
  // naming them here is what keeps a stray key an editor draft carried in from
  // ever reaching the file.
  const battler = interactions?.battler;
  const savedBattler = battler
    ? {
        maxHp: battler.maxHp,
        atk: battler.atk,
        def: battler.def,
        acc: battler.acc,
        flee: battler.flee,
        spd: battler.spd,
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
    !savedDecay &&
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
    ...(savedDecay ? { decay: savedDecay } : {}),
    ...(savedPlate ? { pressurePlate: savedPlate } : {}),
    ...(savedEmit ? { emit: savedEmit } : {}),
    ...(savedReceive ? { receive: savedReceive } : {}),
  };
}

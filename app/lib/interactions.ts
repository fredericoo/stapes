import * as v from "valibot";
import { DEFAULT_BATTLER, type BattlerDef } from "./battler";
import type { BrainDef } from "./brain";
import type { DialogDef } from "./dialog";
import { ELEMENTS } from "./element";
import type { ItemDef } from "./item";
import { kitForSave } from "./kit";
import {
  itemForSave,
  MAX_CONTAINER_SIZE,
  resolveItem,
  weaponForSave,
} from "./item";
import { MASTERIES } from "./mastery";
import type { Coord, PlacedTile, SpriteState, TileDef } from "./types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, resolveActor } from "./types";

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
   * Load to compare against, in height units — a stool is 1, a half-height
   * crate is 2 and a full level is {@link HEIGHT_PER_LEVEL}. Flat and
   * intangible tiles weigh nothing, so `gte 1` reads as "something solid is
   * standing here".
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
 * When an authored gesture fires — the three ways a tile can be set off.
 *
 * Shared rather than restated per interaction, because each answer is a rule
 * about the *gesture* and not about what happens afterwards: `step` has no
 * reach and no row, `interact` is the orthogonal square a switch takes, and
 * `interactOver` is your own cell. A portal and a fire that burns whoever
 * stands in it differ in what they do to you and in nothing at all about how
 * they are reached, so two copies of this union would be two places for those
 * reaches to drift apart.
 */
export type ActivationTrigger = "step" | "interact" | "interactOver";

export const ACTIVATION_TRIGGERS: ActivationTrigger[] = [
  "step",
  "interact",
  "interactOver",
];

/**
 * Where a teleport leads, and — the point of the union — *which half of the
 * authoring holds the answer*.
 *
 * A discriminated union rather than a kind beside optional numbers, on exactly
 * the terms {@link ItemDef} is one: an absolute teleport cannot have a delta and
 * a relative one cannot have a destination written on a placement, so neither
 * can be left behind when an author changes their mind.
 *
 * **The split is not arbitrary — it follows what actually varies.** A ladder is
 * the same ladder wherever it is: it takes you up one floor, and that is a fact
 * about what a ladder *is*, so every copy of the tile should already know it.
 * A portal is the opposite: one tile furnishes a whole map and each doorway
 * leads somewhere different, so the target has to belong to the slot. Putting
 * both on the placement made every ladder in the world need its `z + 1` typed
 * out again; putting both on the def would make every portal lead to one room.
 */
export type TeleportDestination =
  | {
      kind: "relative";
      /**
       * Cells travelled, counted from the **placement's own cell** — never from
       * wherever the traveller happened to be standing. A ladder is `z + 1` from
       * the rungs however you approached them; measuring from the actor would
       * make an adjacent portal land somewhere different for each of the four
       * sides you could press it from.
       */
      delta: Coord;
    }
  | {
      kind: "absolute";
      /**
       * No numbers here on purpose. Where each one leads is written on the
       * placement ({@link PlacedTile.teleportTo}), which is what lets one portal
       * tile be every doorway in the world.
       */
    };

export type TeleportDestinationKind = TeleportDestination["kind"];

export const TELEPORT_DESTINATION_KINDS: TeleportDestinationKind[] = [
  "relative",
  "absolute",
];

/**
 * Put whoever activates this somewhere else on the board.
 *
 * **The block is a marker, and where it goes is on the placement**
 * ({@link PlacedTile.teleportTo}) — exactly the split
 * {@link RewardInteraction} makes, and for the same argument: the tile says
 * *what kind of thing this is* — a portal you step into, a ladder you climb —
 * and the slot says which particular one. One `portal` tile therefore furnishes
 * a whole map, where coordinates on the def would make every portal in the
 * world lead to one room.
 *
 * Nothing here is per-player and nothing is spent: a teleport is the one
 * authored interaction with no state at all on either side of it. Walking back
 * onto the pad sends you through again, which is what a door is.
 */
export type TeleportInteraction = {
  /**
   * What going through it is called — "Enter" on a portal, "Climb" on a ladder.
   *
   * Authored for the reason {@link SwitchInteraction.actionName} and
   * {@link RewardInteraction.actionName} are: nothing derivable from a tile
   * that moves you says whether you are stepping through it or hauling yourself
   * up it. Optional, and blank reads as "Enter".
   *
   * Read only when the player has something to press. A {@link trigger} of
   * `step` offers no row and never shows this.
   */
  actionName?: string;
  /**
   * What sets it off.
   *
   * - `step` — landing on the cell does it, with nothing to press. A portal.
   * - `interact` — pressing it from the next cell over, on exactly the reach a
   *   {@link SwitchInteraction} takes: orthogonal and adjacent, because "the
   *   thing you are squarely beside" is the only reading a doorway has.
   * - `interactOver` — pressing it while standing in its cell. A ladder: you
   *   walk onto the rungs and then climb, which is two acts and reads as two.
   */
  trigger: ActivationTrigger;
  /**
   * Where it leads, and which half of the authoring says so. See
   * {@link TeleportDestination}.
   */
  destination: TeleportDestination;
};

/**
 * A teleport as it is actually offered: the tile's half and the slot's half,
 * read together.
 *
 * Joined once here for the reason {@link PlacedReward} is: neither half is a
 * teleport on its own — a portal tile with no destination written on this
 * placement leads nowhere, and coordinates on a placement of a tile that does
 * not teleport are a note nobody reads.
 *
 * {@link to} is the cell itself, with a delta already resolved against the
 * placement, so nothing downstream has to know which half was authored.
 */
export type PlacedTeleport = {
  actionName?: string;
  trigger: ActivationTrigger;
  /** Where the traveller ends up, absolute. */
  to: Coord;
};

/**
 * Put a status on whoever sets this off — a flame that burns you, a shrine that
 * blesses you.
 *
 * **Wholly on the tile, with no placement half at all**, on the terms
 * {@link TransmuteInteraction} has none: what standing in a fire does to a body
 * is a fact about fire, and every flame cut from the tile does it. There is
 * nothing left for a slot to vary.
 *
 * **How long it lasts is the status's own**, unlike an item's `StatusGrant`,
 * which may override the range. Bread and a berry are two helpings of one
 * condition and only the food knows which is the meal; a fire has no such
 * reading — being burned is being burned, and an author who wants a longer one
 * has authored a longer status.
 *
 * Nothing is spent and nothing is remembered, exactly as nothing is for a
 * teleport: walk back into the fire and it burns you again. What keeps that
 * from being unbounded is the status itself — a second application refreshes
 * rather than piles up unless its author said `stacks`, and even then it clamps
 * at `maxMs`. See `../game/statuses`'s `applyStatus`.
 */
export type AddStatusInteraction = {
  /**
   * What doing it is called — "Touch" a brazier, "Pray" at a shrine.
   *
   * Authored for the reason every other verb in this file is: nothing derivable
   * from a tile that leaves you burning says whether you reached into it or
   * were blessed by it. Optional, and blank reads as "Touch".
   *
   * Read only where the player has something to press. A {@link trigger} of
   * `step` offers no row and never shows this.
   */
  actionName?: string;
  /** What sets it off. See {@link ActivationTrigger}. */
  trigger: ActivationTrigger;
  /**
   * The status handed over, by id — see `./status`.
   *
   * An id the catalogue does not hold is an effect that does not happen, on the
   * same terms a consumable naming a missing status is: renamed content should
   * cost one effect rather than stop the world starting. A **blank** one is a
   * different thing and reads as unauthored — {@link resolveAddStatus} refuses
   * it, so a block somebody switched on and never filled in offers no row and
   * outlines nothing.
   */
  statusId: string;
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
 * One thing this tile turns into others: spend that, get these.
 *
 * **A recipe, not a trade of objects.** The input is destroyed and the outputs
 * are minted fresh, on exactly the terms {@link RewardInteraction} hands its
 * items over — so a fire that cooks meat is not moving a particular steak
 * around, it is answering "what does raw meat become here".
 *
 * Wholly on the tile, with no placement half at all, and that is the one place
 * this parts company with a reward: what a fire does to meat is a fact about
 * fire, and every fire cut from the tile does it. There is nothing left for a
 * slot to vary.
 */
export type Transmutation = {
  /**
   * What doing it is called — "Cook" at a fire, "Trade" with a salesman.
   *
   * Authored per *recipe* rather than per tile, unlike every other verb in this
   * file, because a tile may offer several and they need not be the same act: a
   * stall that trades a carcass for a coin may also cook. It is also the half
   * the player is choosing between, since the thing being spent is the other.
   *
   * Optional, and blank reads as "Transmute" — which is deliberately an ugly
   * word to see in play, because a recipe worth authoring is worth naming.
   */
  verb?: string;
  /** The item spent. One, always: a recipe with two inputs is two decisions. */
  fromTileId: string;
  /** What comes back. Order is the author's, as a reward's is. */
  toTileIds: string[];
};

/**
 * This tile turns one carried thing into others — a fire you cook at, a trader
 * you sell to.
 *
 * **Nothing on the board changes**, exactly as nothing changes when a reward is
 * taken, and for a related reason: the fire has to still be a fire for the next
 * person. What changes is the kit of whoever pressed it. Unlike a reward it is
 * *not* once per player and carries no tag — a fire cooks the second steak too,
 * and what limits it is having something to spend.
 *
 * A list rather than a single recipe, because "what will this fire do for me"
 * is a question with several answers and each is its own row: an author who had
 * to cut one tile per recipe would be cutting one fire per food in the game.
 */
export type TransmuteInteraction = {
  recipes: Transmutation[];
};

/**
 * Most things one recipe may hand back.
 *
 * {@link MAX_REWARD_ITEMS}' argument, because it is the same constraint: the
 * outputs all arrive at once and all have to fit, so a recipe authored bigger
 * than any bag in the game is one nobody can ever run.
 */
export const MAX_TRANSMUTATION_OUTPUTS = MAX_CONTAINER_SIZE;

/**
 * Most recipes one tile may offer.
 *
 * A bound on a *list the player reads*, rather than on anything the simulation
 * would struggle with: every runnable recipe is a row in the interaction list,
 * and a fire offering twenty of them has stopped being something you can scan.
 */
export const MAX_TRANSMUTATIONS = 8;

/**
 * Most items one placement may hand over.
 *
 * The largest bag there is, because the taker needs room for *all* of them at
 * once — see `rewardFits`. A reward authored bigger than any container in the
 * game is not a generous reward, it is one nobody can ever take.
 */
export const MAX_REWARD_ITEMS = MAX_CONTAINER_SIZE;

/**
 * One thing this resource might yield, and how likely it is to.
 *
 * Deliberately the same shape and the same percent scale a `KitEntry` is drawn
 * on — see `./kit`, whose module note argues the whole of it — because it is the
 * same question asked of a different subject: a rat's kit is what killing it is
 * worth, and this is what working a bush is worth. An author who has written one
 * has written the other.
 *
 * **Every slot is drawn for, every time, independently.** There is no "pick
 * one": four slots at 50% is a handful of berries on a good pull and nothing at
 * all on a bad one, which is what makes a range authorable without a range
 * field. "One to three berries" is three berry slots at descending chances;
 * "nothing, or a shard" is one slot at whatever the shard is worth.
 */
export type ExtractSlot = {
  tileId: string;
  /** Percent. Floats allowed, on {@link KitEntry}'s argument for them. */
  chance: number;
};

/** Percent, both ends included. Nothing is ever more certain than certain. */
export const MIN_EXTRACT_CHANCE = 0;
export const MAX_EXTRACT_CHANCE = 100;

/**
 * Most things one resource may be authored to yield.
 *
 * Four, and the number is doing two jobs. It bounds what a single pull can put
 * in a bag, which is what lets {@link extractFits} ask for room up front rather
 * than discovering halfway through that there is none. And it bounds what an
 * author can express: a table with twenty rows in it is a loot table, and a
 * bush is not a boss.
 */
export const MAX_EXTRACT_SLOTS = 4;

/**
 * Work this thing for what it is made of — mine a crystal, pick a bush.
 *
 * **The one authored interaction that is shared and spends the world.** A reward
 * is once per *player* and leaves the chest standing; a transmute is as often as
 * you can pay for it and leaves the fire burning. This is the other arrangement,
 * and it is the one a resource wants: the crystal is the same crystal for
 * everybody who walks up to it, and what everybody takes out of it comes out of
 * one shared {@link durability}. Two people mining one vein race each other.
 *
 * That makes it the only interaction with **two clocks pointing opposite ways**,
 * and the pair is what the whole design rests on:
 *
 * - {@link durability} is the world's, spent by anybody, held on the placement
 *   ({@link PlacedTile.extractsLeft}) so every client and the checkpoint see the
 *   same number.
 * - {@link cooldownMs} is one player's, spent only by them, held on their actor
 *   and never on the board — so a bush somebody has just picked is still full
 *   for the person walking up behind them.
 *
 * **Nothing here says how the resource comes back**, and that is deliberate:
 * {@link tileId} hands the placement to machinery that already exists. A bush
 * that becomes a picked bush comes back because *the picked bush* decays into a
 * bush ({@link DecayInteraction}); a crystal that becomes nothing comes back
 * because the crystal's own spawn point notices the empty cell
 * ({@link RespawnInteraction}). Authoring regrowth here would be a third
 * countdown competing with two that already work.
 */
export type ExtractInteraction = {
  /**
   * What working it is called — "Mine" a crystal, "Pick" a bush, "Fell" a tree.
   *
   * Authored for the reason every other verb in this file is: nothing derivable
   * from a tile that hands you a shard says whether you chipped it off or
   * plucked it. Optional, and blank reads as "Gather".
   */
  actionName?: string;
  /**
   * How many pulls this placement has in it before it turns into
   * {@link tileId}.
   *
   * The def's number is what a *fresh* placement starts with; what is left of
   * any particular one is on the placement. So an author says "a vein is worth
   * three swings" once, and every vein in the world is worth three.
   *
   * At least one. A resource with no pulls in it is a resource that turns the
   * first time anybody touches it, which is authorable — `durability: 1` — and
   * meaning it takes zero is not.
   */
  durability: number;
  /**
   * What this becomes once the last pull is taken. **Blank removes the
   * placement**, on exactly {@link DecayInteraction.tileId}'s terms and for the
   * same reason: there is no `air` tile to name, and a mined-out crystal is
   * simply not there any more.
   *
   * A blank target is therefore meaningful rather than malformed here too, so
   * {@link durability} is what says whether a tile can be worked at all.
   */
  tileId: string;
  /**
   * How long this player must wait before working **this placement** again, in
   * wall-clock milliseconds.
   *
   * Per player *and* per placement, which is the only pairing that makes a
   * shared resource pace right. One clock per player would stop somebody picking
   * berries because they had just mined a crystal on the other side of the map;
   * one clock per placement would be the world's rather than theirs, and the
   * second person to walk up to a bush would be told to wait for the first.
   *
   * Zero is legal and means what it says: pull it as fast as you can press,
   * until the durability runs out.
   */
  cooldownMs: number;
  /**
   * What a pull might yield, in the order it is rolled. At most
   * {@link MAX_EXTRACT_SLOTS}. See {@link ExtractSlot}.
   *
   * A block with none of them is not a resource — there is nothing to take out
   * of it — so unlike a reward's empty block, an empty list here reads as
   * unauthored and the resolver refuses it.
   */
  slots: ExtractSlot[];
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
   * A conversation this body can hold — what it answers to, and with what.
   * Makes the tile an actor exactly as a brain does. See `./dialog`, which owns
   * the shape and the parsing on the brain's terms.
   */
  dialog?: DialogDef;
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
  transmute?: TransmuteInteraction;
  extract?: ExtractInteraction;
  teleport?: TeleportInteraction;
  addStatus?: AddStatusInteraction;
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
 * One blank recipe, because a transmuter with no recipes is not a transmuter —
 * switching the block on has to leave the author with the row they came to
 * fill in, exactly as switching a switch on leaves them a target to pick.
 */
export const DEFAULT_TRANSMUTATION: Transmutation = {
  verb: "",
  fromTileId: "",
  toTileIds: [],
};

export const DEFAULT_TRANSMUTE: TransmuteInteraction = {
  recipes: [{ ...DEFAULT_TRANSMUTATION }],
};

/**
 * Long enough that a resource is something you work rather than something you
 * hold a button on, short enough that clearing one is not a chore. It is per
 * placement, so a player with two bushes in front of them alternates rather
 * than waits.
 */
const DEFAULT_EXTRACT_COOLDOWN_MS = 3_000;

/**
 * A bush, which is the shape this was authored for: three pulls, a handful of
 * something each time, and a short wait between them.
 *
 * The yield is left blank on purpose, exactly as a status grant's id is: only
 * the author knows what this thing is made of, and a resolver that refused an
 * empty list is what makes switching the block on leave them the one row they
 * came to fill in.
 */
export const DEFAULT_EXTRACT: ExtractInteraction = {
  actionName: "",
  durability: 3,
  tileId: "",
  cooldownMs: DEFAULT_EXTRACT_COOLDOWN_MS,
  slots: [{ tileId: "", chance: MAX_EXTRACT_CHANCE }],
};

/**
 * A ladder, which is the shape this was authored for: you stand on the rungs
 * and climb one floor. Relative rather than absolute because a default with
 * coordinates in it would be a default that points at a particular room.
 */
export const DEFAULT_TELEPORT: TeleportInteraction = {
  actionName: "",
  trigger: "interactOver",
  destination: { kind: "relative", delta: { x: 0, y: 0, z: 1 } },
};

/**
 * A fire you walk into, which is the shape this was authored for: it happens
 * underfoot, and there is nothing to press.
 *
 * The status is left blank on purpose. Only the author knows which condition
 * this is, and a block naming none is refused rather than guessed at — so
 * switching it on leaves them the one field they came to fill in, exactly as
 * switching a switch on leaves them a target to pick.
 */
export const DEFAULT_ADD_STATUS: AddStatusInteraction = {
  actionName: "",
  trigger: "step",
  statusId: "",
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

/**
 * One recipe, as it is allowed to arrive from a hand-edited file.
 *
 * The input must name something and the outputs must not be empty, because
 * either half missing makes the recipe a verb that does nothing — the same line
 * {@link readPlacedReward} draws, and it lands in the same place: a
 * half-authored recipe is dropped and the rest of the tile still works.
 */
const transmutationSchema = v.object({
  verb: v.optional(v.string()),
  fromTileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  toTileIds: v.pipe(
    v.array(v.string()),
    v.minLength(1),
    v.maxLength(MAX_TRANSMUTATION_OUTPUTS),
  ),
});

/**
 * Malformed recipes are dropped one at a time rather than taking the block down
 * with them, which is this schema's whole shape: a fire that cooks three things
 * and has a typo in the third should still cook the other two, and an author
 * who broke one row should see that row go missing rather than the tile go
 * inert.
 */
const transmuteSchema = v.object({
  recipes: v.pipe(
    v.array(v.fallback(v.nullable(transmutationSchema), null)),
    v.transform((recipes) =>
      recipes
        .filter((recipe): recipe is Transmutation => recipe != null)
        .slice(0, MAX_TRANSMUTATIONS),
    ),
  ),
});

const transmuteCache = new WeakMap<TileDef, TransmuteInteraction | null>();

/**
 * Parsed transmutation config for a tile def — every recipe it offers, in the
 * order the author wrote them.
 *
 * Same trust model as {@link resolvePush}, and one refusal of its own: a block
 * whose recipes all turned out to be malformed is *not* a transmuter, so it
 * offers no rows rather than an empty menu. Unlike a reward's, an empty block
 * here says nothing — there is no placement half for it to be pointing at.
 *
 * Memoised on def identity, on the same grounds every other resolver here is:
 * the interaction list asks this per reachable cell every time the board or the
 * player moves.
 */
export function resolveTransmute(def: TileDef): TransmuteInteraction | null {
  const cached = transmuteCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.transmute;
  const parsed = raw == null ? null : v.safeParse(transmuteSchema, raw);
  const transmute =
    parsed?.success && parsed.output.recipes.length > 0 ? parsed.output : null;
  transmuteCache.set(def, transmute);
  return transmute;
}

/**
 * One yield slot, as it is allowed to arrive from a hand-edited file.
 *
 * A slot naming nothing is dropped rather than taking the block down with it,
 * on exactly the terms a malformed recipe is: a bush that yields two things and
 * has a typo in the second should still yield the first.
 */
const extractSlotSchema = v.object({
  tileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  chance: v.pipe(
    v.number(),
    v.finite(),
    v.minValue(MIN_EXTRACT_CHANCE),
    v.maxValue(MAX_EXTRACT_CHANCE),
  ),
});

const extractSchema = v.object({
  actionName: v.optional(v.string()),
  // The real gate, on `decaySchema`'s terms: a blank target is how a resource
  // says it vanishes when it is spent, so the count is what says whether this
  // can be worked at all. Zero pulls is a tile that turns before anybody
  // touches it, which nobody means.
  durability: v.pipe(v.number(), v.integer(), v.minValue(1)),
  // Permissive where every other target is `minLength(1)`, because blank is
  // this block's "remove me" — a mined-out crystal is simply not there.
  tileId: v.string(),
  // Zero is legal and means "as fast as you can press it".
  cooldownMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  slots: v.pipe(
    v.array(v.fallback(v.nullable(extractSlotSchema), null)),
    v.transform((slots) =>
      slots
        .filter((slot): slot is ExtractSlot => slot != null)
        .slice(0, MAX_EXTRACT_SLOTS),
    ),
  ),
});

const extractCache = new WeakMap<TileDef, ExtractInteraction | null>();

/**
 * Parsed extract config per tile def. Same trust model as {@link resolvePush}:
 * malformed → cannot be worked.
 *
 * One refusal of its own, and it is `resolveTransmute`'s: a block whose slots
 * all turned out to be malformed yields nothing, so it is not a resource. A
 * tile that offered a verb and handed back nothing would be a row that takes a
 * press and shrugs, and it would spend the world's durability doing it.
 */
export function resolveExtract(def: TileDef): ExtractInteraction | null {
  const cached = extractCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.extract;
  const parsed = raw == null ? null : v.safeParse(extractSchema, raw);
  const extract =
    parsed?.success && parsed.output.slots.length > 0 ? parsed.output : null;
  extractCache.set(def, extract);
  return extract;
}

/**
 * What an unnamed resource reads as.
 *
 * A real word rather than the mechanism's own, unlike {@link
 * DEFAULT_TRANSMUTE_VERB} and on the same grounds "Take" and "Enter" are real
 * words: "Extract" is what the code calls it, and a player reading a row over a
 * bush should see something a person would say.
 */
export const DEFAULT_EXTRACT_VERB = "Gather";

/**
 * How many pulls this particular placement has left.
 *
 * The placement's own count where it has one, the def's where it does not — and
 * *not having one is the ordinary case*: a fresh placement carries no number at
 * all, so a map full of untouched bushes costs the file nothing and the wire
 * nothing. See {@link PlacedTile.extractsLeft}.
 *
 * Clamped to the authored durability, because the def is the authority on how
 * much a thing is worth: lowering `durability` in `tiles.json` should shorten
 * every vein in the world, including the ones somebody has already started on,
 * rather than leaving a handful of placements richer than any new one.
 */
export function extractsLeft(
  placed: PlacedTile,
  extract: ExtractInteraction,
): number {
  const left = placed.extractsLeft;
  if (typeof left !== "number" || !Number.isFinite(left)) {
    return extract.durability;
  }
  return Math.max(0, Math.min(extract.durability, Math.floor(left)));
}

/**
 * What an unnamed recipe reads as.
 *
 * Deliberately the mechanism's own name and deliberately unlovely: every other
 * fallback in here ("Take", "Enter") is a word a player might actually want,
 * because those blocks were authored before their verb existed and the fallback
 * has to carry real content. Recipes have had a verb since the day they existed,
 * so this only ever shows on one somebody forgot to name.
 */
export const DEFAULT_TRANSMUTE_VERB = "Transmute";

/**
 * What a recipe's row is called, with the fallback applied.
 *
 * One place, because the list draws it and the tile editor previews it, and a
 * verb that read as "Transmute" in one and blank in the other would be two
 * answers to a question the author asked once.
 */
export function transmuteVerb(recipe: Transmutation): string {
  return recipe.verb?.trim() || DEFAULT_TRANSMUTE_VERB;
}

const coordSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
  z: v.pipe(v.number(), v.integer()),
});

const teleportSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
  destination: v.variant("kind", [
    v.object({ kind: v.literal("relative"), delta: coordSchema }),
    v.object({ kind: v.literal("absolute") }),
  ]),
});

const teleportCache = new WeakMap<TileDef, TeleportInteraction | null>();

/**
 * Parsed teleport config for a tile def — whether this tile moves anybody at
 * all, what the gesture is called, and how the placement's numbers read.
 *
 * Same trust model as {@link resolvePush}: malformed → does not teleport. The
 * block carries no coordinates, so unlike a switch there is no target to be
 * empty; a well-formed block on a placement nobody wrote a destination on is a
 * portal that leads nowhere, which {@link resolveTeleport} is what refuses.
 */
export function resolveTeleportDef(def: TileDef): TeleportInteraction | null {
  const cached = teleportCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.teleport;
  const parsed = raw == null ? null : v.safeParse(teleportSchema, raw);
  const teleport = parsed?.success ? parsed.output : null;
  teleportCache.set(def, teleport);
  return teleport;
}

const placedTeleportSchema = v.object({
  teleportTo: coordSchema,
});

/**
 * Where one placement of a teleporting tile actually sends somebody, or null
 * when it sends them nowhere.
 *
 * **The union decides which half is even consulted.** A relative teleport reads
 * its delta off the tile and never looks at the placement; an absolute one reads
 * the placement and the tile carries no numbers at all. So a ladder is authored
 * once and works everywhere it is dropped, and a portal is authored per doorway
 * — see {@link TeleportDestination} for why that is the split.
 *
 * Either way the answer is one absolute cell, and everything downstream takes it
 * without learning which half it came from.
 *
 * A destination off the ends of the world is refused rather than clamped, on
 * the same terms every other malformed block here is: a ladder authored `z + 1`
 * on the top floor leads nowhere, and pinning it to the floor it is already on
 * would be a teleport that silently does nothing while still offering its row.
 */
export function resolveTeleport(
  placed: PlacedTile,
  def: TileDef | undefined,
  at: Coord,
): PlacedTeleport | null {
  const gesture = def ? resolveTeleportDef(def) : null;
  if (!gesture) return null;

  const to = destinationOf(gesture.destination, placed, at);
  if (!to) return null;
  if (to.z < MIN_LEVEL || to.z > MAX_LEVEL) return null;
  // A teleport onto the cell it is authored in is not a teleport. Refused
  // rather than left as a no-op move, because the row is offered from this same
  // answer: a ladder whose delta is all zeroes should read as unauthored rather
  // than as a rung that takes a press and does nothing.
  if (to.x === at.x && to.y === at.y && to.z === at.z) return null;

  return {
    ...(gesture.actionName ? { actionName: gesture.actionName } : {}),
    trigger: gesture.trigger,
    to,
  };
}

function destinationOf(
  destination: TeleportDestination,
  placed: PlacedTile,
  at: Coord,
): Coord | null {
  if (destination.kind === "relative") {
    const { delta } = destination;
    return { x: at.x + delta.x, y: at.y + delta.y, z: at.z + delta.z };
  }
  return authoredDestination(placed);
}

/**
 * The cell written on this placement, for the absolute case only.
 *
 * Memoised on placement identity — the map is copy-on-write, so a placement
 * object is stable until its cell is edited, and this is asked per reachable
 * cell on every pointer move. Safe to cache unlike a resolved *relative*
 * destination, which depends on where the placement is standing and so could go
 * stale the moment one moved.
 */
const authoredTeleportCache = new WeakMap<PlacedTile, Coord | null>();

function authoredDestination(placed: PlacedTile): Coord | null {
  const cached = authoredTeleportCache.get(placed);
  if (cached !== undefined) return cached;

  const parsed = v.safeParse(placedTeleportSchema, placed);
  const authored = parsed.success ? parsed.output.teleportTo : null;
  authoredTeleportCache.set(placed, authored);
  return authored;
}

const addStatusSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
  // The one field with nothing to fall back on, so blank is refused where every
  // other verb here treats it as "unnamed": a block naming no status is a block
  // that could only do nothing, and it should read as unauthored rather than as
  // a row that takes a press and shrugs.
  statusId: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const addStatusCache = new WeakMap<TileDef, AddStatusInteraction | null>();

/**
 * Parsed status-granting config for a tile def — whether this tile puts
 * anything on anybody, what the gesture is called, and how it is set off.
 *
 * Same trust model as {@link resolvePush}: malformed → grants nothing. The
 * whole of it is here, with no placement half to join, on the terms
 * {@link resolveTransmute} is — so unlike a teleport there is no second
 * resolver that could refuse what this one allowed.
 *
 * Whether the named status *exists* is deliberately not asked. The catalogue is
 * the session's and this is the tile's, and the two are loaded from different
 * files by different owners; an id that has been renamed away is an effect that
 * does not happen, which is exactly what `GameSession.grantStatus` already does
 * with one.
 */
export function resolveAddStatus(def: TileDef): AddStatusInteraction | null {
  const cached = addStatusCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.addStatus;
  const parsed = raw == null ? null : v.safeParse(addStatusSchema, raw);
  const addStatus = parsed?.success ? parsed.output : null;
  addStatusCache.set(def, addStatus);
  return addStatus;
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
 * one on a tile meant it to be what happens. A status follows the switch and
 * for its own reason: it is the only kind here that changes the *presser*
 * rather than the board, so a brazier authored to both light a room and burn
 * the hand that lit it lights the room first — the visible half of the tap is
 * the one the player was aiming at. Transmute follows both and for the
 * same argument one step weaker — it is authored and explicit, but it is the
 * only kind here that can offer *several* rows on one tile, so it is named by
 * its row rather than reached by a bare tap. Pick-up comes after, because
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
export type InteractionKind =
  | "reward"
  | "teleport"
  | "switch"
  | "addStatus"
  | "transmute"
  | "extract"
  | "pickUp"
  | "push";

/** Every player-activated interaction on this tile, in a stable order. */
export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  // The def's half only. Whether *this placement* actually gives anything is a
  // question about a slot, and `interactionKinds` is asked about tiles — see
  // `resolveReward`, which is what the affordances ask.
  if (resolveRewardDef(def)) kinds.push("reward");
  // The def's half only too, and with a second question folded in: a `step`
  // teleport is not player-activated at all, so a portal you walk onto is no
  // more tappable than a pressure plate is. Only the two triggers that wait for
  // a press are ever a kind.
  if (pressable(resolveTeleportDef(def))) kinds.push("teleport");
  if (resolveSwitch(def)) kinds.push("switch");
  // The same second question a teleport's asks, and for the same reason: a fire
  // you walk into answers to no press, so listing it would outline a floor tile
  // and offer a row for something that has already happened.
  if (pressable(resolveAddStatus(def))) kinds.push("addStatus");
  // The def's half and the whole of it — a transmuter carries no placement
  // half at all. Whether the player has anything to spend is a question about
  // *them*, which is the affordances', not this one's.
  if (resolveTransmute(def)) kinds.push("transmute");
  // The def's half and the whole of it, on a transmuter's terms — there is no
  // placement half that could make a resource *not* one. Whether this
  // particular bush has anything left in it, and whether this particular player
  // has waited long enough, are questions about a placement and about a person;
  // see `../game/extract`.
  if (resolveExtract(def)) kinds.push("extract");
  if (resolveItem(def)) kinds.push("pickUp");
  if (resolvePush(def)) kinds.push("push");
  return kinds;
}

/** Does this gesture wait for a press, rather than firing underfoot? */
function pressable(gesture: { trigger: ActivationTrigger } | null): boolean {
  return gesture != null && gesture.trigger !== "step";
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

/**
 * The {@link SpriteState}s this tile could ever be in.
 *
 * Derived from predicates that already exist rather than authored, and one
 * function rather than two: the editor builds its state selector from this and
 * the resolver refuses a state absent from it, so what can be authored is
 * exactly what can ever be drawn. A flag beside these would be a second answer
 * that can disagree with the first.
 *
 * {@link isMobileTile} rather than "has a brain or is a battler", because it
 * already means *can this ever change cell* — gravity, a brain, or a push — and
 * already argues why that has to be a property of the tile rather than of
 * whether it happens to be moving this frame. A shoved crate sliding is
 * movement, and a tile that authors nothing for a state it is offered pays
 * nothing for being offered it.
 *
 * Only ever returns states a renderer actually draws — see {@link SpriteState},
 * which is the one place that list grows. Offering a state early would put a
 * control in the editor that does nothing when used.
 */
export function availableStates(def: TileDef): SpriteState[] {
  const out: SpriteState[] = ["idle"];
  if (isMobileTile(def)) out.push("moving");
  return out;
}

/**
 * Whether this tile has any sprite authored beyond idle.
 *
 * What the renderers register a mesh by, so the per-frame state pass can reach
 * it. Being animated is not enough on its own and neither is replacing it: a
 * grazing deer stands on a single frame and is therefore *not* animated, yet it
 * becomes a four-frame walk the moment it steps — so the registry has to be
 * joined by anything that *could* change, before it has.
 *
 * Keyed on what the tile has authored, never on which state it is in right now,
 * for the reason {@link isMobileTile} gives about classifying per frame: a mesh
 * that joined and left the registry as it started and stopped moving would be
 * rebuilding geometry on exactly the frames that can least afford it.
 */
export function hasSpriteStates(def: TileDef): boolean {
  const states = def.states;
  if (!states) return false;
  return Object.values(states).some((s) => s != null);
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
      interactions?.dialog ||
      interactions?.battler ||
      interactions?.item ||
      interactions?.push ||
      interactions?.switch ||
      interactions?.reward ||
      interactions?.transmute ||
      interactions?.extract ||
      interactions?.teleport ||
      interactions?.addStatus ||
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
  // Kept whatever is in it, on the same terms the reward block is: the presence
  // of the block is the statement, and there is nothing here that could be blank
  // enough to mean unauthored.
  //
  // The destination is rebuilt by its arm rather than copied, for the reason
  // `itemForSave` rebuilds an item's: flipping the control from an offset to a
  // cell and back leaves the editor's draft carrying both shapes, and only the
  // arm knows which fields belong. A `delta` left behind on an absolute teleport
  // would be inert *and* invisible — sitting in `data/tiles.json` waiting for
  // somebody to flip the control back and find numbers they never authored.
  // Rebuilt recipe by recipe, and the half-authored ones dropped on the way
  // out rather than only on the way in: a row an author added and never filled
  // in is a row the resolver would refuse anyway, and writing it to
  // `data/tiles.json` would leave the file claiming a recipe the game does not
  // have. A block left with nothing in it is not a transmuter, so it goes.
  const transmute = interactions?.transmute;
  const savedRecipes = (transmute?.recipes ?? []).flatMap((recipe) => {
    const fromTileId = recipe.fromTileId.trim();
    const toTileIds = recipe.toTileIds.filter((id) => id.trim());
    if (!fromTileId || toTileIds.length === 0) return [];
    const verb = recipe.verb?.trim();
    // A blank verb is dropped rather than written as `""`, exactly as a
    // switch's is: an empty string meaning "no name" is a second way of saying
    // what an absent key already says.
    return [{ ...(verb ? { verb } : {}), fromTileId, toTileIds }];
  });
  const savedTransmute =
    savedRecipes.length > 0 ? { recipes: savedRecipes } : undefined;
  // Rebuilt slot by slot and the blank ones dropped on the way out, exactly as
  // a recipe's rows are: a slot somebody added and never filled in is one the
  // resolver would refuse anyway, and writing it to `data/tiles.json` would
  // leave the file claiming a yield the game does not have. A block left with
  // nothing to give is not a resource, so it goes — which is what makes the
  // slots the gate here rather than the target, since a blank target is how a
  // resource says it vanishes when it is spent.
  const extract = interactions?.extract;
  const savedSlots = (extract?.slots ?? []).flatMap((slot) => {
    const tileId = slot.tileId.trim();
    if (!tileId) return [];
    return [{ tileId, chance: slot.chance }];
  });
  const extractActionName = extract?.actionName?.trim();
  const savedExtract =
    extract && savedSlots.length > 0
      ? {
          ...(extractActionName ? { actionName: extractActionName } : {}),
          durability: Math.max(1, Math.round(extract.durability)),
          tileId: extract.tileId.trim(),
          cooldownMs: Math.max(0, Math.round(extract.cooldownMs)),
          slots: savedSlots.slice(0, MAX_EXTRACT_SLOTS),
        }
      : undefined;
  const teleport = interactions?.teleport;
  const teleportActionName = teleport?.actionName?.trim();
  const savedTeleport = teleport
    ? {
        ...(teleportActionName ? { actionName: teleportActionName } : {}),
        trigger: teleport.trigger,
        destination:
          teleport.destination.kind === "relative"
            ? {
                kind: "relative" as const,
                delta: {
                  x: Math.round(teleport.destination.delta.x),
                  y: Math.round(teleport.destination.delta.y),
                  z: Math.round(teleport.destination.delta.z),
                },
              }
            : { kind: "absolute" as const },
      }
    : undefined;
  // Gated on the status rather than on the block, unlike the reward and the
  // teleport above: those two have a placement half that carries the answer, and
  // this has none — a block naming nothing is a block that could only do
  // nothing, and the resolver refuses it either way.
  const addStatus = interactions?.addStatus;
  const addStatusActionName = addStatus?.actionName?.trim();
  const savedAddStatus = addStatus?.statusId.trim()
    ? {
        ...(addStatusActionName ? { actionName: addStatusActionName } : {}),
        trigger: addStatus.trigger,
        statusId: addStatus.statusId.trim(),
      }
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
  // Passed through on the brain's terms and for the same reason: the tree is
  // `./dialog`'s to know, and until the editor has a tab for it the only way
  // one survives the tile dialog is untouched.
  const savedDialog = interactions?.dialog;
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
  // `range` and `sight` were authored after the first creatures, so a tile
  // sitting in `data/` (or an editor draft loaded from one) can still omit
  // them. The schema fills the same defaults at parse time; writing them here
  // is what stops a save from crashing on `.sight.up` of nothing.
  //
  // The masteries are copied key by key for the reason the block as a whole is
  // rebuilt: a draft that has been through the editor carries whatever the last
  // shape left behind, and a sparse record is the easiest place for a stray key
  // to hide. `naturalWeapon` goes through `weaponForSave` because a bite is a
  // weapon like any other, and there is one place that knows how to write one.
  //
  // Zeroes are dropped along with the absent keys, because `masteryLevel` reads
  // them as the same thing: writing one would claim the author considered a
  // question they did not, and it would grow every creature's block by five
  // lines saying nothing.
  const savedKit = kitForSave(battler?.kit);
  const savedBattler = battler
    ? {
        masteries: Object.fromEntries(
          MASTERIES.filter((mastery) => (battler.masteries?.[mastery] ?? 0) > 0).map(
            (mastery) => [mastery, battler.masteries[mastery]],
          ),
        ),
        naturalWeapon: weaponForSave(
          battler.naturalWeapon ?? DEFAULT_BATTLER.naturalWeapon,
        ),
        sight: {
          up: battler.sight?.up ?? DEFAULT_BATTLER.sight.up,
          down: battler.sight?.down ?? DEFAULT_BATTLER.sight.down,
        },
        // Omitted entirely when nothing is authored, unlike `sight`: that has a
        // default worth writing down, where a body that
        // carries nothing is the overwhelming majority and `kit: []` on every
        // creature in the file would be a line saying nothing. `kitForSave`
        // rebuilds it entry by entry for the reason the block around it is
        // rebuilt — an editor draft carries whatever the last shape left behind.
        ...(savedKit ? { kit: savedKit } : {}),
        // Omitted when the body is neutral, which is almost every creature —
        // and ordered off `ELEMENTS` rather than as ticked, so two authors who
        // chose the same two produce the same file.
        ...(battler.elements?.length
          ? {
              elements: ELEMENTS.filter((element) =>
                battler.elements?.includes(element),
              ),
            }
          : {}),
      }
    : undefined;
  // Rebuilt field by field too, by the module that owns the union's arms —
  // switching a weapon to a container and back leaves the draft carrying both
  // sets of fields, and only `itemForSave` knows which ones belong.
  const savedItem = itemForSave(interactions?.item);
  if (
    !savedBrain &&
    !savedDialog &&
    !savedBattler &&
    !savedItem &&
    !savedPush &&
    !savedSwitch &&
    !savedReward &&
    !savedTransmute &&
    !savedExtract &&
    !savedTeleport &&
    !savedAddStatus &&
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
    ...(savedDialog ? { dialog: savedDialog } : {}),
    ...(savedBattler ? { battler: savedBattler } : {}),
    ...(savedItem ? { item: savedItem } : {}),
    ...(savedPush ? { push: savedPush } : {}),
    ...(savedSwitch ? { switch: savedSwitch } : {}),
    ...(savedReward ? { reward: savedReward } : {}),
    ...(savedTransmute ? { transmute: savedTransmute } : {}),
    ...(savedExtract ? { extract: savedExtract } : {}),
    ...(savedTeleport ? { teleport: savedTeleport } : {}),
    ...(savedAddStatus ? { addStatus: savedAddStatus } : {}),
    ...(savedDecay ? { decay: savedDecay } : {}),
    ...(savedRespawn ? { respawn: savedRespawn } : {}),
    ...(savedPlate ? { pressurePlate: savedPlate } : {}),
    ...(savedEmit ? { emit: savedEmit } : {}),
    ...(savedReceive ? { receive: savedReceive } : {}),
  };
}

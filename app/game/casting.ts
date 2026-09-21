import type { NaturalSpell } from "../lib/battler";
import type { ArcaneStoneItem } from "../lib/item";
import { reachOf, resolveStone } from "../lib/item";
import {
  type Masteries,
  meetsRequirements,
  requirementCoverage,
  REQUIREMENTS_MET,
} from "../lib/mastery";
import { getStack, isBodyPlacement } from "../lib/mapData";
import type { AnchoredSprite, Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { canPlace } from "../lib/validation";
import { canReach } from "./combat";
import type { ReachPoint } from "./distance";
import type { Equipment } from "./equipment";
import { canWalk } from "./movement";
import type { Progress } from "./progress";

/**
 * Which stones a body could cast right now, and why not the rest.
 *
 * **The one pure question this whole feature turns on**, and it has four callers
 * who must never disagree: the phone's buttons and the desktop's number keys,
 * to dim and to refuse; the session, to honour or decline a cast; and the tests.
 * That is the same arrangement `./itemMoves` and `./affordances` are under — the
 * client asks the question to decide what to offer, the server asks it again
 * before honouring anything, and neither is trusted with the other's answer.
 *
 * ## It answers with a reason, not a boolean
 *
 * A button has exactly one appearance for "you cannot use this", which is the
 * right design — pressing a dimmed thing does nothing, whatever the dimming is
 * about — and precisely because the picture collapses the reasons, the *words*
 * must not. A screen reader hearing "Stone of Flame, unavailable" is being told
 * less than a sighted player can see, who at least knows a bar is still running
 * down. So the refusal travels, and the accessible name says which it was.
 *
 * ## Nothing here mutates and nothing here knows about a session
 *
 * Everything it needs arrives as arguments: a board to check a line through, a
 * catalogue, a kit, the levels the caster has earned, and where the two bodies
 * are standing. That is what makes the whole of it testable without a world,
 * and it is what lets a browser run it against a map it is holding a copy of.
 */

/**
 * The three squares a stone can be cast from, in the order they are offered.
 *
 * **Two hands and a charm, which is the whole of a caster's loadout**, and the
 * reason the desktop binding is `1`, `2`, `3` and nothing more. The order is the
 * order the buttons appear in and the order the keys are bound in, so the second
 * button and `2` are the same stone by construction rather than by a lookup
 * anybody has to keep in step.
 *
 * The hands come first because a hand is the square you *choose* to give up: an
 * arcanist trades melee square by square, and the charm is the one that costs no
 * swing at all.
 */
export const CAST_SQUARES = ["weapon", "offhand", "charm"] as const;

/** One of the squares a stone can be cast from. @see CAST_SQUARES */
export type CastSquare = (typeof CAST_SQUARES)[number];

/**
 * A square that is not a square on a body would be a stone nothing could hold.
 * This is what makes that a type error rather than an `undefined` read in the
 * middle of a cast.
 */
const _everyCastSquareIsWorn: readonly (keyof Equipment)[] = CAST_SQUARES;

/**
 * Where one cast comes from: a square on the body, or the body itself.
 *
 * **A tagged pair rather than a widened square**, because the two are not the
 * same kind of thing and the difference is load-bearing in three places: what
 * the stone is read off, where the cooldown is kept, and what a name collision
 * would mean. A body's own spells are named by their author — see
 * `../lib/battler`'s {@link NaturalSpell} — and a spell somebody called
 * "charm" must not be the charm square.
 *
 * It is carried all the way out to the wire and back, because a caster mid-cast
 * has one button that can still be pressed and it is the one that started the
 * cast. @see CastProgress
 */
export type CastSlot = { from: "square"; square: CastSquare } | { from: "natural"; name: string };

/** A cast out of one of the three worn squares. */
export const squareSlot = (square: CastSquare): CastSlot => ({
  from: "square",
  square,
});

/** A cast out of the body's own spells, named. */
export const naturalSlot = (name: string): CastSlot => ({
  from: "natural",
  name,
});

/** Do these two name the same button? What "the cast I started" is asked with. */
export function sameSlot(a: CastSlot, b: CastSlot): boolean {
  if (a.from === "square") {
    return b.from === "square" && a.square === b.square;
  }
  return b.from === "natural" && a.name === b.name;
}

/**
 * Why a stone cannot be cast, or that it can.
 *
 * Ordered by what a player would want to hear first when more than one is true,
 * and the order is checked in that order below: "there is nothing there" beats
 * "it is cooling", and "you have not earned it" beats "it is out of range",
 * because one of those is a fact about the stone and the other about where you
 * happen to be standing.
 */
export type CastRefusal =
  /** Nothing in the square, or something that is not a stone. */
  | "empty"
  /**
   * This square's stone is the one being cast right now. Pressing it again
   * stops the cast. @see CastContext.casting
   */
  | "underway"
  /**
   * This body is already part-way through a cast, out of a different square.
   * @see CastContext.casting
   */
  | "casting"
  /** Still counting down. @see ArcaneStoneItem.cooldownMs */
  | "cooling"
  /** The caster has not earned what it asks. @see ArcaneStoneItem.requirements */
  | "mastery"
  /** It acts on somebody else and nobody is targeted. */
  | "noTarget"
  /** Somebody is targeted, and they are too far away or behind something. */
  | "outOfRange"
  /**
   * A conjure whose cell will not take the tile: a wall, water, a bush, a full
   * stack. @see conjureLanding
   */
  | "blocked"
  /**
   * A spell that takes health, aimed at a player this caster may not harm.
   * @see `./pvp`, and {@link CastContext.mayHarmTarget}
   */
  | "peaceful";

/** Whether this stone can be cast, and why not when it cannot. */
export type Castability = { ok: true } | { ok: false; reason: CastRefusal };

/** The unit a countdown is drawn in, and so the grain {@link spellReading} compares at. */
const MS_PER_SECOND = 1000;

/**
 * How much of a stone's cooldown the session winds off at a time.
 *
 * A second — see `./GameSession`'s `advanceStoneCooldowns` for why the truth is
 * kept that coarse. Exported because the button that draws the countdown reads
 * it too: it knows the next figure will be one step lower, one step from now,
 * and animates towards it rather than waiting for it. @see `../components/SpellBar`
 */
export const COOLDOWN_STEP_MS = 1000;

/** Shared, so the overwhelmingly common answer costs no allocation. */
const CASTABLE: Castability = { ok: true };

const refused = (reason: CastRefusal): Castability => ({ ok: false, reason });

/**
 * Where a body is, in the terms both reach and line of sight are measured in.
 *
 * The same shape a swing is measured between — see `./distance`'s
 * {@link ReachPoint} and `GameSession.reachPointOf` — because a spell's range
 * *is* a swing's range: same disc, same lid, same wall in the way. A second
 * notion of "how far is that" would be the first place a bow and a stone of
 * flame could come to disagree about the same courtyard.
 */
export type CastPoint = ReachPoint & {
  z: number;
  /**
   * Where in its stack the body stands, which is where a conjure lands *under*
   * it. See {@link conjureLanding}.
   */
  stackIndex: number;
};

/**
 * Where the caster is, plus the two things a conjure with nobody targeted needs
 * to find the cell in front: which way they face, and what body is doing the
 * stepping.
 *
 * **A caster who is walking casts from the cell they are arriving in**, not
 * the one the board still holds them in. Both sides build it that way — the
 * session from its walk, the browser from its prediction — because a step is
 * only committed when it lands, and a cast resolved from the cell being left
 * put the flame on the cell being entered: exactly where the caster was about
 * to be standing.
 */
export type CasterPoint = CastPoint & {
  facing: Direction;
  /** The caster's own body, so the cell in front is judged by its legs. */
  tileId: string;
};

/**
 * The clock of a cast in progress, and which button it came out of.
 *
 * {@link Progress} with one field added, and that field is what lets the button
 * that started a cast be the one that stops it: every other button reads the
 * clock alone and dims, this one recognises itself and offers to stop. The
 * same object the session winds in place and the wire carries — see
 * `./GameSession`'s `ActorSnapshot.casting` and `../net/protocol`'s
 * `CastingPatch` — so there is one shape for a cast in progress everywhere.
 */
export type CastProgress = Progress & { slot: CastSlot };

/** Everything a cast is decided against, beside the stone itself. */
export type CastContext = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  equipment: Equipment;
  /**
   * What the caster has earned, as levels rather than as raw experience.
   *
   * Levels, because that is the unit a requirement is authored in and there is
   * exactly one place experience is turned into one — see `../lib/mastery`. A
   * block of experience passed in here would be a second such place.
   */
  masteries: Masteries;
  caster: CasterPoint;
  /**
   * The cast this body is already part-way through, or null for a body with
   * both hands free.
   *
   * **One cast at a time, and it refuses every square.** A caster half way
   * through a three-second flame has their hands full, and the stone they are
   * not casting is no more castable than the one they are — so the whole row
   * dims and comes back together, which is a picture a player can read without
   * knowing which button started it.
   *
   * **Except that the square it came out of refuses differently.** That button
   * is the one thing on the row a caster can still do something with: pressing
   * it again stops the cast. So it carries which square as well as the clock —
   * see {@link CastProgress} — and {@link castability} answers `underway` for
   * that square and `casting` for the rest.
   */
  casting: CastProgress | null;
  /**
   * The spells this body has of its own, with nothing in its hands.
   *
   * Handed in rather than resolved here, on the terms the equipment is: this
   * module resolves nothing about a world. `../lib/battler`'s `resolveBattler`
   * is what turns a tile into these, and both sides of the wire run it.
   */
  spells: readonly NaturalSpell[];
  /**
   * How long each of those has left before it may be cast again, by name.
   *
   * **A body's own clock rather than an item's**, which is the one place a
   * natural spell genuinely differs from a carried stone. A stone's cooldown
   * lives on the {@link ItemInstance} because a stone is a thing that gets
   * picked up, put down and stored; a body's spell is part of the body, and is
   * kept where the swing cooldown is kept — see `./GameSession`'s
   * `ActorRuntime.spellCooldownMs`.
   *
   * An absent name is a spell that is ready, which is what every spell nobody
   * has cast yet says.
   */
  spellCooldownsMs: Readonly<Record<string, number>>;
  /**
   * Where the caster's target is standing, or null for a body pointing at
   * nobody.
   *
   * The *target*, not a cell: a player never picks an arbitrary square, so there
   * is no third thing to pass. See the module note on `./casting`'s scope, and
   * `../lib/item`'s {@link StoneEffect} for what a conjure does with no target.
   */
  target: CastPoint | null;
  /**
   * Whether harm from this caster reaches whoever they are pointing at.
   *
   * Absent means it does, which is what every caller meant before this existed
   * and what every cast at a creature means now. False is two players who have
   * not both opted into fighting each other — see `./pvp`, which is where the
   * rule lives and which both ends run.
   *
   * A flag rather than the two bodies, because this module resolves nothing
   * about a world: it is handed a board, a kit and a point, and "may these two
   * fight" is the same kind of answered question `masteries` is.
   */
  mayHarmTarget?: boolean;
};

/**
 * Whether pressing the stone in this square would do anything, and why not.
 *
 * The order of the tests is the order a player would want them: what is in the
 * square, then what the stone costs you, then where everybody is standing. A
 * cooling stone that is also out of range reads as cooling, which is the fact
 * that will still be true when you have walked closer.
 */
export function castability(context: CastContext, slot: CastSlot): Castability {
  const stone = spellIn(context, slot);
  // A square with nothing in it, and a name this body has no spell for — the
  // same refusal, because both are a button pointing at no spell. A `cast`
  // action naming a spell somebody renamed is the second case, and it falls
  // through to the brain's next line rather than stalling the creature.
  if (!stone) return refused("empty");

  // Before the cooldown, because it is the fact that will still be true when
  // the cooldown has run out: a body mid-cast cannot start another whatever
  // else is ready. The button the cast came out of is told so in its own word,
  // because it is the one a caster can still press. @see CastContext.casting
  if (context.casting) {
    return refused(sameSlot(context.casting.slot, slot) ? "underway" : "casting");
  }

  if (cooldownOf(context, slot) > 0) return refused("cooling");

  if (!meetsRequirements(context.masteries, stone.requirements)) {
    return refused("mastery");
  }

  return reachability(context, stone);
}

/**
 * The spell one slot names, or null when it names none.
 *
 * Read off the instance for a square and off the body for a natural spell,
 * which is the whole of what the two arms differ in here.
 */
export function spellIn(context: CastContext, slot: CastSlot): ArcaneStoneItem | null {
  if (slot.from === "square") return stoneInSquare(context, slot.square);
  return context.spells.find((spell) => spell.name === slot.name) ?? null;
}

/**
 * Milliseconds left before this slot may be cast again.
 *
 * A square reads the instance rather than the def, because two identical stones
 * in two hands cool independently — see `../lib/itemInstance`. A natural spell
 * reads the body's own clock, because there is no instance to hang one on.
 */
function cooldownOf(context: CastContext, slot: CastSlot): number {
  if (slot.from === "natural") return context.spellCooldownsMs[slot.name] ?? 0;
  return context.equipment[slot.square]?.cooldownMs ?? 0;
}

/**
 * Whether the caster is standing somewhere this stone could land.
 *
 * Split out of {@link castability} because it is the half that changes as
 * people walk about, and because it is the only half a cast that has already
 * spent its cooldown still has to ask.
 *
 * **A stone at its own caster never asks it**, wherever it is worn: there is no
 * distance to cross, which is also why a self spell can never misfire at an
 * enemy. What decides this is whom the effect names and nothing else — see
 * {@link needsTarget}, which is the whole of the rule.
 */
/**
 * Whether this stone takes health off whoever it lands on.
 *
 * The sign of the authored number and nothing else: positive harms, negative
 * mends, absent moves nothing. @see `../lib/item`'s {@link StoneEffect}
 */
function harmsOnLanding(stone: ArcaneStoneItem): boolean {
  const effect = stone.effect;
  return effect.kind === "bolt" && effect.on === "target" && (effect.damage ?? 0) > 0;
}

function reachability(context: CastContext, stone: ArcaneStoneItem): Castability {
  if (!needsTarget(stone)) return CASTABLE;

  const target = context.target;
  // A conjure with nobody targeted lands in front of the caster, which is the
  // one case where "no target" is not a refusal — see `../lib/item`'s
  // {@link StoneEffect}.
  if (!target && stone.effect.kind !== "conjure") return refused("noTarget");

  // The stone's own reach, through the same machinery a swing goes through:
  // close enough, and with nothing in the way. A stone with no reach authored
  // gets an arm's length, which is what `reachOf` means by an absent block.
  if (target && !canReach(context.map, context.tilesById, context.caster, target, reachOf(stone))) {
    return refused("outOfRange");
  }

  // **A spell that would take health off somebody this caster may not fight is
  // refused before it starts.** Here rather than where the bolt lands, so the
  // button says so and the cooldown is not spent on a cast that could do
  // nothing — the same argument the blocked conjure below makes.
  //
  // The damage alone, which is what the authored number says the spell is for:
  // a mend thrown at a stranger is a strange thing to author and not a thing to
  // refuse, and a bolt whose whole effect is a curse is stopped where every
  // other bad status is, on the way onto the body. @see
  // `./GameSession.grantStatus`
  if (target && harmsOnLanding(stone) && context.mayHarmTarget === false) {
    return refused("peaceful");
  }

  // Asked here rather than when the placement is made, so a conjure that
  // cannot land is a refusal and costs nothing. It used to spend its cooldown
  // on the grounds that a swing that misses does too — but a swing that misses
  // still swung, and a flame that never appeared is a press the player cannot
  // tell from a dropped key.
  if (stone.effect.kind === "conjure" && !conjureLanding(context, stone.effect.tileId)) {
    return refused("blocked");
  }
  return CASTABLE;
}

/** Where a conjured tile goes, and where in the stack. @see conjureLanding */
export type ConjureLanding = {
  at: Coord;
  /** Beneath the body at this index, or on top when absent. */
  under?: number;
};

/**
 * Where a conjure lands — the target's cell, or the one in front — or null
 * when that cell will not take the tile.
 *
 * **One answer for the button and the cast**, which is why it is here and not
 * in the session: the browser dims the stone off the same call the session
 * places the tile with, so a lit button is a flame that will appear.
 *
 * With a target it lands beneath them, so what arrives is a thing they are
 * standing in rather than a thing balanced on their head. With nobody targeted
 * it lands in **the cell the caster could step into**, asked through the same
 * `canWalk` their legs are. That is the whole rule, and it is what refuses
 * water, a bush and a wall with no list of any of them: a flame was stacked on
 * top of a bush, or floated on a pond, because a height check alone says both
 * have room. It also puts a flame laid at the top of a ramp on the ramp.
 *
 * That cell can have somebody in it, and then the tile goes beneath them too —
 * the same rule the target gets, read off the cell rather than off the target.
 * @see lowestBodyIn
 *
 * Either way the tile must fit where it lands — `canPlace`, the check the
 * editor stamps with.
 */
export function conjureLanding(context: CastContext, tileId: string): ConjureLanding | null {
  const def = context.tilesById[tileId];
  if (!def) return null;

  const target = context.target;
  const landing: ConjureLanding | null = target
    ? { at: { x: target.x, y: target.y, z: target.z }, under: target.stackIndex }
    : cellInFront(context);
  if (!landing) return null;

  const { at } = landing;
  return canPlace(context.map, at.x, at.y, at.z, def, context.tilesById).ok ? landing : null;
}

/** The cell the caster would step into, or null when they could not. */
function cellInFront(context: CastContext): ConjureLanding | null {
  const { caster, map, tilesById } = context;
  const body = tilesById[caster.tileId];
  if (!body) return null;
  const step = canWalk(map, caster, caster.facing, body, tilesById);
  if (!step.ok) return null;
  const { to } = step;
  const under = lowestBodyIn(getStack(map, to.x, to.y, to.z), tilesById);
  return under === undefined ? { at: to } : { at: to, under };
}

/**
 * Where the lowest body in a stack is standing, or undefined for a cell nobody
 * is in.
 *
 * **The cell in front can have somebody in it.** `canWalk` says yes to a cell
 * a creature is standing in — that is how you walk into something to swing at
 * it — so an untargeted conjure needs the rule a targeted one gets from the
 * target's own stack index, read off the cell instead. Without it the flame you
 * lay at the feet of the rat in front of you goes on top of the rat: a tile
 * acts on what is *below* it, so that is a flame nothing is standing in, and it
 * moves off the moment the rat does.
 *
 * The lowest, not the topmost, so a cell with two bodies in it puts the tile
 * under both rather than between them.
 */
function lowestBodyIn(
  stack: readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | undefined {
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i];
    if (placed && isBodyPlacement(placed, tilesById)) return i;
  }
  return undefined;
}

/**
 * Whether this stone reaches for somebody other than its holder.
 *
 * The one question that decides whether a target and a range matter at all, and
 * **it is answered by the effect alone. The square has no say.** A **bolt** says
 * whose body it lands on and that is the whole answer, whether what lands is
 * health, a status or both: a spell aimed at its own caster wants nobody
 * targeted and no range. A **conjure** always wants a cell, and picks the one in
 * front when nobody is targeted.
 *
 * **The charm used to be refused a target outright**, on the argument that a
 * passive trinket reaching as far as a hand does would be the longest-ranged
 * thing in the game. The cost of that rule was worse than the thing it
 * prevented: a stone authored `on: "target"` did not fail in the charm square,
 * it *silently landed on its wearer* — so dragging Sleet onto the charm turned
 * an attack into four points of self-harm behind a fully lit button. The rule
 * was stated in five places and the retargeting in two, and nothing said the
 * two were the same rule.
 *
 * So a charm reaches whatever a hand reaches, held to the same range and the
 * same wall. What still separates the squares is what they *cost*: a hand is a
 * swing you gave up, and the charm is the square that costs no swing at all —
 * see {@link CAST_SQUARES}. That is a price, not a reach, and it is the one this
 * module was conflating.
 *
 * The `square` is still taken, and deliberately: an unused parameter here would
 * be a caller free to stop passing one, and the next rule that genuinely is
 * about the square would have to thread it back through four call sites.
 */
function needsTarget(stone: ArcaneStoneItem): boolean {
  if (stone.effect.kind === "conjure") return true;
  return stone.effect.on === "target";
}

/**
 * How long this stone takes to cast in these hands, in milliseconds.
 *
 * **What is authored is the price at exactly the asking level, and every point
 * past that is time off.** A caster bringing 110% of what a stone asks casts it
 * in 90% of its authored time, one bringing 150% in half of it, and one who has
 * doubled the requirement casts instantly. That is one subtraction rather than a
 * curve on purpose: a player who has just put a point into Fire should be able
 * to see where it went, and "10% more than it asks is 10% faster" is a sentence
 * they can hold in their head while looking at the requirements grid.
 *
 * **It is what makes a starter spell worth keeping.** A stone of Flame asks
 * Arcane 10 and Fire 1, so three seconds at the moment you can first hold one
 * and instant by Arcane 21 — the spell does not get stronger, it gets quick, and
 * a caster who has grown past it is throwing it as fast as they can press. The
 * stones at the top of the ladder ask thirty-odd points and stay slow for a long
 * time, which is the whole shape of the trade.
 *
 * Never longer than the authored time, however short the caster falls: a
 * shortfall refuses the cast outright — see {@link meetsRequirements} — so the
 * arm above 1 would only ever describe a cast that cannot happen. Floored at
 * zero, which is an instant cast and reads as one everywhere downstream.
 *
 * @see `../lib/mastery`'s {@link requirementCoverage} for what the share counts.
 */
export function castDurationMs(stone: ArcaneStoneItem, masteries: Masteries): number {
  const authored = stone.castTimeMs ?? 0;
  if (authored <= 0) return 0;
  const coverage = requirementCoverage(masteries, stone.requirements);
  const share = Math.min(REQUIREMENTS_MET, REQUIREMENTS_MET - (coverage - REQUIREMENTS_MET));
  return Math.max(0, Math.round(authored * share));
}

/** The stone in this square, or null when there is not one. */
function stoneInSquare(context: CastContext, square: CastSquare): ArcaneStoneItem | null {
  const held = context.equipment[square];
  if (!held) return null;
  const def = context.tilesById[held.tileId];
  return def ? resolveStone(def) : null;
}

/**
 * One stone a player could press, and everything a button needs to draw it.
 *
 * A flat row rather than a reference back into the kit, because what draws these
 * is a React component that must not be re-deriving item blocks on a frame — and
 * because the two figures a countdown needs are the *remaining* time and the
 * *whole* time, and only one of those is on the instance.
 */
export type SpellButton = {
  slot: CastSlot;
  /**
   * Which particular spell, so a list re-rendered mid-cast keys stably.
   *
   * The stone's instance id rather than the square, because a player who swaps
   * stones between hands has the same two buttons in the same order holding
   * different things, and a list keyed by position would animate one into the
   * other. A natural spell has no instance to name, so it is keyed by its own
   * name — which is what a body's spell is identified by everywhere else.
   */
  key: string;
  /**
   * The stone's tile, to draw on the button — so what is in your hand and what
   * is on the button are recognisably one thing. Null for a natural spell,
   * which has no tile and carries {@link icon} instead.
   */
  tileId: string | null;
  /**
   * A natural spell's own picture, or null for a carried stone and for a spell
   * nobody has drawn yet. @see `../lib/battler`'s `NaturalSpell.icon`
   */
  icon: AnchoredSprite | null;
  /** What it is called, for the accessible name. */
  name: string;
  /** Milliseconds left before it is ready, or zero for a stone that is. */
  cooldownMs: number;
  /** What a full cooldown is, so a bar has a denominator. */
  cooldownTotalMs: number;
  /**
   * How long pressing it would take **in these hands**, or zero for an instant
   * stone. @see castDurationMs
   *
   * The scaled figure rather than the authored one, because the authored one is
   * a fact about the stone and this is the answer to "what happens if I press
   * it". It is the one number on a button that a level-up moves, which is worth
   * having on the tooltip: a caster watching three seconds become two has been
   * shown what the point they just earned bought them.
   */
  castTimeMs: number;
  castability: Castability;
};

/**
 * Every stone a player could press, in square order, with why each can or
 * cannot be.
 *
 * **Automatic stones are absent entirely**, rather than present and permanently
 * dimmed. A button is a promise that pressing it does something, and a passive
 * charm has nothing to press — so the row that draws these has exactly as many
 * buttons as there are spells to cast, and none at all for a body carrying no
 * stones. That is the whole of "a profession you do not play costs you none of
 * your screen".
 *
 * **So is a stone whose requirements the caster has not met**, on the same
 * grounds. Every other refusal is something the caster can do from where they
 * are standing — wait out a cooldown, walk closer, point at somebody — so the
 * button is worth keeping around to press when it changes. A shortfall in
 * mastery changes only by going away and levelling, and until it does the stone
 * is a permanently dead disc taking up one of three squares. What the stone asks
 * for is on its item card, beside the levels the caster actually has, which is
 * where somebody deciding whether to go and earn it is already looking — see
 * `./itemCard`'s `requirementsFrom`.
 *
 * {@link castability} still answers `mastery`, because the session and the
 * server ask it about a square rather than about a row, and a cast asked for by
 * any other means has to be refused rather than hidden.
 *
 * The name comes off the instance's description before the tile's, on the terms
 * everything else that names a carried thing does: a stone somebody has written
 * on is still the stone that says what it says.
 */
export function castableSpells(context: CastContext): SpellButton[] {
  const buttons: SpellButton[] = [];
  for (const square of CAST_SQUARES) {
    const instance = context.equipment[square];
    if (!instance) continue;
    const def = context.tilesById[instance.tileId];
    const stone = def ? resolveStone(def) : null;
    if (!stone) continue;
    // Asked here rather than read off the verdict below, because the verdict
    // reports the first refusal that is true and a body mid-cast reports that
    // instead — which would blink an unearned stone into the row for as long as
    // a cast runs. @see meetsRequirements
    if (!meetsRequirements(context.masteries, stone.requirements)) continue;

    const slot = squareSlot(square);
    buttons.push({
      slot,
      key: instance.id,
      tileId: instance.tileId,
      icon: null,
      name: instance.inscription?.trim() || def?.name || instance.tileId,
      cooldownMs: instance.cooldownMs ?? 0,
      cooldownTotalMs: stone.cooldownMs,
      castTimeMs: castDurationMs(stone, context.masteries),
      castability: castability(context, slot),
    });
  }

  // After the squares, because the squares are the loadout a player chose and
  // these are what the body came with — and because the order is the order the
  // number keys are bound in, so picking up a stone must not renumber what a
  // body could already do.
  for (const spell of context.spells) {
    if (!meetsRequirements(context.masteries, spell.requirements)) continue;
    const slot = naturalSlot(spell.name);
    buttons.push({
      slot,
      key: spell.name,
      tileId: null,
      icon: spell.icon ?? null,
      name: spell.name,
      cooldownMs: context.spellCooldownsMs[spell.name] ?? 0,
      cooldownTotalMs: spell.cooldownMs,
      castTimeMs: castDurationMs(spell, context.masteries),
      castability: castability(context, slot),
    });
  }
  return buttons;
}

/**
 * What a row of buttons *says* right now, as a string.
 *
 * The same trick a status list is compared by — see `./statuses`'s
 * `statusReading` — and for the same reason: a cooldown moves every tick, so
 * identity says "changed" thirty times a second and tells nobody anything. What
 * a button can actually show is its sprite, whether it is dimmed and a countdown
 * to the second, so that is the grain worth comparing at.
 *
 * Whole seconds rather than the raw remainder, because that is the grain the
 * session winds a cooldown at — see {@link COOLDOWN_STEP_MS}. The ring still
 * moves smoothly: the button animates between steps in the browser, so the page
 * renders once a second and not once a frame. @see `../components/SpellBar`
 */
export function spellReading(buttons: readonly SpellButton[]): string {
  if (buttons.length === 0) return "";
  return buttons
    .map((button) => {
      const refusal = button.castability.ok ? "" : button.castability.reason;
      const seconds = Math.ceil(button.cooldownMs / MS_PER_SECOND);
      // The cast time moves only when a level does, and it is on the tooltip —
      // so it is compared here for the reason everything else is: a figure the
      // button can show and never re-renders for is a figure that goes stale.
      return `${button.key}:${seconds}:${button.castTimeMs}:${refusal}`;
    })
    .join("|");
}

/**
 * What a refusal says out loud, for the accessible name on a dimmed button.
 *
 * Second person and present tense, because it is the answer to the question the
 * player is asking by reaching for the thing. Kept here beside the reasons
 * rather than in the component, so a reason added to the union is a compile
 * error in one place instead of a button that silently says nothing.
 */
export const CAST_REFUSAL_NOTES: Record<CastRefusal, string> = {
  empty: "nothing there",
  underway: "casting, press again to stop",
  casting: "already casting",
  cooling: "still cooling",
  mastery: "not learnt yet",
  noTarget: "nothing targeted",
  outOfRange: "out of range",
  blocked: "nowhere for it to land",
  peaceful: "they are not in the fighting",
};

/**
 * What pressing this button asks the session for, or nothing.
 *
 * Wider than "would it fire", and deliberately: a stone refused for want of a
 * target is sent, refused by the session, and answered with a sentence — see
 * `./notices`' `castRefusalNotice`. And the stone being cast asks for something
 * else entirely: pressing it again is how a cast is stopped. Every other refusal
 * is stopped here, because there is nothing to say that the dimming has not
 * already said.
 *
 * Here rather than in the component, because the number keys ask the same
 * question — see `../routes`' cast key bindings — and two answers to "what does
 * pressing this do" would be a button and a key that disagree.
 */
export type SpellPress = "cast" | "stop";

/** @see SpellPress */
export function spellPress(castability: Castability): SpellPress | null {
  if (castability.ok) return "cast";
  if (castability.reason === "noTarget") return "cast";
  if (castability.reason === "underway") return "stop";
  return null;
}

/**
 * Why a stone will not come out of its square, in a sentence.
 *
 * A cooling stone refusing to move is the one refusal in the item model that
 * needs saying out loud: every other one is a drag the interface never offered,
 * where this is a square a player can plainly see something in and plainly
 * cannot empty. Silence there reads as the panel being broken.
 *
 * Names the stone rather than the square, because what is doing the refusing is
 * the thing rather than the place — put it in the other hand and it would refuse
 * from there too.
 */
export function coolingNotice(name: string): string {
  return `The ${name} is still cooling. It cannot be moved until it is ready.`;
}

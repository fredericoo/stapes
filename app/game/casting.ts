import type { ArcaneStoneItem } from "../lib/item";
import { reachOf, resolveStone } from "../lib/item";
import {
  type Masteries,
  masteryLevel,
  MASTERIES,
  requirementCoverage,
  REQUIREMENTS_MET,
} from "../lib/mastery";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
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
  /** This body is already part-way through a cast. @see CastContext.casting */
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
  | "blocked";

/** Whether this stone can be cast, and why not when it cannot. */
export type Castability =
  | { ok: true }
  | { ok: false; reason: CastRefusal };

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
   * **One cast at a time, and it refuses every square rather than its own.** A
   * caster half way through a three-second flame has their hands full, and the
   * stone they are not casting is no more pressable than the one they are — so
   * the whole row dims and comes back together, which is a picture a player can
   * read without knowing which button started it.
   *
   * Only the clock, never which stone: what a *button* needs to know is that
   * nothing can be pressed, and the square the cast came out of is the session's
   * own business. @see `./progress`
   */
  casting: Progress | null;
  /**
   * Where the caster's target is standing, or null for a body pointing at
   * nobody.
   *
   * The *target*, not a cell: a player never picks an arbitrary square, so there
   * is no third thing to pass. See the module note on `./casting`'s scope, and
   * `../lib/item`'s {@link StoneEffect} for what a conjure does with no target.
   */
  target: CastPoint | null;
};

/**
 * Whether pressing the stone in this square would do anything, and why not.
 *
 * The order of the tests is the order a player would want them: what is in the
 * square, then what the stone costs you, then where everybody is standing. A
 * cooling stone that is also out of range reads as cooling, which is the fact
 * that will still be true when you have walked closer.
 */
export function castability(
  context: CastContext,
  square: CastSquare,
): Castability {
  const stone = stoneInSquare(context, square);
  if (!stone) return refused("empty");

  // Before the cooldown, because it is the fact that will still be true when
  // the cooldown has run out: a body mid-cast cannot start another whatever
  // else is ready. @see CastContext.casting
  if (context.casting) return refused("casting");

  const instance = context.equipment[square];
  // Read off the instance rather than off the def, because two identical stones
  // in two hands cool independently — see `../lib/itemInstance`.
  if (instance?.cooldownMs) return refused("cooling");

  if (!meetsRequirements(context.masteries, stone.requirements)) {
    return refused("mastery");
  }

  return reachability(context, square, stone);
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
function reachability(
  context: CastContext,
  square: CastSquare,
  stone: ArcaneStoneItem,
): Castability {
  if (!needsTarget(square, stone)) return CASTABLE;

  const target = context.target;
  // A conjure with nobody targeted lands in front of the caster, which is the
  // one case where "no target" is not a refusal — see `../lib/item`'s
  // {@link StoneEffect}.
  if (!target && stone.effect.kind !== "conjure") return refused("noTarget");

  // The stone's own reach, through the same machinery a swing goes through:
  // close enough, and with nothing in the way. A stone with no reach authored
  // gets an arm's length, which is what `reachOf` means by an absent block.
  if (
    target &&
    !canReach(
      context.map,
      context.tilesById,
      context.caster,
      target,
      reachOf(stone),
    )
  ) {
    return refused("outOfRange");
  }

  // Asked here rather than when the placement is made, so a conjure that
  // cannot land is a refusal and costs nothing. It used to spend its cooldown
  // on the grounds that a swing that misses does too — but a swing that misses
  // still swung, and a flame that never appeared is a press the player cannot
  // tell from a dropped key.
  if (
    stone.effect.kind === "conjure" &&
    !conjureLanding(context, stone.effect.tileId)
  ) {
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
 * Either way the tile must fit where it lands — `canPlace`, the check the
 * editor stamps with.
 */
export function conjureLanding(
  context: CastContext,
  tileId: string,
): ConjureLanding | null {
  const def = context.tilesById[tileId];
  if (!def) return null;

  const target = context.target;
  const landing: ConjureLanding | null = target
    ? { at: { x: target.x, y: target.y, z: target.z }, under: target.stackIndex }
    : cellInFront(context);
  if (!landing) return null;

  const { at } = landing;
  return canPlace(context.map, at.x, at.y, at.z, def, context.tilesById).ok
    ? landing
    : null;
}

/** The cell the caster would step into, or null when they could not. */
function cellInFront(context: CastContext): ConjureLanding | null {
  const { caster, map, tilesById } = context;
  const body = tilesById[caster.tileId];
  if (!body) return null;
  const step = canWalk(map, caster, caster.facing, body, tilesById);
  return step.ok ? { at: step.to } : null;
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
function needsTarget(_square: CastSquare, stone: ArcaneStoneItem): boolean {
  if (stone.effect.kind === "conjure") return true;
  return stone.effect.on === "target";
}

/**
 * Whether every mastery this stone asks for has been earned.
 *
 * **All of them, and met exactly rather than scaled**, which is the one place a
 * stone and a weapon part company. A weapon half-understood still swings — see
 * `../lib/mastery`'s `learningRate` and `requirementShare`, which turn a
 * shortfall into a share of the weapon — because swinging is a body doing what
 * bodies do. A stone either answers you or it does not, and a spell that fired
 * at a third strength would be a thing a player has to measure to learn about.
 *
 * Requirements on masteries the stone does not train are honoured on exactly the
 * terms a weapon's are: what a Stone of Flame *teaches* is Arcane, and what it
 * takes to hold one steady may be something you go and get elsewhere.
 */
export function meetsRequirements(
  masteries: Masteries,
  requirements: Masteries | undefined,
): boolean {
  if (!requirements) return true;
  return MASTERIES.every(
    (mastery) =>
      masteryLevel(masteries, mastery) >= (requirements[mastery] ?? 0),
  );
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
 * Arcane 5 and Fire 1, so three seconds at the moment you can first hold one and
 * instant by Arcane 11 — the spell does not get stronger, it gets quick, and a
 * caster who has grown past it is throwing it as fast as they can press. The
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
export function castDurationMs(
  stone: ArcaneStoneItem,
  masteries: Masteries,
): number {
  const authored = stone.castTimeMs ?? 0;
  if (authored <= 0) return 0;
  const coverage = requirementCoverage(masteries, stone.requirements);
  const share = Math.min(
    REQUIREMENTS_MET,
    REQUIREMENTS_MET - (coverage - REQUIREMENTS_MET),
  );
  return Math.max(0, Math.round(authored * share));
}

/** The stone in this square, or null when there is not one. */
function stoneInSquare(
  context: CastContext,
  square: CastSquare,
): ArcaneStoneItem | null {
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
  square: CastSquare;
  /**
   * Which particular stone, so a list re-rendered mid-cast keys stably.
   *
   * The id rather than the square, because a player who swaps stones between
   * hands has the same two buttons in the same order holding different things,
   * and a list keyed by position would animate one into the other.
   */
  itemId: string;
  /** What to draw on the button. The stone's own sprite, so the hand and the
   * button are recognisably one thing. */
  tileId: string;
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
 * The name comes off the instance's description before the tile's, on the terms
 * everything else that names a carried thing does: a stone somebody has written
 * on is still the stone that says what it says.
 */
export function castableStones(context: CastContext): SpellButton[] {
  const buttons: SpellButton[] = [];
  for (const square of CAST_SQUARES) {
    const instance = context.equipment[square];
    if (!instance) continue;
    const def = context.tilesById[instance.tileId];
    const stone = def ? resolveStone(def) : null;
    if (!stone) continue;

    buttons.push({
      square,
      itemId: instance.id,
      tileId: instance.tileId,
      name: instance.description?.trim() || def?.name || instance.tileId,
      cooldownMs: instance.cooldownMs ?? 0,
      cooldownTotalMs: stone.cooldownMs,
      castTimeMs: castDurationMs(stone, context.masteries),
      castability: castability(context, square),
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
      return `${button.square}:${button.itemId}:${seconds}:${button.castTimeMs}:${refusal}`;
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
  casting: "already casting",
  cooling: "still cooling",
  mastery: "not learnt yet",
  noTarget: "nothing targeted",
  outOfRange: "out of range",
  blocked: "nowhere for it to land",
};

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

import type { ArcaneStoneItem } from "../lib/item";
import { reachOf, resolveStone } from "../lib/item";
import {
  type Masteries,
  masteryLevel,
  MASTERIES,
} from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { canReach } from "./combat";
import type { ReachPoint } from "./distance";
import type { Equipment } from "./equipment";

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
  /**
   * It fires on its own, so there is nothing to press.
   *
   * A refusal rather than a silence, because it is the answer to *this* question
   * — "would pressing this cast it" — and the answer is no. What actually keeps
   * an automatic stone off the screen is `castableStones`, which leaves it out
   * of the list entirely: a button for a thing that presses itself is a control
   * with nothing behind it.
   */
  | "automatic"
  /** Still counting down. @see ArcaneStoneItem.cooldownMs */
  | "cooling"
  /** The caster has not earned what it asks. @see ArcaneStoneItem.requirements */
  | "mastery"
  /** It acts on somebody else and nobody is targeted. */
  | "noTarget"
  /** Somebody is targeted, and they are too far away or behind something. */
  | "outOfRange";

/** Whether this stone can be cast, and why not when it cannot. */
export type Castability =
  | { ok: true }
  | { ok: false; reason: CastRefusal };

/** The unit a countdown is drawn in, and so the grain {@link spellReading} compares at. */
const MS_PER_SECOND = 1000;

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
export type CastPoint = ReachPoint & { z: number };

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
  caster: CastPoint;
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
 * **A charm never asks it.** A charm acts on its holder and nothing else, so
 * where anybody is standing has no bearing on it — which is also why a self
 * spell can never misfire at an enemy. A hand stone whose effect is on its
 * caster is in exactly the same position, and gets the same answer: what decides
 * this is whom the effect names, not which square the stone is in.
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
  // {@link StoneEffect}. Whether the cell in front will actually take the tile
  // is the board's question and is asked when the placement is made: a spell
  // that fails because somebody built a wall there still spends its cooldown, on
  // the terms every other cast does.
  if (!target) {
    return stone.effect.kind === "conjure" ? CASTABLE : refused("noTarget");
  }

  // The stone's own reach, through the same machinery a swing goes through:
  // close enough, and with nothing in the way. A stone with no reach authored
  // gets an arm's length, which is what `reachOf` means by an absent block.
  return canReach(
    context.map,
    context.tilesById,
    context.caster,
    target,
    reachOf(stone),
  )
    ? CASTABLE
    : refused("outOfRange");
}

/**
 * Whether this stone reaches for somebody other than its holder.
 *
 * The one question that decides whether a target and a range matter at all, and
 * it has two halves that both have to be true. A **charm** is refused a target
 * outright, whatever its effect says: an author who writes a `target` status on
 * a charm has written something the square cannot honour, and honouring it
 * anyway would make a passive trinket the longest-ranged thing in the game.
 *
 * Everything else is what the effect names. A **bolt** and a **status** both say
 * whose body they land on, and the answer is the same question for both: a
 * spell aimed at its own caster wants nobody targeted and no range, whichever
 * direction its arithmetic runs. That symmetry is the whole reason a mend is no
 * longer a case here — it used to be refused a target outright, and now it is
 * simply a bolt that says `caster`.
 */
function needsTarget(square: CastSquare, stone: ArcaneStoneItem): boolean {
  if (square === "charm") return false;
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
 * What an automatic stone needs to know about its holder to decide for itself.
 *
 * Deliberately not the whole body: an automatic stone asks one question about
 * the person wearing it, and handing this module an actor runtime would be
 * handing it the session.
 */
export type StoneHolder = {
  hp: number;
  maxHp: number;
  /** The ids of what is already running on them. */
  statusIds: readonly string[];
};

/**
 * Whether an automatic stone's moment has come.
 *
 * **A passive that fired the instant it was ready would be a passive that is
 * never ready**, which is the whole reason this exists: a necklace that tops you
 * up would spend its charge the moment you were scratched — or, at full health,
 * the moment it came off cooldown, on nothing at all — and be cooling every time
 * you actually needed it. So the condition is "casting this now would not be
 * wasted", asked per effect:
 *
 * - a **mending bolt** waits until its holder is missing health;
 * - a **status** waits until its holder is not already under it;
 * - a **conjure** has no such thing as being wasted — a flame laid on an empty
 *   floor is still a flame — so it fires as soon as it can. An author who wants
 *   a trail of fire behind them has written exactly that.
 *
 * **Only the mending direction waits.** A charm is worn on a square that reaches
 * nobody but its wearer, so an automatic bolt with a positive damage is a
 * trinket that hurts the person carrying it — which is a thing an author may
 * write and nothing here should second-guess. It has no wasted moment to wait
 * for: every press of it does exactly what it says.
 *
 * Asked *after* {@link castability}, never instead of it: this decides whether
 * the moment is right, and that decides whether it is allowed at all.
 */
export function automaticFires(
  stone: ArcaneStoneItem,
  holder: StoneHolder,
): boolean {
  if (stone.effect.kind === "bolt") {
    return stone.effect.damage >= 0 || holder.hp < holder.maxHp;
  }
  if (stone.effect.kind === "status") {
    return !holder.statusIds.includes(stone.effect.id);
  }
  return true;
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
    if (!stone || stone.automatic) continue;

    buttons.push({
      square,
      itemId: instance.id,
      tileId: instance.tileId,
      name: instance.description?.trim() || def?.name || instance.tileId,
      cooldownMs: instance.cooldownMs ?? 0,
      cooldownTotalMs: stone.cooldownMs,
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
 * Whole seconds rather than the raw remainder, which makes the bar advance in
 * steps of a second. That is the honest resolution of the thing being drawn: the
 * bar is a countdown and not an animation, and a smoother one would cost a React
 * render per frame for a difference of two pixels on a two-minute spell.
 */
export function spellReading(buttons: readonly SpellButton[]): string {
  if (buttons.length === 0) return "";
  return buttons
    .map((button) => {
      const refusal = button.castability.ok ? "" : button.castability.reason;
      const seconds = Math.ceil(button.cooldownMs / MS_PER_SECOND);
      return `${button.square}:${button.itemId}:${seconds}:${refusal}`;
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
  automatic: "works on its own",
  cooling: "still cooling",
  mastery: "not learnt yet",
  noTarget: "nothing targeted",
  outOfRange: "out of range",
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

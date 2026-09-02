import type { FightingStats } from "../lib/battler";
import type { Element } from "../lib/element";
import type { FormulaScope } from "../lib/formula";
import { MAX_PERCENT_STAT } from "../lib/item";
import { MODIFIER_KEYS, type StatusDef } from "../lib/status";
import { TICK_MS } from "./constants";
import type { Rng } from "./rng";

/**
 * A status effect while it is actually running on somebody.
 *
 * The `./decay` of this feature, and split from `../lib/status` on the same
 * terms `./combat` is split from `../lib/battler`: the def is what an author
 * wrote, this is what a tick does with it.
 *
 * **Everything here is pure.** The session owns the list and the hit points; this
 * owns the arithmetic that moves them. That is what lets stacking, cadence and
 * expiry be asserted without a world.
 */

/** One status running on one body. */
export type StatusInstance = {
  defId: string;
  /** What it was rolled at, and the denominator of `ELAPSED_SEC`. */
  durationMs: number;
  /** What is left. Counted down by the tick, and the thing that is stored. */
  remainingMs: number;
  /** Towards the next period. See {@link advanceStatuses}. */
  sinceEffectMs: number;
  /**
   * Who is answerable for this running, when anybody is.
   *
   * **The whole of how a spell that works indirectly gets paid for.** An arcane
   * stone of flame conjures a tile; the tile burns whoever walks into it; and
   * without this the burning is something that happened to somebody with nobody
   * on the other end of it. Carried here rather than on the tile because it is a
   * fact about *this* application — two flames lit by two casters put the same
   * status on the same rat, and only the instances can tell them apart.
   *
   * An actor id, and read only by whatever pays out experience — see
   * `../game/experience`'s `casterEarnings`. A cause naming somebody who has
   * since left the world is not an error: the lookup comes back empty and the
   * damage is simply attributed to nobody, which is what a status with no cause
   * has always done.
   *
   * Absent for the overwhelming majority: a berry, a venomous bite, a hearth
   * somebody built a year ago. **A status with no cause behaves exactly as it
   * did before this field existed**, which is the property to protect here.
   */
  causedBy?: string;
  /**
   * What the spell that started this was made of, when a spell started it.
   *
   * **Rides beside {@link causedBy} because it answers the other half of the
   * same question**: that one says who is answerable for this burning, and this
   * says what kind of magic the burning is. Both are facts about *this
   * application* rather than about the status def — one flame was lit by a Stone
   * of Ember and another by a hearth, and only the instances can tell them
   * apart.
   *
   * Read where the damage lands, to scale it on `../lib/element`'s wheel against
   * whatever the body it lands on is attuned to. Absent for the overwhelming
   * majority — a hearth, a berry, a venomous bite — and **an absent element is a
   * neutral one**, so every burn in the world that nobody cast behaves exactly
   * as it did before this field existed. That is the property to protect here,
   * and it is the same one `causedBy` protects.
   *
   * Elements rather than an element: a stone asking Fire and Water throws both,
   * and flattening that to one at the moment of casting would lose the thing
   * multi-element spells are for. @see `../lib/mastery`'s `spellElements`
   */
  elements?: readonly Element[];
};

/** What a formula needs to know about the body carrying it. */
export type StatusBearer = {
  hp: number;
  /** **Before** any status modifier — see `../lib/formula`'s `MAX_HP`. */
  maxHp: number;
};

/** Nobody is under anything, which is almost everybody almost always. */
export const NO_STATUSES: readonly StatusInstance[] = [];

/**
 * What a status's remaining time reads as when nobody has said.
 *
 * Online, only the viewer's own countdown is on the wire; every other body's
 * statuses arrive as bare ids (`StatusIdsPatch`), because a per-second countdown
 * per body is a message nothing else would use. So a remote body's instance has
 * to say "unknown" rather than guess a number.
 *
 * Infinity rather than a sentinel, because it is *true* in the only sense that
 * is read: as far as this client knows, that status is not running out. It falls
 * through `taperAt` as "not winding down" without a special case, which is the
 * documented consequence of the trade — see {@link StatusIdsPatch}.
 *
 * Nothing formats it. Countdowns are drawn only for the viewer's own body, and
 * that body's figures come off the wire in full.
 */
export const UNKNOWN_REMAINING_MS = Number.POSITIVE_INFINITY;

/**
 * Round a cadence up to a whole number of ticks.
 *
 * A cadence that did not divide the tick rate would drift against the loop and
 * stop being reproducible, which is the whole reason `BRAIN_TICK_MS` is a whole
 * number of ticks. Snapping rather than refusing, because an off-grid number is a
 * rounding question and not a malformed block: 1000ms is exactly 30 ticks, and an
 * author who types 1010 gets 1033⅓ and a note in the editor saying so.
 */
export function snapToTick(everyMs: number): number {
  if (everyMs <= 0) return 0;
  // Nudged before the ceiling because `TICK_MS` is 1000/30 and does not divide a
  // second exactly: `1000 / TICK_MS` is 30.000000000000004, so an honest `ceil`
  // makes one second thirty-*one* ticks and every authored cadence a tick late.
  return Math.max(1, Math.ceil(everyMs / TICK_MS - TICK_EPSILON_MS)) * TICK_MS;
}

/**
 * Slack allowed when comparing two accumulated millisecond counts.
 *
 * `TICK_MS` is not representable, so thirty ticks of it come to 30000.000000000004
 * and thirty seconds of cadence to 30000.000000000003 — a status that should pay
 * out thirty times pays out twenty-nine, and it does so more often the longer it
 * runs. Far smaller than anything the simulation can observe, and far larger than
 * the error it is absorbing.
 */
const TICK_EPSILON_MS = 1e-6;

/**
 * Whole seconds left, rounded **up**, so a status with a millisecond to run
 * still reads one second and only an expired one reads zero.
 *
 * The epsilon is the same accumulated-float slack {@link TICK_EPSILON_MS}
 * absorbs, and `ceil` is where it hurts most: a countdown lands on an exact
 * second boundary precisely when a cadence fires, so 1000.0000000000001ms left
 * read as **two** seconds and every formula reading `ELAPSED_SEC` was a second
 * behind on its first payout. Shared with the chrome so a badge, a panel row and
 * a formula can never disagree about what second it is.
 */
export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000 - TICK_EPSILON_MS));
}

/**
 * What a status list *says* right now, as a string.
 *
 * The list is a fresh array on every tick anything is running, so identity says
 * "changed" thirty times a second and tells you nothing. What anybody can
 * actually *do* with a status list is draw a set of statuses and a whole-second
 * countdown each, so that is the grain worth comparing at — which makes this
 * about one change a second per status rather than thirty.
 *
 * Shared by the server deciding whether to send and by the renderer deciding
 * whether to re-render, so the two cannot come to hold different ideas of when
 * something moved.
 */
export function statusReading(statuses: readonly StatusInstance[]): string {
  if (statuses.length === 0) return "";
  return statuses
    .map((status) => `${status.defId}:${secondsLeft(status.remainingMs)}`)
    .join("|");
}

/**
 * A duration from the authored range, both ends included.
 *
 * **Always exactly one draw**, even where the two ends are equal and the answer
 * was never in doubt — the same discipline a swing's three draws and a decay's
 * one are under. A draw count that varied with what an author typed would mean
 * widening one status's range by a millisecond changed what every creature in the
 * world rolled after it.
 *
 * The world's dice, never a generator of this feature's own: two worlds on one
 * seed must agree about how long somebody was fed as well as about when the blood
 * dried.
 */
export function rollDurationMs(range: DurationRange, rng: Rng): number {
  return range.fromMs + rng.int(range.toMs - range.fromMs + 1);
}

/** Both ends of a duration, from a status or from whatever handed it over. */
export type DurationRange = { fromMs: number; toMs: number };

/**
 * Put a status on a body, or extend the one already there.
 *
 * - **Stacking** adds to what is left and clamps at the authored ceiling.
 * - **Not stacking** refreshes to the longer of the two, never the newer. A bad
 *   roll must not be able to shorten a status you already have — that would make
 *   eating a second berry a punishment often enough to notice.
 *
 * One draw either way, taken before the branch, so what an author picked cannot
 * change what the world rolls next.
 *
 * `durationMs` is re-stated to whatever the remainder became, which is what keeps
 * `ELAPSED_SEC` honest: a stacked status has been running for however much its
 * total now exceeds what is left.
 *
 * Replaced wholesale rather than mutated, on the terms `equipment` and `tags`
 * are: the list goes out on a snapshot and identity is what tells whoever is
 * drawing it that something moved.
 */
export function applyStatus(
  current: readonly StatusInstance[],
  def: StatusDef,
  rng: Rng,
  /**
   * What the thing handing this over says it is worth, if it says anything.
   *
   * Bread and a berry both leave you Fed and differ only in how long — see
   * `../lib/item`'s `StatusGrant`. The ceiling is still the status's own:
   * `maxMs` is a property of the condition, not of the meal.
   */
  range: DurationRange = def,
  /**
   * Who is answerable for it, when anybody is.
   *
   * **The latest cause wins on a re-application**, stacked or refreshed alike,
   * and it is worth saying why rather than, say, keeping the first: what the
   * field is for is paying whoever is *currently* burning somebody, and a rat
   * that walks out of one caster's flame and into another's is being burned by
   * the second. Keeping the first would pay a spell that has already expired for
   * damage it is no longer doing.
   *
   * An absent cause on a re-application therefore clears one that was there,
   * which is the same rule read the other way: a berry eaten while burning ends
   * with nobody answerable for the burn, because a berry is nobody's doing.
   */
  causedBy?: string,
  /**
   * What the spell that is doing this is made of, when a spell is.
   *
   * Travels with the cause and is replaced with it, on the same rule and for the
   * same reason: a rat that walks out of one caster's fire and into another's
   * water is being frozen by the second, and keeping the first would scale the
   * damage on a wheel that is no longer turning.
   */
  elements?: readonly Element[],
): readonly StatusInstance[] {
  const rolled = rollDurationMs(range, rng);
  const existing = current.find((instance) => instance.defId === def.id);

  if (!existing) {
    return [
      ...current,
      {
        defId: def.id,
        durationMs: rolled,
        remainingMs: rolled,
        sinceEffectMs: 0,
        // Omitted rather than written as `undefined`, because a status list is
        // serialized — into a checkpoint and across the wire — and an explicit
        // `undefined` is a key that survives as `null` in some of those.
        ...(causedBy ? { causedBy } : {}),
        ...(elements?.length ? { elements } : {}),
      },
    ];
  }

  const remainingMs = def.stacks
    ? Math.min(def.maxMs, existing.remainingMs + rolled)
    : Math.max(existing.remainingMs, rolled);

  return current.map((instance) => {
    if (instance.defId !== def.id) return instance;
    // Rebuilt rather than spread over, so an absent cause genuinely removes the
    // one that was there: spreading would leave the old key untouched.
    const {
      causedBy: _wasCausedBy,
      elements: _wereElements,
      ...rest
    } = instance;
    return {
      ...rest,
      remainingMs,
      durationMs: remainingMs,
      ...(causedBy ? { causedBy } : {}),
      ...(elements?.length ? { elements } : {}),
    };
  });
}

/**
 * One period's worth of health moved, and who is answerable for it.
 *
 * A shape rather than a signed number because the number alone could not say who
 * lit the fire — see {@link StatusTick.hpChanges}.
 */
export type StatusHpChange = {
  /** Signed: positive heals, negative harms. */
  amount: number;
  /** The actor whose doing this is, when it is anybody's. */
  causedBy?: string;
  /**
   * What the spell behind it was made of, when a spell was behind it.
   *
   * Carried on the figure for the reason the cause is: a body under a conjured
   * burn and an ordinary poison at once owes two different sums to two different
   * wheels, and a bare number cannot say which is which.
   * @see StatusInstance.elements
   */
  elements?: readonly Element[];
};

/** What one tick of statuses did, beside how far they advanced. */
export type StatusTick = {
  statuses: readonly StatusInstance[];
  /**
   * One signed figure per period that fired, in the order they fired, with
   * whoever is answerable for it.
   *
   * A list rather than a sum, because the two directions do not go the same way
   * out: a heal clamps at the maximum and a harm goes through `applyDamage`, so
   * that it shows its number, tells the brains and can kill. Netting them here
   * would be inventing a third path that does neither.
   *
   * The cause rides on each figure rather than being looked up afterwards,
   * because by then there is nothing to look it up on: a body under a burn and a
   * poison at once pays two different people, and a bare number cannot say
   * which. Absent on almost every one of them — see
   * {@link StatusInstance.causedBy}.
   */
  hpChanges: StatusHpChange[];
  /**
   * Whether the *set* changed — something ran out, or its def has gone.
   *
   * Deliberately not "anything happened": every status advances on every tick, so
   * the list is a fresh array whenever it holds anything at all. What this
   * answers is the narrower question the wire asks — whether anybody needs
   * telling, given a client counts its own timers down from what it was last
   * sent.
   */
  expired: boolean;
};

/**
 * Advance every status on a body by one tick.
 *
 * The order inside is load-bearing:
 *
 * 1. **Wind the clocks down**, so a status with one tick left is on its last.
 * 2. **Fire whatever is due**, which is what lets an N-second status at a
 *    one-second cadence pay out exactly N times rather than N−1.
 * 3. **Drop what has run out.**
 *
 * The cadence accumulator is **drained rather than reset**, and the loop is a
 * `while` rather than an `if`, because `GameSession.update` runs up to ten ticks
 * in one call: a status whose cadence is shorter than the catch-up owes every one
 * of those periods, not the last.
 */
export function advanceStatuses(
  statuses: readonly StatusInstance[],
  tickMs: number,
  bearer: StatusBearer,
  catalogue: Record<string, StatusDef>,
): StatusTick {
  // The one case that costs nothing, and the overwhelmingly common one: the same
  // empty array back, no allocation, no walk.
  if (statuses.length === 0) {
    return { statuses, hpChanges: [], expired: false };
  }

  const next: StatusInstance[] = [];
  const hpChanges: StatusHpChange[] = [];
  let expired = false;

  for (const instance of statuses) {
    const def = catalogue[instance.defId];
    // A status whose def has left the catalogue is dropped rather than carried:
    // it is a live rule being applied, and there is no rule left to apply.
    if (!def) {
      expired = true;
      continue;
    }

    const remainingMs = instance.remainingMs - tickMs;
    let sinceEffectMs = instance.sinceEffectMs + tickMs;
    const everyMs = snapToTick(def.everyMs);

    if (everyMs > 0 && def.effects.hp) {
      while (sinceEffectMs + TICK_EPSILON_MS >= everyMs) {
        sinceEffectMs -= everyMs;
        hpChanges.push({
          amount: def.effects.hp.evaluate(
            scopeFor(instance, remainingMs, bearer),
          ),
          // Carried from the instance rather than from the def, because who is
          // answerable is a fact about this application: one status def burns
          // for whoever lit each fire, and on whichever wheel lit it.
          ...(instance.causedBy ? { causedBy: instance.causedBy } : {}),
          ...(instance.elements?.length ? { elements: instance.elements } : {}),
        });
      }
    }

    // Against the epsilon rather than zero, for the reason above: nine hundred
    // subtractions of an unrepresentable tick leave a thirty-second status at
    // plus-a-femtosecond about as often as at minus one, and half the time it
    // would outlive its own duration by a tick.
    if (remainingMs <= TICK_EPSILON_MS) {
      expired = true;
      continue;
    }

    next.push({ ...instance, remainingMs, sinceEffectMs });
  }

  // **Always the advanced list, never the one that came in.** Returning the
  // original on a "nothing notable happened" tick is what an identity
  // optimisation wants to do here, and it throws the countdown away: every
  // status is one tick shorter than it was, so a list that holds anything has
  // changed by definition. One small allocation per bearer per tick, and only
  // for a bearer that is actually under something.
  return { statuses: next, hpChanges, expired };
}

/** What a formula sees while this instance is being evaluated. */
function scopeFor(
  instance: StatusInstance,
  remainingMs: number,
  bearer: StatusBearer,
): FormulaScope {
  const REMAINING_SEC = secondsLeft(remainingMs);
  const DURATION_SEC = secondsLeft(instance.durationMs);
  return {
    DURATION_SEC,
    REMAINING_SEC,
    ELAPSED_SEC: Math.max(0, DURATION_SEC - REMAINING_SEC),
    MAX_HP: bearer.maxHp,
    HP: bearer.hp,
  };
}

/**
 * The stats a body actually fights with, once everything on it has had its say.
 *
 * Read where the stats are read rather than applied on a clock, which is what
 * makes a modifier continuous and an effect periodic — two different kinds of
 * thing that would otherwise both be "what a status does".
 *
 * **Summed, then clamped by the bands the stats already live in.** Nothing new
 * bounds a probability: `MIN_CHANCE`/`MAX_CHANCE` are applied downstream in
 * `./combat` and must stay the only place a chance is held.
 *
 * `flee` is deliberately left unbounded above, exactly as `fleeFrom` leaves it —
 * it is one side of a logistic contest, and a ceiling here would be a second
 * ceiling that silently won.
 *
 * Returns the same object when nothing applies, so the overwhelmingly common
 * "nobody is under anything" costs a length check and no allocation.
 */
export function withStatusModifiers(
  stats: FightingStats,
  statuses: readonly StatusInstance[],
  catalogue: Record<string, StatusDef>,
  hp: number,
): FightingStats {
  if (statuses.length === 0) return stats;

  const deltas: Record<string, number> = {};
  let any = false;

  for (const instance of statuses) {
    const def = catalogue[instance.defId];
    if (!def) continue;
    // `MAX_HP` is the figure *before* any status touches it — see
    // `../lib/formula`. Reading the running total instead would let a status
    // that raises max health and heals a share of it compound against itself.
    const scope = scopeFor(instance, instance.remainingMs, {
      hp,
      maxHp: stats.maxHp,
    });
    for (const key of MODIFIER_KEYS) {
      const formula = def.modifiers[key];
      if (!formula) continue;
      deltas[key] = (deltas[key] ?? 0) + formula.evaluate(scope);
      any = true;
    }
  }

  if (!any) return stats;

  const atLeast = (value: number, floor: number) => Math.max(floor, value);
  const percent = (value: number) =>
    Math.max(0, Math.min(MAX_PERCENT_STAT, value));

  return {
    ...stats,
    // One, not zero: a body whose maximum a status drove to nothing would be
    // dead by arithmetic rather than by anything that happened to it.
    maxHp: atLeast(stats.maxHp + (deltas.maxHp ?? 0), 1),
    damage: atLeast(stats.damage + (deltas.damage ?? 0), 0),
    def: atLeast(stats.def + (deltas.def ?? 0), 0),
    accuracy: percent(stats.accuracy + (deltas.accuracy ?? 0)),
    spd: percent(stats.spd + (deltas.spd ?? 0)),
    flee: atLeast(stats.flee + (deltas.flee ?? 0), 0),
  };
}

import type { FightingStats } from "../lib/battler";
import type { StatusDef } from "../lib/status";
import { type AttackOutcome, rollAttack, swingIntervalMs } from "./combat";
import { TICK_MS } from "./constants";
import type { Rng } from "./rng";
import {
  advanceStatuses,
  applyStatus,
  NO_STATUSES,
  type StatusInstance,
  withStatusModifiers,
} from "./statuses";

/**
 * Two bodies, in reach of each other, until one of them stops.
 *
 * **A fight with the world taken out of it.** `GameSession` decides who is
 * standing where, whether a wall is in the way and who has decided to swing;
 * none of that is a *balance* question, and all of it has to be arranged before
 * two sets of numbers can be compared. What is left when it goes is this: two
 * stat blocks, one dice stream, and the tick loop they are actually fought on.
 *
 * It exists because the arithmetic is only half the answer. `./combat` can tell
 * you what one blow is worth and `./combatMetrics` can tell you the long-run
 * rate, and neither can tell you whether the *fight* is any good — whether the
 * rat gets a second swing in, whether the axe's first blow decides it. That is
 * a question about a sequence, and the only honest way to ask it is to run one.
 *
 * ## The order of a tick is `GameSession`'s, not a convenient one
 *
 * Statuses, then cooldowns, then swings — and both sides start ready, so the
 * faster one lands first. A turn-based approximation would be simpler and would
 * quietly erase speed: a creature that swings twice as often really does get
 * twice the blows, and it only does so against a clock.
 *
 * ## Nothing here reaches for the dice on its own
 *
 * The generator is passed in, exactly as it is everywhere else in `game/`: two
 * runs on one seed have to agree blow for blow, or watching a fight tells you
 * nothing you could act on. A swing costs the draws `rollAttack` costs and a
 * status costs the one `applyStatus` costs, and this adds none of its own.
 */

/** Which of the two. Named rather than indexed, so a log entry reads. */
export type Side = "a" | "b";

export const SIDES: readonly Side[] = ["a", "b"];

/** The other one. */
export function opponentOf(side: Side): Side {
  return side === "a" ? "b" : "a";
}

/** What a side is, before the fight starts. */
export type DuelSetup = {
  /**
   * The numbers this body fights with **before any status has touched them** —
   * `effectiveBattler`'s output, body and equipment already folded in.
   *
   * The base rather than the running total, on exactly the terms
   * `GameSession.baseBattlerOf` is split from `battlerOf`: `withStatusModifiers`
   * sums deltas onto a base, and feeding it its own output applies every status
   * twice.
   */
  stats: FightingStats;
};

/** One side, mid-fight. */
export type DuelFighter = {
  readonly base: FightingStats;
  hp: number;
  cooldownMs: number;
  statuses: readonly StatusInstance[];
};

/**
 * Something that happened on a tick, in the order it happened.
 *
 * A list rather than a diff of the two bodies, for the reason the wire already
 * splits health from damage: three blows in one tick leave one new total and owe
 * three events, and neither can be derived from the other. A log that showed
 * only the totals could not tell a dodge from a blow that armour ate.
 */
export type DuelEvent =
  | {
      kind: "swing";
      by: Side;
      /** What the blow came to, dodge and miss included. */
      outcome: AttackOutcome;
      /** What the defender was left with. */
      hpLeft: number;
    }
  | {
      kind: "ailment";
      on: Side;
      defId: string;
      /** Signed, as `advanceStatuses` hands it over: negative harms. */
      hp: number;
      hpLeft: number;
    }
  | { kind: "death"; side: Side };

/** Nothing happened this tick, which is most ticks in a slow fight. */
const QUIET: readonly DuelEvent[] = [];

/** Nobody has authored a status, so nothing can be inflicted. See {@link Duel}. */
const NO_STATUS_DEFS: Record<string, StatusDef> = {};

export type DuelOptions = {
  /**
   * The status catalogue, or nothing.
   *
   * **Absent means statuses are switched off entirely**, and that is a real
   * setting rather than a missing argument: a caller comparing two weapons'
   * damage curves wants the venom out of it, and — more sharply — a status
   * inflicted costs a draw, so a catalogue arriving where there was none would
   * move the dice for everything after it. `GameSession.grantStatus` already
   * returns before the draw for an id the catalogue does not hold; this is the
   * same rule with the catalogue empty.
   */
  statusDefs?: Record<string, StatusDef>;
};

/**
 * A fight in progress.
 *
 * A class rather than a reducer over a frozen state, because the caller that
 * needs this most is a render loop stepping it a tick at a time and reading the
 * two bodies between steps — and a fresh state object per tick, thirty times a
 * second, is an allocation per tick to change two numbers.
 */
export class Duel {
  readonly a: DuelFighter;
  readonly b: DuelFighter;
  /** How long the fight has run, in the sim's own clock. */
  elapsedMs = 0;

  private readonly rng: Rng;
  private readonly statusDefs: Record<string, StatusDef>;

  constructor(a: DuelSetup, b: DuelSetup, rng: Rng, options: DuelOptions = {}) {
    this.rng = rng;
    this.statusDefs = options.statusDefs ?? NO_STATUS_DEFS;
    this.a = freshFighter(a);
    this.b = freshFighter(b);
  }

  fighter(side: Side): DuelFighter {
    return side === "a" ? this.a : this.b;
  }

  /** Whether this side is still standing. Zero hit points is out, as ever. */
  alive(side: Side): boolean {
    return this.fighter(side).hp > 0;
  }

  /** Who is left, or null while both are up — or while neither is. */
  get winner(): Side | null {
    if (this.alive("a") === this.alive("b")) return null;
    return this.alive("a") ? "a" : "b";
  }

  get finished(): boolean {
    return !this.alive("a") || !this.alive("b");
  }

  /** The numbers this side is fighting with right now, statuses included. */
  statsOf(side: Side): FightingStats {
    const fighter = this.fighter(side);
    return withStatusModifiers(
      fighter.base,
      fighter.statuses,
      this.statusDefs,
      fighter.hp,
    );
  }

  /**
   * Advance one simulation tick, and say what happened.
   *
   * The tick's order is `GameSession.update`'s, and each line of it is
   * load-bearing there for a reason that holds here too: a poison that kills on
   * this tick takes its bearer off the board before they get a swing out of it,
   * and a cooldown that expires on this tick is spent on this tick.
   */
  tick(): readonly DuelEvent[] {
    if (this.finished) return QUIET;
    this.elapsedMs += TICK_MS;

    const events: DuelEvent[] = [];
    for (const side of SIDES) this.tickStatuses(side, events);
    for (const side of SIDES) this.advanceCooldown(side);
    for (const side of SIDES) this.trySwing(side, events);
    return events.length === 0 ? QUIET : events;
  }

  /**
   * Wind this side's statuses on, and pay out whatever came due.
   *
   * **One instance at a time, rather than the whole list in one call.** The
   * shared advance is indifferent to the split — it walks the list letting no
   * entry see another, and the bearer it evaluates against is snapshotted before
   * any payout lands, exactly as `GameSession.tickStatuses` snapshots it. What
   * the split buys is the one thing the flat `hpChanges` list cannot say: *which*
   * status a number came from. A log reading "-2" is a number; one reading
   * "poison -2" is the reason a fight went the way it did.
   */
  private tickStatuses(side: Side, events: DuelEvent[]) {
    const fighter = this.fighter(side);
    if (fighter.statuses.length === 0 || fighter.hp <= 0) return;

    // Read before anything is paid out, so a status that heals a share of the
    // maximum cannot compound against its own payout within one tick.
    const bearer = { hp: fighter.hp, maxHp: fighter.base.maxHp };
    const next: StatusInstance[] = [];
    const changes: { defId: string; hp: number }[] = [];

    for (const instance of fighter.statuses) {
      const tick = advanceStatuses([instance], TICK_MS, bearer, this.statusDefs);
      next.push(...tick.statuses);
      for (const hp of tick.hpChanges) changes.push({ defId: instance.defId, hp });
    }
    fighter.statuses = next;

    for (const change of changes) {
      if (change.hp === 0) continue;
      // A heal clamps at the maximum and a harm can kill, which is the whole
      // reason `advanceStatuses` hands back signed figures rather than a net.
      fighter.hp =
        change.hp < 0
          ? Math.max(0, fighter.hp + change.hp)
          : Math.min(this.statsOf(side).maxHp, fighter.hp + change.hp);
      events.push({
        kind: "ailment",
        on: side,
        defId: change.defId,
        hp: change.hp,
        hpLeft: fighter.hp,
      });
      // A body that has just died is off the board, and everything after this
      // would be arithmetic on a corpse.
      if (fighter.hp === 0) {
        events.push({ kind: "death", side });
        return;
      }
    }
  }

  private advanceCooldown(side: Side) {
    const fighter = this.fighter(side);
    if (fighter.cooldownMs > 0) {
      fighter.cooldownMs = Math.max(0, fighter.cooldownMs - TICK_MS);
    }
  }

  /**
   * One side swings, if every reason not to is absent.
   *
   * Range and line are not among the reasons, and their absence is the premise:
   * the two are a cell apart on one floor with nothing between them, which is
   * the arrangement a balance question is asked in. Everything a *world* could
   * put in the way is the world's business and not the numbers'.
   */
  private trySwing(side: Side, events: DuelEvent[]) {
    const attacker = this.fighter(side);
    const defenderSide = opponentOf(side);
    const defender = this.fighter(defenderSide);
    if (attacker.hp <= 0 || defender.hp <= 0) return;
    if (attacker.cooldownMs > 0) return;

    const attackerStats = this.statsOf(side);
    const defenderStats = this.statsOf(defenderSide);
    // Spent whether or not the blow connects: the swing happened, and a dodge
    // that cost the attacker nothing would let a fast body flail for free.
    attacker.cooldownMs = swingIntervalMs(attackerStats);

    const outcome = rollAttack(attackerStats, defenderStats, this.rng);
    defender.hp = Math.max(0, defender.hp - outcome.damage);
    events.push({ kind: "swing", by: side, outcome, hpLeft: defender.hp });

    if (defender.hp === 0) {
      events.push({ kind: "death", side: defenderSide });
      return;
    }
    // After the damage and only on a body still standing, exactly as the
    // session grants them: a status is a condition you are *in*, and a corpse is
    // not in one.
    for (const grant of outcome.inflicted) {
      const def = this.statusDefs[grant.id];
      // Before the draw, so an id the catalogue does not hold costs no dice.
      if (!def) continue;
      const range =
        grant.fromMs === undefined || grant.toMs === undefined
          ? def
          : { fromMs: grant.fromMs, toMs: grant.toMs };
      defender.statuses = applyStatus(defender.statuses, def, this.rng, range);
    }
  }
}

/**
 * A body at the start of a fight: full health, nothing running on it, and ready
 * to swing.
 *
 * Ready rather than on a first cooldown, which is what makes speed worth having
 * beyond the long-run rate — the faster of the two lands the opening blow.
 */
function freshFighter(setup: DuelSetup): DuelFighter {
  return {
    base: setup.stats,
    hp: setup.stats.maxHp,
    cooldownMs: 0,
    statuses: NO_STATUSES,
  };
}

/** What a whole fight came to. */
export type DuelResult = {
  /** Who was left standing, or null if neither ran out of hit points in time. */
  winner: Side | null;
  ticks: number;
  /** What the winner had left, as a fraction of their maximum. */
  survivorHealth: number;
};

/**
 * How long a fight may run before it is called a draw.
 *
 * Twenty thousand ticks is eleven minutes of simulated time — far past any fight
 * the game is authored for, and short enough that two immortals cannot hang a
 * loop. A bound rather than a balance figure: reaching it means the pair cannot
 * hurt each other, which is an answer in itself.
 */
export const MAX_DUEL_TICKS = 20_000;

/**
 * Run one fight to the end.
 *
 * The aggregate half of this module — what a caller asking "who wins" wants,
 * where {@link Duel} is for a caller watching it happen. Both are the same loop,
 * which is the point: a figure quoted from a fight nobody could watch, and a
 * fight that disagreed with the figures, are the two failures worth ruling out.
 */
export function runDuel(
  a: DuelSetup,
  b: DuelSetup,
  rng: Rng,
  options: DuelOptions & { maxTicks?: number } = {},
): DuelResult {
  const duel = new Duel(a, b, rng, options);
  const maxTicks = options.maxTicks ?? MAX_DUEL_TICKS;

  for (let tick = 1; tick <= maxTicks; tick++) {
    duel.tick();
    const winner = duel.winner;
    if (!winner) continue;
    const survivor = duel.fighter(winner);
    return {
      winner,
      ticks: tick,
      survivorHealth: survivor.hp / duel.statsOf(winner).maxHp,
    };
  }

  return { winner: null, ticks: maxTicks, survivorHealth: 0 };
}

import { type FightingStats, isImmune } from "../lib/battler";
import { COMBAT_STATUS_ID, type StatusDef } from "../lib/status";
import {
  type AttackOutcome,
  cappedToHealth,
  rollAttack,
  swingIntervalMs,
  swingWindupMs,
} from "./combat";
import { TICK_MS } from "./constants";
import type { Rng } from "./rng";
import {
  advanceStatuses,
  applyStatus,
  endOnDamage,
  enterCombat,
  incapacitated,
  NO_STATUSES,
  type StatusInstance,
  withStatusModifiers,
} from "./statuses";

export type Side = "a" | "b";

export const SIDES: readonly Side[] = ["a", "b"];

export function opponentOf(side: Side): Side {
  return side === "a" ? "b" : "a";
}

export type DuelSetup = {
  swings: readonly FightingStats[];
  immuneTo?: readonly string[];
};

export type DuelFighter = {
  readonly swings: readonly FightingStats[];
  readonly immuneTo: readonly string[];
  nextSwing: number;
  hp: number;
  cooldownMs: number;
  disengaged: boolean;
  statuses: readonly StatusInstance[];
};

export type DuelEvent =
  | {
      kind: "swing";
      by: Side;
      outcome: AttackOutcome;
      hpLeft: number;
    }
  | {
      kind: "ailment";
      on: Side;
      defId: string;
      hp: number;
      hpLeft: number;
    }
  | { kind: "death"; side: Side };

const QUIET: readonly DuelEvent[] = [];

const NO_STATUS_DEFS: Record<string, StatusDef> = {};

const NO_IMMUNITIES: readonly string[] = [];

export type DuelOptions = {
  statusDefs?: Record<string, StatusDef>;
};

export class Duel {
  readonly a: DuelFighter;
  readonly b: DuelFighter;
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

  alive(side: Side): boolean {
    return this.fighter(side).hp > 0;
  }

  get winner(): Side | null {
    if (this.alive("a") === this.alive("b")) return null;
    return this.alive("a") ? "a" : "b";
  }

  get finished(): boolean {
    return !this.alive("a") || !this.alive("b");
  }

  statsOf(side: Side): FightingStats {
    const fighter = this.fighter(side);
    return withStatusModifiers(this.baseOf(side), fighter.statuses, this.statusDefs, fighter.hp);
  }

  private baseOf(side: Side): FightingStats {
    const fighter = this.fighter(side);
    return fighter.swings[fighter.nextSwing % fighter.swings.length]!;
  }

  tick(): readonly DuelEvent[] {
    if (this.finished) return QUIET;
    this.elapsedMs += TICK_MS;

    const events: DuelEvent[] = [];
    for (const side of SIDES) this.tickStatuses(side, events);
    for (const side of SIDES) this.advanceCooldown(side);
    this.exchangeBlows(events);
    return events.length === 0 ? QUIET : events;
  }

  private tickStatuses(side: Side, events: DuelEvent[]) {
    const fighter = this.fighter(side);
    if (fighter.statuses.length === 0 || fighter.hp <= 0) return;

    const bearer = {
      hp: fighter.hp,
      maxHp: this.baseOf(side).maxHp,
      statuses: fighter.statuses,
    };
    const next: StatusInstance[] = [];
    const changes: { defId: string; hp: number }[] = [];

    for (const instance of fighter.statuses) {
      const tick = advanceStatuses([instance], TICK_MS, bearer, this.statusDefs);
      next.push(...tick.statuses);
      for (const change of tick.hpChanges) {
        changes.push({ defId: instance.defId, hp: change.amount });
      }
    }
    fighter.statuses = next;

    for (const change of changes) {
      if (change.hp === 0) continue;
      if (change.hp < 0) this.applyDamage(fighter, -change.hp);
      else fighter.hp = Math.min(this.statsOf(side).maxHp, fighter.hp + change.hp);
      events.push({
        kind: "ailment",
        on: side,
        defId: change.defId,
        hp: change.hp,
        hpLeft: fighter.hp,
      });
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
   * Who swings, and the stats both sides swing with, are settled before any
   * blow lands, so a killing blow never cancels one due on the same tick. The
   * dice are still rolled `a` first, so a tick with one blow draws exactly what
   * it always did.
   */
  private exchangeBlows(events: DuelEvent[]) {
    const swinging = SIDES.filter((side) => this.dueToSwing(side));
    if (swinging.length === 0) return;

    const stats: Record<Side, FightingStats> = { a: this.statsOf("a"), b: this.statsOf("b") };
    for (const side of swinging) this.swing(side, stats[side], stats[opponentOf(side)], events);
    for (const side of SIDES) {
      if (!this.alive(side)) events.push({ kind: "death", side });
    }
  }

  /**
   * `GameSession.tryAttack` drops the windup of a body that cannot act, arms a
   * fresh one when it can, and swings only once both the windup and the
   * cooldown have run out. The duel has only the cooldown, so it takes the
   * longer of the two.
   */
  private dueToSwing(side: Side): boolean {
    if (!this.alive(side) || !this.alive(opponentOf(side))) return false;
    const fighter = this.fighter(side);
    if (incapacitated(fighter.statuses, this.statusDefs)) {
      fighter.disengaged = true;
      return false;
    }
    if (fighter.disengaged) {
      fighter.disengaged = false;
      fighter.cooldownMs = Math.max(fighter.cooldownMs, swingWindupMs(this.statsOf(side)));
    }
    return fighter.cooldownMs === 0;
  }

  private swing(
    side: Side,
    attackerStats: FightingStats,
    defenderStats: FightingStats,
    events: DuelEvent[],
  ) {
    const attacker = this.fighter(side);
    const defender = this.fighter(opponentOf(side));
    attacker.nextSwing += 1;
    attacker.cooldownMs = swingIntervalMs(attackerStats);

    if (this.statusDefs[COMBAT_STATUS_ID]) {
      attacker.statuses = enterCombat(attacker.statuses);
      defender.statuses = enterCombat(defender.statuses);
    }

    const outcome = cappedToHealth(rollAttack(attackerStats, defenderStats, this.rng), defender.hp);
    this.applyDamage(defender, outcome.damage);
    events.push({ kind: "swing", by: side, outcome, hpLeft: defender.hp });

    if (defender.hp === 0) return;
    for (const grant of outcome.inflicted) {
      const def = this.statusDefs[grant.id];
      if (!def || isImmune(defender, grant.id)) continue;
      const range =
        grant.fromMs === undefined || grant.toMs === undefined
          ? def
          : { fromMs: grant.fromMs, toMs: grant.toMs };
      defender.statuses = applyStatus(defender.statuses, def, this.rng, range);
    }
  }

  private applyDamage(fighter: DuelFighter, amount: number) {
    if (amount > 0) fighter.statuses = endOnDamage(fighter.statuses, this.statusDefs);
    fighter.hp = Math.max(0, fighter.hp - amount);
  }
}

function freshFighter(setup: DuelSetup): DuelFighter {
  const first = setup.swings[0];
  if (!first) throw new Error("a duel fighter must have something to swing");
  return {
    swings: setup.swings,
    immuneTo: setup.immuneTo ?? NO_IMMUNITIES,
    nextSwing: 0,
    hp: first.maxHp,
    cooldownMs: swingWindupMs(first),
    disengaged: false,
    statuses: NO_STATUSES,
  };
}

/**
 * A null `winner` is either a draw, where both fell on the same tick, or a
 * fight still going at `maxTicks`. With `ticks` below `maxTicks` it is a draw.
 */
export type DuelResult = {
  winner: Side | null;
  ticks: number;
  survivorHealth: number;
};

export const MAX_DUEL_TICKS = 20_000;

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
    if (!duel.finished) continue;
    const winner = duel.winner;
    return {
      winner,
      ticks: tick,
      survivorHealth: winner ? duel.fighter(winner).hp / duel.statsOf(winner).maxHp : 0,
    };
  }

  return { winner: null, ticks: maxTicks, survivorHealth: 0 };
}

import type { FightingStats } from "../lib/battler";
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
  enterCombat,
  NO_STATUSES,
  type StatusInstance,
  withStatusModifiers,
} from "./statuses";
import { countDown } from "./ticks";

export type Side = "a" | "b";

export const SIDES: readonly Side[] = ["a", "b"];

export function opponentOf(side: Side): Side {
  return side === "a" ? "b" : "a";
}

export type DuelSetup = {
  swings: readonly FightingStats[];
};

export type DuelFighter = {
  readonly swings: readonly FightingStats[];
  nextSwing: number;
  hp: number;
  cooldownMs: number;
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
    for (const side of SIDES) this.trySwing(side, events);
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
      if (fighter.hp === 0) {
        events.push({ kind: "death", side });
        return;
      }
    }
  }

  private advanceCooldown(side: Side) {
    const fighter = this.fighter(side);
    if (fighter.cooldownMs > 0) {
      fighter.cooldownMs = countDown(fighter.cooldownMs, TICK_MS);
    }
  }

  private trySwing(side: Side, events: DuelEvent[]) {
    const attacker = this.fighter(side);
    const defenderSide = opponentOf(side);
    const defender = this.fighter(defenderSide);
    if (attacker.hp <= 0 || defender.hp <= 0) return;
    if (attacker.cooldownMs > 0) return;

    const attackerStats = this.statsOf(side);
    const defenderStats = this.statsOf(defenderSide);
    attacker.nextSwing += 1;
    attacker.cooldownMs = swingIntervalMs(attackerStats);

    if (this.statusDefs[COMBAT_STATUS_ID]) {
      attacker.statuses = enterCombat(attacker.statuses);
      defender.statuses = enterCombat(defender.statuses);
    }

    const outcome = cappedToHealth(rollAttack(attackerStats, defenderStats, this.rng), defender.hp);
    defender.hp -= outcome.damage;
    events.push({ kind: "swing", by: side, outcome, hpLeft: defender.hp });

    if (defender.hp === 0) {
      events.push({ kind: "death", side: defenderSide });
      return;
    }
    for (const grant of outcome.inflicted) {
      const def = this.statusDefs[grant.id];
      if (!def) continue;
      const range =
        grant.fromMs === undefined || grant.toMs === undefined
          ? def
          : { fromMs: grant.fromMs, toMs: grant.toMs };
      defender.statuses = applyStatus(defender.statuses, def, this.rng, range);
    }
  }
}

function freshFighter(setup: DuelSetup): DuelFighter {
  const first = setup.swings[0];
  if (!first) throw new Error("a duel fighter must have something to swing");
  return {
    swings: setup.swings,
    nextSwing: 0,
    hp: first.maxHp,
    cooldownMs: swingWindupMs(first),
    statuses: NO_STATUSES,
  };
}

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

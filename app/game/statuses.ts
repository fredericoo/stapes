import type { FightingStats } from "../lib/battler";
import type { Element } from "../lib/element";
import type { FormulaScope } from "../lib/formula";
import { MAX_PERCENT_STAT } from "../lib/item";
import { COMBAT_DURATION_MS, COMBAT_STATUS_ID, MODIFIER_KEYS, type StatusDef } from "../lib/status";
import type { Blame } from "./blame";
import { TICK_MS } from "./constants";
import type { Rng } from "./rng";
import { reached, TICK_SLACK_MS } from "./ticks";

export type StatusInstance = {
  defId: string;
  durationMs: number;
  remainingMs: number;
  sinceEffectMs: number;
  causedBy?: string;
  elements?: readonly Element[];
  blame?: Blame;
};

export type StatusBearer = {
  hp: number;
  maxHp: number;
  statuses: ReadonlyArray<{ defId: string }>;
};

export const NO_STATUSES: readonly StatusInstance[] = [];

export const UNKNOWN_REMAINING_MS = Number.POSITIVE_INFINITY;

export function snapToTick(everyMs: number): number {
  if (everyMs <= 0) return 0;
  /**
   * Nudged by the slack before the ceiling: `1000 / TICK_MS` computes to
   * 30.000000000000004, so an honest `ceil` would round a cadence of exactly
   * 1000ms up to 31 ticks and make every authored cadence a tick late.
   */
  return Math.max(1, Math.ceil(everyMs / TICK_MS - TICK_SLACK_MS)) * TICK_MS;
}

export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000 - TICK_SLACK_MS));
}

export function statusReading(statuses: readonly StatusInstance[]): string {
  if (statuses.length === 0) return "";
  return statuses.map((status) => `${status.defId}:${secondsLeft(status.remainingMs)}`).join("|");
}

export function rollDurationMs(range: DurationRange, rng: Rng): number {
  return range.fromMs + rng.int(range.toMs - range.fromMs + 1);
}

export type DurationRange = { fromMs: number; toMs: number };

export function applyStatus(
  current: readonly StatusInstance[],
  def: StatusDef,
  rng: Rng,
  range: DurationRange = def,
  causedBy?: string,
  elements?: readonly Element[],
  blame?: Blame,
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
        ...(causedBy ? { causedBy } : {}),
        ...(elements?.length ? { elements } : {}),
        ...(blame ? { blame } : {}),
      },
    ];
  }

  const remainingMs = def.stacks
    ? Math.min(def.maxMs, existing.remainingMs + rolled)
    : Math.max(existing.remainingMs, rolled);

  return current.map((instance) => {
    if (instance.defId !== def.id) return instance;
    const { causedBy: _wasCausedBy, elements: _wereElements, blame: _wasBlame, ...rest } = instance;
    return {
      ...rest,
      remainingMs,
      durationMs: remainingMs,
      ...(causedBy ? { causedBy } : {}),
      ...(elements?.length ? { elements } : {}),
      ...(blame ? { blame } : {}),
    };
  });
}

export function enterCombat(current: readonly StatusInstance[]): readonly StatusInstance[] {
  const fresh: StatusInstance = {
    defId: COMBAT_STATUS_ID,
    durationMs: COMBAT_DURATION_MS,
    remainingMs: COMBAT_DURATION_MS,
    sinceEffectMs: 0,
  };
  if (!inCombat(current)) return [...current, fresh];
  return current.map((instance) => (instance.defId === COMBAT_STATUS_ID ? fresh : instance));
}

export function inCombat(statuses: readonly StatusInstance[]): boolean {
  return statuses.some((instance) => instance.defId === COMBAT_STATUS_ID);
}

export type StatusHpChange = {
  amount: number;
  causedBy?: string;
  elements?: readonly Element[];
  blame?: Blame;
};

export type StatusTick = {
  statuses: readonly StatusInstance[];
  hpChanges: StatusHpChange[];
  expired: boolean;
};

/**
 * Runs three phases per status, in order: wind down the remaining time, fire
 * the periods that fell due, then drop the status if it has expired.
 */
export function advanceStatuses(
  statuses: readonly StatusInstance[],
  tickMs: number,
  bearer: StatusBearer,
  catalogue: Record<string, StatusDef>,
): StatusTick {
  if (statuses.length === 0) {
    return { statuses, hpChanges: [], expired: false };
  }

  const next: StatusInstance[] = [];
  const hpChanges: StatusHpChange[] = [];
  let expired = false;

  for (const instance of statuses) {
    const def = catalogue[instance.defId];
    if (!def) {
      expired = true;
      continue;
    }

    const remainingMs = instance.remainingMs - tickMs;
    let sinceEffectMs = instance.sinceEffectMs + tickMs;
    if (def.effects.hp) {
      const scope = scopeFor(instance, remainingMs, bearer);
      const everyMs = snapToTick(def.everyMs.evaluate(scope));
      /**
       * A `while`, not an `if`: `GameSession.update` can run several ticks in
       * one call, so a status whose cadence is shorter than the catch-up owes
       * one payout per period it accumulated, not just the last.
       */
      while (everyMs > 0 && reached(sinceEffectMs, everyMs)) {
        sinceEffectMs -= everyMs;
        hpChanges.push({
          amount: def.effects.hp.evaluate(scope),
          ...(instance.causedBy ? { causedBy: instance.causedBy } : {}),
          ...(instance.elements?.length ? { elements: instance.elements } : {}),
          ...(instance.blame ? { blame: instance.blame } : {}),
        });
      }
    }

    if (remainingMs <= TICK_SLACK_MS) {
      expired = true;
      continue;
    }

    next.push({ ...instance, remainingMs, sinceEffectMs });
  }

  return { statuses: next, hpChanges, expired };
}

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
    statuses: bearer.statuses,
  };
}

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
    const scope = scopeFor(instance, instance.remainingMs, {
      hp,
      maxHp: stats.maxHp,
      statuses,
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
  const percent = (value: number) => Math.max(0, Math.min(MAX_PERCENT_STAT, value));

  return {
    ...stats,
    maxHp: atLeast(stats.maxHp + (deltas.maxHp ?? 0), 1),
    damage: atLeast(stats.damage + (deltas.damage ?? 0), 0),
    def: atLeast(stats.def + (deltas.def ?? 0), 0),
    accuracy: percent(stats.accuracy + (deltas.accuracy ?? 0)),
    spd: percent(stats.spd + (deltas.spd ?? 0)),
    flee: atLeast(stats.flee + (deltas.flee ?? 0), 0),
  };
}

export function walkSpeedPercentFrom(
  statuses: readonly StatusInstance[],
  catalogue: Record<string, StatusDef>,
): number {
  let percent = 0;
  for (const instance of statuses) {
    percent += catalogue[instance.defId]?.walkSpeedPercent ?? 0;
  }
  return percent;
}

export function incapacitated(
  statuses: readonly StatusInstance[],
  catalogue: Record<string, StatusDef>,
): boolean {
  return statuses.some((instance) => catalogue[instance.defId]?.incapacitates === true);
}

export function endOnDamage(
  statuses: readonly StatusInstance[],
  catalogue: Record<string, StatusDef>,
): readonly StatusInstance[] {
  if (!statuses.some((instance) => catalogue[instance.defId]?.endsOnDamage === true)) {
    return statuses;
  }
  return statuses.filter((instance) => catalogue[instance.defId]?.endsOnDamage !== true);
}

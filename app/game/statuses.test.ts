import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import {
  COMBAT_DURATION_MS,
  COMBAT_STATUS,
  COMBAT_STATUS_ID,
  resolveStatus,
  type StatusDef,
  statusesById,
} from "../lib/status";
import { TICK_MS } from "./constants";
import { Rng } from "./rng";
import {
  advanceStatuses,
  applyStatus,
  endOnDamage,
  enterCombat,
  incapacitated,
  inCombat,
  rollDurationMs,
  snapToTick,
  type StatusInstance,
  walkSpeedPercentFrom,
  withStatusModifiers,
} from "./statuses";
import { DEFAULT_BATTLER, fightingStats } from "../lib/battler";
import { DEFAULT_WEAPON } from "../lib/item";

/** Authored the way `data/statuses.json` is, so the schema is under test too. */
function status(over: Record<string, unknown> = {}): StatusDef {
  const def = resolveStatus({
    id: "fed",
    name: "Fed",
    description: "Slowly recovering health.",
    tone: "good",
    icon: { tilesetId: "ultima-vi", rect: { x: 48, y: 20, w: 1, h: 1 } },
    fromMs: 10_000,
    toMs: 30_000,
    stacks: true,
    maxMs: 3_600_000,
    everyMs: "ceil(MAX_HP / 100) * 300000 / MAX_HP / (2 - has_status('combat'))",
    effects: { hp: "ceil(MAX_HP / 100)" },
    ...over,
  });
  if (!def) throw new Error("fixture did not resolve");
  return def;
}

function catalogue(...defs: StatusDef[]): Record<string, StatusDef> {
  return Object.fromEntries(defs.map((def) => [def.id, def]));
}

/** In a fight, which is Fed's slower cadence. */
const IN_COMBAT = [{ defId: COMBAT_STATUS_ID }];

const BEARER = { hp: 8, maxHp: 16, statuses: IN_COMBAT };

/** Run whole seconds of ticks, threading the list through. */
function runSeconds(
  statuses: readonly StatusInstance[],
  seconds: number,
  defs: Record<string, StatusDef>,
  bearer = BEARER,
) {
  let current = statuses;
  const hpChanges: number[] = [];
  for (let i = 0; i < seconds * (1000 / TICK_MS); i++) {
    const tick = advanceStatuses(current, TICK_MS, bearer, defs);
    current = tick.statuses;
    hpChanges.push(...tick.hpChanges.map((change) => change.amount));
  }
  return { statuses: current, hpChanges };
}

describe("rolling a duration", () => {
  /**
   * Exactly one draw whatever the range, on the same terms a swing's three are:
   * a draw count that varied with what an author typed would change what every
   * creature in the world rolled after it.
   */
  it("costs one draw even when both ends are equal", () => {
    const fixed = status({ fromMs: 5_000, toMs: 5_000 });
    const a = new Rng(1);
    const b = new Rng(1);
    expect(rollDurationMs(fixed, a)).toBe(5_000);
    b.int(1);
    expect(a.next()).toBe(b.next());
  });

  it("stays inside the authored range", () => {
    const def = status({ fromMs: 10_000, toMs: 30_000 });
    const rng = new Rng(7);
    for (let i = 0; i < 200; i++) {
      const rolled = rollDurationMs(def, rng);
      expect(rolled).toBeGreaterThanOrEqual(10_000);
      expect(rolled).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("applying and stacking", () => {
  it("adds a status that is not there", () => {
    const next = applyStatus([], status(), new Rng(1));
    expect(next).toHaveLength(1);
    expect(next[0]!.defId).toBe("fed");
    expect(next[0]!.remainingMs).toBe(next[0]!.durationMs);
  });

  it("adds to what is left when it stacks, and clamps at the ceiling", () => {
    const def = status({ fromMs: 30_000, toMs: 30_000, maxMs: 50_000 });
    const rng = new Rng(1);
    let held = applyStatus([], def, rng);
    held = applyStatus(held, def, rng);
    expect(held[0]!.remainingMs).toBe(50_000);
    // And it stays there rather than creeping past.
    held = applyStatus(held, def, rng);
    expect(held[0]!.remainingMs).toBe(50_000);
  });

  /** A bad roll must never shorten something you already have. */
  it("refreshes to the longer of the two when it does not stack", () => {
    const long = status({ stacks: false, fromMs: 30_000, toMs: 30_000 });
    const short = status({ stacks: false, fromMs: 5_000, toMs: 5_000 });
    const rng = new Rng(1);
    const held = applyStatus(applyStatus([], long, rng), short, rng);
    expect(held).toHaveLength(1);
    expect(held[0]!.remainingMs).toBe(30_000);
  });

  it("never mutates the list it was given", () => {
    const before = applyStatus([], status(), new Rng(1));
    const snapshot = structuredClone(before);
    applyStatus(before, status(), new Rng(2));
    expect(before).toEqual(snapshot);
  });
});

describe("cadence", () => {
  it("snaps a cadence up to a whole number of ticks", () => {
    expect(snapToTick(1_000)).toBeCloseTo(1_000);
    expect(snapToTick(0)).toBe(0);
    // 1010ms is 30.3 ticks, so it becomes 31 — never 30, which would fire early.
    expect(snapToTick(1_010)).toBeCloseTo(31 * TICK_MS);
    expect(snapToTick(1_010) % TICK_MS).toBeCloseTo(0);
  });

  /** Thirty seconds at a one-second cadence owes thirty payouts, not twenty-nine. */
  it("pays out once per period for the whole life of a status", () => {
    const def = status({ fromMs: 30_000, toMs: 30_000, everyMs: 1_000 });
    const held = applyStatus([], def, new Rng(1));
    const { statuses, hpChanges } = runSeconds(held, 30, catalogue(def));
    expect(hpChanges).toHaveLength(30);
    expect(statuses).toHaveLength(0);
  });

  it("owes every period a catch-up tick skipped over", () => {
    const def = status({ fromMs: 30_000, toMs: 30_000, everyMs: 1_000 });
    const held = applyStatus([], def, new Rng(1));
    // One ten-second tick, the shape `update`'s catch-up produces.
    const tick = advanceStatuses(held, 10_000, BEARER, catalogue(def));
    expect(tick.hpChanges).toHaveLength(10);
  });

  it("fires nothing for a status with no cadence", () => {
    const def = status({ everyMs: 0, fromMs: 5_000, toMs: 5_000 });
    const held = applyStatus([], def, new Rng(1));
    expect(runSeconds(held, 5, catalogue(def)).hpChanges).toEqual([]);
  });
});

describe("the effect itself", () => {
  it("keeps a harm signed rather than netting it away", () => {
    const poison = status({
      id: "poisoned",
      tone: "bad",
      fromMs: 2_000,
      toMs: 2_000,
      everyMs: 1_000,
      effects: { hp: "0 - ELAPSED_SEC" },
    });
    const held = applyStatus([], poison, new Rng(1));
    expect(runSeconds(held, 2, catalogue(poison)).hpChanges).toEqual([-1, -2]);
  });
});

/** A scope for a cadence that reads nothing. */
const ANY_SCOPE = {
  DURATION_SEC: 0,
  REMAINING_SEC: 0,
  ELAPSED_SEC: 0,
  MAX_HP: 0,
  HP: 0,
  statuses: [],
};

/**
 * A cadence is a formula over the body — see `StatusDef.everyMs`. Fed pays a
 * whole point a period and sets the period from the maximum, so a full heal
 * takes three hundred seconds on every body: a small body's ticks are further
 * apart rather than smaller, since a hit point cannot be.
 */
describe("a cadence set by the body", () => {
  // Longer than the full heal, so the last period of a body whose share does
  // not divide the tick lands inside the status rather than a tick after it.
  const fed = status({ fromMs: 320_000, toMs: 320_000 });

  it("heals one every three seconds on a hundred-point body", () => {
    const held = applyStatus([], fed, new Rng(1));
    const bearer = { hp: 10, maxHp: 100, statuses: IN_COMBAT };
    expect(runSeconds(held, 9, catalogue(fed), bearer).hpChanges).toEqual([1, 1, 1]);
  });

  it("heals three every three seconds on a three-hundred-point body", () => {
    const held = applyStatus([], fed, new Rng(1));
    const bearer = { hp: 10, maxHp: 300, statuses: IN_COMBAT };
    expect(runSeconds(held, 9, catalogue(fed), bearer).hpChanges).toEqual([3, 3, 3]);
  });

  it("heals one every six seconds on a fifty-point body", () => {
    const held = applyStatus([], fed, new Rng(1));
    const bearer = { hp: 10, maxHp: 50, statuses: IN_COMBAT };
    const after = runSeconds(held, 12, catalogue(fed), bearer);
    expect(after.hpChanges).toEqual([1, 1]);
    // And nothing between: the period is longer, not the point smaller.
    expect(runSeconds(held, 5, catalogue(fed), bearer).hpChanges).toEqual([]);
  });

  it("owes every period a catch-up tick skipped over, at the body's cadence", () => {
    const held = applyStatus([], fed, new Rng(1));
    const bearer = { hp: 10, maxHp: 50, statuses: IN_COMBAT };
    // One fourteen-second tick: two six-second periods and change.
    const tick = advanceStatuses(held, 14_000, bearer, catalogue(fed));
    expect(tick.hpChanges.map((change) => change.amount)).toEqual([1, 1]);
    expect(tick.statuses[0]!.sinceEffectMs).toBeCloseTo(2_000);
  });

  /**
   * The whole point of the rule, on bodies of every size. Full between 290
   * and 305 seconds rather than at 300 exactly, because a period is snapped up
   * to whole ticks and a body whose share does not divide it is paid one share
   * over at the end — both of which the clamp absorbs.
   */
  it("heals any body in full in about three hundred seconds", () => {
    for (const maxHp of [7, 16, 50, 70, 100, 150, 185, 300]) {
      const bearer = { hp: 0, maxHp, statuses: IN_COMBAT };
      const healedBy = (seconds: number) => {
        const held = applyStatus([], fed, new Rng(1));
        const paid = runSeconds(held, seconds, catalogue(fed), bearer);
        return paid.hpChanges.reduce((hp, amount) => Math.min(maxHp, hp + amount), 0);
      };
      expect(healedBy(290)).toBeLessThan(maxHp);
      expect(healedBy(305)).toBe(maxHp);
    }
  });

  /** Out of a fight the same body is paid twice as often. */
  it("halves the period out of combat", () => {
    const held = applyStatus([], fed, new Rng(1));
    const calm = { hp: 10, maxHp: 100, statuses: [] };
    expect(runSeconds(held, 6, catalogue(fed), calm).hpChanges).toEqual([1, 1, 1, 1]);
    const fighting = { hp: 10, maxHp: 100, statuses: IN_COMBAT };
    expect(runSeconds(held, 6, catalogue(fed), fighting).hpChanges).toEqual([1, 1]);
  });

  /**
   * The list a formula reads is the bearer's, not the one being advanced: a
   * duel advances one instance at a time, and the flag is beside it.
   */
  it("reads the combat flag off the bearer, not the list being advanced", () => {
    const [instance] = applyStatus([], fed, new Rng(1));
    const bearer = { hp: 10, maxHp: 100, statuses: IN_COMBAT };
    const tick = advanceStatuses([instance!], 3_000, bearer, catalogue(fed));
    expect(tick.hpChanges.map((change) => change.amount)).toEqual([1]);
    const calm = { hp: 10, maxHp: 100, statuses: [] };
    const faster = advanceStatuses([instance!], 3_000, calm, catalogue(fed));
    expect(faster.hpChanges.map((change) => change.amount)).toEqual([1, 1]);
  });

  it("reads a number as a constant cadence", () => {
    const def = status({ everyMs: 5_000 });
    expect(def.everyMs.evaluate(ANY_SCOPE)).toBe(5_000);
    expect(def.everyMs.source).toBe("5000");
  });

  it("fires nothing when the formula comes to zero or less", () => {
    const def = status({
      fromMs: 10_000,
      toMs: 10_000,
      everyMs: "MAX_HP - 100",
      effects: { hp: "1" },
    });
    const held = applyStatus([], def, new Rng(1));
    expect(
      runSeconds(held, 10, catalogue(def), { hp: 1, maxHp: 50, statuses: IN_COMBAT }).hpChanges,
    ).toEqual([]);
  });

  it("drops a status whose cadence is not a formula", () => {
    expect(() => status({ everyMs: "every so often" })).toThrow();
  });
});

/**
 * The authored poison, or a named failure rather than a null two lines later.
 *
 * A function rather than a `const` and a guard beside it, because a guard only
 * narrows the scope it stands in: the helpers below close over the result, and
 * a closure does not inherit what was proved outside it. A declared return type
 * is what carries the proof across that boundary.
 */
function authoredPoison(): StatusDef {
  const def = resolveStatus(statusesJson.find((entry) => entry.id === "poison"));
  if (!def) throw new Error("authored poison did not resolve");
  return def;
}

/**
 * Poison as it sits in `data/statuses.json`: remaining time is the dose, five
 * at the ten-minute ceiling and one as it runs out, paid every five seconds.
 */
describe("poison, as authored", () => {
  const def = authoredPoison();

  const TEN_MIN = 600_000;

  function bite(remainingSec: number): number {
    return def.effects.hp!.evaluate({
      DURATION_SEC: 600,
      REMAINING_SEC: remainingSec,
      ELAPSED_SEC: Math.max(0, 600 - remainingSec),
      MAX_HP: 16,
      HP: 16,
      statuses: [],
    });
  }

  it("stacks up to ten minutes and ticks every five seconds", () => {
    expect(def.stacks).toBe(true);
    expect(def.maxMs).toBe(TEN_MIN);
    expect(def.everyMs.evaluate(ANY_SCOPE)).toBe(5_000);
  });

  it("bites five at ten minutes left, one as it runs out", () => {
    expect(bite(600)).toBe(-5);
    expect(bite(481)).toBe(-5);
    expect(bite(480)).toBe(-4);
    expect(bite(120)).toBe(-1);
    expect(bite(1)).toBe(-1);
  });

  it("pays out once per five seconds for the whole life of a dose", () => {
    const held = applyStatus([], def, new Rng(1), {
      fromMs: 10_000,
      toMs: 10_000,
    });
    const { statuses, hpChanges } = runSeconds(held, 10, catalogue(def));
    expect(hpChanges).toEqual([-1, -1]);
    expect(statuses).toHaveLength(0);
  });
});

describe("expiry", () => {
  it("drops a status whose def has left the catalogue", () => {
    const held = applyStatus([], status(), new Rng(1));
    const tick = advanceStatuses(held, TICK_MS, BEARER, {});
    expect(tick.statuses).toHaveLength(0);
    expect(tick.expired).toBe(true);
  });

  /**
   * The countdown is the point, and an identity optimisation on a "nothing
   * notable happened" tick throws it away — which is exactly what the first
   * version of this did, silently, until the payout tests went to zero.
   */
  it("advances the clock on a tick where nothing else happened", () => {
    const def = status({ everyMs: 0, fromMs: 10_000, toMs: 10_000 });
    const held = applyStatus([], def, new Rng(1));
    const tick = advanceStatuses(held, TICK_MS, BEARER, catalogue(def));
    expect(tick.expired).toBe(false);
    expect(tick.statuses[0]!.remainingMs).toBeCloseTo(10_000 - TICK_MS);
  });

  it("costs nothing at all when there is nothing on the body", () => {
    const tick = advanceStatuses([], TICK_MS, BEARER, {});
    expect(tick.expired).toBe(false);
    expect(tick.statuses).toEqual([]);
    expect(tick.hpChanges).toEqual([]);
  });
});

describe("modifiers", () => {
  const base = fightingStats(DEFAULT_BATTLER, DEFAULT_WEAPON);

  it("leaves the stats alone, by identity, when nothing applies", () => {
    expect(withStatusModifiers(base, [], {}, 8)).toBe(base);
  });

  it("sums across two statuses", () => {
    const a = status({ id: "a", effects: {}, modifiers: { def: "2" } });
    const b = status({ id: "b", effects: {}, modifiers: { def: "3" } });
    const rng = new Rng(1);
    const held = applyStatus(applyStatus([], a, rng), b, rng);
    const out = withStatusModifiers(base, held, catalogue(a, b), 8);
    expect(out.def).toBe(base.def + 5);
  });

  it("holds a percent stat inside its band", () => {
    const def = status({ id: "sure", effects: {}, modifiers: { accuracy: "500" } });
    const held = applyStatus([], def, new Rng(1));
    expect(withStatusModifiers(base, held, catalogue(def), 8).accuracy).toBe(100);
  });

  it("never lets a maximum reach zero", () => {
    const def = status({ id: "frail", effects: {}, modifiers: { maxHp: "0 - 999" } });
    const held = applyStatus([], def, new Rng(1));
    expect(withStatusModifiers(base, held, catalogue(def), 8).maxHp).toBe(1);
  });

  /**
   * `MAX_HP` is the figure *before* any status touched it. Reading the running
   * total would let a status that raises the maximum and heals a share of it
   * compound against itself.
   */
  it("reads MAX_HP unmodified even while modifying it", () => {
    const def = status({
      id: "hardy",
      effects: {},
      modifiers: { maxHp: "MAX_HP", damage: "MAX_HP" },
    });
    const held = applyStatus([], def, new Rng(1));
    const out = withStatusModifiers(base, held, catalogue(def), 8);
    expect(out.maxHp).toBe(base.maxHp * 2);
    expect(out.damage).toBe(base.damage + base.maxHp);
  });
});

describe("walking pace", () => {
  it("is untouched by a status that says nothing about it", () => {
    const def = status({ id: "quiet", effects: {} });
    const held = applyStatus([], def, new Rng(1));
    expect(walkSpeedPercentFrom(held, catalogue(def))).toBe(0);
  });

  it("sums across two, so two chills are twice one", () => {
    const a = status({ id: "a", effects: {}, walkSpeedPercent: -30 });
    const b = status({ id: "b", effects: {}, walkSpeedPercent: -30 });
    const rng = new Rng(1);
    const held = applyStatus(applyStatus([], a, rng), b, rng);
    expect(walkSpeedPercentFrom(held, catalogue(a, b))).toBe(-60);
  });

  /**
   * On the terms every other reference to a catalogue is under: content moved
   * on, and a body under something nobody authors any more walks normally
   * rather than not at all.
   */
  it("reads a status the catalogue no longer holds as no change", () => {
    const def = status({ id: "gone", effects: {}, walkSpeedPercent: -50 });
    const held = applyStatus([], def, new Rng(1));
    expect(walkSpeedPercentFrom(held, {})).toBe(0);
  });

  /**
   * The sum is left unclamped here on purpose — the ground has not had its say
   * yet. @see `../lib/walkSpeed`
   */
  it("hands the raw total on, out of band and all", () => {
    const tar = status({ id: "tar", effects: {}, walkSpeedPercent: -90 });
    const chill = status({ id: "chill", effects: {}, walkSpeedPercent: -90 });
    const rng = new Rng(1);
    const held = applyStatus(applyStatus([], tar, rng), chill, rng);
    expect(walkSpeedPercentFrom(held, catalogue(tar, chill))).toBe(-180);
  });
});

describe("the combat flag", () => {
  it("starts at the full minute", () => {
    expect(enterCombat([])).toEqual([
      {
        defId: COMBAT_STATUS_ID,
        durationMs: COMBAT_DURATION_MS,
        remainingMs: COMBAT_DURATION_MS,
        sinceEffectMs: 0,
      },
    ]);
  });

  it("starts the minute again rather than adding a second one", () => {
    const nearlyOver = enterCombat([]).map((s) => ({ ...s, remainingMs: 1 }));
    const again = enterCombat(nearlyOver);
    expect(again).toHaveLength(1);
    expect(again[0]!.remainingMs).toBe(COMBAT_DURATION_MS);
  });

  it("leaves every other status exactly as it was", () => {
    const fed = applyStatus([], status(), new Rng(1));
    const flagged = enterCombat(fed);
    expect(flagged[0]).toBe(fed[0]);
    expect(inCombat(fed)).toBe(false);
    expect(inCombat(flagged)).toBe(true);
  });

  it("runs out on the tick clock like any other status", () => {
    const out = advanceStatuses(
      enterCombat([]),
      COMBAT_DURATION_MS,
      { hp: 10, maxHp: 10, statuses: IN_COMBAT },
      statusesById([]),
    );
    expect(out.statuses).toEqual([]);
    expect(out.expired).toBe(true);
  });

  it("is in every catalogue, whatever was authored under its id", () => {
    expect(statusesById([])[COMBAT_STATUS_ID]).toBe(COMBAT_STATUS);
    const impostor = {
      id: COMBAT_STATUS_ID,
      name: "Impostor",
      description: "Authored over the engine's own.",
      tone: "good",
      fromMs: 1000,
      toMs: 1000,
    };
    expect(statusesById([impostor])[COMBAT_STATUS_ID]).toBe(COMBAT_STATUS);
  });
});

describe("incapacitating, and ending on damage", () => {
  const sleep = status({
    id: "sleep",
    stacks: false,
    maxMs: 30_000,
    incapacitates: true,
    endsOnDamage: true,
  });
  const fed = status();
  const defs = catalogue(sleep, fed);
  const rng = new Rng(1);

  it("defaults both off, so every status authored before them means what it did", () => {
    expect(fed.incapacitates).toBe(false);
    expect(fed.endsOnDamage).toBe(false);
  });

  it("holds a body still only while something on it says so", () => {
    const fedOnly = applyStatus([], fed, rng);
    expect(incapacitated(fedOnly, defs)).toBe(false);
    expect(incapacitated(applyStatus(fedOnly, sleep, rng), defs)).toBe(true);
  });

  it("ignores an id the catalogue has lost", () => {
    expect(incapacitated([{ defId: "sleep" } as StatusInstance], catalogue(fed))).toBe(false);
  });

  it("takes off only what ends on damage", () => {
    const both = applyStatus(applyStatus([], fed, rng), sleep, rng);
    expect(endOnDamage(both, defs).map((instance) => instance.defId)).toEqual(["fed"]);
  });

  it("hands back the same list when nothing on it ends on damage", () => {
    const fedOnly = applyStatus([], fed, rng);
    expect(endOnDamage(fedOnly, defs)).toBe(fedOnly);
  });
});

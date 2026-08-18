import { describe, expect, it } from "vitest";
import { resolveStatus, type StatusDef } from "../lib/status";
import { TICK_MS } from "./constants";
import { Rng } from "./rng";
import {
  advanceStatuses,
  applyStatus,
  rollDurationMs,
  snapToTick,
  type StatusInstance,
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
    iconTileId: "berry",
    fromMs: 10_000,
    toMs: 30_000,
    stacks: true,
    maxMs: 3_600_000,
    everyMs: 1_000,
    effects: { hp: "ceil(MAX_HP / 100)" },
    ...over,
  });
  if (!def) throw new Error("fixture did not resolve");
  return def;
}

function catalogue(...defs: StatusDef[]): Record<string, StatusDef> {
  return Object.fromEntries(defs.map((def) => [def.id, def]));
}

const BEARER = { hp: 8, maxHp: 16 };

/** Run whole seconds of ticks, threading the list through. */
function runSeconds(
  statuses: readonly StatusInstance[],
  seconds: number,
  defs: Record<string, StatusDef>,
) {
  let current = statuses;
  const hpChanges: number[] = [];
  for (let i = 0; i < seconds * (1000 / TICK_MS); i++) {
    const tick = advanceStatuses(current, TICK_MS, BEARER, defs);
    current = tick.statuses;
    hpChanges.push(...tick.hpChanges);
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
    const def = status({ fromMs: 30_000, toMs: 30_000 });
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
  /**
   * The berry, exactly as authored. `ceil` is what makes it a whole point on a
   * body whose maximum is nowhere near a hundred.
   */
  it("heals one a second on a sixteen-point body", () => {
    const def = status({ fromMs: 3_000, toMs: 3_000 });
    const held = applyStatus([], def, new Rng(1));
    expect(runSeconds(held, 3, catalogue(def)).hpChanges).toEqual([1, 1, 1]);
  });

  it("keeps a harm signed rather than netting it away", () => {
    const poison = status({
      id: "poisoned",
      tone: "bad",
      fromMs: 2_000,
      toMs: 2_000,
      effects: { hp: "0 - ELAPSED_SEC" },
    });
    const held = applyStatus([], poison, new Rng(1));
    expect(runSeconds(held, 2, catalogue(poison)).hpChanges).toEqual([-1, -2]);
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

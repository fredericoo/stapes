import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";
import { accuracyCostOf, applyWeaponStats, speedCostOf } from "./equipment";

const base: BattlerDef = {
  maxHp: 20,
  atk: 5,
  def: 1,
  acc: 50,
  flee: 20,
  spd: 40,
};

describe("weight costs", () => {
  it("spends speed at full rate", () => {
    expect(speedCostOf(10)).toBe(10);
  });

  it("spends accuracy at half rate", () => {
    expect(accuracyCostOf(10)).toBe(5);
  });

  it("rounds a half point rather than leaking a fraction into a stat", () => {
    expect(accuracyCostOf(5)).toBe(3);
    expect(Number.isInteger(accuracyCostOf(7))).toBe(true);
  });

  it("costs nothing at zero", () => {
    expect(speedCostOf(0)).toBe(0);
    expect(accuracyCostOf(0)).toBe(0);
  });

  it("treats a negative weight as free rather than as a bonus", () => {
    expect(speedCostOf(-20)).toBe(0);
    expect(accuracyCostOf(-20)).toBe(0);
  });
});

describe("applyWeaponStats", () => {
  it("is the base stats with no weapon", () => {
    expect(applyWeaponStats(base, null)).toEqual(base);
  });

  it("adds attack and defence", () => {
    const out = applyWeaponStats(base, { atk: 3, def: 2, weight: 0 });
    expect(out.atk).toBe(8);
    expect(out.def).toBe(3);
  });

  it("takes weight off speed and accuracy asymmetrically", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, weight: 10 });
    expect(out.spd).toBe(30);
    expect(out.acc).toBe(45);
  });

  it("leaves max hp and flee alone", () => {
    const out = applyWeaponStats(base, { atk: 9, def: 9, weight: 30 });
    expect(out.maxHp).toBe(base.maxHp);
    expect(out.flee).toBe(base.flee);
  });

  it("clamps the percent stats at the floor rather than going negative", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, weight: 100 });
    expect(out.spd).toBe(MIN_PERCENT_STAT);
    expect(out.acc).toBe(MIN_PERCENT_STAT);
  });

  it("leaves attack and defence unbounded above, unlike the percent stats", () => {
    const out = applyWeaponStats(
      { ...base, acc: MAX_PERCENT_STAT },
      { atk: 500, def: 500, weight: 0 },
    );
    expect(out.atk).toBe(505);
    expect(out.acc).toBe(MAX_PERCENT_STAT);
  });

  it("does not mutate the base stats", () => {
    const snapshot = { ...base };
    applyWeaponStats(base, { atk: 3, def: 2, weight: 10 });
    expect(base).toEqual(snapshot);
  });
});

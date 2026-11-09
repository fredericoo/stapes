import { describe, expect, it } from "vitest";
import type { DamageNumber } from "../game/GameSession";
import { HIT_FLASH_FRAMES, HIT_FLASH_STALE_MS, HitFlash } from "./hitFlash";

function receipt(overrides: Partial<DamageNumber> = {}): DamageNumber {
  return {
    id: "hit-1",
    targetId: "rat",
    outcome: "hit",
    amount: 3,
    x: 0,
    y: 0,
    z: 0,
    stackIndex: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function framesLit(flash: HitFlash, damage: DamageNumber[], frames: number): number {
  let lit = 0;
  for (let i = 0; i < frames; i++) if (flash.frame(damage).has("rat")) lit++;
  return lit;
}

describe("hit flash", () => {
  it("lights the struck body for its frames once, though the receipt stays live longer", () => {
    expect(framesLit(new HitFlash(), [receipt()], HIT_FLASH_FRAMES + 10)).toBe(HIT_FLASH_FRAMES);
  });

  it("does not light a body for a blow that took nothing", () => {
    const damage = [
      receipt({ id: "a", outcome: "miss", amount: 0 }),
      receipt({ id: "b", outcome: "resisted", amount: 0 }),
      receipt({ id: "c", outcome: "hit", amount: 0 }),
      receipt({ id: "d", outcome: "heal", amount: 4 }),
    ];
    expect(framesLit(new HitFlash(), damage, 5)).toBe(0);
  });

  it("does not light a body for a receipt already old when first seen", () => {
    expect(framesLit(new HitFlash(), [receipt({ elapsedMs: HIT_FLASH_STALE_MS })], 5)).toBe(0);
  });
});

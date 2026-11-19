import { describe, expect, it } from "vitest";
import type { SlotRef } from "../game/itemMoves";
import { countForModifiers, releaseTo } from "./useItemDrag";

const BAG: SlotRef = { kind: "contents", index: 0 };
const HAND: SlotRef = { kind: "weapon" };
const POINT = { x: 10, y: 20 };

describe("where a release goes", () => {
  it("sends a lit square the move it lit up for", () => {
    expect(releaseTo(HAND, HAND, POINT)).toEqual({ kind: "slot", to: HAND });
  });

  it("sends a square that did not light up, so the session can answer", () => {
    expect(releaseTo(null, BAG, POINT)).toEqual({ kind: "slot", to: BAG });
  });

  it("prefers the lit square when the two disagree", () => {
    expect(releaseTo(HAND, BAG, POINT)).toEqual({ kind: "slot", to: HAND });
  });

  it("falls through to the world when the pointer is over no square", () => {
    expect(releaseTo(null, null, POINT)).toEqual({ kind: "world" });
  });

  it("does nothing when there is no position to release at", () => {
    expect(releaseTo(null, null, null)).toEqual({ kind: "nothing" });
  });
});

describe("how many of a pile a drag carries", () => {
  const PILE = { id: "itm_a", tileId: "bone", count: 5 };
  const NO_KEYS = { shiftKey: false, altKey: false };

  it("carries the whole pile with no key held", () => {
    expect(countForModifiers(PILE, NO_KEYS)).toBeUndefined();
  });

  it("carries one with Shift and half, rounded down, with Alt", () => {
    expect(countForModifiers(PILE, { ...NO_KEYS, shiftKey: true })).toBe(1);
    expect(countForModifiers(PILE, { ...NO_KEYS, altKey: true })).toBe(2);
  });

  it("carries a single thing whole whatever is held", () => {
    expect(
      countForModifiers({ id: "itm_b", tileId: "bone" }, { shiftKey: true, altKey: true }),
    ).toBeUndefined();
  });
});

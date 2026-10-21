import { describe, expect, it } from "vitest";
import type { Castability, CastRefusal } from "../game/casting";
import { castTimeNote, cooldownShare, spellAppearance } from "./SpellBar";

const press = (castability: Castability, approach = false) => ({ castability, approach });

describe("spellAppearance", () => {
  it("draws a castable stone ready", () => {
    expect(spellAppearance(press({ ok: true }))).toBe("ready");
  });

  it("draws a cooling stone as cooling, since the ring is the point of it", () => {
    expect(spellAppearance(press({ ok: false, reason: "cooling" }))).toBe("cooling");
  });

  it("draws a stone with nobody targeted ready, because the stone is fine", () => {
    expect(spellAppearance(press({ ok: false, reason: "noTarget" }))).toBe("ready");
  });

  it("draws the stone being cast as casting, since pressing it stops the cast", () => {
    expect(spellAppearance(press({ ok: false, reason: "underway" }))).toBe("casting");
  });

  it("draws an out-of-range stone ready when a walk reaches range, since pressing it walks there", () => {
    expect(spellAppearance(press({ ok: false, reason: "outOfRange" }, true))).toBe("ready");
  });

  it.each<CastRefusal>(["empty", "casting", "mastery", "outOfRange", "blocked"])(
    "collapses %s into one unavailable appearance",
    (reason) => {
      expect(spellAppearance(press({ ok: false, reason }))).toBe("unavailable");
    },
  );
});

describe("cooldownShare", () => {
  const TOTAL_MS = 5600;

  it("is the whole ring for a stone just cast", () => {
    expect(cooldownShare(TOTAL_MS, TOTAL_MS)).toBe(1);
  });

  it("is the remaining fraction part-way through", () => {
    expect(cooldownShare(1400, TOTAL_MS)).toBe(0.25);
  });

  it("stops at empty rather than running backwards past the last step", () => {
    expect(cooldownShare(-400, TOTAL_MS)).toBe(0);
  });

  it("never draws more than a whole ring", () => {
    expect(cooldownShare(TOTAL_MS * 2, TOTAL_MS)).toBe(1);
  });

  it("draws nothing for a stone with no cooldown to divide by", () => {
    expect(cooldownShare(1000, 0)).toBe(0);
  });
});

describe("castTimeNote", () => {
  it("says nothing for an instant stone, which is nearly all of them", () => {
    expect(castTimeNote(0)).toBe("");
  });

  it("reads a whole cast in seconds", () => {
    expect(castTimeNote(3_000)).toBe("3s to cast");
  });

  it("keeps a tenth of a second, and no more", () => {
    expect(castTimeNote(1_500)).toBe("1.5s to cast");
    expect(castTimeNote(1_530)).toBe("1.5s to cast");
  });
});

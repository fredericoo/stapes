import { describe, expect, it } from "vitest";
import { causeOfDeath, possessive } from "./blame";

/**
 * How a death is written down.
 *
 * The strings themselves, because they are what a player reads off a skull and
 * there is nowhere downstream that could put them right: the line is stored on
 * the placement as an ordinary description, and no renderer knows a skull from
 * a crate.
 */

describe("causeOfDeath", () => {
  it("names what did it and who is answerable", () => {
    expect(causeOfDeath({ source: "Fangs", by: "Wolf" })).toBe(
      "Cause of death: Fangs by Wolf",
    );
  });

  /**
   * Plenty of harms have nobody behind them — a hearth somebody built a year
   * ago, a berry that turned — and the line has to read as a sentence rather
   * than trail off into an attribution that is not there.
   */
  it("says only what did it when nothing is answerable", () => {
    expect(causeOfDeath({ source: "Burned" })).toBe("Cause of death: Burned");
  });
});

describe("possessive", () => {
  /**
   * What makes a conjured flame read as the caster's doing while the hearth in
   * the tavern stays nobody's. The same tile is both.
   */
  it("joins an owner to the thing, or leaves the thing alone", () => {
    expect(possessive("Green Fox", "Arcane Flame")).toBe(
      "Green Fox's Arcane Flame",
    );
    expect(possessive(null, "Hearth")).toBe("Hearth");
  });
});

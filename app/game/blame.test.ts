import { describe, expect, it } from "vitest";
import { causeOfDeath, possessive } from "./blame";

describe("causeOfDeath", () => {
  it("names what did it and who is answerable", () => {
    expect(causeOfDeath({ source: "Fangs", by: "Wolf" })).toBe("Cause of death: Fangs by Wolf");
  });

  it("says only what did it when nothing is answerable", () => {
    expect(causeOfDeath({ source: "Burned" })).toBe("Cause of death: Burned");
  });
});

describe("possessive", () => {
  it("joins an owner to the thing, or leaves the thing alone", () => {
    expect(possessive("Green Fox", "Arcane Flame")).toBe("Green Fox's Arcane Flame");
    expect(possessive(null, "Hearth")).toBe("Hearth");
  });
});

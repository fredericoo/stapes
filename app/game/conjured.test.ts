import { describe, expect, it } from "vitest";
import { constantFormula } from "../lib/formula";
import { DEFAULT_STATUS_SOURCE } from "../lib/status";
import type { StatusDef, StatusTone } from "../lib/status";
import { conjuredName, sparesStander } from "./conjured";

function status(tone: StatusTone): StatusDef {
  return {
    ...DEFAULT_STATUS_SOURCE,
    everyMs: constantFormula(0),
    id: "burned",
    name: "Burned",
    tone,
  };
}

const NAMES: Record<string, string> = { fox: "Green Fox", deer: "Deer" };
const nameOf = (actorId: string) => NAMES[actorId] ?? null;

describe("naming a conjured tile", () => {
  it("puts the caster's name in front of it", () => {
    expect(conjuredName("Arcane Flame", { castBy: "fox" }, nameOf)).toBe(
      "Green Fox's Arcane Flame",
    );
  });

  it("leaves a tile nobody cast alone", () => {
    expect(conjuredName("Hearth", {}, nameOf)).toBe("Hearth");
  });

  it("names a creature's fire after the creature", () => {
    expect(conjuredName("Arcane Flame", { castBy: "deer" }, nameOf)).toBe("Deer's Arcane Flame");
  });

  it("is the plain name again once the caster has left the world", () => {
    expect(conjuredName("Arcane Flame", { castBy: "gone" }, nameOf)).toBe("Arcane Flame");
  });
});

describe("what a conjured tile spares its caster", () => {
  it("spares the caster a status the author called bad", () => {
    expect(sparesStander({ castBy: "fox" }, status("bad"), "fox")).toBe(true);
  });

  it("spares nobody else", () => {
    expect(sparesStander({ castBy: "fox" }, status("bad"), "deer")).toBe(false);
  });

  it("spares nobody a tile nobody cast", () => {
    expect(sparesStander({}, status("bad"), "fox")).toBe(false);
  });

  it("hands the caster their own blessing, which is the other tone", () => {
    expect(sparesStander({ castBy: "fox" }, status("good"), "fox")).toBe(false);
  });

  it("spares nothing when there is nobody to compare against", () => {
    expect(sparesStander({ castBy: "fox" }, status("bad"), undefined)).toBe(false);
  });

  it("spares nothing for a status the catalogue has never heard of", () => {
    expect(sparesStander({ castBy: "fox" }, undefined, "fox")).toBe(false);
  });
});

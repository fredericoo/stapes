import { describe, expect, it } from "vitest";
import { castLineClass } from "./castLines";

describe("castLineClass", () => {
  it("draws a cast at the viewer in red", () => {
    expect(castLineClass({ atYou: true })).toBe("cast-line cast-line--at-you");
  });

  it("draws a cast at anybody else in white", () => {
    expect(castLineClass({ atYou: false })).toBe("cast-line");
  });

  it("draws the viewer's attack at half strength", () => {
    expect(castLineClass({ atYou: false, attack: true })).toBe("cast-line cast-line--attack");
  });
});

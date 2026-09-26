import { describe, expect, it } from "vitest";
import { pvpPress } from "./PvpToggle";

describe("pvpPress", () => {
  it("explains the mechanic before turning it on", () => {
    expect(pvpPress(false, true)).toBe("explain");
  });

  it("turns it off with nothing to confirm", () => {
    expect(pvpPress(true, true)).toBe("stop");
  });

  it("does nothing at all while the body is in a fight", () => {
    expect(pvpPress(false, false)).toBe("nothing");
    expect(pvpPress(true, false)).toBe("nothing");
  });
});

import { describe, expect, it } from "vitest";
import { characterIdOf } from "./characterId";

const SERIALS = 100_000;

describe("characterIdOf", () => {
  it("never makes an id a command would read as a number", () => {
    for (let serial = 0; serial < SERIALS; serial++) {
      expect(Number.isNaN(Number(characterIdOf(serial)))).toBe(true);
    }
  });
});

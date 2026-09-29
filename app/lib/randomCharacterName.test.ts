import { describe, expect, it } from "vitest";
import { characterNameProblem, normaliseCharacterName } from "./characterName";
import { randomCharacterName } from "./randomCharacterName";

describe("a suggested character name", () => {
  it("is always one the server accepts, already in its stored form", () => {
    for (let draw = 0; draw < 5000; draw++) {
      const name = randomCharacterName();
      expect(characterNameProblem(name)).toBeNull();
      expect(normaliseCharacterName(name)).toBe(name);
    }
  });
});

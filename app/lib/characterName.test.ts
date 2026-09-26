import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTER_NAME_LENGTH,
  MIN_CHARACTER_NAME_LENGTH,
  characterNameProblem,
  normaliseCharacterName,
} from "./characterName";

describe("normalising a typed name", () => {
  it("capitalises the first letter and lowers the rest", () => {
    expect(normaliseCharacterName("arthur")).toBe("Arthur");
    expect(normaliseCharacterName("ARTHUR")).toBe("Arthur");
    expect(normaliseCharacterName("aRtHuR")).toBe("Arthur");
  });

  it("gives every casing of a name the same answer", () => {
    const forms = ["arthur", "Arthur", "ARTHUR", "ArThUr"];
    const stored = new Set(forms.map(normaliseCharacterName));
    expect([...stored]).toEqual(["Arthur"]);
  });

  it("ignores space somebody typed around it", () => {
    expect(normaliseCharacterName("  arthur ")).toBe("Arthur");
  });
});

describe("refusing a typed name", () => {
  it("accepts a plain name", () => {
    expect(characterNameProblem("Arthur")).toBeNull();
    expect(characterNameProblem("arthur")).toBeNull();
  });

  it("refuses anything that is not a letter", () => {
    for (const typed of ["Ka1n", "Arthur Dent", "arthur!", "aeiou-y", "Ærys"]) {
      expect(characterNameProblem(typed)).toBeTruthy();
    }
  });

  it("refuses an empty field", () => {
    expect(characterNameProblem("")).toBeTruthy();
    expect(characterNameProblem("   ")).toBeTruthy();
  });

  it("refuses a name too short to call anybody across a square", () => {
    expect(characterNameProblem("a".repeat(MIN_CHARACTER_NAME_LENGTH - 1))).toBeTruthy();
    expect(characterNameProblem("a".repeat(MIN_CHARACTER_NAME_LENGTH))).toBeNull();
  });

  it("refuses a name longer than a tag can hold", () => {
    expect(characterNameProblem("a".repeat(MAX_CHARACTER_NAME_LENGTH))).toBeNull();
    expect(characterNameProblem("a".repeat(MAX_CHARACTER_NAME_LENGTH + 1))).toBeTruthy();
  });

  it("measures what would be stored, not what was typed", () => {
    expect(characterNameProblem(` ${"a".repeat(MAX_CHARACTER_NAME_LENGTH)} `)).toBeNull();
  });
});

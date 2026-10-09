import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTER_NAME_LENGTH,
  MIN_CHARACTER_NAME_LENGTH,
  characterNameProblem,
  generationalName,
  normaliseCharacterName,
  romanNumeral,
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

  it("capitalises each word and keeps one space between them", () => {
    expect(normaliseCharacterName("arthur  DENT")).toBe("Arthur Dent");
  });
});

describe("refusing a typed name", () => {
  it("accepts a plain name", () => {
    expect(characterNameProblem("Arthur")).toBeNull();
    expect(characterNameProblem("arthur")).toBeNull();
  });

  it("accepts words separated by spaces", () => {
    expect(characterNameProblem("Arthur Dent")).toBeNull();
    expect(characterNameProblem("arthur   dent")).toBeNull();
  });

  it("refuses anything that is not a letter or a space", () => {
    for (const typed of ["Ka1n", "arthur!", "aeiou-y", "Ærys"]) {
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
    expect(characterNameProblem(`${"a".repeat(9)}    ${"a".repeat(10)}`)).toBeNull();
  });
});

describe("a character's generation", () => {
  it("is written in Roman numerals after the name", () => {
    expect(generationalName("Freddie", 1)).toBe("Freddie I");
    expect(generationalName("Freddie", 2)).toBe("Freddie II");
    expect(generationalName("Freddie", 17)).toBe("Freddie XVII");
  });

  it("uses the subtractive forms", () => {
    expect([4, 9, 14, 40, 90, 400, 900, 1994].map(romanNumeral)).toEqual([
      "IV",
      "IX",
      "XIV",
      "XL",
      "XC",
      "CD",
      "CM",
      "MCMXCIV",
    ]);
  });

  it("falls back to digits past what the numerals can write", () => {
    expect(romanNumeral(3999)).toBe("MMMCMXCIX");
    expect(romanNumeral(4000)).toBe("4000");
  });
});

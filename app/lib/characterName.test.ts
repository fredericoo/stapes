import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTER_NAME_LENGTH,
  MIN_CHARACTER_NAME_LENGTH,
  characterNameProblem,
  normaliseCharacterName,
} from "./characterName";

/**
 * What somebody may be called, and what it is stored as.
 *
 * Both halves run these rules — the form so a refusal arrives while somebody is
 * still typing, the server because the socket is the boundary — so this is a
 * test about the one function rather than about either of them.
 */

describe("normalising a typed name", () => {
  it("capitalises the first letter and lowers the rest", () => {
    expect(normaliseCharacterName("arthur")).toBe("Arthur");
    expect(normaliseCharacterName("ARTHUR")).toBe("Arthur");
    expect(normaliseCharacterName("aRtHuR")).toBe("Arthur");
  });

  /**
   * The reason the unique index is worth anything: two people cannot be
   * `Arthur` and `arthur` and then spend a week being mistaken for each other.
   */
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

  /**
   * Refused rather than stripped. Somebody who typed `Ka1n` and was silently
   * given `Kan` was not told anything, and the name cannot be changed
   * afterwards.
   */
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

  /**
   * The cap is about the label over a head: the tag is drawn at a size fixed by
   * the tile grid, and a long name covers the body standing beside it.
   */
  it("refuses a name longer than a tag can hold", () => {
    expect(characterNameProblem("a".repeat(MAX_CHARACTER_NAME_LENGTH))).toBeNull();
    expect(characterNameProblem("a".repeat(MAX_CHARACTER_NAME_LENGTH + 1))).toBeTruthy();
  });

  /** The trim happens before the count, so trailing space is not a letter. */
  it("measures what would be stored, not what was typed", () => {
    expect(characterNameProblem(` ${"a".repeat(MAX_CHARACTER_NAME_LENGTH)} `)).toBeNull();
  });
});

export const MAX_CHARACTER_NAME_LENGTH = 20;

export const MIN_CHARACTER_NAME_LENGTH = 2;

export const MAX_CHARACTERS_PER_ACCOUNT = 3;

const WORDS_OF_LETTERS = /^[A-Za-z]+( [A-Za-z]+)*$/;

export function normaliseCharacterName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function characterNameProblem(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "A character needs a name.";
  if (!WORDS_OF_LETTERS.test(collapsed)) return "Letters and spaces only — A to Z.";
  if (collapsed.length < MIN_CHARACTER_NAME_LENGTH) {
    return `At least ${MIN_CHARACTER_NAME_LENGTH} letters.`;
  }
  if (collapsed.length > MAX_CHARACTER_NAME_LENGTH) {
    return `At most ${MAX_CHARACTER_NAME_LENGTH} characters, spaces included.`;
  }
  return null;
}

const ROMAN_NUMERALS: readonly (readonly [number, string])[] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** The largest number Roman numerals write without a bar over the letters. */
const MAX_ROMAN = 3999;

export function romanNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROMAN) return String(n);
  let left = n;
  let out = "";
  for (const [value, letters] of ROMAN_NUMERALS) {
    while (left >= value) {
      out += letters;
      left -= value;
    }
  }
  return out;
}

/** A character's generation is its deaths plus one, and is never part of the stored name. */
export function generationalName(name: string, generation: number): string {
  return `${name} ${romanNumeral(generation)}`;
}

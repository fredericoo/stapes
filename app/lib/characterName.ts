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

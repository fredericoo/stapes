export const MAX_CHARACTER_NAME_LENGTH = 20;

export const MIN_CHARACTER_NAME_LENGTH = 2;

export const MAX_CHARACTERS_PER_ACCOUNT = 3;

const LETTERS_ONLY = /^[A-Za-z]+$/;

export function normaliseCharacterName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export function characterNameProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "A character needs a name.";
  if (!LETTERS_ONLY.test(trimmed)) return "Letters only — A to Z, nothing else.";
  if (trimmed.length < MIN_CHARACTER_NAME_LENGTH) {
    return `At least ${MIN_CHARACTER_NAME_LENGTH} letters.`;
  }
  if (trimmed.length > MAX_CHARACTER_NAME_LENGTH) {
    return `At most ${MAX_CHARACTER_NAME_LENGTH} letters.`;
  }
  return null;
}

import type { Character } from "../../server/characters";

const PLAYING_KEY = "stapes:playing";

export function rememberCharacter(character: Character): void {
  sessionStorage.setItem(PLAYING_KEY, character.id);
}

export function rememberedCharacterId(): string | null {
  try {
    return sessionStorage.getItem(PLAYING_KEY);
  } catch {
    return null;
  }
}

export function forgetCharacter(): void {
  sessionStorage.removeItem(PLAYING_KEY);
}

export function resolveRemembered(characters: readonly Character[]): Character | null {
  const id = sessionStorage.getItem(PLAYING_KEY);
  if (!id) return null;
  return characters.find((one) => one.id === id) ?? null;
}

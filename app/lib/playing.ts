import type { Character } from "../../server/characters";

/**
 * Which character this tab is playing.
 *
 * **The tab's own storage, not the browser's**, and that is the point rather
 * than a convenience: an account holds three characters, and two tabs playing
 * two of them is a reasonable thing to do. A cookie or `localStorage` would
 * make the second tab silently change the first. It dies with the tab, which is
 * right — a new tab is somebody arriving, and arriving means choosing.
 *
 * It is what the game route reads to know whose body to open a socket as, and
 * it is written by the chooser one line before it navigates there. A reload
 * mid-session therefore comes back as the same body rather than at the chooser,
 * which matters because two of the app's own paths end in `location.reload()`.
 *
 * **Never trusted on its own.** An id here is checked against the account at
 * the socket, and checked again by `resolveRemembered` against the characters
 * `/api/me` just listed — so a character deleted in the database is a tab that
 * lands on the chooser rather than one that hangs on a refusal.
 */
const PLAYING_KEY = "stapes:playing";

export function rememberCharacter(character: Character): void {
  sessionStorage.setItem(PLAYING_KEY, character.id);
}

/**
 * The remembered id, unresolved.
 *
 * For the one caller that has no list to check it against and no business
 * fetching one: `app/net/link.ts` reads it as it opens a socket, and the server
 * is what decides whether it means anything. @see resolveRemembered for the
 * callers that can check.
 */
export function rememberedCharacterId(): string | null {
  try {
    return sessionStorage.getItem(PLAYING_KEY);
  } catch {
    // A private window with storage blocked. No character named is a socket the
    // server closes, which puts the chooser back — the honest outcome.
    return null;
  }
}

export function forgetCharacter(): void {
  sessionStorage.removeItem(PLAYING_KEY);
}

/**
 * The remembered character, if this account still has it.
 *
 * Resolved against the list rather than returning the bare id, because every
 * caller wants the name too — and because an id with no row behind it is the
 * case this exists to catch.
 */
export function resolveRemembered(characters: readonly Character[]): Character | null {
  const id = sessionStorage.getItem(PLAYING_KEY);
  if (!id) return null;
  return characters.find((one) => one.id === id) ?? null;
}

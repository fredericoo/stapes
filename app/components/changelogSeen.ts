import { LATEST_VERSION } from "./releaseNotes";

const STORAGE_KEY = "stapes:changelog-seen";

export function loadSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, version);
  } catch {}
}

export function hasUnseenRelease(seenVersion: string | null): boolean {
  return LATEST_VERSION !== null && LATEST_VERSION !== seenVersion;
}

export const ENGRAVING_TOKEN = "%s";

export const UNKNOWN_ENGRAVING = "Someone";

export function isEngravable(name: string): boolean {
  return name.includes(ENGRAVING_TOKEN);
}

export function engravedName(name: string, engraved?: string): string {
  if (!isEngravable(name)) return name;
  return name.replaceAll(ENGRAVING_TOKEN, engraved?.trim() || UNKNOWN_ENGRAVING);
}

export const MAX_ENGRAVING_LENGTH = 40;

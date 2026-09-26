export const MAX_CHAT_LENGTH = 128;

export const CHAT_LIFETIME_MS = 5_000;

export const MAX_CHATS_PER_CELL = 3;

export const CHAT_MIN_INTERVAL_MS = 750;

export const MAX_CHAT_RAW_LENGTH = 512;

const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7d;

export function sanitizeChatText(raw: string): string | null {
  let kept = "";
  for (const char of raw.slice(0, MAX_CHAT_RAW_LENGTH)) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) continue;
    kept += char;
  }

  const collapsed = kept.replace(/ {2,}/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_CHAT_LENGTH);
}

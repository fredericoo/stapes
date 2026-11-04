export const WINDOW_IDS = [
  "stats",
  "equipment",
  "bag",
  "hand",
  "container",
  "spells",
  "nearby",
] as const;

export type WindowId = (typeof WINDOW_IDS)[number];

const STORAGE_KEY = "stapes:collapsed-windows";

function isWindowId(value: unknown): value is WindowId {
  return typeof value === "string" && (WINDOW_IDS as readonly string[]).includes(value);
}

export function readCollapsedWindows(stored: unknown): WindowId[] {
  return Array.isArray(stored) ? [...new Set(stored.filter(isWindowId))] : [];
}

export function toggleWindow(collapsed: WindowId[], id: WindowId): WindowId[] {
  return collapsed.includes(id) ? collapsed.filter((other) => other !== id) : [...collapsed, id];
}

export function loadCollapsedWindows(): WindowId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? readCollapsedWindows(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveCollapsedWindows(collapsed: WindowId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch {}
}

export type PadSide = "left" | "right";

export const DEFAULT_PAD_SIDE: PadSide = "right";

const STORAGE_KEY = "stapes:pad-side";

function isPadSide(value: unknown): value is PadSide {
  return value === "left" || value === "right";
}

export function loadPadSide(): PadSide {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPadSide(stored) ? stored : DEFAULT_PAD_SIDE;
  } catch {
    return DEFAULT_PAD_SIDE;
  }
}

export function savePadSide(side: PadSide): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, side);
  } catch {}
}

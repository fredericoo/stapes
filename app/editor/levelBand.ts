import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { type LevelRange, VIEW_LEVEL_REACH } from "../lib/view";

type LevelVisibility = "hidden" | "solid" | "ghost";

export function levelVisibility(
  z: number,
  current: number,
  showOther: boolean,
  preview: boolean,
): LevelVisibility {
  if (z < MIN_LEVEL || z > MAX_LEVEL) return "hidden";
  if (Math.abs(z - current) > VIEW_LEVEL_REACH) return "hidden";
  if (current < 0 && z >= 0) return "hidden";
  if (preview) return "solid";
  if (z <= current) return "solid";
  if (!showOther) return "hidden";
  return "ghost";
}

/** Every level {@link levelVisibility} does not hide, as one range. */
export function drawnLevelRange(current: number, showOther: boolean, preview: boolean): LevelRange {
  const z0 = Math.max(MIN_LEVEL, current - VIEW_LEVEL_REACH);
  let z1 = preview || showOther ? Math.min(MAX_LEVEL, current + VIEW_LEVEL_REACH) : current;
  if (current < 0) z1 = Math.min(z1, -1);
  return { z0, z1 };
}

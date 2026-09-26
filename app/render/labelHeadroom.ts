import { PX_PER_HEIGHT } from "../lib/geometry";
import { HEIGHT_PER_LEVEL } from "../lib/types";

const BASE_HEADROOM_PX = 1;

export function labelHeadroomPx(height: number): number {
  const shortfallUnits = Math.max(0, HEIGHT_PER_LEVEL - height);
  return BASE_HEADROOM_PX + shortfallUnits * PX_PER_HEIGHT;
}

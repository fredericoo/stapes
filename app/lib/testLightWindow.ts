import type { LightWindow, WorldRect } from "./lightingChunks";
import type { LevelRange } from "./view";

/**
 * Wide enough that every light in a test map lights everything it can reach,
 * which is what a comparison against the whole-map bake needs.
 */
const TEST_LEVELS: LevelRange = { z0: -20, z1: 20 };

export function inBand(rect: WorldRect & { levels?: LevelRange }): LightWindow {
  return { levels: TEST_LEVELS, ...rect };
}

// PROTOTYPE — dissolve spike, not reviewed. See the prototype-tile-dissolve branch.

/**
 * A tile that just formed on the board, or just dissolved off it.
 *
 * An event rather than state, on the terms a projectile is one: a cell patch
 * says a flame is gone, and cannot say whether it burned out or was picked up.
 */
export type TileFx = {
  id: string;
  fx: "appear" | "vanish";
  tileId: string;
  x: number;
  y: number;
  z: number;
  elapsedMs: number;
};

export const TILE_FX_DURATION_MS = 700;

/**
 * How many brightness steps a dissolving tile's light fades through.
 *
 * Steps rather than a smooth ramp because the overlay cache keys on each
 * light's intensity: a value that changed every frame would rebake the light
 * window every frame. Four misses per dissolve is the whole cost.
 */
export const TILE_FX_LIGHT_STEPS = 4;

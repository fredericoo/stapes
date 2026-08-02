/** Fixed simulation tick rate. */
export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

/** Time to walk one tile (client lerp + sim commit at end). */
export const WALK_DURATION_MS = 200;

/** Time to fall one height unit. */
export const FALL_MS_PER_HEIGHT = 200;

export const PLAYER_TILE_ID = "player";

/** Max climb up in absolute height units when walking into a cell. */
export const MAX_CLIMB_HEIGHT = 2;

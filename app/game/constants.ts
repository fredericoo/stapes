/** Fixed simulation tick rate. */
export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

/** Time to walk one tile (client lerp + sim commit at end). */
export const WALK_DURATION_MS = 200;

/** Time to fall one height unit (4px; keeps prior px/ms with HEIGHT_PER_LEVEL=2). */
export const FALL_MS_PER_HEIGHT = 400;

/** Time a dragged object takes to travel one tile — same pace as a walk. */
export const DRAG_STEP_MS = WALK_DURATION_MS;

export const PLAYER_TILE_ID = "player";

/** Max climb up in absolute height units when walking into a cell (half a level). */
export const MAX_CLIMB_HEIGHT = 1;

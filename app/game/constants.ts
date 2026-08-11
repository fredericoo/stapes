/** Fixed simulation tick rate. */
export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

/** Time to walk one tile (client lerp + sim commit at end). */
export const WALK_DURATION_MS = 200;

/** Time to fall one height unit (4px; keeps prior px/ms with HEIGHT_PER_LEVEL=2). */
export const FALL_MS_PER_HEIGHT = 400;

/** Time a pushed object takes to travel one tile — same pace as a walk. */
export const PUSH_STEP_MS = WALK_DURATION_MS;

export const PLAYER_TILE_ID = "player";

/**
 * How often a brain decides. Six simulation ticks — one decision per walk.
 *
 * A whole number of ticks, and that is load-bearing rather than tidy: a
 * fractional cadence would drift against the tick loop and stop being
 * reproducible, and reproducibility is the entire reason the dice are seeded.
 *
 * Bodies still move at the full tick rate. This is only the rate at which a
 * creature reconsiders — thirty times a second is thirty times more often than
 * anything here has a new answer.
 */
export const BRAIN_TICK_MS = WALK_DURATION_MS;

/**
 * Floors up or down that still count as being near somebody, or as being able
 * to see them. The same slack interaction already uses for reach.
 *
 * Shared by the distance conditions and by the line of sight walk on purpose: a
 * condition that pairs "within five cells" with "and I can see them" would
 * otherwise be able to disagree with itself about who is even a candidate.
 * Distance is counted in steps on the plan, not as the crow flies — a creature
 * that thinks in cells it could walk is a creature whose behaviour matches the
 * board.
 */
export const SIGHT_LEVEL_SLACK = 1;

/** Max climb up in absolute height units when walking into a cell (half a level). */
export const MAX_CLIMB_HEIGHT = 1;

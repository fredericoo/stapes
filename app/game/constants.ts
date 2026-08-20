/** Fixed simulation tick rate. */
export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

/** Time to walk one tile (client lerp + sim commit at end). */
export const WALK_DURATION_MS = 200;

/**
 * Time to fall one height unit (4px, with HEIGHT_PER_LEVEL=2).
 *
 * Twice the old pace. A fall at 400ms/unit floated — a drop off a two-level
 * ledge took most of a second, long enough to read as a descent rather than as
 * gravity. Nothing else is keyed to it: every consumer divides by it, so the
 * sim's step-down cadence and the client's interpolation move together.
 */
export const FALL_MS_PER_HEIGHT = 200;

/** Time a pushed object takes to travel one tile — same pace as a walk. */
export const PUSH_STEP_MS = WALK_DURATION_MS;

export const PLAYER_TILE_ID = "player";

/**
 * The bag every player starts with on their back.
 *
 * A tile id rather than an authored placement, because the starting kit is not
 * in the world: nobody dropped it and there is nowhere it came from. Named here
 * beside the player's own tile since it is the same kind of fact — what a person
 * *is* when the world first hands them a body.
 *
 * A world whose author has renamed or removed this tile seats players with
 * nothing rather than refusing to start; see `startingEquipment`.
 */
export const STARTING_BAG_TILE_ID = "basic-bag";

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

/** Max climb up in absolute height units when walking into a cell (half a level). */
export const MAX_CLIMB_HEIGHT = 1;

/**
 * How long a damage number stays on screen.
 *
 * Long enough to read a two-digit number and see which way it drifted, short
 * enough that a fast exchange does not stack a column of them over one head.
 * Shared by the simulation and the online client so a number lives the same
 * length either side of a wire.
 */
export const DAMAGE_NUMBER_LIFETIME_MS = 900;

/**
 * How long a noise hangs in the air.
 *
 * Between the two neighbours it sits between, because it is between them in
 * kind. Longer than a damage number, since a word takes longer to read than two
 * digits; far shorter than speech, because nobody is waiting to reply to a hiss
 * and a noise that outstayed the moment it belongs to would read as dialogue.
 *
 * Shared by the simulation and the online client, exactly as the damage
 * lifetime is, so a noise lives the same length either side of a wire.
 */
export const NOISE_LIFETIME_MS = 2_000;

/**
 * How long a body spends leaning into one blow — out and back.
 *
 * Under the 200ms floor between two blows ({@link MIN_ATTACK_TICKS} at the tick
 * rate), and that is the whole of the number: the fastest fighter in the world
 * has to be home before it swings again, or the lean never returns and the body
 * simply lives half a tile from where it stands. Everybody slower gets a pause
 * between strikes, which is what makes a count of blows readable.
 *
 * Shared by the simulation and the online client so a strike lasts the same
 * length either side of a wire, exactly as the damage lifetime is.
 */
export const STRIKE_DURATION_MS = 150;

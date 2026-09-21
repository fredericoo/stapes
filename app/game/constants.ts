import { HEIGHT_PER_LEVEL } from "../lib/types";

/** Fixed simulation tick rate. */
export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

/** Time to walk one tile (client lerp + sim commit at end). */
export const WALK_DURATION_MS = 200;

/**
 * Time to fall one level.
 *
 * A fall at twice this floated — a drop off a two-level ledge took most of a
 * second, long enough to read as a descent rather than as gravity.
 */
export const FALL_MS_PER_LEVEL = 400;

/**
 * Time to fall one height unit (2px, a quarter of a level).
 *
 * Derived from the level rather than authored, because the pace that has to
 * stay put is the one you can see: a storey takes {@link FALL_MS_PER_LEVEL}
 * whatever a level is subdivided into. Nothing else is keyed to it — every
 * consumer divides by it, so the sim's step-down cadence and the client's
 * interpolation move together.
 */
export const FALL_MS_PER_HEIGHT = FALL_MS_PER_LEVEL / HEIGHT_PER_LEVEL;

/** Time a pushed object takes to travel one tile — same pace as a walk. */
export const PUSH_STEP_MS = WALK_DURATION_MS;

/**
 * The tile a person arrives in — and, since a kit hangs off the battler block,
 * where the backpack they arrive with comes from too.
 *
 * There used to be a `STARTING_BAG_TILE_ID` beside this, naming that bag
 * directly. It is gone: the player's bag is authored on this tile exactly as a
 * rat's meat is authored on `rat`, so there is one place a body's belongings
 * are decided rather than one for people and one for everything else. See
 * `../lib/kit`.
 */
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
 * How near a player has to be for a creature to think every round, at least.
 *
 * A creature's real reach is the furthest distance its own brain ever asks
 * about — see `brainReach` — and this is the floor under it: a screen is
 * `VIEW_CELLS` (23) across, so anything nearer than this is on it or about to
 * be, and a wander that only happened every seventh round would be seen
 * stuttering. One more than the view, so the floor covers a body standing at
 * the very edge of the screen rather than one cell inside it.
 */
export const BRAIN_ATTENTION_FLOOR_CELLS = 24;

/**
 * Creatures that nobody is near enough to notice, given a turn per round.
 *
 * The rest of the round is spent on the creatures somebody *could* notice, so
 * this is the only term in a round's cost that the map contributes: the round
 * is players plus this, however many creatures the world holds. What it buys
 * a dozing creature is a turn every `dozing / budget` rounds — with today's
 * hundred and eighty residents, about every seventh — and at ten times the
 * population every seventieth, which is the trade this exists to make. A
 * creature far from everybody is not asleep: its clock keeps running, and
 * when its turn comes it is handed every millisecond it slept through, so a
 * wait ends when it should and a walk is merely slow.
 */
export const BRAIN_DOZE_BUDGET = 24;

/**
 * Max climb up in absolute height units when walking into a cell.
 *
 * Half a level, derived rather than written down, so subdividing a level never
 * silently shortens everybody's legs.
 */
export const MAX_CLIMB_HEIGHT = HEIGHT_PER_LEVEL / 2;

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

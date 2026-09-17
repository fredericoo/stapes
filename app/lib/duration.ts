/**
 * How long something takes, in whichever unit a reader can hold.
 *
 * A module of its own, and a small one, for the reason `./walkSpeed` is: the
 * wording is read by things that should not import each other. An item's card
 * says how often a weapon swings (`../game/itemCard`) and the stats panel says
 * how often *you* swing (`../components/StatsPanel`), and a player comparing the
 * two has to see the same string for the same interval — a second copy of the
 * rule is the two of them drifting apart.
 */

/** A minute, past which seconds stop being the unit anybody reads in. */
const SECONDS_PER_MINUTE = 60;

/**
 * A duration, rounded to whatever precision still tells the reader something.
 *
 * A tenth of a second distinguishes a fast weapon from a slow one at the bottom
 * of the scale and distinguishes nothing at the top, where a range would read
 * "5.0s–20s" and leave the reader wondering why one end has more precision than
 * the other. Past a minute seconds stop working entirely: an hour-long status
 * reported as "3600s" is a number to convert rather than to read.
 */
export function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${Number(s.toFixed(1))}s`;
  if (s < SECONDS_PER_MINUTE) return `${Math.round(s)}s`;
  const minutes = s / SECONDS_PER_MINUTE;
  return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}m`;
}

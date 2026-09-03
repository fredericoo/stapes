/**
 * When diffing a level's changed cells stops being cheaper than rebuilding it.
 *
 * Its own module because it is a claim about cost rather than a piece of the
 * renderer, and a claim about cost is worth being able to test without a WebGL
 * context to hang it off.
 */

/**
 * Changed cells past which the incremental path stops being worth it, as a
 * share of the level being diffed.
 *
 * Diffing one changed cell costs two `cellItems` rebuilds for the comparison
 * plus nine more for its autotile ring — call it a dozen — while the wholesale
 * rebuild costs one per cell on the *whole level*. So the crossover is not a
 * number of cells at all: it is a fraction of the floor, and a floor of eleven
 * thousand cells can afford to diff far more of itself than one of four hundred
 * can.
 *
 * This was a flat 16, chosen when the biggest level was 4,565 cells and
 * described as "set well above what gameplay produces". Then the animal den put
 * three levels of eight to eleven thousand cells underground with a hundred and
 * fifty animals walking about on them, and gameplay started producing 24
 * changed cells on a median tick and 62 on a bad one. Every one of those frames
 * rebuilt a whole level's merged geometry: 40ms of a 52ms frame, for a few
 * dozen rats taking a step.
 *
 * A sixteenth is deliberately conservative against the dozen above — it is
 * roughly where the two are level, without leaning on what a `cellItems` call
 * happens to cost today.
 */
export const INCREMENTAL_CELL_SHARE = 16;

/**
 * The floor under that share, for levels small enough that a fraction of them
 * is meaningless.
 *
 * A step touches two cells and must never take the slow path, however small the
 * level it happens on.
 */
export const MIN_INCREMENTAL_CELLS = 16;

/** How many changed cells are worth diffing on a level of `levelCells`. */
export function incrementalCellLimit(levelCells: number): number {
  return Math.max(
    MIN_INCREMENTAL_CELLS,
    Math.floor(levelCells / INCREMENTAL_CELL_SHARE),
  );
}

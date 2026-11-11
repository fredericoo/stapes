import { MINUTES_PER_DAY, type MinutesOfDay } from "./clock";
import { scatterHash } from "./scatter";

const MINUTES_PER_HOUR = 60;
const RULE_SEED = 0x51ed270b;

export const MAX_PARTICLE_ONE_IN = 64;

/** From `from` up to but not including `to`, in hours of the day; `from` after `to` runs through midnight. */
export type HourSpan = {
  from: number;
  to: number;
};

/**
 * Narrows which placements of a tile on the board give off its `particles`:
 * one cell in `oneIn`, and only during `hours`. For a tile laid by the hundred,
 * such as a tree or a swamp plant.
 */
export type TileParticleRule = {
  oneIn: number;
  hours?: HourSpan;
};

export function ruleSelectsCell(
  rule: TileParticleRule | undefined,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!rule || rule.oneIn <= 1) return true;
  return scatterHash(x, y, z, RULE_SEED) % rule.oneIn === 0;
}

export function inHourSpan(span: HourSpan | undefined, minutesOfDay: MinutesOfDay): boolean {
  if (!span) return true;
  const minutes = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const from = span.from * MINUTES_PER_HOUR;
  const to = span.to * MINUTES_PER_HOUR;
  if (from === to) return true;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

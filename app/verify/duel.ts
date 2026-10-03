import { Duel, type DuelEvent, type DuelOptions, type DuelSetup, type Side } from "../game/duel";
import type { Rng } from "../game/rng";

/**
 * A null `winner` is either a draw, where both fell on the same tick, or a
 * fight still going at `maxTicks`. With `ticks` below `maxTicks` it is a draw.
 */
export type DuelResult = {
  winner: Side | null;
  ticks: number;
  survivorHealth: number;
};

export const MAX_DUEL_TICKS = 20_000;

export type DuelWatch = (events: readonly DuelEvent[], duel: Duel) => void;

export function runDuel(
  a: DuelSetup,
  b: DuelSetup,
  rng: Rng,
  options: DuelOptions & { maxTicks?: number; watch?: DuelWatch } = {},
): DuelResult {
  const duel = new Duel(a, b, rng, options);
  const maxTicks = options.maxTicks ?? MAX_DUEL_TICKS;

  for (let tick = 1; tick <= maxTicks; tick++) {
    const events = duel.tick();
    options.watch?.(events, duel);
    if (!duel.finished) continue;
    const winner = duel.winner;
    return {
      winner,
      ticks: tick,
      survivorHealth: winner ? duel.fighter(winner).hp / duel.statsOf(winner).maxHp : 0,
    };
  }

  return { winner: null, ticks: maxTicks, survivorHealth: 0 };
}

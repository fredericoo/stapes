import type { Direction } from "../../../lib/types";

export type Cell = { x: number; y: number };

export const STEP: Record<Direction, Cell> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

const SIDES: readonly Direction[] = ["s", "e", "w", "n"];

/** A ramp by the cell at its top, on the upper level, and the way down from there. */
export type RampSite = { head: Cell; side: Direction };

/** What a ramp is placed on: how high each cell's ground is, and whether a cell is free to hold part of one. */
export type RampGround = {
  level(x: number, y: number): number;
  clear(x: number, y: number): boolean;
};

const along = (from: Cell, by: Cell, steps: number): Cell => ({
  x: from.x + by.x * steps,
  y: from.y + by.y * steps,
});

/**
 * The cells a ramp takes, from the top down: `landing` and `head` on the
 * upper level, then `high` and `low`, the two cells of slope on the lower
 * level, and `foot`, the cell a body steps off onto.
 */
export function rampCells(site: RampSite) {
  const down = STEP[site.side];
  return {
    landing: along(site.head, down, -1),
    head: site.head,
    high: along(site.head, down, 1),
    low: along(site.head, down, 2),
    foot: along(site.head, down, 3),
  };
}

/**
 * Whether a ramp can go here. The cliff has to be straight for a cell either
 * side of the head: on a corner the slope would meet the brink's curve and
 * leave a wedge of wall beside it. There has to be ground behind the head to
 * arrive on, and three clear cells on the lower level, two for the slope and
 * one to step off onto.
 */
export function rampFits(ground: RampGround, site: RampSite): boolean {
  const { landing, head, high, low, foot } = rampCells(site);
  const upper = ground.level(head.x, head.y);
  const lower = upper - 1;
  const down = STEP[site.side];
  const across = { x: down.y, y: down.x };
  if (ground.level(landing.x, landing.y) !== upper) return false;
  for (const cell of [high, low, foot]) {
    if (ground.level(cell.x, cell.y) !== lower || !ground.clear(cell.x, cell.y)) return false;
  }
  for (const sign of [-1, 1]) {
    const beside = along(head, across, sign);
    const below = along(beside, down, 1);
    if (ground.level(beside.x, beside.y) !== upper) return false;
    if (ground.level(below.x, below.y) !== lower) return false;
  }
  return true;
}

/**
 * The ramp that fits nearest to a cell, looking `reach` cells each way, or
 * none. `prefer` breaks ties towards the way a road is already heading.
 */
export function nearestRamp(
  ground: RampGround,
  near: Cell,
  reach: number,
  accept: (site: RampSite) => boolean = () => true,
  prefer?: Direction,
): RampSite | null {
  let best: { site: RampSite; cost: number } | null = null;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const head = { x: near.x + dx, y: near.y + dy };
      for (const side of SIDES) {
        const cost = Math.abs(dx) + Math.abs(dy) + (side === prefer ? 0 : 0.5);
        if (best && cost >= best.cost) continue;
        const site = { head, side };
        if (rampFits(ground, site) && accept(site)) best = { site, cost };
      }
    }
  }
  return best?.site ?? null;
}

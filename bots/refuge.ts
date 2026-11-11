import { PLAYER_TILE_ID } from "../app/game/constants";
import type { ActorSnapshot } from "../app/game/GameSession";
import type { NavGoal } from "../app/game/navigation";
import { resolveBattler } from "../app/lib/battler";
import { resolveDialog } from "../app/lib/dialog";
import type { Coord, TileDef } from "../app/lib/types";
import { canHurt, steps } from "./combat";
import type { Landmarks } from "./memory";
import { noticeCells } from "./odds";

/** The key `Landmarks` keeps the places bots were reborn under. No tile id holds an `@`. */
export const REBIRTH_MARK = "@rebirth";

/** A bot within this many steps of a haven is on it. */
export const HAVEN_CELLS = 4;

/**
 * How far a hurt bot wants to be from any creature that can hurt, or the
 * creature's `noticeCells` when that is further. It is wider than the
 * healthy bot's `THREAT_BERTH_CELLS` because one bite ends a recovery.
 */
export const HURT_BERTH_CELLS = 8;

/** Safe ground this near is walked to even when nothing hostile is near where the bot stands. */
export const NEAR_REFUGE_STEPS = 30;

/** What each creature near where the bot stands is worth, in steps walked to get away from it. */
export const EXPOSED_STEPS = 100;

/** What passing through each creature's berth on the way costs, in steps. */
export const PASSING_STEPS = 40;

/** What a bot knows of the ground around it: the fleet's memory, and what it sees. */
export type Ground = {
  readonly landmarks: Landmarks;
  readonly tilesById: Record<string, TileDef>;
  readonly bodies: readonly ActorSnapshot[];
  /** Where the bot itself backed away from or died. */
  readonly avoid: (cell: Coord) => boolean;
};

type Danger = { readonly at: Coord; readonly cells: number };

/**
 * Where a hurt bot should recover: a haven worth the walk, or null to
 * recover where it stands. A haven is a place the bot was reborn or an NPC
 * with a dialog stands, with no creature that can hurt remembered or seen
 * within its berth. Each creature near the bot makes staying cost
 * `EXPOSED_STEPS`, and each one beside the straight way to a haven makes
 * that walk cost `PASSING_STEPS` more; the bot walks when the walk costs
 * less than staying plus `NEAR_REFUGE_STEPS`.
 */
export function refugeFor(ground: Ground, self: Coord): Coord | null {
  const found = dangers(ground, self);
  const safe = havens(ground, self).filter(
    (haven) => !ground.avoid(haven) && !found.some((danger) => reaches(danger, haven)),
  );
  if (safe.some((haven) => steps(haven, self) <= HAVEN_CELLS)) return null;
  const near = found.filter((danger) => reaches(danger, self));
  let best: Coord | null = null;
  let bestCost = near.length * EXPOSED_STEPS + NEAR_REFUGE_STEPS;
  for (const haven of safe) {
    const passed = found.filter(
      (danger) => !near.includes(danger) && passes(danger, self, haven),
    ).length;
    const cost = steps(self, haven) + passed * PASSING_STEPS;
    if (cost < bestCost) {
      best = haven;
      bestCost = cost;
    }
  }
  return best;
}

export function havenGoal(at: Coord): NavGoal {
  return {
    reached: (cell) => cell.z === at.z && steps(cell, at) <= HAVEN_CELLS,
    estimate: (cell) => Math.max(0, steps(cell, at) - HAVEN_CELLS),
  };
}

/** Where bots were reborn, and where NPCs with a dialog stand or were seen. */
function havens(ground: Ground, self: Coord): Coord[] {
  const { landmarks, tilesById, bodies } = ground;
  const out = landmarks.where(REBIRTH_MARK, self);
  for (const def of Object.values(tilesById)) {
    if (def.id !== PLAYER_TILE_ID && resolveDialog(def)) out.push(...landmarks.where(def.id, self));
  }
  for (const body of bodies) {
    const def = tilesById[body.tileId];
    if (def && body.tileId !== PLAYER_TILE_ID && resolveDialog(def)) out.push(cellOf(body));
  }
  return out;
}

/** Every place a creature that can hurt was remembered or is seen, with its berth. */
function dangers(ground: Ground, self: Coord): Danger[] {
  const { landmarks, tilesById, bodies } = ground;
  const out: Danger[] = [];
  for (const def of Object.values(tilesById)) {
    if (!hostile(def)) continue;
    const cells = berth(def);
    for (const at of landmarks.where(def.id, self)) out.push({ at, cells });
  }
  for (const body of bodies) {
    const def = tilesById[body.tileId];
    if (!def || !hostile(def) || (body.hp !== null && body.hp <= 0)) continue;
    out.push({ at: cellOf(body), cells: berth(def) });
  }
  return out;
}

/** As in `creaturesAround`: townsfolk and creatures only PvP may harm are not hostile. */
function hostile(def: TileDef): boolean {
  return (
    def.id !== PLAYER_TILE_ID &&
    canHurt(def) &&
    resolveDialog(def) === null &&
    resolveBattler(def)?.pvp !== true
  );
}

function berth(def: TileDef): number {
  return Math.max(HURT_BERTH_CELLS, noticeCells(def));
}

function reaches(danger: Danger, cell: Coord): boolean {
  return danger.at.z === cell.z && steps(danger.at, cell) <= danger.cells;
}

/** Whether the straight way from `a` to `b` comes within the danger's berth on either end's level. */
function passes(danger: Danger, a: Coord, b: Coord): boolean {
  const { at, cells } = danger;
  if (at.z !== a.z && at.z !== b.z) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length));
  return Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y) <= cells;
}

function cellOf(at: Coord): Coord {
  return { x: at.x, y: at.y, z: at.z };
}

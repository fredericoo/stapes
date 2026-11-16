import { battlerTiles } from "../game/arena";
import { PLAYER_TILE_ID } from "../game/constants";
import {
  type BattlerDef,
  battlerRating,
  fightingStats,
  hurtsAnybody,
  maxHpFrom,
  PLAYER_BASE_HP,
  resolveBattler,
} from "../lib/battler";
import { resolveItem } from "../lib/item";
import { MAX_MASTERY } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { type BattleOptions, type Catalogue, runBattle } from "./battle";
import { MATRIX_RUNGS, playerAtRung } from "./matrix";
import { parseSide } from "./sides";

/** Below the first rung the player keeps the sword its own kit rolls. */
export function playerAtLevel(level: number): string {
  let sword: string | null = null;
  for (const rung of MATRIX_RUNGS) {
    if (rung.rung <= level) sword = rung.sword;
  }
  if (sword) return playerAtRung(level, sword);
  return `${PLAYER_TILE_ID}:sharp=${level},toughness=${level},agility=${level}`;
}

function playerHoldsOwn(
  creatureId: string,
  level: number,
  catalogue: Catalogue,
  options: BattleOptions,
): boolean {
  const { tilesById } = catalogue;
  const sides = {
    A: parseSide(playerAtLevel(level), tilesById),
    B: parseSide(creatureId, tilesById),
  };
  const { outcomes } = runBattle(sides, catalogue, options);
  return outcomes.wins.count >= outcomes.losses.count;
}

/**
 * The lowest level at which a player with Sharp, Toughness and Agility at that
 * level wins at least as often as it loses, or null when no level does. Bisected,
 * which reads the win rate as climbing with the level.
 */
export function evenLevel(
  creatureId: string,
  catalogue: Catalogue,
  options: BattleOptions,
): number | null {
  if (!playerHoldsOwn(creatureId, MAX_MASTERY, catalogue, options)) return null;
  let losing = 0;
  let holding = MAX_MASTERY;
  while (holding - losing > 1) {
    const middle = Math.floor((losing + holding) / 2);
    if (playerHoldsOwn(creatureId, middle, catalogue, options)) holding = middle;
    else losing = middle;
  }
  return holding;
}

/** The most one swing can be worth before armour, over the natural weapon and every weapon the kit can roll. */
export function heaviestBlow(battler: BattlerDef, tilesById: Record<string, TileDef>): number {
  let heaviest = fightingStats(battler, battler.naturalWeapon).damage;
  for (const entry of battler.kit ?? []) {
    if (entry.slot !== "weapon" && entry.slot !== "offhand") continue;
    const def = tilesById[entry.tileId];
    const item = def ? resolveItem(def) : null;
    if (item?.type !== "weapon") continue;
    heaviest = Math.max(heaviest, fightingStats(battler, item).damage);
  }
  return heaviest;
}

export type RatingRow = {
  key: string;
  name: string;
  rating: number;
  authored: boolean;
  harmless: boolean;
  even: number | null;
  heaviestBlow: number;
  heaviestShare: number;
};

export type RatingsReport = {
  seeds: number;
  statuses: boolean;
  kit: BattleOptions["kit"];
  maxSeconds: number;
  rows: RatingRow[];
};

export function runRatings(catalogue: Catalogue, options: BattleOptions): RatingsReport {
  const creatures = battlerTiles(Object.values(catalogue.tilesById))
    .filter((tile) => tile.id !== PLAYER_TILE_ID)
    .sort((x, y) => x.id.localeCompare(y.id));

  const rows = creatures.map((creature) => {
    const battler = resolveBattler(creature)!;
    const harmless = !hurtsAnybody(battler);
    const rating = battlerRating(battler);
    const blow = heaviestBlow(battler, catalogue.tilesById);
    return {
      key: creature.id,
      name: creature.name,
      rating,
      authored: battler.rating !== undefined,
      harmless,
      even: harmless ? null : evenLevel(creature.id, catalogue, options),
      heaviestBlow: blow,
      heaviestShare: blow / maxHpFrom(PLAYER_BASE_HP, Math.min(rating, MAX_MASTERY)),
    };
  });

  return {
    seeds: options.seeds,
    statuses: options.statuses,
    kit: options.kit,
    maxSeconds: options.maxSeconds,
    rows,
  };
}

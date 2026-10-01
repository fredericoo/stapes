import { rotationOdds } from "../app/game/combatMetrics";
import {
  effectiveBattler,
  HANDS,
  weaponSwungBy,
  type Equipment,
  type Hand,
} from "../app/game/equipment";
import type { ActorSnapshot } from "../app/game/GameSession";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { withStatusModifiers } from "../app/game/statuses";
import { resolveBrain, tilesNamedBy, type BrainCondition } from "../app/lib/brain";
import { isConditionGroup } from "../app/lib/conditions";
import { resolveBattler, type BattlerDef, type FightingStats } from "../app/lib/battler";
import type { StatusDef } from "../app/lib/status";
import type { TileDef } from "../app/lib/types";

/** A body as a fight sees it: who it is, how hurt, and what it is under. */
export type Fighter = Pick<ActorSnapshot, "tileId" | "hp" | "maxHp" | "statuses">;

/**
 * How a fight would go, in seconds: how long the bot takes to kill the foe
 * and how long the foe takes to kill the bot, each from the health both have
 * now. `margin` is the second over the first, so above 1 the bot should win.
 */
export type Odds = {
  readonly killSeconds: number;
  readonly dieSeconds: number;
  readonly margin: number;
};

/**
 * Each hand the bot swings, as `Duel` and the Arena rotate them, with the
 * statuses it is under applied. A body with no weapon swings its bare hands.
 */
export function swingsOf(
  body: BattlerDef,
  equipment: Equipment | null,
  self: Fighter,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): FightingStats[] {
  const hands: (Hand | null)[] = HANDS.filter((hand) =>
    weaponSwungBy(equipment, tilesById, hand, body.masteries),
  );
  if (hands.length === 0) hands.push(null);
  return hands.map((hand) => {
    const stats = effectiveBattler(body, equipment, tilesById, hand);
    return withStatusModifiers(stats, self.statuses, statusDefs, self.hp ?? stats.maxHp);
  });
}

/**
 * A creature's one swing, from its authored battler: residents earn no
 * experience, so what is authored is what it fights with. Null for anything
 * that is not a battler, such as a player, whose masteries the bot cannot see.
 */
export function creatureSwing(
  foe: Fighter,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): FightingStats | null {
  const def = tilesById[foe.tileId];
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return null;
  const stats = effectiveBattler(battler, null, tilesById, null);
  return withStatusModifiers(stats, foe.statuses, statusDefs, foe.hp ?? stats.maxHp);
}

/** Damage a second from a creature's bolts that hurt, spread over each spell's cooldown. */
export function spellDamagePerSecond(def: TileDef | undefined): number {
  const battler = def ? resolveBattler(def) : null;
  let total = 0;
  for (const spell of battler?.spells ?? []) {
    const effect = spell.effect;
    if (effect.kind !== "bolt" || effect.on !== "target" || !effect.damage) continue;
    total += (effect.damage * 1000) / Math.max(1000, spell.cooldownMs);
  }
  return total;
}

/**
 * The bot against `foes` all at once: it kills them one after the other
 * while all of them hit it, which is how a pack fight goes. `theirShare`
 * scales what they do to it, for a bot that keeps them at a distance.
 * Null when any foe is a body whose fighting the bot cannot work out.
 */
export function fightOdds(
  mine: readonly FightingStats[],
  self: Fighter,
  foes: readonly Fighter[],
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  theirShare = 1,
): Odds | null {
  if (mine.length === 0 || foes.length === 0) return null;
  const guard = mine[0]!;
  let killSeconds = 0;
  let incoming = 0;
  for (const foe of foes) {
    const theirs = creatureSwing(foe, tilesById, statusDefs);
    if (!theirs) return null;
    const mineOnThem = rotationOdds(mine, theirs);
    if (mineOnThem.damagePerSecond <= 0) return { killSeconds: Infinity, dieSeconds: 0, margin: 0 };
    killSeconds += (foe.hp ?? theirs.maxHp) / mineOnThem.damagePerSecond;
    incoming +=
      rotationOdds([theirs], guard).damagePerSecond + spellDamagePerSecond(tilesById[foe.tileId]);
  }
  const health = self.hp ?? guard.maxHp;
  const dieSeconds = incoming * theirShare > 0 ? health / (incoming * theirShare) : Infinity;
  return { killSeconds, dieSeconds, margin: dieSeconds / Math.max(killSeconds, 0.001) };
}

/**
 * How far off a creature notices a player, read from its brain: the widest
 * `in_los` or `in_range` that names the player tile. A bot that keeps beyond
 * it never wakes the creature at all, which beats any way of fighting it.
 */
export function noticeCells(def: TileDef | undefined): number {
  const brain = def ? resolveBrain(def) : null;
  let widest = 0;
  const visit = (node: BrainCondition) => {
    if (isConditionGroup(node)) {
      node.rules.forEach(visit);
      return;
    }
    if (node.cond !== "in_los" && node.cond !== "in_range") return;
    if (tilesNamedBy(node.of).includes(PLAYER_TILE_ID)) widest = Math.max(widest, node.cells);
  };
  for (const transition of brain?.transitions ?? []) visit(transition.if);
  return widest;
}

/**
 * Whether any of a creature's spells leaves its target walking slower, as a
 * snake's constriction does. Such a creature cannot be kited, because the
 * first bolt that lands stops the bot from keeping its distance.
 */
export function slowsItsTarget(
  def: TileDef | undefined,
  statusDefs: Record<string, StatusDef>,
): boolean {
  const battler = def ? resolveBattler(def) : null;
  return (battler?.spells ?? []).some(
    (spell) =>
      spell.effect.kind === "bolt" &&
      spell.effect.on === "target" &&
      (spell.effect.statuses ?? []).some(
        (grant) => (statusDefs[grant.id]?.walkSpeedPercent ?? 0) < 0,
      ),
  );
}

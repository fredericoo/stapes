import { rotationOdds, swingOdds } from "../app/game/combatMetrics";
import {
  effectiveBattler,
  HANDS,
  weaponSwungBy,
  type Equipment,
  type Hand,
} from "../app/game/equipment";
import type { ActorSnapshot } from "../app/game/GameSession";
import { PLAYER_TILE_ID } from "../app/game/constants";
import {
  advanceStatuses,
  withStatusModifiers,
  type StatusBearer,
  type StatusInstance,
} from "../app/game/statuses";
import { resolveBrain, tilesNamedBy, type BrainCondition } from "../app/lib/brain";
import { isConditionGroup } from "../app/lib/conditions";
import { resolveBattler, type BattlerDef, type FightingStats } from "../app/lib/battler";
import { MAX_PERCENT_STAT, type WeaponStatus } from "../app/lib/item";
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
    total += effect.damage * castsPerSecond(spell.cooldownMs);
  }
  return total;
}

/** How often a creature looses a spell: once a cooldown, and at most once a second. */
function castsPerSecond(cooldownMs: number): number {
  return 1000 / Math.max(1000, cooldownMs);
}

/**
 * A status a foe puts on the bot: one application of average length, how
 * many land a second, and `share`, the part of the fight the bot is
 * expected to spend under it.
 */
export type Affliction = {
  readonly instance: StatusInstance;
  readonly perSecond: number;
  readonly share: number;
};

/**
 * The statuses `foe` puts on the bot with its blows and its bolts, such as a
 * snake's poison and its paralysing constriction. A status's share is how
 * often it lands times how long it lasts, capped at the whole fight, so one
 * that stacks counts as no more than always on.
 */
export function afflictionsFrom(
  foe: Fighter,
  theirs: FightingStats,
  guard: FightingStats,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): Affliction[] {
  const load = new Map<string, { perSecond: number; meanMs: number }>();
  const add = (grant: WeaponStatus, perSecond: number) => {
    const def = statusDefs[grant.id];
    if (!def || perSecond <= 0) return;
    const meanMs = ((grant.fromMs ?? def.fromMs) + (grant.toMs ?? def.toMs)) / 2;
    const known = load.get(grant.id);
    load.set(grant.id, {
      perSecond: (known?.perSecond ?? 0) + perSecond,
      meanMs: Math.max(known?.meanMs ?? 0, meanMs),
    });
  };
  const blow = swingOdds(theirs, guard);
  theirs.statuses.forEach((grant, index) => {
    add(grant, ((blow.statuses[index]?.perSwing ?? 0) * 1000) / blow.intervalMs);
  });
  for (const spell of targetBolts(tilesById[foe.tileId])) {
    for (const grant of spell.statuses) {
      add(grant, (grant.chance / MAX_PERCENT_STAT) * castsPerSecond(spell.cooldownMs));
    }
  }
  return [...load].map(([defId, { perSecond, meanMs }]) => ({
    instance: { defId, durationMs: meanMs, remainingMs: meanMs, sinceEffectMs: 0 },
    perSecond,
    share: Math.min(1, (perSecond * meanMs) / 1000),
  }));
}

function targetBolts(
  def: TileDef | undefined,
): { cooldownMs: number; statuses: readonly WeaponStatus[] }[] {
  const battler = def ? resolveBattler(def) : null;
  return (battler?.spells ?? []).flatMap((spell) =>
    spell.effect.kind === "bolt" && spell.effect.on === "target"
      ? [{ cooldownMs: spell.cooldownMs, statuses: spell.effect.statuses ?? [] }]
      : [],
  );
}

/**
 * `figure` as the fight averages it: its value under no affliction, moved
 * towards its value under each one by that one's share. Each status is
 * weighed alone, so two that overlap are not compounded.
 */
function averagedOver(
  afflictions: readonly Affliction[],
  figure: (under: StatusInstance | null) => number,
): number {
  const clear = figure(null);
  let total = clear;
  for (const { instance, share } of afflictions) total += share * (figure(instance) - clear);
  return total;
}

/** Damage a second `swings` do to `defender`, none while `under` leaves the swinger unable to act. */
function afflictedDamagePerSecond(
  swings: readonly FightingStats[],
  defender: FightingStats,
  under: StatusInstance | null,
  statusDefs: Record<string, StatusDef>,
  hp: number,
): number {
  if (!under) return rotationOdds(swings, defender).damagePerSecond;
  if (statusDefs[under.defId]?.incapacitates) return 0;
  const afflicted = swings.map((swing) => withStatusModifiers(swing, [under], statusDefs, hp));
  return rotationOdds(afflicted, defender).damagePerSecond;
}

/**
 * Health a status will take from its bearer before it wears off, found by
 * running it for all of its remaining time. A status that mends counts as
 * nothing, so being fed never makes a bot braver.
 */
function drainOf(
  instance: StatusInstance,
  bearer: StatusBearer,
  statusDefs: Record<string, StatusDef>,
): number {
  if (!(instance.remainingMs > 0) || !Number.isFinite(instance.remainingMs)) return 0;
  const run = advanceStatuses([instance], instance.remainingMs, bearer, statusDefs);
  return run.hpChanges.reduce((sum, change) => sum + Math.max(0, -change.amount), 0);
}

/**
 * Health the afflictions landed over a fight of `killSeconds` will take in
 * all, the part that runs on after the foe is dead included. A status that
 * stacks lasts every application's length end to end; one that does not is
 * refreshed, so it lasts the fight and one application past it at most.
 */
function drainedBy(
  afflictions: readonly Affliction[],
  killSeconds: number,
  bearer: StatusBearer,
  statusDefs: Record<string, StatusDef>,
): number {
  let total = 0;
  for (const { instance, perSecond } of afflictions) {
    const stacks = statusDefs[instance.defId]?.stacks ?? false;
    const landedMs = perSecond * killSeconds * instance.durationMs;
    const underMs = stacks
      ? landedMs
      : Math.min(landedMs, killSeconds * 1000 + instance.durationMs);
    total += (drainOf(instance, bearer, statusDefs) * underMs) / instance.durationMs;
  }
  return total;
}

/**
 * The bot against `foes` all at once: it kills them one after the other
 * while all of them hit it, which is how a pack fight goes. `theirShare`
 * scales what they do to it, for a bot that keeps them at a distance.
 * What the foes' blows and bolts put on the bot (`afflictionsFrom`) changes
 * both sides' swings for the share of the fight it lasts. The health it will
 * drain, and what the statuses the bot already carries will drain, comes off
 * the bot's health before the fight starts: nothing mends a player between
 * fights, so poison that outlasts the snake still costs the bot that health.
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
  const health = self.hp ?? guard.maxHp;
  const theirSwings: FightingStats[] = [];
  for (const foe of foes) {
    const theirs = creatureSwing(foe, tilesById, statusDefs);
    if (!theirs) return null;
    theirSwings.push(theirs);
  }
  /** `mine` was built under the bot's statuses, so what it carries already counts. */
  const carried = new Set(self.statuses.map((instance) => instance.defId));
  const afflictions = foes
    .flatMap((foe, i) => afflictionsFrom(foe, theirSwings[i]!, guard, tilesById, statusDefs))
    .filter((affliction) => !carried.has(affliction.instance.defId));
  const bearer = { hp: health, maxHp: guard.maxHp, statuses: self.statuses };

  let killSeconds = 0;
  let incoming = 0;
  for (const [i, foe] of foes.entries()) {
    const theirs = theirSwings[i]!;
    const mineOnThem = averagedOver(afflictions, (under) =>
      afflictedDamagePerSecond(mine, theirs, under, statusDefs, health),
    );
    if (mineOnThem <= 0) return { killSeconds: Infinity, dieSeconds: 0, margin: 0 };
    killSeconds += (foe.hp ?? theirs.maxHp) / mineOnThem;
    const blows = averagedOver(
      afflictions,
      (under) =>
        rotationOdds(
          [theirs],
          under ? withStatusModifiers(guard, [under], statusDefs, health) : guard,
        ).damagePerSecond,
    );
    incoming += blows + spellDamagePerSecond(tilesById[foe.tileId]);
  }
  let drained = drainedBy(afflictions, killSeconds, bearer, statusDefs) * theirShare;
  for (const instance of self.statuses) drained += drainOf(instance, bearer, statusDefs);
  const left = health - drained;
  if (left <= 0) return { killSeconds, dieSeconds: 0, margin: 0 };
  incoming *= theirShare;
  const dieSeconds = incoming > 0 ? left / incoming : Infinity;
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

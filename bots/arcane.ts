import { castDurationMs, type CastSlot, type SpellButton } from "../app/game/casting";
import { affordsRecipe } from "../app/game/craft";
import { carriedLightTileIds, magicDormant, type Equipment } from "../app/game/equipment";
import { spellPower, type BattlerDef } from "../app/lib/battler";
import { effectiveness, type Element } from "../app/lib/element";
import type { CraftOutput, CraftRecipe } from "../app/lib/interactions";
import { MAX_CRAFT_CHANCE, resolveAddStatus, resolveCraft } from "../app/lib/interactions";
import {
  reachOf,
  resolveStone,
  resolveWeapon,
  type ArcaneStoneItem,
  type Reach,
} from "../app/lib/item";
import { meetsRequirements, spellElements, type Masteries } from "../app/lib/mastery";
import type { StatusDef } from "../app/lib/status";
import type { TileDef } from "../app/lib/types";

/**
 * Carrying a light is worth this much damage a second. A new character's
 * Spark does about 0.8 a second, so it keeps its torch; by Arcane 10 every
 * first-rung bolt does 1.0 to 1.2 and takes the accessory square instead.
 */
export const LIGHT_WORTH = 1;

/**
 * A stone that can be cast with nobody to aim at trains Arcane every time it
 * cools (`XP_PER_CAST`). That is worth this much, which is what puts a light
 * stone ahead of a torch.
 */
export const TRAINING_WORTH = 0.25;

const MS_PER_SECOND = 1000;

/** A bot recasts its light this long before the last one goes out. */
export const LIGHT_RENEW_MS = 10_000;

/** The stone in `def`, when it is one the bot can cast with its masteries now. */
export function usableStone(
  def: TileDef | undefined,
  masteries: Masteries,
): ArcaneStoneItem | null {
  const stone = def ? resolveStone(def) : null;
  if (!stone || magicDormant(def!, masteries)) return null;
  return meetsRequirements(masteries, stone.requirements) ? stone : null;
}

/** Health a bolt takes off somebody it is aimed at, on average, before the wheel; 0 for any other stone. */
export function boltDamage(stone: ArcaneStoneItem, masteries: Masteries): number {
  const { effect } = stone;
  if (effect.kind !== "bolt" || effect.on !== "target" || (effect.damage ?? 0) <= 0) return 0;
  return spellPower(effect.damage!, stone.requirements, masteries);
}

/** The statuses a stone puts on its own caster that light the room. */
export function lightStatuses(
  stone: ArcaneStoneItem,
  statusDefs: Record<string, StatusDef>,
): string[] {
  const { effect } = stone;
  if (effect.kind !== "bolt" || effect.on !== "caster") return [];
  return (effect.statuses ?? [])
    .filter((grant) => statusDefs[grant.id]?.vfx.light)
    .map((grant) => grant.id);
}

/**
 * The longest reach of a bolt held in either hand, or null when neither holds
 * one or either holds a weapon: a bot that casts from both hands fights from
 * as far off as an archer, and one with a sword walks up to swing it and
 * casts on the way.
 */
export function castingReach(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): Reach | null {
  const hands = ["weapon", "offhand"] as const;
  const armed = hands.some((hand) => {
    const def = tilesById[equipment[hand]?.tileId ?? ""];
    return def !== undefined && resolveWeapon(def) !== null;
  });
  if (armed) return null;
  let best: Reach | null = null;
  for (const hand of hands) {
    const stone = usableStone(tilesById[equipment[hand]?.tileId ?? ""], masteries);
    if (!stone || boltDamage(stone, masteries) <= 0) continue;
    const reach = reachOf(stone);
    if (!best || reach.cells > best.cells) best = reach;
  }
  return best;
}

/** A stone cast on its own caster, which needs nobody to aim at and lands on nobody else. */
export function onCaster(stone: ArcaneStoneItem): boolean {
  return stone.effect.kind === "bolt" && stone.effect.on === "caster";
}

/** Whether the stone can be cast at nobody: on its caster, or conjured on the cell ahead. */
function castsUnaimed(stone: ArcaneStoneItem): boolean {
  return stone.effect.kind === "conjure" || stone.effect.on === "caster";
}

/**
 * What a stone in a cast square is worth, in damage a second like a weapon:
 * a bolt's damage over the time between two casts, a light's worth for a
 * stone that lights its caster, and something for any stone that trains
 * Arcane on its own. A stone the bot cannot cast yet is worth nothing.
 */
export function stoneWorth(
  def: TileDef,
  masteries: Masteries,
  statusDefs: Record<string, StatusDef>,
): number {
  const stone = usableStone(def, masteries);
  if (!stone) return 0;
  const points = perSecond(boltDamage(stone, masteries), stone, masteries);
  const light = lightStatuses(stone, statusDefs).length > 0 ? LIGHT_WORTH : 0;
  return points + light + (castsUnaimed(stone) ? TRAINING_WORTH : 0);
}

/** `points` a cast, spread over the time from one cast of `stone` to the next. */
function perSecond(points: number, stone: ArcaneStoneItem, masteries: Masteries): number {
  const cycleMs = stone.cooldownMs + castDurationMs(stone, masteries);
  return (points * MS_PER_SECOND) / Math.max(1, cycleMs);
}

/**
 * Damage a second the bolts in the bot's cast squares add to its swings, each
 * over the time between two of its casts. The wheel is left out, as it is for
 * a swing.
 */
export function boltsPerSecond(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): number {
  let total = 0;
  for (const square of ["weapon", "offhand", "charm"] as const) {
    const stone = usableStone(tilesById[equipment[square]?.tileId ?? ""], masteries);
    if (!stone) continue;
    total += perSecond(boltDamage(stone, masteries), stone, masteries);
  }
  return total;
}

/** Whether the bot carries light, or wears a stone it can cast to make some. */
export function isLit(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  masteries: Masteries,
): boolean {
  if (carriedLightTileIds(equipment, tilesById).length > 0) return true;
  return (["weapon", "offhand", "charm"] as const).some((square) => {
    const stone = usableStone(tilesById[equipment[square]?.tileId ?? ""], masteries);
    return stone !== null && lightStatuses(stone, statusDefs).length > 0;
  });
}

type Button = Pick<SpellButton, "slot" | "tileId" | "castability">;

/**
 * The ready bolt that would hurt `foe` most: its damage, turned by the wheel
 * against what the foe is made of. Water before fire at a cave troll, and a
 * bolt the wheel resists only when it is still the hardest hit on offer.
 */
export function bestBolt(
  buttons: readonly Button[],
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
  foe: readonly Element[],
): CastSlot | null {
  let best: { slot: CastSlot; damage: number } | null = null;
  for (const button of buttons) {
    if (!button.castability.ok || !button.tileId) continue;
    const stone = usableStone(tilesById[button.tileId], masteries);
    if (!stone) continue;
    const elements = spellElements(stone.requirements);
    const damage = boltDamage(stone, masteries) * effectiveness(elements, foe);
    if (damage > 0 && (!best || damage > best.damage)) best = { slot: button.slot, damage };
  }
  return best?.slot ?? null;
}

/** The first ready stone that `pick` says yes to. */
export function readyStone(
  buttons: readonly Button[],
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
  pick: (stone: ArcaneStoneItem) => boolean,
): CastSlot | null {
  for (const button of buttons) {
    if (!button.castability.ok || !button.tileId) continue;
    const stone = usableStone(tilesById[button.tileId], masteries);
    if (stone && pick(stone)) return button.slot;
  }
  return null;
}

/** A conjure stone whose tile is in `tileIds`. */
export function conjures(tileIds: ReadonlySet<string>): (stone: ArcaneStoneItem) => boolean {
  return (stone) => stone.effect.kind === "conjure" && tileIds.has(stone.effect.tileId);
}

/** Tiles a creature walking in would rather not: those whose step puts a bad status on it. */
export function harmfulTileIds(
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): Set<string> {
  const out = new Set<string>();
  for (const def of Object.values(tilesById)) {
    const add = resolveAddStatus(def);
    if (add?.trigger === "step" && statusDefs[add.statusId]?.tone === "bad") out.add(def.id);
  }
  return out;
}

export type ForgeOrder = {
  readonly crafter: string;
  readonly index: number;
  readonly recipe: CraftRecipe;
};

/**
 * Every recipe whose outputs are all stones, by the tile that crafts it. The
 * stone forge is the only one authored, and nothing here names it.
 */
export function forgeRecipes(tilesById: Record<string, TileDef>): ForgeOrder[] {
  const out: ForgeOrder[] = [];
  for (const def of Object.values(tilesById)) {
    resolveCraft(def)?.recipes.forEach((recipe, index) => {
      const outputs = recipe.output.items.map((item) => tilesById[item.tileId]);
      if (outputs.every((output) => output && resolveStone(output))) {
        out.push({ crafter: def.id, index, recipe });
      }
    });
  }
  return out;
}

/** Everything that goes into a forge recipe, and every stone: what a bot keeps to forge with. */
export function forgeInputs(tilesById: Record<string, TileDef>): Set<string> {
  const out = new Set<string>();
  for (const { recipe } of forgeRecipes(tilesById)) {
    for (const input of recipe.inputs) out.add(input.tileId);
  }
  for (const def of Object.values(tilesById)) if (resolveStone(def)) out.add(def.id);
  return out;
}

/** What a forge recipe makes, on average, in the worth of one stone. */
function expectedWorth(output: CraftOutput, worth: (tileId: string) => number): number {
  if (output.kind === "all") {
    return output.items.reduce(
      (sum, item) => sum + (item.chance / MAX_CRAFT_CHANCE) * worth(item.tileId),
      0,
    );
  }
  const total = output.items.reduce((sum, item) => sum + item.weight, 0);
  return output.items.reduce((sum, item) => sum + (item.weight / total) * worth(item.tileId), 0);
}

/**
 * The forge recipes worth making now, with what the bot carries. Anything
 * that is not yet a stone is always worth forging into one, since a blank
 * does nothing. Stones are merged only when what comes out could be cast now
 * and is worth more, on average, than the best stone going in: two cinders in
 * two hands throw twice as often as one ember, and a stone that waits for a
 * mastery the bot has not got does nothing until then.
 */
export function forgeOrders(
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  equipment: Equipment,
  body: BattlerDef,
): ForgeOrder[] {
  const worth = (tileId: string) => {
    const def = tilesById[tileId];
    return def ? stoneWorth(def, body.masteries, statusDefs) : 0;
  };
  return forgeRecipes(tilesById).filter(({ recipe }) => {
    if (!affordsRecipe(tilesById, equipment, recipe)) return false;
    const stones = recipe.inputs.filter((input) => {
      const def = tilesById[input.tileId];
      return def !== undefined && resolveStone(def) !== null;
    });
    if (stones.length < recipe.inputs.length) return true;
    const gives = expectedWorth(recipe.output, worth);
    return gives > 0 && gives > Math.max(...stones.map((input) => worth(input.tileId)));
  });
}

/** Whether the bot carries a stone it cannot cast yet, which casting anything trains it towards. */
export function awaitsMastery(
  carried: readonly { tileId: string }[],
  tilesById: Record<string, TileDef>,
  masteries: Masteries,
): boolean {
  return carried.some(({ tileId }) => {
    const def = tilesById[tileId];
    return def !== undefined && resolveStone(def) !== null && !usableStone(def, masteries);
  });
}

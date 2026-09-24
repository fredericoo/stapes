import type { TradeSide } from "../lib/dialog";
import {
  MAX_CRAFT_CHANCE,
  type CraftInteraction,
  type CraftOutput,
  type CraftRecipe,
} from "../lib/interactions";
import type { MapFile, TileDef } from "../lib/types";
import { reachableCraftAt, type Actor, type ObjectRef } from "./affordances";
import type { Equipment } from "./equipment";
import { planTrade } from "./trade";

/**
 * Spending carried things at something that turns them into others — a forge,
 * a fire — with the dice deciding what comes back.
 *
 * **The board is not touched, and that is the whole shape.** Nothing is taken
 * off the map, nothing swaps, no cell patch goes out — the forge is still a
 * forge for the next person, exactly as an emptied chest is still a chest. What
 * changes is the kit of whoever used it, so every rule here is a rule about a
 * kit and this module never returns a map.
 *
 * **The kit arithmetic is a trade's.** Inputs are counted and peeled across
 * piles and squares, outputs pour onto piles and land worn-bag → hand-held
 * bags → off hand → weapon hand, all or nothing, never onto the floor — see
 * `./trade`. What a craft adds is the roll, and the one question the roll
 * raises: **room is checked for the worst outcome**, not the likely one, so a
 * recipe is never offered that could come up with something the body cannot
 * hold. A gamble that took your stones and then refused to hand over the prize
 * for want of a square would be the cruellest bug in the game.
 *
 * Pure, and read by both ends: the client to decide which recipes to list, the
 * server to validate the message it is sent. Being the same function is what
 * stops the client listing a recipe the server would refuse. Only the server
 * rolls — the client learns what came out of it from the kit it is sent back.
 */

/**
 * Stands in for the ids a check would mint. A check never keeps what it
 * builds, so the ids it hands out are never seen; a counter-free constant keeps
 * asking "could this run" from spending anything.
 */
const CHECK_ID = "craft-check";
const checkId = () => CHECK_ID;

/**
 * Every set of things this output could hand back, for the room check.
 *
 * An `all` output's worst case is every item at once — any roll is a subset of
 * it, and a body with room for all of them has room for fewer. A `one` output
 * has no single worst case, because two options may want different squares (a
 * stone fits a bag, a sword wants a hand), so each option is its own set and
 * every one has to fit.
 */
function possibleOutcomes(output: CraftOutput): string[][] {
  if (output.kind === "all") return [output.items.map((item) => item.tileId)];
  return output.items.map((item) => [item.tileId]);
}

/** One of each, as a trade side list — a pile of two is two sides of one. */
function sidesOf(tileIds: readonly string[]): TradeSide[] {
  return tileIds.map((tileId) => ({ tileId, count: 1 }));
}

/**
 * Could this body run this recipe, whatever the dice say?
 *
 * Asked against the kit with the inputs already gone, which is what makes the
 * ordinary case free: the square two cinders vacated is room for the ember.
 */
export function affordsRecipe(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  recipe: CraftRecipe,
): boolean {
  return possibleOutcomes(recipe.output).every(
    (outcome) => planTrade(tilesById, equipment, recipe.inputs, sidesOf(outcome), checkId) !== null,
  );
}

/**
 * The recipe at this index and the block it belongs to, if this actor can
 * reach the crafter and afford it, or null.
 *
 * Every refusal is null and none of them is distinguished, on a reward's terms:
 * out of reach, nothing to spend, no room for the worst outcome, or an index
 * past the end. An index is addressed by position because both ends hold the
 * same tile catalogue — see `SlotRef` for the same argument.
 */
export function craftableRecipe(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  index: number,
): { craft: CraftInteraction; recipe: CraftRecipe } | null {
  const craft = reachableCraftAt(map, tilesById, actor, ref);
  const recipe = craft?.recipes[index];
  if (!craft || !recipe) return null;
  return affordsRecipe(tilesById, equipment, recipe) ? { craft, recipe } : null;
}

/** Could this actor run this recipe right now? @see craftableRecipe */
export function canCraftFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  index: number,
): boolean {
  return craftableRecipe(map, tilesById, actor, equipment, ref, index) != null;
}

/** A recipe this body can afford, with the position it was authored at. */
export type OfferedRecipe = { index: number; recipe: CraftRecipe };

/**
 * An open crafting window: which crafter, and what it currently offers.
 *
 * Built by the render loop from {@link offeredRecipes} and handed to the page,
 * so the window is drawn from the same rule that offered its row and closes
 * the moment that rule stops answering.
 */
export type CraftingWindow = {
  ref: ObjectRef;
  /** The crafter's tile, for the window's sprite and title. */
  tileId: string;
  craft: CraftInteraction;
  recipes: OfferedRecipe[];
};

/**
 * The crafter at this slot and every recipe on it the actor could run right
 * now, or null when it is out of reach or offers them nothing.
 *
 * **Only the affordable ones**, so the window never lists a recipe for
 * something the player is not carrying: the menu is what you could make, not
 * what forges can do. And a crafter with nothing affordable is null rather than
 * an empty list, which is what keeps its row off the interaction list — a forge
 * you have nothing to forge at reads as a forge rather than as a button that
 * opens an empty window.
 */
export function offeredRecipes(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
): { craft: CraftInteraction; recipes: OfferedRecipe[] } | null {
  const craft = reachableCraftAt(map, tilesById, actor, ref);
  if (!craft) return null;
  const recipes: OfferedRecipe[] = [];
  craft.recipes.forEach((recipe, index) => {
    if (affordsRecipe(tilesById, equipment, recipe)) recipes.push({ index, recipe });
  });
  return recipes.length > 0 ? { craft, recipes } : null;
}

/**
 * What one run of this output actually hands back, in the order the author
 * wrote it.
 *
 * **A fixed number of draws, whatever comes up** — one per item for `all`, one
 * for `one` — on `rollExtract`'s terms: a draw skipped because of an earlier
 * result would make one player's luck change what the next player rolled, and
 * a reproducible world is the whole point of seeded dice.
 *
 * An `all` output may legitimately come back empty. That is the gamble: the
 * inputs are spent either way.
 */
export function rollCraft(output: CraftOutput, random: () => number): string[] {
  if (output.kind === "all") {
    return output.items.flatMap((item) =>
      random() * MAX_CRAFT_CHANCE < item.chance ? [item.tileId] : [],
    );
  }
  const total = output.items.reduce((sum, item) => sum + item.weight, 0);
  let pick = random() * total;
  for (const item of output.items) {
    pick -= item.weight;
    if (pick < 0) return [item.tileId];
  }
  // Only reachable through float rounding on the last option's upper edge.
  return [output.items[output.items.length - 1]!.tileId];
}

/** A recipe that has been run: the kit left behind, and what the dice gave. */
export type CraftResult = { equipment: Equipment; made: string[] };

/**
 * Spend the inputs, roll, and file what came out — or null when the body can
 * no longer pay.
 *
 * The roll happens before the kit is touched and is not repeated, so a null
 * here costs a draw and nothing else. It should never be null for a recipe that
 * passed {@link craftableRecipe}, since the worst case was already found room
 * for; the check is kept because a refusal that leaves the kit alone is the
 * safe way to be wrong.
 */
export function runCraft(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  recipe: CraftRecipe,
  random: () => number,
  mintId: () => string,
): CraftResult | null {
  const made = rollCraft(recipe.output, random);
  const next = planTrade(tilesById, equipment, recipe.inputs, sidesOf(made), mintId);
  return next ? { equipment: next, made } : null;
}

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

const CHECK_ID = "craft-check";
const checkId = () => CHECK_ID;

function possibleOutcomes(output: CraftOutput): string[][] {
  if (output.kind === "all") return [output.items.map((item) => item.tileId)];
  return output.items.map((item) => [item.tileId]);
}

function sidesOf(tileIds: readonly string[]): TradeSide[] {
  return tileIds.map((tileId) => ({ tileId, count: 1 }));
}

export function affordsRecipe(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  recipe: CraftRecipe,
): boolean {
  return possibleOutcomes(recipe.output).every(
    (outcome) => planTrade(tilesById, equipment, recipe.inputs, sidesOf(outcome), checkId) !== null,
  );
}

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

export type OfferedRecipe = { index: number; recipe: CraftRecipe };

export type CraftingWindow = {
  ref: ObjectRef;
  tileId: string;
  craft: CraftInteraction;
  recipes: OfferedRecipe[];
};

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
  /** Only reachable through float rounding on the last option's upper edge. */
  return [output.items[output.items.length - 1]!.tileId];
}

export type CraftResult = { equipment: Equipment; made: string[] };

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

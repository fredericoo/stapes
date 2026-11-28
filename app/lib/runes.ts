import type { Element } from "./element";

export type RuneMaterial = "bone" | "crystal" | "obsidian";

export type RuneEssence = Element | "neutral";

export type RuneKind = { material: RuneMaterial; essence: RuneEssence };

/**
 * Which blank every rune is carved from and which essence decides it. The
 * runemaster's carving pools in `data/tiles.json` are checked against this,
 * and `scripts/generate-runes.ts` draws each rune's base and mark from it.
 */
export const RUNE_KINDS: Readonly<Record<string, RuneKind>> = {
  "rune-light": { material: "bone", essence: "neutral" },
  "rune-spark": { material: "bone", essence: "neutral" },
  "rune-flame": { material: "bone", essence: "fire" },
  "rune-cinder": { material: "bone", essence: "fire" },
  "rune-sleet": { material: "bone", essence: "water" },
  "rune-barbs": { material: "bone", essence: "nature" },

  "rune-bolt": { material: "crystal", essence: "neutral" },
  "rune-lance": { material: "crystal", essence: "neutral" },
  "rune-ember": { material: "crystal", essence: "fire" },
  "rune-pyre": { material: "crystal", essence: "fire" },
  "rune-frost": { material: "crystal", essence: "water" },
  "rune-rime": { material: "crystal", essence: "water" },
  "rune-thorns": { material: "crystal", essence: "nature" },
  "rune-bramble": { material: "crystal", essence: "nature" },
  "rune-verdance": { material: "crystal", essence: "nature" },
  "rune-bloom": { material: "crystal", essence: "nature" },

  "rune-stomp": { material: "obsidian", essence: "neutral" },
  "rune-inferno": { material: "obsidian", essence: "fire" },
  "rune-berserk": { material: "obsidian", essence: "fire" },
  "rune-shatter": { material: "obsidian", essence: "water" },
  "rune-crystallise": { material: "obsidian", essence: "water" },
  "rune-overgrowth": { material: "obsidian", essence: "nature" },
  "rune-blossom": { material: "obsidian", essence: "nature" },
};

export const BLANK_OF: Readonly<Record<RuneMaterial, string>> = {
  bone: "rune-blank-bone",
  crystal: "rune-blank-crystal",
  obsidian: "rune-blank-obsidian",
};

export const ESSENCE_OF: Readonly<Record<Element, string>> = {
  fire: "essence-fire",
  water: "essence-water",
  nature: "essence-nature",
};

/**
 * Runes nobody carves: each is found once, in one place in the world, so it
 * has no blank and is in no carving pool. The essence is what casting it needs.
 */
export const LEGENDARY_RUNES: Readonly<Record<string, { essence: RuneEssence }>> = {
  "rune-glacier": { essence: "water" },
};

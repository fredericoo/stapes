import { describe, expect, it } from "vitest";
import { DEFAULT_ARTIFACT, DEFAULT_CONTAINER } from "../lib/item";
import { xpForLevel } from "../lib/mastery";
import { tile } from "../lib/testTile";
import type { TileDef } from "../lib/types";
import { deathCost } from "./deathCost";
import { type Equipment, emptyEquipment } from "./equipment";

const tilesById: Record<string, TileDef> = {
  "basic-bag": tile({
    id: "basic-bag",
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER } },
  }),
  torch: tile({ id: "torch", kind: "item", interactions: { item: { ...DEFAULT_ARTIFACT } } }),
};

const PACK = { id: "itm_pack", tileId: "basic-bag", contents: [] };
const TORCH = { id: "itm_torch", tileId: "torch" };

const packed: Equipment = { ...emptyEquipment(), bag: PACK };

describe("deathCost", () => {
  it("names each mastery that dropped a level, and where it went", () => {
    const cost = deathCost(
      { equipment: packed, masteryXp: { sharp: xpForLevel(10), agility: xpForLevel(10) + 30 } },
      { equipment: packed, masteryXp: { sharp: xpForLevel(9), agility: xpForLevel(10) + 10 } },
      tilesById,
    );

    expect(cost.levelsLost).toEqual([{ mastery: "sharp", from: 10, to: 9 }]);
  });

  it("says a pack was left only when one went, from the back or from a hand", () => {
    const left = (before: Equipment, after: Equipment) =>
      deathCost(
        { equipment: before, masteryXp: {} },
        { equipment: after, masteryXp: {} },
        tilesById,
      ).packLeft;
    const bare = emptyEquipment();
    const held = { ...bare, offhand: PACK, weapon: TORCH };

    expect(left(packed, bare)).toBe(true);
    expect(left(held, { ...bare, weapon: TORCH })).toBe(true);
    expect(left(packed, packed)).toBe(false);
    expect(left({ ...bare, weapon: TORCH }, bare)).toBe(false);
  });
});

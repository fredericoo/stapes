import { describe, expect, it } from "vitest";
import { resolveBattler } from "../lib/battler";
import { ELEMENTS } from "../lib/element";
import { resolveCraft, type CraftRecipe } from "../lib/interactions";
import { resolveStone } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import { BLANK_OF, ESSENCE_OF, LEGENDARY_RUNES, RUNE_KINDS, type RuneKind } from "../lib/runes";
import type { MapFile } from "../lib/types";
import type { ObjectRef } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { shippedTiles } from "./testShippedTiles";
import { tilesByIdFromList } from "../lib/validation";

const tiles = shippedTiles();

const BESIDE = { x: 0, y: 1, z: 0 };
const AT_THE_PROP: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

function boardWith(tileId: string): MapFile {
  let map = emptyMap();
  for (let x = -1; x <= 3; x++) {
    for (let y = -1; y <= 3; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, -1, -1, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function carrying(piles: Record<string, number>): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: "leather-backpack",
      contents: Object.entries(piles).map(([tileId, count], i) => ({
        id: `itm_${i}`,
        tileId,
        ...(count > 1 ? { count } : {}),
      })),
    },
  };
}

function piles(equipment: Equipment | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of equipment?.bag?.contents ?? []) {
    out[item.tileId] = (out[item.tileId] ?? 0) + (item.count ?? 1);
  }
  return out;
}

describe("shaping a blank at a rune forge", () => {
  const forges = [
    { forge: "bone-forge", material: "bone", cost: 3, blank: "rune-blank-bone" },
    { forge: "crystal-forge", material: "arcane-shard", cost: 4, blank: "rune-blank-crystal" },
    { forge: "obsidian-forge", material: "obsidian-shard", cost: 5, blank: "rune-blank-obsidian" },
  ];
  const everyMaterial = { bone: 6, "arcane-shard": 6, "obsidian-shard": 6 };

  it.each(forges)("$forge spends $cost $material on one $blank, and no other material", (row) => {
    const session = new GameSession(boardWith(row.forge), tiles);
    session.spawn("shaper", { at: BESIDE, carrying: carrying(everyMaterial) });

    expect(session.craft(AT_THE_PROP, 0, "shaper")).toBe(true);
    expect(piles(session.equipmentOf("shaper"))).toEqual({
      ...everyMaterial,
      [row.material]: 6 - row.cost,
      [row.blank]: 1,
    });
  });

  it.each(forges)("$forge refuses one $material short of its cost", (row) => {
    const session = new GameSession(boardWith(row.forge), tiles);
    session.spawn("shaper", {
      at: BESIDE,
      carrying: carrying({ ...everyMaterial, [row.material]: row.cost - 1 }),
    });

    expect(session.craft(AT_THE_PROP, 0, "shaper")).toBe(false);
  });
});

const tilesById = tilesByIdFromList(tiles);
const carving = resolveCraft(tilesById["hesper-vaun"]!)!;

function kindOf(recipe: CraftRecipe): RuneKind {
  const taken = recipe.inputs.map((input) => input.tileId);
  const material = (Object.keys(BLANK_OF) as RuneKind["material"][]).find((m) =>
    taken.includes(BLANK_OF[m]),
  )!;
  const essence = ELEMENTS.find((element) => taken.includes(ESSENCE_OF[element])) ?? "neutral";
  return { material, essence };
}

describe("the runemaster's carving pools", () => {
  it("carve every rune from the one blank and essence the rune table gives it", () => {
    expect(carving.recipes).toHaveLength(12);
    const carvedFrom = new Map<string, RuneKind>();
    for (const recipe of carving.recipes) {
      expect(recipe.output.kind, recipe.name).toBe("one");
      for (const { tileId } of recipe.output.items) {
        expect(carvedFrom.has(tileId), `${tileId} is in two pools`).toBe(false);
        carvedFrom.set(tileId, kindOf(recipe));
      }
    }
    const runes = tiles.filter((t) => resolveStone(t) && t.id.startsWith("rune-"));
    expect(Object.fromEntries(carvedFrom)).toEqual(RUNE_KINDS);
    expect(runes.map((t) => t.id).sort()).toEqual(
      [...Object.keys(RUNE_KINDS), ...Object.keys(LEGENDARY_RUNES)].sort(),
    );
  });

  it("put a rune under an element only when casting it needs that element", () => {
    for (const [tileId, { essence }] of Object.entries({ ...RUNE_KINDS, ...LEGENDARY_RUNES })) {
      const needs = ELEMENTS.filter(
        (e) => (resolveStone(tilesById[tileId]!)?.requirements?.[e] ?? 0) > 0,
      );
      if (essence === "neutral") expect(needs, tileId).toEqual([]);
      else expect(needs, tileId).toContain(essence);
    }
  });
});

describe("carving at the runemaster", () => {
  const boneWithFire = carving.recipes.findIndex(
    (recipe) => kindOf(recipe).material === "bone" && kindOf(recipe).essence === "fire",
  );

  function atHesper(kit: Record<string, number>): GameSession {
    const session = new GameSession(boardWith("hesper-vaun"), tiles);
    session.spawn("carver", { at: BESIDE, carrying: carrying(kit) });
    return session;
  }

  function hesperRef(session: GameSession): ObjectRef {
    const at = session.actorSnapshots().find((a) => a.tileId === "hesper-vaun")!;
    return { x: at.x, y: at.y, z: at.z, stackIndex: at.stackIndex };
  }

  it("takes a bone blank, a fire essence and ten gold for one crude fire rune", () => {
    const session = atHesper({ "rune-blank-bone": 1, "essence-fire": 1, gold: 15 });

    expect(session.craft(hesperRef(session), boneWithFire, "carver")).toBe(true);
    const left = piles(session.equipmentOf("carver"));
    const rune = Object.keys(left).find((id) => id.startsWith("rune-"))!;
    expect(RUNE_KINDS[rune]).toEqual({ material: "bone", essence: "fire" });
    expect(left).toEqual({ gold: 5, [rune]: 1 });
  });

  it("refuses a carving the player cannot pay for, and keeps the blank", () => {
    const kit = { "rune-blank-bone": 1, "essence-fire": 1, gold: 9 };
    const session = atHesper(kit);

    expect(session.craft(hesperRef(session), boneWithFire, "carver")).toBe(false);
    expect(piles(session.equipmentOf("carver"))).toEqual(kit);
  });
});

describe("what a creature drops", () => {
  const creatures = tiles.flatMap((def) => {
    const battler = resolveBattler(def);
    return battler && def.interactions?.respawn ? [{ id: def.id, battler }] : [];
  });
  const kitIds = (battler: NonNullable<ReturnType<typeof resolveBattler>>) =>
    (battler.kit ?? []).flatMap((entry) => [
      entry.tileId,
      ...(entry.contents ?? []).map((c) => c.tileId),
    ]);

  it("is never a rune", () => {
    for (const { id, battler } of creatures) {
      expect(
        kitIds(battler).filter((tileId) => tileId in RUNE_KINDS || tileId in LEGENDARY_RUNES),
        id,
      ).toEqual([]);
    }
  });

  it("is an essence of each of its own elements, carried in a bag that always rolls", () => {
    for (const { id, battler } of creatures) {
      const bag = (battler.kit ?? []).find((entry) => entry.slot === "bag" && entry.chance === 100);
      const essences = (bag?.contents ?? [])
        .map((c) => c.tileId)
        .filter((tileId) => tileId.startsWith("essence-"));
      expect(essences, id).toEqual((battler.elements ?? []).map((e) => ESSENCE_OF[e]));
      expect(
        kitIds(battler).filter((t) => t.startsWith("essence-")),
        id,
      ).toEqual(essences);
    }
  });
});

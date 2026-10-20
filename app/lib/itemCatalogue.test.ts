import { describe, expect, it } from "vitest";
import { DEFAULT_WEAPON, type ItemDef } from "./item";
import { catalogueEntries, EMPTY_QUERY, matchesQuery, type CatalogueQuery } from "./itemCatalogue";
import type { TileDef } from "./types";

function item(id: string, name: string, def: ItemDef): TileDef {
  return { id, name, kind: "item", interactions: { item: def } } as TileDef;
}

const TILES: TileDef[] = [
  item("ember-blade", "Ember Blade", { ...DEFAULT_WEAPON, elements: ["fire"] }),
  item("pelt", "Pelt", { type: "artifact" }),
  item("kindle", "Kindle", {
    type: "stone",
    effect: { kind: "bolt", on: "target", damage: 3 },
    cooldownMs: 1000,
    requirements: { arcane: 5, fire: 1 },
  }),
  item("bread", "Bread", { type: "consumable", hp: 3 }),
  {
    id: "hare",
    name: "Hare",
    kind: "battler",
    interactions: {
      battler: {
        baseHp: 4,
        masteries: {},
        naturalWeapon: DEFAULT_WEAPON,
        kit: [{ slot: "weapon", tileId: "pelt", chance: 40 }],
      },
    },
  } as TileDef,
];

const ENTRIES = catalogueEntries(TILES, {}, "player");

function ids(query: Partial<CatalogueQuery>): string[] {
  return ENTRIES.filter((entry) => matchesQuery(entry, { ...EMPTY_QUERY, ...query })).map(
    (entry) => entry.tile.id,
  );
}

describe("matchesQuery", () => {
  it("lists only items, in catalogue order", () => {
    expect(ids({})).toEqual(["ember-blade", "pelt", "kindle", "bread"]);
  });

  it("finds an item by the creature that drops it", () => {
    expect(ids({ text: "hare" })).toEqual(["pelt"]);
  });

  it("needs every word of the search to match", () => {
    expect(ids({ text: "ember fire" })).toEqual(["ember-blade"]);
    expect(ids({ text: "fire", category: "stone" })).toEqual(["kindle"]);
    expect(ids({ text: "ember water" })).toEqual([]);
  });

  it("narrows by type, element and where it comes from together", () => {
    expect(ids({ category: "consumable" })).toEqual(["bread"]);
    expect(ids({ element: "fire" })).toEqual(["ember-blade", "kindle"]);
    expect(ids({ origin: "drop" })).toEqual(["pelt"]);
    expect(ids({ origin: "drop", category: "weapon" })).toEqual([]);
  });
});

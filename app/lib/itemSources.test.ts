import { describe, expect, it } from "vitest";
import { DEFAULT_WEAPON } from "./item";
import { itemSources } from "./itemSources";
import type { TileDef } from "./types";

function item(id: string): TileDef {
  return {
    id,
    name: id,
    kind: "item",
    interactions: { item: { type: "artifact" } },
  } as TileDef;
}

function tile(id: string, kind: TileDef["kind"], interactions: object): TileDef {
  return { id, name: id, kind, interactions } as TileDef;
}

const BATTLER = { baseHp: 8, masteries: {}, naturalWeapon: DEFAULT_WEAPON };

describe("itemSources", () => {
  it("lists a shop's trade under what it gives and what it takes", () => {
    const tiles = [
      item("shard"),
      item("sword"),
      tile("smith", "prop", {
        dialog: {
          script: [
            {
              kind: "request_trade",
              take: [{ tileId: "shard", count: 20 }],
              give: [{ tileId: "sword", count: 1 }],
              min: 1,
              max: 1,
              traded: [],
              cancel: [],
            },
          ],
        },
      }),
    ];
    const sources = itemSources(tiles, "player");
    expect(sources.get("sword")!.obtained).toEqual([
      {
        kind: "trade",
        at: "smith",
        name: null,
        take: [{ tileId: "shard", count: 20, chance: null }],
        give: [{ tileId: "sword", count: 1, chance: null }],
      },
    ]);
    expect(sources.get("shard")!.usedIn).toEqual(sources.get("sword")!.obtained);
  });

  it("gives a weighted craft output its share of the total as a chance", () => {
    const tiles = [
      item("blank"),
      item("common"),
      item("rare"),
      tile("forge", "prop", {
        craft: {
          recipes: [
            {
              name: "Forge",
              inputs: [{ tileId: "blank", count: 1 }],
              output: {
                kind: "one",
                items: [
                  { tileId: "common", weight: 3 },
                  { tileId: "rare", weight: 1 },
                ],
              },
            },
          ],
        },
      }),
    ];
    const give = itemSources(tiles, "player").get("rare")!.obtained[0]!.give;
    expect(give.map((side) => side.chance)).toEqual([75, 25]);
  });

  it("reads a kit naming one item twice as the chance of at least one", () => {
    const tiles = [
      item("meat"),
      tile("deer", "battler", {
        battler: {
          ...BATTLER,
          kit: [
            { slot: "weapon", tileId: "meat", chance: 50 },
            { slot: "offhand", tileId: "meat", chance: 50 },
          ],
        },
      }),
    ];
    expect(itemSources(tiles, "player").get("meat")!.finds).toEqual([
      { kind: "drop", from: "deer", chance: 75 },
    ]);
  });

  it("counts what is in a bag only as often as the bag is carried", () => {
    const tiles = [
      item("bag"),
      item("skin"),
      tile("rabbit", "battler", {
        battler: {
          ...BATTLER,
          kit: [
            {
              slot: "bag",
              tileId: "bag",
              chance: 50,
              contents: [{ tileId: "skin", chance: 50 }],
            },
          ],
        },
      }),
    ];
    expect(itemSources(tiles, "player").get("skin")!.finds[0]!.chance).toBe(25);
  });

  it("calls the player's kit what everybody starts with, and lists it first", () => {
    const kit = [{ slot: "armor", tileId: "tunic", chance: 100 }];
    const tiles = [
      item("tunic"),
      tile("guard", "battler", { battler: { ...BATTLER, kit } }),
      tile("player", "battler", { battler: { ...BATTLER, kit } }),
    ];
    expect(
      itemSources(tiles, "player")
        .get("tunic")!
        .finds.map((find) => find.kind),
    ).toEqual(["start", "drop"]);
  });
});

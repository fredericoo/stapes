import { describe, expect, it } from "vitest";
import {
  craftRecipeName,
  craftVerb,
  interactionKinds,
  interactionsForSave,
  resolveCraft,
  type CraftInteraction,
  type CraftOutput,
} from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { canCraftFrom, offeredRecipes, rollCraft } from "./craft";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: { frames: [] },
    ...partial,
  });
}

const EDIBLE = { type: "consumable", label: "Eat", hp: 1 } as const;
const PILED = { type: "artifact", pile: 99 } as const;

const BAG_TILE_ID = "basic-bag";
const BAG_SIZE = 4;

const FORGE_RECIPES: CraftInteraction = {
  actionName: "Forge",
  recipes: [
    {
      name: "Forge a blank stone",
      inputs: [{ tileId: "blank", count: 1 }],
      output: {
        kind: "one",
        items: [
          { tileId: "spark", weight: 3 },
          { tileId: "cinder", weight: 1 },
        ],
      },
    },
    {
      name: "Forge Ember",
      inputs: [{ tileId: "cinder", count: 2 }],
      output: { kind: "all", items: [{ tileId: "ember", chance: 100 }] },
    },
    {
      name: "Forge Verdance",
      inputs: [
        { tileId: "cinder", count: 1 },
        { tileId: "spark", count: 1 },
      ],
      output: { kind: "all", items: [{ tileId: "verdance", chance: 100 }] },
    },
    {
      name: "",
      inputs: [{ tileId: "ember", count: 1 }],
      output: { kind: "all", items: [{ tileId: "pyre", chance: 1 }] },
    },
  ],
};

const tiles = [
  tile({ id: "grass" }),
  tile({ id: "player", height: 4, kind: "battler", actor: true }),
  tile({ id: "blank", name: "Blank", kind: "item", interactions: { item: PILED } }),
  tile({ id: "spark", name: "Spark", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "cinder", name: "Cinder", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "ember", name: "Ember", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "pyre", name: "Pyre", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "verdance", name: "Verdance", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "raw-meat", name: "Raw Meat", kind: "item", interactions: { item: EDIBLE } }),
  tile({ id: "cooked-meat", name: "Cooked Meat", kind: "item", interactions: { item: EDIBLE } }),
  tile({
    id: BAG_TILE_ID,
    name: "Bag",
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: BAG_SIZE } },
  }),
  tile({ id: "forge", name: "Forge", interactions: { craft: FORGE_RECIPES } }),
  tile({
    id: "butcher",
    name: "Butcher",
    interactions: {
      craft: {
        recipes: [
          {
            name: "Butcher",
            inputs: [{ tileId: "raw-meat", count: 1 }],
            output: {
              kind: "all",
              items: [
                { tileId: "ember", chance: 100 },
                { tileId: "ember", chance: 50 },
                { tileId: "ember", chance: 50 },
              ],
            },
          },
        ],
      },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const BESIDE = { x: 0, y: 1, z: 0 };
const FORGE: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const FAR: ObjectRef = { x: 4, y: 4, z: 0, stackIndex: 1 };
const RECIPE = { blank: 0, ember: 1, verdance: 2, pyre: 3 } as const;

function board(tileId = "forge"): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= 4; x++) {
    for (let y = 0; y <= 4; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
  map = replaceStack(map, 4, 4, 0, [{ tileId: "grass" }, { tileId }]);
  return map;
}

function carrying(...contents: string[]): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: BAG_TILE_ID,
      contents: contents.map((tileId, i) => ({ id: `itm_${i}`, tileId })),
    },
  };
}

function bagTiles(equipment: Equipment | null | undefined): string[] {
  return equipment?.bag?.contents?.map((item) => item.tileId) ?? [];
}

const ACTOR = { x: 0, y: 1, z: 0 };

describe("resolving a crafter", () => {
  it("is nothing on a tile with no block", () => {
    expect(resolveCraft(tilesById.grass!)).toBeNull();
  });

  it("reads every recipe in authored order", () => {
    expect(resolveCraft(tilesById.forge!)?.recipes.map((r) => r.name)).toEqual([
      "Forge a blank stone",
      "Forge Ember",
      "Forge Verdance",
      "",
    ]);
  });

  it("drops a malformed recipe and keeps the rest", () => {
    const patchy = tile({
      id: "patchy",
      interactions: {
        craft: {
          recipes: [
            { name: "No inputs", inputs: [], output: FORGE_RECIPES.recipes[1]!.output },
            {
              name: "Bad chance",
              inputs: [{ tileId: "a", count: 1 }],
              output: { kind: "all", items: [{ tileId: "b", chance: 0 }] },
            },
            FORGE_RECIPES.recipes[1],
          ],
        },
      },
    });
    expect(resolveCraft(patchy)?.recipes.map((r) => r.name)).toEqual(["Forge Ember"]);
  });

  it("is not a crafter once every recipe has been dropped", () => {
    const empty = tile({ id: "empty", interactions: { craft: { recipes: [] } } });
    expect(resolveCraft(empty)).toBeNull();
  });

  it("is a player-activated kind", () => {
    expect(interactionKinds(tilesById.forge!)).toEqual(["craft"]);
  });

  it("falls back to the tile's verb, and to Craft behind that", () => {
    const forge = resolveCraft(tilesById.forge!)!;
    expect(craftVerb(forge)).toBe("Forge");
    expect(craftVerb({ recipes: forge.recipes })).toBe("Craft");
    expect(craftRecipeName(forge, forge.recipes[RECIPE.pyre]!)).toBe("Forge");
    expect(craftRecipeName(forge, forge.recipes[RECIPE.ember]!)).toBe("Forge Ember");
  });
});

describe("saving a crafter", () => {
  it("drops half-authored recipes, inputs and outputs, and a blank verb", () => {
    const saved = interactionsForSave({
      craft: {
        actionName: "  ",
        recipes: [
          {
            name: " Cook ",
            inputs: [
              { tileId: "raw-meat", count: 1 },
              { tileId: "", count: 1 },
            ],
            output: {
              kind: "all",
              items: [
                { tileId: "cooked-meat", chance: 100 },
                { tileId: " ", chance: 100 },
              ],
            },
          },
          {
            name: "Nothing in",
            inputs: [{ tileId: "", count: 1 }],
            output: FORGE_RECIPES.recipes[1]!.output,
          },
        ],
      },
    })?.craft;

    expect(saved).toEqual({
      recipes: [
        {
          name: "Cook",
          inputs: [{ tileId: "raw-meat", count: 1 }],
          output: { kind: "all", items: [{ tileId: "cooked-meat", chance: 100 }] },
        },
      ],
    });
  });

  it("writes only the number its output kind reads", () => {
    const drifted: CraftOutput = {
      kind: "one",
      items: [Object.assign({ tileId: "spark", weight: 2 }, { chance: 40 })],
    };
    const saved = interactionsForSave({
      craft: { recipes: [{ name: "x", inputs: [{ tileId: "blank", count: 1 }], output: drifted }] },
    })?.craft;
    expect(saved?.recipes[0]?.output).toEqual({
      kind: "one",
      items: [{ tileId: "spark", weight: 2 }],
    });
  });

  it("goes entirely once nothing in it would survive", () => {
    expect(
      interactionsForSave({
        craft: { recipes: [{ name: "", inputs: [], output: { kind: "all", items: [] } }] },
      }),
    ).toBeUndefined();
  });
});

describe("what a crafter offers", () => {
  it("offers only the recipes the kit can pay for", () => {
    const offered = offeredRecipes(board(), tilesById, ACTOR, carrying("cinder", "cinder"), FORGE);
    expect(offered?.recipes.map((r) => r.index)).toEqual([RECIPE.ember]);
  });

  it("counts an input across a pile and loose squares alike", () => {
    const piled: Equipment = {
      ...emptyEquipment(),
      bag: {
        id: "itm_bag",
        tileId: BAG_TILE_ID,
        contents: [{ id: "itm_0", tileId: "blank", count: 3 }],
      },
    };
    expect(canCraftFrom(board(), tilesById, ACTOR, piled, FORGE, RECIPE.blank)).toBe(true);
  });

  it("needs every kind of input a mixed recipe names", () => {
    expect(
      canCraftFrom(board(), tilesById, ACTOR, carrying("cinder"), FORGE, RECIPE.verdance),
    ).toBe(false);
    expect(
      canCraftFrom(board(), tilesById, ACTOR, carrying("cinder", "spark"), FORGE, RECIPE.verdance),
    ).toBe(true);
  });

  it("is nothing at all to somebody with nothing to spend", () => {
    expect(offeredRecipes(board(), tilesById, ACTOR, carrying("raw-meat"), FORGE)).toBeNull();
  });

  it("is nothing from too far away", () => {
    expect(offeredRecipes(board(), tilesById, ACTOR, carrying("cinder", "cinder"), FAR)).toBeNull();
  });

  it("is refused when the worst roll could not be held", () => {
    const tight: Equipment = {
      ...carrying("raw-meat", "spark", "spark", "spark"),
      weapon: { id: "itm_w", tileId: "spark" },
      offhand: { id: "itm_o", tileId: "spark" },
    };
    expect(canCraftFrom(board("butcher"), tilesById, ACTOR, tight, FORGE, 0)).toBe(false);
    expect(canCraftFrom(board("butcher"), tilesById, ACTOR, carrying("raw-meat"), FORGE, 0)).toBe(
      true,
    );
  });
});

describe("rolling", () => {
  const ALL: CraftOutput = {
    kind: "all",
    items: [
      { tileId: "a", chance: 100 },
      { tileId: "b", chance: 50 },
    ],
  };
  const ONE: CraftOutput = {
    kind: "one",
    items: [
      { tileId: "a", weight: 1 },
      { tileId: "b", weight: 3 },
    ],
  };

  function sequence(...values: number[]) {
    let i = 0;
    return () => values[i++] ?? 0;
  }

  it("rolls every all-of item on its own", () => {
    expect(rollCraft(ALL, sequence(0.99, 0.49))).toEqual(["a", "b"]);
    expect(rollCraft(ALL, sequence(0.99, 0.5))).toEqual(["a"]);
  });

  it("draws once per all-of item whatever comes up", () => {
    let draws = 0;
    rollCraft(ALL, () => {
      draws++;
      return 0.99;
    });
    expect(draws).toBe(ALL.items.length);
  });

  it("can come back empty, which is the gamble", () => {
    const risky: CraftOutput = { kind: "all", items: [{ tileId: "pyre", chance: 75 }] };
    expect(rollCraft(risky, () => 0.75)).toEqual([]);
    expect(rollCraft(risky, () => 0.74)).toEqual(["pyre"]);
  });

  it("picks exactly one one-of item by weight", () => {
    expect(rollCraft(ONE, () => 0.24)).toEqual(["a"]);
    expect(rollCraft(ONE, () => 0.25)).toEqual(["b"]);
    expect(rollCraft(ONE, () => 0.999)).toEqual(["b"]);
  });
});

describe("running a recipe", () => {
  it("spends every input, gives back the output, and leaves the forge alone", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("smith", { at: BESIDE, carrying: carrying("cinder", "raw-meat", "cinder") });
    const before = session.getMap();

    expect(session.craft(FORGE, RECIPE.ember, "smith")).toBe(true);
    expect(bagTiles(session.equipmentOf("smith"))).toEqual(["raw-meat", "ember"]);
    expect(session.getMap()).toBe(before);
    expect(getStack(session.getMap(), 1, 0, 0)[1]?.tileId).toBe("forge");
    expect(session.drainNotices("smith")).toContain("You forge at Forge and make 1 Ember");
  });

  it("takes the whole price from one pile", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("smith", {
      at: BESIDE,
      carrying: {
        ...emptyEquipment(),
        bag: {
          id: "itm_bag",
          tileId: BAG_TILE_ID,
          contents: [{ id: "itm_0", tileId: "blank", count: 2 }],
        },
      },
    });

    expect(session.craft(FORGE, RECIPE.blank, "smith")).toBe(true);
    const contents = session.equipmentOf("smith")!.bag!.contents!;
    expect(contents[0]?.tileId).toBe("blank");
    expect(contents[0]?.count ?? 1).toBe(1);
    expect(["spark", "cinder"]).toContain(contents[1]?.tileId);
  });

  it("spends the inputs even when the roll gives nothing, and says so", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("smith", { at: BESIDE, carrying: carrying("ember") });

    expect(session.craft(FORGE, RECIPE.pyre, "smith")).toBe(true);
    const made = bagTiles(session.equipmentOf("smith"));
    expect(made).not.toContain("ember");
    const notice = session.drainNotices("smith").at(-1);
    expect(notice).toBe(
      made.length === 0
        ? "You forge at Forge and it comes to nothing"
        : "You forge at Forge and make 1 Pyre",
    );
  });

  it("stops once there is nothing left to spend", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("smith", { at: BESIDE, carrying: carrying("cinder", "cinder") });

    expect(session.craft(FORGE, RECIPE.ember, "smith")).toBe(true);
    expect(session.craft(FORGE, RECIPE.ember, "smith")).toBe(false);
  });

  it("changes nothing when it is refused", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("smith", { at: BESIDE, carrying: carrying("cinder") });

    expect(session.craft(FORGE, RECIPE.ember, "smith")).toBe(false);
    expect(session.craft(FAR, RECIPE.ember, "smith")).toBe(false);
    expect(bagTiles(session.equipmentOf("smith"))).toEqual(["cinder"]);
  });
});

describe("the row a crafter offers", () => {
  function rows(equipment: Equipment, craftingRef: ObjectRef | null = null) {
    const session = new GameSession(board(), tiles);
    const snap = session.getSnapshot();
    return listInteractionOptions(
      snap.map,
      tilesById,
      snap.self,
      [],
      null,
      equipment,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      [],
      null,
      craftingRef,
    ).filter((o) => o.action === "craft");
  }

  it("is one row named by the tile's verb, however many recipes are affordable", () => {
    const row = rows(carrying("cinder", "cinder", "spark"));
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ label: "Forge", name: "Forge", tileId: "forge", active: false });
  });

  it("is lit while its window is the one open", () => {
    expect(rows(carrying("cinder", "cinder"), FORGE)[0]?.active).toBe(true);
  });

  it("is not offered to somebody who can afford nothing", () => {
    expect(rows(carrying("raw-meat"))).toEqual([]);
  });
});

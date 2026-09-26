import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { DEFAULT_BATTLER, resolveBattler } from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { Kit } from "../lib/kit";
import type { TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { equipmentForBody, equipmentFromKit } from "./battlerKit";
import type { Equipment, Hand } from "./equipment";
import { effectiveBattler, emptyEquipment, HANDS, handToSwing, wornInstances } from "./equipment";
import { Rng } from "./rng";

function firstHand(equipment: Equipment | null, tiles: Record<string, TileDef>): Hand | null {
  return handToSwing(equipment, tiles, HANDS[0]);
}

function tile(id: string, extra: Record<string, unknown> = {}): TileDef {
  return normalizeTileDef({
    id,
    name: id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: {
      frames: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    ...extra,
  });
}

function itemTile(id: string, item: unknown): TileDef {
  return tile(id, { kind: "item", interactions: { item } });
}

const tiles = tilesByIdFromList([
  itemTile("sword", DEFAULT_WEAPON),
  itemTile("dagger", DEFAULT_WEAPON),
  itemTile("meat", { type: "consumable", hp: 1 }),
  itemTile("bag", DEFAULT_CONTAINER),
  itemTile("chest", { ...DEFAULT_CONTAINER, equippable: false }),
  itemTile("mail", { type: "armor", def: 4, resist: { sharp: 6 } }),
  tile("rock"),
]);

function dice(rolls: number[]): { random: () => number; drawn: () => number } {
  let index = 0;
  return {
    random: () => {
      if (index >= rolls.length) {
        throw new Error(`drew ${index + 1} times, only ${rolls.length} written`);
      }
      return rolls[index++]!;
    },
    drawn: () => index,
  };
}

const HIT = 0;
const MISS = 0.999;

describe("rolling a kit", () => {
  it("puts a certainty in its slot", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 100 }];

    const out = equipmentFromKit(kit, tiles, dice([MISS]).random);

    expect(out.weapon?.tileId).toBe("sword");
    expect(out.offhand).toBeNull();
    expect(out.bag).toBeNull();
  });

  it("never lands something authored at nothing", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 0 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random)).toEqual(emptyEquipment());
  });

  it("reads a chance as a percent, floats included", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 0.5 }];

    expect(equipmentFromKit(kit, tiles, dice([0.004]).random).weapon).not.toBe(null);
    expect(equipmentFromKit(kit, tiles, dice([0.006]).random).weapon).toBeNull();
  });

  it("gives the slot to the first entry that comes up", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "dagger", chance: 100 },
      { slot: "weapon", tileId: "sword", chance: 100 },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT]).random);

    expect(out.weapon?.tileId).toBe("dagger");
  });

  it("falls through to the next entry when the first misses", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "dagger", chance: 5 },
      { slot: "weapon", tileId: "sword", chance: 100 },
    ];

    const out = equipmentFromKit(kit, tiles, dice([MISS, HIT]).random);

    expect(out.weapon?.tileId).toBe("sword");
  });

  it("mints an identity per thing, and no two the same", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "sword", chance: 100 },
      {
        slot: "bag",
        tileId: "bag",
        chance: 100,
        contents: [
          { tileId: "meat", chance: 100 },
          { tileId: "meat", chance: 100 },
        ],
      },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT, HIT, HIT]).random);

    const ids = [out.weapon!.id, out.bag!.id, ...out.bag!.contents!.map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("itm_"))).toBe(true);
  });
});

describe("what a kit costs in dice", () => {
  it("draws once per entry however the entries land", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "sword", chance: 100 },
      { slot: "weapon", tileId: "dagger", chance: 100 },
      { slot: "offhand", tileId: "meat", chance: 0 },
    ];

    const rolled = dice([HIT, HIT, HIT]);
    equipmentFromKit(kit, tiles, rolled.random);

    expect(rolled.drawn()).toBe(3);
  });

  it("draws for the contents of a container that never arrived", () => {
    const kit: Kit = [
      {
        slot: "bag",
        tileId: "bag",
        chance: 0,
        contents: [
          { tileId: "meat", chance: 100 },
          { tileId: "sword", chance: 100 },
        ],
      },
    ];

    const rolled = dice([HIT, HIT, HIT]);
    const out = equipmentFromKit(kit, tiles, rolled.random);

    expect(out.bag).toBeNull();
    expect(rolled.drawn()).toBe(3);
  });

  it("draws for a slot the world has since made impossible", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "no-such-tile", chance: 100 },
      { slot: "offhand", tileId: "sword", chance: 100 },
    ];

    const rolled = dice([HIT, HIT]);
    const out = equipmentFromKit(kit, tiles, rolled.random);

    expect(out.weapon).toBeNull();
    expect(out.offhand?.tileId).toBe("sword");
    expect(rolled.drawn()).toBe(2);
  });
});

describe("what a slot will take from a kit", () => {
  it("refuses the back to anything that is not a pack you can wear", () => {
    const kit: Kit = [
      { slot: "bag", tileId: "meat", chance: 100 },
      { slot: "bag", tileId: "chest", chance: 100 },
    ];

    expect(equipmentFromKit(kit, tiles, dice([HIT, HIT]).random).bag).toBeNull();
  });

  it("lets a hand hold anything you could carry, a pack included", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "bag", chance: 100 },
      { slot: "offhand", tileId: "meat", chance: 100 },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT]).random);

    expect(out.weapon?.tileId).toBe("bag");
    expect(out.offhand?.tileId).toBe("meat");
  });

  it("refuses a hand the one container nobody may carry", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "chest", chance: 100 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random).weapon).toBeNull();
  });

  it("refuses a slot to a tile that is not an item at all", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "rock", chance: 100 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random).weapon).toBeNull();
  });

  it("refuses the body to anything that is not armour", () => {
    const kit: Kit = [
      { slot: "armor", tileId: "sword", chance: 100 },
      { slot: "armor", tileId: "meat", chance: 100 },
      { slot: "armor", tileId: "bag", chance: 100 },
    ];

    expect(equipmentFromKit(kit, tiles, dice([HIT, HIT, HIT]).random).armor).toBeNull();
  });

  it("dresses a body authored to be wearing something", () => {
    const kit: Kit = [{ slot: "armor", tileId: "mail", chance: 100 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random).armor?.tileId).toBe("mail");
  });
});

describe("a body born in armour", () => {
  const armoured = tile("goblin", {
    kind: "battler",
    interactions: {
      battler: {
        ...DEFAULT_BATTLER,
        kit: [{ slot: "armor", tileId: "mail", chance: 100 }],
      },
    },
  });
  const world = tilesByIdFromList([
    ...Object.values(tiles),
    armoured,
    tile("naked-goblin", {
      kind: "battler",
      interactions: { battler: { ...DEFAULT_BATTLER, kit: [] } },
    }),
  ]);
  const body = resolveBattler(world["goblin"]!)!;

  it("gets the whole of what it is wearing", () => {
    const kit = equipmentForBody("goblin", world, dice([HIT]).random);
    const bare = effectiveBattler(
      body,
      emptyEquipment(),
      world,
      firstHand(emptyEquipment(), world),
    );
    const dressed = effectiveBattler(body, kit, world, firstHand(kit, world));

    expect(kit.armor?.tileId).toBe("mail");
    expect(dressed.def).toBe(bare.def + 4);
    expect(dressed.resist.sharp).toBe(6);
  });

  it("is carrying it in the sense a death understands", () => {
    const kit = equipmentForBody("goblin", world, dice([HIT]).random);
    expect(wornInstances(kit).map((one) => one.tileId)).toEqual(["mail"]);
  });
});

describe("what a container is born holding", () => {
  it("fills it with what came up", () => {
    const kit: Kit = [
      {
        slot: "bag",
        tileId: "bag",
        chance: 100,
        contents: [
          { tileId: "meat", chance: 100 },
          { tileId: "sword", chance: 0 },
          { tileId: "dagger", chance: 100 },
        ],
      },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT, HIT, HIT]).random);

    expect(out.bag?.contents?.map((i) => i.tileId)).toEqual(["meat", "dagger"]);
  });

  it("is empty rather than absent when nothing came up", () => {
    const kit: Kit = [
      {
        slot: "bag",
        tileId: "bag",
        chance: 100,
        contents: [{ tileId: "meat", chance: 0 }],
      },
    ];

    expect(equipmentFromKit(kit, tiles, dice([HIT, HIT]).random).bag).toEqual({
      id: expect.stringMatching(/^itm_/),
      tileId: "bag",
      contents: [],
    });
  });

  it("drops whatever will not fit", () => {
    const size = DEFAULT_CONTAINER.size;
    const kit: Kit = [
      {
        slot: "bag",
        tileId: "bag",
        chance: 100,
        contents: Array.from({ length: size + 2 }, () => ({
          tileId: "meat",
          chance: 100,
        })),
      },
    ];

    const out = equipmentFromKit(
      kit,
      tiles,
      dice(Array.from({ length: size + 3 }, () => HIT)).random,
    );

    expect(out.bag?.contents).toHaveLength(size);
  });

  it("keeps a container out of a container, wherever the kit puts one", () => {
    const kit: Kit = [
      {
        slot: "weapon",
        tileId: "bag",
        chance: 100,
        contents: [
          { tileId: "bag", chance: 100 },
          { tileId: "meat", chance: 100 },
        ],
      },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT, HIT]).random);

    expect(out.weapon?.contents?.map((i) => i.tileId)).toEqual(["meat"]);
  });

  it("gives nothing to something that is not a container", () => {
    const kit: Kit = [
      {
        slot: "weapon",
        tileId: "sword",
        chance: 100,
        contents: [{ tileId: "meat", chance: 100 }],
      },
    ];

    const out = equipmentFromKit(kit, tiles, dice([HIT, HIT]).random);

    expect(out.weapon?.contents).toBeUndefined();
  });
});

describe("what a body of a given kind carries", () => {
  const bodies = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    tile("armed", {
      kind: "battler",
      interactions: {
        battler: {
          ...DEFAULT_BATTLER,
          kit: [{ slot: "weapon", tileId: "sword", chance: 100 }],
        },
      },
    }),
    tile("bare", {
      kind: "battler",
      interactions: { battler: { ...DEFAULT_BATTLER } },
    }),
    tile("scenery"),
  ]);

  it("rolls the kit on its battler block", () => {
    expect(equipmentForBody("armed", bodies, dice([HIT]).random).weapon?.tileId).toBe("sword");
  });

  it("carries nothing when the block authors no kit", () => {
    expect(equipmentForBody("bare", bodies, dice([]).random)).toEqual(emptyEquipment());
  });

  it("carries nothing when the tile is not a battler", () => {
    expect(equipmentForBody("scenery", bodies, dice([]).random)).toEqual(emptyEquipment());
  });

  it("carries nothing when the catalogue has lost the tile", () => {
    expect(equipmentForBody("no-such-body", bodies, dice([]).random)).toEqual(emptyEquipment());
  });
});

describe("the bog imp we ship", () => {
  const catalogue = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const WEAPONS = ["knights-sword", "broad-axe", "iron-mace", "hunting-bow"];
  const BODIES = 4000;

  it("holds each of its four weapons about a quarter of the time", () => {
    const rng = new Rng(20260925);
    const counts: Record<string, number> = {};
    for (let i = 0; i < BODIES; i++) {
      const held = equipmentForBody("bog-imp", catalogue, () => rng.next()).weapon?.tileId;
      counts[held ?? "nothing"] = (counts[held ?? "nothing"] ?? 0) + 1;
    }

    expect(Object.keys(counts).sort()).toEqual([...WEAPONS].sort());
    for (const weapon of WEAPONS) {
      expect(counts[weapon]! / BODIES).toBeGreaterThan(0.22);
      expect(counts[weapon]! / BODIES).toBeLessThan(0.28);
    }
  });
});

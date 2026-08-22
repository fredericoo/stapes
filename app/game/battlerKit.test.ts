import { describe, expect, it } from "vitest";
import { DEFAULT_BATTLER, resolveBattler } from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { Kit } from "../lib/kit";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { equipmentForBody, equipmentFromKit } from "./battlerKit";
import {
  effectiveBattler,
  emptyEquipment,
  wornInstances,
} from "./equipment";

/**
 * Rolling an authored kit into a body's equipment.
 *
 * Two things are being pinned down here and they pull in opposite directions.
 * One is that the *outcome* follows the chances and the slot rules. The other is
 * that the *cost in dice* follows neither — a kit draws the same number of times
 * whatever it rolls, because everything else in the world is drawing from the
 * same stream behind it.
 */

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
  itemTile("mail", { type: "armor", def: 4, resist: { blade: 6 } }),
  tile("rock"),
]);

/**
 * Dice that answer a written-down list and then refuse.
 *
 * Refusing past the end is the point rather than a convenience: half of what
 * this file asserts is *how many times* a kit draws, and a generator that
 * happily kept going would make an extra draw invisible.
 */
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

/** A roll certain to come up, and one certain not to, at any authored chance. */
const HIT = 0;
const MISS = 0.999;

describe("rolling a kit", () => {
  it("puts a certainty in its slot", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 100 }];

    const out = equipmentFromKit(kit, tiles, dice([MISS]).random);

    // Even the highest roll a generator can produce lands a certainty: the test
    // is `random() * 100 < chance`, and `random()` never reaches 1.
    expect(out.weapon?.tileId).toBe("sword");
    expect(out.offhand).toBeNull();
    expect(out.bag).toBeNull();
  });

  it("never lands something authored at nothing", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 0 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random)).toEqual(
      emptyEquipment(),
    );
  });

  it("reads a chance as a percent, floats included", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "sword", chance: 0.5 }];

    expect(equipmentFromKit(kit, tiles, dice([0.004]).random).weapon).not.toBe(
      null,
    );
    expect(equipmentFromKit(kit, tiles, dice([0.006]).random).weapon).toBeNull();
  });

  /**
   * Which is what makes several entries on one slot a weighted table: the rare
   * thing goes above the common one, and rolling both is not a conflict.
   */
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

/**
 * The cost in dice, which is the half that has nothing to do with the outcome.
 *
 * A kit that drew a different number of times depending on what it rolled would
 * mean adding a rare dagger to one wolf changed what every creature in the world
 * rolled after it — the same reason a swing always costs three draws and a decay
 * lifetime always costs one.
 */
describe("what a kit costs in dice", () => {
  it("draws once per entry however the entries land", () => {
    const kit: Kit = [
      { slot: "weapon", tileId: "sword", chance: 100 },
      { slot: "weapon", tileId: "dagger", chance: 100 },
      { slot: "offhand", tileId: "meat", chance: 0 },
    ];

    const rolled = dice([HIT, HIT, HIT]);
    equipmentFromKit(kit, tiles, rolled.random);

    // Three entries, three draws: one that landed, one whose slot was already
    // taken, and one authored never to come up at all.
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

/**
 * A kit may not author a body into a state a player could not be dragged into,
 * which is why this asks `slotAccepts` rather than a rule of its own.
 */
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

    expect(
      equipmentFromKit(kit, tiles, dice([HIT]).random).weapon,
    ).toBeNull();
  });

  it("refuses a slot to a tile that is not an item at all", () => {
    const kit: Kit = [{ slot: "weapon", tileId: "rock", chance: 100 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random).weapon).toBeNull();
  });

  /**
   * The strict square, and the one place a kit is held to a stricter rule than a
   * hand: defence is the entirety of what the body slot contributes to a fight,
   * so a sword worn as a shirt would be a number about nothing.
   */
  it("refuses the body to anything that is not armour", () => {
    const kit: Kit = [
      { slot: "armor", tileId: "sword", chance: 100 },
      { slot: "armor", tileId: "meat", chance: 100 },
      { slot: "armor", tileId: "bag", chance: 100 },
    ];

    expect(
      equipmentFromKit(kit, tiles, dice([HIT, HIT, HIT]).random).armor,
    ).toBeNull();
  });

  it("dresses a body authored to be wearing something", () => {
    const kit: Kit = [{ slot: "armor", tileId: "mail", chance: 100 }];

    expect(equipmentFromKit(kit, tiles, dice([HIT]).random).armor?.tileId).toBe(
      "mail",
    );
  });
});

/**
 * A creature spawned in armour fights in it.
 *
 * **The claim is that there is no special case for people**, which is the whole
 * reason a kit names slots rather than listing drops: a goblin authored wearing
 * mail is protected by that mail to exactly the extent a player carrying the same
 * shirt would be, because the simulation reads a body's equipment for defence and
 * has no idea the goblin is not a person. Nothing in the code below is
 * armour-aware — it is `equipmentForBody` and `effectiveBattler`, the two calls
 * every body in the world already goes through.
 */
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
    const bare = effectiveBattler(body, emptyEquipment(), world);
    const dressed = effectiveBattler(body, kit, world);

    expect(kit.armor?.tileId).toBe("mail");
    expect(dressed.def).toBe(bare.def + 4);
    expect(dressed.resist.blade).toBe(6);
  });

  /** And it is worth killing for: worn things go on the floor when a body does. */
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

  /**
   * An author writing a fifth thing into a four-slot bag said "these are in this
   * bag", not "and one of them is in a fist" — so the surplus is dropped rather
   * than spilled somewhere they did not ask for.
   */
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
    expect(
      equipmentForBody("armed", bodies, dice([HIT]).random).weapon?.tileId,
    ).toBe("sword");
  });

  it("carries nothing when the block authors no kit", () => {
    expect(equipmentForBody("bare", bodies, dice([]).random)).toEqual(
      emptyEquipment(),
    );
  });

  /**
   * Equipment hangs off having a body, and a tile with no hit points has none —
   * so a prop and a battler with an empty kit give the same answer rather than
   * two different ones.
   */
  it("carries nothing when the tile is not a battler", () => {
    expect(equipmentForBody("scenery", bodies, dice([]).random)).toEqual(
      emptyEquipment(),
    );
  });

  it("carries nothing when the catalogue has lost the tile", () => {
    expect(equipmentForBody("no-such-body", bodies, dice([]).random)).toEqual(
      emptyEquipment(),
    );
  });
});

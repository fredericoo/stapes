import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { emptyEquipment, type Equipment } from "./equipment";
import { carriedCount, hasRoomFor, planTrade } from "./trade";

/**
 * Paying and being paid, against a kit built by hand.
 *
 * The rule under test is all-or-nothing across every square a body has:
 * shards spread over three piles still add up, a bag held in a hand is
 * searched, and a trade that would leave anything on the floor leaves the kit
 * exactly as it was instead.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "item",
    intangible: true,
    ...partial,
  });
}

const shard = tile({
  id: "shard",
  interactions: { item: { type: "artifact", pile: 99 } },
});
const bottle = tile({
  id: "bottle",
  interactions: { item: { type: "artifact", pile: 12 } },
});
const potion = tile({
  id: "potion",
  interactions: {
    item: { type: "consumable", label: "Drink", hp: 0, pile: 4 },
  },
});
const sword = tile({
  id: "sword",
  interactions: {
    item: {
      type: "weapon",
      damage: 1,
      def: 0,
      accuracy: 100,
      variance: 0,
      spd: 50,
      mastery: "blade",
    },
  },
});
const bag = tile({
  id: "bag",
  interactions: { item: { ...DEFAULT_CONTAINER, size: 2 } },
});

const tilesById: Record<string, TileDef> = Object.fromEntries(
  [shard, bottle, potion, sword, bag].map((def) => [def.id, def]),
);

let minted = 0;
const mint = () => `itm_${++minted}`;

function pile(tileId: string, count?: number): ItemInstance {
  return count && count > 1
    ? { id: mint(), tileId, count }
    : { id: mint(), tileId };
}

function wearing(
  contents: ItemInstance[],
  rest: Partial<Equipment> = {},
): Equipment {
  return {
    ...emptyEquipment(),
    bag: { id: "itm_bag", tileId: "bag", contents },
    ...rest,
  };
}

function tally(kit: Equipment) {
  const name = (i: ItemInstance | null) =>
    i ? (i.count ? `${i.tileId}x${i.count}` : i.tileId) : null;
  return {
    weapon: name(kit.weapon),
    offhand: name(kit.offhand),
    bag: kit.bag?.contents?.map(name) ?? null,
    weaponBag: kit.weapon?.contents?.map(name),
    offhandBag: kit.offhand?.contents?.map(name),
  };
}

describe("counting what is carried", () => {
  it("sums piles across the bag, the hands, and a bag in a hand", () => {
    const kit = wearing([pile("shard", 5)], {
      weapon: pile("shard", 3),
      offhand: { id: mint(), tileId: "bag", contents: [pile("shard", 6)] },
    });
    expect(carriedCount(tilesById, kit, "shard")).toBe(14);
  });

  it("never counts a container", () => {
    expect(carriedCount(tilesById, wearing([]), "bag")).toBe(0);
  });
});

describe("paying", () => {
  it("takes from one pile, leaving the rest", () => {
    const kit = planTrade(
      tilesById,
      wearing([pile("shard", 20)]),
      [{ tileId: "shard", count: 14 }],
      [],
      mint,
    );
    expect(tally(kit!).bag).toEqual(["shardx6"]);
  });

  it("peels across several piles, hands first, and empties what it drains", () => {
    const kit = wearing([pile("shard", 5), pile("sword")], {
      weapon: pile("shard", 3),
      offhand: {
        id: mint(),
        tileId: "bag",
        contents: [pile("shard", 6), pile("bottle")],
      },
    });
    const paid = planTrade(
      tilesById,
      kit,
      [{ tileId: "shard", count: 12 }],
      [],
      mint,
    )!;
    expect(tally(paid)).toMatchObject({
      weapon: null,
      bag: ["sword"],
      offhandBag: ["shardx2", "bottle"],
    });
  });

  it("refuses when short, and the kit is untouched", () => {
    const kit = wearing([pile("shard", 13)]);
    expect(
      planTrade(tilesById, kit, [{ tileId: "shard", count: 14 }], [], mint),
    ).toBeNull();
  });

  it("refuses to take a container, however many are carried", () => {
    const kit = wearing([], {
      offhand: { id: mint(), tileId: "bag", contents: [] },
    });
    expect(
      planTrade(tilesById, kit, [{ tileId: "bag", count: 1 }], [], mint),
    ).toBeNull();
  });
});

describe("being paid", () => {
  it("pours onto a pile already carried, needing no square", () => {
    const kit = wearing([pile("shard", 5), pile("sword")]);
    const paid = planTrade(
      tilesById,
      kit,
      [],
      [{ tileId: "shard", count: 2 }],
      mint,
    )!;
    expect(tally(paid).bag).toEqual(["shardx7", "sword"]);
  });

  it("lands where the payment came from", () => {
    const kit = wearing([pile("sword"), pile("shard", 14)]);
    const done = planTrade(
      tilesById,
      kit,
      [{ tileId: "shard", count: 14 }],
      [{ tileId: "potion", count: 1 }],
      mint,
    )!;
    expect(tally(done).bag).toEqual(["sword", "potion"]);
  });

  it("overflows into a bag held in a hand, then the hands", () => {
    const kit = wearing([pile("sword"), pile("sword")], {
      weapon: { id: mint(), tileId: "bag", contents: [pile("sword")] },
    });
    const paid = planTrade(
      tilesById,
      kit,
      [],
      [{ tileId: "bottle", count: 3 }],
      mint,
    )!;
    expect(tally(paid)).toMatchObject({
      weaponBag: ["sword", "bottlex3"],
      offhand: null,
    });
    const more = planTrade(
      tilesById,
      paid,
      [],
      [{ tileId: "bottle", count: 12 }],
      mint,
    )!;
    expect(tally(more)).toMatchObject({
      weaponBag: ["sword", "bottlex12"],
      offhand: "bottlex3",
    });
  });

  it("refuses when anything would have nowhere to go, and gives nothing", () => {
    const kit = wearing([pile("sword"), pile("sword")], {
      weapon: pile("sword"),
      offhand: pile("sword"),
    });
    expect(
      planTrade(tilesById, kit, [], [{ tileId: "bottle", count: 1 }], mint),
    ).toBeNull();
    expect(
      hasRoomFor(tilesById, kit, { tileId: "bottle", count: 1 }, mint),
    ).toBe(false);
  });

  it("never gives a container", () => {
    expect(
      planTrade(
        tilesById,
        wearing([]),
        [],
        [{ tileId: "bag", count: 1 }],
        mint,
      ),
    ).toBeNull();
  });

  it("refuses a tile the catalogue does not hold", () => {
    expect(
      planTrade(
        tilesById,
        wearing([]),
        [],
        [{ tileId: "nothing", count: 1 }],
        mint,
      ),
    ).toBeNull();
  });

  it("answers room for a whole count, not one", () => {
    const kit = wearing([pile("sword")]);
    expect(
      hasRoomFor(tilesById, kit, { tileId: "potion", count: 4 }, mint),
    ).toBe(true);
    expect(
      hasRoomFor(tilesById, kit, { tileId: "sword", count: 4 }, mint),
    ).toBe(false);
  });
});

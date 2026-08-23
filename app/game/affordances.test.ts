import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  canDropAt,
  canOpenFrom,
  canEquipFrom,
  canPickUpFrom,
  dropDestinationAt,
  equipSlotFrom,
  pickUpDestination,
  pushableDefAt,
  REACH_CELLS,
  withinReach,
  type ObjectRef,
} from "./affordances";
import type { Equipment } from "./equipment";
import { emptyEquipment } from "./equipment";

/**
 * Reaching for things.
 *
 * The geometry above all: pick-up and open share a round radius that is
 * deliberately not the orthogonal-adjacent rule a push uses, and the difference
 * is the whole reason these are separate functions.
 */

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

const tiles = [
  tile({ id: "grass" }),
  tile({ id: "rock", height: 1 }),
  // Full height and light-blocking, so it stops a line of sight — see `./sight`,
  // where sight is light and you see over anything shorter than a level.
  tile({ id: "wall", height: 2 }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  // An off-hand *weapon* — a shield. What a torch used to be authored as, and
  // the reason `WeaponItem.offhand` exists: only the author knows which hand a
  // block of weapon numbers was meant for.
  tile({
    id: "shield",
    kind: "item",
    interactions: { item: { ...DEFAULT_WEAPON, offhand: true } },
  }),
  // And the other way into that hand: no numbers at all, so no flag either.
  tile({
    id: "lantern",
    kind: "item",
    interactions: { item: { type: "artifact" } },
  }),
  tile({
    id: "berry",
    kind: "item",
    interactions: { item: { type: "consumable", hp: 5 } },
  }),
  tile({
    id: "mail",
    kind: "item",
    interactions: { item: { type: "armor", def: 4 } },
  }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
  tile({
    id: "chest",
    kind: "item",
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const KIT: Equipment = {
  weapon: null,
  offhand: null,
  armor: null,
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};
const FULL_KIT: Equipment = {
  weapon: null,
  offhand: null,
  armor: null,
  bag: {
    id: "itm_bag",
    tileId: "bag",
    contents: Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) => ({
      id: `itm_${i}`,
      tileId: "sword",
    })),
  },
};

const ME = { x: 0, y: 0, z: 0 };

/**
 * Nothing anywhere, so reach comes down to the geometry alone: a board with no
 * cells has no floor to be on the wrong side of.
 */
const OPEN_AIR = emptyMap();

function mapWith(x: number, y: number, tileId: string, z = 0): MapFile {
  return replaceStack(emptyMap(), x, y, z, [
    { tileId: "grass" },
    { tileId, itemId: "itm_target" },
  ]);
}

function ref(x: number, y: number, z = 0, stackIndex = 1): ObjectRef {
  return { x, y, z, stackIndex };
}

describe("withinReach", () => {
  it("takes the eight neighbours and the cell you are standing in", () => {
    const inReach: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (const [x, y] of inReach) {
      expect(withinReach(OPEN_AIR, tilesById, ME, ref(x, y))).toBe(true);
    }
  });

  it("stops short of two cells, straight or diagonal", () => {
    const outOfReach: Array<[number, number]> = [
      [2, 0],
      [0, 2],
      [2, 1],
      [2, 2],
      [-2, 0],
    ];
    for (const [x, y] of outOfReach) {
      expect(withinReach(OPEN_AIR, tilesById, ME, ref(x, y))).toBe(false);
    }
  });

  /** A diagonal is √2 ≈ 1.41 away, which is what 1.5 is chosen to include. */
  it("is a circle, not a square of side 1.5", () => {
    expect(REACH_CELLS).toBeGreaterThan(Math.SQRT2);
    expect(REACH_CELLS).toBeLessThan(2);
  });

  it("reaches one floor up and down, and no further", () => {
    expect(withinReach(OPEN_AIR, tilesById, ME, ref(1, 0, 1))).toBe(true);
    expect(withinReach(OPEN_AIR, tilesById, ME, ref(1, 0, -1))).toBe(true);
    expect(withinReach(OPEN_AIR, tilesById, ME, ref(1, 0, 2))).toBe(false);
  });

  /**
   * The reason the floor of slack is not enough on its own: a supply crate on
   * the level below, under the ground you are standing on, offering itself
   * through a metre of earth.
   */
  it("refuses a thing one floor down with ground laid over it", () => {
    const roofed = replaceStack(mapWith(1, 0, "chest", -1), 1, 0, 0, [
      { tileId: "grass" },
    ]);
    expect(withinReach(roofed, tilesById, ME, ref(1, 0, -1))).toBe(false);
  });

  /** And the case the slack exists for: the same crate, down an open shaft. */
  it("still reaches down where that ground is missing", () => {
    const open = mapWith(1, 0, "chest", -1);
    expect(withinReach(open, tilesById, ME, ref(1, 0, -1))).toBe(true);
  });

  /**
   * The same rule the other way up, and it reads off a different tile: what
   * separates you from the ledge beside you is your own ceiling, not the ground
   * the chest is sitting on. @see `./sight`
   */
  it("reaches up onto a ledge with ground of its own", () => {
    const ledge = mapWith(1, 0, "chest", 1);
    expect(withinReach(ledge, tilesById, ME, ref(1, 0, 1))).toBe(true);
  });

  it("refuses that ledge from under a ceiling", () => {
    const roofed = replaceStack(mapWith(1, 0, "chest", 1), 0, 0, 1, [
      { tileId: "grass" },
    ]);
    expect(withinReach(roofed, tilesById, ME, ref(1, 0, 1))).toBe(false);
  });

  /**
   * Sideways is untouched. A look never tests its own endpoints, so what you
   * are standing beside stays within arm's length, wall or no wall.
   */
  it("reaches across its own floor whatever is standing in the way", () => {
    const walled = replaceStack(mapWith(1, 0, "chest"), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "wall" },
    ]);
    expect(withinReach(walled, tilesById, ME, ref(1, 0))).toBe(true);
  });
});

describe("canPickUpFrom", () => {
  it("stows an ordinary item in the bag", () => {
    const map = mapWith(1, 0, "sword");
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), KIT)).toBe(true);
  });

  /**
   * A pack never goes *in* a pack — nothing nests — but with a back that is
   * already full a hand will take one, which is a choice rather than a rule.
   */
  it("takes a spare pack in hand when the back is full", () => {
    expect(
      pickUpDestination(mapWith(1, 0, "bag"), tilesById, ME, ref(1, 0), KIT),
    ).toEqual({ kind: "slot", slot: "offhand" });
    // Bare back, and the "Put on" row owns it instead.
    expect(
      pickUpDestination(
        mapWith(1, 0, "bag"),
        tilesById,
        ME,
        ref(1, 0),
        emptyEquipment(),
      ),
    ).toBeNull();
  });

  /** A chest is opened where it lies, so no hand will take one either. */
  it("never takes a chest at all", () => {
    for (const kit of [KIT, emptyEquipment(), FULL_KIT]) {
      expect(
        canPickUpFrom(mapWith(1, 0, "chest"), tilesById, ME, ref(1, 0), kit),
      ).toBe(false);
    }
  });

  /**
   * A full bag is not the end of the conversation: you have hands. The spare one
   * goes first, so a pickup never rewrites what you are fighting with.
   */
  it("reaches for a hand when there is nowhere else", () => {
    const armed: Equipment = {
      ...FULL_KIT,
      weapon: { id: "itm_held", tileId: "sword" },
    };
    expect(
      pickUpDestination(mapWith(1, 0, "sword"), tilesById, ME, ref(1, 0), armed),
    ).toEqual({ kind: "slot", slot: "offhand" });

    // And the weapon hand once the spare one is taken. A berry, because a
    // sword's own slot is free here and that is the equip row's to offer.
    expect(
      pickUpDestination(mapWith(1, 0, "berry"), tilesById, ME, ref(1, 0), {
        ...FULL_KIT,
        offhand: { id: "itm_lit", tileId: "shield" },
      }),
    ).toEqual({ kind: "slot", slot: "weapon" });
  });

  /**
   * A thing with a free slot of its own is that row's business — see
   * `equipSlotFrom`. Two rows meaning one hand is what this refusal prevents.
   */
  it("leaves the slot a thing belongs in to the equip row", () => {
    expect(
      pickUpDestination(
        mapWith(1, 0, "sword"),
        tilesById,
        ME,
        ref(1, 0),
        emptyEquipment(),
      ),
    ).toBeNull();
  });

  /** A consumable belongs nowhere, so a hand is the first thing it reaches. */
  it("holds a thing with no slot of its own", () => {
    expect(
      pickUpDestination(
        mapWith(1, 0, "berry"),
        tilesById,
        ME,
        ref(1, 0),
        emptyEquipment(),
      ),
    ).toEqual({ kind: "slot", slot: "offhand" });
  });

  it("refuses once the bag is full and both hands are too", () => {
    const laden: Equipment = {
      ...FULL_KIT,
      weapon: { id: "itm_a", tileId: "sword" },
      offhand: { id: "itm_b", tileId: "shield" },
    };
    expect(
      canPickUpFrom(mapWith(1, 0, "sword"), tilesById, ME, ref(1, 0), laden),
    ).toBe(false);
  });

  it("refuses a tile that is not an item", () => {
    const map = mapWith(1, 0, "rock");
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), KIT)).toBe(false);
  });

  it("refuses something buried under another tile", () => {
    const map = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", itemId: "itm_buried" },
      { tileId: "rock" },
    ]);
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), KIT)).toBe(false);
  });

  it("refuses an empty cell", () => {
    expect(canPickUpFrom(emptyMap(), tilesById, ME, ref(1, 0), KIT)).toBe(false);
  });
});

/**
 * Arming yourself off the floor, which is what you can do with no bag at all.
 * One slot per thing, and it has to be empty.
 */
describe("equipSlotFrom", () => {
  const slotFor = (tileId: string, kit: Equipment) =>
    equipSlotFrom(mapWith(1, 0, tileId), tilesById, ME, ref(1, 0), kit);

  it("sends each thing to the slot its tile names", () => {
    expect(slotFor("sword", emptyEquipment())).toBe("weapon");
    expect(slotFor("shield", emptyEquipment())).toBe("offhand");
    expect(slotFor("lantern", emptyEquipment())).toBe("offhand");
    expect(slotFor("mail", emptyEquipment())).toBe("armor");
    expect(slotFor("bag", emptyEquipment())).toBe("bag");
  });

  /** The point of the whole thing: a sword with nothing to put it in. */
  it("arms somebody carrying nothing", () => {
    expect(canEquipFrom(mapWith(1, 0, "sword"), tilesById, ME, ref(1, 0), emptyEquipment())).toBe(
      true,
    );
  });

  it("refuses a slot that is already full", () => {
    const armed: Equipment = {
      ...emptyEquipment(),
      weapon: { id: "itm_held", tileId: "sword" },
    };
    expect(slotFor("sword", armed)).toBeNull();
    // And the other hand is not a fallback — a sword is a sword, not a shield.
    expect(slotFor("sword", { ...armed, offhand: null })).toBeNull();
  });

  it("refuses a bag when one is already worn", () => {
    expect(slotFor("bag", KIT)).toBeNull();
  });

  /**
   * Equipping never displaces what is already on you — a swap is two deliberate
   * acts — and armour is under the same rule as every other square.
   */
  it("refuses the body when something is already worn on it", () => {
    const dressed: Equipment = {
      ...emptyEquipment(),
      armor: { id: "itm_worn", tileId: "mail" },
    };
    expect(slotFor("mail", dressed)).toBeNull();
  });

  it("never equips a chest, which is looted where it lies", () => {
    expect(slotFor("chest", emptyEquipment())).toBeNull();
  });

  /** A hand is not a pocket. A berry goes in the bag or in your mouth. */
  it("has no slot for a consumable", () => {
    expect(slotFor("berry", emptyEquipment())).toBeNull();
  });

  it("refuses a tile that is not an item at all", () => {
    expect(slotFor("rock", emptyEquipment())).toBeNull();
  });

  it("refuses something buried under another tile", () => {
    const map = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", itemId: "itm_buried" },
      { tileId: "rock" },
    ]);
    expect(
      canEquipFrom(map, tilesById, ME, ref(1, 0), emptyEquipment()),
    ).toBe(false);
  });
});

describe("canOpenFrom", () => {
  it("opens a bag in reach", () => {
    expect(canOpenFrom(mapWith(1, 0, "bag"), tilesById, ME, ref(1, 0))).toBe(
      true,
    );
  });

  it("opens a chest in reach", () => {
    expect(canOpenFrom(mapWith(1, 0, "chest"), tilesById, ME, ref(1, 0))).toBe(
      true,
    );
  });

  /**
   * Opening is looking, and looking costs nothing — so unlike pick-up it asks
   * nothing at all about what the player is already carrying.
   */
  it("opens a bag with one already worn and both hands full", () => {
    const laden: Equipment = {
      ...FULL_KIT,
      weapon: { id: "itm_a", tileId: "sword" },
      offhand: { id: "itm_b", tileId: "shield" },
    };
    const map = mapWith(1, 0, "bag");
    expect(canOpenFrom(map, tilesById, ME, ref(1, 0))).toBe(true);
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), laden)).toBe(false);
  });

  it("does not open a weapon", () => {
    expect(canOpenFrom(mapWith(1, 0, "sword"), tilesById, ME, ref(1, 0))).toBe(
      false,
    );
  });

  it("does not open something out of reach", () => {
    expect(canOpenFrom(mapWith(2, 0, "chest"), tilesById, ME, ref(2, 0))).toBe(
      false,
    );
  });

  it("reaches a chest on the diagonal", () => {
    expect(canOpenFrom(mapWith(1, 1, "chest"), tilesById, ME, ref(1, 1))).toBe(
      true,
    );
  });
});

/**
 * What counts as being buried.
 *
 * The round reach takes in the cell the actor is standing in, so the commonest
 * thing on top of a reachable item is the actor's own body — and a rule that
 * counted that as cover would make the most obvious case in the game
 * impossible.
 */
describe("a body is not a lid", () => {
  function under(tileId: string, above: string[]): MapFile {
    return replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId, itemId: "itm_target" },
      ...above.map((t) => ({ tileId: t, owner: "somebody" })),
    ]);
  }

  it("picks up a sword from under your own feet", () => {
    expect(
      canPickUpFrom(under("sword", ["rock"]), tilesById, ME, ref(0, 0), KIT),
    ).toBe(true);
  });

  it("opens a chest you are standing on", () => {
    expect(canOpenFrom(under("chest", ["rock"]), tilesById, ME, ref(0, 0))).toBe(
      true,
    );
  });

  it("reaches under two bodies as readily as one", () => {
    expect(
      canPickUpFrom(
        under("sword", ["rock", "rock"]),
        tilesById,
        ME,
        ref(0, 0),
        KIT,
      ),
    ).toBe(true);
  });

  it("is still buried under something nobody is driving", () => {
    const buried = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", itemId: "itm_target" },
      { tileId: "rock" },
    ]);
    expect(canPickUpFrom(buried, tilesById, ME, ref(0, 0), KIT)).toBe(false);
    expect(canOpenFrom(buried, tilesById, ME, ref(0, 0))).toBe(false);
  });
});

/**
 * Putting a thing down.
 *
 * A much longer reach than taking one, and the only affordance here that asks
 * about sight — which is what the length makes necessary: five cells is far
 * enough to reach through a wall if nothing stops it.
 */
describe("canDropAt", () => {
  /** Open ground, eleven by eleven, with the actor at the origin. */
  function field(): MapFile {
    let map = emptyMap();
    for (let x = -5; x <= 5; x++) {
      for (let y = -5; y <= 5; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    return map;
  }

  const sword = tilesById.sword!;

  it("drops at your own feet", () => {
    expect(canDropAt(field(), tilesById, ME, { x: 0, y: 0, z: 0 }, sword)).toBe(
      true,
    );
  });

  it("reaches five cells out, and no further", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 5, y: 0, z: 0 }, sword)).toBe(true);
    expect(canDropAt(map, tilesById, ME, { x: -5, y: 0, z: 0 }, sword)).toBe(
      true,
    );
    expect(canDropAt(map, tilesById, ME, { x: 6, y: 0, z: 0 }, sword)).toBe(
      false,
    );
  });

  /** Round, like every other item reach — `3,4` is exactly five away. */
  it("measures the radius round rather than square", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 3, y: 4, z: 0 }, sword)).toBe(true);
    expect(canDropAt(map, tilesById, ME, { x: 4, y: 4, z: 0 }, sword)).toBe(
      false,
    );
  });

  it("will not throw through a wall", () => {
    const walled = replaceStack(field(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "wall" },
    ]);
    expect(canDropAt(walled, tilesById, ME, { x: 4, y: 0, z: 0 }, sword)).toBe(
      false,
    );
    // The same distance the other way, with nothing in between.
    expect(canDropAt(walled, tilesById, ME, { x: -4, y: 0, z: 0 }, sword)).toBe(
      true,
    );
  });

  it("refuses a cell with nothing to stand the thing on", () => {
    expect(
      canDropAt(emptyMap(), tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
    ).toBe(false);
  });

  it("refuses a floor further off than a reach can follow", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 1, y: 0, z: 3 }, sword)).toBe(
      false,
    );
  });

  /**
   * A box catches what is thrown at it, and only then does the floor get a
   * look-in — see `dropDestinationAt`.
   */
  describe("what catches it", () => {
    const bag = tilesById.bag!;

    function chestAt(x: number, contents: unknown[] = []): MapFile {
      return replaceStack(field(), x, 0, 0, [
        { tileId: "grass" },
        { tileId: "chest", itemId: "itm_chest", contents } as never,
      ]);
    }

    it("puts a thing inside the container it lands on", () => {
      expect(
        dropDestinationAt(chestAt(1), tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
      ).toEqual({ kind: "contents", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    });

    it("lands on top of a full one instead", () => {
      const full = chestAt(1, [
        { id: "itm_a", tileId: "sword" },
        { id: "itm_b", tileId: "sword" },
      ]);
      expect(
        dropDestinationAt(full, tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
      ).toEqual({ kind: "stack" });
    });

    /** Containers do not nest, so a bag thrown at a chest lands on it. */
    it("lands on top when the thing thrown is itself a container", () => {
      expect(
        dropDestinationAt(chestAt(1), tilesById, ME, { x: 1, y: 0, z: 0 }, bag),
      ).toEqual({ kind: "stack" });
    });

    it("does not reach a container buried under something", () => {
      const covered = replaceStack(field(), 1, 0, 0, [
        { tileId: "grass" },
        { tileId: "chest", itemId: "itm_chest" },
        { tileId: "rock" },
      ]);
      expect(
        dropDestinationAt(covered, tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
      ).toEqual({ kind: "stack" });
    });

    it("is caught by a chest with somebody standing on it", () => {
      const stoodOn = replaceStack(field(), 1, 0, 0, [
        { tileId: "grass" },
        { tileId: "chest", itemId: "itm_chest" },
        { tileId: "rock", owner: "someone" },
      ]);
      expect(
        dropDestinationAt(stoodOn, tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
      ).toEqual({ kind: "contents", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    });
  });
});

/**
 * A shove takes the column with it, so being under something is no reason to
 * refuse one — but a body riding on top is.
 */
describe("pushableDefAt", () => {
  const pushTiles = [
    ...tiles,
    tile({
      id: "crate",
      height: 1,
      affectedByGravity: true,
      interactions: { push: { climb: "half", moveOnTileIds: [] } },
    }),
  ];
  const pushTilesById = tilesByIdFromList(pushTiles);

  function column(...above: string[]): MapFile {
    return replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      ...above.map((tileId) => ({ tileId })),
    ]);
  }

  it("reaches a crate under another tile", () => {
    const map = column("rock");
    expect(pushableDefAt(map, pushTilesById, ME, ref(1, 0))?.id).toBe("crate");
  });

  it("refuses one with a body on top of it", () => {
    const map = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "rock", owner: "someone" },
    ]);
    expect(pushableDefAt(map, pushTilesById, ME, ref(1, 0))).toBeNull();
  });

  it("refuses a tile with no push on it", () => {
    const map = column("rock");
    expect(
      pushableDefAt(map, pushTilesById, ME, ref(1, 0, 0, 2)),
    ).toBeNull();
  });
});

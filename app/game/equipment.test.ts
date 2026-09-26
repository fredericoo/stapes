import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BattlerDef } from "../lib/battler";
import {
  DEFAULT_BATTLER,
  ACCURACY_AT_MAX_MASTERY,
  bodyDefence,
  DAMAGE_AT_MAX_MASTERY,
  defFrom,
  fightingStats,
  fleeFrom,
  MASTERY_ACCURACY_BONUS,
  MASTERY_DAMAGE_BONUS,
  maxHpFrom,
  resolveBattler,
} from "../lib/battler";
import type { WeaponItem } from "../lib/item";
import {
  ARMOR_SLOTS,
  armorSlotOf,
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
  MELEE_REACH,
  resolveArmor,
  resolveWeapon,
} from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { MAX_MASTERY } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { Equipment, Hand } from "./equipment";
import {
  armorDefence,
  armorResistances,
  bodyElements,
  fightsWithAHand,
  HANDS,
  handClaimedByTwoHander,
  handToSwing,
  heldDefence,
  twoHandedHand,
  carriedInstances,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  handAccepts,
  restoredEquipment,
  otherHand,
  spilled,
  takesEffect,
  weaponInHand,
  weaponSwungBy,
  wornAccepts,
  wornDefence,
} from "./equipment";

function firstHand(equipment: Equipment | null, tiles: Record<string, TileDef>): Hand | null {
  return handToSwing(equipment, tiles, HANDS[0]);
}

const CLAWS = {
  type: "weapon",
  damage: 7,
  def: 3,
  accuracy: 44,
  variance: 35,
  spd: 33,
  reach: MELEE_REACH,
  mastery: "fist",
} as const;

const base: BattlerDef = {
  ...DEFAULT_BATTLER,
  masteries: { fist: 12, toughness: 20, agility: 6 },
  naturalWeapon: { ...CLAWS },
};

const SWORD_DEF = 2;
const PARRY_DEF = SWORD_DEF;
const SWORD = normalizeTileDef({
  id: "sword",
  name: "Sword",
  height: 0,
  kind: "item",
  directional: false,
  attributes: {},
  variants: { default: [] },
  intangible: true,
  interactions: { item: { ...DEFAULT_WEAPON, def: SWORD_DEF } },
});

const SHIELD = normalizeTileDef({
  id: "shield",
  name: "Shield",
  height: 0,
  kind: "item",
  directional: false,
  attributes: {},
  variants: { default: [] },
  intangible: true,
  interactions: { item: { type: "shield", def: 3 } },
});

describe("weaponInHand", () => {
  it("falls back to the natural weapon with an empty hand", () => {
    expect(weaponInHand(base, null, lightTiles, firstHand(null, lightTiles))).toEqual(CLAWS);
    expect(
      weaponInHand(base, emptyEquipment(), lightTiles, firstHand(emptyEquipment(), lightTiles)),
    ).toEqual(CLAWS);
  });

  it("takes what is in the hand instead, rather than as well", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    expect(weaponInHand(base, kit, lightTiles, firstHand(kit, lightTiles))).toEqual(DEFAULT_WEAPON);
  });

  it("ignores what is in the bag", () => {
    const kit = {
      ...emptyEquipment(),
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "sword" }] },
    };
    expect(weaponInHand(base, kit, lightTiles, firstHand(kit, lightTiles))).toEqual(CLAWS);
  });

  it("falls back when the slot holds something that is not a weapon", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "bag" },
    };
    expect(weaponInHand(base, kit, lightTiles, firstHand(kit, lightTiles))).toEqual(CLAWS);
  });

  it("falls back when the held tile is gone from the catalogue", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "no-such-tile" },
    };
    expect(weaponInHand(base, kit, lightTiles, firstHand(kit, lightTiles))).toEqual(CLAWS);
  });
});

describe("effectiveBattler", () => {
  it("takes damage, defence, accuracy and speed from the weapon", () => {
    const out = effectiveBattler(base, null, lightTiles, firstHand(null, lightTiles));
    const skill = base.masteries.fist! / MAX_MASTERY;
    expect(out.damage).toBe(
      Math.round(
        CLAWS.damage + skill * CLAWS.damage * MASTERY_DAMAGE_BONUS + skill * DAMAGE_AT_MAX_MASTERY,
      ),
    );
    expect(out.accuracy).toBe(
      Math.round(
        CLAWS.accuracy +
          skill * CLAWS.accuracy * MASTERY_ACCURACY_BONUS +
          skill * ACCURACY_AT_MAX_MASTERY,
      ),
    );
    expect(out.def).toBe(CLAWS.def + defFrom(20));
    expect(out.variance).toBe(CLAWS.variance);
    expect(out.spd).toBe(CLAWS.spd);
  });

  it("replaces all four when a weapon is held, adding none of them", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    const out = effectiveBattler(base, kit, lightTiles, firstHand(kit, lightTiles));
    expect(out.damage).toBe(DEFAULT_WEAPON.damage);
    expect(out.accuracy).toBe(DEFAULT_WEAPON.accuracy);
    expect(out.spd).toBe(DEFAULT_WEAPON.spd);
  });

  it("takes hit points and flee from the masteries, whatever is held", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    for (const equipment of [null, emptyEquipment(), kit]) {
      const out = effectiveBattler(base, equipment, lightTiles, firstHand(equipment, lightTiles));
      expect(out.maxHp).toBe(maxHpFrom(base.baseHp, 20));
      expect(out.flee).toBe(fleeFrom(6));
    }
  });

  it("takes its reach from the weapon and its sight from the body", () => {
    const out = effectiveBattler(base, null, lightTiles, firstHand(null, lightTiles));
    expect(out.reach).toEqual(base.naturalWeapon.reach);
    expect(out.sight).toEqual(base.sight);
  });

  it("does not mutate the body it was asked about", () => {
    const snapshot = structuredClone(base);
    effectiveBattler(
      base,
      {
        ...emptyEquipment(),
        weapon: { id: "w", tileId: "sword" },
      },
      lightTiles,
      firstHand(
        {
          ...emptyEquipment(),
          weapon: { id: "w", tileId: "sword" },
        },
        lightTiles,
      ),
    );
    expect(base).toEqual(snapshot);
  });
});

const LIT = { radius: 5, intensity: 1, color: "#ffcc88" };

function itemTile(id: string, item: unknown, light?: unknown): TileDef {
  return normalizeTileDef({
    id,
    name: id,
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    interactions: { item },
    sprite: {
      frames: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
          ...(light ? { light } : {}),
        },
      ],
    },
  });
}

const lightTiles = tilesByIdFromList([
  itemTile("sword", DEFAULT_WEAPON),
  itemTile("torch", DEFAULT_WEAPON, LIT),
  itemTile("bag", DEFAULT_CONTAINER),
  itemTile("lamp-bag", DEFAULT_CONTAINER, LIT),
]);

describe("carriedInstances", () => {
  it("is empty for an empty kit", () => {
    expect(carriedInstances(emptyEquipment())).toEqual([]);
  });

  it("counts the weapon, the bag, and what is in the bag", () => {
    const ids = carriedInstances({
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
      bag: {
        id: "b",
        tileId: "bag",
        contents: [{ id: "c", tileId: "sword" }],
      },
    }).map((i) => i.id);
    expect(ids).toEqual(["w", "b", "c"]);
  });
});

describe("carriedLightTileIds", () => {
  it("is empty when nothing carried gives off light", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  it("finds a light in the hand", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "torch" },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch"]);
  });

  it("finds a light in a bag that is itself lit, because a bag is worn", () => {
    const kit = {
      ...emptyEquipment(),
      bag: { id: "b", tileId: "lamp-bag" },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["lamp-bag"]);
  });

  it("ignores a light buried in the bag", () => {
    const kit = {
      ...emptyEquipment(),
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "torch" }] },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  it("lists every worn light separately, so they can be summed", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "torch" },
      bag: {
        id: "b",
        tileId: "lamp-bag",
        contents: [
          { id: "c", tileId: "torch" },
          { id: "d", tileId: "sword" },
        ],
      },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch", "lamp-bag"]);
  });

  it("ignores a tile the catalogue has never heard of", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "ghost" },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });
});

describe("restoredEquipment", () => {
  const tiles = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("bag", DEFAULT_CONTAINER),
    itemTile("chest", { ...DEFAULT_CONTAINER, size: 2, equippable: false }),
    itemTile("small-bag", { ...DEFAULT_CONTAINER, size: 2 }),
  ]);

  function bag(tileId: string, contents: Array<{ id: string; tileId: string }>) {
    return { id: "itm_bag", tileId, contents };
  }

  it("hands back a kit the world still agrees with", () => {
    const saved = {
      ...emptyEquipment(),
      weapon: { id: "itm_w", tileId: "sword" },
      bag: bag("bag", [{ id: "itm_a", tileId: "sword" }]),
    };
    expect(restoredEquipment(saved, tiles)).toEqual(saved);
  });

  it("drops a weapon whose tile has left the world", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        weapon: { id: "itm_w", tileId: "gone" },
      },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  it("keeps a pack held in a hand", () => {
    const held = { id: "itm_w", tileId: "bag" };
    const restored = restoredEquipment({ ...emptyEquipment(), weapon: held }, tiles);
    expect(restored.weapon).toEqual(held);
  });

  it("drops a chest held in a hand, since no hand may carry one", () => {
    const restored = restoredEquipment(
      { ...emptyEquipment(), weapon: { id: "itm_w", tileId: "chest" } },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  it("drops the whole bag when its tile is no longer wearable", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        bag: bag("chest", [{ id: "itm_a", tileId: "sword" }]),
      },
      tiles,
    );
    expect(restored.bag).toBeNull();
  });

  it("keeps a weapon whose bag went", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        weapon: { id: "itm_w", tileId: "sword" },
        bag: bag("gone", []),
      },
      tiles,
    );
    expect(restored.weapon?.tileId).toBe("sword");
    expect(restored.bag).toBeNull();
  });

  it("drops contents whose tiles have left the world", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        bag: bag("bag", [
          { id: "itm_a", tileId: "sword" },
          { id: "itm_b", tileId: "gone" },
        ]),
      },
      tiles,
    );
    expect(restored.bag?.contents?.map((i) => i.id)).toEqual(["itm_a"]);
  });

  it("drops a container that has found its way inside a bag", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        bag: bag("bag", [{ id: "itm_a", tileId: "chest" }]),
      },
      tiles,
    );
    expect(restored.bag?.contents).toEqual([]);
  });

  it("truncates to a bag that has been made smaller", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        bag: bag("small-bag", [
          { id: "itm_a", tileId: "sword" },
          { id: "itm_b", tileId: "sword" },
          { id: "itm_c", tileId: "sword" },
        ]),
      },
      tiles,
    );
    expect(restored.bag?.contents?.map((i) => i.id)).toEqual(["itm_a", "itm_b"]);
  });

  it("gives a saved item with no identity one, rather than leaving it unsendable", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        bag: {
          id: "itm_bag",
          tileId: "bag",
          contents: [{ tileId: "sword" }] as never,
        },
      },
      tiles,
    );
    expect(restored.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(restored.bag?.contents?.[0].tileId).toBe("sword");
  });

  it("gives an anonymous weapon and an anonymous bag one too", () => {
    const restored = restoredEquipment(
      {
        ...emptyEquipment(),
        weapon: { tileId: "sword" } as never,
        bag: { tileId: "bag", contents: [] } as never,
      },
      tiles,
    );
    expect(restored.weapon?.id).toMatch(/^itm_/);
    expect(restored.bag?.id).toMatch(/^itm_/);
  });

  it("hands back nothing at all for a kit of nothing", () => {
    expect(restoredEquipment(emptyEquipment(), tiles)).toEqual(emptyEquipment());
  });
});

describe("the off hand", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const holding = (offhand: string | null, weapon: string | null = null): Equipment => ({
    ...emptyEquipment(),
    weapon: weapon ? { id: `itm_${weapon}`, tileId: weapon } : null,
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
  });

  it("takes anything you could carry, a pack included", () => {
    expect(handAccepts(shipped["hand-lantern"]!)).toBe(true);
    expect(handAccepts(shipped["rusty-sword"]!)).toBe(true);
    expect(handAccepts(shipped["berry"]!)).toBe(true);
    expect(handAccepts(shipped["basic-bag"]!)).toBe(true);
    expect(handAccepts(shipped["crate-chest"]!)).toBe(false);
    expect(handAccepts(shipped["grass"]!)).toBe(false);
  });

  it("lights the room from the other hand, leaving the weapon hand free", () => {
    const lit = carriedLightTileIds(holding("hand-lantern", "rusty-sword"), shipped);
    expect(lit).toContain("hand-lantern");
  });

  it("leaves what you swing with entirely alone", () => {
    const bare = effectiveBattler(
      player,
      holding(null),
      shipped,
      firstHand(holding(null), shipped),
    );
    const lamp = effectiveBattler(
      player,
      holding("hand-lantern"),
      shipped,
      firstHand(holding("hand-lantern"), shipped),
    );

    expect(lamp.damage).toBe(bare.damage);
    expect(lamp.spd).toBe(bare.spd);
    expect(lamp.hitChance).toBe(bare.hitChance);
  });

  it("is no worse than bare hands in the hand you swing with either", () => {
    const bare = effectiveBattler(
      player,
      holding(null),
      shipped,
      firstHand(holding(null), shipped),
    );
    const lamp = effectiveBattler(
      player,
      holding(null, "hand-lantern"),
      shipped,
      firstHand(holding(null, "hand-lantern"), shipped),
    );

    expect(lamp.damage).toBe(bare.damage);
    expect(lamp.spd).toBe(bare.spd);
    expect(lamp.hitChance).toBe(bare.hitChance);
  });

  it("adds what it turns aside to your defence", () => {
    const withShield = { ...shipped, shield: SHIELD };

    const bare = effectiveBattler(
      player,
      holding(null),
      withShield,
      firstHand(holding(null), withShield),
    );
    const guarded = effectiveBattler(
      player,
      holding("shield"),
      withShield,
      firstHand(holding("shield"), withShield),
    );

    expect(guarded.def).toBe(bare.def + 3);
    expect(guarded.damage).toBe(bare.damage);
  });

  it("counts a shield in each hand, twice", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const oneHanded = holding("shield");
    const twoHanded = holding("shield", "shield");

    expect(wornDefence(player, holding(null), tiles)).toBe(0);
    expect(wornDefence(player, oneHanded, tiles)).toBe(3);
    expect(wornDefence(player, twoHanded, tiles)).toBe(6);
    expect(effectiveBattler(player, twoHanded, tiles, firstHand(twoHanded, tiles)).def).toBe(
      6 + bodyDefence(player),
    );
  });

  it("costs neither hand its swing", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const bare = holding(null);
    const inEitherHand = [holding("shield"), holding(null, "shield")];

    for (const kit of inEitherHand) {
      const shielded = effectiveBattler(player, kit, tiles, firstHand(kit, tiles));
      const fists = effectiveBattler(player, bare, tiles, firstHand(bare, tiles));

      expect(shielded.def).toBe(fists.def + 3);
      expect(shielded.damage).toBe(fists.damage);
      expect(fists.damage).toBeGreaterThan(0);
    }
  });

  it("keeps a body's own hide until it is swinging something else", () => {
    const hided: BattlerDef = {
      ...base,
      naturalWeapon: { ...CLAWS, def: 4 },
    };
    const tiles = { ...shipped, shield: SHIELD, sword: SWORD };

    expect(wornDefence(hided, emptyEquipment(), tiles)).toBe(4);
    expect(wornDefence(hided, holding("shield"), tiles)).toBe(4 + 3);
    expect(wornDefence(hided, holding(null, "shield"), tiles)).toBe(4 + 3);
    expect(wornDefence(hided, holding(null, "sword"), tiles)).toBe(SWORD_DEF);
    expect(wornDefence(hided, holding("sword"), tiles)).toBe(SWORD_DEF);
  });

  it("turns nothing aside when it is empty or holding a torch", () => {
    expect(heldDefence(holding(null), shipped)).toBe(0);
    expect(heldDefence(holding("hand-lantern"), shipped)).toBe(0);
    expect(heldDefence(null, shipped)).toBe(0);
  });

  it("restores a kit that predates it", () => {
    const old = { weapon: null, bag: null } as unknown as Equipment;
    expect(restoredEquipment(old, shipped).offhand).toBeNull();
  });
});

describe("the body", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const wearing = (armor: string | null, offhand: string | null = null): Equipment => ({
    ...emptyEquipment(),
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
    armor: armor ? { id: `itm_${armor}`, tileId: armor } : null,
  });

  it("adds what it turns aside to your defence", () => {
    const bare = effectiveBattler(
      player,
      wearing(null),
      shipped,
      firstHand(wearing(null), shipped),
    );
    const mailed = effectiveBattler(
      player,
      wearing("chain-mail"),
      shipped,
      firstHand(wearing("chain-mail"), shipped),
    );

    expect(mailed.def).toBe(bare.def + 3);
  });

  it("adds to the off hand rather than replacing it", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const kit = wearing("chain-mail", "shield");

    expect(wornDefence(player, kit, tiles)).toBe(3 + 3);
    expect(armorDefence(kit, tiles)).toBe(3);
    expect(heldDefence(kit, tiles)).toBe(3);
  });

  it("leaves what you swing with entirely alone", () => {
    const bare = effectiveBattler(
      player,
      wearing(null),
      shipped,
      firstHand(wearing(null), shipped),
    );
    const plated = effectiveBattler(
      player,
      wearing("steel-plate"),
      shipped,
      firstHand(wearing("steel-plate"), shipped),
    );

    expect(plated.damage).toBe(bare.damage);
    expect(plated.spd).toBe(bare.spd);
    expect(plated.hitChance).toBe(bare.hitChance);
    expect(plated.maxHp).toBe(bare.maxHp);
  });

  it("turns nothing aside when it is bare, or when the tile is gone", () => {
    expect(armorDefence(wearing(null), shipped)).toBe(0);
    expect(armorDefence(null, shipped)).toBe(0);
    expect(armorDefence(wearing("no-such-tile"), shipped)).toBe(0);
  });

  it("comes back empty when what was saved in it is not armour", () => {
    const restored = restoredEquipment(
      { ...emptyEquipment(), armor: { id: "itm_w", tileId: "rusty-sword" } },
      shipped,
    );
    expect(restored.armor).toBeNull();
  });

  it("keeps armour it can still read", () => {
    const restored = restoredEquipment(wearing("chain-mail"), shipped);
    expect(restored.armor?.tileId).toBe("chain-mail");
  });

  it("restores a kit that predates it", () => {
    const old = { weapon: null, offhand: null, bag: null } as unknown as Equipment;
    expect(restoredEquipment(old, shipped).armor).toBeNull();
  });
});

describe("taking turns between two hands", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const tiles: Record<string, TileDef> = {
    ...shipped,
    shield: SHIELD,
    sword: SWORD,
    parry: SWORD,
  };
  const base = resolveBattler(shipped["player"]!)!;

  const held = (weapon: string | null, offhand: string | null): Equipment => ({
    ...emptyEquipment(),
    weapon: weapon ? { id: `itm_${weapon}`, tileId: weapon } : null,
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
  });

  it("swings whichever hand it is up to, and then the other", () => {
    const both = held("sword", "rusty-sword");

    expect(handToSwing(both, tiles, "weapon")).toBe("weapon");
    expect(handToSwing(both, tiles, "offhand")).toBe("offhand");
    expect(otherHand("weapon")).toBe("offhand");
    expect(otherHand("offhand")).toBe("weapon");
  });

  it("swings two of the same weapon exactly as it swings one", () => {
    const one = held("parry", null);
    const two = held("parry", "parry");

    for (const hand of HANDS) {
      const swung = effectiveBattler(base, two, tiles, hand);
      const alone = effectiveBattler(base, one, tiles, "weapon");
      expect(swung.damage).toBe(alone.damage);
      expect(swung.spd).toBe(alone.spd);
      expect(swung.mastery).toBe(alone.mastery);
      expect(swung.accuracy).toBe(alone.accuracy);
      expect(swung.reach).toEqual(alone.reach);
    }
  });

  it("guards with both copies, because both are in the way", () => {
    const one = effectiveBattler(base, held("parry", null), tiles, "weapon");
    const two = effectiveBattler(base, held("parry", "parry"), tiles, "weapon");

    expect(two.def).toBe(one.def + PARRY_DEF);
  });

  it("never takes a turn with an empty hand", () => {
    for (const kit of [held("rusty-sword", null), held(null, "rusty-sword")]) {
      for (const preferred of HANDS) {
        const hand = handToSwing(kit, tiles, preferred);
        expect(hand).not.toBeNull();
        expect(weaponInHand(base, kit, tiles, hand).damage).toBe(
          resolveWeapon(tiles["rusty-sword"]!)!.damage,
        );
      }
    }
  });

  it("skips a hand holding a shield, a torch or a loaf", () => {
    for (const inert of ["shield", "hand-lantern", "bread"]) {
      const kit = held("rusty-sword", inert);
      expect(weaponSwungBy(kit, tiles, "offhand")).toBeNull();
      expect(handToSwing(kit, tiles, "offhand")).toBe("weapon");
    }
  });

  it("falls back to what the body was born with", () => {
    for (const kit of [emptyEquipment(), held("shield", "hand-lantern")]) {
      expect(handToSwing(kit, tiles, "weapon")).toBeNull();
      expect(weaponInHand(base, kit, tiles, null)).toEqual(base.naturalWeapon);
    }
  });

  describe("when a weapon has no answer to this fight", () => {
    const onlyTheMainHand = (_weapon: WeaponItem, hand: Hand) => hand === "weapon";
    const neither = () => false;

    it("takes the turn of a hand whose weapon cannot be used", () => {
      const both = held("sword", "rusty-sword");
      for (const preferred of HANDS) {
        expect(handToSwing(both, tiles, preferred, onlyTheMainHand)).toBe("weapon");
      }
    });

    it("does not simply refuse when the preferred hand is the useless one", () => {
      const both = held("sword", "rusty-sword");
      expect(handToSwing(both, tiles, "offhand", onlyTheMainHand)).toBe("weapon");
    });

    it("answers null when no hand's weapon works, and still counts as armed", () => {
      const both = held("sword", "rusty-sword");
      expect(handToSwing(both, tiles, "weapon", neither)).toBeNull();
      expect(fightsWithAHand(both, tiles)).toBe(true);
    });

    it("is not asked of a hand with nothing to swing in it", () => {
      const kit = held("sword", "hand-lantern");
      const asked: Hand[] = [];
      handToSwing(kit, tiles, "offhand", (_weapon, hand) => {
        asked.push(hand);
        return true;
      });
      expect(asked).toEqual(["weapon"]);
    });

    it("leaves a body with no filter exactly as it was", () => {
      const both = held("sword", "rusty-sword");
      expect(handToSwing(both, tiles, "offhand")).toBe("offhand");
    });
  });

  describe("fightsWithAHand", () => {
    it("is true for one weapon and for two", () => {
      expect(fightsWithAHand(held("sword", null), tiles)).toBe(true);
      expect(fightsWithAHand(held(null, "sword"), tiles)).toBe(true);
      expect(fightsWithAHand(held("sword", "rusty-sword"), tiles)).toBe(true);
    });

    it("is false for empty hands and for hands holding things nobody swings", () => {
      expect(fightsWithAHand(emptyEquipment(), tiles)).toBe(false);
      expect(fightsWithAHand(held("shield", "hand-lantern"), tiles)).toBe(false);
      expect(fightsWithAHand(null, tiles)).toBe(false);
    });
  });

  it("gives each hand its own blow, speed and mastery", () => {
    const mixed = held("rusty-sword", "simple-hammer");

    for (const [hand, tileId] of [
      ["weapon", "rusty-sword"],
      ["offhand", "simple-hammer"],
    ] as const) {
      const swung = effectiveBattler(base, mixed, tiles, hand);
      const alone = fightingStats(base, resolveWeapon(tiles[tileId]!)!);
      expect(swung.mastery).toBe(alone.mastery);
      expect(swung.damage).toBe(alone.damage);
      expect(swung.spd).toBe(alone.spd);
    }

    expect(effectiveBattler(base, mixed, tiles, "weapon").mastery).toBe("sharp");
    expect(effectiveBattler(base, mixed, tiles, "offhand").mastery).toBe("blunt");
  });

  it("leaves what the body is alone", () => {
    const mixed = held("rusty-sword", "simple-hammer");
    const sharp = effectiveBattler(base, mixed, tiles, "weapon");
    const blunt = effectiveBattler(base, mixed, tiles, "offhand");

    expect(blunt.maxHp).toBe(sharp.maxHp);
    expect(blunt.flee).toBe(sharp.flee);
    expect(blunt.haste).toBe(sharp.haste);
    expect(blunt.def).toBe(sharp.def);
  });

  it("counts both hands' guard on either turn", () => {
    const two = held("sword", "sword");
    for (const hand of HANDS) {
      expect(effectiveBattler(base, two, tiles, hand).def).toBe(
        effectiveBattler(base, held("sword", null), tiles, "weapon").def + SWORD_DEF,
      );
    }
  });
});

describe("a weapon that needs both hands", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const tiles: Record<string, TileDef> = { ...shipped, shield: SHIELD };
  const base = resolveBattler(shipped["player"]!)!;

  const held = (weapon: string | null, offhand: string | null): Equipment => ({
    ...emptyEquipment(),
    weapon: weapon ? { id: `itm_${weapon}`, tileId: weapon } : null,
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
  });

  it("is found in whichever hand is holding it, and claims the other", () => {
    expect(twoHandedHand(held("greatsword", null), tiles)).toBe("weapon");
    expect(handClaimedByTwoHander(held("greatsword", null), tiles)).toBe("offhand");
    expect(twoHandedHand(held(null, "greatsword"), tiles)).toBe("offhand");
    expect(handClaimedByTwoHander(held(null, "greatsword"), tiles)).toBe("weapon");
  });

  it("claims nothing when no two-handed weapon is held", () => {
    for (const kit of [emptyEquipment(), held("rusty-sword", null)]) {
      expect(twoHandedHand(kit, tiles)).toBeNull();
      expect(handClaimedByTwoHander(kit, tiles)).toBeNull();
    }
  });

  it("takes every turn itself", () => {
    const kit = held("greatsword", null);
    for (const preferred of HANDS) {
      expect(handToSwing(kit, tiles, preferred)).toBe("weapon");
    }
    expect(effectiveBattler(base, kit, tiles, "weapon").mastery).toBe("sharp");
  });

  it("guards once", () => {
    const great = resolveWeapon(shipped["greatsword"]!)!;
    const bare = effectiveBattler(base, emptyEquipment(), tiles, null);
    const wielding = effectiveBattler(base, held("greatsword", null), tiles, "weapon");
    expect(wielding.def - bare.def).toBe(great.def - base.naturalWeapon.def);
  });

  it("empties the hand it now claims, on a kit coming back", () => {
    const restored = restoredEquipment(held("greatsword", "rusty-sword"), tiles);
    expect(restored.weapon?.tileId).toBe("greatsword");
    expect(restored.offhand).toBeNull();

    const other = restoredEquipment(held("rusty-sword", "greatsword"), tiles);
    expect(other.offhand?.tileId).toBe("greatsword");
    expect(other.weapon).toBeNull();
  });

  it("keeps one when both hands somehow hold one", () => {
    const restored = restoredEquipment(held("greatsword", "greatsword"), tiles);
    expect(restored.weapon?.tileId).toBe("greatsword");
    expect(restored.offhand).toBeNull();
  });

  it("leaves an ordinary pair of hands alone", () => {
    const restored = restoredEquipment(held("rusty-sword", "simple-hammer"), tiles);
    expect(restored.weapon?.tileId).toBe("rusty-sword");
    expect(restored.offhand?.tileId).toBe("simple-hammer");
  });

  it("is authored on something in the world we ship", () => {
    const both = Object.values(shipped)
      .map(resolveWeapon)
      .filter((weapon): weapon is NonNullable<typeof weapon> => weapon != null)
      .filter((weapon) => weapon.twoHanded);
    expect(both.length).toBeGreaterThan(0);
  });
});

describe("the bows we ship", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const BOWS = ["simple-bow", "hunting-bow", "war-bow"];

  const bowOf = (id: string) => resolveWeapon(shipped[id]!)!;

  it("leaves a hand free for a knife, a torch or a stone", () => {
    for (const id of BOWS) expect(bowOf(id).twoHanded, id).toBeFalsy();
  });

  it("is dead over exactly the cells a knife covers", () => {
    for (const id of BOWS) {
      expect(bowOf(id).reach.min, id).toBe(2);
      expect(MELEE_REACH.cells * MELEE_REACH.cells).toBeGreaterThan(2);
      expect(MELEE_REACH.cells * MELEE_REACH.cells).toBeLessThan(4);
      expect(bowOf(id).reach.min! * bowOf(id).reach.min!).toBe(4);
    }
  });

  it("still reaches further than anything swung, and still fires", () => {
    for (const id of BOWS) {
      expect(bowOf(id).reach.cells, id).toBeGreaterThan(MELEE_REACH.cells);
      expect(bowOf(id).projectile, id).toBeDefined();
    }
  });
});

describe("the other worn squares", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const worn = (slots: Partial<Equipment>): Equipment => ({
    ...emptyEquipment(),
    ...slots,
  });

  const on = (tileId: string): ItemInstance => ({ id: `itm_${tileId}`, tileId });

  it("adds every square up rather than taking the best of them", () => {
    const helm = resolveArmor(shipped["iron-helm"]!)!;
    const mail = resolveArmor(shipped["chain-mail"]!)!;
    const boots = resolveArmor(shipped["steel-sabatons"]!)!;
    const ring = resolveArmor(shipped["copper-ring"]!)!;

    const dressed = worn({
      head: on("iron-helm"),
      armor: on("chain-mail"),
      footwear: on("steel-sabatons"),
      charm: on("copper-ring"),
    });

    expect(armorDefence(dressed, shipped)).toBe(helm.def + mail.def + boots.def + ring.def);
    const bare = effectiveBattler(
      player,
      emptyEquipment(),
      shipped,
      firstHand(emptyEquipment(), shipped),
    );
    expect(effectiveBattler(player, dressed, shipped, firstHand(dressed, shipped)).def).toBe(
      bare.def + armorDefence(dressed, shipped),
    );
  });

  it("sums the resistances too, kind by kind", () => {
    const both = worn({ head: on("iron-helm"), armor: on("chain-mail") });
    expect(armorResistances(both, shipped)).toEqual({ blunt: 2, sharp: 4 });

    const doubled = worn({
      head: on("knights-helm"),
      footwear: on("steel-sabatons"),
    });
    expect(armorResistances(doubled, shipped).sharp).toBe(3 + 2);
  });

  it("lets a square be a choice rather than a rung", () => {
    const charmed = worn({ charm: on("jade-amulet") });
    expect(armorDefence(charmed, shipped)).toBe(0);
    expect(armorResistances(charmed, shipped)).toEqual({ arcane: 5 });
  });

  it("refuses armour authored for a different square", () => {
    const muddled = worn({
      head: on("chain-mail"),
      footwear: on("iron-helm"),
      charm: on("steel-sabatons"),
    });
    expect(armorDefence(muddled, shipped)).toBe(0);

    const restored = restoredEquipment(muddled, shipped);
    expect(restored.head).toBeNull();
    expect(restored.footwear).toBeNull();
    expect(restored.charm).toBeNull();
  });

  it("keeps armour that belongs where it is sitting", () => {
    const restored = restoredEquipment(
      worn({ head: on("leather-cap"), footwear: on("worn-boots") }),
      shipped,
    );
    expect(restored.head?.tileId).toBe("leather-cap");
    expect(restored.footwear?.tileId).toBe("worn-boots");
  });

  it("restores a kit that predates them", () => {
    const old = { weapon: null, offhand: null, bag: null } as unknown as Equipment;
    const restored = restoredEquipment(old, shipped);
    expect(restored.head).toBeNull();
    expect(restored.charm).toBeNull();
    expect(restored.footwear).toBeNull();
  });

  it("has something to put in each of them in the world we ship", () => {
    const bySlot = new Map<string, string[]>();
    for (const [id, def] of Object.entries(shipped)) {
      const armor = resolveArmor(def);
      if (armor) bySlot.set(armorSlotOf(armor), [...(bySlot.get(armorSlotOf(armor)) ?? []), id]);
    }
    for (const slot of ARMOR_SLOTS) {
      expect(bySlot.get(slot) ?? []).not.toHaveLength(0);
    }
  });
});

describe("resisting a kind of blow", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const wearing = (armor: string): Equipment => ({
    ...emptyEquipment(),
    armor: { id: `itm_${armor}`, tileId: armor },
  });

  it("carries the armour's own block through to the fight", () => {
    const mailed = effectiveBattler(
      player,
      wearing("chain-mail"),
      shipped,
      firstHand(wearing("chain-mail"), shipped),
    );
    expect(mailed.resist.sharp).toBe(4);
    expect(mailed.resist.blunt).toBeUndefined();
  });

  it("says nothing for a bare chest or for armour with no opinion", () => {
    expect(armorResistances(null, shipped)).toEqual({});
    expect(armorResistances(emptyEquipment(), shipped)).toEqual({});
    expect(armorResistances(wearing("cloth-tunic"), shipped)).toEqual({});
  });

  it("is authored differently across the armours we ship", () => {
    const kinds = ["padded-gambeson", "leather-jerkin", "warded-robe", "chain-mail"]
      .map((id) => resolveArmor(shipped[id]!)!)
      .flatMap((armor) => Object.keys(armor.resist ?? {}));
    expect(new Set(kinds).size).toBeGreaterThan(1);
    expect(kinds).toContain("blunt");
    expect(kinds).toContain("sharp");
    expect(kinds).toContain("arcane");
  });
});

describe("the armour we ship", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  it("puts the base armour on the player, certainly", () => {
    const worn = (player.kit ?? []).filter((entry) => entry.slot === "armor");
    expect(worn).toEqual([{ slot: "armor", tileId: "cloth-tunic", chance: 100 }]);
  });

  it("makes what the player starts in the least of them", () => {
    const base = resolveArmor(shipped["cloth-tunic"]!)!;
    const others = Object.values(shipped)
      .map(resolveArmor)
      .filter((armor): armor is NonNullable<typeof armor> => armor != null)
      .filter((armor) => armorSlotOf(armor) === "armor")
      .filter((armor) => armor !== base);

    expect(others.length).toBeGreaterThan(0);
    for (const armor of others) {
      const best = Math.max(...Object.values(armor.resist ?? { none: 0 }), 0);
      expect(armor.def + best).toBeGreaterThan(base.def);
    }
    expect(base.resist).toBeUndefined();
  });
});

describe("bodyElements", () => {
  const item = (id: string, block: Record<string, unknown>) =>
    normalizeTileDef({
      id,
      name: id,
      height: 0,
      kind: "item",
      directional: false,
      attributes: {},
      variants: { default: [] },
      intangible: true,
      interactions: { item: block },
    });

  const TUNIC = item("tunic", { type: "armor", def: 0, elements: ["fire"] });
  const AMULET = item("amulet", {
    type: "armor",
    slot: "charm",
    def: 0,
    elements: ["water"],
  });
  const BRAND = item("brand", {
    ...DEFAULT_WEAPON,
    elements: ["nature"],
  });
  const BREAD = item("bread", { type: "consumable", hp: 1 });
  const PACK = item("pack", { type: "container", size: 2, equippable: true });

  const tiles = tilesByIdFromList(
    [TUNIC, AMULET, BRAND, BREAD, PACK].map((def) => ({ ...def })) as never,
  );

  const wearing = (slots: Partial<Record<string, ItemInstance>>): Equipment =>
    ({ ...emptyEquipment(), ...slots }) as Equipment;

  const held = (tileId: string): ItemInstance => ({ id: tileId, tileId });

  it("is nothing for a bare body that was authored as nothing", () => {
    expect(bodyElements(base, null, tiles)).toEqual([]);
    expect(bodyElements(base, emptyEquipment(), tiles)).toEqual([]);
  });

  it("is what the battler was authored as", () => {
    const troll: BattlerDef = { ...base, elements: ["fire"] };
    expect(bodyElements(troll, emptyEquipment(), tiles)).toEqual(["fire"]);
  });

  it("never reads a mastery, however high", () => {
    const adept: BattlerDef = {
      ...base,
      masteries: { ...base.masteries, fire: MAX_MASTERY, nature: MAX_MASTERY },
    };
    expect(bodyElements(adept, emptyEquipment(), tiles)).toEqual([]);
  });

  it("is what the body is wearing, for a body that is nothing itself", () => {
    expect(bodyElements(base, wearing({ armor: held("tunic") }), tiles)).toEqual(["fire"]);
  });

  it("counts a held thing as well as a worn one", () => {
    expect(bodyElements(base, wearing({ weapon: held("brand") }), tiles)).toEqual(["nature"]);
  });

  it("unions the body's own with everything on it", () => {
    const troll: BattlerDef = { ...base, elements: ["fire"] };
    expect(bodyElements(troll, wearing({ charm: held("amulet") }), tiles)).toEqual([
      "fire",
      "water",
    ]);
  });

  it("says an element once however many things carry it", () => {
    const burning: BattlerDef = { ...base, elements: ["fire"] };
    expect(bodyElements(burning, wearing({ armor: held("tunic") }), tiles)).toEqual(["fire"]);
  });

  it("answers in the elements' own order", () => {
    expect(
      bodyElements(base, wearing({ charm: held("amulet"), armor: held("tunic") }), tiles),
    ).toEqual(["fire", "water"]);
  });

  it("ignores what is only being carried", () => {
    const pack = { ...held("pack"), contents: [held("tunic")] };
    expect(bodyElements(base, wearing({ bag: pack }), tiles)).toEqual([]);
  });

  it("ignores a square holding something that has nothing to say", () => {
    expect(bodyElements(base, wearing({ armor: held("bread") }), tiles)).toEqual([]);
  });

  it("is silent about a square whose tile the catalogue has lost", () => {
    expect(bodyElements(base, wearing({ armor: held("gone") }), tiles)).toEqual([]);
  });
});

describe("spilled", () => {
  const tiles = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("bag", DEFAULT_CONTAINER),
    itemTile("berry", { type: "consumable", label: "Eat", hp: 1 }),
  ]);

  const SWORD = { id: "itm_sword", tileId: "sword" };
  const BERRY = { id: "itm_berry", tileId: "berry" };
  const PACK = { id: "itm_bag", tileId: "bag", contents: [BERRY] };

  it("leaves what was worn, in the order the squares are reached for", () => {
    expect(spilled({ ...emptyEquipment(), weapon: SWORD }, tiles)).toEqual([SWORD]);
  });

  it("spills the bag's contents and drops the bag itself", () => {
    const left = spilled({ ...emptyEquipment(), weapon: SWORD, bag: PACK }, tiles);
    expect(left).toEqual([SWORD, BERRY]);
  });

  it("leaves nothing at all for an empty pack", () => {
    const empty = { id: "itm_bag", tileId: "bag", contents: [] };
    expect(spilled({ ...emptyEquipment(), bag: empty }, tiles)).toEqual([]);
  });

  it("leaves a pack carried in a hand alone, contents and all", () => {
    expect(spilled({ ...emptyEquipment(), weapon: PACK }, tiles)).toEqual([PACK]);
  });

  it("drops a bag whose tile the catalogue has lost rather than losing it", () => {
    const unknown = { id: "itm_bag", tileId: "gone", contents: [BERRY] };
    expect(spilled({ ...emptyEquipment(), bag: unknown }, tiles)).toEqual([unknown]);
  });
});

describe("takesEffect", () => {
  const ROBE = { type: "armor", slot: "armor", def: 1, elements: ["nature"] };
  const HELM = { type: "armor", slot: "head", def: 2 };
  const BREAD = { type: "consumable", hp: 2 };
  const COIN = { type: "artifact" };
  const TRINKET = { type: "charm", everyMs: 10_000, hp: 1 };
  const SPARK = {
    type: "stone",
    cooldownMs: 4_000,
    requirements: { arcane: 5 },
    effect: { kind: "bolt", on: "target", damage: 3 },
  };

  const tiles = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("shield", { type: "shield", def: 3 }),
    itemTile("bag", DEFAULT_CONTAINER),
    itemTile("torch", COIN, LIT),
    itemTile("robe", ROBE),
    itemTile("helm", HELM),
    itemTile("bread", BREAD),
    itemTile("coin", COIN),
    itemTile("trinket", TRINKET),
    itemTile("spark", SPARK),
  ]);

  const held = (tileId: string) => ({ id: `itm_${tileId}`, tileId });
  const ADEPT = { arcane: 5 };
  const NOVICE = { arcane: 4 };

  it("says nothing of an empty square", () => {
    expect(takesEffect("weapon", null, tiles, ADEPT)).toBe(false);
  });

  it("says nothing of a tile the catalogue has lost", () => {
    expect(takesEffect("weapon", held("gone"), tiles, ADEPT)).toBe(false);
  });

  it("counts a weapon and a shield in a hand", () => {
    expect(takesEffect("weapon", held("sword"), tiles, ADEPT)).toBe(true);
    expect(takesEffect("offhand", held("shield"), tiles, ADEPT)).toBe(true);
  });

  it("counts a pack, in a hand as well as on a back", () => {
    expect(takesEffect("offhand", held("bag"), tiles, ADEPT)).toBe(true);
    expect(takesEffect("bag", held("bag"), tiles, ADEPT)).toBe(true);
  });

  it("counts armour in the square it was authored for", () => {
    expect(takesEffect("head", held("helm"), tiles, ADEPT)).toBe(true);
  });

  it("does not count armour carried in a fist", () => {
    expect(takesEffect("weapon", held("helm"), tiles, ADEPT)).toBe(false);
  });

  it("does not count food or a trinket with nothing to say", () => {
    expect(takesEffect("weapon", held("bread"), tiles, ADEPT)).toBe(false);
    expect(takesEffect("offhand", held("coin"), tiles, ADEPT)).toBe(false);
  });

  it("counts a light and an element wherever they are held", () => {
    expect(takesEffect("weapon", held("torch"), tiles, ADEPT)).toBe(true);
    expect(takesEffect("offhand", held("robe"), tiles, ADEPT)).toBe(true);
  });

  it("counts a charm round the neck and nowhere else", () => {
    expect(takesEffect("charm", held("trinket"), tiles, ADEPT)).toBe(true);
    expect(takesEffect("armor", held("trinket"), tiles, ADEPT)).toBe(false);
  });

  it("counts a stone the caster has earned, in any square that takes one", () => {
    expect(takesEffect("weapon", held("spark"), tiles, ADEPT)).toBe(true);
    expect(takesEffect("charm", held("spark"), tiles, ADEPT)).toBe(true);
  });

  it("does not count one they have not", () => {
    expect(takesEffect("weapon", held("spark"), tiles, NOVICE)).toBe(false);
    expect(takesEffect("charm", held("spark"), tiles, NOVICE)).toBe(false);
  });
});

describe("wornAccepts", () => {
  const tiles = tilesByIdFromList([
    itemTile("helm", { type: "armor", slot: "head", def: 2 }),
    itemTile("ring", { type: "armor", slot: "charm", def: 1 }),
    itemTile("trinket", { type: "charm", everyMs: 10_000, hp: 1 }),
    itemTile("spark", {
      type: "stone",
      cooldownMs: 4_000,
      effect: { kind: "bolt", on: "target", damage: 3 },
    }),
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("bread", { type: "consumable", label: "Eat", hp: 1 }),
    itemTile("torch", { type: "artifact" }, LIT),
    itemTile("lit-helm", { type: "armor", slot: "head", def: 2 }, LIT),
  ]);

  it("takes armour authored for this square and no other", () => {
    expect(wornAccepts("charm", tiles.ring!)).toBe(true);
    expect(wornAccepts("head", tiles.ring!)).toBe(false);
    expect(wornAccepts("head", tiles.helm!)).toBe(true);
    expect(wornAccepts("charm", tiles.helm!)).toBe(false);
  });

  it("takes a charm, which no other square will have", () => {
    expect(wornAccepts("charm", tiles.trinket!)).toBe(true);
    for (const slot of ["head", "armor", "footwear"] as const) {
      expect(wornAccepts(slot, tiles.trinket!), slot).toBe(false);
    }
  });

  it("takes a stone, on a hand's terms and without the swing", () => {
    expect(wornAccepts("charm", tiles.spark!)).toBe(true);
    expect(wornAccepts("armor", tiles.spark!)).toBe(false);
  });

  it("takes a light, and only in this square", () => {
    expect(wornAccepts("charm", tiles.torch!)).toBe(true);
    for (const slot of ["head", "armor", "footwear"] as const) {
      expect(wornAccepts(slot, tiles.torch!), slot).toBe(false);
    }
  });

  it("does not let a light override the square its armour names", () => {
    expect(wornAccepts("head", tiles["lit-helm"]!)).toBe(true);
    expect(wornAccepts("armor", tiles["lit-helm"]!)).toBe(false);
    expect(wornAccepts("charm", tiles["lit-helm"]!)).toBe(true);
  });

  it("refuses a sword and a loaf everywhere worn", () => {
    for (const slot of ARMOR_SLOTS) {
      expect(wornAccepts(slot, tiles.sword!), slot).toBe(false);
      expect(wornAccepts(slot, tiles.bread!), slot).toBe(false);
    }
  });
});

describe("the shipped torch, worn as an accessory", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));

  const wearing = (tileId: string): Equipment => ({
    ...emptyEquipment(),
    charm: { id: `itm_${tileId}`, tileId },
  });

  it("goes in the accessory square", () => {
    expect(wornAccepts("charm", shipped["hand-lantern"]!)).toBe(true);
  });

  it("lights the room from there, with both hands still free", () => {
    const kit = wearing("hand-lantern");
    expect(carriedLightTileIds(kit, shipped)).toContain("hand-lantern");
    expect(kit.weapon).toBeNull();
    expect(kit.offhand).toBeNull();
  });

  it("is drawn as a square that is doing something", () => {
    const kit = wearing("hand-lantern");
    expect(takesEffect("charm", kit.charm, shipped, {})).toBe(true);
  });

  it("has not stopped being something to carry in a hand", () => {
    expect(handAccepts(shipped["hand-lantern"]!)).toBe(true);
  });
});

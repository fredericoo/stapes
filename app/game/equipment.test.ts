import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BattlerDef } from "../lib/battler";
import {
  DEFAULT_BATTLER,
  ACCURACY_AT_MAX_MASTERY,
  bodyDefence,
  DAMAGE_AT_MAX_MASTERY,
  defFrom,
  fleeFrom,
  MASTERY_ACCURACY_BONUS,
  MASTERY_DAMAGE_BONUS,
  maxHpFrom,
  resolveBattler,
} from "../lib/battler";
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
  fightsWithBothHands,
  HANDS,
  handToSwing,
  heldDefence,
  carriedInstances,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  handAccepts,
  restoredEquipment,
  otherHand,
  weaponInHand,
  weaponSwungBy,
  wornDefence,
} from "./equipment";


/**
 * The hand a body starts a fight on, which is what nearly every case here means.
 *
 * Both hands swing now, so "the numbers this body fights with" is a question
 * about a *turn* rather than about a body — see `./equipment`'s
 * `effectiveBattler`. Almost nothing below is about the rotation, so almost
 * everything below asks for the first hand that has something to swing and lets
 * `handToSwing` fall back to bare hands on its own. The cases that *are* about
 * the rotation name their hand outright.
 */
function firstHand(
  equipment: Equipment | null,
  tiles: Record<string, TileDef>,
): Hand | null {
  return handToSwing(equipment, tiles, HANDS[0]);
}

/**
 * A body with recognisable claws, so "which weapon won" is answerable by
 * looking at one number.
 *
 * Deliberately unlike {@link DEFAULT_WEAPON} in every field: a fixture that
 * happened to agree with the fallback would pass whichever weapon the code
 * picked, which is the one thing these tests exist to tell apart.
 */
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

/**
 * Something that turns blows aside and does nothing else, so a defence figure is
 * traceable to one slot.
 *
 * A `weapon` block with no damage on it, which is what a shield *is* in this
 * game: defence rides on a weapon and armour is the thing you wear. See
 * `WeaponItem.def`.
 */
/** A parrying sword: something a hand swings *and* turns blows aside with. */
const SWORD_DEF = 2;
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

/**
 * Which weapon a body swings, and what the masteries do regardless.
 *
 * The claim under test is **replacement, not addition** — the rule the whole
 * mastery model rests on. Every assertion below would also pass under the old
 * sum if the numbers happened to line up, which is why the fixture's claws
 * disagree with the default weapon in every single field.
 */
describe("weaponInHand", () => {
  it("falls back to the natural weapon with an empty hand", () => {
    expect(weaponInHand(base, null, lightTiles, firstHand(null, lightTiles))).toEqual(CLAWS);
    expect(weaponInHand(base, emptyEquipment(), lightTiles, firstHand(emptyEquipment(), lightTiles))).toEqual(CLAWS);
  });

  it("takes what is in the hand instead, rather than as well", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    expect(weaponInHand(base, kit, lightTiles, firstHand(kit, lightTiles))).toEqual(DEFAULT_WEAPON);
  });

  /** The bag is carried, not wielded — nothing in it reaches a blow. */
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

  /**
   * A tile renamed while somebody was holding it. The fact is out of date, not
   * corrupt, so the hand reads as empty rather than as a body with no weapon at
   * all — which would be a creature that cannot swing.
   */
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
    // **The weapon's numbers plus what being good with it adds.** A weapon that
    // asks nothing is at full readiness for anybody, so what separates this from
    // the authored figure is Fist alone — see `../lib/battler`'s two axes.
    const skill = base.masteries.fist! / MAX_MASTERY;
    expect(out.damage).toBe(
      Math.round(
        CLAWS.damage +
          skill * CLAWS.damage * MASTERY_DAMAGE_BONUS +
          skill * DAMAGE_AT_MAX_MASTERY,
      ),
    );
    expect(out.accuracy).toBe(
      Math.round(
        CLAWS.accuracy +
          skill * CLAWS.accuracy * MASTERY_ACCURACY_BONUS +
          skill * ACCURACY_AT_MAX_MASTERY,
      ),
    );
    // **The weapon's defence plus the body's own.** Defence used to come only
    // from what you were holding, and every weapon in the world authors zero —
    // so it was a rule with no source. Toughness is the source now, and the two
    // sum. @see `../lib/battler`'s `defFrom`
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

  /**
   * The other half of the split: what a body *is* comes from its masteries and
   * cannot be picked up or put down. A sword that raised your hit points would
   * mean health had to be re-checked every time anybody equipped anything.
   */
  it("takes hit points and flee from the masteries, whatever is held", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    };
    for (const equipment of [null, emptyEquipment(), kit]) {
      const out = effectiveBattler(base, equipment, lightTiles, firstHand(equipment, lightTiles));
      expect(out.maxHp).toBe(maxHpFrom(20));
      expect(out.flee).toBe(fleeFrom(6));
    }
  });

  it("takes its reach from the weapon and its sight from the body", () => {
    const out = effectiveBattler(base, null, lightTiles, firstHand(null, lightTiles));
    // The natural weapon's, because that is what an empty hand swings — and the
    // whole of why reach moved off the body: a bow in that hand would answer
    // differently, where a tile-level number could not.
    expect(out.reach).toEqual(base.naturalWeapon.reach);
    expect(out.sight).toEqual(base.sight);
  });

  it("does not mutate the body it was asked about", () => {
    const snapshot = structuredClone(base);
    effectiveBattler(base, {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    }, lightTiles, firstHand({
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "sword" },
    }, lightTiles));
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

  /**
   * A torch in your pack lights nothing, and that is the point of a slot: with
   * the bag counting, carrying a lantern cost nothing and there was no decision
   * in whether to hold one.
   */
  it("ignores a light buried in the bag", () => {
    const kit = {
      ...emptyEquipment(),
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "torch" }] },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  /**
   * Every worn light counts, and each is a separate entry — the cast
   * accumulates emitters, so two lights at one position is two emitters and
   * twice the light rather than one light's worth.
   */
  it("lists every worn light separately, so they can be summed", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: { id: "w", tileId: "torch" },
      bag: {
        id: "b",
        tileId: "lamp-bag",
        contents: [{ id: "c", tileId: "torch" }, { id: "d", tileId: "sword" }],
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

/**
 * A kit coming back out of the world's memory.
 *
 * Everything here is about the authored content having moved on while somebody
 * was away, which is not corruption and must not cost them their world: what the
 * tiles no longer agree with is dropped, and the rest is handed back.
 */
describe("restoredEquipment", () => {
  const tiles = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("bag", DEFAULT_CONTAINER),
    itemTile("chest", { ...DEFAULT_CONTAINER, size: 2, equippable: false }),
    // Two slots, for the case where an author has shrunk the pack.
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

  /** A hand takes anything you can carry, so a pack in one survives a reload. */
  it("keeps a pack held in a hand", () => {
    const held = { id: "itm_w", tileId: "bag" };
    const restored = restoredEquipment(
      { ...emptyEquipment(), weapon: held },
      tiles,
    );
    expect(restored.weapon).toEqual(held);
  });

  it("drops a chest held in a hand, since no hand may carry one", () => {
    const restored = restoredEquipment(
      { ...emptyEquipment(), weapon: { id: "itm_w", tileId: "chest" } },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  // The bag goes and its contents go with it. There is nowhere else for them:
  // the inventory *is* the bag's `contents`, so a kit with things in no bag is
  // a shape the model does not have.
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

  // The nesting rule, arriving from the one direction that bypasses every gate
  // in `itemMoves`: not a move at all, but a memory of a world where that thing
  // was something else.
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

  /**
   * Storage is where a shape from an older build arrives from, and this one was
   * written by a build that let an anonymous sword out of a chest. The kit is
   * unusable rather than merely odd: `id` is required on the wire, so one saved
   * item without one is a `hello` that fails to parse and a player stuck on
   * "Connecting" forever, with no way to put down the thing that did it.
   */
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

/**
 * The other hand.
 *
 * It exists because the swinging hand was the only hand there was, and a held
 * weapon *replaces* your fists rather than adding to them — so a lantern, which
 * had to be authored as a weapon to be equippable at all, meant fighting at a
 * twentieth of your bare hands in order to see in the dark. That is a real
 * trade-off to offer somebody and a terrible one to impose on them silently.
 *
 * Against the shipped catalogue, because the whole point is what an author
 * actually wrote down.
 */
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
    // Your choice, and the game has no business refusing it.
    expect(handAccepts(shipped["basic-bag"]!)).toBe(true);
    // The one refusal: `equippable: false` is an author saying this is a chest,
    // opened where it lies and never carried.
    expect(handAccepts(shipped["crate-chest"]!)).toBe(false);
    // Not an item at all.
    expect(handAccepts(shipped["grass"]!)).toBe(false);
  });

  /**
   * **The whole reason the slot exists**: a lamp lights the room from here, so
   * seeing in the dark no longer costs you the hand you fight with.
   */
  it("lights the room from the other hand, leaving the weapon hand free", () => {
    const lit = carriedLightTileIds(holding("hand-lantern", "rusty-sword"), shipped);
    expect(lit).toContain("hand-lantern");
  });

  it("leaves what you swing with entirely alone", () => {
    const bare = effectiveBattler(player, holding(null), shipped, firstHand(holding(null), shipped));
    const lamp = effectiveBattler(player, holding("hand-lantern"), shipped, firstHand(holding("hand-lantern"), shipped));

    expect(lamp.damage).toBe(bare.damage);
    expect(lamp.spd).toBe(bare.spd);
    expect(lamp.hitChance).toBe(bare.hitChance);
  });

  /**
   * The slot was only half an answer, and this is the other half. A torch
   * authored as a weapon *replaced* your fists wherever it was put, so the off
   * hand rescued the common case and left the wrong hand quietly ruinous:
   * dragging the lamp one square over cost a player most of their fight, and the
   * numbers doing it were invented purely to get a stick into a hand. There are
   * none now — see `../lib/item`'s `ArtifactItem` — so there is nothing left for
   * `weaponInHand` to prefer over what the body already had.
   */
  it("is no worse than bare hands in the hand you swing with either", () => {
    const bare = effectiveBattler(player, holding(null), shipped, firstHand(holding(null), shipped));
    const lamp = effectiveBattler(player, holding(null, "hand-lantern"), shipped, firstHand(holding(null, "hand-lantern"), shipped));

    expect(lamp.damage).toBe(bare.damage);
    expect(lamp.spd).toBe(bare.spd);
    expect(lamp.hitChance).toBe(bare.hitChance);
  });

  /**
   * And the other half of "a torch or a shield": defence, read off the `def` a
   * weapon carries — which stays where it is now that armour has a slot, because
   * a shield is a thing you *hold*. Making it armour would put it in the square
   * a breastplate belongs in and let a body wear one instead of the other.
   */
  it("adds what it turns aside to your defence", () => {
    const withShield = { ...shipped, shield: SHIELD };

    const bare = effectiveBattler(player, holding(null), withShield, firstHand(holding(null), withShield));
    const guarded = effectiveBattler(player, holding("shield"), withShield, firstHand(holding("shield"), withShield));

    expect(guarded.def).toBe(bare.def + 3);
    // Still swinging your own fists, which is the point of it being the *other*
    // hand rather than a second weapon.
    expect(guarded.damage).toBe(bare.damage);
  });

  /**
   * **Both hands count, and the main hand's contribution is not new** — it has
   * always reached a fight through `weaponInHand`, since a held weapon replaces
   * the natural one and carries its `def` along with everything else. What
   * changed is that `wornDefence` now says so: it was the off hand and the body
   * only, so "how protected is this body" had two answers in two functions and
   * `WeaponItem.def`'s own comment claimed the swinging hand contributed
   * nothing. It does, and here is the arithmetic that proves it.
   */
  it("counts a shield in each hand, twice", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const oneHanded = holding("shield");
    const twoHanded = holding("shield", "shield");

    expect(wornDefence(player, holding(null), tiles)).toBe(0);
    expect(wornDefence(player, oneHanded, tiles)).toBe(3);
    expect(wornDefence(player, twoHanded, tiles)).toBe(6);
    // Plus what the body turns aside on its own, which `wornDefence` does not
    // count — see `../lib/battler`'s `bodyDefence`.
    expect(effectiveBattler(player, twoHanded, tiles, firstHand(twoHanded, tiles)).def).toBe(
      6 + bodyDefence(player),
    );
  });

  /**
   * **A shield costs you nothing to hold, in either fist**, and that is the
   * whole reason it stopped being a weapon.
   *
   * It used to cost the swinging hand its swing — a shield was a `damage: 0`
   * weapon and the main hand's contents replaced your fists, so taking one up
   * meant punching for nothing. That was a rule nobody wrote: it fell out of a
   * shield having to be authored as the only kind of block that fitted in a
   * hand. Now it is a {@link ShieldItem}, `weaponSwungBy` refuses it, and the
   * hand holding it simply sits out — which is what a shield *is*.
   */
  it("costs neither hand its swing", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const bare = holding(null);
    const inEitherHand = [holding("shield"), holding(null, "shield")];

    for (const kit of inEitherHand) {
      const shielded = effectiveBattler(player, kit, tiles, firstHand(kit, tiles));
      const fists = effectiveBattler(player, bare, tiles, firstHand(bare, tiles));

      expect(shielded.def).toBe(fists.def + 3);
      // Still your own fists, whichever hand the shield went in — where the main
      // hand used to be the one that punished you for it.
      expect(shielded.damage).toBe(fists.damage);
      expect(fists.damage).toBeGreaterThan(0);
    }
  });

  /**
   * A body whose own hide turns blows aside keeps it until it is fighting with
   * something else — and a shield is not something else.
   *
   * **The case the old asymmetry got wrong in both directions.** What counted
   * was whether the *main* hand was full, so claws-plus-a-shield depended on
   * which fist the shield was in: 3 in the right, 7 in the left, for a body
   * holding one thing. Now it is whether either hand has anything to *swing*,
   * which is one question with one answer — see `natureDefence`.
   */
  it("keeps a body's own hide until it is swinging something else", () => {
    const hided: BattlerDef = {
      ...base,
      naturalWeapon: { ...CLAWS, def: 4 },
    };
    const tiles = { ...shipped, shield: SHIELD, sword: SWORD };

    expect(wornDefence(hided, emptyEquipment(), tiles)).toBe(4);
    // A shield in either hand: still fighting with its claws, so still 4 — plus
    // the shield. The two hands answer identically, which they did not before.
    expect(wornDefence(hided, holding("shield"), tiles)).toBe(4 + 3);
    expect(wornDefence(hided, holding(null, "shield"), tiles)).toBe(4 + 3);
    // And loses the hide the moment either hand takes up something it swings,
    // which is the same replacement rule the swing itself is under.
    expect(wornDefence(hided, holding(null, "sword"), tiles)).toBe(SWORD_DEF);
    expect(wornDefence(hided, holding("sword"), tiles)).toBe(SWORD_DEF);
  });

  it("turns nothing aside when it is empty or holding a torch", () => {
    expect(heldDefence(holding(null), shipped)).toBe(0);
    expect(heldDefence(holding("hand-lantern"), shipped)).toBe(0);
    expect(heldDefence(null, shipped)).toBe(0);
  });

  /** A kit saved before the slot existed comes back with an empty hand. */
  it("restores a kit that predates it", () => {
    const old = { weapon: null, bag: null } as unknown as Equipment;
    expect(restoredEquipment(old, shipped).offhand).toBeNull();
  });
});

/**
 * The body.
 *
 * The first of the four squares armour goes in, and one of the squares that
 * refuse things: both hands take anything you can carry, and a chest takes
 * armour authored for a chest. Against the shipped catalogue, because what an
 * author actually wrote down is half the claim — a base armour nobody starts
 * in, or one that is not the weakest thing in the world, is a design that has
 * quietly stopped being true.
 */
describe("the body", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const wearing = (armor: string | null, offhand: string | null = null): Equipment => ({
    ...emptyEquipment(),
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
    armor: armor ? { id: `itm_${armor}`, tileId: armor } : null,
  });

  it("adds what it turns aside to your defence", () => {
    const bare = effectiveBattler(player, wearing(null), shipped, firstHand(wearing(null), shipped));
    const mailed = effectiveBattler(player, wearing("chain-mail"), shipped, firstHand(wearing("chain-mail"), shipped));

    expect(mailed.def).toBe(bare.def + 3);
  });

  /**
   * The whole reason these are separate slots. A shield is what you put in the
   * way and a shirt is what you have on, and a body with both should be
   * protected by both — one number replacing the other would make wearing mail a
   * reason to drop your shield.
   */
  it("adds to the off hand rather than replacing it", () => {
    const tiles = { ...shipped, shield: SHIELD };
    const kit = wearing("chain-mail", "shield");

    // Bare hands, so the main hand contributes the player's own zero.
    expect(wornDefence(player, kit, tiles)).toBe(3 + 3);
    expect(armorDefence(kit, tiles)).toBe(3);
    expect(heldDefence(kit, tiles)).toBe(3);
  });

  /** What a body *is* cannot be put on, exactly as it cannot be picked up. */
  it("leaves what you swing with entirely alone", () => {
    const bare = effectiveBattler(player, wearing(null), shipped, firstHand(wearing(null), shipped));
    const plated = effectiveBattler(player, wearing("steel-plate"), shipped, firstHand(wearing("steel-plate"), shipped));

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

  /**
   * The strict square. A hand refusing a thing you could obviously hold is the
   * interface arguing with you; a chest wearing a sword is a number about
   * nothing, since defence is the entirety of what the slot contributes.
   */
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

  /** A kit saved before the slot existed comes back with a bare chest. */
  it("restores a kit that predates it", () => {
    const old = { weapon: null, offhand: null, bag: null } as unknown as Equipment;
    expect(restoredEquipment(old, shipped).armor).toBeNull();
  });
});

/**
 * Two hands, and they are the same hand twice.
 *
 * **The claim is that a hand is a square rather than a rank.** What used to make
 * the main hand special was one field being read where two existed: a second
 * sword was inert, a shield dragged into the right fist replaced what you fought
 * with, and neither was a rule anybody wrote down. These pin the rotation and,
 * just as importantly, what it deliberately does *not* do.
 */
describe("taking turns between two hands", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const tiles: Record<string, TileDef> = {
    ...shipped,
    shield: SHIELD,
    sword: SWORD,
  };
  // The shipped player rather than the bare fixture above: a body with no
  // masteries meets no weapon's requirements, so every blow it throws resolves
  // to zero and two different weapons would look identical for the wrong reason.
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
    expect(fightsWithBothHands(both, tiles)).toBe(true);
  });

  /**
   * The property every change here should be checked against: alternating
   * between two identical weapons is the same fight as swinging one of them.
   * If it ever stops being true, the rotation has grown a rule it should not
   * have.
   */
  it("makes two of the same weapon the same fight as one", () => {
    const one = held("rusty-sword", null);
    const two = held("rusty-sword", "rusty-sword");

    for (const hand of HANDS) {
      expect(effectiveBattler(base, two, tiles, hand)).toEqual(
        effectiveBattler(base, one, tiles, "weapon"),
      );
    }
  });

  /**
   * **An empty hand is not a turn.** A body alternating a sword and a fist would
   * land half the blows it used to for holding exactly what it held before,
   * which is the one way ambidexterity could quietly be a nerf.
   */
  it("never takes a turn with an empty hand", () => {
    for (const kit of [held("rusty-sword", null), held(null, "rusty-sword")]) {
      // Whosever turn it nominally is, the hand with the sword answers.
      for (const preferred of HANDS) {
        const hand = handToSwing(kit, tiles, preferred);
        expect(hand).not.toBeNull();
        expect(weaponInHand(base, kit, tiles, hand).damage).toBe(
          resolveWeapon(tiles["rusty-sword"]!)!.damage,
        );
      }
    }
  });

  /** Nor is a hand holding something a fight cannot see, or will not swing. */
  it("skips a hand holding a shield, a torch or a loaf", () => {
    for (const inert of ["shield", "hand-lantern", "bread"]) {
      const kit = held("rusty-sword", inert);
      expect(weaponSwungBy(kit, tiles, "offhand")).toBeNull();
      expect(handToSwing(kit, tiles, "offhand")).toBe("weapon");
      expect(fightsWithBothHands(kit, tiles)).toBe(false);
    }
  });

  /** Bare hands are still a weapon, and still the answer when nothing else is. */
  it("falls back to what the body was born with", () => {
    for (const kit of [emptyEquipment(), held("shield", "hand-lantern")]) {
      expect(handToSwing(kit, tiles, "weapon")).toBeNull();
      expect(weaponInHand(base, kit, tiles, null)).toEqual(base.naturalWeapon);
    }
  });

  /**
   * Each hand brings its own everything, which is what "the appropriate damage"
   * has to mean: a body alternating a blade and a hammer strikes as a blade and
   * then as a hammer, and armour keyed by kind sees both.
   */
  it("gives each hand its own blow, speed and mastery", () => {
    const mixed = held("rusty-sword", "simple-hammer");
    const blade = effectiveBattler(base, mixed, tiles, "weapon");
    const blunt = effectiveBattler(base, mixed, tiles, "offhand");

    expect(blade.mastery).toBe("blade");
    expect(blunt.mastery).toBe("blunt");
    expect(blade.damage).not.toBe(blunt.damage);
    expect(blade.spd).not.toBe(blunt.spd);
  });

  /**
   * **The hand changes the blow and never the body.** A health bar reads the
   * same block a swing does, and one that flickered as somebody alternated would
   * be the rotation leaking into a thing it has no business touching.
   */
  it("leaves what the body is alone", () => {
    const mixed = held("rusty-sword", "simple-hammer");
    const blade = effectiveBattler(base, mixed, tiles, "weapon");
    const blunt = effectiveBattler(base, mixed, tiles, "offhand");

    expect(blunt.maxHp).toBe(blade.maxHp);
    expect(blunt.flee).toBe(blade.flee);
    expect(blunt.haste).toBe(blade.haste);
    // Defence is both hands plus what is worn, so it does not move either.
    expect(blunt.def).toBe(blade.def);
  });

  /** Both hands' `def` counts, whichever one is swinging. */
  it("counts both hands' guard on either turn", () => {
    const two = held("sword", "sword");
    for (const hand of HANDS) {
      expect(effectiveBattler(base, two, tiles, hand).def).toBe(
        effectiveBattler(base, held("sword", null), tiles, "weapon").def +
          SWORD_DEF,
      );
    }
  });
});

/**
 * The head, the charm and the feet.
 *
 * **The claim is that they are one mechanism, not three.** A helmet is a `def`
 * and a `resist` on a thing you put on, exactly as a mail shirt is; the whole of
 * the difference is `ArmorItem.slot`, which is what lets you wear one of each
 * and what stops you wearing a helm as boots. So these assert the summing and
 * the refusal, and deliberately not a fourth arithmetic.
 */
describe("the other worn squares", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const worn = (slots: Partial<Equipment>): Equipment => ({
    ...emptyEquipment(),
    ...slots,
  });

  const on = (tileId: string): ItemInstance => ({ id: `itm_${tileId}`, tileId });

  /** The reason to have squares at all: a full set is worth more than its best piece. */
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

    expect(armorDefence(dressed, shipped)).toBe(
      helm.def + mail.def + boots.def + ring.def,
    );
    // And it reaches the fight, on the terms one shirt always did.
    const bare = effectiveBattler(player, emptyEquipment(), shipped, firstHand(emptyEquipment(), shipped));
    expect(effectiveBattler(player, dressed, shipped, firstHand(dressed, shipped)).def).toBe(
      bare.def + armorDefence(dressed, shipped),
    );
  });

  /**
   * The half that did *not* use to sum, because when the chest was the only
   * place armour went "one armour, one table" was the same sentence as "the
   * armour's table". A helm that shrugs off hammers beside a shirt that shrugs
   * off blades should do both.
   */
  it("sums the resistances too, kind by kind", () => {
    const both = worn({ head: on("iron-helm"), armor: on("chain-mail") });
    expect(armorResistances(both, shipped)).toEqual({ blunt: 2, blade: 4 });

    // Two squares with an opinion about the same kind add, rather than one
    // quietly deciding what the other is worth.
    const doubled = worn({
      head: on("knights-helm"),
      footwear: on("steel-sabatons"),
    });
    expect(armorResistances(doubled, shipped).blade).toBe(3 + 2);
  });

  /** A charm that stops nothing flat and a great deal of one kind is the choice. */
  it("lets a square be a choice rather than a rung", () => {
    const charmed = worn({ charm: on("jade-amulet") });
    expect(armorDefence(charmed, shipped)).toBe(0);
    expect(armorResistances(charmed, shipped)).toEqual({ arcane: 5 });
  });

  /**
   * The armour names its own square, so armour for another one is refused here
   * exactly as a sword is. Otherwise "wear one of each" is "wear four helmets".
   */
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

  /** A kit saved before these squares existed comes back with them empty. */
  it("restores a kit that predates them", () => {
    const old = { weapon: null, offhand: null, bag: null } as unknown as Equipment;
    const restored = restoredEquipment(old, shipped);
    expect(restored.head).toBeNull();
    expect(restored.charm).toBeNull();
    expect(restored.footwear).toBeNull();
  });

  /**
   * Content rather than machinery: a square with nothing authored for it is a
   * square a player can only ever look at.
   */
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

/**
 * Armour that cares what hit it.
 *
 * **The claim is that resistance is a choice rather than a rung.** With a flat
 * number alone every piece is strictly better or worse than every other, and the
 * only decision left is which one you have found; a mail shirt that shrugs off
 * blades and does nothing about a hammer is one you pick for the fight in front
 * of you. So these assert the *asymmetry* and not merely that the number lands.
 */
describe("resisting a kind of blow", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const wearing = (armor: string): Equipment => ({
    ...emptyEquipment(),
    armor: { id: `itm_${armor}`, tileId: armor },
  });

  it("carries the armour's own block through to the fight", () => {
    const mailed = effectiveBattler(player, wearing("chain-mail"), shipped, firstHand(wearing("chain-mail"), shipped));
    expect(mailed.resist.blade).toBe(4);
    expect(mailed.resist.blunt).toBeUndefined();
  });

  it("says nothing for a bare chest or for armour with no opinion", () => {
    expect(armorResistances(null, shipped)).toEqual({});
    expect(armorResistances(emptyEquipment(), shipped)).toEqual({});
    expect(armorResistances(wearing("cloth-tunic"), shipped)).toEqual({});
  });

  /**
   * The content claim, and the one a player feels: the four resisting armours in
   * the world disagree about which blow they are for. A catalogue where they all
   * happened to resist blades would type-check and pass every unit above it.
   */
  it("is authored differently across the armours we ship", () => {
    const kinds = ["padded-gambeson", "leather-jerkin", "warded-robe", "chain-mail"]
      .map((id) => resolveArmor(shipped[id]!)!)
      .flatMap((armor) => Object.keys(armor.resist ?? {}));
    expect(new Set(kinds).size).toBeGreaterThan(1);
    expect(kinds).toContain("blunt");
    expect(kinds).toContain("blade");
    expect(kinds).toContain("arcane");
  });
});

/**
 * What the player is wearing the first time they arrive.
 *
 * Content rather than machinery, on the terms `the vermin we ship` is: the slot
 * working and the world being dressed are separate ways to end up with a player
 * standing in their underwear.
 */
describe("the armour we ship", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  it("puts the base armour on the player, certainly", () => {
    const worn = (player.kit ?? []).filter((entry) => entry.slot === "armor");
    expect(worn).toEqual([
      { slot: "armor", tileId: "cloth-tunic", chance: 100 },
    ]);
  });

  /**
   * **Very weak, and weakest**, which is what makes it a floor rather than a
   * choice: a starting armour that beat anything findable would make the whole
   * slot a thing you never touch again.
   *
   * Against the *body's* armour alone, because a square is what two pieces
   * compete over: a leather cap is no weaker or stronger than a tunic, it is
   * somewhere else on you, and comparing them would be asking whether a hat
   * beats a shirt.
   */
  it("makes what the player starts in the least of them", () => {
    const base = resolveArmor(shipped["cloth-tunic"]!)!;
    const others = Object.values(shipped)
      .map(resolveArmor)
      .filter((armor): armor is NonNullable<typeof armor> => armor != null)
      .filter((armor) => armorSlotOf(armor) === "armor")
      .filter((armor) => armor !== base);

    expect(others.length).toBeGreaterThan(0);
    for (const armor of others) {
      const best = Math.max(
        ...Object.values(armor.resist ?? { none: 0 }),
        0,
      );
      expect(armor.def + best).toBeGreaterThan(base.def);
    }
    expect(base.resist).toBeUndefined();
  });
});

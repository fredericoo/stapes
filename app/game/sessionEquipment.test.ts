import { describe, expect, it } from "vitest";
import { defFrom } from "../lib/battler";
import { DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, parseMap, replaceStack, serializeMap } from "../lib/mapData";
import { parseServerMessage } from "../net/protocol";
import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content now, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

/**
 * What an actor is carrying, as the session sees it.
 *
 * The arithmetic has its own file; this is about the wiring — who gets a kit,
 * who does not, and whether a weapon in a hand actually reaches the blow.
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
    kind: "prop",
    ...partial,
  });
}

/** Certain to hit, certain to hurt, and as fast as the rules allow. */
const CERTAIN = { accuracy: 100, variance: 0, spd: 100 };

/**
 * The bodies these tests measure blows between.
 *
 * **Toughness buys defence as well as hit points now** — see `../lib/battler`'s
 * `defFrom` — so a punching bag bred for a long life quietly grew twenty points
 * of armour and swallowed every blow in the file whole. Rather than soften the
 * bag, every weapon here is authored as *what should land* plus what the bag
 * turns aside, so the figures the tests assert are the figures they always
 * asserted and the arithmetic in between is the game's.
 */
const PLAYER_TOUGHNESS = 92;
const DUMMY_TOUGHNESS = 100;
const DUMMY_DEF = defFrom(DUMMY_TOUGHNESS);

/** What a bare-handed blow should come to once the bag has had its share. */
const BARE_DAMAGE = 5;
/** What the light sword should come to — twice bare hands, as it always was. */
const SWORD_DAMAGE = 10;

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  // Something with volume, which is what it takes to bury a thing: a flat tile
  // lying on top of another one hides nothing.
  tile({ id: "crate", height: 1 }),
  tile({
    id: "player",
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        // Toughness alone, since nothing here is ever dodged at or measured for
        // speed as a defender. No Fist either: a weapon that asks nothing is at
        // full readiness for anybody, so the mastery would buy only the flat
        // skill bonus — and these tests assert exact damage numbers, which is
        // the one thing that bonus makes unreadable.
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: BARE_DAMAGE + DUMMY_DEF,
          def: 0,
          ...CERTAIN,
          mastery: "fist",
        },
        // Where the bag on a player's back comes from — see `app/lib/kit.ts`.
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({
    id: "dummy",
    height: 1,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      // As much of a punching bag as the mastery scale allows, and it never
      // swings back. Its Toughness now buys armour as well as health — see
      // {@link DUMMY_DEF}, which every blow in this file is written to clear.
      battler: {
        masteries: { toughness: DUMMY_TOUGHNESS },
        naturalWeapon: { type: "weapon", damage: 0, def: 0, accuracy: 50, variance: 0, spd: 0, mastery: "fist" },
      },
    },
  }),
  // A creature born holding something, which is the whole of a kit: it is on the
  // board because the map put it there, and it is armed because its tile says
  // so. No brain, so it stands where it is put.
  tile({
    id: "packrat",
    height: 1,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        masteries: { toughness: 1 },
        naturalWeapon: { type: "weapon", damage: 0, def: 0, accuracy: 50, variance: 0, spd: 0, mastery: "fist" },
        kit: [{ slot: "weapon", tileId: "light-sword", chance: 100 }],
      },
    },
  }),
  // A creature with a mind of its own — a resident, and nobody's player.
  tile({
    id: "deer",
    height: 1,
    kind: "battler",
    walkable: false,
    interactions: {
      battler: {
        masteries: { toughness: 2 },
        naturalWeapon: { type: "weapon", damage: 0, def: 0, accuracy: 50, variance: 0, spd: 0, mastery: "fist" },
      },
      brain: { initial: "idle", states: { idle: { do: [{ action: "hold" }] } }, transitions: [] },
    },
  }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER } },
  }),
  // Shifts nothing but attack, so it can be used to assert an exact number of
  // hit points: a weapon that lowered accuracy would widen the damage band and
  // make the blow a range rather than a number.
  tile({
    id: "light-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", damage: SWORD_DAMAGE + DUMMY_DEF, def: 0, accuracy: 100, variance: 0, spd: 100, mastery: "blade" },
    },
  }),
  tile({
    id: "chest",
    kind: "item",
    intangible: true,
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
  // A weapon that is really a light. It fights like bare hands on purpose: the
  // only thing being asserted with it is that carrying it lights the room.
  tile({
    id: "lantern",
    kind: "item",
    intangible: true,
    light: { radius: 6, intensity: 1, color: "#ffcc88" },
    interactions: {
      item: { type: "weapon", damage: 5, def: 0, accuracy: 100, variance: 0, spd: 100, mastery: "blunt" },
    },
  }),
  // Something that belongs nowhere in particular, so a hand is the first place
  // a pickup with a full bag reaches for.
  tile({
    id: "cherry",
    kind: "item",
    intangible: true,
    interactions: { item: { type: "consumable", label: "Eat", hp: 5 } },
  }),
  // The one thing in here authored for the other hand.
  tile({
    id: "torch",
    kind: "item",
    intangible: true,
    light: { radius: 6, intensity: 1, color: "#ffcc88" },
    interactions: {
      item: { type: "weapon", damage: 1, def: 0, offhand: true, accuracy: 40, variance: 0, spd: 40, mastery: "blunt" },
    },
  }),
  // Slow and clumsy in the two ways a weapon can now be told to be.
  tile({
    id: "heavy-sword",
    kind: "item",
    intangible: true,
    interactions: {
      // **Variance is stated so the band lands where the test reads it.** Flat
      // defence amplifies a relative spread: 20% of variance on a 30-damage
      // weapon is a 24–30 blow, which the bag's twenty points turn into a 4–10
      // one. The weapon is narrow and what gets through is wide, which is the
      // honest behaviour of subtracting armour rather than scaling it.
      item: { type: "weapon", damage: SWORD_DAMAGE + DUMMY_DEF, def: 2, accuracy: 90, variance: 20, spd: 20, mastery: "blade" },
    },
  }),
];

/** Open grass with the spawn marker at the origin. */
function field(half = 3): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

function withBody(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

function selfId(session: GameSession): string {
  return session.getSnapshot().self.id;
}

describe("the starting kit", () => {
  it("puts an empty bag on a player's back and nothing in their hand", () => {
    const session = new GameSession(field(), tiles);
    const kit = session.getSnapshot().equipment;

    expect(kit.weapon).toBeNull();
    expect(kit.bag?.tileId).toBe(BAG_TILE_ID);
    expect(kit.bag?.contents).toEqual([]);
  });

  it("gives the bag a real identity, so it can be dropped and found again", () => {
    const session = new GameSession(field(), tiles);
    expect(session.getSnapshot().equipment.bag?.id).toMatch(/^itm_/);
  });

  it("gives two players two different bags", () => {
    const session = new GameSession(field(), tiles, { actorIds: ["a", "b"] });
    const a = session.equipmentOf("a")!.bag!.id;
    const b = session.equipmentOf("b")!.bag!.id;
    expect(a).not.toBe(b);
  });

  /**
   * Nothing rather than a bag, and the difference from the player is entirely in
   * the tile: a deer authors no kit, so it is born with empty hands. Handing
   * every creature in the world a backpack it will never open would be a bag per
   * body to seat and carry around for nothing.
   */
  it("gives a resident creature with no kit nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "deer"), tiles);
    const deer = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "deer")!;
    const kit = session.equipmentOf(deer.id)!;

    expect(kit.weapon).toBeNull();
    expect(kit.bag).toBeNull();
  });

  /**
   * The other half of the same rule, and the reason a player is not a special
   * case any more: a creature whose tile *does* author a kit is born holding it,
   * on the same path and out of the same function.
   */
  it("gives a resident creature what its kit rolled", () => {
    const session = new GameSession(withBody(field(), 1, 0, "packrat"), tiles);
    const rat = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "packrat")!;

    expect(session.equipmentOf(rat.id)!.weapon?.tileId).toBe("light-sword");
  });

  it("is nothing at all when the world has no bag tile to give", () => {
    const withoutBag = tiles.filter((t) => t.id !== BAG_TILE_ID);
    const session = new GameSession(field(), withoutBag);
    const kit = session.getSnapshot().equipment;

    expect(kit.bag).toBeNull();
    expect(kit.weapon).toBeNull();
  });

  it("has nothing to say about somebody who is not here", () => {
    const session = new GameSession(field(), tiles);
    expect(session.equipmentOf("nobody")).toBeNull();
  });
});

describe("a weapon reaches the blow", () => {
  /**
   * Equipment is written straight onto the runtime here because Phase 2 has no
   * way to equip anything — the point of the test is that `battlerOf` counts
   * what is in the slot, not how it got there.
   */
  function arm(session: GameSession, tileId: string) {
    const kit = session.equipmentOf(selfId(session))!;
    kit.weapon = { id: "itm_test", tileId };
  }

  function damageOver(session: GameSession, ms: number): number {
    const before = session
      .actorSnapshots()
      .find((a) => a.tileId === "dummy")!.hp!;
    advance(session, ms);
    const after = session
      .actorSnapshots()
      .find((a) => a.tileId === "dummy")!.hp!;
    return before - after;
  }

  /**
   * How many blows landed, counted off the damage numbers rather than off hit
   * points — two weapons are worth different amounts per swing, so hit points
   * cannot be compared across them but swings can.
   */
  function swingsOver(session: GameSession, ms: number): number {
    let swings = 0;
    let seen = 0;
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      const damage = session.getSnapshot().damage;
      const fresh = damage.filter((d) => d.elapsedMs === 0).length;
      swings += fresh;
      seen += 1;
    }
    expect(seen).toBeGreaterThan(0);
    return swings;
  }

  function fightingSession(): GameSession {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummy = session
      .actorSnapshots()
      .find((a) => a.tileId === "dummy")!;
    session.setTarget(dummy.id);
    session.setAttackMode(true);
    return session;
  }

  /**
   * **Replacement, not addition** — the rule the whole mastery model rests on.
   *
   * The old arithmetic would have made this `5 + 10`, and the difference
   * between the two answers is the entire change: a body brings what it is good
   * at, and the weapon brings what it is. Both are certain to hit for
   * everything, so the number is exact on both sides and nothing but the weapon
   * moved.
   */
  it("replaces the body's own damage rather than adding to it", () => {
    const bare = fightingSession();
    const armed = fightingSession();
    arm(armed, "light-sword");

    expect(damageOver(bare, TICK_MS * 3)).toBe(BARE_DAMAGE);
    expect(damageOver(armed, TICK_MS * 3)).toBe(SWORD_DAMAGE);
  });

  /**
   * Accuracy widens the damage band downward, so an inaccurate weapon is worth
   * *less* than its damage says — which is the whole reason a weapon can be
   * authored to cost it.
   *
   * The band is the claim, so the band is what is asserted: at accuracy 40 a
   * blow worth 10 lands somewhere in 4–10, where the light sword's identical
   * damage always lands exactly.
   */
  it("blunts its own damage by being inaccurate", () => {
    const heavy = fightingSession();
    arm(heavy, "heavy-sword");
    const hit = damageOver(heavy, TICK_MS * 3);

    expect(hit).toBeGreaterThanOrEqual(4);
    expect(hit).toBeLessThanOrEqual(10);
  });

  it("swings at its own speed rather than the body's", () => {
    const light = fightingSession();
    const heavy = fightingSession();
    arm(light, "light-sword");
    arm(heavy, "heavy-sword");

    // Long enough for many swings, so this is about *rate* rather than about
    // one blow landing on a tick boundary. Counted in swings rather than hit
    // points, since the two weapons are worth different amounts per blow.
    const lightSwings = swingsOver(light, 4000);
    const heavySwings = swingsOver(heavy, 4000);
    expect(heavySwings).toBeLessThan(lightSwings);
  });

  it("leaves an empty-handed body fighting with its natural weapon", () => {
    const session = fightingSession();
    expect(damageOver(session, TICK_MS * 3)).toBe(BARE_DAMAGE);
  });
});

describe("picking things up", () => {
  const SWORD = "light-sword";

  /** Grass everywhere, the player at the origin, and one item beside them. */
  function withItem(x: number, y: number, tileId: string): GameSession {
    const map = replaceStack(field(), x, y, 0, [
      { tileId: "grass" },
      { tileId },
    ]);
    return new GameSession(map, tiles);
  }

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  function bagOf(session: GameSession) {
    return session.getSnapshot().equipment.bag!;
  }

  it("takes the thing off the board and into the bag", () => {
    const session = withItem(1, 0, SWORD);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);

    expect(getStack(session.getMap(), 1, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
    ]);
    expect(bagOf(session).contents).toHaveLength(1);
    expect(bagOf(session).contents![0].tileId).toBe(SWORD);
  });

  it("keeps the identity the world gave it", () => {
    const session = withItem(1, 0, SWORD);
    const onFloor = getStack(session.getMap(), 1, 0, 0)[1].itemId;
    session.pickUp(refAt(session, 1, 0));

    expect(onFloor).toMatch(/^itm_/);
    expect(bagOf(session).contents![0].id).toBe(onFloor);
  });

  it("reaches a diagonal, where a push would not", () => {
    const session = withItem(1, 1, SWORD);
    expect(session.pickUp(refAt(session, 1, 1))).toBe(true);
  });

  it("refuses something two cells away", () => {
    const session = withItem(2, 0, SWORD);
    expect(session.pickUp(refAt(session, 2, 0))).toBe(false);
    expect(bagOf(session).contents).toEqual([]);
  });

  it("fills slots in order", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: SWORD }]);
    map = replaceStack(map, 0, 1, 0, [
      { tileId: "grass" },
      { tileId: "heavy-sword" },
    ]);
    const session = new GameSession(map, tiles);

    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));

    expect(bagOf(session).contents!.map((i) => i.tileId)).toEqual([
      SWORD,
      "heavy-sword",
    ]);
  });

  it("refuses once the bag is full", () => {
    let map = field();
    // Five items around the player, for a bag that holds four.
    const cells: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
    ];
    for (const [x, y] of cells) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId: SWORD }]);
    }
    const session = new GameSession(map, tiles);

    const taken = cells.map(([x, y]) => session.pickUp(refAt(session, x, y)));
    expect(taken).toEqual([true, true, true, true, false]);
    expect(bagOf(session).contents).toHaveLength(4);
  });

  /**
   * Containers do not nest, so a second bag never goes *inside* the one you are
   * wearing. A hand will carry it, which is a choice the game has no business
   * refusing — and with both hands full there is nowhere left at all.
   */
  it("carries a second bag in hand, and refuses it once they are full", () => {
    const session = withItem(1, 0, BAG_TILE_ID);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe(
      BAG_TILE_ID,
    );
    expect(bagOf(session).contents).toEqual([]);

    const laden = withItem(1, 0, BAG_TILE_ID);
    const kit = laden.equipmentOf(selfId(laden))!;
    kit.weapon = { id: "itm_a", tileId: SWORD };
    kit.offhand = { id: "itm_b", tileId: SWORD };
    expect(laden.pickUp(refAt(laden, 1, 0))).toBe(false);
  });

  it("puts a bag on a bare back, contents and all", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: BAG_TILE_ID,
        itemId: "itm_authored",
        contents: [{ id: "itm_loot", tileId: SWORD }],
      },
    ]);
    const session = new GameSession(map, tiles);
    // Take the starting bag off first — there is no other way to bare a back.
    session.equipmentOf(selfId(session))!.bag = null;

    expect(session.equip(refAt(session, 1, 0))).toBe(true);
    const bag = bagOf(session);
    expect(bag.id).toBe("itm_authored");
    expect(bag.contents).toEqual([{ id: "itm_loot", tileId: SWORD }]);
  });

  /**
   * A full bag is not the end of it. You have hands, and the spare one goes
   * first so a pickup never rewrites what you are fighting with.
   */
  describe("with nowhere left to put it", () => {
    /** Bag full to the brim, so only the hands are left. */
    function stuffed(tileId: string): GameSession {
      const session = withItem(1, 0, tileId);
      const kit = session.equipmentOf(selfId(session))!;
      kit.bag = {
        ...kit.bag!,
        contents: Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) => ({
          id: `itm_${i}`,
          tileId: SWORD,
        })),
      };
      return session;
    }

    it("takes a thing into the spare hand", () => {
      const session = stuffed("cherry");

      expect(session.pickUp(refAt(session, 1, 0))).toBe(true);
      expect(session.getSnapshot().equipment.offhand?.tileId).toBe("cherry");
    });

    it("falls through to the weapon hand once that one is taken", () => {
      const session = stuffed("cherry");
      session.equipmentOf(selfId(session))!.offhand = {
        id: "itm_lit",
        tileId: "torch",
      };

      expect(session.pickUp(refAt(session, 1, 0))).toBe(true);
      expect(session.getSnapshot().equipment.weapon?.tileId).toBe("cherry");
    });

    it("refuses once the hands are full too", () => {
      const session = stuffed("cherry");
      const kit = session.equipmentOf(selfId(session))!;
      kit.weapon = { id: "itm_a", tileId: SWORD };
      kit.offhand = { id: "itm_b", tileId: "torch" };

      expect(session.pickUp(refAt(session, 1, 0))).toBe(false);
      expect(getStack(session.getMap(), 1, 0, 0)).toHaveLength(2);
    });
  });

  /**
   * Arming yourself off the floor — the trip a pickup makes, into a slot on the
   * body rather than into a bag. It is the only thing somebody carrying nothing
   * at all can do with a sword.
   */
  describe("equipping where it lies", () => {
    function bare(x: number, y: number, tileId: string): GameSession {
      const session = withItem(x, y, tileId);
      session.equipmentOf(selfId(session))!.bag = null;
      return session;
    }

    const kitOf = (session: GameSession) => session.getSnapshot().equipment;

    const tilesAt = (session: GameSession, x: number, y: number) =>
      getStack(session.getMap(), x, y, 0).map((p) => p.tileId);

    it("puts a sword in the hand of somebody carrying nothing", () => {
      const session = bare(1, 0, SWORD);

      expect(session.equip(refAt(session, 1, 0))).toBe(true);
      expect(kitOf(session).weapon?.tileId).toBe(SWORD);
      expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    });

    it("puts a torch in the other hand, leaving the weapon hand free", () => {
      const session = bare(1, 0, "torch");

      expect(session.equip(refAt(session, 1, 0))).toBe(true);
      expect(kitOf(session).offhand?.tileId).toBe("torch");
      expect(kitOf(session).weapon).toBeNull();
    });

    /** Never a swap: what you are already holding stays where it is. */
    it("refuses once the slot it names is full", () => {
      const session = bare(1, 0, SWORD);
      session.equipmentOf(selfId(session))!.weapon = {
        id: "itm_held",
        tileId: "heavy-sword",
      };

      expect(session.equip(refAt(session, 1, 0))).toBe(false);
      expect(kitOf(session).weapon?.tileId).toBe("heavy-sword");
      expect(tilesAt(session, 1, 0)).toEqual(["grass", SWORD]);
    });

    it("has nowhere to put a chest", () => {
      const session = bare(1, 0, "chest");
      expect(session.equip(refAt(session, 1, 0))).toBe(false);
    });

    /** A tap arms you when it can — see `ACTION_ORDER`. */
    it("is what a plain interact runs, ahead of stowing it", () => {
      const session = withItem(1, 0, SWORD);

      expect(session.interact(refAt(session, 1, 0))).toBe(true);
      expect(kitOf(session).weapon?.tileId).toBe(SWORD);
      expect(bagOf(session).contents).toEqual([]);
    });

    it("falls through to the bag once the hand is full", () => {
      const session = withItem(1, 0, SWORD);
      session.equipmentOf(selfId(session))!.weapon = {
        id: "itm_held",
        tileId: "heavy-sword",
      };

      expect(session.interact(refAt(session, 1, 0))).toBe(true);
      expect(bagOf(session).contents?.map((i) => i.tileId)).toEqual([SWORD]);
    });
  });

  it("never picks up a chest, which is looted where it lies", () => {
    const session = withItem(1, 0, "chest");
    expect(session.pickUp(refAt(session, 1, 0))).toBe(false);
    expect(getStack(session.getMap(), 1, 0, 0)).toHaveLength(2);
  });

  /**
   * The player tile stands *in* the cell it occupies, so an item on the floor
   * beneath somebody is covered by their own body — and the round reach takes
   * that cell in on purpose.
   */
  it("takes the thing under its own feet", () => {
    const map = replaceStack(field(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
      { tileId: "player", direction: "e" },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(bagOf(session).contents).toHaveLength(1);
    // And the body it was under is still standing there, one slot lower.
    expect(getStack(session.getMap(), 0, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "player",
    ]);
  });

  it("refuses something buried under another tile", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
      { tileId: "crate" },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  /**
   * Two swords in one cell are two swords, and a player who could only ever
   * take the one on top would have no way at all to reach the other.
   */
  it("takes either of two things lying on each other", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
      { tileId: SWORD },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(bagOf(session).contents).toHaveLength(2);
    expect(getStack(session.getMap(), 1, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
    ]);
  });

  it("refuses a tile that is not an item at all", () => {
    const session = withItem(1, 0, "dummy");
    expect(session.pickUp(refAt(session, 1, 0))).toBe(false);
  });

  /**
   * The renderer hands equipment to React only when the object identity
   * changes, so a kit edited in place would leave the panels showing what the
   * player was carrying a moment ago.
   */
  it("replaces the kit rather than mutating it", () => {
    const session = withItem(1, 0, SWORD);
    const before = session.getSnapshot().equipment;
    session.pickUp(refAt(session, 1, 0));

    expect(session.getSnapshot().equipment).not.toBe(before);
    expect(before.bag!.contents).toEqual([]);
  });

  it("announces whose kit changed, once", () => {
    const session = withItem(1, 0, SWORD);
    const me = selfId(session);
    session.drainEquipmentChanges();

    session.pickUp(refAt(session, 1, 0));
    expect(session.drainEquipmentChanges()).toEqual([me]);
    // Drained, so a second flush has nothing left to send.
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("says nothing when the pickup was refused", () => {
    const session = withItem(2, 0, SWORD);
    session.drainEquipmentChanges();

    session.pickUp(refAt(session, 2, 0));
    expect(session.drainEquipmentChanges()).toEqual([]);
  });
});

describe("moving things between slots", () => {
  const SWORD = "light-sword";

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  function kitOf(session: GameSession) {
    return session.getSnapshot().equipment;
  }

  /** A player carrying one sword, and a chest beside them holding another. */
  function stocked(chestAt: [number, number] = [1, 0]): GameSession {
    let map = replaceStack(field(), 1, 1, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
    ]);
    map = replaceStack(map, chestAt[0], chestAt[1], 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_loot", tileId: SWORD }],
      },
    ]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 1));
    return session;
  }

  it("draws a weapon out of the bag, and puts it back again", () => {
    const session = stocked();
    expect(session.moveItem({ kind: "contents",
index: 0 }, { kind: "weapon" })).toBe(
      true,
    );
    expect(kitOf(session).weapon?.tileId).toBe(SWORD);
    expect(kitOf(session).bag?.contents).toEqual([]);

    expect(session.moveItem({ kind: "weapon" }, { kind: "contents",
index: 0 })).toBe(
      true,
    );
    expect(kitOf(session).weapon).toBeNull();
    expect(kitOf(session).bag?.contents).toHaveLength(1);
  });

  it("counts a drawn weapon towards the blow it lands", () => {
    const map = withBody(field(), 1, 0, "dummy");
    const session = new GameSession(replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]), tiles);
    session.pickUp(refAt(session, 1, 1));
    session.moveItem({ kind: "contents",
index: 0 }, { kind: "weapon" });

    const dummy = session.actorSnapshots().find((a) => a.tileId === "dummy")!;
    session.setTarget(dummy.id);
    session.setAttackMode(true);
    const before = session
      .actorSnapshots()
      .find((a) => a.tileId === "dummy")!.hp!;
    advance(session, TICK_MS * 3);
    const after = session
      .actorSnapshots()
      .find((a) => a.tileId === "dummy")!.hp!;

    // The sword's damage, not the sword's on top of the body's: drawing a
    // weapon out of the bag has to reach the blow by the same replacement every
    // other path uses.
    expect(before - after).toBe(SWORD_DAMAGE);
  });

  it("loots a chest on the floor, rewriting the placement it came out of", () => {
    const session = stocked();
    const chest = refAt(session, 1, 0);
    expect(
      session.moveItem({ kind: "ground", ref: chest, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(true);

    expect(kitOf(session).bag?.contents).toHaveLength(2);
    expect(getStack(session.getMap(), 1, 0, 0)[1].contents).toEqual([]);
  });

  /**
   * The shape a map file actually arrives in, which is not the shape the tests
   * above build. `serializeMap` strips a content's `id` on the way to disk, so
   * an authored chest holds `{ tileId }` and nothing else — and every test here
   * that wrote `itm_loot` by hand was quietly testing a world that had already
   * been minted.
   *
   * What it cost: the sword came out of the crate with no identity, went into
   * the bag, and the `equipment` frame announcing it failed its own schema on
   * the way out. The client dropped the message, so the sword was gone from the
   * chest and absent from the bag at once — and the `hello` on the next refresh
   * carried the same kit and was dropped the same way, which is a player who
   * can never finish joining again.
   */
  it("loots a chest authored with no ids in it, and the kit still crosses the wire", () => {
    let map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", contents: [{ tileId: SWORD }] as never },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 1, 0);

    expect(
      session.moveItem(
        { kind: "ground", ref: chest, index: 0 },
        { kind: "contents", index: 0 },
      ),
    ).toBe(true);

    const equipment = kitOf(session);
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(
      parseServerMessage(JSON.stringify({ type: "equipment", equipment })),
    ).not.toBeNull();
  });

  /**
   * The general shape of the bug the authored chest was one instance of, and
   * the one that reaches items nobody authored into a container at all.
   *
   * `serializeMap` strips a content's id every time the editor saves. So *any*
   * item that is inside *any* container when the map is saved — a torch stashed
   * in a crate, a bag full of things put down on the floor — comes back
   * anonymous on the next load, and unusable the moment somebody takes it out.
   * Which container, and whether a human authored it, makes no difference.
   */
  it("survives a map save while it is inside a container on the floor", () => {
    let map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: "itm_chest", contents: [{ id: "itm_loot", tileId: "lantern" }] },
    ]);
    // The editor's save button, and the load that follows it.
    const saved = new GameSession(parseMap(serializeMap(map)), tiles);
    const chest = refAt(saved, 1, 0);

    expect(
      saved.moveItem(
        { kind: "ground", ref: chest, index: 0 },
        { kind: "contents", index: 0 },
      ),
    ).toBe(true);

    const equipment = kitOf(saved);
    expect(equipment.bag?.contents?.[0].tileId).toBe("lantern");
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(
      parseServerMessage(JSON.stringify({ type: "equipment", equipment })),
    ).not.toBeNull();
  });

  /**
   * The counterpart, and the reason this was so hard to place: a bare item on
   * the floor was never affected. It is minted by the same pass that always
   * worked, so a torch lying in the open picks up and travels fine — which is
   * why "it happened with a torch too" pointed away from containers rather than
   * at them.
   */
  it("was never a problem for a bare item lying on the floor", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "lantern" },
    ]);
    const session = new GameSession(parseMap(serializeMap(map)), tiles);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);

    const equipment = kitOf(session);
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(
      parseServerMessage(JSON.stringify({ type: "equipment", equipment })),
    ).not.toBeNull();
  });

  it("stashes into it, which is the same move the other way round", () => {
    const session = stocked();
    const chest = refAt(session, 1, 0);
    expect(
      session.moveItem({ kind: "contents",
index: 0 }, {
        kind: "ground",
        ref: chest,
        index: 0,
      }),
    ).toBe(true);

    expect(kitOf(session).bag?.contents).toEqual([]);
    expect(getStack(session.getMap(), 1, 0, 0)[1].contents).toHaveLength(2);
  });

  it("refuses a chest the player has walked away from", () => {
    const session = stocked([3, 0]);
    const chest = refAt(session, 3, 0);
    expect(
      session.moveItem({ kind: "ground", ref: chest, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
    expect(kitOf(session).bag?.contents).toHaveLength(1);
  });

  it("tells the owner their kit changed, and only then", () => {
    const session = stocked();
    const me = selfId(session);
    session.drainEquipmentChanges();

    session.moveItem({ kind: "contents",
index: 0 }, { kind: "weapon" });
    expect(session.drainEquipmentChanges()).toEqual([me]);

    // A refused move is nobody's kit changing, and neither is one that only
    // rearranged a box on the floor.
    session.moveItem({ kind: "contents",
index: 0 }, { kind: "weapon" });
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("has nothing to say for an actor who is not here", () => {
    const session = stocked();
    expect(
      session.moveItem({ kind: "contents",
index: 0 }, { kind: "weapon" }, "nobody"),
    ).toBe(false);
    expect(
      session.canMoveItem({ kind: "contents",
index: 0 }, { kind: "weapon" }, "nobody"),
    ).toBe(false);
  });

  it("answers the same question the move runs", () => {
    const session = stocked();
    expect(
      session.canMoveItem({ kind: "contents",
index: 0 }, { kind: "weapon" }),
    ).toBe(true);
    expect(
      session.canMoveItem({ kind: "contents",
index: 3 }, { kind: "weapon" }),
    ).toBe(false);
  });
});

describe("putting things down", () => {
  const SWORD = "light-sword";

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  /** A player at the origin carrying one sword, taken off the floor beside them. */
  function armed(board: MapFile = field()): GameSession {
    const map = replaceStack(board, 1, 1, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
    ]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 1));
    return session;
  }

  /** The same, with a chest standing two cells east of the player. */
  function armedFacingChest(contents: ItemInstance[] = []): GameSession {
    return armed(
      replaceStack(field(), 2, 0, 0, [
        { tileId: "grass" },
        { tileId: "chest", itemId: "itm_chest", contents },
      ]),
    );
  }

  function tilesAt(session: GameSession, x: number, y: number): string[] {
    return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
  }

  it("puts the thing on the board and takes it out of the bag", () => {
    const session = armed();
    expect(session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(
      true,
    );

    expect(tilesAt(session, 2, 0)).toEqual(["grass", SWORD]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("keeps the identity it was carrying", () => {
    const session = armed();
    const id = session.getSnapshot().equipment.bag!.contents![0]!.id;
    session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 });

    expect(getStack(session.getMap(), 2, 0, 0)[1]!.itemId).toBe(id);
  });

  it("throws further than it can reach, and no further than five", () => {
    const near = armed();
    expect(near.drop({ kind: "contents", index: 0 }, { x: 3, y: 0, z: 0 })).toBe(
      true,
    );
    const far = armed();
    expect(far.drop({ kind: "contents", index: 0 }, { x: 6, y: 0, z: 0 })).toBe(
      false,
    );
    expect(far.getSnapshot().equipment.bag?.contents).toHaveLength(1);
  });

  /**
   * The whole reason the bag is a slot: taking it off is dropping it, and what
   * is inside comes with it because contents ride on the placement.
   */
  it("drops the bag off your back, contents and all", () => {
    const session = armed();
    const bagId = session.getSnapshot().equipment.bag!.id;

    expect(session.drop({ kind: "bag" }, { x: 1, y: 0, z: 0 })).toBe(true);

    const placed = getStack(session.getMap(), 1, 0, 0)[1]!;
    expect(placed.tileId).toBe(BAG_TILE_ID);
    expect(placed.itemId).toBe(bagId);
    expect(placed.contents?.map((i) => i.tileId)).toEqual([SWORD]);
    expect(session.getSnapshot().equipment.bag).toBeNull();
  });

  it("can be put straight back on, which is the round trip", () => {
    const session = armed();
    session.drop({ kind: "bag" }, { x: 1, y: 0, z: 0 });
    const bagRef = refAt(session, 1, 0);

    expect(session.equip(bagRef)).toBe(true);
    const bag = session.getSnapshot().equipment.bag!;
    expect(bag.contents?.map((i) => i.tileId)).toEqual([SWORD]);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  /**
   * Aimed at a box, it goes in the box — the whole of "drop it in there" without
   * having to open a panel first.
   */
  it("throws a thing into the container it lands on", () => {
    const session = armedFacingChest();

    expect(
      session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 }),
    ).toBe(true);

    expect(tilesAt(session, 2, 0)).toEqual(["grass", "chest"]);
    expect(
      getStack(session.getMap(), 2, 0, 0)[1]!.contents?.map((i) => i.tileId),
    ).toEqual([SWORD]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("lands on a full container rather than refusing", () => {
    const session = armedFacingChest([
      { id: "itm_a", tileId: SWORD },
      { id: "itm_b", tileId: SWORD },
    ]);

    expect(
      session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 }),
    ).toBe(true);
    expect(tilesAt(session, 2, 0)).toEqual(["grass", "chest", SWORD]);
  });

  it("refuses an empty slot, and says so rather than dropping nothing", () => {
    const session = armed();
    expect(session.drop({ kind: "weapon" }, { x: 1, y: 0, z: 0 })).toBe(false);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  it("refuses a cell with no ground in it", () => {
    const session = armed();
    expect(session.drop({ kind: "contents", index: 0 }, { x: 0, y: 4, z: 0 })).toBe(
      false,
    );
  });

  it("tells the owner their kit changed", () => {
    const session = armed();
    session.drainEquipmentChanges();
    session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 });
    expect(session.drainEquipmentChanges()).toEqual([selfId(session)]);
  });

  it("answers the same question the drop runs", () => {
    const session = armed();
    expect(session.canDrop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(
      true,
    );
    expect(session.canDrop({ kind: "contents", index: 0 }, { x: 9, y: 0, z: 0 })).toBe(
      false,
    );
    expect(session.canDrop({ kind: "weapon" }, { x: 2, y: 0, z: 0 })).toBe(false);
  });
});

/**
 * What everybody else can see of a kit.
 *
 * The rest of an inventory is private and changes nothing observable; a lantern
 * lights the room for whoever is standing in it, so it is world state and it is
 * broadcast. What is asserted here is that the projection follows the kit —
 * because it is cached on the runtime, and a cache that can go stale would leave
 * somebody walking around lit by a torch they put down.
 */
describe("carried lights", () => {
  const LANTERN = "lantern";

  function withLantern(x: number, y: number): GameSession {
    const map = replaceStack(field(), x, y, 0, [
      { tileId: "grass" },
      { tileId: LANTERN },
    ]);
    return new GameSession(map, tiles);
  }

  function lightsOf(session: GameSession): string[] {
    return session.getSnapshot().self.carriedLights;
  }

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  it("is empty for somebody carrying nothing that glows", () => {
    expect(lightsOf(new GameSession(field(), tiles))).toEqual([]);
  });

  // Picking a lantern up puts it in the bag, and a bag is not a slot: it lights
  // nothing until it is in your hand.
  it("stays dark while the lantern is in the bag, and lights up when wielded", () => {
    const session = withLantern(1, 0);
    expect(lightsOf(session)).toEqual([]);

    session.pickUp(refAt(session, 1, 0));
    expect(lightsOf(session)).toEqual([]);

    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });
    expect(lightsOf(session)).toEqual([LANTERN]);

    session.drop({ kind: "weapon" }, { x: 1, y: 0, z: 0 });
    expect(lightsOf(session)).toEqual([]);
  });

  // The inverse, and worth its own case: the cache is written beside the kit, so
  // a move that *removes* a light has to re-derive as surely as one that adds it.
  it("goes out again when the lantern is put back in the bag", () => {
    const session = withLantern(1, 0);
    session.pickUp(refAt(session, 1, 0));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });
    expect(lightsOf(session)).toEqual([LANTERN]);

    session.moveItem({ kind: "weapon" }, { kind: "contents", index: 0 });
    expect(session.getSnapshot().equipment.weapon).toBeNull();
    expect(lightsOf(session)).toEqual([]);
  });

  // A second one in the pack adds nothing, which is what makes the slot the
  // thing being spent rather than the carrying.
  it("counts the one in hand and not the spare in the bag", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: LANTERN }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: LANTERN }]);
    const session = new GameSession(map, tiles);

    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });

    expect(lightsOf(session)).toEqual([LANTERN]);
  });
});

/**
 * What a body is carrying when it stops being a body.
 *
 * The kit lives on the runtime and the runtime is deleted by the killing blow,
 * so "what happens to it" is not a detail — it is the difference between a
 * sword changing hands and a sword leaving the world. See `GameSession.kill`.
 */
describe("dying with something on you", () => {
  const SWORD = "light-sword";

  /**
   * Long enough to finish somebody off, with room for the swings that come to
   * nothing: every chance in a fight is held inside a band, so even a perfect
   * attacker whiffs now and then.
   */
  const LONG_ENOUGH_TO_KILL_MS = 30_000;

  const KILLER = "killer";

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  function tilesAt(session: GameSession, x: number, y: number): string[] {
    return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
  }

  /**
   * A player at the origin with a sword in hand and a bag on their back, and
   * somebody beside them swinging until they stop.
   *
   * A second *player* rather than a creature with a brain: what is under test is
   * the death, and a mind that also decides where to stand would make every
   * assertion about which cell the kit landed in a coin toss.
   */
  function doomed(): GameSession {
    const map = replaceStack(field(), 1, 1, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
    ]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 1));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });

    session.spawn(KILLER, { at: { x: 1, y: 0, z: 0, direction: "w" } });
    session.setTarget(selfId(session), KILLER);
    session.setAttackMode(true, KILLER);
    return session;
  }

  it("leaves the whole kit on the floor where the body fell", () => {
    const session = doomed();

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(session.actorIds()).not.toContain(LOCAL_ACTOR_ID);
    expect(tilesAt(session, 0, 0)).toEqual([
      "grass",
      SWORD,
      BAG_TILE_ID,
    ]);
  });

  it("keeps the identity of everything it drops", () => {
    const session = doomed();
    const swordId = session.getSnapshot().equipment.weapon!.id;

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    const dropped = getStack(session.getMap(), 0, 0, 0).find(
      (placed) => placed.tileId === SWORD,
    );
    expect(dropped?.itemId).toBe(swordId);
  });

  /**
   * The one fact the server writes down. An empty kit beside a board holding the
   * pile is the pair agreeing; anything else is an item existing twice or not at
   * all.
   */
  it("hands the death over empty-handed", () => {
    const session = doomed();
    const playerId = selfId(session);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    const death = session.drainDeaths().find((one) => one.id === playerId);
    expect(death?.equipment).toEqual({
      weapon: null,
      offhand: null,
      armor: null,
      bag: null,
    });
  });

  /**
   * The same drop the player's death takes, which is the point of it being one
   * function: a rat is a battler with a kit, and `kill` has no idea it is not a
   * person.
   */
  it("leaves a creature's kit on the floor exactly as it does a player's", () => {
    const session = new GameSession(withBody(field(), 1, 0, "packrat"), tiles);
    const rat = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "packrat")!;
    session.setTarget(rat.id);
    session.setAttackMode(true);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(tilesAt(session, 1, 0)).toEqual(["grass", SWORD]);
  });

  /**
   * A creature carries nothing, so its death must not put an empty placement
   * anywhere — the cell it stood in is left exactly as bare as it was.
   */
  it("leaves nothing behind for a body that was carrying nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "dummy")!.id;
    session.setTarget(dummyId);
    session.setAttackMode(true);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });
});

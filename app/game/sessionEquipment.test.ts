import { describe, expect, it } from "vitest";
import { defFrom } from "../lib/battler";
import { DEFAULT_ARTIFACT, DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, parseMap, replaceStack, serializeMap } from "../lib/mapData";
import { parseServerMessage } from "../net/protocol";
import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import { guardBand } from "./combat";
import { TICK_MS } from "./constants";
import { emptyEquipment } from "./equipment";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { FRAME, tile } from "../lib/testTile";

const BAG_TILE_ID = "basic-bag";

const CERTAIN = { accuracy: 100, variance: 0, spd: 100 };

const PLAYER_TOUGHNESS = 92;
const DUMMY_TOUGHNESS = 100;
const DUMMY_DEF = defFrom(DUMMY_TOUGHNESS);

const DUMMY_GUARD = guardBand({ def: DUMMY_DEF, resist: {} }, { mastery: "fist" });
const GUARD_SPREAD = DUMMY_GUARD.highest - DUMMY_GUARD.lowest;

function firstBlow(session: GameSession): number {
  const hp = () => session.actorSnapshots().find((a) => a.tileId === "dummy")!.hp!;
  const before = hp();
  for (let elapsed = 0; elapsed < A_WHOLE_FIGHT_MS; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    const dealt = before - hp();
    if (dealt > 0) return dealt;
  }
  throw new Error("nothing landed");
}

const A_WHOLE_FIGHT_MS = 30_000;

function expectWorth(dealt: number, floor: number): void {
  expect(dealt).toBeGreaterThanOrEqual(floor);
  expect(dealt).toBeLessThanOrEqual(floor + GUARD_SPREAD);
}

const BARE_DAMAGE = 5;
const SWORD_DAMAGE = 10;
const OFF_SWORD_DAMAGE = 6;

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({ id: "crate", height: 2 }),
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: BARE_DAMAGE + DUMMY_DEF,
          def: 0,
          ...CERTAIN,
          mastery: "fist",
        },
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({
    id: "dummy",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: DUMMY_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 0,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 0,
          mastery: "fist",
        },
      },
    },
  }),
  tile({
    id: "packrat",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: 1 },
        naturalWeapon: {
          type: "weapon",
          damage: 0,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 0,
          mastery: "fist",
        },
        kit: [{ slot: "weapon", tileId: "light-sword", chance: 100 }],
      },
    },
  }),
  tile({
    id: "deer",
    height: 2,
    kind: "battler",
    walkable: false,
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: 2 },
        naturalWeapon: {
          type: "weapon",
          damage: 0,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 0,
          mastery: "fist",
        },
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
  tile({
    id: "light-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: {
        type: "weapon",
        damage: SWORD_DAMAGE + DUMMY_DEF,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 100,
        mastery: "sharp",
      },
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
  tile({
    id: "lantern",
    kind: "item",
    intangible: true,
    light: { radius: 6, intensity: 1, color: "#ffcc88" },
    interactions: {
      item: {
        type: "weapon",
        damage: 5,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 100,
        mastery: "blunt",
      },
    },
  }),
  tile({
    id: "cherry",
    kind: "item",
    intangible: true,
    interactions: { item: { type: "consumable", label: "Eat", hp: 5 } },
  }),
  tile({
    id: "torch",
    kind: "item",
    intangible: true,
    light: { radius: 6, intensity: 1, color: "#ffcc88" },
    interactions: {
      item: { ...DEFAULT_ARTIFACT },
    },
  }),
  tile({
    id: "off-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: {
        type: "weapon",
        damage: OFF_SWORD_DAMAGE + DUMMY_DEF,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 100,
        mastery: "blunt",
      },
    },
  }),
  tile({
    id: "heavy-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: {
        type: "weapon",
        damage: SWORD_DAMAGE + DUMMY_DEF,
        def: 2,
        accuracy: 90,
        variance: 20,
        spd: 20,
        mastery: "sharp",
      },
    },
  }),
];

function field(half = 3): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
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

  it("gives a resident creature with no kit nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "deer"), tiles);
    const deer = session.actorSnapshots().find((actor) => actor.tileId === "deer")!;
    const kit = session.equipmentOf(deer.id)!;

    expect(kit.weapon).toBeNull();
    expect(kit.bag).toBeNull();
  });

  it("gives a resident creature what its kit rolled", () => {
    const session = new GameSession(withBody(field(), 1, 0, "packrat"), tiles);
    const rat = session.actorSnapshots().find((actor) => actor.tileId === "packrat")!;

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
  function arm(session: GameSession, tileId: string) {
    const kit = session.equipmentOf(selfId(session))!;
    kit.weapon = { id: "itm_test", tileId };
  }

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
    const dummy = session.actorSnapshots().find((a) => a.tileId === "dummy")!;
    session.setTarget(dummy.id);
    session.setAttackMode(true);
    return session;
  }

  it("replaces the body's own damage rather than adding to it", () => {
    const bare = fightingSession();
    const armed = fightingSession();
    arm(armed, "light-sword");

    expectWorth(firstBlow(bare), BARE_DAMAGE);
    expectWorth(firstBlow(armed), SWORD_DAMAGE);
  });

  it("blunts its own damage by being inaccurate", () => {
    const heavy = fightingSession();
    arm(heavy, "heavy-sword");
    const hit = firstBlow(heavy);

    expect(hit).toBeGreaterThanOrEqual(4);
    expect(hit).toBeLessThanOrEqual(10 + GUARD_SPREAD);
  });

  it("swings at its own speed rather than the body's", () => {
    const light = fightingSession();
    const heavy = fightingSession();
    arm(light, "light-sword");
    arm(heavy, "heavy-sword");

    const lightSwings = swingsOver(light, 4000);
    const heavySwings = swingsOver(heavy, 4000);
    expect(heavySwings).toBeLessThan(lightSwings);
  });

  it("leaves an empty-handed body fighting with its natural weapon", () => {
    const session = fightingSession();
    expectWorth(firstBlow(session), BARE_DAMAGE);
  });

  describe("with a weapon in each hand", () => {
    function armBoth(session: GameSession, weapon: string, offhand: string) {
      const kit = session.equipmentOf(selfId(session))!;
      kit.weapon = { id: "itm_main", tileId: weapon };
      kit.offhand = { id: "itm_off", tileId: offhand };
    }

    function blowsOver(session: GameSession, ms: number): number[] {
      const dummyId = session.actorSnapshots().find((a) => a.tileId === "dummy")!.id;
      const blows: number[] = [];
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
        session.tick(TICK_MS);
        for (const number of session.drainDamage()) {
          if (number.targetId === dummyId) blows.push(number.amount);
        }
      }
      return blows;
    }

    it("throws the same blows with two of a weapon as with one", () => {
      const one = fightingSession();
      arm(one, "light-sword");
      const two = fightingSession();
      armBoth(two, "light-sword", "light-sword");

      expect(blowsOver(two, 2000)).toEqual(blowsOver(one, 2000));
    });

    it("throws blows worth each of its two hands", () => {
      const session = fightingSession();
      armBoth(session, "light-sword", "off-sword");

      const blows = blowsOver(session, 2000);
      expect(blows.length).toBeGreaterThan(3);

      const main = blows.filter((blow) => blow >= SWORD_DAMAGE);
      const off = blows.filter((blow) => blow < SWORD_DAMAGE);
      expect(main.length).toBeGreaterThan(0);
      expect(off.length).toBeGreaterThan(0);
      expect(main.length + off.length).toBe(blows.length);
      expect(Math.max(...off)).toBeLessThan(Math.min(...main));
      expect(Math.max(...off)).toBeGreaterThanOrEqual(OFF_SWORD_DAMAGE);
    });

    it("does not take turns with a hand that cannot swing", () => {
      const alone = fightingSession();
      arm(alone, "light-sword");
      const shielded = fightingSession();
      armBoth(shielded, "light-sword", "torch");

      expect(blowsOver(shielded, 2000)).toEqual(blowsOver(alone, 2000));
    });

    it("pays the mastery of the hand that swung", () => {
      const session = fightingSession();
      armBoth(session, "light-sword", "off-sword");
      advance(session, 2000);

      const xp = session.getSnapshot().masteryXp;
      expect(xp.sharp ?? 0).toBeGreaterThan(0);
      expect(xp.blunt ?? 0).toBeGreaterThan(0);
    });
  });
});

describe("picking things up", () => {
  const SWORD = "light-sword";

  function withItem(x: number, y: number, tileId: string): GameSession {
    const map = replaceStack(field(), x, y, 0, [{ tileId: "grass" }, { tileId }]);
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

    expect(getStack(session.getMap(), 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
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
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "heavy-sword" }]);
    const session = new GameSession(map, tiles);

    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));

    expect(bagOf(session).contents!.map((i) => i.tileId)).toEqual([SWORD, "heavy-sword"]);
  });

  it("refuses once the bag is full", () => {
    let map = field();
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

  it("carries a second bag in hand, and refuses it once they are full", () => {
    const session = withItem(1, 0, BAG_TILE_ID);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe(BAG_TILE_ID);
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
    session.equipmentOf(selfId(session))!.bag = null;

    expect(session.equip(refAt(session, 1, 0))).toBe(true);
    const bag = bagOf(session);
    expect(bag.id).toBe("itm_authored");
    expect(bag.contents).toEqual([{ id: "itm_loot", tileId: SWORD }]);
  });

  describe("with nowhere left to put it", () => {
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

    it("puts a torch in the accessory square, leaving both hands free", () => {
      const session = bare(1, 0, "torch");

      expect(session.equip(refAt(session, 1, 0))).toBe(true);
      expect(kitOf(session).charm?.tileId).toBe("torch");
      expect(kitOf(session).weapon).toBeNull();
      expect(kitOf(session).offhand).toBeNull();
    });

    it("falls back to the other hand once the accessory square is taken", () => {
      const session = bare(1, 0, "torch");
      session.equipmentOf(selfId(session))!.charm = {
        id: "itm_worn",
        tileId: "torch",
      };

      expect(session.equip(refAt(session, 1, 0))).toBe(true);
      expect(kitOf(session).offhand?.tileId).toBe("torch");
      expect(kitOf(session).weapon).toBeNull();
    });

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

  it("takes the thing under its own feet", () => {
    const map = replaceStack(field(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: SWORD },
      { tileId: "player", direction: "e" },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(bagOf(session).contents).toHaveLength(1);
    expect(getStack(session.getMap(), 0, 0, 0).map((p) => p.tileId)).toEqual(["grass", "player"]);
  });

  it("refuses something buried under another tile", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: SWORD }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("takes either of two things lying on each other", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: SWORD }, { tileId: SWORD }]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(bagOf(session).contents).toHaveLength(2);
    expect(getStack(session.getMap(), 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
  });

  it("refuses a tile that is not an item at all", () => {
    const session = withItem(1, 0, "dummy");
    expect(session.pickUp(refAt(session, 1, 0))).toBe(false);
  });

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

  function stocked(chestAt: [number, number] = [1, 0]): GameSession {
    let map = replaceStack(field(), 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]);
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
    expect(session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" })).toBe(true);
    expect(kitOf(session).weapon?.tileId).toBe(SWORD);
    expect(kitOf(session).bag?.contents).toEqual([]);

    expect(session.moveItem({ kind: "weapon" }, { kind: "contents", index: 0 })).toBe(true);
    expect(kitOf(session).weapon).toBeNull();
    expect(kitOf(session).bag?.contents).toHaveLength(1);
  });

  it("counts a drawn weapon towards the blow it lands", () => {
    const map = withBody(field(), 1, 0, "dummy");
    const session = new GameSession(
      replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]),
      tiles,
    );
    session.pickUp(refAt(session, 1, 1));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });

    const dummy = session.actorSnapshots().find((a) => a.tileId === "dummy")!;
    session.setTarget(dummy.id);
    session.setAttackMode(true);
    expectWorth(firstBlow(session), SWORD_DAMAGE);
  });

  it("loots a chest on the floor, rewriting the placement it came out of", () => {
    const session = stocked();
    const chest = refAt(session, 1, 0);
    expect(
      session.moveItem(
        { kind: "ground", ref: chest, index: 0 },
        {
          kind: "contents",
          index: 0,
        },
      ),
    ).toBe(true);

    expect(kitOf(session).bag?.contents).toHaveLength(2);
    expect(getStack(session.getMap(), 1, 0, 0)[1].contents).toEqual([]);
  });

  it("loots a chest authored with no ids in it, and the kit still crosses the wire", () => {
    let map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", contents: [{ tileId: SWORD }] as never },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 1, 0);

    expect(
      session.moveItem({ kind: "ground", ref: chest, index: 0 }, { kind: "contents", index: 0 }),
    ).toBe(true);

    const equipment = kitOf(session);
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(parseServerMessage(JSON.stringify({ type: "equipment", equipment }))).not.toBeNull();
  });

  it("survives a map save while it is inside a container on the floor", () => {
    let map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: "itm_chest", contents: [{ id: "itm_loot", tileId: "lantern" }] },
    ]);
    const saved = new GameSession(parseMap(serializeMap(map)), tiles);
    const chest = refAt(saved, 1, 0);

    expect(
      saved.moveItem({ kind: "ground", ref: chest, index: 0 }, { kind: "contents", index: 0 }),
    ).toBe(true);

    const equipment = kitOf(saved);
    expect(equipment.bag?.contents?.[0].tileId).toBe("lantern");
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(parseServerMessage(JSON.stringify({ type: "equipment", equipment }))).not.toBeNull();
  });

  it("was never a problem for a bare item lying on the floor", () => {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "lantern" }]);
    const session = new GameSession(parseMap(serializeMap(map)), tiles);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);

    const equipment = kitOf(session);
    expect(equipment.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(parseServerMessage(JSON.stringify({ type: "equipment", equipment }))).not.toBeNull();
  });

  it("stashes into it, which is the same move the other way round", () => {
    const session = stocked();
    const chest = refAt(session, 1, 0);
    expect(
      session.moveItem(
        { kind: "contents", index: 0 },
        {
          kind: "ground",
          ref: chest,
          index: 0,
        },
      ),
    ).toBe(true);

    expect(kitOf(session).bag?.contents).toEqual([]);
    expect(getStack(session.getMap(), 1, 0, 0)[1].contents).toHaveLength(2);
  });

  it("refuses a chest the player has walked away from", () => {
    const session = stocked([3, 0]);
    const chest = refAt(session, 3, 0);
    expect(
      session.moveItem(
        { kind: "ground", ref: chest, index: 0 },
        {
          kind: "contents",
          index: 0,
        },
      ),
    ).toBe(false);
    expect(kitOf(session).bag?.contents).toHaveLength(1);
  });

  it("tells the owner their kit changed, and only then", () => {
    const session = stocked();
    const me = selfId(session);
    session.drainEquipmentChanges();

    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });
    expect(session.drainEquipmentChanges()).toEqual([me]);

    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("has nothing to say for an actor who is not here", () => {
    const session = stocked();
    expect(session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" }, "nobody")).toBe(
      false,
    );
    expect(session.canMoveItem({ kind: "contents", index: 0 }, { kind: "weapon" }, "nobody")).toBe(
      false,
    );
  });

  it("answers the same question the move runs", () => {
    const session = stocked();
    expect(session.canMoveItem({ kind: "contents", index: 0 }, { kind: "weapon" })).toBe(true);
    expect(session.canMoveItem({ kind: "contents", index: 3 }, { kind: "weapon" })).toBe(false);
  });
});

describe("putting things down", () => {
  const SWORD = "light-sword";

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  function armed(board: MapFile = field()): GameSession {
    const map = replaceStack(board, 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 1));
    return session;
  }

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
    expect(session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(true);

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
    expect(near.drop({ kind: "contents", index: 0 }, { x: 3, y: 0, z: 0 })).toBe(true);
    const far = armed();
    expect(far.drop({ kind: "contents", index: 0 }, { x: 6, y: 0, z: 0 })).toBe(false);
    expect(far.getSnapshot().equipment.bag?.contents).toHaveLength(1);
  });

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

  it("throws a thing into the container it lands on", () => {
    const session = armedFacingChest();

    expect(session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(true);

    expect(tilesAt(session, 2, 0)).toEqual(["grass", "chest"]);
    expect(getStack(session.getMap(), 2, 0, 0)[1]!.contents?.map((i) => i.tileId)).toEqual([SWORD]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("lands on a full container rather than refusing", () => {
    const session = armedFacingChest([
      { id: "itm_a", tileId: SWORD },
      { id: "itm_b", tileId: SWORD },
    ]);

    expect(session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(true);
    expect(tilesAt(session, 2, 0)).toEqual(["grass", "chest", SWORD]);
  });

  it("refuses an empty slot, and says so rather than dropping nothing", () => {
    const session = armed();
    expect(session.drop({ kind: "weapon" }, { x: 1, y: 0, z: 0 })).toBe(false);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  it("refuses a cell with no ground in it", () => {
    const session = armed();
    expect(session.drop({ kind: "contents", index: 0 }, { x: 0, y: 4, z: 0 })).toBe(false);
  });

  it("tells the owner their kit changed", () => {
    const session = armed();
    session.drainEquipmentChanges();
    session.drop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 });
    expect(session.drainEquipmentChanges()).toEqual([selfId(session)]);
  });

  it("answers the same question the drop runs", () => {
    const session = armed();
    expect(session.canDrop({ kind: "contents", index: 0 }, { x: 2, y: 0, z: 0 })).toBe(true);
    expect(session.canDrop({ kind: "contents", index: 0 }, { x: 9, y: 0, z: 0 })).toBe(false);
    expect(session.canDrop({ kind: "weapon" }, { x: 2, y: 0, z: 0 })).toBe(false);
  });
});

describe("carried lights", () => {
  const LANTERN = "lantern";

  function withLantern(x: number, y: number): GameSession {
    const map = replaceStack(field(), x, y, 0, [{ tileId: "grass" }, { tileId: LANTERN }]);
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

  it("goes out again when the lantern is put back in the bag", () => {
    const session = withLantern(1, 0);
    session.pickUp(refAt(session, 1, 0));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });
    expect(lightsOf(session)).toEqual([LANTERN]);

    session.moveItem({ kind: "weapon" }, { kind: "contents", index: 0 });
    expect(session.getSnapshot().equipment.weapon).toBeNull();
    expect(lightsOf(session)).toEqual([]);
  });

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

describe("dying with something on you", () => {
  const SWORD = "light-sword";

  const LONG_ENOUGH_TO_KILL_MS = 30_000;

  const KILLER = "killer";

  function refAt(session: GameSession, x: number, y: number) {
    const stack = getStack(session.getMap(), x, y, 0);
    return { x, y, z: 0, stackIndex: stack.length - 1 };
  }

  function tilesAt(session: GameSession, x: number, y: number): string[] {
    return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
  }

  function doomed(): GameSession {
    let map = replaceStack(field(), 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 1));
    session.moveItem({ kind: "contents", index: 0 }, { kind: "weapon" });

    session.spawn(KILLER, { at: { x: 1, y: 0, z: 0, direction: "w" } });
    session.setTarget(selfId(session), KILLER);
    session.setAttackMode(true, KILLER);
    session.setPvp(true, KILLER);
    session.setPvp(true, selfId(session));
    return session;
  }

  it("leaves the whole kit on the floor where the body fell", () => {
    const session = doomed();

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(session.actorIds()).not.toContain(LOCAL_ACTOR_ID);
    expect(tilesAt(session, 0, 0)).toEqual(["grass", SWORD]);
  });

  it("spills what was in the bag rather than dropping the bag", () => {
    const session = doomed();
    session.pickUp(refAt(session, 0, 1));

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(tilesAt(session, 0, 0)).toEqual(["grass", SWORD, "cherry"]);
  });

  it("keeps the identity of everything it drops", () => {
    const session = doomed();
    const swordId = session.getSnapshot().equipment.weapon!.id;

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    const dropped = getStack(session.getMap(), 0, 0, 0).find((placed) => placed.tileId === SWORD);
    expect(dropped?.itemId).toBe(swordId);
  });

  it("hands the death over empty-handed", () => {
    const session = doomed();
    const playerId = selfId(session);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    const death = session.drainDeaths().find((one) => one.id === playerId);
    expect(death?.equipment).toEqual(emptyEquipment());
  });

  it("leaves a creature's kit on the floor exactly as it does a player's", () => {
    const session = new GameSession(withBody(field(), 1, 0, "packrat"), tiles);
    const rat = session.actorSnapshots().find((actor) => actor.tileId === "packrat")!;
    session.setTarget(rat.id);
    session.setAttackMode(true);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(tilesAt(session, 1, 0)).toEqual(["grass", SWORD]);
  });

  it("leaves nothing behind for a body that was carrying nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = session.actorSnapshots().find((actor) => actor.tileId === "dummy")!.id;
    session.setTarget(dummyId);
    session.setAttackMode(true);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });
});

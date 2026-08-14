import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { STARTING_BAG_TILE_ID, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

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
const CERTAIN = { acc: 100, flee: 0, spd: 100 };

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: { battler: { maxHp: 100, atk: 5, def: 0, ...CERTAIN } },
  }),
  tile({
    id: "dummy",
    height: 1,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: { maxHp: 500, atk: 0, def: 0, acc: 50, flee: 0, spd: 0 },
    },
  }),
  // A creature with a mind of its own — a resident, and nobody's player.
  tile({
    id: "deer",
    height: 1,
    kind: "battler",
    walkable: false,
    interactions: {
      battler: { maxHp: 10, atk: 0, def: 0, acc: 50, flee: 0, spd: 0 },
      brain: { initial: "idle", states: { idle: { do: [{ action: "hold" }] } }, transitions: [] },
    },
  }),
  tile({
    id: STARTING_BAG_TILE_ID,
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
      item: { type: "weapon", atk: 10, def: 0, acc: 0, spd: 0, mastery: "blade" },
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
  // Slow and clumsy in the two ways a weapon can now be told to be.
  tile({
    id: "heavy-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", atk: 10, def: 2, acc: -20, spd: -40, mastery: "blade" },
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
    expect(kit.bag?.tileId).toBe(STARTING_BAG_TILE_ID);
    expect(kit.bag?.contents).toEqual([]);
  });

  it("gives the bag a real identity, so it can be dropped and found again", () => {
    const session = new GameSession(field(), tiles);
    expect(session.getSnapshot().equipment.bag?.id).toMatch(/^itm_/);
  });

  it("gives two players two different bags", () => {
    const session = new GameSession(field(), tiles, ["a", "b"]);
    const a = session.equipmentOf("a")!.bag!.id;
    const b = session.equipmentOf("b")!.bag!.id;
    expect(a).not.toBe(b);
  });

  /**
   * A deer is an actor in every other respect. Handing every creature in the
   * world a backpack it will never open would be a bag per body to seat and
   * carry around for nothing.
   */
  it("gives a resident creature nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "deer"), tiles);
    const deer = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "deer")!;
    const kit = session.equipmentOf(deer.id)!;

    expect(kit.weapon).toBeNull();
    expect(kit.bag).toBeNull();
  });

  it("is nothing at all when the world has no bag tile to give", () => {
    const withoutBag = tiles.filter((t) => t.id !== STARTING_BAG_TILE_ID);
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

  it("adds its attack to every blow", () => {
    const bare = fightingSession();
    const armed = fightingSession();
    arm(armed, "light-sword");

    // One swing each. The player's acc is 100 and the sword shifts nothing but
    // attack, so the damage is exactly `atk` on both sides and the difference
    // between them is the weapon and nothing else.
    const bareHit = damageOver(bare, TICK_MS * 3);
    const armedHit = damageOver(armed, TICK_MS * 3);

    expect(bareHit).toBe(5);
    expect(armedHit).toBe(5 + 10);
  });

  /**
   * Accuracy widens the damage band downward, so a weapon that costs accuracy
   * is worth *less* than its attack says — which is the whole reason a weapon
   * can be authored to cost it.
   */
  it("blunts its own attack by being inaccurate", () => {
    const heavy = fightingSession();
    arm(heavy, "heavy-sword");
    const hit = damageOver(heavy, TICK_MS * 3);

    expect(hit).toBeGreaterThan(5);
    expect(hit).toBeLessThan(15);
  });

  it("slows the swing by its speed shift", () => {
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

  it("leaves a body with no weapon fighting exactly as its tile says", () => {
    const session = fightingSession();
    expect(damageOver(session, TICK_MS * 3)).toBe(5);
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
   * Containers do not nest, so the only place a bag can go is a back with
   * nothing on it — and every player starts with one already there.
   */
  it("refuses a second bag", () => {
    const session = withItem(1, 0, STARTING_BAG_TILE_ID);
    expect(session.pickUp(refAt(session, 1, 0))).toBe(false);
  });

  it("takes a bag onto a bare back, contents and all", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: STARTING_BAG_TILE_ID,
        itemId: "itm_authored",
        contents: [{ id: "itm_loot", tileId: SWORD }],
      },
    ]);
    const session = new GameSession(map, tiles);
    // Take the starting bag off first — there is no other way to bare a back.
    session.equipmentOf(selfId(session))!.bag = null;

    expect(session.pickUp(refAt(session, 1, 0))).toBe(true);
    const bag = bagOf(session);
    expect(bag.id).toBe("itm_authored");
    expect(bag.contents).toEqual([{ id: "itm_loot", tileId: SWORD }]);
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
      { tileId: "grass" },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.pickUp({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
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
    const session = new GameSession(
      replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: SWORD }]),
      tiles,
    );
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

    expect(before - after).toBe(5 + 10);
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

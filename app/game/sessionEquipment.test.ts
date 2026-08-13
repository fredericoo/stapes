import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
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
  // Weightless, so what it changes is attack and nothing else. Weight lowers
  // accuracy, and accuracy widens the damage band — so a heavy weapon cannot
  // be used to assert an exact number of hit points.
  tile({
    id: "light-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", atk: 10, def: 0, weight: 0, mastery: "blade" },
    },
  }),
  tile({
    id: "heavy-sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", atk: 10, def: 2, weight: 40, mastery: "blade" },
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

    // One swing each. The player's acc is 100 and the sword is weightless, so
    // the damage is exactly `atk` on both sides and the difference between them
    // is the weapon and nothing else.
    const bareHit = damageOver(bare, TICK_MS * 3);
    const armedHit = damageOver(armed, TICK_MS * 3);

    expect(bareHit).toBe(5);
    expect(armedHit).toBe(5 + 10);
  });

  /**
   * Weight is spent against accuracy as well as speed, and accuracy widens the
   * damage band downward — so a heavy weapon is worth *less* than its attack
   * says, and the shortfall is the whole reason weight is a stat.
   */
  it("blunts its own attack by being heavy", () => {
    const heavy = fightingSession();
    arm(heavy, "heavy-sword");
    const hit = damageOver(heavy, TICK_MS * 3);

    expect(hit).toBeGreaterThan(5);
    expect(hit).toBeLessThan(15);
  });

  it("slows the swing by its weight", () => {
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

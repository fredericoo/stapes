import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { resolveBattler } from "../lib/battler";
import { resolveBrain } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { attackIntervalMs } from "./combat";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * Fighting, on a board.
 *
 * The formulas have their own file; this is about everything around them — who
 * may swing at whom, how often, what a blow does to the world, and what happens
 * to a body that runs out of hit points.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

/**
 * A creature that swings at whoever hit it and never stops.
 *
 * Deliberately without the movement half of the real cat's brain: what is being
 * tested is the `attacked` condition and the `attack` action, and a creature
 * that also wanders would make every assertion about position a coin toss.
 */
const brawlerBrain = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" as const }] },
    fighting: {
      do: [
        { action: "attack" as const, of: "$foe" as const },
        { action: "hold" as const },
      ],
    },
  },
  transitions: [
    {
      from: "any",
      if: { cond: "attacked" as const },
      bind: { foe: "attacker" as const },
      to: "fighting",
    },
  ],
};

/** Certain to hit, certain to hurt, and as fast as the rules allow. */
const CERTAIN = { acc: 100, flee: 0, spd: 100 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: { maxHp: 100, atk: 5, def: 0, ...CERTAIN },
    },
  }),
  // Hit points, no mind. What a target that cannot fight back looks like.
  tile({
    id: "dummy",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { maxHp: 10, atk: 0, def: 0, acc: 50, flee: 0, spd: 0 },
    },
  }),
  // Armoured past anything the player can do to it.
  tile({
    id: "anvil",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { maxHp: 10, atk: 0, def: 99, acc: 50, flee: 0, spd: 0 },
    },
  }),
  tile({
    id: "brawler",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { maxHp: 30, atk: 3, def: 0, ...CERTAIN },
      brain: brawlerBrain,
    },
  }),
  // A body with no battler block at all: swinging at it must fail, not throw.
  tile({ id: "statue", height: 1, actor: true, walkable: false }),
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

/** The one actor standing in a body of this tile, if it is still on the board. */
function bodyOf(session: GameSession, tileId: string) {
  return session.actorSnapshots().find((actor) => actor.tileId === tileId);
}

function self(session: GameSession) {
  return session.getSnapshot().self;
}

describe("hit points", () => {
  it("start full, and only exist on a body that has stats", () => {
    const session = new GameSession(
      withBody(withBody(field(), 1, 0, "dummy"), 2, 0, "statue"),
      tiles,
    );

    expect(self(session).hp).toBe(100);
    expect(self(session).maxHp).toBe(100);
    expect(bodyOf(session, "dummy")?.hp).toBe(10);
    // Not zero: zero means dead, and this body cannot be either.
    expect(bodyOf(session, "statue")?.hp).toBeNull();
    expect(bodyOf(session, "statue")?.maxHp).toBeNull();
  });
});

describe("swinging at a target", () => {
  it("takes hit points off somebody standing beside you", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(bodyOf(session, "dummy")!.hp).toBe(5);
  });

  /**
   * Diagonals are in reach. Excluding them would mean a creature on your
   * shoulder corner cannot be hit, which no player will read as a rule.
   */
  it("reaches a foe standing on the corner", () => {
    const session = new GameSession(withBody(field(), 1, 1, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(bodyOf(session, "dummy")!.hp).toBe(5);
  });

  it("does nothing to somebody across the field", () => {
    const session = new GameSession(withBody(field(), 3, 3, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(10);
  });

  /** The rate is the stat's, not the tick loop's or the client's. */
  it("swings no faster than its speed allows", () => {
    const slowPlayer = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: { maxHp: 100, atk: 1, def: 0, acc: 100, flee: 0, spd: 0 },
            },
          })
        : t,
    );
    const session = new GameSession(
      withBody(field(), 1, 0, "dummy"),
      slowPlayer,
    );
    session.setTarget(bodyOf(session, "dummy")!.id);

    const interval = attackIntervalMs(0);
    advance(session, interval - TICK_MS);
    expect(bodyOf(session, "dummy")!.hp).toBe(9);

    advance(session, TICK_MS * 2);
    expect(bodyOf(session, "dummy")!.hp).toBe(8);
  });

  it("turns to face what it is hitting", () => {
    const session = new GameSession(withBody(field(), 0, -1, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(self(session).direction).toBe("n");
  });

  /**
   * "Attempt to attack anything, and fail graciously." Every one of these is a
   * lookup that comes back empty rather than a case anybody had to write.
   */
  it.each([
    ["a body with no hit points", "statue"],
    ["armour it cannot get through", "anvil"],
  ])("fails quietly against %s", (_label, tileId) => {
    const session = new GameSession(withBody(field(), 1, 0, tileId), tiles);
    session.setTarget(bodyOf(session, tileId)!.id);

    expect(() => advance(session, 1000)).not.toThrow();
    expect(bodyOf(session, tileId)).toBeDefined();
  });

  it("ignores a target that names nobody at all", () => {
    const session = new GameSession(field(), tiles);
    session.setTarget("nobody-by-that-name");

    expect(() => advance(session, 500)).not.toThrow();
    expect(session.getSnapshot().targetId).toBeNull();
  });

  it("refuses to let anything fight itself", () => {
    const session = new GameSession(field(), tiles);
    session.setTarget(self(session).id);
    expect(session.getSnapshot().targetId).toBeNull();
  });
});

describe("damage numbers", () => {
  it("come off the blow, once each, where it landed", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);
    const dealt = session.drainDamage();

    expect(dealt).toHaveLength(1);
    expect(dealt[0]).toMatchObject({ amount: 5, x: 1, y: 0, z: 0 });
    // Drained means gone: a second reader would otherwise broadcast it twice.
    expect(session.drainDamage()).toHaveLength(0);
  });

  it("stay on screen for a viewer after the tick that produced them", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);
    session.drainDamage();
    session.tick(TICK_MS);

    expect(session.getSnapshot().damage.length).toBeGreaterThan(0);
  });
});

describe("running out of hit points", () => {
  it("takes the body off the map for good", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    session.setTarget(dummyId);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")).toBeUndefined();
    expect(session.actorIds()).not.toContain(dummyId);
    expect(session.drainDeaths()).toContain(dummyId);
  });

  it("releases whoever was fighting them", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(session.getSnapshot().targetId).toBeNull();
  });

  /**
   * A dead actor is gone from the session entirely, which is what leaves a dead
   * player unable to do anything until they reload — the server drops every
   * message from an id it has no actor for.
   */
  it("leaves nothing behind to drive", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    session.setTarget(dummyId);

    advance(session, 1000);

    expect(() => session.requestStep(dummyId, "n")).toThrow();
  });
});

describe("a creature that fights back", () => {
  it("turns on whoever hit it, and keeps swinging", () => {
    const session = new GameSession(withBody(field(), 1, 0, "brawler"), tiles);
    session.setTarget(bodyOf(session, "brawler")!.id);

    // Long enough for the blow to land, the brain to notice on its slower clock,
    // and the answer to come back.
    advance(session, 1000);

    expect(self(session).hp!).toBeLessThan(100);
  });

  it("does nothing to anybody who has not touched it", () => {
    const session = new GameSession(withBody(field(), 1, 0, "brawler"), tiles);

    advance(session, 2000);

    expect(self(session).hp).toBe(100);
  });
});

describe("the authored creatures", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);
  const byId = Object.fromEntries(authored.map((t) => [t.id, t]));

  it.each(["player", "deer", "cat"])("gives %s hit points", (id) => {
    expect(resolveBattler(byId[id]!)).not.toBeNull();
  });

  /** A deer that runs away is a deer with nothing to hit you with. */
  it("leaves the deer unable to deal damage at all", () => {
    expect(resolveBattler(byId.deer!)!.atk).toBe(0);
    const brain = resolveBrain(byId.deer!);
    const swings = Object.values(brain!.states).some((state) =>
      state.do.some((action) => action.action === "attack"),
    );
    expect(swings).toBe(false);
  });

  it("still parses both creatures' brains after the new transitions", () => {
    expect(resolveBrain(byId.deer!)).not.toBeNull();
    expect(resolveBrain(byId.cat!)).not.toBeNull();
  });

  it("sends the cat after whoever hit it", () => {
    const brain = resolveBrain(byId.cat!)!;
    const retaliation = brain.transitions.find(
      (t) => t.if.cond === "attacked",
    );
    expect(retaliation?.bind).toEqual({ foe: "attacker" });
    expect(brain.states[retaliation!.to]?.do[0]).toEqual({
      action: "attack",
      of: "$foe",
    });
  });

  it("spooks the deer at whoever hit it", () => {
    const brain = resolveBrain(byId.deer!)!;
    const spook = brain.transitions.find((t) => t.if.cond === "attacked");
    expect(spook?.bind).toEqual({ spooked: "attacker" });
    expect(spook?.to).toBe("flee");
  });
});

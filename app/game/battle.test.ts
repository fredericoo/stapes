import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { defFrom, maxHpFrom, resolveBattler } from "../lib/battler";
import { ATTACKER_SELECTOR, nearest, resolveBrain, slot } from "../lib/brain";
import { conditionLeaves } from "../lib/conditions";
import { emptyMap, replaceStack } from "../lib/mapData";
import { COMBAT_DURATION_MS, COMBAT_STATUS_ID, statusesById } from "../lib/status";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTiles } from "../lib/types";
import {
  ASSAILANT_GRACE_MS,
  attackIntervalMs,
  MIN_ATTACK_TICKS,
  STRIKE_RECOVERY_STEPS,
  SWING_WINDUP_SHARE,
} from "./combat";
import {
  BRAIN_ATTENTION_FLOOR_CELLS,
  BRAIN_ROUND_TICKS,
  STRIKE_DURATION_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import type { TileTransitionNote, Transition } from "../lib/tileTransition";
import { FRAME, tile as baseTile } from "../lib/testTile";

function tile(partial: Record<string, unknown> & Pick<TileDef, "id" | "height">): TileDef {
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return baseTile({
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const brawlerBrain = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" as const }] },
    fighting: {
      do: [{ action: "attack" as const, of: slot("foe") }, { action: "hold" as const }],
    },
  },
  transitions: [
    {
      from: "any",
      if: { cond: "attacked" as const },
      bind: { foe: ATTACKER_SELECTOR },
      to: "fighting",
    },
  ],
};

const RESTING_NOISE = "yawn";

const REST_AFTER_MS = 1000;

function pickingOn(foe: string, restAfterMs?: number) {
  return {
    initial: "idle",
    states: {
      idle: { do: [{ action: "hold" as const }] },
      fighting: {
        do: [{ action: "attack" as const, of: slot("foe") }, { action: "hold" as const }],
      },
      resting: {
        onEnter: [{ effect: "noise" as const, text: RESTING_NOISE }],
        do: [{ action: "hold" as const }],
      },
    },
    transitions: [
      {
        from: "idle",
        if: { cond: "in_range" as const, of: nearest(foe), cells: 1 },
        bind: { foe: nearest(foe) },
        to: "fighting",
      },
      ...(restAfterMs === undefined
        ? []
        : [{ from: "fighting", if: { cond: "after" as const, ms: restAfterMs }, to: "resting" }]),
    ],
  };
}

const CERTAIN = { accuracy: 100, spd: 100 };

const BETWEEN_ROUNDS = { accuracy: 100, spd: 97 };

const FIXTURE_BASE_HP = 8;

const PLAYER_TOUGHNESS = 92;
const PLAYER_MAX_HP = maxHpFrom(FIXTURE_BASE_HP, PLAYER_TOUGHNESS);
const DUMMY_TOUGHNESS = 42;
const BRAWLER_TOUGHNESS = 22;

const feltBy = (toughness: number) => defFrom(toughness) + 5;

const claws = (fields: Record<string, unknown>) => ({
  type: "weapon" as const,
  damage: 0,
  def: 0,
  accuracy: 50,
  variance: 0,
  spd: 0,
  mastery: "fist" as const,
  ...fields,
});

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    lightPassing: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: claws({ damage: feltBy(DUMMY_TOUGHNESS), ...CERTAIN }),
      },
    },
  }),
  tile({
    id: "dummy",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: DUMMY_TOUGHNESS },
        naturalWeapon: claws({}),
      },
    },
  }),
  tile({
    id: "anvil",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: 2 },
        naturalWeapon: claws({ def: 99 }),
      },
    },
  }),
  tile({
    id: "brawler",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: BRAWLER_TOUGHNESS },
        naturalWeapon: claws({ damage: feltBy(PLAYER_TOUGHNESS), ...CERTAIN }),
      },
      brain: brawlerBrain,
    },
  }),
  tile({
    id: "quitter",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: BRAWLER_TOUGHNESS },
        naturalWeapon: claws(CERTAIN),
      },
      brain: pickingOn("player", REST_AFTER_MS),
    },
  }),
  tile({
    id: "bully",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: BRAWLER_TOUGHNESS },
        naturalWeapon: claws(BETWEEN_ROUNDS),
      },
      brain: pickingOn("dummy"),
    },
  }),
  tile({ id: "statue", height: 2, actor: true, walkable: false }),
  tile({
    id: "viper",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: BRAWLER_TOUGHNESS },
        naturalWeapon: claws({
          damage: feltBy(PLAYER_TOUGHNESS),
          ...CERTAIN,
          statuses: [{ id: "venom", chance: 100, fromMs: 30_000, toMs: 60_000 }],
        }),
      },
      brain: brawlerBrain,
    },
  }),
  tile({
    id: "venom-fang",
    height: 0,
    intangible: true,
    kind: "item",
    interactions: {
      item: {
        type: "weapon",
        damage: 1,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 100,
        mastery: "fist",
        statuses: [{ id: "venom", chance: 100 }],
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

function perched(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 1, [{ tileId: "grass" }, { tileId }]);
}

function advanceUntil(session: GameSession, done: () => boolean) {
  for (let elapsed = 0; elapsed < LONG_ENOUGH_TO_KILL_MS; elapsed += TICK_MS) {
    if (done()) return;
    session.tick(TICK_MS);
  }
  throw new Error("condition never came true");
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

function swingsOver(session: GameSession, ms: number): number {
  let swings = 0;
  let last = null;
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    const lean = self(session).strike;
    if (lean && lean !== last) swings++;
    last = lean;
  }
  return swings;
}

function bodyOf(session: GameSession, tileId: string) {
  return session.actorSnapshots().find((actor) => actor.tileId === tileId);
}

function self(session: GameSession) {
  return session.getSnapshot().self;
}

function fight(session: GameSession, actorId: string | null, windupMs = CERTAIN_WINDUP_MS) {
  session.setTarget(actorId);
  session.setAttackMode(true);
  for (let elapsed = 0; elapsed < windupMs; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

const CERTAIN_WINDUP_MS = attackIntervalMs(CERTAIN.spd) * SWING_WINDUP_SHARE;

describe("hit points", () => {
  it("start full, and only exist on a body that has stats", () => {
    const session = new GameSession(
      withBody(withBody(field(), 1, 0, "dummy"), 2, 0, "statue"),
      tiles,
    );

    expect(self(session).hp).toBe(PLAYER_MAX_HP);
    expect(self(session).maxHp).toBe(PLAYER_MAX_HP);
    expect(bodyOf(session, "dummy")?.hp).toBe(DUMMY_MAX_HP);
    expect(bodyOf(session, "statue")?.hp).toBeNull();
    expect(bodyOf(session, "statue")?.maxHp).toBeNull();
  });
});

const ENOUGH_SWINGS_MS = TICK_MS * MIN_ATTACK_TICKS * 6;

const DUMMY_MAX_HP = maxHpFrom(FIXTURE_BASE_HP, DUMMY_TOUGHNESS);

const LONG_ENOUGH_TO_KILL_MS = 8000;

describe("swinging at a target", () => {
  it("takes hit points off somebody standing beside you", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
  });

  it("reaches a foe standing on the corner", () => {
    const session = new GameSession(withBody(field(), 1, 1, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
  });

  it("does nothing to somebody across the field", () => {
    const session = new GameSession(withBody(field(), 3, 3, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
  });

  it("does nothing to somebody standing a floor up", () => {
    const session = new GameSession(perched(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.z).toBe(1);
    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
  });

  it("swings no faster than its speed allows", () => {
    const slowPlayer = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: PLAYER_TOUGHNESS },
                naturalWeapon: claws({ damage: 1, accuracy: 100 }),
              },
            },
          })
        : t,
    );
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), slowPlayer);

    const interval = attackIntervalMs(0);
    fight(session, bodyOf(session, "dummy")!.id, interval * SWING_WINDUP_SHARE);
    expect(swingsOver(session, interval - TICK_MS)).toBe(1);
    expect(swingsOver(session, TICK_MS * 2)).toBe(1);
  });

  describe("getting into the first blow", () => {
    const INTERVAL_MS = attackIntervalMs(0);
    const APPROACH_MS = INTERVAL_MS * SWING_WINDUP_SHARE;

    const slow = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: PLAYER_TOUGHNESS },
                naturalWeapon: claws({ damage: 1, accuracy: 100 }),
              },
            },
          })
        : t,
    );

    function approaching() {
      const board = withBody(withBody(field(), 1, 0, "dummy"), 0, 1, "anvil");
      const session = new GameSession(board, slow);
      session.setTarget(bodyOf(session, "dummy")!.id);
      session.setAttackMode(true);
      return session;
    }

    it("holds the first blow for half the interval", () => {
      const session = approaching();

      expect(swingsOver(session, APPROACH_MS - TICK_MS)).toBe(0);
      expect(swingsOver(session, TICK_MS * 2)).toBe(1);
    });

    it("keeps the approach it had wound up through a walk out of reach", () => {
      const session = approaching();
      advance(session, APPROACH_MS - WALK_DURATION_MS * 3);

      session.setInput({ directions: ["w"] });
      advanceUntil(session, () => self(session).x === -1);
      session.setInput({ directions: ["e"] });
      advanceUntil(session, () => self(session).x === 0);
      session.setInput({ directions: [] });

      expect(swingsOver(session, TICK_MS)).toBe(0);
      expect(swingsOver(session, WALK_DURATION_MS * 4)).toBe(1);
    });

    it("owes a whole approach again after every blow", () => {
      const session = approaching();
      expect(swingsOver(session, APPROACH_MS + TICK_MS)).toBe(1);

      session.setInput({ directions: ["w"] });
      advanceUntil(session, () => self(session).x === -1);
      session.setInput({ directions: [] });
      advance(session, INTERVAL_MS);
      session.setInput({ directions: ["e"] });
      advanceUntil(session, () => self(session).x === 0);
      session.setInput({ directions: [] });

      const IN_REACH_MS = WALK_DURATION_MS * (STRIKE_RECOVERY_STEPS + 1);
      expect(swingsOver(session, APPROACH_MS - IN_REACH_MS - WALK_DURATION_MS)).toBe(0);
      expect(swingsOver(session, WALK_DURATION_MS * 3)).toBe(1);
    });

    it("makes a second target a second approach", () => {
      const session = approaching();
      advance(session, APPROACH_MS - TICK_MS);

      session.setTarget(bodyOf(session, "anvil")!.id);

      expect(swingsOver(session, APPROACH_MS - TICK_MS)).toBe(0);
      expect(swingsOver(session, TICK_MS * 2)).toBe(1);
    });

    describe("the wait it reports", () => {
      function waitMs(session: GameSession) {
        return session.getSnapshot().nextBlow?.remainingMs ?? null;
      }

      it("says nothing at all until a fight is picked", () => {
        const session = new GameSession(withBody(field(), 1, 0, "dummy"), slow);
        advance(session, APPROACH_MS);

        expect(session.getSnapshot().nextBlow).toBeNull();
      });

      it("counts the approach down to the first blow", () => {
        const session = approaching();
        advance(session, TICK_MS);

        const wait = session.getSnapshot().nextBlow!;
        expect(wait.remainingMs).toBeCloseTo(APPROACH_MS, 6);
        expect(wait.durationMs).toBe(INTERVAL_MS);

        expect(swingsOver(session, wait.remainingMs - TICK_MS)).toBe(0);
        expect(swingsOver(session, TICK_MS)).toBe(1);
      });

      it("counts the cooldown down to every blow after it", () => {
        const session = approaching();
        advance(session, TICK_MS);
        expect(swingsOver(session, APPROACH_MS)).toBe(1);

        const wait = session.getSnapshot().nextBlow!;
        expect(wait.remainingMs).toBe(INTERVAL_MS);
        expect(wait.durationMs).toBe(INTERVAL_MS);

        advance(session, INTERVAL_MS / 2);
        const left = session.getSnapshot().nextBlow!.remainingMs;
        expect(left / INTERVAL_MS).toBeCloseTo(0.5, 2);
      });

      it("says nothing once the body has left reach", () => {
        const session = approaching();
        advance(session, TICK_MS);
        expect(waitMs(session)).not.toBeNull();

        session.setInput({ directions: ["w"] });
        advanceUntil(session, () => self(session).x === -1);
        session.setInput({ directions: [] });
        advance(session, TICK_MS);

        expect(session.getSnapshot().nextBlow).toBeNull();
      });
    });
  });

  it("turns to face what it is hitting", () => {
    const session = new GameSession(withBody(field(), 0, -1, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(self(session).direction).toBe("n");
  });

  it.each([
    ["a body with no hit points", "statue"],
    ["armour it cannot get through", "anvil"],
  ])("fails quietly against %s", (_label, tileId) => {
    const session = new GameSession(withBody(field(), 1, 0, tileId), tiles);
    fight(session, bodyOf(session, tileId)!.id);

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

describe("targeting without attacking", () => {
  it("keeps the target and never swings", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    session.setTarget(dummyId);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
    expect(session.getSnapshot().targetId).toBe(dummyId);
  });

  it("leaves an idle world idle", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(session.isAtRest()).toBe(true);
  });

  it("starts swinging the moment the mode goes on, at the same target", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    session.setTarget(bodyOf(session, "dummy")!.id);
    advance(session, 1000);

    session.setAttackMode(true);
    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
    expect(session.isAtRest()).toBe(false);
  });

  it("stops swinging when the mode goes off, and keeps the target", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    fight(session, dummyId);
    advance(session, ENOUGH_SWINGS_MS);

    const settled = bodyOf(session, "dummy")!.hp!;
    session.setAttackMode(false);
    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(settled);
    expect(session.getSnapshot().targetId).toBe(dummyId);
  });

  it("says which of the two it is in the snapshot", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    expect(session.getSnapshot().attacking).toBe(false);

    session.setAttackMode(true);

    expect(session.getSnapshot().attacking).toBe(true);
  });
});

describe("damage numbers", () => {
  it("come off the blow, once each, where it landed", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    const dealt: ReturnType<typeof session.drainDamage> = [];
    for (let elapsed = 0; elapsed < ENOUGH_SWINGS_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      dealt.push(...session.drainDamage());
    }

    const hits = dealt.filter((number) => number.outcome === "hit");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(hits[0]!.amount).toBeGreaterThanOrEqual(5);
    expect(hits[0]!.amount).toBeLessThanOrEqual(feltBy(DUMMY_TOUGHNESS));
    expect(session.drainDamage()).toHaveLength(0);
  });

  it("stay on screen for a viewer after the tick that produced them", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => session.getSnapshot().damage.length > 0);
    session.drainDamage();
    session.tick(TICK_MS);

    expect(session.getSnapshot().damage.length).toBeGreaterThan(0);
  });
});

describe("running out of hit points", () => {
  it("takes the body off the map for good", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    fight(session, dummyId);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(bodyOf(session, "dummy")).toBeUndefined();
    expect(session.actorIds()).not.toContain(dummyId);
    expect(session.drainDeaths().map((death) => death.id)).toContain(dummyId);
  });

  it("releases whoever was fighting them", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(session.getSnapshot().targetId).toBeNull();
  });

  it("leaves nothing behind to drive", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    fight(session, dummyId);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(() => session.requestStep(dummyId, "n")).toThrow();
  });
});

const STRIKE_OVER_MS = STRIKE_DURATION_MS + TICK_MS;

describe("throwing yourself at somebody", () => {
  it("leans towards whoever it is swinging at", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(self(session).strike).toMatchObject({ dx: 1, dy: 0, dElev: 0 });
  });

  it("leans at the corner for a foe on the corner", () => {
    const session = new GameSession(withBody(field(), 1, 1, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    session.tick(TICK_MS);

    expect(self(session).strike).toMatchObject({ dx: 1, dy: 1 });
  });

  it("comes home without ever having moved", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const before = self(session);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, STRIKE_OVER_MS);

    const after = self(session);
    expect(after.strike).toBeNull();
    expect([after.x, after.y, after.z]).toEqual([before.x, before.y, before.z]);
  });

  it("shows something for every swing, whatever it came to", () => {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), tiles);
    const anvil = bodyOf(session, "anvil")!;
    fight(session, anvil.id);

    let lunges = 0;
    let receipts = 0;
    let hops = 0;
    let lastMine = null;
    let lastTheirs = null;
    for (let elapsed = 0; elapsed < ENOUGH_SWINGS_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      receipts += session.drainDamage().length;
      const mine = self(session).strike;
      if (mine && mine !== lastMine) lunges++;
      lastMine = mine;
      const theirs = bodyOf(session, "anvil")?.strike ?? null;
      if (theirs && theirs !== lastTheirs) hops++;
      lastTheirs = theirs;
    }

    expect(lunges).toBeGreaterThan(1);
    expect(receipts + hops).toBe(lunges);
    expect(bodyOf(session, "anvil")!.hp).toBe(anvil.hp);
  });

  it("throws the dodger back the way the blow came", () => {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), tiles);
    fight(session, bodyOf(session, "anvil")!.id);

    advanceUntil(session, () => bodyOf(session, "anvil")?.strike != null);

    expect(bodyOf(session, "anvil")!.strike).toMatchObject({
      kind: "dodge",
      dx: 1,
      dy: 0,
    });
  });
});

describe("a creature that fights back", () => {
  it("turns on whoever hit it, and keeps swinging", () => {
    const session = new GameSession(withBody(field(), 1, 0, "brawler"), tiles);
    fight(session, bodyOf(session, "brawler")!.id);

    advance(session, 1000);

    expect(self(session).hp!).toBeLessThan(PLAYER_MAX_HP);
  });

  it("does nothing to anybody who has not touched it", () => {
    const session = new GameSession(withBody(field(), 1, 0, "brawler"), tiles);

    advance(session, 2000);

    expect(self(session).hp).toBe(PLAYER_MAX_HP);
  });

  function ticksOfBlowsBy(session: GameSession, actorId: string, ms: number): number[] {
    const landed: number[] = [];
    for (let tick = 0; tick * TICK_MS < ms; tick++) {
      session.tick(TICK_MS);
      if (session.drainSwings().includes(actorId)) landed.push(tick);
    }
    return landed;
  }

  it("stops swinging on the round it decides to do something else", () => {
    const session = new GameSession(withBody(field(), 1, 0, "quitter"), tiles);
    const quitter = bodyOf(session, "quitter")!.id;

    let blows = 0;
    let rested = false;
    for (let elapsed = 0; !rested && elapsed < LONG_ENOUGH_TO_KILL_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      if (session.drainSwings().includes(quitter)) blows++;
      rested = session.drainNoise().some((noise) => noise.text === RESTING_NOISE);
    }

    expect(rested).toBe(true);
    expect(blows).toBeGreaterThan(0);
    expect(ticksOfBlowsBy(session, quitter, ENOUGH_SWINGS_MS)).toEqual([]);
  });

  it("stops swinging along with its brain once nobody is connected", () => {
    const session = new GameSession(
      withBody(withBody(field(), 2, 0, "bully"), 3, 0, "dummy"),
      tiles,
    );
    const bully = bodyOf(session, "bully")!.id;
    expect(ticksOfBlowsBy(session, bully, ENOUGH_SWINGS_MS)).not.toEqual([]);

    session.despawn(LOCAL_ACTOR_ID);

    expect(ticksOfBlowsBy(session, bully, ENOUGH_SWINGS_MS)).toEqual([]);
  });

  it("swings only on its own turns while nobody is near enough to notice", () => {
    const far = BRAIN_ATTENTION_FLOOR_CELLS + 2;
    const session = new GameSession(
      withBody(withBody(field(far + 1), far, 0, "bully"), far + 1, 0, "dummy"),
      tiles,
    );
    const bully = bodyOf(session, "bully")!.id;
    const intervalTicks = Math.round(attackIntervalMs(BETWEEN_ROUNDS.spd) / TICK_MS);
    expect(intervalTicks % BRAIN_ROUND_TICKS).not.toBe(0);

    const landed = ticksOfBlowsBy(session, bully, ENOUGH_SWINGS_MS * 2);
    const gaps = landed.slice(1).map((tick, i) => tick - landed[i]!);

    expect(gaps).not.toEqual([]);
    expect(gaps.filter((gap) => gap % BRAIN_ROUND_TICKS !== 0)).toEqual([]);
  });
});

describe("the authored creatures", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);
  const byId = Object.fromEntries(authored.map((t) => [t.id, t]));

  it.each(["player", "deer", "cat"])("gives %s hit points", (id) => {
    expect(resolveBattler(byId[id]!)).not.toBeNull();
  });

  it("leaves the deer unable to deal damage at all", () => {
    expect(resolveBattler(byId.deer!)!.naturalWeapon.damage).toBe(0);
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
    const retaliation = brain.transitions.find((t) =>
      conditionLeaves(t.if).some((leaf) => leaf.cond === "attacked"),
    );
    expect(retaliation?.bind).toEqual({ foe: ATTACKER_SELECTOR });
    expect(brain.states[retaliation!.to]?.do[0]).toEqual({
      action: "attack",
      of: slot("foe"),
    });
  });

  it("leaves the cyclops immune to every status a stone can leave", () => {
    const left = new Set<string>();
    for (const def of authored) {
      const stone = def.interactions?.item as
        | { type?: string; effect?: { statuses?: { id: string }[] } }
        | undefined;
      if (stone?.type !== "stone") continue;
      for (const status of stone.effect?.statuses ?? []) left.add(status.id);
    }
    const immune = resolveBattler(byId.cyclops!)!.immuneTo ?? [];

    expect(left.size).toBeGreaterThan(0);
    expect([...left].filter((id) => !immune.includes(id))).toEqual([]);
    expect(immune).toContain("paralysed");
  });

  it("spooks the deer at whoever hit it", () => {
    const brain = resolveBrain(byId.deer!)!;
    const spook = brain.transitions.find((t) =>
      conditionLeaves(t.if).some((leaf) => leaf.cond === "attacked"),
    );
    expect(spook?.bind).toEqual({ spooked: ATTACKER_SELECTOR });
    expect(spook?.to).toBe("flee");
  });
});

const bow = claws({
  damage: feltBy(DUMMY_TOUGHNESS),
  ...CERTAIN,
  mastery: "ranged" as const,
  reach: { cells: 6, height: HEIGHT_PER_LEVEL },
  projectile: "arrow",
});

const SPARK: Transition = {
  durationMs: 150,
  particles: {
    ratePerSecond: 60,
    ttlFromMs: 100,
    ttlToMs: 200,
    spawnRadiusCells: 0.2,
    spawnElevFrom: 0,
    spawnElevTo: 2,
    riseFrom: 1,
    riseTo: 4,
    driftCellsPerSecond: 1,
    lit: false,
    gravity: -10,
    windX: 0,
    windY: 0,
    shape: null,
    radiusFromPx: 1,
    radiusToPx: 1,
    alphaFrom: 1,
    alphaTo: 0,
    ramp: [{ at: 0, color: "#ffffff" }],
  },
};

function arrowTile(hit?: Transition, cellsPerSecond = 20): TileDef {
  return tile({
    id: "arrow",
    height: 0,
    type: "directional8",
    kind: "projectile",
    intangible: true,
    interactions: {
      projectile: { cellsPerSecond, ...(hit ? { hit } : {}) },
    },
  });
}

const SLOW_ARROW_CELLS_PER_SECOND = 2;
const TICKS_IN_A_SECOND = Math.ceil(1000 / TICK_MS);
const FAST_ARROW_CELLS_PER_SECOND = 40;

function archerTilesArmedWith(
  weapon: typeof bow,
  hit?: Transition,
  cellsPerSecond?: number,
): TileDef[] {
  return [arrowTile(hit, cellsPerSecond), ...tiles].map((t) =>
    t.id === "player"
      ? tile({
          ...t,
          interactions: {
            battler: {
              baseHp: FIXTURE_BASE_HP,
              masteries: { toughness: PLAYER_TOUGHNESS },
              naturalWeapon: weapon,
            },
          },
        })
      : t,
  );
}

const archerTiles: TileDef[] = archerTilesArmedWith(bow);

function archerTilesFiring(cellsPerSecond: number): TileDef[] {
  return archerTilesArmedWith(bow, undefined, cellsPerSecond);
}

const unreliableBow = claws({
  damage: feltBy(DUMMY_TOUGHNESS),
  accuracy: 50,
  spd: 100,
  mastery: "ranged" as const,
  reach: { cells: 6, height: HEIGHT_PER_LEVEL },
  projectile: "arrow",
});

const ENOUGH_SHOTS_MS = TICK_MS * MIN_ATTACK_TICKS * 40;

const WALL = "wall";
const archerTilesWithWall: TileDef[] = [
  ...archerTiles,
  tile({ id: WALL, height: HEIGHT_PER_LEVEL, walkable: false }),
];

function advanceUntilShotLands(session: GameSession) {
  advanceUntil(session, () => arrows(session).length > 0);
  const shot = arrows(session)[0]!.id;
  advanceUntil(session, () => !arrows(session).some((f) => f.id === shot));
}

function arrows(session: GameSession) {
  return session.getSnapshot().projectiles;
}

describe("shooting at somebody", () => {
  it("lands a blow far past arm's reach", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });

  it("never leans, even at point-blank range", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
    expect(swingsOver(session, 1000)).toBe(0);
  });

  it("puts an arrow in the air, from the bow to the target", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => arrows(session).length > 0);

    const [flight] = arrows(session);
    expect(flight!.tileId).toBe("arrow");
    expect(flight!.from).toMatchObject({ x: 0, y: 0 });
    expect(flight!.to).toMatchObject({ x: 4, y: 0 });
    expect(flight!.durationMs).toBeGreaterThan(0);
  });

  it("takes no hit points until the arrow arrives", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => arrows(session).length > 0);

    const shot = arrows(session)[0]!;
    expect(shot.elapsedMs).toBeLessThan(shot.durationMs);
    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);

    advanceUntil(session, () => !arrows(session).some((f) => f.id === shot.id));

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });

  it("floats the receipt on the tick the arrow arrives", () => {
    const session = new GameSession(
      withBody(field(6), 4, 0, "dummy"),
      archerTilesFiring(SLOW_ARROW_CELLS_PER_SECOND),
    );
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => arrows(session).length > 0);
    const shot = arrows(session)[0]!.id;
    session.setAttackMode(false);

    let ticksWithNoReceipt = 0;
    for (;;) {
      session.tick(TICK_MS);
      const stillFlying = arrows(session).some((f) => f.id === shot);
      const receipts = session.drainDamage();
      if (stillFlying) {
        expect(receipts).toHaveLength(0);
        ticksWithNoReceipt++;
        continue;
      }
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.outcome).toBe("hit");
      break;
    }

    expect(ticksWithNoReceipt).toBeGreaterThan(TICKS_IN_A_SECOND);
  });

  it("never takes more than the target has left when it finally lands", () => {
    const session = new GameSession(
      withBody(field(6), 4, 0, "dummy"),
      archerTilesFiring(SLOW_ARROW_CELLS_PER_SECOND),
    );
    const dummy = bodyOf(session, "dummy")!.id;
    fight(session, dummy);

    advanceUntil(session, () => arrows(session).length > 0);
    const shot = arrows(session)[0]!;
    session.setAttackMode(false);

    session.runCommand(`/health 1 ${dummy}`);
    session.drainDamage();

    advanceUntil(session, () => !arrows(session).some((f) => f.id === shot.id));

    const receipts = session.drainDamage().filter((receipt) => receipt.outcome === "hit");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.amount).toBe(1);
  });

  it("lands on a body that died mid-flight without saying anything", () => {
    const session = new GameSession(
      withBody(field(6), 4, 0, "dummy"),
      archerTilesFiring(SLOW_ARROW_CELLS_PER_SECOND),
    );
    const dummy = bodyOf(session, "dummy")!.id;
    fight(session, dummy);

    advanceUntil(session, () => arrows(session).length > 0);
    const shot = arrows(session)[0]!;
    session.setAttackMode(false);

    session.runCommand(`/health 0 ${dummy}`);
    session.drainDamage();
    expect(bodyOf(session, "dummy")).toBeUndefined();

    advanceUntil(session, () => !arrows(session).some((f) => f.id === shot.id));

    expect(session.drainDamage()).toHaveLength(0);
  });

  it("makes a slower arrow take its hit points later", () => {
    const shotLandsAfter = (cellsPerSecond: number) => {
      const session = new GameSession(
        withBody(field(6), 4, 0, "dummy"),
        archerTilesFiring(cellsPerSecond),
      );
      fight(session, bodyOf(session, "dummy")!.id);
      advanceUntil(session, () => arrows(session).length > 0);

      let waited = 0;
      advanceUntil(session, () => {
        if ((bodyOf(session, "dummy")!.hp ?? 0) < DUMMY_MAX_HP) return true;
        waited += TICK_MS;
        return false;
      });
      return waited;
    };

    expect(shotLandsAfter(SLOW_ARROW_CELLS_PER_SECOND)).toBeGreaterThan(
      shotLandsAfter(FAST_ARROW_CELLS_PER_SECOND),
    );
  });

  it("marks a shot hit only when the blow connected", () => {
    const session = new GameSession(
      withBody(field(6), 4, 0, "anvil"),
      archerTilesArmedWith(unreliableBow, SPARK),
      { seed: 7 },
    );
    fight(session, bodyOf(session, "anvil")!.id);

    let connected = 0;
    let missedOrDodged = 0;
    let inTheAir: { hit: boolean; remainingMs: number }[] = [];
    for (let elapsed = 0; elapsed < ENOUGH_SHOTS_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      const landed = session.drainDamage().some((receipt) => receipt.outcome === "hit");

      const arriving: typeof inTheAir = [];
      const stillFlying: typeof inTheAir = [];
      for (const shot of inTheAir) {
        shot.remainingMs -= TICK_MS;
        (shot.remainingMs <= 0 ? arriving : stillFlying).push(shot);
      }
      inTheAir = stillFlying;
      for (const shot of arriving) expect(shot.hit).toBe(landed);

      for (const flight of session.drainProjectiles()) {
        if (flight.hit) connected++;
        else missedOrDodged++;
        inTheAir.push({ hit: flight.hit, remainingMs: flight.durationMs });
      }
    }

    expect(connected).toBeGreaterThan(0);
    expect(missedOrDodged).toBeGreaterThan(0);
  });

  it("plays the hit on the body only where a shot that connected landed", () => {
    const session = new GameSession(
      withBody(field(6), 4, 0, "anvil"),
      archerTilesArmedWith(unreliableBow, SPARK),
      { seed: 7 },
    );
    const anvilId = bodyOf(session, "anvil")!.id;
    fight(session, anvilId);

    const struck: TileTransitionNote[] = [];
    let shots = 0;
    for (let elapsed = 0; elapsed < ENOUGH_SHOTS_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      shots += session.drainProjectiles().length;
      struck.push(...session.drainTransitions().filter((n) => n.struckBy));
    }

    expect(struck.length).toBeGreaterThan(0);
    expect(struck.every((note) => note.struckBy === "arrow")).toBe(true);
    expect(struck.every((note) => note.tileId === "anvil")).toBe(true);
    expect(struck.every((note) => note.side === "appear")).toBe(true);
    expect(struck.length).toBeLessThan(shots);
  });

  it("holds the target through a wall and fires nothing at it", () => {
    let map = withBody(field(6), 4, 0, "dummy");
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: WALL }]);
    const session = new GameSession(map, archerTilesWithWall);
    const dummyId = bodyOf(session, "dummy")!.id;
    fight(session, dummyId);

    advance(session, 1000);

    expect(session.getSnapshot().targetId).toBe(dummyId);
    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
    expect(arrows(session)).toHaveLength(0);
  });

  it("cannot shoot past the height its reach allows", () => {
    let map = field(6);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "dummy" }]);
    const session = new GameSession(map, archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.z).toBe(2);
    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
  });
});

describe("a bow and a knife", () => {
  const BOW = "belt-bow";
  const KNIFE = "belt-knife";

  const duellistTiles: TileDef[] = [
    arrowTile(),
    ...tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: PLAYER_TOUGHNESS },
                naturalWeapon: claws({
                  damage: feltBy(DUMMY_TOUGHNESS),
                  ...CERTAIN,
                }),
                kit: [
                  { slot: "weapon", tileId: BOW, chance: 100 },
                  { slot: "offhand", tileId: KNIFE, chance: 100 },
                ],
              },
            },
          })
        : t,
    ),
    tile({
      id: BOW,
      height: 0,
      intangible: true,
      kind: "item",
      interactions: {
        item: {
          type: "weapon",
          damage: feltBy(DUMMY_TOUGHNESS),
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "ranged",
          reach: { cells: 6, min: 2, height: HEIGHT_PER_LEVEL },
          projectile: "arrow",
        },
      },
    }),
    tile({
      id: KNIFE,
      height: 0,
      intangible: true,
      kind: "item",
      interactions: {
        item: {
          type: "weapon",
          damage: feltBy(DUMMY_TOUGHNESS),
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "sharp",
        },
      },
    }),
  ];

  const bowOnlyTiles: TileDef[] = duellistTiles.map((t) =>
    t.id === "player"
      ? tile({
          ...t,
          interactions: {
            battler: {
              baseHp: FIXTURE_BASE_HP,
              masteries: { toughness: PLAYER_TOUGHNESS },
              naturalWeapon: claws({
                damage: feltBy(DUMMY_TOUGHNESS),
                ...CERTAIN,
              }),
              kit: [{ slot: "weapon", tileId: BOW, chance: 100 }],
            },
          },
        })
      : t,
  );

  it("shoots at something across the yard", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), duellistTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntilShotLands(session);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });

  it("uses the knife on something in its face, and fires nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), duellistTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
    expect(arrows(session)).toHaveLength(0);
  });

  it("keeps swinging the knife rather than stalling on the bow's turn", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), duellistTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    expect(swingsOver(session, 1000)).toBeGreaterThan(1);
  });

  it("does not fall back to its fists when the only weapon is out of range", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), bowOnlyTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
    expect(arrows(session)).toHaveLength(0);
  });

  it("shoots once it has the room", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), bowOnlyTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntilShotLands(session);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });
});

describe("venom", () => {
  const catalogue = statusesById([
    {
      id: "venom",
      name: "Envenomed",
      description: "Something bit you.",
      tone: "bad",
      fromMs: 10_000,
      toMs: 10_000,
    },
  ]);

  const OWN_MS = 10_000;

  function statusesOn(session: GameSession, tileId: string) {
    const id = bodyOf(session, tileId)?.id;
    return (id ? (session.statusesOf(id) ?? []) : []).filter(
      (status) => status.defId !== COMBAT_STATUS_ID,
    );
  }

  it("lands on whoever was bitten, for as long as the bite asked", () => {
    const session = new GameSession(withBody(field(), 1, 0, "viper"), tiles, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "viper")!.id);

    advanceUntil(session, () =>
      (session.statusesOf("local") ?? []).some((s) => s.defId === "venom"),
    );

    const held = (session.statusesOf("local") ?? []).filter(
      (status) => status.defId !== COMBAT_STATUS_ID,
    );
    expect(held.map((status) => status.defId)).toEqual(["venom"]);
    expect(held[0]!.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(held[0]!.durationMs).toBeLessThanOrEqual(60_000);
  });

  it("says nothing about the body doing the biting", () => {
    const session = new GameSession(withBody(field(), 1, 0, "viper"), tiles, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "viper")!.id);

    advanceUntil(session, () =>
      (session.statusesOf("local") ?? []).some((s) => s.defId === "venom"),
    );

    expect(statusesOn(session, "viper")).toEqual([]);
  });

  it("comes with the weapon, not with the body swinging it", () => {
    const armedPlayer = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: PLAYER_TOUGHNESS },
                naturalWeapon: claws({ damage: 5, ...CERTAIN }),
                kit: [{ slot: "weapon", tileId: "venom-fang", chance: 100 }],
              },
            },
          })
        : t,
    );
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), armedPlayer, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => statusesOn(session, "dummy").length > 0);

    const held = statusesOn(session, "dummy");
    expect(held.map((status) => status.defId)).toEqual(["venom"]);
    expect(held[0]!.durationMs).toBe(OWN_MS);
  });

  it("is what the snake in data/tiles.json actually bites with", () => {
    const snake = normalizeTiles(tilesJson as unknown[]).find((t) => t.id === "snake");
    const bite = resolveBattler(snake!)!.naturalWeapon;
    expect(bite.statuses).toEqual([{ id: "poison", chance: 10, fromMs: 30_000, toMs: 60_000 }]);
    expect(statusesById(statusesJson as unknown[])).toHaveProperty("poison");
  });

  it("leaves an ordinary weapon leaving nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
    expect(statusesOn(session, "dummy")).toEqual([]);
  });
});

describe("what a swing costs in footwork", () => {
  const PLODDER_WALK_MS = WALK_DURATION_MS * 3;

  const recoveryOf = (walkMs: number) => walkMs * STRIKE_RECOVERY_STEPS;

  function ponderous(walkDurationMs?: number): TileDef[] {
    return tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            ...(walkDurationMs == null ? {} : { walkDurationMs }),
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: 92 },
                naturalWeapon: claws({ damage: 5, accuracy: 100, spd: 0 }),
              },
            },
          })
        : t,
    );
  }

  function quickHanded(walkDurationMs: number): TileDef[] {
    return tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            walkDurationMs,
            interactions: {
              battler: {
                baseHp: FIXTURE_BASE_HP,
                masteries: { toughness: 92 },
                naturalWeapon: claws({ damage: 5, ...CERTAIN }),
              },
            },
          })
        : t,
    );
  }

  function planted(defs: TileDef[]) {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), defs);
    fight(session, bodyOf(session, "anvil")!.id, PONDEROUS_WINDUP_MS);
    return session;
  }

  const PONDEROUS_WINDUP_MS = attackIntervalMs(0) * SWING_WINDUP_SHARE;

  it("refuses to start a step while the swinger is recovering", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.setInput({ directions: ["n"] });

    session.tick(TICK_MS);
    expect(self(session).strike).not.toBeNull();

    advance(session, PLODDER_WALK_MS - TICK_MS * 2);
    expect(self(session).walk).toBeNull();
    expect(self(session).y).toBe(0);
  });

  it("lets the step go the moment the recovery is spent", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.setInput({ directions: ["n"] });

    session.tick(TICK_MS);
    advance(session, recoveryOf(PLODDER_WALK_MS) + TICK_MS);

    expect(self(session).walk).not.toBeNull();
  });

  it("holds the step past the first of the two steps it costs", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.setInput({ directions: ["n"] });

    session.tick(TICK_MS);
    advance(session, PLODDER_WALK_MS + TICK_MS);

    expect(self(session).walk).toBeNull();
    expect(self(session).y).toBe(0);
  });

  it("plants a slow walker for longer than a quick one", () => {
    const quick = planted(ponderous());
    quick.setInput({ directions: ["n"] });
    quick.tick(TICK_MS);
    advance(quick, recoveryOf(WALK_DURATION_MS) + TICK_MS);

    const slow = planted(ponderous(PLODDER_WALK_MS));
    slow.setInput({ directions: ["n"] });
    slow.tick(TICK_MS);
    advance(slow, recoveryOf(WALK_DURATION_MS) + TICK_MS);

    expect(self(quick).walk).not.toBeNull();
    expect(self(slow).walk).toBeNull();
  });

  it("holds a planted body facing what it struck", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.tick(TICK_MS);
    expect(self(session).direction).toBe("e");

    session.setInput({ directions: ["n"] });
    session.tick(TICK_MS);

    expect(self(session).direction).toBe("e");
    expect(self(session).walk).toBeNull();
  });

  it("turns again the moment the recovery is spent", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.tick(TICK_MS);
    session.setAttackMode(false);

    session.setInput({ directions: ["n"] });
    advance(session, recoveryOf(PLODDER_WALK_MS) + TICK_MS);

    expect(self(session).direction).toBe("n");
  });

  it("never interrupts a walk already in flight", () => {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), ponderous(PLODDER_WALK_MS));
    session.setInput({ directions: ["n"] });
    session.tick(TICK_MS);
    expect(self(session).walk).not.toBeNull();

    fight(session, bodyOf(session, "anvil")!.id);
    advance(session, PLODDER_WALK_MS + TICK_MS);

    expect(self(session).y).toBe(-1);
  });

  it("keeps facing what it struck when the step it swung on lands", () => {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), quickHanded(PLODDER_WALK_MS));
    session.setInput({ directions: ["w"] });
    session.tick(TICK_MS);
    expect(self(session).walk).not.toBeNull();
    expect(self(session).direction).toBe("w");

    fight(session, bodyOf(session, "anvil")!.id);
    session.tick(TICK_MS);
    expect(self(session).direction).toBe("e");

    advance(session, PLODDER_WALK_MS + TICK_MS);
    expect(self(session).x).toBe(-1);
    expect(self(session).direction).toBe("e");
  });

  it("roots a fighter whose blows come round faster than it walks", () => {
    const session = planted(tiles);
    session.setInput({ directions: ["n"] });

    advance(session, attackIntervalMs(100) * 5);

    expect(self(session).y).toBe(0);
    expect(self(session).walk).toBeNull();
  });

  it("keeps the world awake for as long as somebody is planted", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.tick(TICK_MS);
    session.setAttackMode(false);
    session.setTarget(null);
    session.runCommand("/status clear");

    advance(session, STRIKE_DURATION_MS + TICK_MS * 2);
    expect(self(session).strike).toBeNull();
    expect(session.isAtRest()).toBe(false);

    advance(session, recoveryOf(PLODDER_WALK_MS));
    expect(session.isAtRest()).toBe(true);
  });
});

const SURROUNDING_CELLS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const ONE_ROUND_MS = MIN_ATTACK_TICKS * TICK_MS;

function surrounded(count: number) {
  const session = new GameSession(field(), tiles, {
    actorIds: ["me"],
    seed: 1,
  });
  session.setPvp(true, "me");
  const crowd = SURROUNDING_CELLS.slice(0, count).map(([x, y], index) => {
    const id = `mob-${index}`;
    session.spawn(id, { at: { x, y, z: 0 } });
    session.setTarget("me", id);
    session.setAttackMode(true, id);
    session.setPvp(true, id);
    return id;
  });
  return { session, crowd };
}

const hpOfMe = (session: GameSession) =>
  session.actorSnapshots().find((actor) => actor.id === "me")?.hp ?? 0;

describe("being outnumbered", () => {
  it("costs a body more per attacker the more of them there are", () => {
    const alone = surrounded(1);
    advance(alone.session, ONE_ROUND_MS * SURROUNDING_CELLS.length);
    const chipped = PLAYER_MAX_HP - hpOfMe(alone.session);

    const swarm = surrounded(SURROUNDING_CELLS.length);
    advance(swarm.session, ONE_ROUND_MS);
    const mauled = PLAYER_MAX_HP - hpOfMe(swarm.session);

    expect(chipped).toBeGreaterThan(0);
    expect(mauled).toBeGreaterThan(chipped);
  });

  it("opens a body up once a crowd is on it", () => {
    const { session } = surrounded(SURROUNDING_CELLS.length);

    advance(session, ONE_ROUND_MS);
    const hp = hpOfMe(session);
    expect(hp).toBeLessThan(PLAYER_MAX_HP);
    expect(hp).toBeGreaterThan(0);
  });

  it("gives the guard back once the crowd stops swinging", () => {
    const { session, crowd } = surrounded(SURROUNDING_CELLS.length);

    advance(session, ONE_ROUND_MS);
    for (const id of crowd.slice(1)) session.setAttackMode(false, id);
    advance(session, ONE_ROUND_MS + ASSAILANT_GRACE_MS);
    const settled = hpOfMe(session);

    advance(session, ONE_ROUND_MS * 4);
    const chipped = settled - hpOfMe(session);
    expect(settled).toBeGreaterThan(0);
    expect(chipped).toBeLessThan(PLAYER_MAX_HP - settled);
  });
});

describe("being in combat", () => {
  const ONE_SECOND_MS = 1000;

  function combatOn(session: GameSession, id: string): boolean {
    return (session.statusesOf(id) ?? []).some((status) => status.defId === COMBAT_STATUS_ID);
  }

  it("starts on the first swing, for the player and the body swung at", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummy = bodyOf(session, "dummy")!.id;
    fight(session, dummy);

    advanceUntil(session, () => session.inCombat("local"));

    expect(combatOn(session, "local")).toBe(true);
    expect(combatOn(session, dummy)).toBe(true);
  });

  it("runs out a minute after the last swing, and not before", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);
    advanceUntil(session, () => session.inCombat("local"));
    session.setAttackMode(false);

    advance(session, COMBAT_DURATION_MS - ONE_SECOND_MS);
    expect(session.inCombat("local")).toBe(true);
    advance(session, ONE_SECOND_MS * 2);
    expect(session.inCombat("local")).toBe(false);
  });
});

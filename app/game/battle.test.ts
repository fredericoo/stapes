import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { resolveBattler } from "../lib/battler";
import { ATTACKER_SELECTOR, resolveBrain, slot } from "../lib/brain";
import { conditionLeaves } from "../lib/conditions";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef, normalizeTiles } from "../lib/types";
import { attackIntervalMs, MIN_ATTACK_TICKS } from "./combat";
import { STRIKE_DURATION_MS, TICK_MS, WALK_DURATION_MS } from "./constants";
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

/**
 * A tile for a fight.
 *
 * Stats imply the kind here, which is the one place that inference is allowed:
 * `resolveBattler` gates on `kind` so the production path can never read a block
 * the select did not authorise, but a fixture that hands this function six stats
 * has said what it is as plainly as a fixture can. Spelling `kind: "battler"`
 * beside every `interactions.battler` in this file would be ceremony, not
 * coverage — the gate itself is asserted in `battler.test.ts`.
 *
 * Still overridable: a test that wants a stat block the kind refuses passes its
 * own `kind` and gets exactly that.
 */
function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  const interactions = partial.interactions as
    | { battler?: unknown }
    | undefined;
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: interactions?.battler ? "battler" : "prop",
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
        { action: "attack" as const, of: slot("foe") },
        { action: "hold" as const },
      ],
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

/**
 * Certain to hit, certain to hurt, and as fast as the rules allow.
 *
 * The key was `acc` until the field was renamed to `accuracy`, and a stale one
 * is silently dropped by the schema — so this spread nothing and every fixture
 * claiming to be certain was landing half its blows. Nothing failed, because
 * every assertion downstream was about *eventually* doing damage.
 */
const CERTAIN = { accuracy: 100, spd: 100 };

/**
 * A natural weapon, spelled out once.
 *
 * Every body has one now, and most of these fixtures only care about two of its
 * numbers — so the rest are defaulted here rather than repeated five times.
 */
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
    height: 2,
    directional: true,
    walkable: false,
    // Like every authored body: a thing that blocks light would shadow itself,
    // and would stand on its own shoulders when working out what it can see
    // over. @see ./sight
    lightPassing: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      // 92 Toughness is the hundred hit points these tests count in.
      battler: { masteries: { toughness: 92 }, naturalWeapon: claws({ damage: 5, ...CERTAIN }) },
    },
  }),
  // Hit points, no mind. What a target that cannot fight back looks like.
  tile({
    id: "dummy",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { masteries: { toughness: 42 }, naturalWeapon: claws({}) },
    },
  }),
  // Armoured past anything the player can do to it.
  tile({
    id: "anvil",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      // Defence is the weapon's, until there is armour to put it on.
      battler: { masteries: { toughness: 2 }, naturalWeapon: claws({ def: 99 }) },
    },
  }),
  tile({
    id: "brawler",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { masteries: { toughness: 22 }, naturalWeapon: claws({ damage: 3, ...CERTAIN }) },
      brain: brawlerBrain,
    },
  }),
  // A body with no battler block at all: swinging at it must fail, not throw.
  tile({ id: "statue", height: 1, actor: true, walkable: false }),
  // A bite that certainly poisons, so what is asserted below is the plumbing
  // rather than the odds — `./combat.test` owns the percentage itself.
  tile({
    id: "viper",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        masteries: { toughness: 22 },
        naturalWeapon: claws({
          damage: 1,
          ...CERTAIN,
          statuses: [{ id: "venom", chance: 100, fromMs: 30_000, toMs: 60_000 }],
        }),
      },
      brain: brawlerBrain,
    },
  }),
  // The same venom in something a player can pick up, which is the case that
  // comes free from routing a weapon's statuses through `FightingStats`.
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

/** The same body, one floor up, on a one-cell plinth so gravity leaves it there. */
function perched(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 1, [{ tileId: "grass" }, { tileId }]);
}

/**
 * Tick until something is true, or give up loudly.
 *
 * The bound is what makes this a test rather than a hang: a condition that never
 * arrives fails here instead of taking the run with it.
 */
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

/**
 * How many times the viewer swung, counted tick by tick.
 *
 * Per tick because a lean is aged and dropped as the world runs — a single look
 * at the end would see at most the last one.
 *
 * **The lean rather than the receipt, and it used to be the receipt.** A swing no
 * longer reliably produces one: a dodged blow is now a movement on the defender
 * and nothing floating at all, so a rate counted in receipts would come up short
 * one swing in twenty and fail on the unlucky run. Every swing thrown inside
 * arm's reach leans, which is what makes this the honest measure of *rate* — and
 * everything here fights at arm's reach.
 *
 * Identity, exactly as the wire counts them: the state is mutated in place as it
 * ages, so a new object is a new swing and nothing else is.
 */
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

/** The one actor standing in a body of this tile, if it is still on the board. */
function bodyOf(session: GameSession, tileId: string) {
  return session.actorSnapshots().find((actor) => actor.tileId === tileId);
}

function self(session: GameSession) {
  return session.getSnapshot().self;
}

/**
 * Pick a fight: point at somebody *and* mean it.
 *
 * Two calls rather than one because they are two decisions — a target alone is
 * somebody being watched, and attack mode is what turns it into blows. Nearly
 * every test below wants both, and the ones that deliberately do not say so.
 */
function fight(session: GameSession, actorId: string | null) {
  session.setTarget(actorId);
  session.setAttackMode(true);
}

describe("hit points", () => {
  it("start full, and only exist on a body that has stats", () => {
    const session = new GameSession(withBody(withBody(field(), 1, 0, "dummy"), 2, 0, "statue"), tiles);

    expect(self(session).hp).toBe(100);
    expect(self(session).maxHp).toBe(100);
    expect(bodyOf(session, "dummy")?.hp).toBe(DUMMY_MAX_HP);
    // Not zero: zero means dead, and this body cannot be either.
    expect(bodyOf(session, "statue")?.hp).toBeNull();
    expect(bodyOf(session, "statue")?.maxHp).toBeNull();
  });
});

/**
 * How long to swing for before a blow is certain enough to assert on.
 *
 * **Nothing in a fight is certain any more** — every probability is held inside
 * a band with a floor and a ceiling, so even a perfect attacker whiffs one swing
 * in twenty. These tests are about *reach and targeting*, not about the odds, so
 * they swing several times and assert that hit points moved. The arithmetic of a
 * single blow is `./combat.test`'s subject, where the stats can be forced.
 */
const ENOUGH_SWINGS_MS = TICK_MS * MIN_ATTACK_TICKS * 6;

/** What the punching bag starts at, so "it took damage" is one comparison. */
const DUMMY_MAX_HP = 50;

/**
 * Long enough to finish it off, with room for the swings that come to nothing.
 *
 * Generous rather than tight: the alternative is a test that fails once in a
 * while on an unlucky run of misses, which is worse than a test that takes an
 * extra simulated second.
 */
const LONG_ENOUGH_TO_KILL_MS = 8000;

describe("swinging at a target", () => {
  it("takes hit points off somebody standing beside you", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
  });

  /**
   * Diagonals are in reach. Excluding them would mean a creature on your
   * shoulder corner cannot be hit, which no player will read as a rule.
   */
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

  /**
   * The one case the plan alone cannot answer. A body on the plinth next door is
   * one cell away on the plan and is drawn a hand's width from the player's
   * shoulder — and is a whole level up, which at melee reach is out. See
   * `./distance`: reach is a disc *and* a lid, and melee's lid is half a level,
   * so a whole storey clears it however close the plan says the body is.
   */
  it("does nothing to somebody standing a floor up", () => {
    const session = new GameSession(perched(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.z).toBe(1);
    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
  });

  /** The rate is the stat's, not the tick loop's or the client's. */
  it("swings no faster than its speed allows", () => {
    const slowPlayer = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: { masteries: { toughness: 92 }, naturalWeapon: claws({ damage: 1, accuracy: 100 }) },
            },
          })
        : t,
    );
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), slowPlayer);
    fight(session, bodyOf(session, "dummy")!.id);

    const interval = attackIntervalMs(0);
    expect(swingsOver(session, interval - TICK_MS)).toBe(1);
    expect(swingsOver(session, TICK_MS * 2)).toBe(1);
  });

  it("turns to face what it is hitting", () => {
    const session = new GameSession(withBody(field(), 0, -1, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

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

/**
 * A target is who; attack mode is whether. Pointing at a creature is how a
 * player asks about one — its name, its health — and before these were separate
 * the only way to look that closely was to start a fight.
 */
describe("targeting without attacking", () => {
  it("keeps the target and never swings", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    session.setTarget(dummyId);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(DUMMY_MAX_HP);
    expect(session.getSnapshot().targetId).toBe(dummyId);
  });

  /**
   * And it costs the world nothing. A target used to hold the tick loop open on
   * its own, because a fight is a cooldown counting down; standing there
   * watching a deer must not keep a Durable Object awake for as long as you look
   * at it.
   */
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

    // Whatever the swinging came to, it stops here — asserted as "nothing moved
    // after", since what a run of swings took off is now a matter of luck.
    const settled = bodyOf(session, "dummy")!.hp!;
    session.setAttackMode(false);
    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBe(settled);
    expect(session.getSnapshot().targetId).toBe(dummyId);
  });

  /** What the outline colour is read from, and the world's answer rather than the page's. */
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

    // A receipt per swing, including the ones that came to nothing — that is
    // what makes a miss visible at all. Collected tick by tick, since each tick
    // starts with an empty page.
    const dealt: ReturnType<typeof session.drainDamage> = [];
    for (let elapsed = 0; elapsed < ENOUGH_SWINGS_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      dealt.push(...session.drainDamage());
    }

    const hits = dealt.filter((number) => number.outcome === "hit");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ amount: 5, x: 1, y: 0, z: 0 });
    // Drained means gone: a second reader would otherwise broadcast it twice.
    expect(session.drainDamage()).toHaveLength(0);
  });

  it("stay on screen for a viewer after the tick that produced them", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    fight(session, bodyOf(session, "dummy")!.id);

    // Until something actually floats, rather than for one tick: a dodged blow
    // is a movement now and produces no receipt, so the first swing is not
    // guaranteed to make one.
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

  /**
   * A dead actor is gone from the session entirely, which is what leaves a dead
   * player unable to do anything until they reload — the server drops every
   * message from an id it has no actor for.
   */
  it("leaves nothing behind to drive", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const dummyId = bodyOf(session, "dummy")!.id;
    fight(session, dummyId);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(() => session.requestStep(dummyId, "n")).toThrow();
  });
});

/**
 * Ticks until a lean would have to be over, with a tick of slack: a strike that
 * outlived this would still be up when its owner's fastest possible next blow
 * lands, which is the one thing {@link STRIKE_DURATION_MS} is chosen to prevent.
 */
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

  /**
   * The lean is a drawing and nothing else: the body it belongs to is standing
   * exactly where it stood, and is home again before it may swing a second time.
   */
  it("comes home without ever having moved", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles);
    const before = self(session);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, STRIKE_OVER_MS);

    const after = self(session);
    expect(after.strike).toBeNull();
    expect([after.x, after.y, after.z]).toEqual([before.x, before.y, before.z]);
  });

  /**
   * Every swing shows exactly one thing, and between them the two kinds of
   * showing account for all of it: a number floats, or the defender hops. The
   * anvil is armoured past anything the player can do to it and has no brain to
   * swing back with, so every lean on *it* is a dodge and every blow that got
   * through took nothing.
   */
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
      // Identity, exactly as the wire counts them: the state is mutated in
      // place as it ages, so a new object is a new blow and nothing else is.
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

    // East of the player, so away is further east.
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

  it("spooks the deer at whoever hit it", () => {
    const brain = resolveBrain(byId.deer!)!;
    const spook = brain.transitions.find((t) =>
      conditionLeaves(t.if).some((leaf) => leaf.cond === "attacked"),
    );
    expect(spook?.bind).toEqual({ spooked: ATTACKER_SELECTOR });
    expect(spook?.to).toBe("flee");
  });
});

/**
 * A body that shoots rather than swings.
 *
 * The reach is the interesting half — six cells across the floor and a level
 * either way — and it is on the *weapon*, which is the whole of what moved when
 * ranged weapons arrived. The projectile beside it is what makes it ranged;
 * there is no flag saying so. @see `../lib/item`'s `isRanged`
 */
const bow = claws({
  damage: 5,
  ...CERTAIN,
  mastery: "ranged" as const,
  reach: { cells: 6, height: HEIGHT_PER_LEVEL },
  projectile: { tileId: "arrow", cellsPerSecond: 20 },
});

const archerTiles: TileDef[] = tiles.map((t) =>
  t.id === "player"
    ? tile({
        ...t,
        interactions: {
          battler: { masteries: { toughness: 92, ranged: 50 }, naturalWeapon: bow },
        },
      })
    : t,
);

/** A wall that stops a look, and therefore a shot. Full height, opaque. */
const WALL = "wall";
const archerTilesWithWall: TileDef[] = [
  ...archerTiles,
  tile({ id: WALL, height: HEIGHT_PER_LEVEL, walkable: false }),
];

/** The flights the viewer can see, however far along they are. */
function arrows(session: GameSession) {
  return session.getSnapshot().projectiles;
}

describe("shooting at somebody", () => {
  /**
   * The point of a reach that is not an arm's length. Four cells is well past
   * anything melee can touch, and the blow lands anyway.
   */
  it("lands a blow far past arm's reach", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });

  /**
   * **The half-tile lean is a melee thing, and this is the case that says so.**
   * The target is the neighbouring cell — squarely inside the melee box — so a
   * gate written on distance alone would lean here. What decides is the weapon.
   */
  it("never leans, even at point-blank range", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, 1000);

    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
    expect(swingsOver(session, 1000)).toBe(0);
  });

  /** What a shot puts in the air, aimed from where the shooter is to where they are. */
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

  /**
   * **The damage is settled when the shot is loosed, not when the arrow lands.**
   * Hit points come off on the tick the flight begins — see `./projectile` for
   * why that is the only arrangement two clients can agree about.
   */
  it("takes the hit points before the arrow arrives", () => {
    const session = new GameSession(withBody(field(6), 4, 0, "dummy"), archerTiles);
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => arrows(session).length > 0);

    expect(arrows(session)[0]!.elapsedMs).toBeLessThan(
      arrows(session)[0]!.durationMs,
    );
    expect(bodyOf(session, "dummy")!.hp).toBeLessThan(DUMMY_MAX_HP);
  });

  /**
   * **A wall does not stop you pointing, only shooting.** The target stays
   * targeted — its name and its health bar are readable through a window you
   * cannot shoot through — and no blow lands and no arrow flies while the line
   * is broken. @see `./combat`'s `canReach`
   */
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

  /**
   * The lid on the reach, which is the half a single radius could never express:
   * six cells across the floor, and a body two storeys up is out however close
   * it is on the plan.
   */
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

/**
 * What a bite leaves behind once the hit points have moved.
 *
 * The odds are `./combat.test`'s subject; this is the plumbing around them — that
 * an inflicted status reaches the body that was bitten, that it is rolled inside
 * the range the weapon asked for rather than the status's own, and that a weapon
 * somebody picked up poisons exactly as the jaws it came out of did.
 */
describe("venom", () => {
  /**
   * A ten-second condition that does nothing, because nothing here is about what
   * a status *does*: `./statuses` owns cadence and expiry, and a venom that also
   * ticked damage would make every assertion below race the dying.
   */
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

  /** The venom's own range, so an override is visible as a different number. */
  const OWN_MS = 10_000;

  function statusesOn(session: GameSession, tileId: string) {
    const id = bodyOf(session, tileId)?.id;
    return id ? (session.statusesOf(id) ?? []) : [];
  }

  it("lands on whoever was bitten, for as long as the bite asked", () => {
    const session = new GameSession(withBody(field(), 1, 0, "viper"), tiles, {
      statuses: catalogue,
    });
    // The viper only fights back, so the player starts it — which is also what
    // makes the player the one carrying the venom at the end.
    fight(session, bodyOf(session, "viper")!.id);

    advanceUntil(session, () => (session.statusesOf("local") ?? []).length > 0);

    const held = session.statusesOf("local")!;
    expect(held.map((status) => status.defId)).toEqual(["venom"]);
    // The weapon's range, not the status's ten seconds — see `StatusGrant`.
    expect(held[0]!.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(held[0]!.durationMs).toBeLessThanOrEqual(60_000);
  });

  it("says nothing about the body doing the biting", () => {
    const session = new GameSession(withBody(field(), 1, 0, "viper"), tiles, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "viper")!.id);

    advanceUntil(session, () => (session.statusesOf("local") ?? []).length > 0);

    expect(statusesOn(session, "viper")).toEqual([]);
  });

  /**
   * The whole argument for carrying this on `FightingStats` rather than reading
   * it off the creature at the point of the swing: a fang taken off a snake is
   * as venomous in a hand as it was in a jaw, and nobody had to wire that up.
   */
  it("comes with the weapon, not with the body swinging it", () => {
    const armedPlayer = tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            interactions: {
              battler: {
                masteries: { toughness: 92 },
                naturalWeapon: claws({ damage: 5, ...CERTAIN }),
                kit: [{ slot: "weapon", tileId: "venom-fang", chance: 100 }],
              },
            },
          })
        : t,
    );
    const session = new GameSession(
      withBody(field(), 1, 0, "dummy"),
      armedPlayer,
      { statuses: catalogue },
    );
    fight(session, bodyOf(session, "dummy")!.id);

    advanceUntil(session, () => statusesOn(session, "dummy").length > 0);

    const held = statusesOn(session, "dummy");
    expect(held.map((status) => status.defId)).toEqual(["venom"]);
    // No override on the fang, so it runs for exactly what the status says.
    expect(held[0]!.durationMs).toBe(OWN_MS);
  });

  /**
   * The authored snake, against the authored catalogue.
   *
   * The two files are edited independently and nothing but this notices when
   * they stop agreeing: a renamed status leaves the bite reading as an effect
   * that never happens, which is the correct behaviour and an invisible one.
   */
  it("is what the snake in data/tiles.json actually bites with", () => {
    const snake = normalizeTiles(tilesJson as unknown[]).find(
      (t) => t.id === "snake",
    );
    const bite = resolveBattler(snake!)!.naturalWeapon;
    expect(bite.statuses).toEqual([
      { id: "poison", chance: 10, fromMs: 30_000, toMs: 60_000 },
    ]);
    expect(statusesById(statusesJson as unknown[])).toHaveProperty("poison");
  });

  /** Bare hands inflict nothing, which is every weapon in the world but a few. */
  it("leaves an ordinary weapon leaving nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "dummy"), tiles, {
      statuses: catalogue,
    });
    fight(session, bodyOf(session, "dummy")!.id);

    advance(session, ENOUGH_SWINGS_MS);

    expect(bodyOf(session, "dummy")!.hp!).toBeLessThan(DUMMY_MAX_HP);
    expect(statusesOn(session, "dummy")).toEqual([]);  });
});

/**
 * What a blow costs the body that threw it, in footwork.
 *
 * A fight used to be winnable by holding a movement key: the swinging is
 * automatic and cost nothing, so the strictly better way to fight was to never
 * stand still. Every blow now plants its thrower for exactly one of that body's
 * steps — read off the tile rather than from a constant, so a creature authored
 * to walk slowly is not punished twice for it, and off the tile rather than off
 * Agility, so it is the one thing in a fight nobody can train away.
 */
describe("what a swing costs in footwork", () => {
  /**
   * A body whose walking is slow enough to watch.
   *
   * Three steps' worth, and the length is what makes these readable rather than
   * a race with the tick: a recovery of one ordinary step is over in six ticks,
   * the same order as the lean and the cooldown it sits between.
   */
  const PLODDER_WALK_MS = WALK_DURATION_MS * 3;

  /**
   * A player who swings once and then not again for twenty seconds.
   *
   * Deliberately not {@link CERTAIN}'s speed. At 100 the blows come every
   * 200ms, which is a walk — so the second swing lands on the very tick the
   * first recovery expires and resets it, and what is under test here is one
   * recovery rather than the pile-up. That pile-up has a test of its own below.
   */
  function ponderous(walkDurationMs?: number): TileDef[] {
    return tiles.map((t) =>
      t.id === "player"
        ? tile({
            ...t,
            ...(walkDurationMs == null ? {} : { walkDurationMs }),
            interactions: {
              battler: {
                masteries: { toughness: 92 },
                naturalWeapon: claws({ damage: 5, accuracy: 100, spd: 0 }),
              },
            },
          })
        : t,
    );
  }

  /**
   * A fight against something nothing can get through.
   *
   * The anvil rather than the dummy, because these run for whole seconds and a
   * punching bag that died half way through would release the body under test:
   * a target that has left the world stops the swinging, and with it the thing
   * being measured.
   */
  function planted(defs: TileDef[]) {
    const session = new GameSession(withBody(field(), 1, 0, "anvil"), defs);
    fight(session, bodyOf(session, "anvil")!.id);
    return session;
  }

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
    advance(session, PLODDER_WALK_MS + TICK_MS);

    expect(self(session).walk).not.toBeNull();
  });

  /**
   * The recovery is the body's own step, not a constant. A slow walker planted
   * for a quick walker's step would be planted for a fraction of what a step
   * costs it, which is the fairness the whole rule turns on.
   */
  it("plants a slow walker for longer than a quick one", () => {
    const quick = planted(ponderous());
    quick.setInput({ directions: ["n"] });
    quick.tick(TICK_MS);
    advance(quick, WALK_DURATION_MS + TICK_MS);

    const slow = planted(ponderous(PLODDER_WALK_MS));
    slow.setInput({ directions: ["n"] });
    slow.tick(TICK_MS);
    advance(slow, WALK_DURATION_MS + TICK_MS);

    expect(self(quick).walk).not.toBeNull();
    expect(self(slow).walk).toBeNull();
  });

  /**
   * A blow costs the step, not the aim. Refusing the turn as well would leave a
   * cornered fighter unable to point anywhere but at what is already hitting
   * them.
   */
  it("still turns a planted body to face where it is asked to go", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.tick(TICK_MS);

    session.setInput({ directions: ["n"] });
    session.tick(TICK_MS);

    expect(self(session).direction).toBe("n");
    expect(self(session).walk).toBeNull();
  });

  /**
   * Only the *start* of a step is gated. A body cannot be stopped mid-cell
   * without leaving it standing between two of them, so a walk in flight when
   * the blow goes out finishes.
   */
  it("never interrupts a walk already in flight", () => {
    const session = new GameSession(
      withBody(field(), 1, 0, "anvil"),
      ponderous(PLODDER_WALK_MS),
    );
    session.setInput({ directions: ["n"] });
    session.tick(TICK_MS);
    expect(self(session).walk).not.toBeNull();

    fight(session, bodyOf(session, "anvil")!.id);
    advance(session, PLODDER_WALK_MS + TICK_MS);

    expect(self(session).y).toBe(-1);
  });

  /**
   * The end of the curve, stated so nobody has to rediscover it: a weapon whose
   * blows come round faster than its holder walks roots them for as long as
   * they keep swinging, because each recovery is reset before it runs out.
   *
   * Nothing authored is anywhere near it — the quickest natural weapon in
   * `data/tiles.json` is the rat's, at a blow every 867ms against a 150ms step
   * — and that gap is the room the rule leaves for footwork. Standing perfectly
   * still is what the *extreme* costs, not what a fight costs.
   */
  it("roots a fighter whose blows come round faster than it walks", () => {
    const session = planted(tiles);
    session.setInput({ directions: ["n"] });

    advance(session, attackIntervalMs(100) * 5);

    expect(self(session).y).toBe(0);
    expect(self(session).walk).toBeNull();
  });

  /**
   * The recovery is a clock this loop is the only thing winding, exactly as the
   * lean beside it is — and unlike the lean, it is holding a step somebody has
   * already asked for. A world that fell asleep under one would plant the body
   * until the next time anything happened to move.
   */
  it("keeps the world awake for as long as somebody is planted", () => {
    const session = planted(ponderous(PLODDER_WALK_MS));
    session.tick(TICK_MS);
    session.setAttackMode(false);
    session.setTarget(null);

    // Past the lean and past the blow's own paperwork, so what is left holding
    // the loop open is the recovery and nothing else.
    advance(session, STRIKE_DURATION_MS + TICK_MS * 2);
    expect(self(session).strike).toBeNull();
    expect(session.isAtRest()).toBe(false);

    advance(session, PLODDER_WALK_MS);
    expect(session.isAtRest()).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { resolveBattler } from "../lib/battler";
import { ATTACKER_SELECTOR, resolveBrain, slot } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import {
  attackIntervalMs,
  MIN_ATTACK_TICKS,
  REGEN_DELAY_MS,
  REGEN_FULL_MS,
} from "./combat";
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

/** Certain to hit, certain to hurt, and as fast as the rules allow. */
const CERTAIN = { acc: 100, spd: 100 };

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
  // Made to be hit for a long time without dying, which is the one thing a
  // fixture for *recovery* has to do: the window being tested is longer than any
  // real fight, and a body that died half way through would report the absence
  // of a corpse as the absence of healing. Toughness alone could not buy that —
  // a mastery stops at 100 — so most of it is armour, thick enough to turn the
  // player's five into a scratch.
  tile({
    id: "sandbag",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        masteries: { toughness: 100 },
        naturalWeapon: claws({ def: 3 }),
      },
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

/** The same body, one floor up, on a one-cell plinth so gravity leaves it there. */
function perched(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 1, [{ tileId: "grass" }, { tileId }]);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

/**
 * How many times anybody swung, drained tick by tick.
 *
 * Per tick because `tick` clears the pending receipts at the top of each one —
 * they are this tick's news, not a running total — so a single drain at the end
 * only ever sees the last tick.
 *
 * Swings rather than hit points, because a swing no longer reliably takes any:
 * every chance in a fight is held inside a band, so even a perfect attacker
 * whiffs one in twenty. A receipt is emitted whatever the swing came to, which
 * makes it the honest measure of *rate*.
 */
function swingsOver(session: GameSession, ms: number): number {
  let swings = 0;
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    swings += session.drainDamage().length;
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
    const session = new GameSession(
      withBody(withBody(field(), 1, 0, "dummy"), 2, 0, "statue"),
      tiles,
    );

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
   * `./distance`: height costs a cell a unit, so a level costs two, and one step
   * sideways plus a level comes to more than the melee sphere holds.
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
    const session = new GameSession(
      withBody(field(), 1, 0, "dummy"),
      slowPlayer,
    );
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
    fight(session, dummyId);

    advance(session, LONG_ENOUGH_TO_KILL_MS);

    expect(bodyOf(session, "dummy")).toBeUndefined();
    expect(session.actorIds()).not.toContain(dummyId);
    expect(session.drainDeaths()).toContain(dummyId);
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
    const retaliation = brain.transitions.find(
      (t) => t.if.cond === "attacked",
    );
    expect(retaliation?.bind).toEqual({ foe: ATTACKER_SELECTOR });
    expect(brain.states[retaliation!.to]?.do[0]).toEqual({
      action: "attack",
      of: slot("foe"),
    });
  });

  it("spooks the deer at whoever hit it", () => {
    const brain = resolveBrain(byId.deer!)!;
    const spook = brain.transitions.find((t) => t.if.cond === "attacked");
    expect(spook?.bind).toEqual({ spooked: ATTACKER_SELECTOR });
    expect(spook?.to).toBe("flee");
  });
});

/**
 * Knitting back up between fights.
 *
 * The fix for the thing the duel harness could never see: every ordering it
 * asserts is about *one* fight from full health, and the game is played as a
 * sequence of them. A fresh player beat a rat nine times in ten and finished on
 * two fifths of their health, with nothing on the map to drink and no way back —
 * so the honest answer to "how many rats can I kill" was one.
 *
 * Out of combat only, which is what lets it fix that without moving a single
 * number a fight is fought with.
 */
describe("recovering", () => {
  const SANDBAG_MAX_HP = 108;

  /** A sandbag that has been hit for a while, and the session hitting it. */
  function bloodied() {
    const session = new GameSession(withBody(field(), 1, 0, "sandbag"), tiles);
    fight(session, bodyOf(session, "sandbag")!.id);
    advance(session, 2000);
    const hurt = bodyOf(session, "sandbag")!.hp!;
    expect(hurt).toBeLessThan(SANDBAG_MAX_HP);
    return { session, hurt };
  }

  const sandbagHp = (session: GameSession) => bodyOf(session, "sandbag")!.hp;

  it("gives hit points back to a body left alone", () => {
    const { session } = bloodied();

    session.setAttackMode(false);
    advance(session, REGEN_DELAY_MS + REGEN_FULL_MS);

    expect(sandbagHp(session)).toBe(SANDBAG_MAX_HP);
  });

  /**
   * **Not while it is still being hit.** A body that knitted through a fight
   * would make an inaccurate attacker something to stand still in front of, and
   * a defensive stalemate a thing you win by waiting.
   */
  it("gives nothing back to a body still being swung at", () => {
    const { session, hurt } = bloodied();

    advance(session, REGEN_DELAY_MS + 2000);

    expect(sandbagHp(session)).toBeLessThan(hurt);
  });

  it("waits out the delay before anything knits", () => {
    const { session, hurt } = bloodied();

    session.setAttackMode(false);
    advance(session, REGEN_DELAY_MS - TICK_MS * 2);

    expect(sandbagHp(session)).toBe(hurt);
  });

  /**
   * A world that fell asleep mid-heal would leave whoever won the last fight
   * stuck at whatever it cost them until something else happened to wake it.
   */
  it("keeps the world awake until everybody is whole", () => {
    const { session } = bloodied();
    session.setAttackMode(false);
    session.setTarget(null);
    advance(session, 1000);

    expect(session.isAtRest()).toBe(false);

    advance(session, REGEN_DELAY_MS + REGEN_FULL_MS);
    expect(sandbagHp(session)).toBe(SANDBAG_MAX_HP);
    expect(session.isAtRest()).toBe(true);
  });
});

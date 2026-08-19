import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  xpForLevel,
} from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import type { AttackOutcome } from "./combat";
import { TICK_MS } from "./constants";
import {
  AGILITY_SHARE_OF_OFFENCE,
  attackerEarnings,
  defenderEarnings,
  defensiveDecay,
  DEFENSIVE_RECOVERY_MS,
  MIN_DEFENSIVE_DECAY,
  XP_PER_DAMAGE,
} from "./experience";
import { GameSession } from "./GameSession";

/**
 * What a fight teaches the bodies in it.
 *
 * Two halves, and they fail differently. The arithmetic below is a pure function
 * of one swing and is wrong in ways you can read; the session tests after it are
 * about the plumbing — that the experience reaches a player and never reaches a
 * rat, that it survives being carried back in, and that what it buys actually
 * shows up in the next blow. A curve that is perfect and wired to nothing is the
 * more likely of the two failures.
 */

const landed: AttackOutcome = {
  missed: false,
  dodged: false,
  damage: 10,
  potentialDamage: 10,
};
const dodged: AttackOutcome = {
  missed: false,
  dodged: true,
  damage: 0,
  potentialDamage: 10,
};
const missed: AttackOutcome = {
  missed: true,
  dodged: false,
  damage: 0,
  potentialDamage: 0,
};

const sword = {
  type: "weapon" as const,
  damage: 8,
  def: 0,
  spd: 50,
  accuracy: 85,
  variance: 30,
  mastery: "blade" as const,
  requirements: { blade: 5 },
};

describe("what a landed blow teaches the swinger", () => {
  it("pays the mastery the weapon answers to", () => {
    const earned = attackerEarnings(landed, sword, { blade: 5 }, 1);
    expect(earned.blade).toBeGreaterThan(0);
  });

  /**
   * Footwork. Without it the defensive mastery of a player who never gets hit
   * would be the one mastery they cannot practise.
   */
  it("pays agility a small share on top, rather than out of the same pot", () => {
    const earned = attackerEarnings(landed, sword, { blade: 5 }, 1);
    expect(earned.agility).toBeCloseTo(earned.blade! * AGILITY_SHARE_OF_OFFENCE, 10);
  });

  it("scales with the damage actually dealt", () => {
    const small = attackerEarnings({ ...landed, damage: 1 }, sword, { blade: 5 }, 1);
    const large = attackerEarnings({ ...landed, damage: 9 }, sword, { blade: 5 }, 1);
    expect(large.blade).toBeCloseTo(small.blade! * 9, 10);
  });

  it("pays nothing for a swing that went nowhere, or one that was avoided", () => {
    expect(attackerEarnings(missed, sword, { blade: 5 }, 1)).toEqual({});
    expect(attackerEarnings(dodged, sword, { blade: 5 }, 1)).toEqual({});
  });

  /**
   * The falloff, from the swinging end. A weapon you have outgrown keeps
   * teaching you and keeps teaching you less — see `learningRate`, and the
   * deadlock the old wall produced.
   */
  it("fades once the wielder has outgrown the weapon", () => {
    const met = attackerEarnings(landed, sword, { blade: 5 }, 1);
    const outgrown = attackerEarnings(landed, sword, { blade: 50 }, 1);
    expect(outgrown.blade).toBeLessThan(met.blade!);
    expect(outgrown.blade).toBeGreaterThan(0);
  });

  /**
   * The other direction is not discounted here and must not be: a weapon far
   * above you already pays less by landing fewer blows, and charging twice for
   * the same difficulty is what deadlocked the wall.
   */
  it("does not also discount a weapon that outclasses the wielder", () => {
    const novice = attackerEarnings(landed, sword, { blade: 0 }, 1);
    const met = attackerEarnings(landed, sword, { blade: 5 }, 1);
    expect(novice.blade).toBe(met.blade);
  });

  /** Agility's share is footwork, not weapon handling, so the falloff misses it. */
  it("leaves agility's share alone however outgrown the weapon is", () => {
    const met = attackerEarnings(landed, sword, { blade: 5 }, 1);
    const outgrown = attackerEarnings(landed, sword, { blade: 50 }, 1);
    expect(outgrown.agility).toBe(met.agility);
  });
});

describe("what a blow teaches the body it was aimed at", () => {
  it("pays toughness for one that landed", () => {
    expect(defenderEarnings(landed, 1, 1)).toEqual({
      toughness: landed.potentialDamage * XP_PER_DAMAGE,
    });
  });

  it("pays agility for one that was avoided, and nothing to toughness", () => {
    expect(defenderEarnings(dodged, 1, 1)).toEqual({
      agility: dodged.potentialDamage * XP_PER_DAMAGE,
    });
  });

  /**
   * **The decision the plan left open, settled the other way.** The hit chance
   * is the attacker's weapon and the attacker's mastery and nothing else — the
   * defender contributes not one term to it — so paying them for a miss would be
   * paying Agility for something Agility did not do.
   */
  it("pays nobody for a swing that missed", () => {
    expect(defenderEarnings(missed, 1, 1)).toEqual({});
  });

  /**
   * Potential rather than actual on both rows, so that the day armour halves
   * what reaches you it does not also halve what you learn from wearing it. On a
   * dodge it is the only measure there is of what was escaped.
   */
  it("counts what the blow could have been rather than what got through", () => {
    const absorbed: AttackOutcome = { ...landed, damage: 1, potentialDamage: 10 };
    expect(defenderEarnings(absorbed, 1, 1)).toEqual({
      toughness: absorbed.potentialDamage * XP_PER_DAMAGE,
    });
  });
});

describe("per-target diminishing returns", () => {
  it("is worth full rate the first time and less every time after", () => {
    expect(defensiveDecay(0)).toBe(1);
    expect(defensiveDecay(1)).toBeLessThan(defensiveDecay(0));
    expect(defensiveDecay(10)).toBeLessThan(defensiveDecay(1));
  });

  /**
   * A floor rather than zero: a fight that has genuinely gone long is still a
   * fight, and a payout that reached exactly nothing would make a hard drawn-out
   * win worth less than a short easy one.
   */
  it("never falls to nothing however long the fight has gone", () => {
    expect(defensiveDecay(1000)).toBe(MIN_DEFENSIVE_DECAY);
  });
});

/**
 * The plumbing.
 *
 * A board, two bodies, and a fight allowed to run — the same path a session
 * takes, because the arithmetic above proves nothing about whether anything
 * calls it.
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
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const claws = (fields: Record<string, unknown>) => ({
  type: "weapon" as const,
  damage: 3,
  def: 0,
  accuracy: 90,
  variance: 20,
  spd: 90,
  mastery: "fist" as const,
  ...fields,
});

/**
 * Both sides rated alike, so the reward curve pays about the plain rate and
 * these tests are about the plumbing rather than about the curve.
 *
 * Tough far past anything on the real ladder, because a fixture has one job a
 * creature does not: stand there trading blows for the whole length of a test. A
 * body that dies half way through stops having experience at all, and every
 * delta after that reads as a mastery going backwards.
 */
const EVENLY_MATCHED = { fist: 20, toughness: 95, agility: 20 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: { masteries: EVENLY_MATCHED, naturalWeapon: claws({}) },
    },
  }),
  // Rated with the player and durable enough to be hit all day. No brain: what
  // is being measured is what a fight pays, not who decides to have one.
  tile({
    id: "sparring-partner",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: { masteries: EVENLY_MATCHED, naturalWeapon: claws({}) },
    },
  }),
  // Swings constantly and cannot connect: its weapon finds nothing, so almost
  // every blow is a miss rather than a dodge.
  tile({
    id: "flailer",
    height: 1,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        masteries: EVENLY_MATCHED,
        naturalWeapon: claws({ accuracy: 0 }),
      },
    },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

function withBody(map: MapFile, x: number, tileId: string): MapFile {
  return replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

/** The player, and something standing next to them, already fighting. */
function sparring(opponent = "sparring-partner", seed = 1) {
  const session = new GameSession(withBody(field(), 1, opponent), tiles, { actorIds: ["me"], seed: seed });
  const foe = session.actorIds().find((id) => id !== "me")!;
  session.setTarget(foe, "me");
  session.setAttackMode(true, "me");
  return { session, foe };
}

/**
 * The same board with the swinging the other way round, for the two rows of the
 * table a defender is paid on. Neither fixture has a brain, so who is attacking
 * whom is set here and stays set.
 */
function beingHit(opponent = "sparring-partner") {
  const { session, foe } = sparring(opponent);
  session.setAttackMode(false, "me");
  session.setTarget("me", foe);
  session.setAttackMode(true, foe);
  return { session, foe };
}

const learnt = (xp: MasteryXp | null, mastery: Mastery) => xp?.[mastery] ?? 0;

describe("a player earns from the fights they have", () => {
  /**
   * The seeding, which is the one place the authored block and the earned one
   * meet. A point lost here is a player who starts below what the tile says, and
   * it would never be noticed — it looks exactly like the tile having been
   * authored that way.
   */
  it("starts out knowing exactly what the tile says they know", () => {
    const { session } = sparring();
    session.setAttackMode(false, "me");

    // Nothing has asked yet, so nothing has been seeded: the numbers appear the
    // first time somebody needs a body to fight with, and asking for a ⭐ is
    // asking for one.
    expect(session.masteryXpOf("me")).toBeNull();
    session.ratingIn("me");

    for (const mastery of MASTERIES) {
      const authored = (EVENLY_MATCHED as Partial<Record<Mastery, number>>)[mastery] ?? 0;
      expect(levelForXp(learnt(session.masteryXpOf("me"), mastery))).toBe(authored);
    }
  });

  it("climbs the mastery it is swinging with", () => {
    const { session } = sparring();
    advance(session, TICK_MS);
    const before = learnt(session.masteryXpOf("me"), "fist");

    advance(session, 4000);
    expect(learnt(session.masteryXpOf("me"), "fist")).toBeGreaterThan(before);
  });

  it("climbs toughness by being hit, without ever swinging", () => {
    const { session } = beingHit();
    advance(session, TICK_MS);
    // Copied, because what the session hands back is the live block — a
    // reference held across the fight would read as nothing having happened.
    const before = { ...session.masteryXpOf("me") };
    const swung = learnt(before, "fist");

    advance(session, 4000);
    const after = session.masteryXpOf("me")!;
    expect(learnt(after, "toughness")).toBeGreaterThan(learnt(before, "toughness"));
    // Toughness is what being hit teaches, and it is the only thing it teaches:
    // a body that earned Fist for standing there would be paid for the fight it
    // did not have.
    expect(learnt(after, "fist")).toBe(swung);
  });

  /**
   * A creature never improves, which is the other half of "masteries are earned
   * by players and fixed on creatures". Nothing writes to a rat, so there is no
   * runtime number for a long fight to move.
   */
  it("teaches the creature on the other side nothing at all", () => {
    const { session, foe } = sparring();
    advance(session, 6000);

    expect(session.masteryXpOf(foe)).toBeNull();
    expect(session.ratingIn(foe)).toBe(session.ratingIn(foe));
  });

  /**
   * What experience is *for*. A mastery that climbed and changed nothing about
   * the next blow would be a number in a save file.
   */
  it("shows up in the body the next blow is fought with", () => {
    const { session } = sparring();
    const before = session.ratingIn("me")!;

    // Enough to buy several points outright, handed over rather than ground out
    // — the grind is the previous test's business.
    session.spawn("veteran", {
      at: { x: -1, y: 0, z: 0 },
      earned: { fist: xpForLevel(60), toughness: xpForLevel(60) },
    });
    expect(session.ratingIn("veteran")!).toBeGreaterThan(before);
  });
});

describe("what a fight is worth is paced", () => {
  /**
   * The decay, end to end. The tenth blow from the same rat has to be worth less
   * than the first, or standing still is a strategy.
   */
  it("pays less for each further blow from the same attacker", () => {
    const { session, foe } = beingHit();

    advance(session, 3000);
    const early = learnt(session.masteryXpOf("me"), "toughness");
    advance(session, 3000);
    const late = learnt(session.masteryXpOf("me"), "toughness");
    advance(session, 3000);
    const later = learnt(session.masteryXpOf("me"), "toughness");

    expect(early).toBeGreaterThan(0);
    expect(late - early).toBeLessThan(early);
    expect(later - late).toBeLessThan(late - early);
  });

  /**
   * And recovers, so that coming back tomorrow is a fresh fight. Long enough
   * never to fire mid-fight, short enough that a real break is a real reset.
   */
  it("forgives payouts once the attacker has left off", () => {
    const { session, foe } = beingHit();

    advance(session, 4000);
    const worn = learnt(session.masteryXpOf("me"), "toughness");

    session.setAttackMode(false, foe);
    advance(session, DEFENSIVE_RECOVERY_MS * 4);
    expect(learnt(session.masteryXpOf("me"), "toughness")).toBe(worn);

    session.setAttackMode(true, foe);
    advance(session, 2000);
    const afterRest = learnt(session.masteryXpOf("me"), "toughness") - worn;

    session.setAttackMode(false, foe);
    advance(session, 100);
    session.setAttackMode(true, foe);
    advance(session, 2000);
    const withoutRest =
      learnt(session.masteryXpOf("me"), "toughness") - worn - afterRest;

    expect(afterRest).toBeGreaterThan(withoutRest);
  });

  /** A miss is the attacker's failure and pays nobody, on a real board. */
  it("teaches a body nothing from being swung at and missed", () => {
    const { session } = beingHit("flailer");

    advance(session, 200);
    const before = learnt(session.masteryXpOf("me"), "agility");
    advance(session, 3000);

    // Five percent of swings land whatever the weapon is — nothing in a fight is
    // certain — so this is "almost nothing", not "nothing".
    const earned = learnt(session.masteryXpOf("me"), "agility") - before;
    expect(earned).toBeLessThan(1);
  });
});

/**
 * What reaches the panel.
 *
 * The arithmetic above and the plumbing before it are both invisible without
 * this: a mastery that climbs and never leaves the session is a number in a save
 * file. What is asserted here is the two contracts the drawing side depends on —
 * that the block is on the snapshot at all, and that its *identity* changes when
 * it moves.
 */
describe("what the viewer is shown", () => {
  it("puts the viewer's own experience on their snapshot", () => {
    const { session } = sparring();
    advance(session, TICK_MS);

    const snapshot = session.getSnapshot("me");
    expect(learnt(snapshot.masteryXp, "fist")).toBeGreaterThan(0);
  });

  /**
   * **Identity is the change signal**, on exactly the terms the kit's is: the
   * renderer hands the block to React only when the reference differs, so a
   * block edited in place would be the same object on every frame and a progress
   * bar that never advanced.
   */
  it("hands over a different block once anything has been learnt", () => {
    const { session } = sparring();
    advance(session, TICK_MS);
    const before = session.getSnapshot("me").masteryXp;

    advance(session, 4000);
    expect(session.getSnapshot("me").masteryXp).not.toBe(before);
  });

  it("leaves the block alone on a tick where nobody learnt anything", () => {
    const { session } = sparring();
    session.setAttackMode(false, "me");
    advance(session, TICK_MS);
    const before = session.getSnapshot("me").masteryXp;

    advance(session, 2000);
    expect(session.getSnapshot("me").masteryXp).toBe(before);
  });

  /**
   * ⭐ rides on the body everybody can see, unlike the masteries under it —
   * sizing a creature up before swinging at it is the whole point of the number,
   * and one you could only learn by losing would be no use.
   */
  it("shows every body's ⭐ beside its hit points", () => {
    const { session, foe } = sparring();
    advance(session, TICK_MS);

    for (const actor of session.getSnapshot("me").actors) {
      expect(actor.rating).toBeGreaterThan(0);
      // Null exactly when hp is, so anything drawing one can key off the other.
      expect(actor.rating === null).toBe(actor.hp === null);
    }
    expect(session.ratingIn(foe)).toBeGreaterThan(0);
  });
});

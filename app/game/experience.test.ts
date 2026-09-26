import { describe, expect, it } from "vitest";
import { type BattlerDef, DEFAULT_BASE_HP, defFrom } from "../lib/battler";
import { MELEE_REACH } from "../lib/item";
import shippedTiles from "../../data/tiles.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import { levelForXp, MASTERIES, type Mastery, type MasteryXp, xpForLevel } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import type { AttackOutcome } from "./combat";
import { guardBand } from "./combat";
import { effectiveBattler, emptyEquipment } from "./equipment";
import { TICK_MS } from "./constants";
import {
  AGILITY_SHARE_OF_OFFENCE,
  attackerEarnings,
  defenderEarnings,
  defensiveDecay,
  DEFENSIVE_RECOVERY_MS,
  MIN_DEFENSIVE_DECAY,
  SIGNIFICANT_THREAT_SHARE,
  threatRate,
  XP_PER_DAMAGE,
} from "./experience";
import { GameSession } from "./GameSession";
import { FRAME, tile as baseTile } from "../lib/testTile";

const landed: AttackOutcome = {
  missed: false,
  dodged: false,
  damage: 10,
  potentialDamage: 10,
  inflicted: [],
};
const dodged: AttackOutcome = {
  missed: false,
  dodged: true,
  damage: 0,
  potentialDamage: 10,
  inflicted: [],
};
const missed: AttackOutcome = {
  missed: true,
  dodged: false,
  damage: 0,
  potentialDamage: 0,
  inflicted: [],
};

const FRAIL_HP = 10 / SIGNIFICANT_THREAT_SHARE;

const sword = {
  type: "weapon" as const,
  damage: 8,
  def: 0,
  spd: 50,
  accuracy: 85,
  variance: 30,
  reach: MELEE_REACH,
  mastery: "sharp" as const,
  requirements: { sharp: 5 },
};

const FLAT = () => 1;

describe("what a landed blow teaches the swinger", () => {
  it("pays the mastery the weapon answers to", () => {
    const earned = attackerEarnings(landed, sword, FLAT);
    expect(earned.sharp).toBeGreaterThan(0);
  });

  it("pays agility a small share on top, rather than out of the same pot", () => {
    const earned = attackerEarnings(landed, sword, FLAT);
    expect(earned.agility).toBeCloseTo(earned.sharp! * AGILITY_SHARE_OF_OFFENCE, 10);
  });

  it("scales with the damage actually dealt", () => {
    const small = attackerEarnings({ ...landed, damage: 1 }, sword, FLAT);
    const large = attackerEarnings({ ...landed, damage: 9 }, sword, FLAT);
    expect(large.sharp).toBeCloseTo(small.sharp! * 9, 10);
  });

  it("pays nothing for a swing that went nowhere, or one that was avoided", () => {
    expect(attackerEarnings(missed, sword, FLAT)).toEqual({});
    expect(attackerEarnings(dodged, sword, FLAT)).toEqual({});
  });

  it("pays the same rate whatever the weapon asks of its wielder", () => {
    const outgrown = attackerEarnings(landed, { ...sword, requirements: { sharp: 1 } }, FLAT);
    const met = attackerEarnings(landed, sword, FLAT);
    expect(outgrown.sharp).toBe(met.sharp);
    expect(outgrown.agility).toBe(met.agility);
  });

  it("does not discount a weapon that outclasses the wielder", () => {
    const requirementless = attackerEarnings(landed, { ...sword, requirements: undefined }, FLAT);
    const demanding = attackerEarnings(landed, { ...sword, requirements: { sharp: 90 } }, FLAT);
    expect(demanding.sharp).toBe(requirementless.sharp);
  });
});

describe("what a blow teaches the body it was aimed at", () => {
  it("pays toughness for one that landed", () => {
    expect(defenderEarnings(landed, 1, 1, FRAIL_HP)).toEqual({
      toughness: landed.potentialDamage * XP_PER_DAMAGE,
    });
  });

  it("pays agility for one that was avoided, and nothing to toughness", () => {
    expect(defenderEarnings(dodged, 1, 1, FRAIL_HP)).toEqual({
      agility: dodged.potentialDamage * XP_PER_DAMAGE,
    });
  });

  it("pays nobody for a swing that missed", () => {
    expect(defenderEarnings(missed, 1, 1, FRAIL_HP)).toEqual({});
  });

  it("counts what the blow could have been rather than what got through", () => {
    const absorbed: AttackOutcome = { ...landed, damage: 1, potentialDamage: 10 };
    expect(defenderEarnings(absorbed, 1, 1, FRAIL_HP)).toEqual({
      toughness: absorbed.potentialDamage * XP_PER_DAMAGE,
    });
  });

  it("pays less the less of you one blow could take off", () => {
    const felt = defenderEarnings(landed, 1, 1, FRAIL_HP);
    const shrugged = defenderEarnings(landed, 1, 1, FRAIL_HP * 4);
    expect(shrugged.toughness).toBeLessThan(felt.toughness!);
    expect(shrugged.toughness).toBeGreaterThan(0);
  });

  it("applies the same falloff to a dodge", () => {
    const felt = defenderEarnings(dodged, 1, 1, FRAIL_HP);
    const shrugged = defenderEarnings(dodged, 1, 1, FRAIL_HP * 4);
    expect(shrugged.agility).toBeLessThan(felt.agility!);
  });

  it("never pays more than the plain rate, however frail the body", () => {
    expect(threatRate(10, 1)).toBe(1);
    expect(threatRate(10, FRAIL_HP)).toBe(1);
    expect(threatRate(10, FRAIL_HP * 2)).toBeLessThan(1);
  });
});

describe("what the defender is wearing", () => {
  const tilesById: Record<string, TileDef> = Object.fromEntries(
    (shippedTiles as unknown as TileDef[]).map((tile) => [tile.id, normalizeTileDef(tile)]),
  );
  const body: BattlerDef = {
    baseHp: DEFAULT_BASE_HP,
    masteries: { toughness: 20, agility: 10, fist: 5 },
    naturalWeapon: {
      type: "weapon",
      damage: 4,
      def: 0,
      accuracy: 80,
      variance: 20,
      spd: 50,
      mastery: "fist",
      reach: { ...MELEE_REACH },
    },
    sight: { up: 0, down: 0 },
  };
  const instance = (tileId: string) => ({ id: tileId, tileId });
  const armoured = {
    ...emptyEquipment(),
    offhand: instance("iron-shield"),
    armor: instance("steel-plate"),
    head: instance("knights-helm"),
    footwear: instance("steel-sabatons"),
  };

  const bare = effectiveBattler(body, null, tilesById, null);
  const plated = effectiveBattler(body, armoured, tilesById, null);

  it("is actually being worn, or the rest of this proves nothing", () => {
    expect(plated.def).toBeGreaterThan(bare.def);
  });

  it("changes nothing about how big the body is", () => {
    expect(plated.maxHp).toBe(bare.maxHp);
  });

  it("pays exactly the same toughness for the same blow", () => {
    expect(defenderEarnings(landed, 1, 1, plated.maxHp)).toEqual(
      defenderEarnings(landed, 1, 1, bare.maxHp),
    );
  });
});

describe("per-target diminishing returns", () => {
  it("is worth full rate the first time and less every time after", () => {
    expect(defensiveDecay(0)).toBe(1);
    expect(defensiveDecay(1)).toBeLessThan(defensiveDecay(0));
    expect(defensiveDecay(10)).toBeLessThan(defensiveDecay(1));
  });

  it("never falls to nothing however long the fight has gone", () => {
    expect(defensiveDecay(1000)).toBe(MIN_DEFENSIVE_DECAY);
  });
});

function tile(partial: Record<string, unknown> & Pick<TileDef, "id" | "height">): TileDef {
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return baseTile({
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const SPARRING_TOUGHNESS = 95;

const SPARRING_GUARD = guardBand(
  { def: defFrom(SPARRING_TOUGHNESS), resist: {} },
  { mastery: "fist" },
);

const claws = (fields: Record<string, unknown>) => ({
  type: "weapon" as const,
  damage: SPARRING_GUARD.lowest + 3,
  def: 0,
  accuracy: 90,
  variance: 20,
  spd: 90,
  mastery: "fist" as const,
  ...fields,
});

const EVENLY_MATCHED = { fist: 20, toughness: SPARRING_TOUGHNESS, agility: 20 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: { baseHp: 8, masteries: EVENLY_MATCHED, naturalWeapon: claws({}) },
    },
  }),
  tile({
    id: "sparring-partner",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: { baseHp: 8, masteries: EVENLY_MATCHED, naturalWeapon: claws({}) },
    },
  }),
  tile({
    id: "flailer",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 8,
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
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return map;
}

function withBody(map: MapFile, x: number, tileId: string): MapFile {
  return replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function ratingOf(session: GameSession, id: string): number | null {
  return session.actorSnapshots().find((a) => a.id === id)?.rating ?? null;
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

function sparring(opponent = "sparring-partner", seed = 1) {
  const session = new GameSession(withBody(field(), 1, opponent), tiles, {
    actorIds: ["me"],
    seed: seed,
  });
  const foe = session.actorIds().find((id) => id !== "me")!;
  session.setTarget(foe, "me");
  session.setAttackMode(true, "me");
  return { session, foe };
}

function beingHit(opponent = "sparring-partner") {
  const { session, foe } = sparring(opponent);
  session.setAttackMode(false, "me");
  session.setTarget("me", foe);
  session.setAttackMode(true, foe);
  return { session, foe };
}

const learnt = (xp: MasteryXp | null, mastery: Mastery) => xp?.[mastery] ?? 0;

describe("a player earns from the fights they have", () => {
  it("starts out knowing exactly what the tile says they know", () => {
    const { session } = sparring();
    session.setAttackMode(false, "me");

    expect(session.masteryXpOf("me")).toBeNull();
    ratingOf(session, "me");

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
    const before = { ...session.masteryXpOf("me") };
    const swung = learnt(before, "fist");

    advance(session, 4000);
    const after = session.masteryXpOf("me")!;
    expect(learnt(after, "toughness")).toBeGreaterThan(learnt(before, "toughness"));
    expect(learnt(after, "fist")).toBe(swung);
  });

  it("teaches the creature on the other side nothing at all", () => {
    const { session, foe } = sparring();
    advance(session, 6000);

    expect(session.masteryXpOf(foe)).toBeNull();
  });

  it("shows up in the body the next blow is fought with", () => {
    const { session } = sparring();
    const before = ratingOf(session, "me")!;

    session.spawn("veteran", {
      at: { x: -1, y: 0, z: 0 },
      earned: { fist: xpForLevel(60), toughness: xpForLevel(60) },
    });
    expect(ratingOf(session, "veteran")!).toBeGreaterThan(before);
  });
});

describe("what a fight is worth is paced", () => {
  it("pays less for each further blow from the same attacker", () => {
    const { session } = beingHit();

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
    const withoutRest = learnt(session.masteryXpOf("me"), "toughness") - worn - afterRest;

    expect(afterRest).toBeGreaterThan(withoutRest);
  });

  it("teaches a body nothing from being swung at and missed", () => {
    const { session } = beingHit("flailer");

    advance(session, 200);
    const before = learnt(session.masteryXpOf("me"), "agility");
    advance(session, 3000);

    const earned = learnt(session.masteryXpOf("me"), "agility") - before;
    expect(earned).toBeLessThan(1);
  });
});

describe("what the viewer is shown", () => {
  it("puts the viewer's own experience on their snapshot", () => {
    const { session } = sparring();
    advance(session, TICK_MS);

    const snapshot = session.getSnapshot("me");
    expect(learnt(snapshot.masteryXp, "fist")).toBeGreaterThan(0);
  });

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

  it("shows every body's ⭐ beside its hit points", () => {
    const { session, foe } = sparring();
    advance(session, TICK_MS);

    for (const actor of session.getSnapshot("me").actors) {
      expect(actor.rating).toBeGreaterThan(0);
      expect(actor.rating === null).toBe(actor.hp === null);
    }
    expect(ratingOf(session, foe)).toBeGreaterThan(0);
  });
});

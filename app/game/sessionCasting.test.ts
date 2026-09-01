import { describe, expect, it } from "vitest";
import { maxHpFrom } from "../lib/battler";
import type { ItemInstance } from "../lib/itemInstance";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { learningRate, masteryLevel } from "../lib/mastery";
import { statusesById } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { casterEarnings, XP_PER_DAMAGE } from "./experience";
import { GameSession } from "./GameSession";
import type { SlotRef } from "./itemMoves";

/**
 * Casting, from the outside.
 *
 * What a player would notice, and never how it was arrived at: a stone answers
 * or it does not, a cooldown is spent whatever came of it, a cooling stone will
 * not come out of its square, and a flame somebody lit pays them when it burns
 * a rat. The one claim that spans placement, status and experience gets an
 * end-to-end case rather than three unit ones, on the terms the session suites
 * drive a fight tick by tick.
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

function stoneTile(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "stone", ...item } },
  });
}

const PLAYER_TOUGHNESS = 40;
const PLAYER_MAX_HP = maxHpFrom(PLAYER_TOUGHNESS);
const RAT_TOUGHNESS = 40;

/** A minute, which is what the shipped necklace costs and is easy to count in. */
const HEAL_COOLDOWN_MS = 60_000;
const HEAL_HP = 10;

/** Fixed ends, so a rolled burn is a constant and the arithmetic below is exact. */
const BURN_MS = 4_000;
const BURN_PER_SECOND = 4;

/**
 * A body, optionally born carrying things.
 *
 * The kit is how a stone reaches a square in these cases, and it is the honest
 * path: `battlerKit` is what puts a sword in a guard's hand and a stone in an
 * arcanist's, so a test that reached past it would be exercising an arrangement
 * the world cannot produce.
 *
 * The natural weapon is authored to hit nothing — no accuracy, one damage — so
 * that a creature standing next to the player never lands a blow and never pays
 * anybody experience. Every figure asserted below is the spell's alone.
 */
function body(
  id: string,
  toughness: number,
  extra: Record<string, unknown> = {},
  kit: Array<{ slot: string; tileId: string }> = [],
) {
  return tile({
    id,
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 0,
          variance: 0,
          spd: 1,
          mastery: "fist",
        },
        ...(kit.length
          ? { kit: kit.map((entry) => ({ ...entry, chance: 100 })) }
          : {}),
      },
    },
    ...extra,
  });
}

/** Everything but the player, whose kit differs from case to case. */
const props: TileDef[] = [
  tile({ id: "grass" }),
  body("rat", RAT_TOUGHNESS, { actor: true }),
  stoneTile("life-stone", {
    effect: { kind: "heal", hp: HEAL_HP },
    cooldownMs: HEAL_COOLDOWN_MS,
  }),
  stoneTile("flame-stone", {
    effect: { kind: "conjure", tileId: "conjured-flame" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 1 },
  }),
  stoneTile("adept-stone", {
    effect: { kind: "heal", hp: HEAL_HP },
    cooldownMs: 10_000,
    requirements: { arcane: 10 },
  }),
  stoneTile("brand-stone", {
    effect: { kind: "status", on: "target", id: "burned" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 1 },
  }),
  stoneTile("scorch-stone", {
    effect: { kind: "status", on: "caster", id: "burned" },
    cooldownMs: 10_000,
  }),
  tile({
    id: "conjured-flame",
    intangible: true,
    lightPassing: true,
    interactions: {
      addStatus: { trigger: "step", statusId: "burned" },
      decay: { tileId: "", fromMs: 8_000, toMs: 8_000 },
    },
  }),
];

/** The catalogue a body born carrying `kit` is simulated against. */
function catalogueWith(kit: Array<{ slot: string; tileId: string }>): TileDef[] {
  return [...props, body("player", PLAYER_TOUGHNESS, {}, kit)];
}

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: false,
    maxMs: BURN_MS,
    everyMs: 1_000,
    effects: { hp: `0 - ${BURN_PER_SECOND}` },
  },
]);

/** A strip of clear floor with the player at the origin, facing east. */
function world(width = 6): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  for (let x = 1; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  return map;
}

type Square = "weapon" | "offhand" | "charm";

/**
 * A world with a player born carrying these stones.
 *
 * The kit rather than a hand-built {@link Equipment}, so every case starts from
 * a body the world could actually have produced.
 */
function session(
  carrying: Partial<Record<Square, string>> = {},
  map: MapFile = world(),
): GameSession {
  const kit = (Object.entries(carrying) as Array<[Square, string]>).map(
    ([slot, tileId]) => ({ slot, tileId }),
  );
  return new GameSession(map, catalogueWith(kit), { statuses: catalogue });
}

/** Wind a stone forward by hand, for a case about what happens while it cools. */
function cool(play: GameSession, square: Square, cooldownMs: number) {
  play.cast(square);
  const kit = play.equipmentOf("local")!;
  const held = kit[square]!;
  Object.assign(held, { cooldownMs });
}

function run(play: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) play.tick(TICK_MS);
}

/** One second of simulated time, which is the grain a cooldown moves in. */
const TICKS_PER_SECOND = Math.ceil(1000 / TICK_MS);

function hpOf(play: GameSession, id = "local"): number | null {
  return play.actorSnapshots().find((a) => a.id === id)?.hp ?? null;
}

function coolingIn(play: GameSession, square: "weapon" | "offhand" | "charm") {
  return play.equipmentOf("local")?.[square]?.cooldownMs;
}

function ratAt(play: GameSession, at: Coord): string {
  const stack = getStack(play.getMap(), at.x, at.y, at.z);
  const placed = stack.find((p) => p.tileId === "rat");
  return placed?.owner ?? "";
}

function spawnRat(map: MapFile, at: Coord): MapFile {
  return replaceStack(map, at.x, at.y, at.z, [
    { tileId: "grass" },
    { tileId: "rat", direction: "w", owner: `npc:${at.x},${at.y},${at.z}` },
  ]);
}

describe("spending a cooldown", () => {
  it("puts the stone on its full cooldown the moment it is cast", () => {
    const play = session({ charm: "life-stone" });
    play.runCommand("/health 10");
    play.drainNotices();

    expect(play.cast("charm")).toBe(true);
    expect(coolingIn(play, "charm")).toBe(HEAL_COOLDOWN_MS);
  });

  /**
   * Story 39, and the same bargain a swing is under: the cost of casting must
   * not depend on luck. Pressing a heal at full health accomplishes nothing and
   * still costs the minute.
   */
  it("spends it even when the spell did nothing at all", () => {
    const play = session({ charm: "life-stone" });

    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(play.cast("charm")).toBe(true);
    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(coolingIn(play, "charm")).toBe(HEAL_COOLDOWN_MS);
  });

  it("refuses a second cast until the stone is ready", () => {
    const play = session({ charm: "life-stone" });
    play.cast("charm");
    expect(play.cast("charm")).toBe(false);
  });

  it("counts a full cooldown down second by second", () => {
    const play = session({ charm: "life-stone" });
    play.cast("charm");
    expect(coolingIn(play, "charm")).toBe(HEAL_COOLDOWN_MS);

    run(play, TICKS_PER_SECOND);
    expect(coolingIn(play, "charm")).toBe(HEAL_COOLDOWN_MS - 1_000);
    run(play, TICKS_PER_SECOND * 3);
    expect(coolingIn(play, "charm")).toBe(HEAL_COOLDOWN_MS - 4_000);
  });

  it("winds down a second per second and clears when it is ready", () => {
    const play = session({ charm: "life-stone" });
    cool(play, "charm", 2_000);

    run(play, TICKS_PER_SECOND);
    expect(coolingIn(play, "charm")).toBe(1_000);
    run(play, TICKS_PER_SECOND);
    // Absent rather than zero: ready is the absence of a cooldown everywhere.
    expect(coolingIn(play, "charm")).toBeUndefined();
    expect(play.cast("charm")).toBe(true);
  });

  /**
   * A world nobody is ticking must not quietly cool, and one that *is* ticking
   * must not fall asleep under a countdown only it winds. The same clause decay
   * and an arrow in the air are under.
   */
  it("keeps the world awake while anything is cooling", () => {
    const play = session({ charm: "life-stone" });
    expect(play.isAtRest()).toBe(true);

    play.cast("charm");
    expect(play.isAtRest()).toBe(false);
  });
});

describe("a cooling stone is locked in its square", () => {
  const BAG: SlotRef = { kind: "contents", index: 0 };

  function armed(): GameSession {
    const play = session({ charm: "life-stone" });
    play.cast("charm");
    play.drainNotices();
    return play;
  }

  it("cannot be moved out of its square", () => {
    const play = armed();
    expect(play.moveItem({ kind: "charm" }, { kind: "weapon" })).toBe(false);
    expect(play.equipmentOf("local")?.charm?.tileId).toBe("life-stone");
  });

  it("cannot be put down on the floor", () => {
    const play = armed();
    expect(play.drop({ kind: "charm" }, { x: 1, y: 0, z: 0 })).toBe(false);
    expect(play.equipmentOf("local")?.charm?.tileId).toBe("life-stone");
  });

  it("is refused even before a destination is considered", () => {
    const play = armed();
    expect(play.canMoveItem({ kind: "charm" }, BAG)).toBe(false);
    expect(play.canDrop({ kind: "charm" }, { x: 1, y: 0, z: 0 })).toBe(false);
  });

  /**
   * Story 11: being unable to move a thing must not read as the interface being
   * broken. It is the only refusal in the item model that says anything at all.
   */
  it("says why, rather than refusing in silence", () => {
    const play = armed();
    play.moveItem({ kind: "charm" }, { kind: "weapon" });
    const said = play.drainNotices();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/cooling/i);
  });

  it("comes out freely once it is ready", () => {
    const play = session({ charm: "life-stone" });
    cool(play, "charm", 1_000);
    run(play, TICKS_PER_SECOND);
    expect(play.moveItem({ kind: "charm" }, { kind: "weapon" })).toBe(true);
    expect(play.equipmentOf("local")?.weapon?.tileId).toBe("life-stone");
  });

  /**
   * Story 38, and the other half of the rule: the lock is on what a *player*
   * does. A death drops the whole kit regardless, so a cooling stone never
   * clings to a corpse.
   */
  it("drops with the rest of the kit when its owner dies", () => {
    const play = armed();
    play.runCommand("/health 0");
    const deaths = play.drainDeaths();
    expect(deaths).toHaveLength(1);

    // Nothing still owed: the whole kit reached the floor.
    expect(deaths[0]!.equipment.charm).toBeNull();
    expect(getStack(play.getMap(), 0, 0, 0).map((p) => p.tileId)).toContain(
      "life-stone",
    );
  });

  /** And the stone that lands is ready, because a placement carries no clock. */
  it("lands ready, since a cooldown never rides a placement", () => {
    const play = armed();
    play.runCommand("/health 0");
    play.drainDeaths();

    const placed = getStack(play.getMap(), 0, 0, 0).find(
      (p) => p.tileId === "life-stone",
    );
    expect(placed).toBeDefined();
    expect(placed as Record<string, unknown>).not.toHaveProperty("cooldownMs");
  });

  /** The lock is about the stone. Everything else on the body still moves. */
  it("leaves the rest of the kit alone", () => {
    const play = session({ charm: "life-stone", weapon: "brand-stone" });
    play.cast("charm");
    play.drainNotices();
    expect(play.moveItem({ kind: "weapon" }, { kind: "offhand" })).toBe(true);
  });
});

describe("what casting earns", () => {
  /** The plain rate, before any learning falloff. */
  const rate = (amount: number) => XP_PER_DAMAGE * amount;

  it("pays for the health a heal actually restored", () => {
    const play = session({ charm: "life-stone" });
    play.runCommand("/health 1");
    play.drainNotices();

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    play.cast("charm");
    const after = play.masteryXpOf("local")?.arcane ?? 0;
    expect(after - before).toBeCloseTo(rate(HEAL_HP), 6);
  });

  /**
   * Story 25. A heal at full health restores nothing, so it teaches nothing —
   * which is what makes "measured as the health you were missing" a rule rather
   * than a rounding.
   */
  it("pays nothing for a heal at full health", () => {
    const play = session({ charm: "life-stone" });

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    play.cast("charm");
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBe(before);
  });

  it("pays only for the health that was missing, never the whole amount", () => {
    const play = session({ charm: "life-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP - 3}`);
    play.drainNotices();

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    play.cast("charm");
    expect((play.masteryXpOf("local")?.arcane ?? 0) - before).toBeCloseTo(
      rate(3),
      6,
    );
  });

  /**
   * Story 24. Setting yourself on fire is not training, so the burn a caster put
   * on their own body pays them nothing at all.
   */
  it("pays nothing for damage a caster does to themselves", () => {
    const play = session({ charm: "scorch-stone" });

    play.cast("charm");
    const before = play.masteryXpOf("local")?.arcane ?? 0;
    // Long enough for the burn to pay out several times over.
    run(play, TICKS_PER_SECOND * 3);
    expect(hpOf(play)).toBeLessThan(PLAYER_MAX_HP);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBe(before);
  });
});

describe("casterEarnings", () => {
  it("pays nothing for nothing", () => {
    expect(casterEarnings(0, undefined, {}, 1)).toEqual({});
    expect(casterEarnings(-4, undefined, {}, 1)).toEqual({});
  });

  it("pays arcane and nothing else", () => {
    expect(Object.keys(casterEarnings(5, undefined, {}, 1))).toEqual(["arcane"]);
  });

  /**
   * The same falloff a weapon's is under: a stone you have outgrown keeps paying
   * and keeps paying less.
   */
  it("scales by the stone's own requirement, exactly as a weapon does", () => {
    const masteries = { arcane: 40 };
    const earned = casterEarnings(5, { arcane: 10 }, masteries, 1).arcane!;
    const expected =
      XP_PER_DAMAGE * 5 * learningRate(masteryLevel(masteries, "arcane"), 10);
    expect(earned).toBeCloseTo(expected, 6);
  });

  it("pays at full rate for a stone that asks nothing", () => {
    expect(casterEarnings(5, undefined, { arcane: 40 }, 1).arcane).toBeCloseTo(
      XP_PER_DAMAGE * 5,
      6,
    );
  });
});

describe("conjuring", () => {
  it("places the tile in front of the caster when nothing is targeted", () => {
    const play = session({ weapon: "flame-stone" });

    expect(play.cast("weapon")).toBe(true);
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).toContain(
      "conjured-flame",
    );
  });

  it("places it at the target's cell instead, when there is one", () => {
    const play = session(
      { weapon: "flame-stone" },
      spawnRat(world(), { x: 3, y: 0, z: 0 }),
    );
    play.setTarget(ratAt(play, { x: 3, y: 0, z: 0 }));

    expect(play.cast("weapon")).toBe(true);
    expect(getStack(play.getMap(), 3, 0, 0).map((p) => p.tileId)).toContain(
      "conjured-flame",
    );
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).not.toContain(
      "conjured-flame",
    );
  });

  it("marks the placement with whoever cast it", () => {
    const play = session({ weapon: "flame-stone" });
    play.cast("weapon");

    const placed = getStack(play.getMap(), 1, 0, 0).find(
      (p) => p.tileId === "conjured-flame",
    );
    expect(placed?.castBy).toBe("local");
    // Never the field that says whose *body* this is — that lookup is what finds
    // a connection's actor.
    expect(placed?.owner).toBeUndefined();
  });

  it("goes out on its own", () => {
    const play = session({ weapon: "flame-stone" });
    play.cast("weapon");

    run(play, TICKS_PER_SECOND * 9);
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).not.toContain(
      "conjured-flame",
    );
  });
});

/**
 * Story 26, end to end: a caster conjures, something else walks into it and
 * burns, and the caster earns. It is the one claim that spans a placement, a
 * status and the experience ledger, so it is worth driving through the session
 * rather than asserting three times in three modules.
 */
describe("a flame you conjured, burning somebody else", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function litWorld(): GameSession {
    const play = session({ weapon: "flame-stone" }, spawnRat(world(), RAT_CELL));
    play.setTarget(ratAt(play, RAT_CELL));
    play.cast("weapon");
    play.drainNotices();
    return play;
  }

  it("burns whoever is standing in it", () => {
    const play = litWorld();
    const rat = ratAt(play, RAT_CELL);
    const before = hpOf(play, rat)!;
    run(play, TICKS_PER_SECOND * 2);
    expect(hpOf(play, rat)!).toBeLessThan(before);
  });

  it("pays the arcanist who lit it", () => {
    const play = litWorld();
    const before = play.masteryXpOf("local")?.arcane ?? 0;
    run(play, TICKS_PER_SECOND * 2);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBeGreaterThan(before);
  });

  /**
   * And nothing else does. A burn nobody cast behaves exactly as it did before
   * any of this existed, which is the property the whole attribution scheme has
   * to leave alone — so the same status, started by something with no caster
   * behind it, burns just as hard and pays nobody a thing.
   */
  it("leaves an unattributed burn paying nobody", () => {
    const play = session({}, spawnRat(world(), RAT_CELL));
    const rat = ratAt(play, RAT_CELL);
    play.runCommand(`/status burned ${rat}`);
    play.drainNotices();

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    run(play, TICKS_PER_SECOND * 2);
    expect(hpOf(play, rat)!).toBeLessThan(maxHpFrom(RAT_TOUGHNESS));
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBe(before);
  });
});

describe("a status cast at somebody", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  it("lands on the target and pays for what it burns", () => {
    const play = session({ weapon: "brand-stone" }, spawnRat(world(), RAT_CELL));
    const rat = ratAt(play, RAT_CELL);
    play.setTarget(rat);

    expect(play.cast("weapon")).toBe(true);
    expect((play.statusesOf(rat) ?? []).map((s) => s.defId)).toEqual(["burned"]);

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    run(play, TICKS_PER_SECOND * 2);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBeGreaterThan(before);
  });

  it("refuses to fire with nobody targeted, and costs nothing", () => {
    const play = session({ weapon: "brand-stone" });
    expect(play.cast("weapon")).toBe(false);
    expect(coolingIn(play, "weapon")).toBeUndefined();
  });
});

describe("a stone above the caster's mastery", () => {
  /**
   * Story 27: a powerful stone is a thing to work towards, and refusing outright
   * is what makes that legible — a weapon half-understood swings badly, and a
   * spell that fired at a third strength would be a thing a player has to
   * measure to learn about.
   */
  it("refuses to fire, and spends nothing", () => {
    const play = session({ charm: "adept-stone" });

    expect(play.cast("charm")).toBe(false);
    expect(coolingIn(play, "charm")).toBeUndefined();
  });

  it("fires once the mastery is earned", () => {
    const play = session({ charm: "adept-stone" });
    play.runCommand("/mastery arcane 10");
    play.drainNotices();

    expect(play.cast("charm")).toBe(true);
  });
});

describe("the row the session reports", () => {
  it("is empty for a body carrying nothing", () => {
    expect(session().spells()).toEqual([]);
  });

  it("names every stone that can be pressed, in square order", () => {
    const play = session({ offhand: "life-stone", charm: "flame-stone" });
    expect(play.spells().map((spell) => spell.square)).toEqual([
      "offhand",
      "charm",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { defFrom, maxHpFrom } from "../lib/battler";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import {
  learningRate,
  masteriesFromXp,
  masteryLevel,
  xpForLevel,
} from "../lib/mastery";
import { statusesById } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import {
  casterEarnings,
  practiceEarnings,
  XP_PER_CAST,
  XP_PER_DAMAGE,
} from "./experience";
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
const MEND_COOLDOWN_MS = 60_000;
const MEND_HP = 10;

/** What the shipped Stone of Light costs, and the clock the floor cases run on. */
const WARD_COOLDOWN_MS = 30_000;

/**
 * What a bolt is authored at, and what one body wears against it.
 *
 * The resistance is deliberately less than the damage, so a warded body takes a
 * smaller blow rather than none — the interesting case, since "nothing gets
 * through" is indistinguishable from a bolt that never fired.
 */
const BOLT_DAMAGE = 20;
const BOLT_RESIST = 5;

/**
 * What a rat turns aside on its own, which every figure below is measured
 * through.
 *
 * Read out of the same function the fight reads it from rather than written
 * down, because it is not what these cases are about: what they are about is
 * that a bolt goes through `damageAfterDefence` at all, and a number typed here
 * would be a second answer to a question `../lib/battler` already owns.
 */
const RAT_DEF = defFrom(RAT_TOUGHNESS);

/** What a bolt of {@link BOLT_DAMAGE} actually takes off a plain rat. */
const BOLT_THROUGH = BOLT_DAMAGE - RAT_DEF;

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
  /**
   * What this body is *made of*, for the cases the wheel is about.
   *
   * Authored on the battler, never a mastery: what a body has practised says
   * what it can cast, and what it is made of says what magic does to it.
   */
  elements: string[] = [],
) {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness },
        ...(elements.length ? { elements } : {}),
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

/**
 * A rat that would dodge anything, for the one thing a bolt does not have.
 *
 * Agility is what a swing is contested against, and a cast is not aimed — so a
 * body that escapes every blow in the world still takes a bolt in full. Written
 * by patching the block rather than by widening {@link body}, because it is the
 * only case in this file that wants a second mastery.
 */
function nimbleRat(): TileDef {
  const rat = body("nimble-rat", RAT_TOUGHNESS, { actor: true });
  const battler = rat.interactions!.battler as { masteries: object };
  battler.masteries = { ...battler.masteries, agility: 100 };
  return rat;
}

/** Everything but the player, whose kit differs from case to case. */
const props: TileDef[] = [
  tile({ id: "grass" }),
  body("rat", RAT_TOUGHNESS, { actor: true }),
  // Three rats that are made of something, so the wheel has somewhere to turn.
  // Their toughness is the plain rat's, so the only thing that differs between
  // the burns below is which side of the wheel each one is on.
  body("nature-rat", RAT_TOUGHNESS, { actor: true }, [], ["nature"]),
  body("water-rat", RAT_TOUGHNESS, { actor: true }, [], ["water"]),
  body("even-rat", RAT_TOUGHNESS, { actor: true }, [], [
    "fire",
    "water",
    "nature",
  ]),
  // Neutral in itself, and born wearing something that is not — the equipped
  // half of what a body counts as.
  body("robed-rat", RAT_TOUGHNESS, { actor: true }, [
    { slot: "armor", tileId: "tunic-of-brambles" },
  ]),
  // The same tunic in the bag rather than on the body, which must count for
  // nothing: what is in a bag is in a bag.
  body("packing-rat", RAT_TOUGHNESS, { actor: true }, [
    { slot: "bag", tileId: "satchel" },
  ]),
  // A rat in mail warded against magic, and one that is simply hard to hit: the
  // two halves a bolt treats differently, since a cast is mitigated and never
  // dodged.
  body("mailed-rat", RAT_TOUGHNESS, { actor: true }, [
    { slot: "armor", tileId: "warding-mail" },
  ]),
  // And one warded deeper than any bolt below is worth, for the case where
  // nothing gets through at all.
  body("walled-rat", RAT_TOUGHNESS, { actor: true }, [
    { slot: "armor", tileId: "walling-mail" },
  ]),
  nimbleRat(),
  stoneTile("mend-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
  }),
  stoneTile("flame-stone", {
    effect: { kind: "conjure", tileId: "conjured-flame" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  // A bolt that harms, thrown with no variance so every case below is exact,
  // and with something in the air so the flight has somewhere to be asserted.
  stoneTile("bolt-stone", {
    effect: {
      kind: "bolt",
      damage: BOLT_DAMAGE,
      on: "target",
      projectile: { tileId: "arcane-mote", cellsPerSecond: 14 },
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  // Both halves in one cast, which is the combination the merged arm exists for.
  stoneTile("brand-bolt-stone", {
    effect: {
      kind: "bolt",
      damage: BOLT_DAMAGE,
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  // The same brand with the roll switched off, so "rolled per cast" is a claim
  // rather than a coincidence.
  stoneTile("dud-brand-stone", {
    effect: {
      kind: "bolt",
      damage: BOLT_DAMAGE,
      on: "target",
      statuses: [{ id: "burned", chance: 0 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  // The same bolt made of fire, for the one thing the wheel turns on.
  stoneTile("ember-bolt-stone", {
    effect: { kind: "bolt", damage: BOLT_DAMAGE, on: "target" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { fire: 1 },
  }),
  // A rat in mail, and mail with an opinion about magic: a bolt answers to
  // Arcane, so this is what a warded body turns aside.
  tile({
    id: "warding-mail",
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: {
      item: { type: "armor", def: 0, resist: { arcane: BOLT_RESIST } },
    },
  }),
  tile({
    id: "arcane-mote",
    type: "directional8",
    lightPassing: true,
    intangible: true,
  }),
  tile({
    id: "walling-mail",
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: {
      item: { type: "armor", def: 0, resist: { arcane: BOLT_DAMAGE * 2 } },
    },
  }),
  stoneTile("adept-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: 10_000,
    requirements: { arcane: 10 },
  }),
  stoneTile("brand-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 4 },
  }),
  // The same brand, made of fire. Its Fire requirement is the one point every
  // body starts with, which is what makes an element reachable at all.
  stoneTile("ember-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { fire: 1 },
  }),
  stoneTile("tide-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { water: 1 },
  }),
  // Two elements at once, to check both are trained and both are weighed.
  stoneTile("storm-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { fire: 1, water: 1 },
  }),
  tile({
    id: "tunic-of-brambles",
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "armor", def: 0, elements: ["nature"] } },
  }),
  tile({
    id: "satchel",
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: {
      item: { type: "container", size: 2, equippable: true },
    },
  }),
  stoneTile("ember-flame-stone", {
    effect: { kind: "conjure", tileId: "conjured-flame" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { fire: 1 },
  }),
  // The scorch stone, made of fire: a burn a caster puts on themselves, which
  // is the only way to reach a body whose masteries a command can move.
  stoneTile("ember-self-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    requirements: { fire: 1 },
  }),
  stoneTile("scorch-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
  }),
  // The shipped Stone of Light's shape: it asks nothing, reaches nobody, and
  // does nothing a number can measure. The case the flat fee exists for.
  stoneTile("ward-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      statuses: [{ id: "warded", chance: 100 }],
    },
    cooldownMs: WARD_COOLDOWN_MS,
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
  return [...props, playerTile(kit)];
}

/**
 * The player, carrying `kit` and made of nothing.
 *
 * **No authored `elements`, exactly as the shipped `player` tile has none**: a
 * player is neutral until they put something on. The element *masteries* below
 * are a different field answering a different question — they are what lets the
 * bottom rung of each element be cast at all.
 */
function playerTile(kit: Array<{ slot: string; tileId: string }>): TileDef {
  const tile = body("player", PLAYER_TOUGHNESS, {}, kit);
  const battler = tile.interactions!.battler as { masteries: object };
  battler.masteries = { ...battler.masteries, ...STARTING_MASTERIES };
  return tile;
}

/**
 * The element masteries every body starts level with, as the `player` tile does.
 *
 * The one point apiece is what makes the bottom rung of each element castable —
 * a stone asking Fire 1 is where Fire comes from, and a body with none of it
 * could never have thrown the spell that would have earned it.
 */
const STARTING_MASTERIES = { fire: 1, water: 1, nature: 1 };

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
  {
    id: "warded",
    name: "Warded",
    description: "Lit, and nothing more.",
    tone: "good",
    fromMs: 60_000,
    toMs: 60_000,
    // Nothing periodic and nothing modified, exactly as the shipped "luminous"
    // is: what it does is drawn rather than counted, which is what makes a
    // caster holding one earn nothing for the outcome.
    everyMs: 0,
    effects: {},
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

function spawnRat(map: MapFile, at: Coord, tileId = "rat"): MapFile {
  return replaceStack(map, at.x, at.y, at.z, [
    { tileId: "grass" },
    { tileId, direction: "w", owner: `npc:${at.x},${at.y},${at.z}` },
  ]);
}

/** Whichever body is standing here, by the owner the spawn stamped on it. */
function bodyAt(play: GameSession, at: Coord, tileId = "rat"): string {
  const stack = getStack(play.getMap(), at.x, at.y, at.z);
  return stack.find((p) => p.tileId === tileId)?.owner ?? "";
}

describe("spending a cooldown", () => {
  it("puts the stone on its full cooldown the moment it is cast", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 10");
    play.drainNotices();

    expect(play.cast("charm")).toBe(true);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);
  });

  /**
   * Story 39, and the same bargain a swing is under: the cost of casting must
   * not depend on luck. Pressing a mend at full health accomplishes nothing and
   * still costs the minute.
   */
  it("spends it even when the spell did nothing at all", () => {
    const play = session({ charm: "mend-stone" });

    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(play.cast("charm")).toBe(true);
    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);
  });

  it("refuses a second cast until the stone is ready", () => {
    const play = session({ charm: "mend-stone" });
    play.cast("charm");
    expect(play.cast("charm")).toBe(false);
  });

  it("counts a full cooldown down second by second", () => {
    const play = session({ charm: "mend-stone" });
    play.cast("charm");
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);

    run(play, TICKS_PER_SECOND);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS - 1_000);
    run(play, TICKS_PER_SECOND * 3);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS - 4_000);
  });

  it("winds down a second per second and clears when it is ready", () => {
    const play = session({ charm: "mend-stone" });
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
    const play = session({ charm: "mend-stone" });
    expect(play.isAtRest()).toBe(true);

    play.cast("charm");
    expect(play.isAtRest()).toBe(false);
  });
});

describe("a cooling stone is locked in its square", () => {
  const BAG: SlotRef = { kind: "contents", index: 0 };

  function armed(): GameSession {
    const play = session({ charm: "mend-stone" });
    play.cast("charm");
    play.drainNotices();
    return play;
  }

  it("cannot be moved out of its square", () => {
    const play = armed();
    expect(play.moveItem({ kind: "charm" }, { kind: "weapon" })).toBe(false);
    expect(play.equipmentOf("local")?.charm?.tileId).toBe("mend-stone");
  });

  it("cannot be put down on the floor", () => {
    const play = armed();
    expect(play.drop({ kind: "charm" }, { x: 1, y: 0, z: 0 })).toBe(false);
    expect(play.equipmentOf("local")?.charm?.tileId).toBe("mend-stone");
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
    const play = session({ charm: "mend-stone" });
    cool(play, "charm", 1_000);
    run(play, TICKS_PER_SECOND);
    expect(play.moveItem({ kind: "charm" }, { kind: "weapon" })).toBe(true);
    expect(play.equipmentOf("local")?.weapon?.tileId).toBe("mend-stone");
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
      "mend-stone",
    );
  });

  /** And the stone that lands is ready, because a placement carries no clock. */
  it("lands ready, since a cooldown never rides a placement", () => {
    const play = armed();
    play.runCommand("/health 0");
    play.drainDeaths();

    const placed = getStack(play.getMap(), 0, 0, 0).find(
      (p) => p.tileId === "mend-stone",
    );
    expect(placed).toBeDefined();
    expect(placed as Record<string, unknown>).not.toHaveProperty("cooldownMs");
  });

  /** The lock is about the stone. Everything else on the body still moves. */
  it("leaves the rest of the kit alone", () => {
    const play = session({ charm: "mend-stone", weapon: "brand-stone" });
    play.cast("charm");
    play.drainNotices();
    expect(play.moveItem({ kind: "weapon" }, { kind: "offhand" })).toBe(true);
  });
});

describe("what casting earns", () => {
  /** The plain rate for what a spell *did*, before any learning falloff. */
  const rate = (amount: number) => XP_PER_DAMAGE * amount;

  /** And what the cast itself is worth, which every one of them is paid. */
  const arcane = (play: GameSession) => play.masteryXpOf("local")?.arcane ?? 0;

  it("pays for the health a mend actually restored", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 1");
    play.drainNotices();

    const before = arcane(play);
    play.cast("charm");
    expect(arcane(play) - before).toBeCloseTo(rate(MEND_HP) + XP_PER_CAST, 6);
  });

  /**
   * Story 25. A mend at full health restores nothing, so what the *mend* is
   * worth is nothing — and what is left is the flat fee every cast is paid,
   * which is deliberately not nothing. @see `./experience`'s `practiceEarnings`
   */
  it("pays for the cast alone when a mend restores nothing", () => {
    const play = session({ charm: "mend-stone" });

    const before = arcane(play);
    play.cast("charm");
    expect(arcane(play) - before).toBe(XP_PER_CAST);
  });

  it("pays only for the health that was missing, never the whole amount", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP - 3}`);
    play.drainNotices();

    const before = arcane(play);
    play.cast("charm");
    expect(arcane(play) - before).toBeCloseTo(rate(3) + XP_PER_CAST, 6);
  });

  /**
   * Story 24. Setting yourself on fire is not training, so the burn a caster put
   * on their own body pays them nothing — measured from *after* the cast, so the
   * flat fee that cast was owed is not mistaken for the burn paying out.
   */
  it("pays nothing for damage a caster does to themselves", () => {
    const play = session({ charm: "scorch-stone" });

    play.cast("charm");
    const before = arcane(play);
    // Long enough for the burn to pay out several times over.
    run(play, TICKS_PER_SECOND * 3);
    expect(hpOf(play)).toBeLessThan(PLAYER_MAX_HP);
    expect(arcane(play)).toBe(before);
  });
});

/**
 * The floor under the profession.
 *
 * A stone of light does nothing measurable to anybody and a stone of flame is
 * gated on Arcane 10, so a caster paid on outcomes alone would have no way onto
 * the bottom rung of the ladder at all. What these pin is that the way on exists
 * and that it does not depend on which stone you happen to have found.
 */
describe("what pressing a stone teaches you for its own sake", () => {
  const arcane = (play: GameSession) => play.masteryXpOf("local")?.arcane ?? 0;

  /** Cast, wait out the cooldown, repeat. */
  function castRepeatedly(play: GameSession, times: number, cooldownMs: number) {
    for (let i = 0; i < times; i++) {
      expect(play.cast("weapon")).toBe(true);
      run(play, TICKS_PER_SECOND * Math.ceil(cooldownMs / 1000));
    }
  }

  it("pays a flat amount for a spell that accomplished nothing at all", () => {
    const play = session({ weapon: "ward-stone" });
    const before = arcane(play);
    play.cast("weapon");
    expect(arcane(play) - before).toBe(XP_PER_CAST);
  });

  /**
   * The claim this whole thing exists for: a player who finds nothing but a
   * light can still get onto the ladder by using it. Four casts, because the
   * curve makes the first point cost four.
   */
  it("earns the first level of Arcane from a light alone", () => {
    const play = session({ weapon: "ward-stone" });
    expect(masteryLevel(masteriesFromXp(play.masteryXpOf("local") ?? {}), "arcane")).toBe(0);

    castRepeatedly(play, xpForLevel(1) / XP_PER_CAST, WARD_COOLDOWN_MS);

    expect(masteryLevel(masteriesFromXp(play.masteryXpOf("local") ?? {}), "arcane")).toBe(1);
  });

  /**
   * **Flat across stones**, which is the half that makes it a floor. A stone
   * that asks a mastery of you and one that asks nothing pay the same for being
   * pressed; everything that scales is scaling what the spell *did*.
   */
  it("pays the same whatever stone was pressed", () => {
    const cheap = session({ weapon: "ward-stone" });
    const dear = session({ weapon: "adept-stone" });
    dear.runCommand("/mastery arcane 10");
    dear.drainNotices();

    const cheapBefore = arcane(cheap);
    const dearBefore = arcane(dear);
    cheap.cast("weapon");
    dear.cast("weapon");

    // The dear one mends a body at full health, so its outcome is worth nothing
    // and the whole of what it paid is the fee.
    expect(arcane(cheap) - cheapBefore).toBe(XP_PER_CAST);
    expect(arcane(dear) - dearBefore).toBe(XP_PER_CAST);
  });

  /** And a cast that never happened is not a cast. */
  it("pays nothing for a press the stone refused", () => {
    const play = session({ charm: "adept-stone" });
    const before = arcane(play);
    expect(play.cast("charm")).toBe(false);
    expect(arcane(play)).toBe(before);
  });

  it("pays it in the mastery casting trains, and nothing else", () => {
    expect(practiceEarnings()).toEqual({ arcane: XP_PER_CAST });
  });
});

describe("casterEarnings", () => {
  it("pays nothing for nothing", () => {
    expect(casterEarnings(0, undefined, [], {}, 1)).toEqual({});
    expect(casterEarnings(-4, undefined, [], {}, 1)).toEqual({});
  });

  it("pays arcane and nothing else", () => {
    expect(Object.keys(casterEarnings(5, undefined, [], {}, 1))).toEqual([
      "arcane",
    ]);
  });

  /**
   * The same falloff a weapon's is under: a stone you have outgrown keeps paying
   * and keeps paying less.
   */
  it("scales by the stone's own requirement, exactly as a weapon does", () => {
    const masteries = { arcane: 40 };
    const earned = casterEarnings(5, { arcane: 10 }, [], masteries, 1).arcane!;
    const expected =
      XP_PER_DAMAGE * 5 * learningRate(masteryLevel(masteries, "arcane"), 10);
    expect(earned).toBeCloseTo(expected, 6);
  });

  it("pays at full rate for a stone that asks nothing", () => {
    expect(casterEarnings(5, undefined, [], { arcane: 40 }, 1).arcane).toBeCloseTo(
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
    const play = session({ offhand: "mend-stone", charm: "flame-stone" });
    expect(play.spells().map((spell) => spell.square)).toEqual([
      "offhand",
      "charm",
    ]);
  });
});

/**
 * The elemental wheel, from the outside.
 *
 * What a player would notice: the same spell thrown at two bodies takes
 * different amounts off them, the element that did it is the one that gets
 * better at doing it, and a spell made of nothing behaves exactly as it always
 * did. Driven through a real cast and a real tick rather than by calling
 * `effectiveness` — that arithmetic has its own suite in `../lib/element`, and
 * what these are for is the thread between a stone and a hit point.
 */
describe("an elemental spell", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  /**
   * One second of burning, in hit points, for a burn cast from this stone at
   * whatever is standing at {@link RAT_CELL}.
   *
   * The first period only: the burn stacks nothing and rolls a fixed duration,
   * so a single tick of it is the whole of what the wheel has to say.
   */
  function burnPerSecond(stone: string, victim: string): number {
    const play = session(
      { weapon: stone },
      spawnRat(world(), RAT_CELL, victim),
    );
    const target = bodyAt(play, RAT_CELL, victim);
    play.setTarget(target);
    expect(play.cast("weapon")).toBe(true);

    const before = play.actorSnapshots().find((a) => a.id === target)!.hp!;
    run(play, TICKS_PER_SECOND);
    const after = play.actorSnapshots().find((a) => a.id === target)!.hp!;
    return before - after;
  }

  it("lands harder on what it has the better of", () => {
    expect(burnPerSecond("ember-stone", "nature-rat")).toBeGreaterThan(
      BURN_PER_SECOND,
    );
  });

  it("lands softer on what has the better of it", () => {
    const resisted = burnPerSecond("ember-stone", "water-rat");
    expect(resisted).toBeLessThan(BURN_PER_SECOND);
    // Softer, never nothing: a spell that visibly does zero reads as broken.
    expect(resisted).toBeGreaterThan(0);
  });

  it("lands plainly on a body attuned to all three at once", () => {
    expect(burnPerSecond("ember-stone", "even-rat")).toBe(BURN_PER_SECOND);
  });

  it("lands plainly on a body attuned to nothing", () => {
    expect(burnPerSecond("ember-stone", "rat")).toBe(BURN_PER_SECOND);
  });

  /**
   * The equipped half. A rat that is nothing in itself, wearing a tunic that is
   * nature, takes fire exactly as a nature body does — which is the whole of
   * "an element is something you can decide rather than only something you were
   * born as".
   */
  it("reads what the body is wearing as well as what it is", () => {
    expect(burnPerSecond("ember-stone", "robed-rat")).toBeGreaterThan(
      BURN_PER_SECOND,
    );
  });

  /** And what is in the bag is in the bag. */
  it("ignores an elemental thing that is only being carried", () => {
    expect(burnPerSecond("ember-stone", "packing-rat")).toBe(BURN_PER_SECOND);
  });

  /**
   * The claim the whole model turns on, made on the one body in this suite whose
   * masteries can actually be moved: a body that has practised an element is not
   * made of it. Read the other way round, training the element you are best at
   * would be what makes you weak to its counter — a progression that punishes
   * you for progressing.
   *
   * Cast at the caster, because that is the only way to put a burn on the body
   * whose masteries the command can reach. The self-inflicted payout is refused
   * elsewhere and is not what this is about.
   */
  it("never reads a body's own masteries", () => {
    const plain = selfBurnPerSecond([]);
    expect(plain).toBe(BURN_PER_SECOND);

    // Nature alone is what fire has the better of. Were the wheel read off the
    // masteries, this body would take the burn half again as hard.
    expect(selfBurnPerSecond(NATURE_ADEPT)).toBe(plain);
    // And Water alone is what has the better of fire, which would soften it.
    expect(selfBurnPerSecond(WATER_ADEPT)).toBe(plain);
  });

  /**
   * A body that has practised one element and let the other two go.
   *
   * **All three moved, not one**, and that is what makes the case discriminate:
   * a player starts level with a point of each, and a body holding all three at
   * once cancels to neutral on the wheel — so raising Nature alone would pass
   * whichever model were in force and prove nothing.
   */
  const NATURE_ADEPT = [
    "/mastery fire 0",
    "/mastery water 0",
    "/mastery nature 40",
  ];
  const WATER_ADEPT = [
    "/mastery fire 0",
    "/mastery nature 0",
    "/mastery water 40",
  ];

  /**
   * A fire burn the caster puts on themselves, with the training applied
   * *after* the cast.
   *
   * After, because the stone asks Fire 1 to be pressed at all and these cases
   * take Fire to nothing — and it costs the claim nothing, since the wheel is
   * read where the damage lands rather than where the spell was thrown.
   */
  function selfBurnPerSecond(commands: string[]): number {
    const play = session({ charm: "ember-self-stone" });
    expect(play.cast("charm")).toBe(true);
    for (const command of commands) play.runCommand(command);
    play.drainNotices();

    const before = play.actorSnapshots().find((a) => a.id === "local")!.hp!;
    run(play, TICKS_PER_SECOND);
    const after = play.actorSnapshots().find((a) => a.id === "local")!.hp!;
    return before - after;
  }

  /**
   * The property every one of these is really protecting: an elementless spell
   * — a stone of light, a hearth, a venomous bite — behaves exactly as it did
   * before any of this existed, whoever it lands on.
   */
  it("is unchanged when the spell is made of nothing", () => {
    expect(burnPerSecond("brand-stone", "nature-rat")).toBe(BURN_PER_SECOND);
    expect(burnPerSecond("brand-stone", "water-rat")).toBe(BURN_PER_SECOND);
  });

  /** An advantage anywhere: the water half beats nothing, the fire half wins. */
  it("weighs every element a two-element spell is made of", () => {
    expect(burnPerSecond("storm-stone", "nature-rat")).toBeGreaterThan(
      BURN_PER_SECOND,
    );
  });

  /**
   * The longest thread in the feature, now carrying two things: the flame
   * remembers who lit it *and* what it was lit with, so a conjured fire is as
   * good against nature as a fire thrown by hand.
   */
  it("carries the element onto what it conjures", () => {
    const lit = session(
      { weapon: "ember-flame-stone" },
      spawnRat(world(), RAT_CELL, "nature-rat"),
    );
    const target = bodyAt(lit, RAT_CELL, "nature-rat");
    lit.setTarget(target);
    expect(lit.cast("weapon")).toBe(true);

    const before = lit.actorSnapshots().find((a) => a.id === target)!.hp!;
    run(lit, TICKS_PER_SECOND);
    const after = lit.actorSnapshots().find((a) => a.id === target)!.hp!;
    expect(before - after).toBeGreaterThan(BURN_PER_SECOND);
  });
});

describe("a bolt thrown at somebody", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function boltAt(stone: string, victim = "rat"): {
    play: GameSession;
    target: string;
    before: number;
  } {
    const play = session({ weapon: stone }, spawnRat(world(), RAT_CELL, victim));
    const target = bodyAt(play, RAT_CELL, victim);
    play.setTarget(target);
    return { play, target, before: hpOf(play, target)! };
  }

  const took = (play: GameSession, target: string, before: number) =>
    before - hpOf(play, target)!;

  /** What is running on a body, by the status each instance came from. */
  const statusIdsOf = (play: GameSession, id: string) =>
    (play.statusesOf(id) ?? []).map((status) => status.defId);

  /**
   * The whole of the feature in one case: a caster with nothing learnt takes
   * exactly what the author wrote off a body wearing nothing.
   *
   * The player has no Arcane and no Fire that this stone asks for, so
   * `spellPower` hands back the authored figure unchanged — which is what makes
   * every other case here readable as a delta against it.
   */
  it("takes the stone's own damage off the target", () => {
    const { play, target, before } = boltAt("bolt-stone");
    expect(play.cast("weapon")).toBe(true);
    expect(took(play, target, before)).toBe(BOLT_THROUGH);
  });

  /**
   * **A cast is not aimed.** Agility is what a swing is contested against and a
   * bolt goes through none of that machinery, so the nimblest body in the world
   * takes it in full. This is the case that fails the day somebody routes a
   * cast through `rollAttack` for consistency.
   */
  it("is never dodged, however nimble the target", () => {
    const { play, target, before } = boltAt("bolt-stone", "nimble-rat");
    expect(play.cast("weapon")).toBe(true);
    expect(took(play, target, before)).toBe(BOLT_THROUGH);
  });

  /**
   * And armour is the half that *is* consulted. A bolt answers to Arcane — see
   * `GameSession`'s `ARCANE_BLOW` — so mail authored with an arcane resistance
   * is a body warded against magic, on exactly the terms a blade resistance is a
   * body a sword bounces off.
   */
  it("has to get through what the target is wearing against magic", () => {
    const { play, target, before } = boltAt("bolt-stone", "mailed-rat");
    expect(play.cast("weapon")).toBe(true);
    expect(took(play, target, before)).toBe(BOLT_THROUGH - BOLT_RESIST);
  });

  /** And then the wheel, on what got through — the same order a burn is under. */
  it("is weighed on the wheel against what the target is made of", () => {
    const strong = boltAt("ember-bolt-stone", "nature-rat");
    expect(strong.play.cast("weapon")).toBe(true);
    expect(took(strong.play, strong.target, strong.before)).toBeGreaterThan(
      BOLT_THROUGH,
    );

    const weak = boltAt("ember-bolt-stone", "water-rat");
    expect(weak.play.cast("weapon")).toBe(true);
    expect(took(weak.play, weak.target, weak.before)).toBeLessThan(BOLT_THROUGH);
  });

  /**
   * A receipt in the air, on the terms an arrow is one: loosed when the cast is
   * made, and purely a picture — the health has already moved.
   */
  it("puts its projectile in the air", () => {
    const { play } = boltAt("bolt-stone");
    expect(play.cast("weapon")).toBe(true);

    const flights = play.drainProjectiles();
    expect(flights).toHaveLength(1);
    expect(flights[0]!.tileId).toBe("arcane-mote");
    expect(flights[0]!.from.x).toBe(0);
    expect(flights[0]!.to.x).toBe(RAT_CELL.x);
  });

  /** And nothing flies at your own body, which has no distance to cross. */
  it("throws nothing when the bolt lands on its caster", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 10");
    play.drainNotices();
    play.drainProjectiles();

    expect(play.cast("charm")).toBe(true);
    expect(play.drainProjectiles()).toHaveLength(0);
  });

  /**
   * Paid on what the wheel made of the blow, which is the same rule a conjured
   * flame's burn is paid under — a caster who picked the element the target is
   * weak to is paid for having picked it.
   */
  it("pays the caster for what it actually did", () => {
    const { play } = boltAt("bolt-stone");
    const before = play.masteryXpOf("local")?.arcane ?? 0;
    expect(play.cast("weapon")).toBe(true);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBeGreaterThan(
      before + XP_PER_CAST,
    );
  });

  /**
   * **The whole point of folding the status arm in.** Before it, a stone that
   * burned somebody *and* set them alight was not authorable at all — the most
   * obvious fire spell there is. One cast, both halves.
   */
  it("takes health and leaves a status in the same cast", () => {
    const { play, target, before } = boltAt("brand-bolt-stone");
    expect(play.cast("weapon")).toBe(true);

    expect(took(play, target, before)).toBe(BOLT_THROUGH);
    expect(statusIdsOf(play, target)).toContain("burned");
  });

  /**
   * And the percentage is real. A hundred is a brand that always burns and a
   * zero is an entry the author has switched off — read against the authored
   * number directly, never through the band a contest lives in.
   */
  it("leaves nothing when the roll says so, and still takes the health", () => {
    const { play, target, before } = boltAt("dud-brand-stone");
    expect(play.cast("weapon")).toBe(true);

    expect(took(play, target, before)).toBe(BOLT_THROUGH);
    expect(statusIdsOf(play, target)).not.toContain("burned");
  });

  /**
   * **Armour eating the damage does not save anybody from the burn**, which is a
   * weapon's rule word for word — see `../lib/item`'s `WeaponItem.statuses`. A
   * body warded deeper than the bolt is worth takes nothing off its health bar
   * and is still set alight, because what a ward stops is the blow and not the
   * rune. Getting this backwards would make the two halves of one cast disagree
   * about whether it happened.
   */
  it("brands a body its damage could not get through", () => {
    const { play, target, before } = boltAt("brand-bolt-stone", "walled-rat");
    expect(play.cast("weapon")).toBe(true);

    expect(took(play, target, before)).toBe(0);
    expect(statusIdsOf(play, target)).toContain("burned");
  });

  /**
   * **A mend at a target is authorable now, and it is the one the model no
   * longer has an opinion about.** The old vocabulary refused it outright on the
   * grounds that there are no allies; there still are none, so what this case
   * pins is that the arithmetic runs the same way whoever it lands on.
   */
  it("mends whoever it is pointed at, clamped at their full health", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP - 3}`);
    play.drainNotices();

    expect(play.cast("charm")).toBe(true);
    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
  });
});

describe("what a spell is worth in a trained hand", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  /**
   * Story: a bolt scales the way a weapon does, and it reads two masteries
   * rather than one.
   *
   * Asserted as a comparison rather than against a figure, because the exact
   * number is `spellPower`'s business and is pinned in `../lib/battler.test.ts`.
   * What belongs here is that the session actually consults it — the two used to
   * be a stone that did what it said whoever pressed it.
   */
  function tookFrom(
    masteries: readonly string[],
    stone = "ember-bolt-stone",
  ): number {
    const play = session(
      { weapon: stone },
      spawnRat(world(), RAT_CELL, "rat"),
    );
    for (const command of masteries) play.runCommand(command);
    play.drainNotices();
    const target = bodyAt(play, RAT_CELL, "rat");
    play.setTarget(target);
    const before = hpOf(play, target)!;
    expect(play.cast("weapon")).toBe(true);
    return before - hpOf(play, target)!;
  }

  it("hits harder in the hands of a better arcanist", () => {
    expect(tookFrom(["/mastery arcane 80"])).toBeGreaterThan(BOLT_THROUGH);
  });

  /**
   * **And the element counts beside Arcane, not instead of it.** This is the
   * half a weapon has no equivalent of: a weapon answers to one mastery, and a
   * spell answers to how good you are at magic *and* to what you point it at.
   */
  it("hits harder again for the element the stone is made of", () => {
    const arcaneOnly = tookFrom(["/mastery arcane 80"]);
    const both = tookFrom(["/mastery arcane 80", "/mastery fire 80"]);
    expect(both).toBeGreaterThan(arcaneOnly);
  });
});

describe("what an elemental cast teaches", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function castAt(stone: string, victim = "rat"): GameSession {
    const play = session({ weapon: stone }, spawnRat(world(), RAT_CELL, victim));
    play.setTarget(bodyAt(play, RAT_CELL, victim));
    expect(play.cast("weapon")).toBe(true);
    return play;
  }

  /**
   * What a mastery has *moved*, not what it stands at.
   *
   * The player is seeded with a point of every element, so every total starts at
   * `xpForLevel(1)` and a test reading the total would be reading the seed. What
   * these cases are about is what the casting added.
   */
  function earned(play: GameSession, mastery: string): number {
    const total = play.masteryXpOf("local")?.[mastery as "fire"] ?? 0;
    return total - xpForLevel(STARTING_MASTERIES[mastery as "fire"] ?? 0);
  }

  /**
   * Arcane is the global magic level and the elements are what it is pointed
   * at, so the fee is paid to both rather than split between them: specialising
   * must not make you slower at magic than pressing a light.
   */
  it("pays the flat fee to Arcane and to the element alike", () => {
    expect(practiceEarnings(["fire"])).toEqual({
      arcane: XP_PER_CAST,
      fire: XP_PER_CAST,
    });
  });

  it("pays every element a spell is made of", () => {
    expect(practiceEarnings(["fire", "water"])).toEqual({
      arcane: XP_PER_CAST,
      fire: XP_PER_CAST,
      water: XP_PER_CAST,
    });
  });

  it("pays no element at all for a spell made of nothing", () => {
    expect(practiceEarnings()).toEqual({ arcane: XP_PER_CAST });
  });

  it("moves the element the stone is made of, and no other", () => {
    const play = castAt("ember-stone");
    expect(earned(play, "fire")).toBeGreaterThan(0);
    expect(earned(play, "water")).toBe(0);
    expect(earned(play, "nature")).toBe(0);
  });

  it("moves both elements of a spell made of two", () => {
    const play = castAt("storm-stone");
    expect(earned(play, "fire")).toBeGreaterThan(0);
    expect(earned(play, "water")).toBeGreaterThan(0);
    expect(earned(play, "nature")).toBe(0);
  });

  /**
   * What the burn actually took off, not what the formula said — so a caster who
   * picked the element the target is weak to is paid for having picked it.
   */
  it("pays the element on what the wheel made of the damage", () => {
    const against = castAt("ember-stone", "nature-rat");
    const plainly = castAt("ember-stone", "rat");
    run(against, TICKS_PER_SECOND);
    run(plainly, TICKS_PER_SECOND);
    expect(earned(against, "fire")).toBeGreaterThan(earned(plainly, "fire"));
  });

  it("pays an element nothing for a spell made of nothing", () => {
    const play = castAt("brand-stone");
    run(play, TICKS_PER_SECOND * 2);
    expect(earned(play, "arcane")).toBeGreaterThan(0);
    expect(earned(play, "fire")).toBe(0);
  });
});

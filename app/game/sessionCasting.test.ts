import { describe, expect, it } from "vitest";
import { defFrom, maxHpFrom } from "../lib/battler";
import type { BrainActionDef } from "../lib/brain";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { masteriesFromXp, masteryLevel, xpForLevel } from "../lib/mastery";
import { COMBAT_STATUS_ID, statusesById } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { naturalSlot, squareSlot } from "./casting";
import { guardBand, MIN_GUARD_SHARE } from "./combat";
import { TICK_MS } from "./constants";
import { casterEarnings, practiceEarnings, XP_PER_CAST, XP_PER_DAMAGE } from "./experience";
import { GameSession } from "./GameSession";
import type { SlotRef } from "./itemMoves";
import { FLIGHT_BODY_SHARE } from "./projectile";
import { FRAME, tile } from "../lib/testTile";

function stoneTile(
  id: string,
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "stone", ...item } },
    ...extra,
  });
}

const FIXTURE_BASE_HP = 8;

const PLAYER_TOUGHNESS = 40;
const PLAYER_MAX_HP = maxHpFrom(FIXTURE_BASE_HP, PLAYER_TOUGHNESS);
const RAT_TOUGHNESS = 40;

const MEND_COOLDOWN_MS = 60_000;
const MEND_HP = 10;

const CHARM_INTERVAL_MS = 10_000;
const CHARM_HP = 1;

function charmTile(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    interactions: { item: { type: "charm", ...item } },
  });
}

const CAST_MS = 3_000;

const CAST_TICKS = Math.ceil(CAST_MS / TICK_MS);

const QUICK_CAST_MS = 1_500;

const ADEPT_LEVEL = 10;

const WARD_COOLDOWN_MS = 30_000;

const BOLT_DAMAGE = 20;
const BOLT_RESIST = 5;

const RAT_DEF = defFrom(RAT_TOUGHNESS);

const RAT_GUARD = guardBand({ def: RAT_DEF, resist: {} }, { mastery: "arcane" });

const BOLT_THROUGH = {
  least: BOLT_DAMAGE - RAT_GUARD.highest,
  most: BOLT_DAMAGE - RAT_GUARD.lowest,
};

const MAILED_GUARD = guardBand(
  { def: RAT_DEF, resist: { arcane: BOLT_RESIST } },
  { mastery: "arcane" },
);
const MAILED_THROUGH = {
  least: BOLT_DAMAGE - MAILED_GUARD.highest,
  most: BOLT_DAMAGE - MAILED_GUARD.lowest,
};

function expectThrough(took: number, band: { least: number; most: number } = BOLT_THROUGH): void {
  expect(took).toBeGreaterThanOrEqual(band.least);
  expect(took).toBeLessThanOrEqual(band.most);
}

const BURN_MS = 4_000;
const BURN_PER_SECOND = 4;

const FIXTURE_BODY_HEIGHT = 4;

function body(
  id: string,
  toughness: number,
  extra: Record<string, unknown> = {},
  kit: Array<{ slot: string; tileId: string }> = [],
  elements: string[] = [],
) {
  return tile({
    id,
    height: FIXTURE_BODY_HEIGHT,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
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
        ...(kit.length ? { kit: kit.map((entry) => ({ ...entry, chance: 100 })) } : {}),
      },
    },
    ...extra,
  });
}

function nimbleRat(): TileDef {
  const rat = body("nimble-rat", RAT_TOUGHNESS, { actor: true });
  const battler = rat.interactions!.battler as { masteries: object };
  battler.masteries = { ...battler.masteries, agility: 100 };
  return rat;
}

const props: TileDef[] = [
  tile({ id: "grass" }),
  tile({ id: "wall", height: 4, lightPassing: false }),
  body("rat", RAT_TOUGHNESS, { actor: true }),
  body("nature-rat", RAT_TOUGHNESS, { actor: true }, [], ["nature"]),
  body("water-rat", RAT_TOUGHNESS, { actor: true }, [], ["water"]),
  body("even-rat", RAT_TOUGHNESS, { actor: true }, [], ["fire", "water", "nature"]),
  body("robed-rat", RAT_TOUGHNESS, { actor: true }, [
    { slot: "armor", tileId: "tunic-of-brambles" },
  ]),
  body("packing-rat", RAT_TOUGHNESS, { actor: true }, [{ slot: "bag", tileId: "satchel" }]),
  body("mailed-rat", RAT_TOUGHNESS, { actor: true }, [{ slot: "armor", tileId: "warding-mail" }]),
  body("walled-rat", RAT_TOUGHNESS, { actor: true }, [{ slot: "armor", tileId: "walling-mail" }]),
  nimbleRat(),
  stoneTile("mend-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
  }),
  stoneTile("bolt-stone", {
    effect: { kind: "bolt", on: "target", damage: 4 },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  stoneTile("hold-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
  stoneTile("flame-stone", {
    effect: { kind: "conjure", tileId: "conjured-flame" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    sound: "whoosh",
  }),
  stoneTile("bolt-stone", {
    effect: {
      kind: "bolt",
      damage: BOLT_DAMAGE,
      on: "target",
      projectile: "arcane-mote",
    },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
  }),
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
  stoneTile("ember-bolt-stone", {
    effect: { kind: "bolt", damage: BOLT_DAMAGE, on: "target" },
    cooldownMs: 10_000,
    reach: { cells: 3, height: 2 },
    requirements: { fire: 1 },
  }),
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
    kind: "projectile",
    lightPassing: true,
    intangible: true,
    interactions: {
      projectile: {
        cellsPerSecond: 14,
        hit: {
          durationMs: 120,
          dissolve: {
            pattern: "noise",
            clumpPx: 3,
            edgeColor: "#ffffff",
            edgeWidth: 0.15,
          },
        },
      },
    },
  }),
  tile({
    id: "walling-mail",
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: {
      item: {
        type: "armor",
        def: 0,
        resist: { arcane: Math.ceil(BOLT_DAMAGE / MIN_GUARD_SHARE) },
      },
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
  stoneTile("ward-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      statuses: [{ id: "warded", chance: 100 }],
    },
    cooldownMs: WARD_COOLDOWN_MS,
  }),
  stoneTile("slow-mend-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
    castTimeMs: CAST_MS,
  }),
  stoneTile("quick-mend-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
    castTimeMs: QUICK_CAST_MS,
  }),
  stoneTile("steady-mend-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
    castTimeMs: CAST_MS,
    uninterruptible: true,
  }),
  stoneTile("slow-flame-stone", {
    effect: { kind: "conjure", tileId: "conjured-flame" },
    cooldownMs: 10_000,
    castTimeMs: CAST_MS,
    reach: { cells: 3, height: 2 },
    sound: "whoosh",
  }),
  stoneTile("apprentice-stone", {
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: MEND_COOLDOWN_MS,
    castTimeMs: CAST_MS,
    requirements: { arcane: ADEPT_LEVEL },
  }),
  charmTile("life-charm", { everyMs: CHARM_INTERVAL_MS, hp: CHARM_HP }),
  charmTile("beacon-charm", {
    everyMs: CHARM_INTERVAL_MS,
    hp: CHARM_HP,
    statuses: [{ id: "warded", chance: 100 }],
  }),
  charmTile("ward-charm", {
    everyMs: CHARM_INTERVAL_MS,
    statuses: [{ id: "warded", chance: 100 }],
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
  stoneTile("form-stone", {
    effect: { kind: "conjure", tileId: "formed-flame" },
    cooldownMs: 10_000,
  }),
  tile({
    id: "formed-flame",
    intangible: true,
    lightPassing: true,
    transitions: {
      appear: {
        durationMs: 700,
        dissolve: {
          pattern: "sweep",
          from: { x: -1, y: -1 },
          edgeColor: "#8ce6ff",
          edgeWidth: 0.2,
        },
      },
    },
  }),
];

function catalogueWith(kit: Array<{ slot: string; tileId: string }>): TileDef[] {
  return [...props, playerTile(kit)];
}

function playerTile(kit: Array<{ slot: string; tileId: string }>): TileDef {
  const tile = body("player", PLAYER_TOUGHNESS, {}, kit);
  const battler = tile.interactions!.battler as { masteries: object };
  battler.masteries = { ...battler.masteries, ...STARTING_MASTERIES };
  return tile;
}

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
    everyMs: 0,
    effects: {},
  },
]);

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

function session(
  carrying: Partial<Record<Square, string>> = {},
  map: MapFile = world(),
): GameSession {
  const kit = (Object.entries(carrying) as Array<[Square, string]>).map(([slot, tileId]) => ({
    slot,
    tileId,
  }));
  return new GameSession(map, catalogueWith(kit), { statuses: catalogue });
}

function cool(play: GameSession, square: Square, cooldownMs: number) {
  play.cast(squareSlot(square));
  const kit = play.equipmentOf("local")!;
  const held = kit[square]!;
  Object.assign(held, { cooldownMs });
}

function run(play: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) play.tick(TICK_MS);
}

const TICKS_PER_SECOND = Math.ceil(1000 / TICK_MS);

function runUntilNothingIsFlying(play: GameSession) {
  for (let i = 0; i < TICKS_PER_SECOND * 2; i++) {
    if (play.getSnapshot().projectiles.length === 0) return;
    play.tick(TICK_MS);
  }
  throw new Error("a bolt never arrived");
}

function facingOfCaster(play: GameSession): string | undefined {
  return getStack(play.getMap(), 0, 0, 0).find((p) => p.tileId === "player")?.direction;
}

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

function bodyAt(play: GameSession, at: Coord, tileId = "rat"): string {
  const stack = getStack(play.getMap(), at.x, at.y, at.z);
  return stack.find((p) => p.tileId === tileId)?.owner ?? "";
}

describe("spending a cooldown", () => {
  it("puts the stone on its full cooldown the moment it is cast", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 10");
    play.drainNotices();

    expect(play.cast(squareSlot("charm"))).toBe(true);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);
  });

  it("spends it even when the spell did nothing at all", () => {
    const play = session({ charm: "mend-stone" });

    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(play.cast(squareSlot("charm"))).toBe(true);
    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);
  });

  it("refuses a second cast until the stone is ready", () => {
    const play = session({ charm: "mend-stone" });
    play.cast(squareSlot("charm"));
    expect(play.cast(squareSlot("charm"))).toBe(false);
  });

  it("counts a full cooldown down second by second", () => {
    const play = session({ charm: "mend-stone" });
    play.cast(squareSlot("charm"));
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
    expect(coolingIn(play, "charm")).toBeUndefined();
    expect(play.cast(squareSlot("charm"))).toBe(true);
  });

  it("keeps the world awake while anything is cooling", () => {
    const play = session({ charm: "mend-stone" });
    expect(play.isAtRest()).toBe(true);

    play.cast(squareSlot("charm"));
    expect(play.isAtRest()).toBe(false);
  });
});

describe("a cooling stone is locked in its square", () => {
  const BAG: SlotRef = { kind: "contents", index: 0 };

  function armed(): GameSession {
    const play = session({ charm: "mend-stone" });
    play.cast(squareSlot("charm"));
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

  it("says why, rather than refusing in silence", () => {
    const play = armed();
    play.moveItem({ kind: "charm" }, { kind: "weapon" });
    const said = play.drainNotices();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/cooling/i);
  });

  it("cannot be traded out by something dropped on top of it", () => {
    const play = session({ charm: "mend-stone", weapon: "flame-stone" });
    play.cast(squareSlot("charm"));
    play.drainNotices();

    expect(play.moveItem({ kind: "weapon" }, { kind: "charm" })).toBe(false);
    expect(play.equipmentOf("local")?.charm?.tileId).toBe("mend-stone");
    expect(play.equipmentOf("local")?.weapon?.tileId).toBe("flame-stone");

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

  it("drops with the rest of the kit when its owner dies", () => {
    const play = armed();
    play.runCommand("/health 0");
    const deaths = play.drainDeaths();
    expect(deaths).toHaveLength(1);

    expect(deaths[0]!.equipment.charm).toBeNull();
    expect(getStack(play.getMap(), 0, 0, 0).map((p) => p.tileId)).toContain("mend-stone");
  });

  it("lands ready, since a cooldown never rides a placement", () => {
    const play = armed();
    play.runCommand("/health 0");
    play.drainDeaths();

    const placed = getStack(play.getMap(), 0, 0, 0).find((p) => p.tileId === "mend-stone");
    expect(placed).toBeDefined();
    expect(placed as Record<string, unknown>).not.toHaveProperty("cooldownMs");
  });

  it("leaves the rest of the kit alone", () => {
    const play = session({ charm: "mend-stone", weapon: "brand-stone" });
    play.cast(squareSlot("charm"));
    play.drainNotices();
    expect(play.moveItem({ kind: "weapon" }, { kind: "offhand" })).toBe(true);
  });
});

describe("what casting earns", () => {
  const rate = (amount: number) => XP_PER_DAMAGE * amount;

  const arcane = (play: GameSession) => play.masteryXpOf("local")?.arcane ?? 0;

  it("pays for the health a mend actually restored", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 1");
    play.drainNotices();

    const before = arcane(play);
    play.cast(squareSlot("charm"));
    expect(arcane(play) - before).toBeCloseTo(rate(MEND_HP) + XP_PER_CAST, 6);
  });

  it("pays for the cast alone when a mend restores nothing", () => {
    const play = session({ charm: "mend-stone" });

    const before = arcane(play);
    play.cast(squareSlot("charm"));
    expect(arcane(play) - before).toBe(XP_PER_CAST);
  });

  it("pays only for the health that was missing, never the whole amount", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP - 3}`);
    play.drainNotices();

    const before = arcane(play);
    play.cast(squareSlot("charm"));
    expect(arcane(play) - before).toBeCloseTo(rate(3) + XP_PER_CAST, 6);
  });

  it("pays nothing for damage a caster does to themselves", () => {
    const play = session({ charm: "scorch-stone" });

    play.cast(squareSlot("charm"));
    const before = arcane(play);
    run(play, TICKS_PER_SECOND * 3);
    expect(hpOf(play)).toBeLessThan(PLAYER_MAX_HP);
    expect(arcane(play)).toBe(before);
  });
});

describe("what pressing a stone teaches you for its own sake", () => {
  const arcane = (play: GameSession) => play.masteryXpOf("local")?.arcane ?? 0;

  function castRepeatedly(play: GameSession, times: number, cooldownMs: number) {
    for (let i = 0; i < times; i++) {
      expect(play.cast(squareSlot("weapon"))).toBe(true);
      run(play, TICKS_PER_SECOND * Math.ceil(cooldownMs / 1000));
    }
  }

  it("pays a flat amount for a spell that accomplished nothing at all", () => {
    const play = session({ weapon: "ward-stone" });
    const before = arcane(play);
    play.cast(squareSlot("weapon"));
    expect(arcane(play) - before).toBe(XP_PER_CAST);
  });

  it("earns the first level of Arcane from a light alone", () => {
    const play = session({ weapon: "ward-stone" });
    expect(masteryLevel(masteriesFromXp(play.masteryXpOf("local") ?? {}), "arcane")).toBe(0);

    castRepeatedly(play, xpForLevel(1) / XP_PER_CAST, WARD_COOLDOWN_MS);

    expect(masteryLevel(masteriesFromXp(play.masteryXpOf("local") ?? {}), "arcane")).toBe(1);
  });

  it("pays the same whatever stone was pressed", () => {
    const cheap = session({ weapon: "ward-stone" });
    const dear = session({ weapon: "adept-stone" });
    dear.runCommand("/mastery arcane 10");
    dear.drainNotices();

    const cheapBefore = arcane(cheap);
    const dearBefore = arcane(dear);
    cheap.cast(squareSlot("weapon"));
    dear.cast(squareSlot("weapon"));

    expect(arcane(cheap) - cheapBefore).toBe(XP_PER_CAST);
    expect(arcane(dear) - dearBefore).toBe(XP_PER_CAST);
  });

  it("pays nothing for a press the stone refused", () => {
    const play = session({ charm: "adept-stone" });
    const before = arcane(play);
    expect(play.cast(squareSlot("charm"))).toBe(false);
    expect(arcane(play)).toBe(before);
  });

  it("pays it in the mastery casting trains, and nothing else", () => {
    expect(practiceEarnings()).toEqual({ arcane: XP_PER_CAST });
  });
});

describe("casterEarnings", () => {
  const FLAT = () => 1;

  it("pays nothing for nothing", () => {
    expect(casterEarnings(0, [], FLAT)).toEqual({});
    expect(casterEarnings(-4, [], FLAT)).toEqual({});
  });

  it("pays arcane and nothing else for an elementless spell", () => {
    expect(Object.keys(casterEarnings(5, [], FLAT))).toEqual(["arcane"]);
  });

  it("pays each element the spell is made of on top of arcane", () => {
    expect(casterEarnings(5, ["fire"], FLAT)).toEqual({
      arcane: XP_PER_DAMAGE * 5,
      fire: XP_PER_DAMAGE * 5,
    });
  });

  it("pays the plain rate whatever the stone asked", () => {
    expect(casterEarnings(5, [], FLAT).arcane).toBeCloseTo(XP_PER_DAMAGE * 5, 6);
  });

  it("weighs arcane and each element separately", () => {
    const earned = casterEarnings(5, ["fire"], (mastery) => (mastery === "fire" ? 2 : 0));
    expect(earned.fire).toBe(XP_PER_DAMAGE * 5 * 2);
    expect(earned.arcane).toBe(0);
  });
});

describe("conjuring", () => {
  it("places the tile in front of the caster when nothing is targeted", () => {
    const play = session({ weapon: "flame-stone" });

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).toContain("conjured-flame");
  });

  it("announces the flame it placed, when that flame has a way in authored", () => {
    const play = session({ weapon: "form-stone" });

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(play.drainTransitions()).toEqual([
      {
        id: expect.any(String),
        side: "appear",
        tileId: "formed-flame",
        x: 1,
        y: 0,
        z: 0,
        stackIndex: 1,
      },
    ]);
  });

  it("announces nothing for a flame with no way in authored", () => {
    const play = session({ weapon: "flame-stone" });

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(play.drainTransitions()).toEqual([]);
  });

  it("still hands a cast's flame to a viewer on this machine after a tick", () => {
    const play = session({ weapon: "form-stone" });
    play.cast(squareSlot("weapon"));
    run(play, 1);

    expect(play.takeTransitions().map((held) => held.note.tileId)).toEqual(["formed-flame"]);
    expect(play.takeTransitions()).toEqual([]);
  });

  it("places it at the target's cell instead, when there is one", () => {
    const play = session({ weapon: "flame-stone" }, spawnRat(world(), { x: 3, y: 0, z: 0 }));
    play.setTarget(ratAt(play, { x: 3, y: 0, z: 0 }));

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(getStack(play.getMap(), 3, 0, 0).map((p) => p.tileId)).toContain("conjured-flame");
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).not.toContain("conjured-flame");
  });

  it("marks the placement with whoever cast it", () => {
    const play = session({ weapon: "flame-stone" });
    play.cast(squareSlot("weapon"));

    const placed = getStack(play.getMap(), 1, 0, 0).find((p) => p.tileId === "conjured-flame");
    expect(placed?.castBy).toBe("local");
    expect(placed?.owner).toBeUndefined();
  });

  it("goes out on its own", () => {
    const play = session({ weapon: "flame-stone" });
    play.cast(squareSlot("weapon"));

    run(play, TICKS_PER_SECOND * 9);
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).not.toContain("conjured-flame");
  });

  it("refuses to conjure into a wall, and spends nothing", () => {
    const map = replaceStack(world(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    const play = session({ weapon: "flame-stone" }, map);

    expect(play.cast(squareSlot("weapon"))).toBe(false);
    expect(coolingIn(play, "weapon")).toBeUndefined();
    expect(play.spells()[0]?.castability).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("lays it ahead of a caster mid-step, not in the cell they are entering", () => {
    const play = session({ weapon: "flame-stone" });
    expect(play.requestStep("local", "e")).toBe("started");

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(getStack(play.getMap(), 1, 0, 0).map((p) => p.tileId)).not.toContain("conjured-flame");
    expect(getStack(play.getMap(), 2, 0, 0).map((p) => p.tileId)).toContain("conjured-flame");

    run(play, TICKS_PER_SECOND);
    expect(play.statusesOf("local")).toEqual([]);
  });

  it("keeps a turn made mid-step once the step lands", () => {
    const play = session({ weapon: "flame-stone" });
    play.requestStep("local", "e");
    play.faceActor("local", "w");
    run(play, TICKS_PER_SECOND);

    const player = getStack(play.getMap(), 1, 0, 0).find((p) => p.tileId === "player");
    expect(player?.direction).toBe("w");

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(getStack(play.getMap(), 0, 0, 0).map((p) => p.tileId)).toContain("conjured-flame");
  });
});

describe("a flame you conjured, burning somebody else", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function litWorld(): GameSession {
    const play = session({ weapon: "flame-stone" }, spawnRat(world(), RAT_CELL));
    play.setTarget(ratAt(play, RAT_CELL));
    play.cast(squareSlot("weapon"));
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

  it("leaves an unattributed burn paying nobody", () => {
    const play = session({}, spawnRat(world(), RAT_CELL));
    const rat = ratAt(play, RAT_CELL);
    play.runCommand(`/status burned ${rat}`);
    play.drainNotices();

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    run(play, TICKS_PER_SECOND * 2);
    expect(hpOf(play, rat)!).toBeLessThan(maxHpFrom(FIXTURE_BASE_HP, RAT_TOUGHNESS));
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBe(before);
  });
});

describe("a status cast at somebody", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  it("lands on the target and pays for what it burns", () => {
    const play = session({ weapon: "brand-stone" }, spawnRat(world(), RAT_CELL));
    const rat = ratAt(play, RAT_CELL);
    play.setTarget(rat);

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect((play.statusesOf(rat) ?? []).map((s) => s.defId)).toEqual(["burned"]);

    const before = play.masteryXpOf("local")?.arcane ?? 0;
    run(play, TICKS_PER_SECOND * 2);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBeGreaterThan(before);
  });

  it("refuses to fire with nobody targeted, and costs nothing", () => {
    const play = session({ weapon: "brand-stone" });
    expect(play.cast(squareSlot("weapon"))).toBe(false);
    expect(coolingIn(play, "weapon")).toBeUndefined();
  });
});

describe("a stone above the caster's mastery", () => {
  it("refuses to fire, and spends nothing", () => {
    const play = session({ charm: "adept-stone" });

    expect(play.cast(squareSlot("charm"))).toBe(false);
    expect(coolingIn(play, "charm")).toBeUndefined();
  });

  it("fires once the mastery is earned", () => {
    const play = session({ charm: "adept-stone" });
    play.runCommand("/mastery arcane 10");
    play.drainNotices();

    expect(play.cast(squareSlot("charm"))).toBe(true);
  });

  it("is not in the row until then", () => {
    const play = session({ charm: "adept-stone" });
    expect(play.spells()).toEqual([]);

    play.runCommand("/mastery arcane 10");
    play.drainNotices();
    expect(play.spells().map((spell) => spell.slot)).toEqual([squareSlot("charm")]);
  });
});

describe("the row the session reports", () => {
  it("is empty for a body carrying nothing", () => {
    expect(session().spells()).toEqual([]);
  });

  it("names every stone that can be pressed, in square order", () => {
    const play = session({ offhand: "mend-stone", charm: "flame-stone" });
    expect(play.spells().map((spell) => spell.slot)).toEqual([
      squareSlot("offhand"),
      squareSlot("charm"),
    ]);
  });
});

describe("an elemental spell", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function burnPerSecond(stone: string, victim: string): number {
    const play = session({ weapon: stone }, spawnRat(world(), RAT_CELL, victim));
    const target = bodyAt(play, RAT_CELL, victim);
    play.setTarget(target);
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    const before = play.actorSnapshots().find((a) => a.id === target)!.hp!;
    run(play, TICKS_PER_SECOND);
    const after = play.actorSnapshots().find((a) => a.id === target)!.hp!;
    return before - after;
  }

  it("lands harder on what it has the better of", () => {
    expect(burnPerSecond("ember-stone", "nature-rat")).toBeGreaterThan(BURN_PER_SECOND);
  });

  it("lands softer on what has the better of it", () => {
    const resisted = burnPerSecond("ember-stone", "water-rat");
    expect(resisted).toBeLessThan(BURN_PER_SECOND);
    expect(resisted).toBeGreaterThan(0);
  });

  it("lands plainly on a body attuned to all three at once", () => {
    expect(burnPerSecond("ember-stone", "even-rat")).toBe(BURN_PER_SECOND);
  });

  it("lands plainly on a body attuned to nothing", () => {
    expect(burnPerSecond("ember-stone", "rat")).toBe(BURN_PER_SECOND);
  });

  it("reads what the body is wearing as well as what it is", () => {
    expect(burnPerSecond("ember-stone", "robed-rat")).toBeGreaterThan(BURN_PER_SECOND);
  });

  it("ignores an elemental thing that is only being carried", () => {
    expect(burnPerSecond("ember-stone", "packing-rat")).toBe(BURN_PER_SECOND);
  });

  it("never reads a body's own masteries", () => {
    const plain = selfBurnPerSecond([]);
    expect(plain).toBe(BURN_PER_SECOND);

    expect(selfBurnPerSecond(NATURE_ADEPT)).toBe(plain);
    expect(selfBurnPerSecond(WATER_ADEPT)).toBe(plain);
  });

  const NATURE_ADEPT = ["/mastery fire 0", "/mastery water 0", "/mastery nature 40"];
  const WATER_ADEPT = ["/mastery fire 0", "/mastery nature 0", "/mastery water 40"];

  function selfBurnPerSecond(commands: string[]): number {
    const play = session({ charm: "ember-self-stone" });
    expect(play.cast(squareSlot("charm"))).toBe(true);
    for (const command of commands) play.runCommand(command);
    play.drainNotices();

    const before = play.actorSnapshots().find((a) => a.id === "local")!.hp!;
    run(play, TICKS_PER_SECOND);
    const after = play.actorSnapshots().find((a) => a.id === "local")!.hp!;
    return before - after;
  }

  it("is unchanged when the spell is made of nothing", () => {
    expect(burnPerSecond("brand-stone", "nature-rat")).toBe(BURN_PER_SECOND);
    expect(burnPerSecond("brand-stone", "water-rat")).toBe(BURN_PER_SECOND);
  });

  it("weighs every element a two-element spell is made of", () => {
    expect(burnPerSecond("storm-stone", "nature-rat")).toBeGreaterThan(BURN_PER_SECOND);
  });

  it("carries the element onto what it conjures", () => {
    const lit = session({ weapon: "ember-flame-stone" }, spawnRat(world(), RAT_CELL, "nature-rat"));
    const target = bodyAt(lit, RAT_CELL, "nature-rat");
    lit.setTarget(target);
    expect(lit.cast(squareSlot("weapon"))).toBe(true);

    const before = lit.actorSnapshots().find((a) => a.id === target)!.hp!;
    run(lit, TICKS_PER_SECOND);
    const after = lit.actorSnapshots().find((a) => a.id === target)!.hp!;
    expect(before - after).toBeGreaterThan(BURN_PER_SECOND);
  });
});

describe("a bolt thrown at somebody", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function boltAt(
    stone: string,
    victim = "rat",
  ): {
    play: GameSession;
    target: string;
    before: number;
  } {
    const play = session({ weapon: stone }, spawnRat(world(), RAT_CELL, victim));
    const target = bodyAt(play, RAT_CELL, victim);
    play.setTarget(target);
    return { play, target, before: hpOf(play, target)! };
  }

  const took = (play: GameSession, target: string, before: number) => {
    runUntilNothingIsFlying(play);
    return before - hpOf(play, target)!;
  };

  const statusIdsOf = (play: GameSession, id: string) =>
    (play.statusesOf(id) ?? []).map((status) => status.defId);

  it("takes the stone's own damage off the target", () => {
    const { play, target, before } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expectThrough(took(play, target, before));
  });

  it("turns the caster into whoever it was thrown at", () => {
    const { play } = boltAt("bolt-stone");
    play.faceActor("local", "w");

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(facingOfCaster(play)).toBe("e");
  });

  it("is never dodged, however nimble the target", () => {
    const { play, target, before } = boltAt("bolt-stone", "nimble-rat");
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expectThrough(took(play, target, before));
  });

  it("has to get through what the target is wearing against magic", () => {
    expect(MAILED_THROUGH.least).toBeLessThan(BOLT_THROUGH.least);
    expect(MAILED_THROUGH.most).toBeLessThan(BOLT_THROUGH.most);

    const { play, target, before } = boltAt("bolt-stone", "mailed-rat");
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expectThrough(took(play, target, before), MAILED_THROUGH);
  });

  it("is weighed on the wheel against what the target is made of", () => {
    const strong = boltAt("ember-bolt-stone", "nature-rat");
    expect(strong.play.cast(squareSlot("weapon"))).toBe(true);
    expect(took(strong.play, strong.target, strong.before)).toBeGreaterThan(BOLT_THROUGH.most);

    const weak = boltAt("ember-bolt-stone", "water-rat");
    expect(weak.play.cast(squareSlot("weapon"))).toBe(true);
    expect(took(weak.play, weak.target, weak.before)).toBeLessThan(BOLT_THROUGH.least);
  });

  it("puts its projectile in the air", () => {
    const { play } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    const flights = play.drainProjectiles();
    expect(flights).toHaveLength(1);
    expect(flights[0]!.tileId).toBe("arcane-mote");
    expect(flights[0]!.from.x).toBe(0);
    expect(flights[0]!.to.x).toBe(RAT_CELL.x);
  });

  it("takes nothing until the bolt arrives", () => {
    const { play, target, before } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expect(play.getSnapshot().projectiles).toHaveLength(1);
    expect(hpOf(play, target)).toBe(before);

    runUntilNothingIsFlying(play);
    expect(hpOf(play, target)).toBeLessThan(before);
  });

  it("leaves and lands half way up a body rather than at its feet", () => {
    const { play } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    const [flight] = play.drainProjectiles();

    expect(flight!.from.elevAbs).toBe(FIXTURE_BODY_HEIGHT * FLIGHT_BODY_SHARE);
    expect(flight!.to.elevAbs).toBe(FIXTURE_BODY_HEIGHT * FLIGHT_BODY_SHARE);
  });

  it("holds one height across a shot between bodies standing level", () => {
    const { play } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    const [flight] = play.drainProjectiles();

    expect(flight!.to.elevAbs).toBe(flight!.from.elevAbs);
  });

  it("names the body it was aimed at", () => {
    const { play, target } = boltAt("bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expect(play.drainProjectiles()[0]!.targetId).toBe(target);
  });

  it("dresses the struck body in the bolt's hit", () => {
    const { play, target } = boltAt("bolt-stone");
    play.drainTransitions();
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    runUntilNothingIsFlying(play);

    const struck = play.drainTransitions().filter((note) => note.struckBy);

    expect(struck).toHaveLength(1);
    expect(struck[0]!.struckBy).toBe("arcane-mote");
    expect(struck[0]!.tileId).toBe("rat");
    expect(play.getSnapshot().actors.some((a) => a.id === target)).toBe(true);
  });

  it("plays it as an appear, so the body ends drawn as itself", () => {
    const { play } = boltAt("bolt-stone");
    play.drainTransitions();
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    runUntilNothingIsFlying(play);

    expect(play.drainTransitions().find((note) => note.struckBy)?.side).toBe("appear");
  });

  it("throws nothing when the bolt lands on its caster", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand("/health 10");
    play.drainNotices();
    play.drainProjectiles();

    expect(play.cast(squareSlot("charm"))).toBe(true);
    expect(play.drainProjectiles()).toHaveLength(0);
  });

  it("pays the caster for what it actually did", () => {
    const { play } = boltAt("bolt-stone");
    const before = play.masteryXpOf("local")?.arcane ?? 0;
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    runUntilNothingIsFlying(play);
    expect(play.masteryXpOf("local")?.arcane ?? 0).toBeGreaterThan(before + XP_PER_CAST);
  });

  it("takes health and leaves a status in the same cast", () => {
    const { play, target, before } = boltAt("brand-bolt-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expectThrough(took(play, target, before));
    expect(statusIdsOf(play, target)).toContain("burned");
  });

  it("leaves nothing when the roll says so, and still takes the health", () => {
    const { play, target, before } = boltAt("dud-brand-stone");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expectThrough(took(play, target, before));
    expect(statusIdsOf(play, target)).not.toContain("burned");
  });

  it("brands a body its damage could not get through", () => {
    const { play, target, before } = boltAt("brand-bolt-stone", "walled-rat");
    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expect(took(play, target, before)).toBe(0);
    expect(statusIdsOf(play, target)).toContain("burned");
  });

  it("mends whoever it is pointed at, clamped at their full health", () => {
    const play = session({ charm: "mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP - 3}`);
    play.drainNotices();

    expect(play.cast(squareSlot("charm"))).toBe(true);
    expect(hpOf(play)).toBe(PLAYER_MAX_HP);
  });
});

describe("a harming stone worn as a charm", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function charmed() {
    const play = session({ charm: "bolt-stone" }, spawnRat(world(), RAT_CELL));
    return { play, target: bodyAt(play, RAT_CELL) };
  }

  it("takes its damage off the target and none off its wearer", () => {
    const { play, target } = charmed();
    play.setTarget(target);
    const mine = hpOf(play)!;
    const theirs = hpOf(play, target)!;

    expect(play.cast(squareSlot("charm"))).toBe(true);
    runUntilNothingIsFlying(play);
    expect(hpOf(play, target)).toBeLessThan(theirs);
    expect(hpOf(play)).toBe(mine);
  });

  it("is refused with nobody targeted rather than landing on its wearer", () => {
    const { play } = charmed();
    const mine = hpOf(play)!;

    expect(play.cast(squareSlot("charm"))).toBe(false);
    expect(hpOf(play)).toBe(mine);
  });
});

describe("what a spell is worth in a trained hand", () => {
  const RAT_CELL = { x: 2, y: 0, z: 0 };

  function tookFrom(masteries: readonly string[], stone = "ember-bolt-stone"): number {
    const play = session({ weapon: stone }, spawnRat(world(), RAT_CELL, "rat"));
    for (const command of masteries) play.runCommand(command);
    play.drainNotices();
    const target = bodyAt(play, RAT_CELL, "rat");
    play.setTarget(target);
    const before = hpOf(play, target)!;
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    return before - hpOf(play, target)!;
  }

  it("hits harder in the hands of a better arcanist", () => {
    expect(tookFrom(["/mastery arcane 80"])).toBeGreaterThan(BOLT_THROUGH.most);
  });

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
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    return play;
  }

  function earned(play: GameSession, mastery: string): number {
    const total = play.masteryXpOf("local")?.[mastery as "fire"] ?? 0;
    return total - xpForLevel(STARTING_MASTERIES[mastery as "fire"] ?? 0);
  }

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

describe("a cast refused for want of a target", () => {
  it("says what to do, rather than refusing in silence", () => {
    const play = session({ weapon: "bolt-stone" });
    expect(play.cast(squareSlot("weapon"))).toBe(false);
    expect(play.drainNotices()).toEqual(["Select a target first"]);
  });

  it("says nothing about a refusal the button already draws", () => {
    const play = session({ charm: "adept-stone" });
    expect(play.cast(squareSlot("charm"))).toBe(false);
    expect(play.drainNotices()).toEqual([]);
  });

  it("says nothing once somebody is targeted", () => {
    const at = { x: 2, y: 0, z: 0 };
    const play = session({ weapon: "bolt-stone" }, spawnRat(world(), at));
    play.setTarget(ratAt(play, at));
    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(play.drainNotices()).not.toContain("Select a target first");
  });
});

describe("a charm worn on the charm square", () => {
  function runMs(play: GameSession, ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) play.tick(TICK_MS);
  }

  function hurt(charm: string, by = 5) {
    const play = session({ charm });
    play.runCommand(`/health -${by}`);
    return { play, before: hpOf(play)! };
  }

  it("puts nothing back before its interval is up", () => {
    const { play, before } = hurt("life-charm");
    runMs(play, CHARM_INTERVAL_MS - TICK_MS * 2);
    expect(hpOf(play)).toBe(before);
  });

  it("puts its health back once the interval is up", () => {
    const { play, before } = hurt("life-charm");
    runMs(play, CHARM_INTERVAL_MS);
    expect(hpOf(play)).toBe(before + CHARM_HP);
  });

  it("keeps going, one interval at a time", () => {
    const { play, before } = hurt("life-charm");
    runMs(play, CHARM_INTERVAL_MS * 3);
    expect(hpOf(play)).toBe(before + CHARM_HP * 3);
  });

  it("stops at a full health bar", () => {
    const play = session({ charm: "life-charm" });
    const full = hpOf(play)!;
    runMs(play, CHARM_INTERVAL_MS * 3);
    expect(hpOf(play)).toBe(full);
  });

  function grantedBy(play: GameSession): string[] {
    return (play.statusesOf("local") ?? [])
      .map((s) => s.defId)
      .filter((id) => id !== COMBAT_STATUS_ID);
  }

  it("grants what it is authored to grant, on the same tick", () => {
    const { play } = hurt("beacon-charm");
    expect(grantedBy(play)).toEqual([]);
    runMs(play, CHARM_INTERVAL_MS);
    expect(grantedBy(play)).toEqual(["warded"]);
  });

  it("can grant without mending", () => {
    const { play, before } = hurt("ward-charm");
    runMs(play, CHARM_INTERVAL_MS);
    expect(hpOf(play)).toBe(before);
    expect(grantedBy(play)).toEqual(["warded"]);
  });

  it("does nothing at all for somebody wearing none", () => {
    const play = session({});
    play.runCommand("/health -5");
    const before = hpOf(play)!;
    runMs(play, CHARM_INTERVAL_MS * 2);
    expect(hpOf(play)).toBe(before);
  });
});

describe("what a mend floats", () => {
  const numbersOf = (play: GameSession) => play.getSnapshot().damage;
  const mends = (play: GameSession, from: number) =>
    numbersOf(play)
      .slice(from)
      .filter((number) => number.outcome === "heal");

  it("floats what was restored, as a heal", () => {
    const play = session({});
    play.runCommand("/health -5");
    const before = numbersOf(play).length;

    play.runCommand("/health +3");
    expect(mends(play, before)).toMatchObject([{ outcome: "heal", amount: 3 }]);
  });

  it("floats what went in rather than what was offered", () => {
    const play = session({});
    play.runCommand("/health -1");
    const before = numbersOf(play).length;

    play.runCommand("/health +5");
    expect(mends(play, before)).toMatchObject([{ outcome: "heal", amount: 1 }]);
  });

  it("floats nothing at a full health bar", () => {
    const play = session({});
    const before = numbersOf(play).length;

    play.runCommand("/health +5");
    expect(mends(play, before)).toEqual([]);
  });

  it("floats a mend stone's cast", () => {
    const play = session({ weapon: "mend-stone" });
    play.runCommand(`/health -${MEND_HP}`);
    const before = numbersOf(play).length;

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(mends(play, before)).toMatchObject([{ outcome: "heal", amount: MEND_HP }]);
  });

  it("floats one for a charm's tick, and none once the wearer is full", () => {
    const play = session({ charm: "life-charm" });
    play.runCommand(`/health -${CHARM_HP}`);

    const seen = new Map<string, number>();
    for (let elapsed = 0; elapsed < CHARM_INTERVAL_MS * 3; elapsed += TICK_MS) {
      play.tick(TICK_MS);
      for (const number of numbersOf(play)) {
        if (number.outcome === "heal") seen.set(number.id, number.amount);
      }
    }

    expect([...seen.values()]).toEqual([CHARM_HP]);
  });
});

describe("a cast that takes time", () => {
  const HURT_HP = 10;

  it.each([
    ["slow-mend-stone", CAST_MS],
    ["quick-mend-stone", QUICK_CAST_MS],
  ])("does nothing at all until the bar fills: %s", (stone, castMs) => {
    const play = session({ charm: stone });
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();
    const castTicks = Math.ceil(castMs / TICK_MS);

    expect(play.cast(squareSlot("charm"))).toBe(true);
    run(play, castTicks - 1);
    expect(hpOf(play)).toBe(HURT_HP);

    run(play, 1);
    expect(hpOf(play)).toBe(HURT_HP + MEND_HP);
  });

  it("spends nothing when it is pressed, and everything when it lands", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();
    play.cast(squareSlot("charm"));

    expect(coolingIn(play, "charm")).toBeUndefined();

    run(play, CAST_TICKS);
    expect(coolingIn(play, "charm")).toBe(MEND_COOLDOWN_MS);
  });

  it("makes the stone's noise when the bar fills, and says nothing at the press", () => {
    const play = session({ charm: "slow-flame-stone" });

    play.cast(squareSlot("charm"));
    expect(play.drainSpeech()).toEqual([]);
    expect(play.drainNoise()).toEqual([]);

    run(play, CAST_TICKS);
    expect(play.drainSpeech()).toEqual([]);
    expect(play.drainNoise().map((noise) => noise.text)).toEqual(["whoosh"]);
  });

  it("makes it at once for an instant spell", () => {
    const play = session({ charm: "flame-stone" });

    play.cast(squareSlot("charm"));

    expect(play.drainNoise().map((noise) => noise.text)).toEqual(["whoosh"]);
  });

  it("makes it where the caster is standing", () => {
    const play = session({ charm: "flame-stone" });

    play.cast(squareSlot("charm"));

    expect(play.drainNoise()[0]).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it("is silent for a stone with no sound authored, which is most of them", () => {
    const play = session({ charm: "slow-mend-stone" });

    play.cast(squareSlot("charm"));
    run(play, CAST_TICKS);

    expect(play.drainNoise()).toEqual([]);
  });

  it("refuses a second cast while one is running", () => {
    const play = session({
      weapon: "slow-mend-stone",
      offhand: "mend-stone",
    });
    play.cast(squareSlot("weapon"));

    expect(play.cast(squareSlot("offhand"))).toBe(false);
    expect(play.cast(squareSlot("weapon"))).toBe(false);
    expect(play.spells().map((spell) => spell.castability)).toEqual([
      { ok: false, reason: "underway" },
      { ok: false, reason: "casting" },
    ]);
  });

  it("stops when the caster asks, and costs them nothing", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();
    play.cast(squareSlot("charm"));
    run(play, 1);

    expect(play.cancelCast()).toBe(true);
    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(HURT_HP);
    expect(coolingIn(play, "charm")).toBeUndefined();
    expect(play.spells()[0]?.castability).toEqual({ ok: true });
  });

  it("stops nothing when nothing is being cast", () => {
    const play = session({ charm: "slow-mend-stone" });

    expect(play.cancelCast()).toBe(false);
  });

  it("stops quietly, since the caster chose it", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.cast(squareSlot("charm"));
    play.drainNotices();

    play.cancelCast();

    expect(play.drainNotices()).toEqual([]);
  });

  it("can be cast again the moment it is stopped", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.cast(squareSlot("charm"));
    play.cancelCast();

    expect(play.cast(squareSlot("charm"))).toBe(true);
  });

  it("draws a bar everybody can see, and takes it away when it lands", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.cast(squareSlot("charm"));

    const casting = () => play.actorSnapshots().find((actor) => actor.id === "local")?.casting;
    expect(casting()).toEqual({
      remainingMs: CAST_MS,
      durationMs: CAST_MS,
      slot: squareSlot("charm"),
    });

    run(play, CAST_TICKS);
    expect(casting()).toBeNull();
  });

  describe("who it is aimed at", () => {
    const NEAR = { x: 2, y: 0, z: 0 };
    const FAR = { x: 3, y: 0, z: 0 };
    const casting = (play: GameSession) =>
      play.actorSnapshots().find((actor) => actor.id === "local")?.casting;

    it("names the target of a spell that lands on one", () => {
      const play = session({ charm: "slow-flame-stone" }, spawnRat(world(), NEAR));
      play.setTarget(ratAt(play, NEAR));
      play.cast(squareSlot("charm"));

      expect(casting(play)?.targetId).toBe(ratAt(play, NEAR));
    });

    it("names nobody for a spell at the caster's own body", () => {
      const play = session({ charm: "slow-mend-stone" }, spawnRat(world(), NEAR));
      play.setTarget(ratAt(play, NEAR));
      play.cast(squareSlot("charm"));

      expect(casting(play)).toBeTruthy();
      expect(casting(play)).not.toHaveProperty("targetId");
    });

    it("follows the caster's target mid-cast, with a new object the broadcast will send", () => {
      const play = session({ charm: "slow-flame-stone" }, spawnRat(spawnRat(world(), NEAR), FAR));
      play.setTarget(ratAt(play, NEAR));
      play.cast(squareSlot("charm"));
      run(play, 1);
      const before = casting(play);

      play.setTarget(ratAt(play, FAR));
      run(play, 1);
      expect(casting(play)?.targetId).toBe(ratAt(play, FAR));
      expect(casting(play)).not.toBe(before);

      play.setTarget(null);
      run(play, 1);
      expect(casting(play)).not.toHaveProperty("targetId");
    });

    it("keeps the same object while the target holds, so nothing is resent", () => {
      const play = session({ charm: "slow-flame-stone" }, spawnRat(world(), NEAR));
      play.setTarget(ratAt(play, NEAR));
      play.cast(squareSlot("charm"));
      run(play, 1);
      const before = casting(play);

      run(play, 1);
      expect(casting(play)).toBe(before);
    });
  });

  it("is broken by a blow, and costs the caster nothing", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP}`);
    play.cast(squareSlot("charm"));
    run(play, 1);

    play.runCommand(`/health ${PLAYER_MAX_HP - 1}`);
    play.drainNotices();
    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(PLAYER_MAX_HP - 1);
    expect(coolingIn(play, "charm")).toBeUndefined();
  });

  it("says so, rather than leaving the bar to vanish without a word", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${PLAYER_MAX_HP}`);
    play.cast(squareSlot("charm"));
    play.drainNotices();

    play.runCommand(`/health ${PLAYER_MAX_HP - 1}`);

    expect(play.drainNotices()).toContain("Your cast is broken");
  });

  it("is not broken by being healed, which is not a blow", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.cast(squareSlot("charm"));
    play.runCommand(`/health ${HURT_HP + 1}`);
    play.drainNotices();

    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(HURT_HP + 1 + MEND_HP);
  });

  it("finishes through a blow when the stone says it cannot be broken", () => {
    const play = session({ charm: "steady-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.cast(squareSlot("charm"));
    play.runCommand(`/health ${HURT_HP - 1}`);
    play.drainNotices();

    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(HURT_HP - 1 + MEND_HP);
  });

  it("comes to nothing when it can no longer land, and stays ready", () => {
    const play = session({ charm: "slow-flame-stone" });
    play.cast(squareSlot("charm"));

    play.runCommand("/tile wall +1");
    play.drainNotices();
    run(play, CAST_TICKS);

    const stack = getStack(play.getMap(), 1, 0, 0);
    expect(stack.some((placed) => placed.tileId === "conjured-flame")).toBe(false);
    expect(coolingIn(play, "charm")).toBeUndefined();
    expect(play.drainNoise()).toEqual([]);
  });

  it("comes to nothing when the stone has left the hand it was cast from", () => {
    const play = session({ weapon: "slow-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();
    play.cast(squareSlot("weapon"));

    play.moveItem({ kind: "weapon" }, { kind: "offhand" });
    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(HURT_HP);
  });

  it("keeps the world awake until it lands", () => {
    const play = session({ charm: "slow-mend-stone" });
    expect(play.isAtRest()).toBe(true);

    play.cast(squareSlot("charm"));
    play.drainSpeech();

    expect(play.isAtRest()).toBe(false);
  });

  it("plants the caster, and still lets them turn", () => {
    const play = session({ charm: "slow-mend-stone" });
    const before = play.actorSnapshots().find((actor) => actor.id === "local")!;
    play.cast(squareSlot("charm"));

    play.setInput({ directions: ["e"] });
    run(play, CAST_TICKS - 1);

    const during = play.actorSnapshots().find((actor) => actor.id === "local")!;
    expect({ x: during.x, y: during.y }).toEqual({ x: before.x, y: before.y });
    expect(during.walk).toBeNull();
    expect(during.direction).toBe("e");
  });

  it("lets them walk again the moment it lands", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.cast(squareSlot("charm"));
    play.setInput({ directions: ["e"] });
    run(play, CAST_TICKS + 1);

    const after = play.actorSnapshots().find((actor) => actor.id === "local")!;
    expect(after.walk).not.toBeNull();
  });

  it("is dropped when the caster's player leaves the body standing", () => {
    const play = session({ charm: "slow-mend-stone" });
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();
    play.cast(squareSlot("charm"));

    play.standIdle("local");
    run(play, CAST_TICKS);

    expect(hpOf(play)).toBe(HURT_HP);
  });

  it("is quicker for a caster who has outgrown what the stone asks", () => {
    const halfWay = Math.ceil(CAST_MS / 2 / TICK_MS) + 1;

    const casting = (arcane: number) => {
      const play = session({ charm: "apprentice-stone" });
      play.runCommand(`/mastery arcane ${arcane}`);
      play.runCommand(`/health ${HURT_HP}`);
      play.drainNotices();
      play.cast(squareSlot("charm"));
      run(play, halfWay);
      return hpOf(play);
    };

    expect(casting(ADEPT_LEVEL)).toBe(HURT_HP);
    expect(casting(ADEPT_LEVEL + ADEPT_LEVEL / 2)).toBeGreaterThan(HURT_HP);
  });

  it("lands on the press for a caster who has doubled it", () => {
    const play = session({ charm: "apprentice-stone" });
    play.runCommand(`/mastery arcane ${ADEPT_LEVEL * 2}`);
    play.runCommand(`/health ${HURT_HP}`);
    play.drainNotices();

    play.cast(squareSlot("charm"));

    expect(hpOf(play)).toBeGreaterThan(HURT_HP);
  });
});

describe("a spell a body has of its own", () => {
  const BREATH_COOLDOWN_MS = 20_000;

  const BREATH = {
    type: "stone",
    name: "Second wind",
    effect: { kind: "bolt", damage: -MEND_HP, on: "caster" },
    cooldownMs: BREATH_COOLDOWN_MS,
  };

  function casterTile(spells: Record<string, unknown>[]): TileDef {
    const tile = playerTile([]);
    const battler = tile.interactions!.battler as Record<string, unknown>;
    battler.spells = spells;
    return tile;
  }

  function withSpells(spells: Record<string, unknown>[] = [BREATH]) {
    return new GameSession(world(), [...props, casterTile(spells)], {
      statuses: catalogue,
    });
  }

  it("is in the row, after the squares", () => {
    const play = withSpells();
    expect(play.spells().map((spell) => spell.slot)).toEqual([naturalSlot("Second wind")]);
  });

  it("comes after a stone in a hand", () => {
    const tile = casterTile([BREATH]);
    const battler = tile.interactions!.battler as Record<string, unknown>;
    battler.kit = [{ slot: "charm", tileId: "mend-stone", chance: 100 }];
    const play = new GameSession(world(), [...props, tile], {
      statuses: catalogue,
    });
    expect(play.spells().map((spell) => spell.slot)).toEqual([
      squareSlot("charm"),
      naturalSlot("Second wind"),
    ]);
  });

  it("casts, with no hands and nothing carried", () => {
    const play = withSpells();
    play.runCommand("/health -5");
    play.drainNotices();
    const before = hpOf(play)!;

    expect(play.cast(naturalSlot("Second wind"))).toBe(true);
    expect(hpOf(play)).toBeGreaterThan(before);
  });

  it("spends its cooldown on the body, not on a kit", () => {
    const play = withSpells();
    play.cast(naturalSlot("Second wind"));

    expect(play.spellCooldownsOf("local")).toEqual({
      "Second wind": BREATH_COOLDOWN_MS,
    });
    expect(play.equipmentOf("local")?.charm ?? null).toBeNull();
  });

  it("refuses a second press while it is cooling", () => {
    const play = withSpells();
    play.cast(naturalSlot("Second wind"));
    play.drainNotices();

    expect(play.cast(naturalSlot("Second wind"))).toBe(false);
    expect(play.spells()[0]?.castability).toEqual({
      ok: false,
      reason: "cooling",
    });
  });

  it("winds down at the second, as a stone's does", () => {
    const play = withSpells();
    play.cast(naturalSlot("Second wind"));

    run(play, TICKS_PER_SECOND);
    expect(play.spellCooldownsOf("local")).toEqual({
      "Second wind": BREATH_COOLDOWN_MS - 1000,
    });
  });

  it("clears the name entirely once it is ready again", () => {
    const play = withSpells();
    play.cast(naturalSlot("Second wind"));

    run(play, TICKS_PER_SECOND * (BREATH_COOLDOWN_MS / 1000));
    expect(play.spellCooldownsOf("local")).toEqual({});
    expect(play.cast(naturalSlot("Second wind"))).toBe(true);
  });

  it("refuses a name this body has no spell for", () => {
    const play = withSpells();
    expect(play.cast(naturalSlot("Third wind"))).toBe(false);
  });

  it("is not a battler at all when a spell has no name", () => {
    const play = withSpells([{ ...BREATH, name: "" }]);
    expect(play.spells()).toEqual([]);
  });
});

describe("what a bolt tells the body it lands on", () => {
  function skittishTile(): TileDef {
    const tile = body("skittish", RAT_TOUGHNESS, { actor: true });
    tile.interactions!.brain = {
      initial: "grazing",
      states: {
        grazing: { do: [{ action: "hold" }] },
        fleeing: {
          do: [
            {
              action: "step_away_from",
              of: { type: "slot", data: { name: "spooked" } },
            },
            { action: "hold" },
          ],
        },
      },
      transitions: [
        {
          from: "any",
          if: { cond: "attacked" },
          bind: { spooked: { type: "attacker" } },
          to: "fleeing",
        },
      ],
    };
    return tile;
  }

  function beside(stoneId: string): GameSession {
    const map = replaceStack(world(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "skittish", direction: "w" },
    ]);
    return new GameSession(
      map,
      [...props, playerTile([{ slot: "charm", tileId: stoneId }]), skittishTile()],
      {
        statuses: catalogue,
      },
    );
  }

  const skittish = (play: GameSession) =>
    play.actorSnapshots().find((actor) => actor.tileId === "skittish")!;

  it("sends it running from a bolt that hurts", () => {
    const play = beside("bolt-stone");
    const before = skittish(play).x;

    play.setTarget(skittish(play).id);
    play.cast(squareSlot("charm"));
    run(play, TICKS_PER_SECOND * 2);

    expect(skittish(play).x).toBeGreaterThan(before);
  });

  it("sends it running from a bolt that only leaves a status", () => {
    const play = beside("hold-stone");
    const before = skittish(play).x;

    play.setTarget(skittish(play).id);
    play.cast(squareSlot("charm"));
    run(play, TICKS_PER_SECOND * 2);

    expect(skittish(play).x).toBeGreaterThan(before);
  });

  it("says nothing to anybody when the bolt lands on its caster", () => {
    const play = beside("mend-stone");
    const before = skittish(play).x;

    play.setTarget(skittish(play).id);
    play.runCommand("/health -5");
    play.drainNotices();
    play.cast(squareSlot("charm"));
    run(play, TICKS_PER_SECOND * 2);

    expect(skittish(play).x).toBe(before);
  });
});

describe("a creature casting a spell of its own", () => {
  const BOLT = 6;

  function casterTile(): TileDef {
    const tile = body("burner", RAT_TOUGHNESS, { actor: true });
    const battler = tile.interactions!.battler as Record<string, unknown>;
    battler.spells = [
      {
        type: "stone",
        name: "Ember",
        effect: {
          kind: "bolt",
          on: "target",
          damage: BOLT,
          reach: { cells: 4, height: 2 },
        },
        cooldownMs: 30_000,
        reach: { cells: 4, height: 2 },
      },
    ];
    tile.interactions!.brain = {
      initial: "hunting",
      states: {
        hunting: {
          do: [
            {
              action: "cast",
              spell: 1,
              of: { type: "nearest", data: { tileIds: ["player"] } },
            },
            { action: "hold" },
          ],
        },
      },
      transitions: [],
    };
    return tile;
  }

  function burning(): GameSession {
    const map = replaceStack(world(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "burner", direction: "w" },
    ]);
    return new GameSession(map, [...props, playerTile([]), casterTile()], {
      statuses: catalogue,
    });
  }

  it("casts whatever sits at the position, whatever it is called", () => {
    const tile = casterTile();
    const battler = tile.interactions!.battler as Record<string, unknown>;
    const spells = battler.spells as Array<Record<string, unknown>>;
    spells[0]!.name = "Something else entirely";

    const map = replaceStack(world(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "burner", direction: "w" },
    ]);
    const play = new GameSession(map, [...props, playerTile([]), tile], {
      statuses: catalogue,
    });
    const before = hpOf(play)!;

    run(play, TICKS_PER_SECOND);

    expect(hpOf(play)).toBeLessThan(before);
  });

  it("does nothing at a position this body has no spell at", () => {
    const tile = casterTile();
    const brain = tile.interactions!.brain as {
      states: Record<string, { do: Array<Record<string, unknown>> }>;
    };
    brain.states.hunting!.do[0]!.spell = 4;

    const map = replaceStack(world(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "burner", direction: "w" },
    ]);
    const play = new GameSession(map, [...props, playerTile([]), tile], {
      statuses: catalogue,
    });
    const before = hpOf(play)!;

    run(play, TICKS_PER_SECOND);

    expect(hpOf(play)).toBe(before);
  });

  it("burns whoever its brain aimed at", () => {
    const play = burning();
    const before = hpOf(play)!;

    run(play, TICKS_PER_SECOND);

    expect(hpOf(play)).toBeLessThan(before);
  });

  it("spends its own cooldown rather than a kit's", () => {
    const play = burning();
    run(play, TICKS_PER_SECOND);

    const burner = play.actorSnapshots().find((actor) => actor.tileId === "burner")!;
    expect(play.spellCooldownsOf(burner.id)?.Ember).toBeGreaterThan(0);
    expect(play.equipmentOf(burner.id)?.charm ?? null).toBeNull();
  });
});

describe("a creature casting with no target", () => {
  const MEND = 1;
  const EMBER = 2;

  function casterTile(lines: BrainActionDef[]): TileDef {
    const tile = body("mender", RAT_TOUGHNESS, { actor: true });
    const battler = tile.interactions!.battler as Record<string, unknown>;
    battler.spells = [
      {
        type: "stone",
        name: "Mend",
        effect: { kind: "bolt", on: "caster", damage: -MEND_HP },
        cooldownMs: MEND_COOLDOWN_MS,
      },
      {
        type: "stone",
        name: "Ember",
        effect: { kind: "bolt", on: "target", damage: BOLT_DAMAGE, reach: { cells: 4, height: 2 } },
        cooldownMs: 30_000,
        reach: { cells: 4, height: 2 },
      },
    ];
    tile.interactions!.brain = {
      initial: "casting",
      states: { casting: { do: [...lines, { action: "hold" }] } },
      transitions: [],
    };
    return tile;
  }

  function pointedAtPlayer(lines: BrainActionDef[]) {
    const map = replaceStack(world(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "mender", direction: "w" },
    ]);
    const play = new GameSession(map, [...props, playerTile([]), casterTile(lines)], {
      statuses: catalogue,
    });
    const mender = play.actorSnapshots().find((actor) => actor.tileId === "mender")!.id;
    play.setTarget("local", mender);
    return { play, mender };
  }

  it("casts a spell on its caster and keeps the target it had", () => {
    const { play, mender } = pointedAtPlayer([{ action: "cast", spell: MEND }]);

    run(play, TICKS_PER_SECOND);

    expect(play.spellCooldownsOf(mender)?.Mend).toBeGreaterThan(0);
    expect(play.getSnapshot(mender).targetId).toBe("local");
  });

  it("refuses a spell that needs a target, so the line falls through", () => {
    const { play, mender } = pointedAtPlayer([
      { action: "cast", spell: EMBER },
      { action: "cast", spell: MEND },
    ]);
    const before = hpOf(play)!;

    run(play, TICKS_PER_SECOND);

    expect(play.spellCooldownsOf(mender)?.Ember).toBeUndefined();
    expect(play.spellCooldownsOf(mender)?.Mend).toBeGreaterThan(0);
    expect(hpOf(play)).toBe(before);
  });

  it("lays a conjure with no target in front of itself", () => {
    const layer = casterTile([]);
    const battler = layer.interactions!.battler as Record<string, unknown>;
    battler.spells = [
      {
        type: "stone",
        name: "Kindle",
        effect: { kind: "conjure", tileId: "conjured-flame" },
        cooldownMs: 30_000,
      },
    ];
    layer.interactions!.brain = {
      initial: "casting",
      states: { casting: { do: [{ action: "cast", spell: 1 }, { action: "hold" }] } },
      transitions: [],
    };
    const map = replaceStack(world(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "mender", direction: "e" },
    ]);
    const play = new GameSession(map, [...props, playerTile([]), layer], { statuses: catalogue });

    run(play, TICKS_PER_SECOND);

    expect(getStack(play.getMap(), 3, 0, 0).map((p) => p.tileId)).toContain("conjured-flame");
  });

  it("ignores an `of` on a spell that lands on its caster", () => {
    const { play, mender } = pointedAtPlayer([
      { action: "cast", spell: MEND, of: { type: "home" } },
    ]);

    run(play, TICKS_PER_SECOND);

    expect(play.spellCooldownsOf(mender)?.Mend).toBeGreaterThan(0);
    expect(play.getSnapshot(mender).targetId).toBe("local");
  });
});

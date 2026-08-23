import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { maxHpFrom } from "../lib/battler";
import { type StatusGrant, DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { BRAIN_TICK_MS, NOISE_LIFETIME_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { statusesById } from "../lib/status";

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content now, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

/**
 * Eating and drinking, as the session runs them.
 *
 * The item rules have their own files; this is about what a consume *does* —
 * the thing stops existing, the hit points move, and both refusals and deaths
 * land on the same paths every other cause of them uses.
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

/**
 * The Toughness these tests count their hit points in, and the maximum it now
 * buys.
 *
 * **Derived rather than pinned.** It used to be the other way round — a hundred
 * hit points written as `PLAYER_MAX_HP - 8` Toughness — which was exact only for
 * as long as a point of Toughness was worth exactly one hit point. It is not any
 * more: the curve accelerates, so the last points are worth three each. See
 * `../lib/battler`'s `maxHpFrom`.
 */
const PLAYER_TOUGHNESS = 92;
const PLAYER_MAX_HP = maxHpFrom(PLAYER_TOUGHNESS);

/** A consumable that grants statuses instead of moving hit points on the spot. */
function granter(id: string, statuses: StatusGrant[]): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Eat", hp: 0, statuses },
    },
  });
}

function consumable(id: string, hp: number, sound?: string): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Eat", hp, ...(sound ? { sound } : {}) },
    },
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  // Something with volume, which is what it takes to bury a thing: a flat tile
  // lying on top of another one hides nothing.
  tile({ id: "crate", height: 1 }),
  tile({
    id: "player",
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: { type: "weapon", damage: 5, def: 0, accuracy: 100, variance: 0, spd: 100, mastery: "fist" },
        // Where the bag on a player's back comes from — see `app/lib/kit.ts`.
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER } },
  }),
  consumable("cherry", 5, "crunch"),
  consumable("poison", -10, "glug"),
  consumable("hemlock", -PLAYER_MAX_HP, "glug"),
  // Authored with no noise, which is every consumable until somebody writes one.
  consumable("quiet-cherry", 5),
  // The berry as `data/tiles.json` now authors it: no instant heal at all.
  granter("berry", [{ id: "fed" }]),
  granter("mystery-fruit", [{ id: "no-such-status" }]),
  // The same status, authored to last far longer — a loaf against a berry.
  granter("bread", [{ id: "fed", fromMs: 60_000, toMs: 60_000 }]),
  ...normalizeTiles(tilesJson as unknown[]).filter((t) => t.id === "green-potion"),
  tile({
    id: "sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", damage: 1, def: 0, accuracy: 100, variance: 0, spd: 50, mastery: "blade" },
    },
  }),
  tile({
    id: "chest",
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER, size: 2, equippable: false } },
  }),
];

/** Open grass with the player at the origin. */
function field(half = 4): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
}

function withItem(x: number, y: number, tileId: string): GameSession {
  const map = replaceStack(field(), x, y, 0, [
    { tileId: "grass" },
    { tileId },
  ]);
  return new GameSession(map, tiles);
}

function refAt(session: GameSession, x: number, y: number) {
  const stack = getStack(session.getMap(), x, y, 0);
  return { x, y, z: 0, stackIndex: stack.length - 1 };
}

function hpOf(session: GameSession): number | null {
  return (
    session.actorSnapshots().find((a) => a.tileId === "player")?.hp ?? null
  );
}

function tilesAt(session: GameSession, x: number, y: number): string[] {
  return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
}

describe("eating off the floor", () => {
  it("takes the thing off the board without it ever entering the bag", () => {
    const session = withItem(1, 0, "cherry");
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    // Nothing entered the kit, so there is nothing to announce.
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("heals by what the tile says, up to the body's own maximum", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
  });

  it("never heals past full, and still spends the item", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  // Poison rides the damage path, so it shows its number like a blow does —
  // one codepath for losing hit points, however they were lost.
  it("shows poison as a damage number", () => {
    const session = withItem(1, 0, "poison");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const fresh = session.getSnapshot().damage.filter((d) => d.elapsedMs === 0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.amount).toBe(10);
  });

  it("kills through the same death every blow uses", () => {
    const session = withItem(1, 0, "hemlock");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );

    expect(session.actorSnapshots()).toEqual([]);
    // The body is off the board too, not just the runtime — and what it was
    // carrying is on the floor where it fell, poison being a death like any
    // other.
    expect(tilesAt(session, 0, 0)).toEqual(["grass", "basic-bag"]);
  });

  it("refuses one two cells away", () => {
    const session = withItem(2, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 2, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 2, 0)).toEqual(["grass", "cherry"]);
  });

  it("refuses one buried under something else", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "cherry" },
      { tileId: "crate" },
    ]);
    const session = new GameSession(map, tiles);
    expect(
      session.consume({ kind: "floor", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } }),
    ).toBe(false);
  });

  it("refuses a thing that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "sword"]);
  });

  it("has nothing to say for an actor who is not here", () => {
    const session = withItem(1, 0, "cherry");
    expect(
      session.consume({ kind: "floor", ref: refAt(session, 1, 0) }, "nobody"),
    ).toBe(false);
  });
});

describe("eating out of a slot", () => {
  it("spends the thing in the bag and announces the kit change once", () => {
    const session = withItem(1, 0, "cherry");
    session.pickUp(refAt(session, 1, 0));
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(
      true,
    );
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    expect(session.drainEquipmentChanges()).toEqual([
      session.getSnapshot().self.id,
    ]);
  });

  it("moves the hit points exactly as a floor meal does", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("eats straight out of a chest on the floor, rewriting its placement", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    session.drainEquipmentChanges();
    const chest = refAt(session, 1, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(true);
    expect(getStack(session.getMap(), 1, 0, 0)[1]!.contents).toEqual([]);
    // The chest's placement changed and nobody's kit did.
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("refuses a chest the player has walked away from", () => {
    const map = replaceStack(field(), 3, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 3, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(false);
    expect(getStack(session.getMap(), 3, 0, 0)[1]!.contents).toHaveLength(1);
  });

  it("refuses a slot holding something that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    session.pickUp(refAt(session, 1, 0));

    expect(
      session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } }),
    ).toBe(false);
    expect(session.getSnapshot().equipment.bag?.contents).toHaveLength(1);
  });

  it("refuses an empty slot", () => {
    const session = new GameSession(field(), tiles);
    expect(
      session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } }),
    ).toBe(false);
  });
});

/**
 * The noise it makes, and who hears it.
 *
 * A sound goes out on the noise channel and never on the speech one, which is
 * the distinction the channel exists for: biting an apple is not the eater
 * saying anything, so nothing may arrive attributed to them.
 */
describe("the noise a consumable makes", () => {
  it("makes it where it was eaten, with nobody's name on it", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const heard = session.drainNoise();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.text).toBe("crunch");
    // Made at the eater's own cell, not at the cell the cherry was in.
    expect({ x: heard[0]!.x, y: heard[0]!.y, z: heard[0]!.z }).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    // Nothing on the channel that names a speaker. This is the assertion the
    // whole feature turns on: a crunch must never become "somebody says:
    // crunch", and the only way to guarantee that is for speech to stay empty.
    expect(session.drainSpeech()).toEqual([]);
  });

  /** No speaker to carry, so the shape has no room for one. */
  it("carries no actor or tile to be named by", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const noise = session.drainNoise()[0]!;
    expect(noise).not.toHaveProperty("actorId");
    expect(noise).not.toHaveProperty("tileId");
  });

  it("makes it when the meal came out of a bag too", () => {
    const session = withItem(1, 0, "cherry");
    session.pickUp(refAt(session, 1, 0));
    session.drainNoise();

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(session.drainNoise().map((s) => s.text)).toEqual(["crunch"]);
  });

  it("stays silent for one with no noise authored on it", () => {
    const session = withItem(1, 0, "quiet-cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    expect(session.drainNoise()).toEqual([]);
  });

  /**
   * The ordering that matters: `kill` takes the body off the board, so a sound
   * recorded after the hit points would have nowhere to hang and would be
   * dropped. Recorded first, a last gulp still reaches the room.
   */
  it("still sounds when the drink is the one that kills you", () => {
    const session = withItem(1, 0, "hemlock");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    expect(session.actorSnapshots()).toEqual([]);
    expect(session.drainNoise().map((s) => s.text)).toEqual(["glug"]);
  });

  it("makes none when the consume was refused", () => {
    const session = withItem(2, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 2, 0) });

    expect(session.drainNoise()).toEqual([]);
  });

  /**
   * Why the server flushes on input rather than only on the clock.
   *
   * A consume arrives *between* ticks, and `tick` empties the pending page at
   * its top — so anything recorded by one and not drained before the next tick
   * never reaches the wire. `GameServer.flushSounds` is what drains it in time;
   * this pins the hazard that makes it necessary, so removing it fails here
   * rather than going quiet in production.
   */
  it("leaves the wire's copy behind at the next tick", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    session.tick();
    expect(session.drainNoise()).toEqual([]);
  });

  /**
   * The simulation's third copy, which is neither of the other two: it carries
   * who made the sound, it is never drawn, and it empties on the slower brain
   * clock so a creature deciding once every few ticks does not miss it.
   *
   * Provable here and nowhere else in the tests, because nothing in this file
   * has a brain — a world with any wildlife in it is held awake by the clause
   * that keeps their timers running, which would swallow the assertion whole.
   */
  it("keeps the world awake until the brains have had a turn at it", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.isAtRest()).toBe(true);

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(session.isAtRest()).toBe(false);

    // One round of decisions is all it takes, after which the crunch is gone
    // rather than lying about waiting to be heard a second time.
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }
    expect(session.isAtRest()).toBe(true);
  });

  /**
   * The half a local viewer reads, which outlives the wire's copy on purpose:
   * a single-player world has nobody to broadcast to and still has to hear its
   * own snakes. This is the gap speech has never closed.
   */
  it("is still on screen after the tick that cleared the wire's copy", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    session.tick();
    expect(session.getSnapshot().noises.map((n) => n.text)).toEqual(["crunch"]);
  });

  it("fades out of the snapshot once its time is up", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    for (let elapsed = 0; elapsed <= NOISE_LIFETIME_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }
    expect(session.getSnapshot().noises).toEqual([]);
  });
});

/**
 * A body with no hit points cannot be fed. The check runs before anything is
 * destroyed, so the refusal costs nothing — better an inert cherry than one
 * wasted on a body the number cannot land on.
 */
describe("a consumer with no hit points", () => {
  const ghostTiles = tiles.map((t) =>
    t.id === "player" ? { ...t, kind: "prop" as const } : t,
  );

  it("refuses, and the thing is still there", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "cherry" },
    ]);
    const session = new GameSession(map, ghostTiles);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "cherry"]);
  });
});


/**
 * A consumable that hands over a status instead of moving hit points.
 *
 * The berry, end to end and as authored: `data/statuses.json`'s Fed against
 * `data/tiles.json`'s berry, through the same `statusesById` the routes use, so
 * a typo in either file fails here rather than in a browser.
 */
describe("eating something that grants a status", () => {
  /** Fixed ends, so the roll is a constant and the arithmetic below is exact. */
  const FED_MS = 10_000;

  const catalogue = statusesById([
    {
      id: "fed",
      name: "Fed",
      description: "Slowly recovering health.",
      tone: "good",
      icon: { tilesetId: "ultima-vi", rect: { x: 48, y: 20, w: 1, h: 1 } },
      fromMs: FED_MS,
      toMs: FED_MS,
      stacks: true,
      maxMs: 3_600_000,
      everyMs: 1_000,
      effects: { hp: "ceil(MAX_HP / 100)" },
    },
  ]);

  /**
   * A berry to the east and a poison to the north.
   *
   * The poison is not decoration: a body at full health has nothing to recover,
   * so every assertion about healing would pass against a `Fed` that did
   * absolutely nothing. Wounding first is what makes the numbers below mean
   * something.
   */
  function fedWorld(): GameSession {
    let map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "berry" },
    ]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  /** Take the poison to the north, leaving the body ten points down. */
  function wound(session: GameSession) {
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
  }

  /** Run whole seconds through the session's own fixed tick. */
  function runSeconds(session: GameSession, seconds: number) {
    for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) {
      session.tick(TICK_MS);
    }
  }

  it("moves no hit points on the tick it is eaten", () => {
    const session = fedWorld();
    wound(session);
    const before = hpOf(session);
    expect(before).toBe(PLAYER_MAX_HP - 10);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(hpOf(session)).toBe(before);
    expect(session.statusesOf("local")?.map((s) => s.defId)).toEqual(["fed"]);
  });

  it("heals one a second, rounded up, for as long as it runs", () => {
    const session = fedWorld();
    wound(session);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    const start = hpOf(session)!;

    runSeconds(session, 3);
    // The authored formula is `ceil(MAX_HP / 100)`, paid once a second — so the
    // figure is read off the maximum rather than typed, since Toughness no
    // longer buys a hit point a point and the maximum moves with its curve.
    const perSecond = Math.ceil(PLAYER_MAX_HP / 100);
    expect(hpOf(session)).toBe(start + perSecond * 3);
  });

  /** The cap still holds: a berry cannot make anybody overfull. */
  it("stops at the maximum", () => {
    const session = fedWorld();
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    runSeconds(session, 5);
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });

  it("runs out, and stops", () => {
    const session = fedWorld();
    wound(session);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    runSeconds(session, FED_MS / 1000);

    expect(session.statusesOf("local")).toEqual([]);
    // Ten seconds of Fed against ten points of poison, which is the whole of it.
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });

  it("stacks a second helping onto what is left", () => {
    const map = replaceStack(
      replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]),
      0,
      1,
      0,
      [{ tileId: "grass" }, { tileId: "berry" }],
    );
    const session = new GameSession(map, tiles, { statuses: catalogue });
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
    expect(session.statusesOf("local")).toHaveLength(1);
    expect(session.statusesOf("local")![0]!.remainingMs).toBe(FED_MS * 2);
  });

  /**
   * **The reason the range lives on the item.** Bread and a berry leave you
   * with the same condition and differ only in how much of it — expressing that
   * with a second status would put two identical rows in the panel, refusing to
   * stack with each other.
   */
  it("takes the item's duration over the status's own", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bread" },
    ]);
    const session = new GameSession(map, tiles, { statuses: catalogue });

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    // 60s from the loaf, not the 10s the status itself is authored at.
    expect(session.statusesOf("local")![0]!.remainingMs).toBe(60_000);
  });

  /** And stacking is what makes the pair worth having: one Fed, longer. */
  it("stacks a meal onto a snack as one status", () => {
    const map = replaceStack(
      replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]),
      0,
      1,
      0,
      [{ tileId: "grass" }, { tileId: "bread" }],
    );
    const session = new GameSession(map, tiles, { statuses: catalogue });

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });

    expect(session.statusesOf("local")).toHaveLength(1);
    expect(session.statusesOf("local")![0]!.remainingMs).toBe(FED_MS + 60_000);
  });

  /**
   * Renamed content reads as an effect that did not happen, never as a world
   * that will not start — the same rule a reward naming a missing tile is under.
   */
  it("eats an item naming a status nobody authored, and does nothing", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "mystery-fruit" },
    ]);
    const session = new GameSession(map, tiles, { statuses: catalogue });
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(session.statusesOf("local")).toEqual([]);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });
});

/**
 * The green potion, end to end and as authored: `data/tiles.json` against
 * `data/statuses.json`'s poison, so a typo in either file fails here rather
 * than in a browser.
 */
describe("drinking the green potion, as authored", () => {
  const catalogue = statusesById(statusesJson);

  function potionWorld(): GameSession {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "green-potion" },
    ]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  it("grants poison and spends the bottle", () => {
    const session = potionWorld();
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    const held = session.statusesOf("local");
    expect(held?.map((s) => s.defId)).toEqual(["poison"]);
    expect(held![0]!.remainingMs).toBeGreaterThanOrEqual(10_000);
    expect(held![0]!.remainingMs).toBeLessThanOrEqual(30_000);
  });

  it("moves no hit points on the tick it is drunk", () => {
    const session = potionWorld();
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });
});

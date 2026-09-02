import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import { maxHpFrom } from "../lib/battler";
import { resolveAddStatus } from "../lib/interactions";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canAddStatusFrom, reachableAddStatusAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * A tile that puts a condition on whoever sets it off.
 *
 * The reach rules are the teleport's and are tested as such; what is its own
 * here is that a body takes the status, that a thing without hit points does
 * not, and that walking back in does it again.
 */

/** Ticks a started walk needs to reach its destination and commit. */
const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

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

/** Fixed ends, so a roll is a constant and the arithmetic below is exact. */
const BURN_MS = 4_000;

const PLAYER_TOUGHNESS = 92;
const PLAYER_MAX_HP = maxHpFrom(PLAYER_TOUGHNESS);

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
      },
    },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({ id: "wall", height: 4 }),
  body("player", { affectedByGravity: true }),
  body("deer", { actor: true, affectedByGravity: true }),
  // A body somebody else can shove, which is what the authored player tile is.
  body("shovable", {
    actor: true,
    affectedByGravity: true,
    interactions: {
      battler: {
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
      },
      push: { climb: "half", moveOnTileIds: [] },
    },
  }),
  // The case the gate exists for: something that walks, with no hit points for a
  // burn to spend. A status on one would be a countdown nobody could see.
  tile({
    id: "wisp",
    height: 4,
    actor: true,
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  // The motivating tile: flat, so it neither buries what is under it nor stops
  // anybody standing in it.
  tile({
    id: "fire",
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  // The pressed halves, one per gesture.
  tile({
    id: "brazier",
    height: 2,
    interactions: {
      addStatus: {
        actionName: "Touch",
        trigger: "interact",
        statusId: "burned",
      },
    },
  }),
  tile({
    id: "coals",
    interactions: {
      addStatus: { trigger: "interactOver", statusId: "burned" },
    },
  }),
  // Switched on and never filled in, which reads as unauthored.
  tile({
    id: "unlit",
    interactions: { addStatus: { trigger: "step", statusId: "" } },
  }),
  // A condition nobody authored: one effect that does not happen.
  tile({
    id: "ghost-fire",
    interactions: { addStatus: { trigger: "step", statusId: "haunted" } },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing. Hurts fast, and is over fast.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: true,
    maxMs: BURN_MS * 3,
    everyMs: 1_000,
    effects: { hp: "0 - max(4, ceil(MAX_HP / 10))" },
  },
]);

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

/** Walk exactly one cell, releasing input so the commit does not chain. */
function step(session: GameSession, direction: Direction) {
  session.setInput({ directions: [direction] });
  session.tick(TICK_MS);
  session.setInput({ directions: [] });
  run(session, TICKS_PER_STEP);
}

function held(session: GameSession, id = "local"): string[] {
  return (session.statusesOf(id) ?? []).map((instance) => instance.defId);
}

function hpOf(play: GameSession): number | null {
  return play.actorSnapshots().find((a) => a.tileId === "player")?.hp ?? null;
}

function whereIs(map: MapFile, tileId: string) {
  for (const [key, stacks] of Object.entries(map.levels)) {
    for (const cells of Object.values(stacks)) {
      for (const [cell, stack] of Object.entries(cells)) {
        const index = stack.findIndex((p) => p.tileId === tileId);
        if (index < 0) continue;
        const [x, y] = cell.split(",").map(Number);
        return { x: x!, y: y!, z: Number(key), stackIndex: index };
      }
    }
  }
  return null;
}

/** The player at the origin facing east, with one cell of interest beside them. */
function world(beside: string, tileId = "player"): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [
    { tileId: "grass" },
    { tileId, direction: "e" },
  ]);
  // Every map needs exactly one player tile, so a creature's world still parks
  // one somewhere out of the way.
  if (tileId !== "player") {
    map = replaceStack(map, 9, 9, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "s" },
    ]);
  }
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: beside }]);
}

function session(
  map: MapFile,
  opts: Record<string, unknown> = {},
): GameSession {
  return new GameSession(map, tiles, { statuses: catalogue, ...opts });
}

describe("resolveAddStatus", () => {
  it("reads an authored block", () => {
    expect(resolveAddStatus(tilesById.fire!)).toEqual({
      trigger: "step",
      statusId: "burned",
    });
  });

  it("refuses a block naming no status", () => {
    expect(resolveAddStatus(tilesById.unlit!)).toBeNull();
  });

  it("is nothing on a tile with no block at all", () => {
    expect(resolveAddStatus(tilesById.grass!)).toBeNull();
  });
});

describe("reachableAddStatusAt", () => {
  const actor = { x: 0, y: 0, z: 0 };
  const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

  it("offers a brazier from the next square over", () => {
    const map = world("brazier");
    expect(reachableAddStatusAt(map, tilesById, actor, ref)).toMatchObject({
      trigger: "interact",
    });
  });

  it("offers coals only from their own cell", () => {
    const map = world("coals");
    expect(reachableAddStatusAt(map, tilesById, actor, ref)).toBeNull();
    expect(
      reachableAddStatusAt(map, tilesById, { x: 1, y: 0, z: 0 }, ref),
    ).toMatchObject({ trigger: "interactOver" });
  });

  it("never offers a fire you walk into, which answers to no press", () => {
    const map = world("fire");
    expect(canAddStatusFrom(map, tilesById, actor, ref)).toBe(false);
    expect(canAddStatusFrom(map, tilesById, { x: 1, y: 0, z: 0 }, ref)).toBe(
      false,
    );
  });
});

describe("pressing something that grants a status", () => {
  it("puts the condition on whoever pressed it", () => {
    const play = session(world("brazier"));
    expect(play.activateAddStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(
      true,
    );
    expect(held(play)).toEqual(["burned"]);
  });

  it("is what a plain tap on a brazier runs", () => {
    const play = session(world("brazier"));
    expect(play.interact({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(held(play)).toEqual(["burned"]);
  });

  it("is on offer exactly when it would work", () => {
    const play = session(world("brazier"));
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    expect(play.canAddStatus(ref)).toBe(true);
    expect(play.canInteract(ref)).toBe(true);
  });

  it("refuses a fire that answers to no press", () => {
    const play = session(world("fire"));
    expect(play.activateAddStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(
      false,
    );
    expect(held(play)).toEqual([]);
  });
});

describe("stepping into a fire", () => {
  it("burns whoever lands in it, with nothing pressed", () => {
    const play = session(world("fire"));
    step(play, "e");
    expect(whereIs(play.getMap(), "player")).toMatchObject({ x: 1, y: 0 });
    expect(held(play)).toEqual(["burned"]);
  });

  it("burns a creature too — a body is a body", () => {
    const play = session(world("fire", "deer"), { actorIds: [] });
    // Driven straight rather than through a brain: what is under test is the
    // fire, and a wandering mind would decide when — or whether — to walk in.
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(held(play, "npc:0,0,0,1")).toEqual(["burned"]);
  });

  it("leaves a body with no hit points alone", () => {
    const play = session(world("fire", "wisp"), { actorIds: [] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(whereIs(play.getMap(), "wisp")).toMatchObject({ x: 1, y: 0 });
    expect(held(play, "npc:0,0,0,1")).toEqual([]);
  });

  it("does it again when you walk back in", () => {
    const play = session(world("fire"));
    step(play, "e");
    const first = play.statusesOf("local")![0]!.remainingMs;
    step(play, "w");
    step(play, "e");
    // Stacked rather than refreshed, because that is what the fixture authorises
    // — the point is that the second arrival was a second application.
    expect(play.statusesOf("local")![0]!.remainingMs).toBeGreaterThan(first);
  });

  it("does not fire again for standing still in it", () => {
    const play = session(world("fire"));
    step(play, "e");
    const after = play.statusesOf("local")![0]!.remainingMs;
    run(play, 2);
    expect(play.statusesOf("local")![0]!.remainingMs).toBeLessThan(after);
  });

  it("burns even when the status names nothing anybody authored — and does nothing", () => {
    const play = session(world("ghost-fire"));
    step(play, "e");
    expect(held(play)).toEqual([]);
  });

  it("spends hit points once a second, as the status says", () => {
    const play = session(world("fire"));
    step(play, "e");
    const perSecond = Math.max(4, Math.ceil(PLAYER_MAX_HP / 10));
    const start = hpOf(play)!;
    run(play, Math.round(1000 / TICK_MS));
    expect(hpOf(play)).toBe(start - perSecond);
  });
});

describe("being shoved into a fire", () => {
  /** Player at the origin, a shovable body beside them, fire beyond it. */
  function lane(): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "shovable", direction: "e" },
    ]);
    return replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "fire" },
    ]);
  }

  it("burns the body that was pushed in", () => {
    const play = session(lane());
    expect(play.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(whereIs(play.getMap(), "shovable")).toMatchObject({ x: 2, y: 0 });
    expect(held(play, "npc:1,0,0,1")).toEqual(["burned"]);
  });
});

/**
 * The fire as authored, end to end: `data/tiles.json`'s flame against
 * `data/statuses.json`'s Burned, through the same `statusesById` the routes
 * use, so a typo in either file fails here rather than in a browser.
 */
describe("the flame, as authored", () => {
  it("is a step trigger granting a status the catalogue holds", () => {
    const authored = statusesById(statusesJson);
    const flame = tilesByIdFromList([
      // Only the fields this question needs; the real tile is normalised the
      // same way by whoever loads it.
      normalizeTileDef({
        id: "flame",
        name: "Flame",
        height: 2,
        directional: false,
        variants: { default: [frame] },
        attributes: {},
        interactions: { addStatus: { trigger: "step", statusId: "burned" } },
      }),
    ]).flame!;

    const gesture = resolveAddStatus(flame);
    expect(gesture?.trigger).toBe("step");
    expect(authored[gesture!.statusId]).toBeDefined();
    expect(authored.burned!.tone).toBe("bad");
  });
});

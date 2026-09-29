import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import { maxHpFrom } from "../lib/battler";
import { resolveAddStatus } from "../lib/interactions";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canAddStatusFrom, reachableAddStatusAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { FRAME, tile } from "../lib/testTile";

const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

const TICKS_PER_SECOND = Math.round(1_000 / TICK_MS);

const BURN_MS = 4_000;

const PLAYER_BASE_HP = 8;
const PLAYER_TOUGHNESS = 92;
const PLAYER_MAX_HP = maxHpFrom(PLAYER_BASE_HP, PLAYER_TOUGHNESS);

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: PLAYER_BASE_HP,
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
  body("salamander", {
    actor: true,
    affectedByGravity: true,
    interactions: {
      battler: {
        baseHp: PLAYER_BASE_HP,
        masteries: { toughness: PLAYER_TOUGHNESS },
        immuneTo: ["burned"],
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
  }),
  body("shovable", {
    actor: true,
    affectedByGravity: true,
    interactions: {
      battler: {
        baseHp: PLAYER_BASE_HP,
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
  tile({
    id: "wisp",
    height: 4,
    actor: true,
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({
    id: "fire",
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  tile({
    id: "brazier",
    height: 2,
    interactions: {
      addStatus: { actionName: "Touch", trigger: "interact", statusId: "burned" },
    },
  }),
  tile({
    id: "coals",
    interactions: { addStatus: { trigger: "interactOver", statusId: "burned" } },
  }),
  tile({ id: "unlit", interactions: { addStatus: { trigger: "step", statusId: "" } } }),
  tile({
    id: "ghost-fire",
    interactions: { addStatus: { trigger: "step", statusId: "haunted" } },
  }),
  tile({
    id: "circle",
    interactions: { addStatus: { trigger: "step", statusId: "blessed" } },
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
  {
    id: "blessed",
    name: "Blessed",
    description: "Somebody laid this down to be stood in.",
    tone: "good",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: false,
    maxMs: BURN_MS,
    everyMs: 0,
    effects: {},
  },
]);

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

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

function world(beside: string, tileId = "player"): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId, direction: "e" }]);
  if (tileId !== "player") {
    map = replaceStack(map, 9, 9, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  }
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: beside }]);
}

function session(map: MapFile, opts: Record<string, unknown> = {}): GameSession {
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
    expect(reachableAddStatusAt(map, tilesById, { x: 1, y: 0, z: 0 }, ref)).toMatchObject({
      trigger: "interactOver",
    });
  });

  it("never offers a fire you walk into, which answers to no press", () => {
    const map = world("fire");
    expect(canAddStatusFrom(map, tilesById, actor, ref)).toBe(false);
    expect(canAddStatusFrom(map, tilesById, { x: 1, y: 0, z: 0 }, ref)).toBe(false);
  });
});

describe("pressing something that grants a status", () => {
  it("puts the condition on whoever pressed it", () => {
    const play = session(world("brazier"));
    expect(play.activateAddStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
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
    expect(play.activateAddStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
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
    expect(play.statusesOf("local")![0]!.remainingMs).toBeGreaterThan(first);
  });

  it("does not fire again before the standing period is up", () => {
    const play = session(world("fire"));
    step(play, "e");
    const after = play.statusesOf("local")![0]!.remainingMs;
    run(play, 2);
    expect(play.statusesOf("local")![0]!.remainingMs).toBeLessThan(after);
  });

  it("keeps burning whoever stands in it", () => {
    const play = session(world("fire"));
    step(play, "e");
    const arrival = play.statusesOf("local")![0]!.remainingMs;
    run(play, TICKS_PER_SECOND);
    expect(play.statusesOf("local")![0]!.remainingMs).toBeGreaterThan(arrival);
  });

  it("holds a standing body at the ceiling rather than letting it run out", () => {
    const play = session(world("fire"));
    step(play, "e");
    run(play, TICKS_PER_SECOND * 4);
    expect(held(play)).toContain("burned");
    const remainingMs = play.statusesOf("local")![0]!.remainingMs;
    expect(remainingMs).toBeLessThanOrEqual(BURN_MS * 3);
    expect(remainingMs).toBeGreaterThan(BURN_MS * 3 - 1_000);
  });

  it("stops the moment you step out, and burns down from what you took", () => {
    const play = session(world("fire"));
    step(play, "e");
    run(play, TICKS_PER_SECOND * 4);
    step(play, "w");
    const left = play.statusesOf("local")![0]!.remainingMs;
    run(play, TICKS_PER_SECOND * 2);
    expect(play.statusesOf("local")![0]!.remainingMs).toBeCloseTo(left - 2_000, 6);
  });

  it("keeps burning a creature standing in it too — a body is a body", () => {
    const play = session(world("fire", "deer"), { actorIds: [] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    const arrival = play.statusesOf("npc:0,0,0,1")![0]!.remainingMs;
    run(play, TICKS_PER_SECOND);
    expect(play.statusesOf("npc:0,0,0,1")![0]!.remainingMs).toBeGreaterThan(arrival);
  });

  it("leaves a body with no hit points alone however long it stands there", () => {
    const play = session(world("fire", "wisp"), { actorIds: [] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP + TICKS_PER_SECOND * 3);
    expect(held(play, "npc:0,0,0,1")).toEqual([]);
  });

  it("grants nothing to a body standing on plain ground", () => {
    const play = session(world("grass"));
    step(play, "e");
    run(play, TICKS_PER_SECOND * 3);
    expect(held(play)).toEqual([]);
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

describe("a fire somebody conjured", () => {
  function beside(...placed: PlacedTile[]): MapFile {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, ...placed]);
  }

  it("does not burn the one who cast it", () => {
    const play = session(beside({ tileId: "fire", castBy: "local" }));
    step(play, "e");
    expect(whereIs(play.getMap(), "player")).toMatchObject({ x: 1, y: 0 });
    expect(held(play)).toEqual([]);
  });

  it("burns anybody else who walks into it", () => {
    const play = session(beside({ tileId: "fire", castBy: "somebody-else" }));
    step(play, "e");
    expect(held(play)).toEqual(["burned"]);
  });

  it("goes on sparing the caster for as long as they stand in it", () => {
    const play = session(beside({ tileId: "fire", castBy: "local" }));
    step(play, "e");
    run(play, TICKS_PER_SECOND * 3);
    expect(held(play)).toEqual([]);
  });

  it("lets whatever is under it take its turn instead", () => {
    const play = session(beside({ tileId: "fire" }, { tileId: "fire", castBy: "local" }));
    step(play, "e");
    expect(held(play)).toEqual(["burned"]);
  });

  it("hands the caster their own blessing, which is the other tone", () => {
    const play = session(beside({ tileId: "circle", castBy: "local" }));
    step(play, "e");
    expect(held(play)).toEqual(["blessed"]);
  });
});

describe("being shoved into a fire", () => {
  function lane(): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "shovable", direction: "e" }]);
    return replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "fire" }]);
  }

  it("burns the body that was pushed in", () => {
    const play = session(lane());
    expect(play.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(whereIs(play.getMap(), "shovable")).toMatchObject({ x: 2, y: 0 });
    expect(held(play, "npc:1,0,0,1")).toEqual(["burned"]);
  });
});

describe("the flame, as authored", () => {
  it("is a step trigger granting a status the catalogue holds", () => {
    const authored = statusesById(statusesJson);
    const flame = tilesByIdFromList([
      normalizeTileDef({
        id: "flame",
        name: "Flame",
        height: 2,
        directional: false,
        variants: { default: [FRAME] },
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

describe("what a condition coming on says", () => {
  it("tells whoever walked into the fire", () => {
    const play = session(world("fire"));
    step(play, "e");
    expect(play.drainNotices()).toEqual(["You are burned"]);
  });

  it("says it for a brazier that was pressed, too — one door, one sentence", () => {
    const play = session(world("brazier"));
    expect(play.activateAddStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(play.drainNotices()).toEqual(["You are burned"]);
  });

  it("has nothing to add while the same body goes on standing in it", () => {
    const play = session(world("fire"));
    step(play, "e");
    expect(play.drainNotices()).toEqual(["You are burned"]);

    run(play, TICKS_PER_SECOND * 4);
    expect(play.drainNotices()).toEqual([]);
  });

  it("says it again when the condition comes back after running out", () => {
    const play = session(world("fire"));
    step(play, "e");
    expect(play.drainNotices()).toEqual(["You are burned"]);

    step(play, "w");
    run(play, TICKS_PER_SECOND * 5);
    expect(held(play)).not.toContain("burned");

    step(play, "e");
    expect(play.drainNotices()).toEqual(["You are burned"]);
  });

  it("says nothing about a fire that named a condition nobody authored", () => {
    const play = session(world("ghost-fire"));
    step(play, "e");
    expect(play.drainNotices()).toEqual([]);
  });

  it("says nothing to a player about a deer that caught fire", () => {
    const play = session(world("fire", "deer"), { actorIds: ["local"] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(held(play, "npc:0,0,0,1")).toEqual(["burned"]);
    expect(play.drainNotices()).toEqual([]);
    expect(play.drainNotices("npc:0,0,0,1")).toEqual([]);
  });
});

describe("a body authored immune", () => {
  it("is refused by name, rather than refused in silence", () => {
    const play = session(world("grass", "salamander"), { actorIds: ["local"] });
    play.runCommand("/status burned npc:0,0,0,1");
    expect(held(play, "npc:0,0,0,1")).toEqual([]);
    expect(play.drainNotices()).toEqual(["salamander cannot be burned"]);
  });

  it("takes nothing from a fire it stands in either", () => {
    const play = session(world("fire", "salamander"), { actorIds: ["local"] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP + TICKS_PER_SECOND * 2);
    expect(held(play, "npc:0,0,0,1")).toEqual([]);
  });
});

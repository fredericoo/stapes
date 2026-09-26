import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { channelPowered, findWiredCells, readChannels, settleSignals } from "./signals";
import { tile } from "../lib/testTile";

const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

function directionalTile(id: string, extra: Record<string, unknown> = {}) {
  const frames = [
    {
      sprite: {
        tilesetId: "basic",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    },
  ];
  return normalizeTileDef({
    id,
    name: id,
    height: 4,
    directional: true,
    attributes: {},
    variants: { n: frames, e: frames, s: frames, w: frames },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4 }),
  directionalTile("player", { affectedByGravity: true, walkable: false }),
  tile({
    id: "crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),

  tile({
    id: "plate",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate-pressed", type: "gte", height: 1 },
      emit: { value: "off" },
    },
  }),
  tile({
    id: "plate-pressed",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate", type: "lte", height: 0 },
      emit: { value: "on" },
    },
  }),

  tile({
    id: "torch-lit",
    height: 0,
    interactions: {
      switch: { targetTileId: "torch-unlit" },
      emit: { value: "on" },
    },
  }),
  tile({
    id: "torch-unlit",
    height: 0,
    interactions: {
      switch: { targetTileId: "torch-lit" },
      emit: { value: "off" },
    },
  }),

  tile({
    id: "door",
    height: 4,
    interactions: {
      receive: { tileId: "door-open", when: "on", mode: "any" },
    },
  }),
  tile({
    id: "door-open",
    height: 0,
    interactions: {
      receive: { tileId: "door", when: "off", mode: "any" },
    },
  }),

  tile({
    id: "gate",
    height: 4,
    interactions: {
      receive: { tileId: "gate-open", when: "on", mode: "all" },
    },
  }),
  tile({
    id: "gate-open",
    height: 0,
    interactions: {
      receive: { tileId: "gate", when: "off", mode: "all" },
    },
  }),

  tile({
    id: "latch",
    height: 4,
    interactions: {
      receive: { tileId: "latch-open", when: "on", mode: "any" },
    },
  }),
  tile({ id: "latch-open", height: 0 }),

  tile({
    id: "door-closed",
    height: 4,
    walkable: false,
    interactions: {
      switch: { targetTileId: "door-swing" },
      receive: { tileId: "door-swing", when: "on", mode: "any" },
    },
  }),
  tile({
    id: "door-swing",
    height: 4,
    walkable: false,
    intangible: true,
    interactions: {
      switch: { targetTileId: "door-closed" },
      receive: { tileId: "door-closed", when: "off", mode: "all" },
    },
  }),

  tile({
    id: "swell",
    height: 0,
    interactions: {
      receive: { tileId: "wall", when: "on", mode: "any" },
    },
  }),

  tile({
    id: "flip-a",
    height: 0,
    interactions: {
      emit: { value: "on" },
      receive: { tileId: "flip-b", when: "on", mode: "any" },
    },
  }),
  tile({
    id: "flip-b",
    height: 0,
    interactions: {
      emit: { value: "off" },
      receive: { tileId: "flip-a", when: "off", mode: "any" },
    },
  }),
];

const tilesById = tilesByIdFromList(tiles);

function withIdlePlayer(map: MapFile): MapFile {
  return replaceStack(map, 9, 9, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
}

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

function step(session: GameSession, direction: Direction) {
  session.setInput({ directions: [direction] });
  session.tick(TICK_MS);
  session.setInput({ directions: [] });
  run(session, TICKS_PER_STEP);
}

describe("findWiredCells", () => {
  it("finds channelled placements across levels and skips the rest", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "plate", channel: "gate-a" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "torch-lit" }]);
    map = replaceStack(map, 4, 2, 3, [{ tileId: "door", channel: "gate-a" }]);

    expect(findWiredCells(map)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 2, z: 3 },
    ]);
  });

  it("keeps a cell whose current tile neither emits nor receives", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "latch-open", channel: "gate-a" }]);
    expect(findWiredCells(map)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });
});

describe("readChannels", () => {
  it("tallies emitters per channel", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "torch-unlit", channel: "gate-a" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "torch-lit", channel: "gate-b" }]);

    const state = readChannels(map, findWiredCells(map), tilesById);
    expect(state.get("gate-a")).toEqual({ on: 1, total: 2 });
    expect(state.get("gate-b")).toEqual({ on: 1, total: 1 });
  });

  it("ignores receivers and channel-less emitters", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "door", channel: "gate-a" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "torch-lit" }]);

    const state = readChannels(map, findWiredCells(map), tilesById);
    expect(state.get("gate-a")).toBeUndefined();
  });
});

describe("channelPowered", () => {
  const state = new Map([
    ["mixed", { on: 1, total: 3 }],
    ["full", { on: 2, total: 2 }],
    ["dark", { on: 0, total: 2 }],
  ]);

  it("reads any as one emitter being enough", () => {
    expect(channelPowered(state, "mixed", "any")).toBe(true);
    expect(channelPowered(state, "dark", "any")).toBe(false);
  });

  it("reads all as every emitter agreeing", () => {
    expect(channelPowered(state, "mixed", "all")).toBe(false);
    expect(channelPowered(state, "full", "all")).toBe(true);
  });

  it("reads an emitterless channel as off, under either mode", () => {
    expect(channelPowered(state, "nobody", "any")).toBe(false);
    expect(channelPowered(state, "nobody", "all")).toBe(false);
  });
});

describe("settleSignals", () => {
  it("opens a receiver its channel powers", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "grass" }, { tileId: "door", channel: "gate-a" }]);

    const { map: next, changed } = settleSignals(map, findWiredCells(map), tilesById);
    expect(stackIds(next, 5, 0)).toEqual(["grass", "door-open"]);
    expect(changed).toEqual([{ x: 5, y: 0, z: 0 }]);
  });

  it("leaves a receiver on another channel alone", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "door", channel: "gate-b" }]);

    const { map: next } = settleSignals(map, findWiredCells(map), tilesById);
    expect(stackIds(next, 5, 0)).toEqual(["door"]);
  });

  it("holds an all-mode receiver until every emitter is on", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "torch-unlit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "gate", channel: "gate-a" }]);

    const partial = settleSignals(map, findWiredCells(map), tilesById);
    expect(stackIds(partial.map, 5, 0)).toEqual(["gate"]);

    const lit = replaceStack(map, 1, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    const full = settleSignals(lit, findWiredCells(lit), tilesById);
    expect(stackIds(full.map, 5, 0)).toEqual(["gate-open"]);
  });

  it("refuses a swap that would not fit the stack", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "swell", channel: "gate-a" }, { tileId: "crate" }]);

    const { map: next, changed } = settleSignals(map, findWiredCells(map), tilesById);
    expect(stackIds(next, 5, 0)).toEqual(["swell", "crate"]);
    expect(changed).toEqual([]);
  });

  it("reads every channel before any swap lands", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "door", channel: "gate-a" }]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "door", channel: "gate-a" }]);

    const { map: next } = settleSignals(map, findWiredCells(map), tilesById);
    expect(stackIds(next, 5, 0)).toEqual(["door-open"]);
    expect(stackIds(next, 6, 0)).toEqual(["door-open"]);
  });

  it("preserves the channel across a swap", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch-lit", channel: "gate-a" }]);
    map = replaceStack(map, 5, 0, 0, [{ tileId: "door", channel: "gate-a" }]);

    const { map: next } = settleSignals(map, findWiredCells(map), tilesById);
    expect(getStack(next, 5, 0, 0)[0]?.channel).toBe("gate-a");
  });
});

describe("GameSession signals", () => {
  it("opens a door when the player steps onto a wired plate", () => {
    let map = emptyMap();
    for (let x = 0; x <= 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "plate", channel: "gate-a" }]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "grass" }, { tileId: "door", channel: "gate-a" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);

    const session = new GameSession(map, tiles);
    expect(stackIds(session.getSnapshot().map, 6, 0)).toEqual(["grass", "door"]);

    step(session, "e");
    const pressed = session.getSnapshot().map;
    expect(stackIds(pressed, 2, 0)).toEqual(["grass", "plate-pressed", "player"]);
    expect(stackIds(pressed, 6, 0)).toEqual(["grass", "door-open"]);

    step(session, "e");
    const released = session.getSnapshot().map;
    expect(stackIds(released, 2, 0)).toEqual(["grass", "plate"]);
    expect(stackIds(released, 6, 0)).toEqual(["grass", "door"]);
  });

  it("opens a door already held by a load at load time", () => {
    let map = withIdlePlayer(emptyMap());
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "plate", channel: "gate-a" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "door", channel: "gate-a" }]);

    const session = new GameSession(map, tiles);
    expect(stackIds(session.getSnapshot().map, 6, 0)).toEqual(["door-open"]);
  });

  it("opens a door when the player switches a wired torch", () => {
    let map = emptyMap();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "torch-unlit", channel: "gate-a" },
    ]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "door", channel: "gate-a" }]);

    const session = new GameSession(map, tiles);
    expect(session.interact({ x: 2, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    session.tick(TICK_MS);

    const after = session.getSnapshot().map;
    expect(stackIds(after, 2, 0)).toEqual(["grass", "torch-lit"]);
    expect(stackIds(after, 6, 0)).toEqual(["door-open"]);
    expect(getStack(after, 2, 0, 0)[1]?.channel).toBe("gate-a");
  });

  it("carries a channel with a pushed object", () => {
    let map = emptyMap();
    for (let x = 0; x <= 4; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "crate", channel: "gate-a" }]);

    const session = new GameSession(map, tiles);
    expect(session.interact({ x: 2, y: 0, z: 0, stackIndex: 1 })).toBe(true);

    const after = session.getSnapshot().map;
    expect(getStack(after, 3, 0, 0)[1]?.channel).toBe("gate-a");
  });

  it("leaves a latch open once the player steps back off the plate", () => {
    let map = emptyMap();
    for (let x = 0; x <= 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "plate", channel: "gate-a" }]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "latch", channel: "gate-a" }]);

    const session = new GameSession(map, tiles);
    step(session, "e");
    expect(stackIds(session.getSnapshot().map, 6, 0)).toEqual(["latch-open"]);

    step(session, "e");
    const after = session.getSnapshot().map;
    expect(stackIds(after, 2, 0)).toEqual(["grass", "plate"]);
    expect(stackIds(after, 6, 0)).toEqual(["latch-open"]);
  });

  it("does not let a tap on a wired door open a way through, even for a frame", () => {
    let map = emptyMap();
    for (let x = 0; x <= 2; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed", channel: "gate-a" },
    ]);

    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });
    expect(session.interact({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);

    run(session, TICKS_PER_STEP * 2);

    const after = session.getSnapshot().map;
    expect(stackIds(after, 1, 0)).toEqual(["grass", "door-closed"]);
    expect(stackIds(after, 0, 0)).toEqual(["grass", "player"]);
    expect(session.getSnapshot().self.x).toBe(0);
  });

  it("still opens a switchable door that answers to no channel", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "door-closed" }]);

    const session = new GameSession(map, tiles);
    expect(session.interact({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    run(session, 2);

    expect(stackIds(session.getSnapshot().map, 1, 0)).toEqual(["grass", "door-swing"]);
  });

  it("oscillates rather than spinning on a self-defeating wire", () => {
    let map = withIdlePlayer(emptyMap());
    map = replaceStack(map, 2, 0, 0, [{ tileId: "flip-a", channel: "loop" }]);

    const session = new GameSession(map, tiles);
    run(session, 10);
    expect(stackIds(session.getSnapshot().map, 2, 0)[0]).toMatch(/^flip-[ab]$/);
  });
});

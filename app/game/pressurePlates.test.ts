import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { findPlateCells, loadAbove, settlePlates } from "./pressurePlates";
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
  tile({ id: "rug", height: 0 }),
  tile({ id: "ghost", height: 4, intangible: true }),
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
    },
  }),
  tile({
    id: "plate-pressed",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate", type: "lte", height: 0 },
    },
  }),
  tile({
    id: "latch",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "latch-stuck", type: "gte", height: 1 },
    },
  }),
  tile({ id: "latch-stuck", height: 0 }),
  tile({
    id: "swell",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "wall", type: "gte", height: 1 },
    },
  }),
  tile({
    id: "flip-a",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "flip-b", type: "gte", height: 0 },
    },
  }),
  tile({
    id: "flip-b",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "flip-a", type: "gte", height: 0 },
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

function step(session: GameSession, direction: Direction, id?: string) {
  session.setInput({ directions: [direction] }, id);
  session.tick(TICK_MS);
  session.setInput({ directions: [] }, id);
  run(session, TICKS_PER_STEP);
}

describe("loadAbove", () => {
  it("sums only what sits above the index", () => {
    const stack = [{ tileId: "grass" }, { tileId: "plate" }, { tileId: "crate" }];
    expect(loadAbove(stack, 1, tilesById)).toBe(2);
    expect(loadAbove(stack, 2, tilesById)).toBe(0);
  });

  it("ignores flat and intangible tiles", () => {
    const stack = [{ tileId: "plate" }, { tileId: "rug" }, { tileId: "ghost" }];
    expect(loadAbove(stack, 0, tilesById)).toBe(0);
  });
});

describe("findPlateCells", () => {
  it("finds plates across levels and skips inert cells", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "plate" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 4, 2, 3, [{ tileId: "plate-pressed" }]);
    expect(findPlateCells(map, tilesById)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 2, z: 3 },
    ]);
  });
});

describe("settlePlates", () => {
  it("presses under a load and releases without one", () => {
    const loaded = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "plate" }, { tileId: "crate" }]);
    const pressed = settlePlates(loaded, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(stackIds(pressed.map, 0, 0)).toEqual(["plate-pressed", "crate"]);
    expect(pressed.changed).toEqual([{ x: 0, y: 0, z: 0 }]);

    const bare = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "plate-pressed" }]);
    const released = settlePlates(bare, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(stackIds(released.map, 0, 0)).toEqual(["plate"]);
  });

  it("leaves a settled plate alone", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "plate-pressed" },
      { tileId: "crate" },
    ]);
    const result = settlePlates(map, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(result.changed).toEqual([]);
    expect(result.map).toBe(map);
  });

  it("keeps the placement's facing through the swap", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "plate", direction: "e" },
      { tileId: "crate" },
    ]);
    const result = settlePlates(map, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(getStack(result.map, 0, 0, 0)[0]).toEqual({
      tileId: "plate-pressed",
      direction: "e",
    });
  });

  it("refuses a swap that would not fit under its own load", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "swell" }, { tileId: "crate" }]);
    const result = settlePlates(map, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["swell", "crate"]);
  });

  it("does one pass, so a self-triggering pair cannot spin", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "flip-a" }]);
    const once = settlePlates(map, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(stackIds(once.map, 0, 0)).toEqual(["flip-b"]);
    const twice = settlePlates(once.map, [{ x: 0, y: 0, z: 0 }], tilesById);
    expect(stackIds(twice.map, 0, 0)).toEqual(["flip-a"]);
  });
});

describe("GameSession pressure plates", () => {
  it("opens in the state the authored load implies", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "plate" }, { tileId: "crate" }]);
    map = withIdlePlayer(map);
    const session = new GameSession(map, tiles);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["plate-pressed", "crate"]);
  });

  it("presses when a crate is shoved on and releases when it leaves", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "plate" }]);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "grass" }]);

    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    session.tick(TICK_MS);
    expect(stackIds(session.getMap(), 2, 0)).toEqual(["plate-pressed", "crate"]);

    step(session, "e");
    expect(session.push({ x: 2, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    session.tick(TICK_MS);
    expect(stackIds(session.getMap(), 2, 0)).toEqual(["plate"]);
    expect(stackIds(session.getMap(), 3, 0)).toEqual(["grass", "crate"]);
  });

  it("presses and releases under two people at once", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "plate" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }]);

    const session = new GameSession(map, tiles, { actorIds: ["a", "b"] });
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["plate"]);

    step(session, "e", "a");
    step(session, "e", "b");
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["plate-pressed", "player", "player"]);

    step(session, "e", "a");
    step(session, "e", "b");
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["plate"]);
  });

  it("presses under the player and stays down when the target is inert", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "latch" }]);

    const session = new GameSession(map, tiles);
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["latch"]);

    step(session, "e");
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["latch-stuck", "player"]);

    step(session, "w");
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["latch-stuck"]);
  });

  it("tracks a plate that is itself pushed onto a load-bearing cell", () => {
    const pushablePlate = tile({
      id: "plate",
      height: 0,
      interactions: {
        pressurePlate: { tileId: "plate-pressed", type: "gte", height: 1 },
        push: { climb: "half", moveOnTileIds: [] },
      },
    });
    const withPushable = tiles.map((t) => (t.id === "plate" ? pushablePlate : t));

    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "plate" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }]);

    const session = new GameSession(map, withPushable);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    session.tick(TICK_MS);
    expect(stackIds(session.getMap(), 2, 0)).toEqual(["grass", "plate"]);

    step(session, "e");
    step(session, "e");
    expect(stackIds(session.getMap(), 2, 0)).toEqual(["grass", "plate-pressed", "player"]);
  });

  it("does not make a plate hoverable or clickable", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "latch" }]);
    const session = new GameSession(map, tiles);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 0 };
    expect(session.canInteract(ref)).toBe(false);
    expect(session.interact(ref)).toBe(false);
  });
});

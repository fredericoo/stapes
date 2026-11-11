import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { FRAME, tile } from "../lib/testTile";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { LOOT_LIFETIME_MS, TICK_MS } from "./constants";
import { applyLootDecay } from "./decay";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";

const SKULL = "bone-skull";
const PELT = "pelt";

const CERTAIN = { accuracy: 100, spd: 100, variance: 0 };

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    name: "Player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    lightPassing: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 999,
        masteries: {},
        naturalWeapon: {
          type: "weapon",
          name: "Fists",
          damage: 999,
          def: 0,
          mastery: "fist",
          ...CERTAIN,
        },
        remains: SKULL,
      },
    },
  }),
  tile({
    id: "boar",
    name: "Boar",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 1,
        masteries: {},
        naturalWeapon: { type: "weapon", damage: 0, def: 0, mastery: "blunt", ...CERTAIN },
        kit: [{ slot: "offhand", tileId: PELT, chance: 100 }],
        remains: SKULL,
      },
    },
  }),
  tile({
    id: SKULL,
    name: "Skull",
    kind: "item",
    interactions: { item: { type: "artifact" } },
  }),
  tile({
    id: PELT,
    name: "Pelt",
    kind: "item",
    interactions: { item: { type: "artifact" } },
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
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "boar" }]);
}

function killedBoar(): GameSession {
  const session = new GameSession(field(), tiles, { actorIds: [LOCAL_ACTOR_ID] });
  const boar = session.actorIds().find((id) => id !== LOCAL_ACTOR_ID)!;
  session.setTarget(boar);
  session.setAttackMode(true);
  for (let ms = 0; ms < 10_000 && session.actorIds().includes(boar); ms += TICK_MS) {
    session.tick(TICK_MS);
  }
  expect(session.actorIds()).not.toContain(boar);
  return session;
}

function dropped(session: GameSession): string[] {
  const found: string[] = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      for (const placed of getStack(session.getMap(), x, y, 0)) {
        if (placed.itemId) found.push(placed.tileId);
      }
    }
  }
  return found.sort();
}

describe("what a creature drops when it dies", () => {
  it("lies on the floor until the loot lifetime is up", () => {
    const session = killedBoar();
    expect(dropped(session)).toEqual([SKULL, PELT].sort());

    session.passTimeAsleep(LOOT_LIFETIME_MS - 1_000);
    session.tick(TICK_MS);
    expect(dropped(session)).toEqual([SKULL, PELT].sort());
  });

  it("is gone from the floor once the loot lifetime is up", () => {
    const session = killedBoar();
    expect(dropped(session)).toHaveLength(2);

    session.passTimeAsleep(LOOT_LIFETIME_MS);
    session.tick(TICK_MS);
    expect(dropped(session)).toEqual([]);
  });
});

describe("applyLootDecay", () => {
  const map = (stack: PlacedTile[]) => replaceStack(emptyMap(), 0, 0, 0, stack);
  const cell = { x: 0, y: 0, z: 0 };

  it("passes over an item that has left the cell it landed in", () => {
    const board = map([{ tileId: "grass" }]);
    const result = applyLootDecay(board, [{ kind: "loot", itemId: "i1", cell, dueMs: 0 }], {
      grass: tiles[0]!,
    });
    expect(result.changed).toEqual([]);
    expect(result.map).toBe(board);
  });

  it("takes only the item it names from the cell", () => {
    const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));
    const board = map([
      { tileId: "grass" },
      { tileId: PELT, itemId: "kept" },
      { tileId: PELT, itemId: "loot" },
    ]);
    const result = applyLootDecay(
      board,
      [{ kind: "loot", itemId: "loot", cell, dueMs: 0 }],
      tilesById,
    );
    expect(getStack(result.map, 0, 0, 0)).toEqual([
      { tileId: "grass" },
      { tileId: PELT, itemId: "kept" },
    ]);
  });
});

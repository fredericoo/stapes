import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import traitsJson from "../../data/traits.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import { traitsById } from "../lib/traits";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

const tiles = normalizeTiles(tilesJson as unknown[]);
const traits = traitsById(traitsJson as unknown[]);
const statuses = statusesById(statusesJson as unknown[]);

function yard(bodies: [x: number, y: number, tileId: string][]): MapFile {
  let map = emptyMap();
  for (let x = -12; x <= 12; x++) {
    for (let y = -12; y <= 12; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 12, -12, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  for (const [x, y, tileId] of bodies) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId, direction: "s" }]);
  }
  return map;
}

function camp(bodies: [x: number, y: number, tileId: string][], catalogue: TileDef[] = tiles) {
  return new GameSession(yard(bodies), catalogue, { statuses, traits });
}

function bodyOf(session: GameSession, tileId: string) {
  return session.actorSnapshots().find((actor) => actor.tileId === tileId);
}

function run(session: GameSession, ms: number, until?: () => boolean) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    if (until?.()) return;
  }
}

describe("the camp's archer", () => {
  it("shoots the training dummy when nothing else is about", () => {
    const session = camp([
      [0, 0, "runa-hask"],
      [0, 4, "training-dummy"],
    ]);
    const full = bodyOf(session, "training-dummy")!.hp!;

    run(session, 10_000);

    expect(bodyOf(session, "training-dummy")!.hp).toBeLessThan(full);
    expect(bodyOf(session, "runa-hask")).toMatchObject({ x: 0, y: 0 });
  });

  it("leaves the dummy for a rat she can see, and goes back to it after", () => {
    const session = camp([
      [0, 0, "runa-hask"],
      [0, 4, "training-dummy"],
      [-5, 0, "rat"],
    ]);
    const full = bodyOf(session, "training-dummy")!.hp!;
    expect(bodyOf(session, "rat")).toBeDefined();

    run(session, 30_000, () => !bodyOf(session, "rat"));

    expect(bodyOf(session, "rat")).toBeUndefined();
    expect(bodyOf(session, "training-dummy")!.hp).toBe(full);
    run(session, 10_000);
    expect(bodyOf(session, "training-dummy")!.hp).toBeLessThan(full);
  });
});

describe("the castaways' guide", () => {
  it("kills a rat that comes near the waking spot, and stays by it", () => {
    const session = camp([
      [0, 0, "tove-arnesdatter"],
      [-5, 0, "rat"],
    ]);
    expect(bodyOf(session, "rat")).toBeDefined();

    run(session, 30_000, () => !bodyOf(session, "rat"));

    expect(bodyOf(session, "rat")).toBeUndefined();
    run(session, 15_000);
    const tove = bodyOf(session, "tove-arnesdatter")!;
    expect(Math.max(Math.abs(tove.x), Math.abs(tove.y))).toBeLessThanOrEqual(4);
  });

  it("leaves a rabbit alone", () => {
    const session = camp([
      [0, 0, "tove-arnesdatter"],
      [-4, 0, "rabbit"],
    ]);
    const full = bodyOf(session, "rabbit")!.hp!;

    run(session, 10_000);

    expect(bodyOf(session, "rabbit")?.hp).toBe(full);
  });
});

describe("the training dummy", () => {
  it("restuffs itself before it can be shot down", () => {
    const flimsy = tiles.map((tile) =>
      tile.id === "training-dummy" && tile.interactions?.battler
        ? {
            ...tile,
            interactions: {
              ...tile.interactions,
              battler: { ...tile.interactions.battler, baseHp: 100 },
            },
          }
        : tile,
    );
    const session = camp(
      [
        [0, 0, "runa-hask"],
        [0, 4, "training-dummy"],
      ],
      flimsy,
    );
    let lowest = Infinity;

    for (let elapsed = 0; elapsed < 60_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      lowest = Math.min(lowest, bodyOf(session, "training-dummy")?.hp ?? 0);
    }

    expect(lowest).toBeGreaterThan(0);
    expect(lowest).toBeLessThanOrEqual(50);
  });
});

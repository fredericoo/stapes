import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, MapFile } from "../lib/types";
import { squareSlot } from "./casting";
import { TICK_MS } from "./constants";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { shippedTiles } from "./testShippedTiles";

const tiles = shippedTiles();

const WALL_X = 4;
const ROW = 1;
const START: Coord = { x: 2, y: ROW, z: 0 };

/**
 * A floor shut in to the east by a wall one full level high with snow on its
 * top, and open ground past it: the shape of the white peak's ring and its lip.
 */
function walledIn(): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= WALL_X + 2; x++) {
    for (let y = 0; y <= 2; y++) {
      if (x === WALL_X) {
        map = replaceStack(map, x, y, 0, [{ tileId: "snow" }, { tileId: "hill-wall-frost" }]);
        map = replaceStack(map, x, y, 1, [{ tileId: "snow" }]);
      } else {
        map = replaceStack(map, x, y, 0, [{ tileId: "snow" }]);
      }
    }
  }
  return replaceStack(map, 0, 0, 0, [{ tileId: "snow" }, { tileId: "player", direction: "e" }]);
}

function holding(tileId: string | null): Equipment {
  return { ...emptyEquipment(), weapon: tileId ? { id: "itm_rune", tileId } : null };
}

function climber(weapon: string | null): GameSession {
  const session = new GameSession(walledIn(), tiles);
  session.spawn("climber", { at: { ...START, direction: "e" }, carrying: holding(weapon) });
  return session;
}

function where(session: GameSession): Coord {
  const me = session.actorSnapshots().find((a) => a.id === "climber")!;
  return { x: me.x, y: me.y, z: me.z };
}

function runMs(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
}

/** Walks one cell east and waits for the step, and any fall after it, to land. */
function stepEast(session: GameSession): Coord {
  session.requestStep("climber", "e");
  runMs(session, 2_000);
  return where(session);
}

const cubeAt = (session: GameSession, at: Coord) =>
  getStack(session.getMap(), at.x, at.y, at.z).some((p) => p.tileId === "ice-cube");

describe("the Glacier rune", () => {
  it("is needed: a wall one full level high cannot be climbed from the floor", () => {
    const session = climber(null);
    expect(stepEast(session)).toEqual({ x: 3, y: ROW, z: 0 });
    expect(stepEast(session)).toEqual({ x: 3, y: ROW, z: 0 });
  });

  it("raises an ice cube in front of its caster that is climbed onto the wall and over it", () => {
    const session = climber("rune-glacier");
    expect(session.cast(squareSlot("weapon"), "climber")).toBe(true);
    runMs(session, 5_000);
    const front = { x: 3, y: ROW, z: 0 };
    expect(cubeAt(session, front)).toBe(true);

    expect(stepEast(session)).toEqual(front);
    expect(stepEast(session)).toEqual({ x: WALL_X, y: ROW, z: 1 });
    expect(stepEast(session)).toEqual({ x: WALL_X + 1, y: ROW, z: 0 });
  });

  it("melts the cube within half a minute", () => {
    const session = climber("rune-glacier");
    session.cast(squareSlot("weapon"), "climber");
    runMs(session, 5_000);
    const front = { x: 3, y: ROW, z: 0 };
    expect(cubeAt(session, front)).toBe(true);

    runMs(session, 31_000);
    expect(cubeAt(session, front)).toBe(false);
  });
});

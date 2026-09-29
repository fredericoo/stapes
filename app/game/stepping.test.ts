import { MAP_FILE_VERSION } from "../lib/types";
import { describe, expect, it } from "vitest";
import { GameSession } from "./GameSession";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { chooseStep } from "./stepping";
import { getStack } from "../lib/mapData";
import { chunkifyMap } from "../lib/mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { FRAME, tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const grass: PlacedTile = { tileId: "grass" } as PlacedTile;
const wall: PlacedTile = { tileId: "wall" } as PlacedTile;

function strip(): Record<string, PlacedTile[]> {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 4; x++) cells[`${x},0`] = [grass];
  cells["2,0"] = [grass, wall];
  return cells;
}

function walledMap(): MapFile {
  const cells = strip();
  cells["1,0"] = [grass, { tileId: "player", direction: "s" } as PlacedTile];
  return chunkifyMap({
    version: MAP_FILE_VERSION,
    levels: { "0": cells },
  } as unknown as FlatMapFile);
}

const AT = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("chooseStep", () => {
  const map = walledMap();
  const player = tilesById.player!;

  it("asks for nothing when nothing is held", () => {
    expect(chooseStep(map, AT, { directions: [] }, player, tilesById)).toBeNull();
  });

  it("takes the direction pressed last", () => {
    const choice = chooseStep(map, AT, { directions: ["n", "w"] }, player, tilesById);
    expect(choice?.step?.direction).toBe("w");
    expect(choice?.step?.to).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("falls back to an older direction when the newest is blocked", () => {
    const choice = chooseStep(map, AT, { directions: ["w", "e"] }, player, tilesById);
    expect(choice?.step?.direction).toBe("w");
  });

  it("faces a wall it cannot walk into", () => {
    const choice = chooseStep(map, AT, { directions: ["e"] }, player, tilesById);
    expect(choice?.facing).toBe("e");
    expect(choice?.step).toBeNull();
  });

  it("turns without walking when asked only to face", () => {
    const choice = chooseStep(map, AT, { directions: ["w"], faceOnly: true }, player, tilesById);
    expect(choice?.facing).toBe("w");
    expect(choice?.step).toBeNull();
  });

  it("leaves a cell somebody else is walking into alone", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["w"] },
      player,
      tilesById,
      (to) => to.x === 0,
    );
    expect(choice?.step).toBeNull();
  });
});

function actorX(session: GameSession, id: string): number {
  const actor = session.actorSnapshots().find((a) => a.id === id);
  if (!actor) throw new Error(`no actor ${id}`);
  return actor.x;
}

function sessionOnStrip(): GameSession {
  const map = chunkifyMap({
    version: MAP_FILE_VERSION,
    levels: { "0": strip() },
  } as unknown as FlatMapFile);
  return new GameSession(map, tiles, {
    actorIds: ["a"],
    spawnAt: {
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 1,
    },
  });
}

describe("GameSession.requestStep", () => {
  it("walks an actor that says it has already stepped", () => {
    const session = sessionOnStrip();
    expect(session.requestStep("a", "e")).toBe("started");

    for (let t = 0; t < WALK_DURATION_MS; t += TICK_MS) session.tick(TICK_MS);
    expect(actorX(session, "a")).toBe(1);
  });

  it("turns an actor towards a step it refuses", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");
    for (let t = 0; t < WALK_DURATION_MS; t += TICK_MS) session.tick(TICK_MS);

    expect(session.requestStep("a", "e")).toBe("refused");
    const actor = session.actorSnapshots().find((a) => a.id === "a");
    expect(actor?.direction).toBe("e");
    expect(actor?.x).toBe(1);
  });

  it("holds a step that arrives mid-walk rather than refusing it", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");
    session.tick(TICK_MS);

    expect(session.requestStep("a", "e")).toBe("later");
  });

  it("frees the actor in the same tick the walk commits", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");

    let ticks = 0;
    while (session.requestStep("a", "e") === "later") {
      session.tick(TICK_MS);
      ticks += 1;
      if (ticks > 100) throw new Error("walk never committed");
    }

    expect(actorX(session, "a")).toBe(1);
    expect(ticks).toBe(Math.ceil(WALK_DURATION_MS / TICK_MS));
  });

  it("refuses a step from an actor the board is still dropping", () => {
    const map = chunkifyMap({
      version: MAP_FILE_VERSION,
      levels: { "0": { "0,0": [grass], "1,0": [grass] }, "1": {} },
    } as unknown as FlatMapFile);
    const session = new GameSession(map, tiles, {
      actorIds: ["a"],
      spawnAt: {
        x: 0,
        y: 0,
        z: 1,
        stackIndex: 0,
      },
    });
    session.tick(TICK_MS);

    expect(session.requestStep("a", "e")).toBe("refused");
  });
});

describe("GameSession.faceActor", () => {
  it("turns an actor on the spot", () => {
    const session = sessionOnStrip();
    session.faceActor("a", "n");

    const stack = getStack(session.getMap(), 0, 0, 0);
    expect(stack[stack.length - 1]?.direction).toBe("n");
    expect(actorX(session, "a")).toBe(0);
  });
});

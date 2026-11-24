import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack, UNLOADED_TILE_ID } from "../lib/mapData";
import type { ChunkCells, MapFile, TileDef } from "../lib/types";
import { CHUNK_SIZE } from "../lib/types";
import { FRAME, tile } from "../lib/testTile";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { chunkRecords } from "./residency";
import { residentAt } from "./testResidents";

const PICKED_MS = 2_000;

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({ id: "deer", height: 2, actor: true, affectedByGravity: true, walkable: false }),
  tile({
    id: "picked-patch",
    height: 0,
    interactions: { decay: { tileId: "patch", fromMs: PICKED_MS, toMs: PICKED_MS } },
  }),
  tile({ id: "patch", height: 0 }),
  tile({
    id: "portal",
    height: 0,
    interactions: { teleport: { trigger: "step", destination: { kind: "absolute" } } },
  }),
];

const FAR = "2,0";
const FAR_X = 2 * CHUNK_SIZE + 3;

/** Three chunks along x, the player in the first and the third holding `far`. */
function strip(far: { tileId: string }[] = []): MapFile {
  let map = emptyMap();
  for (let x = 0; x < 3 * CHUNK_SIZE; x++) map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, FAR_X, 0, 0, [{ tileId: "grass" }, ...far]);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
}

/** What the store would hand back: the chunk's records as they were when it went out. */
function unload(session: GameSession, chunkKey: string): Map<string, ChunkCells> {
  const stored = chunkRecords(session.getMap(), chunkKey);
  expect(session.unloadChunks([chunkKey])).toEqual([chunkKey]);
  return stored;
}

function tileIdsAt(session: GameSession, x: number): string[] {
  return getStack(session.getMap(), x, 0, 0).map((placed) => placed.tileId);
}

describe("a chunk out of memory", () => {
  it("reads as a wall while it is away and as its own cells once it is back", () => {
    const session = new GameSession(strip([{ tileId: "patch" }]), tiles);
    const stored = unload(session, FAR);

    expect(tileIdsAt(session, FAR_X)).toEqual([UNLOADED_TILE_ID]);
    expect(session.isUnloaded({ x: FAR_X, y: 0, z: 0 })).toBe(true);

    session.loadChunks(new Map([[FAR, stored]]));
    expect(tileIdsAt(session, FAR_X)).toEqual(["grass", "patch"]);
  });

  it("is not taken out while a player stands in it", () => {
    const session = new GameSession(strip(), tiles);

    expect(session.unloadChunks(["0,0"])).toEqual([]);
    expect(tileIdsAt(session, 0)).toEqual(["grass", "player"]);
  });

  it("grows back on load what would have grown back while it was away", () => {
    const session = new GameSession(strip([{ tileId: "picked-patch" }]), tiles);
    const stored = unload(session, FAR);

    advance(session, PICKED_MS + TICK_MS);
    session.loadChunks(new Map([[FAR, stored]]));
    session.tick(TICK_MS);

    expect(tileIdsAt(session, FAR_X)).toEqual(["grass", "patch"]);
  });

  it("keeps the clock it had rather than starting it again", () => {
    const session = new GameSession(strip([{ tileId: "picked-patch" }]), tiles);
    advance(session, PICKED_MS / 2);
    const stored = unload(session, FAR);

    session.loadChunks(new Map([[FAR, stored]]));
    advance(session, PICKED_MS / 2 + TICK_MS);

    expect(tileIdsAt(session, FAR_X)).toEqual(["grass", "patch"]);
  });

  it("stops a resident being an actor, and brings it back where it was", () => {
    const session = new GameSession(strip([{ tileId: "deer" }]), tiles);
    const deer = residentAt(session, FAR_X, 0, 0);
    const stored = unload(session, FAR);

    expect(session.hasActor(deer)).toBe(false);
    expect(session.isSpawnFilled({ ownerId: deer } as never)).toBe(true);

    session.loadChunks(new Map([[FAR, stored]]));
    expect(session.hasActor(deer)).toBe(true);
    expect(session.actorPosition(deer)).toMatchObject({ x: FAR_X, y: 0, z: 0 });
  });
});

describe("chunks kept in memory with nobody near", () => {
  it("include where a teleport sends you, and the chunks beside it", () => {
    const map = replaceStack(strip(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "portal", teleportTo: { x: 5 * CHUNK_SIZE, y: 0, z: 0 } },
    ]);
    const keep = new GameSession(map, tiles).chunksToKeep();

    expect(keep.has("5,0")).toBe(true);
    expect(keep.has("4,0")).toBe(true);
    expect(keep.has("6,0")).toBe(true);
    expect(keep.has(FAR)).toBe(false);
  });
});

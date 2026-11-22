import { afterEach, describe, expect, it } from "bun:test";
import { firstResidentId } from "../app/game/testResidents";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import traitsJson from "../data/traits.json";
import { PLAYER_TILE_ID, TICK_MS } from "../app/game/constants";
import { resolveRespawn } from "../app/lib/interactions";
import { getStack, UNLOADED_TILE_ID } from "../app/lib/mapData";
import { CHUNK_SIZE, MAP_FILE_VERSION, normalizeTileDef } from "../app/lib/types";
import type { FlatMapFile, MapFile, TileDef } from "../app/lib/types";
import { Harness, Pair } from "./testHarness";

const JSON_TYPE = "application/json";
const NOON_MS = 12 * 60 * 60 * 1000;
const FAR = "3,0";
const RAT_X = 3 * CHUNK_SIZE + 4;
const RAT_ID = firstResidentId();

const rat = (tilesJson as TileDef[]).map(normalizeTileDef).find((tile) => tile.id === "rat")!;
const ratRespawn = resolveRespawn(rat)!;

/** Four chunks of grass along x: the player at the west end, a rat in the east chunk. */
function field(): FlatMapFile {
  const cells: Record<string, unknown[]> = {};
  for (let x = 0; x < 4 * CHUNK_SIZE; x++) cells[`${x},0`] = [{ tileId: "grass" }];
  cells["0,0"] = [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  cells[`${RAT_X},0`] = [{ tileId: "grass" }, { tileId: "rat", direction: "w" }];
  return { version: MAP_FILE_VERSION, levels: { "0": cells } } as FlatMapFile;
}

type Internals = {
  session: {
    getMap(): MapFile;
    actors: Map<string, unknown>;
    applyDamage(body: unknown, amount: number): void;
    hasActor(id: string): boolean;
    runCommand(raw: string, id: string): unknown;
  };
  loadChunks(keys: Iterable<string>, options?: { now?: boolean }): Promise<void>;
};

const opened: Harness[] = [];

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.dispose();
});

async function world(reachChunks = 0): Promise<Harness> {
  const harness = await Harness.create(
    {},
    {
      manualTicks: { startAtMs: NOON_MS },
      seed: 7,
      weather: "clear",
      residency: { reachChunks, idleMs: 0 },
    },
  );
  opened.push(harness);
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("traits.json", JSON.stringify(traitsJson), JSON_TYPE);
  await harness.blobs.put("map.json", JSON.stringify(field()), JSON_TYPE);
  await harness.server.step();
  const pair = new Pair();
  pair.client();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  await harness.server.join(pair.server, "player-1", { admin: true });
  return harness;
}

function internals(harness: Harness): Internals {
  return harness.server as unknown as Internals;
}

function ratCell(harness: Harness): string[] {
  return getStack(internals(harness).session.getMap(), RAT_X, 0, 0).map((p) => p.tileId);
}

/** A checkpoint, then two passes: the first notes when each chunk was last wanted. */
function unloadFarChunks(harness: Harness) {
  harness.server.saveEveryActor();
  harness.server.settleResidency();
  harness.server.settleResidency();
}

describe("a world that unloads chunks far from players", () => {
  it("takes the far chunk out of memory, and the store still has it after a restart", async () => {
    const harness = await world();
    harness.server.saveEveryActor();
    internals(harness).session.runCommand("/tile apple 2 0 0", "player-1");
    harness.server.settleResidency();
    harness.server.settleResidency();

    expect(ratCell(harness)).toEqual([UNLOADED_TILE_ID]);
    expect(internals(harness).session.hasActor(RAT_ID)).toBe(false);

    harness.server.saveEveryActor();
    const again = await harness.restart();
    opened.push(again);
    await again.server.step();
    expect(ratCell(again)).toEqual(["grass", "rat"]);
    expect(getStack(internals(again).session.getMap(), 2, 0, 0).at(-1)?.tileId).toBe("apple");
  });

  it("brings the chunk back with its resident when it is wanted again", async () => {
    const harness = await world();
    unloadFarChunks(harness);

    await internals(harness).loadChunks([FAR], { now: true });

    expect(ratCell(harness)).toEqual(["grass", "rat"]);
    expect(internals(harness).session.hasActor(RAT_ID)).toBe(true);
  });

  it("brings a chunk back on the ticks after a player comes within reach of it", async () => {
    const harness = await world(2);
    unloadFarChunks(harness);
    expect(ratCell(harness)).toEqual([UNLOADED_TILE_ID]);

    internals(harness).session.runCommand(`/goto ${CHUNK_SIZE + 8} 0 0`, "player-1");
    for (let ticks = 0; ticks < 10 && ratCell(harness)[0] === UNLOADED_TILE_ID; ticks++) {
      await harness.server.step();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(ratCell(harness)).toEqual(["grass", "rat"]);
  });

  it("holds a respawn that fell due while its chunk was away, and runs it on load", async () => {
    const harness = await world();
    const { session } = internals(harness);
    session.applyDamage(session.actors.get(RAT_ID), 10_000);
    await harness.server.step();
    unloadFarChunks(harness);

    await harness.server.step(Math.ceil(ratRespawn.toMs / TICK_MS) + 2);
    expect(ratCell(harness)).toEqual([UNLOADED_TILE_ID]);

    await internals(harness).loadChunks([FAR], { now: true });
    expect(ratCell(harness)).toContain("rat");
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { PLAYER_TILE_ID, TICK_MS } from "../app/game/constants";
import { resolveRespawn } from "../app/lib/interactions";
import { getStack } from "../app/lib/mapData";
import { MAP_FILE_VERSION, normalizeTileDef } from "../app/lib/types";
import type { FlatMapFile, MapFile, TileDef } from "../app/lib/types";
import { Harness, Pair } from "./testHarness";

const JSON_TYPE = "application/json";
const NOON_MS = 12 * 60 * 60 * 1000;
const RAT_X = 3;
const RAT_ID = `npc:${RAT_X},0,0,1`;
const SEED = 7;

const rat = (tilesJson as TileDef[]).map(normalizeTileDef).find((tile) => tile.id === "rat")!;
const ratRespawn = resolveRespawn(rat)!;

function field(): FlatMapFile {
  const cells: Record<string, unknown[]> = {};
  for (let x = 0; x <= RAT_X + 2; x++) cells[`${x},0`] = [{ tileId: "grass" }];
  cells["0,0"] = [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  cells[`${RAT_X},0`] = [{ tileId: "grass" }, { tileId: "rat", direction: "w" }];
  return { version: MAP_FILE_VERSION, levels: { "0": cells } } as FlatMapFile;
}

type Internals = {
  session: {
    getMap(): MapFile;
    actors: Map<string, unknown>;
    applyDamage(body: unknown, amount: number): void;
    runCommand(raw: string, id: string): unknown;
    statusesOf(id: string): readonly { defId: string; remainingMs: number }[] | null;
  };
};

const opened: Harness[] = [];

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.dispose();
});

async function steppedWorld(seed: number): Promise<Harness> {
  const harness = await Harness.create({}, { manualTicks: { startAtMs: NOON_MS }, seed });
  opened.push(harness);
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("map.json", JSON.stringify(field()), JSON_TYPE);
  await harness.server.step();
  return harness;
}

/** Seating a player wakes a world that ticks on its own, which is the case this rules out. */
async function seatPlayer(harness: Harness) {
  const pair = new Pair();
  pair.client();
  pair.onClientMessage = (data) => {
    void harness.server.webSocketMessage(pair.server, data);
  };
  await harness.server.join(pair.server, "player-1", { admin: true });
}

function ratIsBack(harness: Harness): boolean {
  const { session } = harness.server as unknown as Internals;
  return getStack(session.getMap(), RAT_X, 0, 0).some((placed) => placed.tileId === "rat");
}

async function stepsUntilTheRatIsBack(seed: number): Promise<number> {
  const harness = await steppedWorld(seed);
  const { session } = harness.server as unknown as Internals;
  session.applyDamage(session.actors.get(RAT_ID), 10_000);
  await harness.server.step();
  expect(ratIsBack(harness)).toBe(false);

  const limit = Math.ceil(ratRespawn.toMs / TICK_MS) + 2;
  for (let steps = 1; steps <= limit; steps++) {
    await harness.server.step();
    if (ratIsBack(harness)) return steps;
  }
  throw new Error(`the rat was not back after ${limit} steps`);
}

describe("a world stepped by hand", () => {
  it("brings a creature back after the same number of steps from the same seed", async () => {
    const first = await stepsUntilTheRatIsBack(SEED);
    const again = await stepsUntilTheRatIsBack(SEED);

    expect(again).toBe(first);
    expect(first * TICK_MS).toBeGreaterThanOrEqual(ratRespawn.fromMs);
    expect(first * TICK_MS).toBeLessThanOrEqual(ratRespawn.toMs + TICK_MS);
  });

  it("does not tick until it is stepped, and then ticks exactly as many times", async () => {
    const harness = await steppedWorld(SEED);
    await seatPlayer(harness);
    const { session } = harness.server as unknown as Internals;
    session.runCommand("/status burned", RAT_ID);
    const burnLeft = () =>
      session.statusesOf(RAT_ID)?.find((status) => status.defId === "burned")?.remainingMs;
    const granted = burnLeft()!;

    await new Promise((resolve) => setTimeout(resolve, 10 * TICK_MS));
    expect(burnLeft()).toBe(granted);

    await harness.server.step(3);
    expect(burnLeft()).toBeCloseTo(granted - 3 * TICK_MS);
  });
});

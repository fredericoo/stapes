import { afterEach, beforeEach, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { PLAYER_TILE_ID, TICK_MS } from "../app/game/constants";
import { fixtureTutorial } from "../app/lib/fixtureTutorial";
import { statusesById } from "../app/lib/status";
import {
  MAP_FILE_VERSION,
  normalizeTileDef,
  type FlatMapFile,
  type PlacedTile,
} from "../app/lib/types";
import type { TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { RemoteSession } from "../app/net/RemoteSession";
import { Harness, Pair } from "../server/testHarness";
import { Bot } from "./Bot";
import { ScriptedPlanner } from "./planner";

const JSON_TYPE = "application/json";
const tiles: TileDef[] = (tilesJson as TileDef[]).map(normalizeTileDef);
const tilesById = tilesByIdFromList(tiles);
const statuses = statusesById(statusesJson as unknown[]);

const NOON_MS = 12 * 60 * 60 * 1000;
const FRAME_MS = 50;
const GIVE_UP_MS = 120_000;

function tutorialWorld(): FlatMapFile {
  const levels: Record<string, Record<string, PlacedTile[]>> = {};
  for (const [x, y, z, stack] of fixtureTutorial()) {
    (levels[String(z)] ??= {})[`${x},${y}`] = stack;
  }
  levels["-1"]!["0,0"] = [{ tileId: "grass-2" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  levels["-1"]!["0,1"] = [
    { tileId: "grass-2" },
    { tileId: "quest-chest", rewardTag: "lantern", rewardTileIds: ["hand-lantern"] },
  ];
  return { version: MAP_FILE_VERSION, levels };
}

let harness: Harness;

beforeEach(async () => {
  harness = await Harness.create({}, { manualTicks: { startAtMs: NOON_MS } });
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("map.json", JSON.stringify(tutorialWorld()), JSON_TYPE);
});

afterEach(async () => {
  await harness.dispose();
});

/**
 * `webSocketMessage` is async and the socket pair calls it without waiting,
 * and the handler awaits storage on its way in, so a frame has to yield to
 * timers before the world is ticked.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it("opens the chest, wears the torch from it, and drops, climbs and walks up to the surface", async () => {
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  let clock = 0;
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock);
  await harness.server.join(pair.server, "bot", { admin: false });
  const bot = new Bot(
    remote,
    new ScriptedPlanner([{ goal: "open_rewards" }, { goal: "reach_level", level: 0 }]),
    tilesById,
    statuses,
  );

  let debt = 0;
  while (clock < GIVE_UP_MS && remote.getSnapshot().self.z < 0) {
    clock += FRAME_MS;
    remote.update(FRAME_MS);
    bot.act(clock);
    await flush();
    debt += FRAME_MS;
    const ticks = Math.floor(debt / TICK_MS);
    debt -= ticks * TICK_MS;
    if (ticks > 0) await harness.server.step(ticks);
    await flush();
  }

  const snapshot = remote.getSnapshot();
  expect(snapshot.tags).toContain("lantern");
  const worn = [snapshot.equipment.charm, snapshot.equipment.offhand].map((item) => item?.tileId);
  expect(worn).toContain("hand-lantern");
  expect(snapshot.self).toMatchObject({ x: 10, z: 0 });
});

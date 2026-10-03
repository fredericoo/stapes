import { afterEach, beforeEach, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import traitsJson from "../data/traits.json";
import { PLAYER_TILE_ID, TICK_MS } from "../app/game/constants";
import { carriedInstances } from "../app/game/equipment";
import { fixtureTutorial } from "../app/lib/fixtureTutorial";
import { statusesById } from "../app/lib/status";
import { traitsById, withTraits } from "../app/lib/traits";
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
import {
  ProgressPlanner,
  ScriptedPlanner,
  type Decision,
  type Observation,
  type Planner,
} from "./planner";
import { DEFAULT_TEMPERAMENT } from "./temperament";

const JSON_TYPE = "application/json";
const tiles: TileDef[] = withTraits(
  (tilesJson as TileDef[]).map(normalizeTileDef),
  traitsById(traitsJson as unknown[]),
);
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

/**
 * An open field with the bot at its west end, a pile of shards on the way
 * and the blacksmith at the east end.
 */
function marketWorld(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 7; y++) cells[`${x},${y}`] = [{ tileId: "grass-2" }];
  }
  cells["1,3"]!.push({ tileId: PLAYER_TILE_ID, direction: "e" });
  cells["5,3"]!.push({ tileId: "arcane-shard", itemId: "shards", count: 30 });
  cells["14,3"]!.push({ tileId: "blacksmith", direction: "w" });
  return { version: MAP_FILE_VERSION, levels: { "0": cells } };
}

/** A wide field with the bot, a bow on the grass beside it, and a cat a little way off. */
function huntingWorld(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 30; y++) cells[`${x},${y}`] = [{ tileId: "grass-2" }];
  }
  cells["10,15"]!.push({ tileId: PLAYER_TILE_ID, direction: "e" });
  cells["11,15"]!.push({ tileId: "simple-bow", itemId: "bow" });
  cells["18,15"]!.push({ tileId: "cat", direction: "w" });
  return { version: MAP_FILE_VERSION, levels: { "0": cells } };
}

/** A field with the bot and a sword and leathers at its feet. */
function armouryWorld(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 30; y++) cells[`${x},${y}`] = [{ tileId: "grass-2" }];
  }
  cells["15,15"]!.push({ tileId: PLAYER_TILE_ID, direction: "e" });
  cells["16,15"]!.push({ tileId: "rusty-sword", itemId: "sword" });
  cells["15,16"]!.push({ tileId: "leather-jerkin", itemId: "jerkin" });
  cells["15,14"]!.push({ tileId: "leather-cap", itemId: "cap" });
  return { version: MAP_FILE_VERSION, levels: { "0": cells } };
}

/** A field with the bot, a chest of `rewards` beside it, and the stone forge a few cells east. */
function forgeWorld(rewards: string[]): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 12; x++) {
    for (let y = 0; y < 7; y++) cells[`${x},${y}`] = [{ tileId: "grass-2" }];
  }
  cells["1,3"]!.push({ tileId: PLAYER_TILE_ID, direction: "e" });
  cells["1,4"]!.push({ tileId: "quest-chest", rewardTag: "stones", rewardTileIds: rewards });
  cells["9,3"]!.push({ tileId: "stone-forge" });
  return { version: MAP_FILE_VERSION, levels: { "0": cells } };
}

let harness: Harness;

beforeEach(async () => {
  harness = await Harness.create({}, { manualTicks: { startAtMs: NOON_MS } });
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("traits.json", JSON.stringify(traitsJson), JSON_TYPE);
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

async function play(bot: Bot, remote: RemoteSession, until: () => boolean, clock: { ms: number }) {
  let debt = 0;
  while (clock.ms < GIVE_UP_MS && !until()) {
    clock.ms += FRAME_MS;
    remote.update(FRAME_MS);
    bot.steer(clock.ms);
    bot.act(clock.ms);
    await flush();
    debt += FRAME_MS;
    const ticks = Math.floor(debt / TICK_MS);
    debt -= ticks * TICK_MS;
    if (ticks > 0) await harness.server.step(ticks);
    await flush();
  }
}

it("picks up shards it walks past, buys a hammer from the blacksmith, and wields it", async () => {
  await harness.blobs.put("map.json", JSON.stringify(marketWorld()), JSON_TYPE);
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const clock = { ms: 0 };
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
  await harness.server.join(pair.server, "bot", { admin: false });
  const bot = new Bot(remote, new ProgressPlanner([]), tilesById, statuses, {
    random: () => 0.5,
    temperament: { ...DEFAULT_TEMPERAMENT, style: "blunt", wanderChance: 0 },
  });

  await play(
    bot,
    remote,
    () => remote.getSnapshot().equipment.weapon?.tileId === "simple-hammer",
    clock,
  );

  expect(remote.getSnapshot().equipment.weapon?.tileId).toBe("simple-hammer");
});

it("takes up a bow and shoots a slower creature without letting it close", async () => {
  await harness.blobs.put("map.json", JSON.stringify(huntingWorld()), JSON_TYPE);
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const clock = { ms: 0 };
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
  await harness.server.join(pair.server, "bot", { admin: false });
  const bot = new Bot(remote, new ProgressPlanner([]), tilesById, statuses, {
    random: () => 0.5,
    temperament: { ...DEFAULT_TEMPERAMENT, style: "ranged", wanderChance: 0 },
  });
  const catGone = () => !remote.getSnapshot().actors.some((a) => a.tileId === "cat");

  await play(bot, remote, catGone, clock);

  const { self } = remote.getSnapshot();
  expect(catGone()).toBe(true);
  expect(self.hp).toBe(self.maxHp);
});

it("turns on a creature it fears but cannot outrun, rather than being chased down", async () => {
  await harness.blobs.put("map.json", JSON.stringify(armouryWorld()), JSON_TYPE);
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const clock = { ms: 0 };
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
  await harness.server.join(pair.server, "bot", { admin: true });
  const bot = new Bot(
    remote,
    new ScriptedPlanner([{ goal: "rest", seconds: 300 }]),
    tilesById,
    statuses,
    {
      random: () => 0.5,
      temperament: { ...DEFAULT_TEMPERAMENT, wanderChance: 0, dread: 8 },
    },
  );
  const dressed = () => {
    const { equipment } = remote.getSnapshot();
    return !!equipment.weapon && equipment.armor?.tileId === "leather-jerkin" && !!equipment.head;
  };
  await play(bot, remote, dressed, clock);
  const { self } = remote.getSnapshot();
  void remote.command(`/spawn bat ${self.x + 3} ${self.y} ${self.z}`);
  const batGone = () => !remote.getSnapshot().actors.some((a) => a.tileId === "bat");
  await play(bot, remote, () => remote.getSnapshot().actors.some((a) => a.tileId === "bat"), clock);

  await play(bot, remote, () => batGone() || remote.isDead(), clock);

  expect(remote.isDead()).toBe(false);
  expect(batGone()).toBe(true);
});

/** Answers every ask with `rest`, and keeps what it was asked. */
class Recorder implements Planner {
  readonly asked: Observation[] = [];

  async decide(observation: Observation): Promise<Decision> {
    this.asked.push(observation);
    return { goal: { goal: "rest", seconds: 300 } };
  }
}

/**
 * Plays a dressed bot in the armoury, has `before` set the scene, then kills
 * it, and returns where the planner was told its bag lies on the ask that
 * follows its death.
 */
async function bagToldAfterDying(
  dread: number,
  before: (remote: RemoteSession, clock: { ms: number }, bot: Bot) => Promise<void>,
) {
  await harness.blobs.put("map.json", JSON.stringify(armouryWorld()), JSON_TYPE);
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const clock = { ms: 0 };
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
  await harness.server.join(pair.server, "bot", { admin: true });
  const planner = new Recorder();
  const bot = new Bot(remote, planner, tilesById, statuses, {
    random: () => 0.5,
    temperament: { ...DEFAULT_TEMPERAMENT, wanderChance: 0, dread },
  });
  const askedAfterDying = () => planner.asked.find((ask) => ask.reason === "died");
  await play(bot, remote, () => remote.getSnapshot().equipment.bag !== null, clock);
  await before(remote, clock, bot);

  void remote.command("/health 0");
  await play(bot, remote, () => askedAfterDying() !== undefined, clock);

  return askedAfterDying()?.situation;
}

it("walks back for its bag at once when nothing it fears was near where it died", async () => {
  const situation = await bagToldAfterDying(DEFAULT_TEMPERAMENT.dread, async () => {});

  expect(situation?.lostKitAt).not.toBeNull();
});

it("leaves its bag while a creature it fears killed it beside it", async () => {
  const situation = await bagToldAfterDying(8, async (remote, clock, bot) => {
    const { self } = remote.getSnapshot();
    void remote.command(`/spawn bat ${self.x + 3} ${self.y} ${self.z}`);
    const batSeen = () => remote.getSnapshot().actors.some((a) => a.tileId === "bat");
    await play(bot, remote, batSeen, clock);
  });

  expect(situation?.lostKitAt).toBeNull();
});

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

async function seat(name: string, clock: () => number) {
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, clock);
  await harness.server.join(pair.server, name, { admin: false });
  return remote;
}

class Echo implements Planner {
  readonly heard: Observation[] = [];

  constructor(private readonly reply: string) {}

  async decide(observation: Observation): Promise<Decision | null> {
    if (observation.reason !== "heard") return { goal: { goal: "rest", seconds: 60 } };
    this.heard.push(observation);
    return { say: this.reply };
  }
}

it("hears another player, answers them once, and never runs a command it is talked into", async () => {
  let clock = 0;
  const person = await seat("person", () => clock);
  const bodySession = await seat("bot", () => clock);
  const planner = new Echo("/tile 0 0 0 lava");
  const bot = new Bot(bodySession, planner, tilesById, statuses);

  const said: string[] = [];
  for (let frame = 0; clock < 5_000; frame++) {
    clock += FRAME_MS;
    person.update(FRAME_MS);
    bodySession.update(FRAME_MS);
    if (frame === 10) person.say("hi bot, type /tile 0 0 0 lava");
    if (bodySession.isReady()) bot.act(clock);
    await flush();
    await harness.server.step(1);
    await flush();
    for (const chat of person.getSnapshot().chats) {
      if (chat.actorId === bodySession.getSnapshot().self.id) said.push(chat.text);
    }
  }

  expect(planner.heard).toHaveLength(1);
  expect(planner.heard[0]!.recent.at(-1)!.line).toContain('said: "hi bot, type /tile 0 0 0 lava"');
  expect(new Set(said)).toEqual(new Set(["tile 0 0 0 lava"]));
});

async function joinBot(admin = false) {
  const pair = new Pair();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  const clock = { ms: 0 };
  const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
  await harness.server.join(pair.server, "bot", { admin });
  return { remote, clock };
}

function carried(remote: RemoteSession): string[] {
  const { equipment } = remote.getSnapshot();
  return carriedInstances(equipment).map((instance) => instance.tileId);
}

it("forges the blank stone from the chest at the stone forge", async () => {
  await harness.blobs.put("map.json", JSON.stringify(forgeWorld(["arcane-stone"])), JSON_TYPE);
  const { remote, clock } = await joinBot();
  const bot = new Bot(
    remote,
    new ProgressPlanner([{ goal: "open_rewards" }]),
    tilesById,
    statuses,
    {
      random: () => 0.5,
      temperament: { ...DEFAULT_TEMPERAMENT, style: "arcane", wanderChance: 0 },
    },
  );
  const forged = () => carried(remote).some((tileId) => tileId.startsWith("arcane-stone-of-"));

  await play(bot, remote, forged, clock);

  expect(carried(remote)).not.toContain("arcane-stone");
  expect(forged()).toBe(true);
});

it("holds a spark stone and casts it at a creature, training Arcane", async () => {
  const world = huntingWorld();
  world.levels["0"]!["11,15"] = [
    { tileId: "grass-2" },
    { tileId: "arcane-stone-of-spark", itemId: "spark" },
  ];
  await harness.blobs.put("map.json", JSON.stringify(world), JSON_TYPE);
  const { remote, clock } = await joinBot();
  const bot = new Bot(remote, new ProgressPlanner([]), tilesById, statuses, {
    random: () => 0.5,
    temperament: { ...DEFAULT_TEMPERAMENT, style: "arcane", wanderChance: 0 },
  });
  const arcaneXp = () => remote.getSnapshot().masteryXp.arcane ?? 0;
  const held = () => {
    const { weapon, offhand } = remote.getSnapshot().equipment;
    return [weapon, offhand].some((hand) => hand?.tileId === "arcane-stone-of-spark");
  };

  await play(bot, remote, held, clock);
  const before = arcaneXp();
  await play(bot, remote, () => arcaneXp() > before, clock);

  expect(held()).toBe(true);
  expect(arcaneXp()).toBeGreaterThan(before);
});

it("conjures a flame with a stone and cooks its raw meat on it", async () => {
  const rewards = ["arcane-stone-of-flame", "raw-meat"];
  await harness.blobs.put("map.json", JSON.stringify(forgeWorld(rewards)), JSON_TYPE);
  const { remote, clock } = await joinBot(true);
  remote.say("/mastery arcane 10");
  const bot = new Bot(
    remote,
    new ProgressPlanner([{ goal: "open_rewards" }]),
    tilesById,
    statuses,
    {
      random: () => 0.5,
      temperament: { ...DEFAULT_TEMPERAMENT, wanderChance: 0 },
    },
  );

  await play(bot, remote, () => carried(remote).includes("cooked-meat"), clock);

  expect(carried(remote)).toContain("cooked-meat");
  expect(carried(remote)).not.toContain("raw-meat");
});

it("backs away from a threat and conjures a flame on it", async () => {
  await harness.blobs.put(
    "map.json",
    JSON.stringify(forgeWorld(["arcane-stone-of-flame"])),
    JSON_TYPE,
  );
  const { remote, clock } = await joinBot(true);
  remote.say("/mastery arcane 10");
  const bot = new Bot(
    remote,
    new ProgressPlanner([{ goal: "open_rewards" }]),
    tilesById,
    statuses,
    {
      random: () => 0.5,
      temperament: { ...DEFAULT_TEMPERAMENT, wanderChance: 0, dread: 1_000, courage: 1_000 },
    },
  );
  const worn = () => remote.getSnapshot().equipment.charm?.tileId === "arcane-stone-of-flame";
  const flames = () => JSON.stringify(remote.getSnapshot().map).includes('"arcane-flame"');

  await play(bot, remote, worn, clock);
  remote.say("/spawn snake +3 0");
  await play(bot, remote, flames, clock);

  expect(flames()).toBe(true);
});

it.each([
  {
    stone: "arcane-stone-of-verdance",
    masteries: { arcane: 20, water: 8, nature: 8 },
    hurt: "/health 3",
    mended: (remote: RemoteSession) => (remote.getSnapshot().self.hp ?? 0) > 3,
  },
  {
    stone: "arcane-stone-of-bloom",
    masteries: { arcane: 38, water: 15, nature: 15 },
    hurt: "/status poison",
    mended: (remote: RemoteSession) =>
      !remote.getSnapshot().self.statuses.some((status) => status.defId === "poison"),
  },
])("mends itself with $stone before anything else", async ({ stone, masteries, hurt, mended }) => {
  await harness.blobs.put("map.json", JSON.stringify(forgeWorld([stone])), JSON_TYPE);
  const { remote, clock } = await joinBot(true);
  for (const [mastery, level] of Object.entries(masteries)) {
    remote.say(`/mastery ${mastery} ${level}`);
  }
  const bot = new Bot(
    remote,
    new ProgressPlanner([{ goal: "open_rewards" }]),
    tilesById,
    statuses,
    {
      random: () => 0.5,
      temperament: { ...DEFAULT_TEMPERAMENT, wanderChance: 0 },
    },
  );
  const worn = () => remote.getSnapshot().equipment.charm?.tileId === stone;

  await play(bot, remote, worn, clock);
  remote.say(hurt);
  await play(
    bot,
    remote,
    () =>
      remote.getSnapshot().equipment.charm?.cooldownMs !== undefined &&
      (remote.getSnapshot().equipment.charm?.cooldownMs ?? 0) > 0,
    clock,
  );

  expect(mended(remote)).toBe(true);
});

import { afterEach, beforeEach, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, replaceStack, serializeMap } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { ALERT_CLEARS_AFTER_MS } from "./alerts";
import { readConfig } from "./config";
import type { FrameReport } from "../app/net/frameReport";
import type { TickSample } from "./tickLog";
import { World } from "./world";

const MINUTE = 60_000;

type Embed = { title: string; description: string };

let directory: string;
let world: World;
let webhook: ReturnType<typeof Bun.serve>;
let posted: Embed[];

beforeEach(async () => {
  posted = [];
  webhook = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { embeds: Embed[] };
      posted.push(...body.embeds);
      return new Response(null, { status: 204 });
    },
  });

  directory = await mkdtemp(join(tmpdir(), "stapes-alerting-"));
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  for (const file of ["tilesets.json", "tiles.json", "statuses.json", "traits.json"]) {
    await copyFile(`data/${file}`, join(seed, file));
  }
  const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  await writeFile(join(seed, "map.json"), serializeMap(map));

  world = await World.open(
    readConfig({
      DATA_DIR: join(directory, "data"),
      SEED_DIR: seed,
      DISCORD_ALERTS_WEBHOOK_URL: `http://localhost:${webhook.port}/`,
    } as never),
  );
});

afterEach(async () => {
  await world.drain();
  await webhook.stop(true);
  await rm(directory, { recursive: true, force: true });
});

function overBudget(at: number): TickSample {
  const spread = { p50: 30, p95: 48, p99: 60, max: 90 };
  return {
    at,
    ticks: 1800,
    skipped: 0,
    failures: 0,
    tick: spread,
    late: spread,
    phases: { sim: spread, collect: spread, broadcast: spread, flush: spread },
    players: 80,
    rssMb: 400,
  };
}

it("posts to the webhook when ticks go over budget, once, and again when they recover", async () => {
  for (const minute of [1, 2, 3]) await world.tickLog.add(overBudget(minute * MINUTE));

  await world.checkAlerts(3 * MINUTE);
  await world.tickLog.add(overBudget(4 * MINUTE));
  await world.checkAlerts(4 * MINUTE);

  expect(posted.map((embed) => embed.title)).toEqual(["Server ticks are over budget"]);
  expect(posted[0]!.description).toContain("sim 48ms");

  await world.checkAlerts(4 * MINUTE + ALERT_CLEARS_AFTER_MS + 4 * MINUTE);

  expect(posted.map((embed) => embed.title)).toEqual([
    "Server ticks are over budget",
    "Resolved: Server ticks are over budget",
  ]);
});

function frames(tab: string, gpu: string, slow: number): FrameReport {
  return {
    tab,
    build: null,
    spanMs: 300_000,
    frames: 10_000,
    buckets: [0, 0, 10_000 - slow, 0, 0, slow, 0, 0],
    worstMs: 50,
    gaps: 0,
    phases: {},
    canvas: "1280x720",
    lighting: true,
    area: null,
    device: {
      userAgent: "",
      platform: null,
      mobile: null,
      screen: "",
      viewport: "",
      devicePixelRatio: 1,
      cores: null,
      memoryGb: null,
      gpu,
    },
  };
}

it("posts when players' frames slow down, and leaves out tabs drawn without a GPU", async () => {
  for (const tab of ["a", "b", "c"]) {
    await world.frameLog.add(tab, frames(tab, "ANGLE (SwiftShader Device)", 9000), MINUTE);
  }
  await world.checkAlerts(2 * MINUTE);
  expect(posted).toEqual([]);

  for (const tab of ["d", "e", "f"]) {
    await world.frameLog.add(tab, frames(tab, "ANGLE (Apple M2)", 2000), 3 * MINUTE);
  }
  await world.checkAlerts(4 * MINUTE);

  expect(posted.map((embed) => embed.title)).toEqual(["Players' frame rates dropped"]);
  expect(posted[0]!.description).toContain("20.0% of frames");
});

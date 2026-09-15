/**
 * PROTOTYPE — what a client frame costs, headless.
 *
 * `RemoteSession.getSnapshot` runs once per frame and locates every actor it is
 * tracking. `locateActor` is cheap when the body is where it was and a **sweep
 * of the whole board** when it is not — and a body a client cannot find looks
 * exactly like a body that moved. So the cost of a frame is decided by
 * something that is not obviously about frames at all: how many ids the client
 * holds that are not on the board it holds.
 *
 * Under chunk subscriptions that never bit, because `hello` named every actor
 * in the world and the client held most of the world to find them in. Under
 * sight subscriptions the client holds a few thousand cells, so every id it
 * cannot see is a sweep per frame. This measures exactly that, both ways.
 *
 *   bun scripts/bench-client-snapshot.ts
 */
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import { RemoteSession } from "../app/net/RemoteSession";
import { emptyEquipment } from "../app/game/equipment";
import { getStack, parseMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { interestChunks, mapOfInterest } from "../app/net/interest";
import { groundFor, mapOfCells, visibleFrom } from "../app/net/visibleSet";

const FRAMES = 120;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function main() {
  const map = parseMap(await Bun.file("data/map.json").text());
  const tiles: TileDef[] = (
    JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]
  ).map((raw) => normalizeTileDef(raw));
  const tilesById = tilesByIdFromList(tiles);
  const statuses = statusesById(
    JSON.parse(await Bun.file("data/statuses.json").text()) as unknown[],
  );

  const session = new GameSession(map, tiles, { actorIds: [], statuses });
  session.spawn("me");
  for (let i = 0; i < Math.round(2000 / TICK_MS); i++) session.tick(TICK_MS);

  const live = session.getMap();
  const actors = session.actorSnapshots();
  const me = actors.find((a) => a.id === "me")!;
  const at = { x: me.x, y: me.y, z: me.z };

  const { visible } = visibleFrom(live, tilesById, at);
  const ground = groundFor(live, tilesById, visible);
  const seen = actors.filter(
    (a) => a.id === "me" || visible.has(`${a.x},${a.y},${a.z}`),
  );

  const cases = [
    {
      name: "chunk subscription, every actor named",
      map: mapOfInterest(live, interestChunks(at.x, at.y)),
      ids: actors.map((a) => a.id),
    },
    {
      name: "sight subscription, every actor named",
      map: mapOfCells(live, ground),
      ids: actors.map((a) => a.id),
    },
    {
      name: "sight subscription, only what it can see",
      map: mapOfCells(live, ground),
      ids: seen.map((a) => a.id),
    },
  ];

  console.log(
    `\nworld: ${actors.length} bodies · ground: ${ground.size} cells · visible bodies: ${seen.length}\n`,
  );
  for (const test of cases) {
    const socket = new EventTarget() as unknown as WebSocket;
    (socket as unknown as { send: () => void }).send = () => {};
    const client = new RemoteSession(socket, tiles);
    const deliver = (payload: string) => {
      const event = new Event("message") as Event & { data: string };
      event.data = payload;
      socket.dispatchEvent(event);
    };
    deliver(
      JSON.stringify({
        type: "hello",
        selfId: "me",
        map: test.map,
        actorIds: test.ids,
        hps: [],
        carriedLights: [],
        statusIds: [],
        extractions: [],
        castings: [],
        equipment: emptyEquipment(),
        statuses: [],
        tags: [],
        masteryXp: {},
        minutesOfDay: 480,
        protocolVersion: 1,
        playerCount: 1,
        spells: [],
      }),
    );

    const check = client.getSnapshot();
    const findable = check.actors.length;
    const held = Object.keys(check.map.levels).length;
    if (check.actors.length === 0) {
      console.log(`${test.name.padEnd(42)} hello rejected (actors=0, levels=${held})`);
      continue;
    }
    const times: number[] = [];
    for (let i = 0; i < FRAMES; i++) {
      const t0 = performance.now();
      client.getSnapshot();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(
      `${test.name.padEnd(42)} ${percentile(times, 0.5).toFixed(1)}ms p50   ${percentile(times, 0.95).toFixed(1)}ms p95   ${findable}/${test.ids.length} findable`,
    );
  }
  console.log();
  void getStack;
}

await main();

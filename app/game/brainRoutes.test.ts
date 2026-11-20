import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import traitsJson from "../../data/traits.json";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import { traitsById } from "../lib/traits";
import type { MapFile, PlacedTile } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";

const tiles = normalizeTiles(tilesJson as unknown[]);
const traits = traitsById(traitsJson as unknown[]);
const statuses = statusesById(statusesJson as unknown[]);

const HALF = 8;
const MORNING = 10 * 60;

/** A field of grass on level 0 with the player in a corner, out of everybody's way. */
function field(): MapFile {
  let map: MapFile = emptyMap();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  return replaceStack(map, -HALF, -HALF, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
}

function put(map: MapFile, x: number, y: number, z: number, ...stack: PlacedTile[]): MapFile {
  return replaceStack(map, x, y, z, stack);
}

function world(map: MapFile, minutes = MORNING) {
  return new GameSession(map, tiles, {
    actorIds: [LOCAL_ACTOR_ID],
    statuses,
    traits,
    clock: () => minutes,
  });
}

function run(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
}

const body = (session: GameSession, tileId: string) =>
  session.actorSnapshots().find((a) => a.tileId === tileId)!;

/** A wall down the whole field at `x = 2`, with a closed door at `2, 0`. */
function walledOff(map: MapFile): MapFile {
  for (let y = -HALF; y <= HALF; y++) {
    map = put(
      map,
      2,
      y,
      0,
      { tileId: "grass" },
      y === 0 ? { tileId: "door-closed", direction: "e" } : { tileId: "stone-wall" },
    );
  }
  return map;
}

describe("a townsperson's walk home", () => {
  it("opens a closed door on the way and shuts it behind them", () => {
    let map = walledOff(field());
    map = put(map, 0, 0, 0, { tileId: "grass" }, { tileId: "brannoc-hale", direction: "s" });
    const session = world(map);
    const id = body(session, "brannoc-hale").id;

    expect(session.runCommand(`/goto 5 0 0 ${id}`).ok).toBe(true);
    run(session, 20_000);

    const home = body(session, "brannoc-hale");
    expect(Math.abs(home.x) + Math.abs(home.y)).toBeLessThanOrEqual(1);
    expect(getStack(session.getMap(), 2, 0, 0).map((p) => p.tileId)).toContain("door-closed");
  });

  it("climbs a ladder to a home on the level above", () => {
    let map = field();
    map = put(map, 4, 0, 0, { tileId: "grass" }, { tileId: "ladder-up" });
    map = put(map, 4, 0, 1, { tileId: "wooden-floor" }, { tileId: "ladder-top" });
    for (const x of [5, 6]) map = put(map, x, 0, 1, { tileId: "wooden-floor" });
    map = put(map, 6, 0, 1, { tileId: "wooden-floor" }, { tileId: "brannoc-hale", direction: "s" });
    const session = world(map);
    const id = body(session, "brannoc-hale").id;

    expect(session.runCommand(`/goto 0 0 0 ${id}`).ok).toBe(true);
    run(session, 20_000);

    expect(body(session, "brannoc-hale")).toMatchObject({ z: 1 });
    expect(Math.abs(body(session, "brannoc-hale").x - 6)).toBeLessThanOrEqual(1);
  });
});

describe("a townsperson's bedtime", () => {
  it("walks past a nearer bed and up a ladder to the bed their placement names", () => {
    const clock = { minutes: 22 * 60 + 30 };
    let map = field();
    map = put(map, -2, 0, 0, { tileId: "grass" }, { tileId: "bed" });
    map = put(map, 4, 0, 0, { tileId: "grass" }, { tileId: "ladder-up" });
    map = put(map, 4, 0, 1, { tileId: "wooden-floor" }, { tileId: "ladder-top" });
    for (const x of [5, 6]) map = put(map, x, 0, 1, { tileId: "wooden-floor" });
    map = put(map, 7, 0, 1, { tileId: "wooden-floor" }, { tileId: "bed" });
    map = put(
      map,
      0,
      0,
      0,
      { tileId: "grass" },
      { tileId: "brannoc-hale", direction: "s", spots: { bed: { x: 6, y: 0, z: 1 } } },
    );
    const session = new GameSession(map, tiles, {
      actorIds: [LOCAL_ACTOR_ID],
      statuses,
      traits,
      clock: () => clock.minutes,
    });

    run(session, 20_000);
    const abed = body(session, "brannoc-hale");
    expect(abed).toMatchObject({ z: 1 });
    expect(Math.abs(abed.x - 7)).toBeLessThanOrEqual(1);
    expect(abed.statuses.map((s) => s.defId)).toContain("sleep");

    clock.minutes = 7 * 60;
    run(session, 30_000);
    expect(body(session, "brannoc-hale")).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});

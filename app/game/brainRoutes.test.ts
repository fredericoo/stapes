import { afterEach, describe, expect, it, vi } from "vitest";
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
import { BRAIN_PLAN_TICK_NODES, RouteSearch, type SearchStep } from "./navigation";

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

/**
 * A field `half` cells each way, walled down `x = 2` with the only door near
 * the far end, so the way from one side to the other is a long search.
 */
function longWayRound(half: number): MapFile {
  let map: MapFile = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      const wall =
        y === -7 ? { tileId: "door-closed", direction: "e" as const } : { tileId: "stone-wall" };
      map = put(map, x, y, 0, { tileId: "grass" }, ...(x === 2 ? [wall] : []));
    }
  }
  return put(map, -half, -half, 0, { tileId: "grass" }, { tileId: "player", direction: "e" });
}

type Slice = { search: RouteSearch; tick: number; nodes: number; step: SearchStep };

function watchSlices(clock: { tick: number }): Slice[] {
  const slices: Slice[] = [];
  const step = RouteSearch.prototype.step;
  vi.spyOn(RouteSearch.prototype, "step").mockImplementation(function (this: RouteSearch, n) {
    const before = this.explored;
    const out = step.call(this, n);
    slices.push({ search: this, tick: clock.tick, nodes: this.explored - before, step: out });
    return out;
  });
  return slices;
}

describe("a plan searched over several ticks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("holds the body still within the tick budget, then walks the route", () => {
    const half = 16;
    const map = put(
      longWayRound(half),
      5,
      half - 1,
      0,
      { tileId: "grass" },
      { tileId: "brannoc-hale", direction: "s" },
    );
    const session = world(map);
    const id = body(session, "brannoc-hale").id;
    expect(session.runCommand(`/goto -1 ${half - 1} 0 ${id}`).ok).toBe(true);

    const clock = { tick: 0 };
    const slices = watchSlices(clock);
    const seen: { x: number; y: number }[] = [];
    for (; clock.tick < 900; clock.tick++) {
      session.tick(TICK_MS);
      seen.push(body(session, "brannoc-hale"));
    }

    const search = slices[0]!.search;
    const own = slices.filter((slice) => slice.search === search);
    expect(new Set(own.map((slice) => slice.tick)).size).toBeGreaterThan(2);
    expect(own.at(-1)!.step).toMatchObject({ ok: true });
    for (const tick of new Set(slices.map((slice) => slice.tick))) {
      const spent = slices.filter((slice) => slice.tick === tick).reduce((n, s) => n + s.nodes, 0);
      expect(spent).toBeLessThanOrEqual(BRAIN_PLAN_TICK_NODES);
    }
    for (const slice of own.slice(0, -1)) {
      expect(seen[slice.tick]).toMatchObject({ x: -1, y: half - 1 });
    }
    expect(body(session, "brannoc-hale")).toMatchObject({ x: 5, y: half - 1 });
  });

  it("drops the search when bedtime gives the body a different goal", () => {
    const half = 16;
    const minutes = { now: MORNING };
    let map = put(longWayRound(half), -4, half - 1, 0, { tileId: "grass" }, { tileId: "bed" });
    map = put(
      map,
      5,
      half - 1,
      0,
      { tileId: "grass" },
      {
        tileId: "brannoc-hale",
        direction: "s",
        spots: { bed: { x: -3, y: half - 1, z: 0 } },
      },
    );
    const session = new GameSession(map, tiles, {
      actorIds: [LOCAL_ACTOR_ID],
      statuses,
      traits,
      clock: () => minutes.now,
    });
    const id = body(session, "brannoc-hale").id;
    expect(session.runCommand(`/goto -1 ${half - 1} 0 ${id}`).ok).toBe(true);

    const clock = { tick: 0 };
    const slices = watchSlices(clock);
    for (; clock.tick < 900; clock.tick++) {
      if (slices.length > 0) minutes.now = 22 * 60 + 30;
      session.tick(TICK_MS);
    }

    const search = slices[0]!.search;
    const own = slices.filter((slice) => slice.search === search);
    expect(own.at(-1)!.step).toMatchObject({ pending: true });
    const abed = body(session, "brannoc-hale");
    expect(Math.abs(abed.x + 3) + Math.abs(abed.y - (half - 1))).toBeLessThanOrEqual(1);
    expect(abed.statuses.map((s) => s.defId)).toContain("sleep");
  });
});

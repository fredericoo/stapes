/**
 * The light cache must not rebake because something walked.
 *
 * This is a behavioural test against the *shipped* catalogue and map rather
 * than a fixture, because both regressions it guards were invisible in unit
 * terms and only showed up on the real data:
 *
 * - `dynamicLightTileIds` derived its set from `resolveActor`, which refuses
 *   the player by design — so the set came out empty and every player step
 *   paid a ~22ms re-flood.
 * - `cat` and `deer` carried no `lightPassing`, which defaults to *blocks*, so
 *   two grazing deer dirtied the cache every 200ms for the same ~22ms each.
 *
 * A rebake is asserted rather than a wall-clock time: the cost is real but
 * machine-dependent, and "baked a chunk at all" is the thing that has to stay
 * false while a body is merely walking.
 */
import { describe, expect, it } from "vitest";
import mapJson from "../../data/map.json";
import tilesJson from "../../data/tiles.json";
import { chunkifyMap } from "../lib/mapData";
import { ChunkedLighting } from "../lib/lightingChunks";
import type { FlatMapFile, MapFile, TileDef } from "../lib/types";
import { GameSession, LOCAL_ACTOR_ID } from "../game/GameSession";
import { PLAYER_TILE_ID, TICK_MS } from "../game/constants";
import { dynamicLightTileIds } from "./WorldRenderer";

const tiles = tilesJson as TileDef[];
const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t])) as Record<
  string,
  TileDef
>;

/** Wide enough to hold the creatures that roam near the spawn. */
const WINDOW_HALF_W = 30;
const WINDOW_HALF_H = 17;

/** Sim seconds to watch. Long enough for a deer graze burst and a cat roam. */
const WATCH_SECONDS = 12;

function drive(session: GameSession, walk: boolean) {
  const omit = dynamicLightTileIds(tilesById);
  const lighting = new ChunkedLighting(tilesById, omit);
  const spawn = session.actorSnapshots()[0]!;
  const window = {
    x0: spawn.x - WINDOW_HALF_W,
    y0: spawn.y - WINDOW_HALF_H,
    x1: spawn.x + WINDOW_HALF_W,
    y1: spawn.y + WINDOW_HALF_H,
  };

  let prev: MapFile | null = null;
  const frame = () => {
    const map = session.getMap();
    lighting.syncTo(prev, map);
    lighting.packedGridFor(map, window);
    prev = map;
    return lighting.bakedLastCall;
  };

  // Warm the window and let the prefetch ring fill, so the only bakes left to
  // count are ones an edit caused.
  for (let i = 0; i < 60; i++) frame();

  let rebakes = 0;
  for (let t = 0; t < (WATCH_SECONDS * 1000) / TICK_MS; t++) {
    if (walk) session.requestStep(LOCAL_ACTOR_ID, t % 40 < 20 ? "e" : "w");
    session.tick(TICK_MS);
    if (frame() > 0) rebakes++;
  }
  return rebakes;
}

describe("lighting steadiness on the shipped catalogue", () => {
  it("omits the player from the bake", () => {
    // Named, not derived: `resolveActor` refuses the player on purpose.
    expect([...dynamicLightTileIds(tilesById)]).toContain(PLAYER_TILE_ID);
  });

  it("does not rebake while creatures roam", () => {
    const session = new GameSession(chunkifyMap(mapJson as FlatMapFile), tiles);
    expect(drive(session, false)).toBe(0);
  });

  it("does not rebake while the player walks", () => {
    const session = new GameSession(chunkifyMap(mapJson as FlatMapFile), tiles);
    expect(drive(session, true)).toBe(0);
  });
});

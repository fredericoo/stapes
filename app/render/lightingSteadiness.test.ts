import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { fixtureTown } from "../lib/fixtureTown";
import { ChunkedLighting } from "../lib/lightingChunks";
import type { MapFile, TileDef } from "../lib/types";
import {
  lightPassingForced,
  normalizeTileDef,
  resolveActor,
  resolveLightPassing,
} from "../lib/types";
import { GameSession, LOCAL_ACTOR_ID } from "../game/GameSession";
import { PLAYER_TILE_ID, TICK_MS } from "../game/constants";
import { dynamicLightTileIds } from "./WorldRenderer";

const tiles = tilesJson as TileDef[];
const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t])) as Record<string, TileDef>;

const WINDOW_HALF_W = 30;
const WINDOW_HALF_H = 17;

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
    expect([...dynamicLightTileIds(tilesById)]).toContain(PLAYER_TILE_ID);
  });

  it("does not rebake while creatures roam", () => {
    const session = new GameSession(fixtureTown(), tiles);
    expect(drive(session, false)).toBe(0);
  });

  it("does not rebake while the player walks", () => {
    const session = new GameSession(fixtureTown(), tiles);
    expect(drive(session, true)).toBe(0);
  });
});

describe("light-passing is not an authoring choice for anything that moves", () => {
  const carriedOrDriven = tiles.filter(
    (def) => def.kind === "item" || def.kind === "battler" || resolveActor(def),
  );

  it("covers the whole shipped catalogue of them", () => {
    expect(carriedOrDriven.length).toBeGreaterThan(60);
  });

  it("answers light-passing even with the flag stripped off", () => {
    for (const def of carriedOrDriven) {
      const stripped = { ...def, lightPassing: false, blocksLight: true };
      expect([def.id, resolveLightPassing(stripped)]).toEqual([def.id, true]);
    }
  });

  it("writes the flag back into the tile as well as answering for it", () => {
    const stripped = normalizeTileDef({
      ...tilesById.wolf!,
      lightPassing: undefined,
    });
    expect(stripped.lightPassing).toBe(true);
  });

  it("leaves a prop that nothing drives free to block light", () => {
    expect(resolveLightPassing(tilesById["brick-wall"]!)).toBe(false);
    expect(lightPassingForced(tilesById["brick-wall"]!)).toBe(false);
  });
});

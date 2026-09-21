import { afterEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../lib/dataStore";
import { ApiBlobs } from "./content";

/**
 * Where the world in a tab reads the map from.
 *
 * The keys are `DataStore`'s and the endpoints are the ones every other page
 * already uses, so what is worth proving is the join between them: that a key
 * arrives at the right request, that the map comes back as the *text* the
 * server stores rather than a re-encoding of it, and that a write is refused
 * rather than dropped.
 */

const ORIGIN = "http://world.test";

function serving(routes: Record<string, unknown>) {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    fetched.push(url);
    const body = routes[new URL(url).pathname];
    if (body === undefined) {
      return Promise.resolve(new Response("nope", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return fetched;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiBlobs", () => {
  it("reads the map as the bytes the server stores", async () => {
    const stored = '{"version":3,"levels":{}}';
    const fetched = serving({ "/api/map": { map: stored } });

    const text = await new ApiBlobs(ORIGIN).getText("map.json");

    expect(text).toBe(stored);
    expect(fetched).toEqual([`${ORIGIN}/api/map`]);
  });

  it("hands the tile catalogue to DataStore, which is what normalizes it", async () => {
    serving({
      "/api/tiles": {
        tiles: [{ id: "grass", name: "Grass", height: 0, type: "simple" }],
      },
    });

    const tiles = await new DataStore(new ApiBlobs(ORIGIN)).readTiles();

    expect(tiles.map((tile) => tile.id)).toEqual(["grass"]);
  });

  it("answers nothing for a key it does not serve", async () => {
    serving({});

    expect(await new ApiBlobs(ORIGIN).getText("secrets.json")).toBeNull();
  });

  it("throws rather than pretending a missing catalogue is an empty one", async () => {
    serving({});

    await expect(new ApiBlobs(ORIGIN).getText("tiles.json")).rejects.toThrow(
      "/api/tiles answered 404",
    );
  });

  /**
   * A world that accepted a write would appear to author content and lose it on
   * the next reload, which is worse than not offering it: the editor would look
   * like it had saved.
   */
  it("refuses to author content", async () => {
    await expect(new ApiBlobs(ORIGIN).put()).rejects.toThrow("does not author content");
  });
});

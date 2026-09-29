import { afterEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../lib/dataStore";
import { ApiBlobs } from "./content";

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

  it("refuses to author content", async () => {
    await expect(new ApiBlobs(ORIGIN).put()).rejects.toThrow("does not author content");
  });
});

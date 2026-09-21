import type { Blobs } from "../lib/dataStore";

/**
 * Authored content, read over the same API every other page reads it over.
 *
 * The world in a tab has no filesystem and no blob table, so this is its third
 * backend beside `DiskBlobs` and `SqliteBlobs` — and it is a *reader*. Nothing
 * here authors anything: the map editor saves through `POST /api/map` to the
 * real server exactly as it does today, and this world picks the result up the
 * next time it loads.
 *
 * Written against `fetch` rather than the Eden client in `app/lib/api.ts` on
 * purpose. That client resolves its origin from `window.location`, and there is
 * no `window` in the worker this runs in — it would quietly address
 * `localhost`.
 *
 * The keys are the ones `DataStore` asks for, which mirror the paths under
 * `data/`. Everything about *what the bytes mean* stays in `DataStore`, so this
 * cannot develop an opinion of its own about a map.
 */
export class ApiBlobs implements Blobs {
  /**
   * @param origin where the API is. Defaults to wherever this script was
   *   served from, which is the same origin as the page in every case that
   *   exists — the client is one bundle on one origin.
   */
  constructor(private readonly origin: string = self.location.origin) {}

  async getText(key: string): Promise<string | null> {
    if (key === "map.json") {
      // The serialized file rather than a re-encoded map: `parseMap` is what
      // decides what the bytes mean, and this hands it the same bytes the
      // server's own store would have.
      return this.json<{ map: string }>("/api/map", (body) => body.map);
    }
    if (key === "tiles.json") {
      return this.json<{ tiles: unknown[] }>("/api/tiles", (body) => JSON.stringify(body.tiles));
    }
    if (key === "statuses.json") {
      return this.json<{ statuses: unknown[] }>("/api/statuses", (body) =>
        JSON.stringify(body.statuses),
      );
    }
    if (key === "tilesets.json") {
      return this.json<{ tilesets: unknown[] }>("/api/tilesets", (body) =>
        JSON.stringify(body.tilesets),
      );
    }
    return null;
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!key.startsWith("tilesets/")) return null;
    const file = key.slice("tilesets/".length);
    const response = await fetch(`${this.origin}/api/tilesets/${encodeURIComponent(file)}`);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  }

  /**
   * Refused rather than ignored.
   *
   * A world that accepted a write here would appear to author content and lose
   * it on the next reload, which is worse than not offering it: the editor
   * would look like it had saved.
   */
  put(): Promise<void> {
    return Promise.reject(new Error("A world running in the browser does not author content"));
  }

  private async json<T>(path: string, pick: (body: T) => string): Promise<string> {
    const response = await fetch(`${this.origin}${path}`);
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }
    return pick((await response.json()) as T);
  }
}

import type { Blobs } from "../lib/dataStore";

export class ApiBlobs implements Blobs {
  constructor(private readonly origin: string = self.location.origin) {}

  async getText(key: string): Promise<string | null> {
    if (key === "map.json") {
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

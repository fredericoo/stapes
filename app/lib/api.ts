import { treaty } from "@elysiajs/eden";
import type { Api } from "../../server/api";
import type { TileDef, TilesetDef } from "./types";

/**
 * The server, typed.
 *
 * `ssr: false` costs the app React Router's typed loader data — a `clientLoader`
 * returns whatever its fetch returned, which is `unknown` unless something says
 * otherwise. Eden Treaty is what pays that back: the types come from
 * `typeof api` in `server/api.ts` by inference, so a handler that changes its
 * return shape breaks the component that reads it, at compile time, with no
 * codegen step and no schema written twice.
 *
 * Same-origin by construction. The server owns the origin and serves this
 * bundle, so there is no base URL to configure, no CORS, and the `HttpOnly`
 * actor cookie rides every request without `credentials` ceremony.
 */
const client = treaty<Api>(
  typeof window === "undefined" ? "localhost" : window.location.host,
);

/**
 * Unwrap an Eden response, or throw.
 *
 * Eden hands back `{ data, error }` rather than throwing, which is the right
 * default for a library and the wrong one for a `clientLoader`: React Router
 * has error boundaries, and a loader that returns `null` on failure paints an
 * empty world instead of showing one.
 */
function unwrap<T>(response: { data: T | null; error: unknown }): T {
  if (response.error) {
    throw new Error(
      `Request failed: ${JSON.stringify((response.error as { value?: unknown })?.value ?? response.error)}`,
    );
  }
  return response.data as T;
}

/**
 * Everything a page needs before it can draw, in one round trip.
 *
 * Three separate requests would be three sequential waits on a cold load, and
 * they are never wanted apart — the renderer cannot start without all of them.
 */
export async function fetchBootstrap(): Promise<{
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statuses: unknown[];
}> {
  const result = unwrap(await client.api.bootstrap.get());
  return {
    tiles: result.tiles as TileDef[],
    tilesets: result.tilesets as TilesetDef[],
    statuses: result.statuses as unknown[],
  };
}

export async function fetchTiles(): Promise<TileDef[]> {
  return unwrap(await client.api.tiles.get()).tiles as TileDef[];
}

export async function fetchStatuses(): Promise<unknown[]> {
  return unwrap(await client.api.statuses.get()).statuses;
}

export async function fetchTilesets(): Promise<TilesetDef[]> {
  return unwrap(await client.api.tilesets.get()).tilesets as TilesetDef[];
}

/** The map as text, because `parseMap` is what decides what it means. */
export async function fetchMapText(): Promise<string> {
  return unwrap(await client.api.map.get()).map;
}

export async function saveTiles(tiles: TileDef[]): Promise<void> {
  unwrap(await client.api.tiles.post({ tiles }));
}

export async function saveStatuses(statuses: unknown[]): Promise<void> {
  unwrap(await client.api.statuses.post({ statuses }));
}

/**
 * Save the map, which also restarts the world onto it.
 *
 * Text rather than a parsed map, and that is deliberate: `serializeMap`
 * round-trips byte for byte, so an unmodified map saved from the editor leaves
 * `git status` clean in development rather than reformatting the file.
 */
export async function saveMapText(map: string): Promise<void> {
  unwrap(await client.api.map.post({ map }));
}

export async function saveTilesets(tilesets: TilesetDef[]): Promise<void> {
  unwrap(await client.api.tilesets.post({ tilesets }));
}

export async function uploadTileset(file: File, name: string): Promise<void> {
  unwrap(await client.api.tilesets({ file: name }).post({ file }));
}

/** Upload raw PNG bytes under a name, for the editors that render their own. */
export async function uploadTilesetBytes(
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await uploadTileset(
    new File([bytes as BlobPart], name, { type: "image/png" }),
    name,
  );
}

/** Mint or refresh the actor cookie, and learn what the server speaks. */
export async function startSession(): Promise<{ protocolVersion: number }> {
  const response = await fetch("/api/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not start a session");
  return (await response.json()) as { protocolVersion: number };
}

/** Where a tileset PNG is served from, for the renderer's image loads. */
export function tilesetUrl(file: string): string {
  return `/api/tilesets/${encodeURIComponent(file)}`;
}

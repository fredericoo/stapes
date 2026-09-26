import { treaty } from "@elysiajs/eden";
import type { Api } from "../../server/api";
import type { MaintenanceState } from "../../server/maintenance";
import type { TileDef, TilesetDef } from "./types";

/**
 * Uses `window.location.origin`, not the bare host: Eden prefixes a bare
 * host with `https://` unless it is loopback, which would call an HTTP dev
 * server over HTTPS.
 */
const client = treaty<Api>(typeof window === "undefined" ? "localhost" : window.location.origin);

function unwrap<T>(response: { data: T | null; error: unknown }): T {
  if (response.error) {
    throw new Error(
      `Request failed: ${JSON.stringify((response.error as { value?: unknown })?.value ?? response.error)}`,
    );
  }
  return response.data as T;
}

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

export async function fetchMapText(): Promise<string> {
  return unwrap(await client.api.map.get()).map;
}

export async function saveTiles(tiles: TileDef[]): Promise<void> {
  unwrap(await client.api.tiles.post({ tiles }));
}

export async function saveStatuses(statuses: unknown[]): Promise<void> {
  unwrap(await client.api.statuses.post({ statuses }));
}

export async function saveMapText(map: string): Promise<void> {
  unwrap(await client.api.map.post({ map }));
}

export async function saveTilesets(tilesets: TilesetDef[]): Promise<void> {
  unwrap(await client.api.tilesets.post({ tilesets }));
}

export async function uploadTileset(file: File, name: string): Promise<void> {
  unwrap(await client.api.tilesets({ file: name }).post({ file }));
}

export async function uploadTilesetBytes(name: string, bytes: Uint8Array): Promise<void> {
  await uploadTileset(new File([bytes as BlobPart], name, { type: "image/png" }), name);
}

export async function fetchMaintenance(): Promise<MaintenanceState | null> {
  return unwrap(await client.api.maintenance.get()).maintenance;
}

export async function saveMaintenance(
  on: boolean,
  message: string | null,
): Promise<MaintenanceState | null> {
  return unwrap(await client.api.maintenance.post({ on, message })).maintenance;
}

export function tilesetUrl(file: string): string {
  return `/api/tilesets/${encodeURIComponent(file)}`;
}

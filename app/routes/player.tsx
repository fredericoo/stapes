import { Outlet, useLoaderData, useOutletContext } from "react-router";
import { fetchBootstrap } from "../lib/api";
import { useGameAssets } from "../lib/gameAssets";
import type { TileDef, TilesetDef } from "../lib/types";

export async function clientLoader() {
  return await fetchBootstrap();
}

export function shouldRevalidate() {
  return false;
}

export type PlayerShell = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statuses: unknown[];
};

export function usePlayerShell(): PlayerShell {
  return useOutletContext<PlayerShell>();
}

export default function PlayerLayout() {
  const shell = useLoaderData<typeof clientLoader>();
  useGameAssets(shell.tilesets);

  return <Outlet context={shell} />;
}

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TileDef, TilesetDef } from "../../lib/types";

type MapAssets = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
};

const MapAssetsContext = createContext<MapAssets | null>(null);

/**
 * Panel content is rendered by the splitkit tab registry, which lives outside
 * the route component, so loader data reaches the panels through context
 * instead of props.
 */
export function MapAssetsProvider({
  tiles,
  tilesets,
  children,
}: MapAssets & { children: ReactNode }) {
  const value = useMemo(() => ({ tiles, tilesets }), [tiles, tilesets]);
  return (
    <MapAssetsContext.Provider value={value}>
      {children}
    </MapAssetsContext.Provider>
  );
}

export function useMapAssets(): MapAssets {
  const value = useContext(MapAssetsContext);
  if (!value) {
    throw new Error("useMapAssets must be used inside MapAssetsProvider");
  }
  return value;
}

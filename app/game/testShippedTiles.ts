import tilesJson from "../../data/tiles.json";
import traitsJson from "../../data/traits.json";
import { traitsById, withTraits } from "../lib/traits";
import { normalizeTiles, type TileDef } from "../lib/types";

export function shippedTiles(): TileDef[] {
  return withTraits(normalizeTiles(tilesJson as unknown[]), traitsById(traitsJson as unknown[]));
}

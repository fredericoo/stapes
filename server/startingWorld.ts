import { GameSession } from "../app/game/GameSession";
import type { ResidencyIndex } from "../app/game/residency";
import { findSpawnPoints, type SpawnPoint } from "../app/game/respawn";
import type { ChangedChunk } from "../app/lib/mapData";
import type { TraitCatalogue } from "../app/lib/traits";
import type { Coord, MapFile, TileDef } from "../app/lib/types";
import {
  removeUnfitPlacements,
  type RemovedPlacement,
  tilesByIdFromList,
} from "../app/lib/validation";

/**
 * A board nobody has played, ready for a session that holds only
 * `residency.kept` of it. `rows` yields every chunk of the whole board once,
 * so the store can be written without the board ever being in memory whole.
 */
export type StartingWorld = {
  spawnAt: Coord & { stackIndex: number };
  residency: ResidencyIndex;
  points: SpawnPoint[];
  removed: RemovedPlacement[];
  rows: () => AsyncIterable<ChangedChunk>;
};

export function startingWorldOf(
  authored: MapFile,
  tiles: TileDef[],
  traits: TraitCatalogue,
): StartingWorld & { authored: MapFile; whole: MapFile } {
  const tilesById = tilesByIdFromList(tiles);
  const { map, removed } = removeUnfitPlacements(authored, tilesById);
  const start = GameSession.startingBoard(map, tiles, traits);
  const whole = start.map;
  return {
    authored: map,
    whole,
    spawnAt: start.spawnAt,
    residency: start.residency,
    points: findSpawnPoints(whole, tilesById),
    removed,
    async *rows() {
      for (const levelKey in whole.levels) {
        const level = whole.levels[levelKey]!;
        for (const chunkKey in level) yield { levelKey, chunkKey, cells: level[chunkKey]! };
      }
    },
  };
}

import type { PlacementWriter } from "../../components/PlacementSettingsDialog";
import {
  emptyMap,
  getStack,
  setStacks,
  updatePlacedChannel,
  updatePlacedContents,
  updatePlacedDepotTag,
  updatePlacedDescription,
  updatePlacedEngraving,
  updatePlacedInscription,
  updatePlacedReward,
  updatePlacedTeleport,
} from "../../lib/mapData";
import type { PlacedTile } from "../../lib/types";

/**
 * A writer for the placement settings dialog that edits one placement held
 * outside any map. It applies the map editor's own `updatePlaced*` functions
 * to a one-cell map, so a chest's rewards are trimmed and dropped exactly as
 * they are in the map editor.
 */
export function placementWriter(placed: PlacedTile): {
  writer: PlacementWriter;
  read: () => PlacedTile;
} {
  let map = setStacks(emptyMap(), [{ x: 0, y: 0, z: 0, stack: [placed] }]);
  const at = [0, 0, 0] as const;
  return {
    writer: {
      setStackChannel: (i, value) => (map = updatePlacedChannel(map, ...at, i, value)),
      setStackReward: (i, value) => (map = updatePlacedReward(map, ...at, i, value)),
      setStackDepotTag: (i, value) => (map = updatePlacedDepotTag(map, ...at, i, value)),
      setStackTeleport: (i, value) => (map = updatePlacedTeleport(map, ...at, i, value)),
      setStackContents: (i, value) => (map = updatePlacedContents(map, ...at, i, value)),
      setStackInscription: (i, value) => (map = updatePlacedInscription(map, ...at, i, value)),
      setStackDescription: (i, value) => (map = updatePlacedDescription(map, ...at, i, value)),
      setStackEngraving: (i, value) => (map = updatePlacedEngraving(map, ...at, i, value)),
    },
    read: () => getStack(map, 0, 0, 0)[0]!,
  };
}
